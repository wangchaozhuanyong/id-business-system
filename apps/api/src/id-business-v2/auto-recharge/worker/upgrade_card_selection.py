"""Select the authorized card in the original upgrade UI, including Add new."""
import asyncio
import json
import os
import re
import time
from urllib.parse import urlencode

from browser_checkout import browser_read
from checkout_core import Stop, parse_credential
from payment_form import fill_official_form, validate_details, verify_billing_fields, verify_card_fields
from upgrade_card_network import METHOD_ID, method_matches_card

METHODS_PATH = '/backend-api/payments/payment_methods'
RADIO_NAME = 'plan-upgrade-payment-method'
CHANGE = re.compile(r'^\s*(?:Change payment method|更改付款方式|更換付款方式|修改付款方式)\s*$', re.I)
ADD = re.compile(r'^\s*(?:Add new|Add new card|Add payment method|新增|新增银行卡|新增銀行卡|添加支付方式|添加付款方式)\s*$', re.I)
CONTINUE = re.compile(r'^\s*(?:Continue|Add|继续|繼續|添加|新增)\s*$', re.I)


async def account_methods(page, target, credential=None):
    if credential is None and getattr(target, 'old_token', None):
        credential = parse_credential(json.dumps({'accessToken': target.old_token}).encode())
    if credential is not None and credential.account_id != target.account_id:
        raise Stop('upgrade_payment_method_unverified')
    response = await browser_read(page, METHODS_PATH + '?' + urlencode({'account_id': target.account_id}), credential)
    if (not isinstance(response, dict) or response.get('account_id', target.account_id) != target.account_id
            or not isinstance(response.get('payment_methods'), list)):
        raise Stop('upgrade_payment_method_unverified')
    methods = response['payment_methods']
    identifiers = [method.get('id') for method in methods if isinstance(method, dict)]
    if len(identifiers) != len(methods) or len(set(identifiers)) != len(identifiers):
        raise Stop('upgrade_payment_method_unverified')
    return methods


def matching_methods(methods, details):
    return [method for method in methods if METHOD_ID.fullmatch(str(method.get('id', '')))
            and method.get('is_healthy') is not False and method.get('is_deleted') is not True
            and method_matches_card(method, details)]


async def visible_button(scope, names, reason):
    button = scope.get_by_role('button', name=names).filter(visible=True)
    if await button.count() != 1 or not await button.is_enabled():
        raise Stop(reason)
    return button


def card_radio(page, identifier):
    if not METHOD_ID.fullmatch(str(identifier)):
        raise Stop('upgrade_payment_method_unverified')
    return page.locator(f"input[type='radio'][name='{RADIO_NAME}'][value='{identifier}']")


async def select_card_radio(radio):
    if await radio.count() != 1:
        raise Stop('official_upgrade_payment_method_not_found')
    label = radio.locator('xpath=ancestor::label[1]').filter(visible=True)
    if await label.count() == 1:
        await label.click()
    elif await radio.is_visible():
        await radio.check()
    else:
        raise Stop('official_upgrade_payment_method_not_found')
    if not await radio.is_checked():
        raise Stop('upgrade_payment_method_changed')


async def verify_selected_upgrade_card(page, card_change, details, *, credential=None):
    if not card_change.original_frame(page.main_frame) or card_change.error:
        raise Stop('upgrade_payment_method_changed')
    identifier = card_change.method_id
    radio = card_radio(page, identifier)
    checked = page.locator(f"input[type='radio'][name='{RADIO_NAME}']:checked")
    if await radio.count() != 1 or await checked.count() != 1 or not await radio.is_checked():
        raise Stop('upgrade_payment_method_changed')
    methods = await account_methods(page, card_change.target, credential)
    matches = matching_methods(methods, details)
    if len(matches) != 1 or matches[0]['id'] != identifier:
        raise Stop('upgrade_payment_method_changed')
    return identifier


async def prepare_upgrade_card(page, target, details, card_change, *, credential=None,
                               wait_seconds=120, cancelled=lambda: None, progress=lambda *_args, **_kwargs: None):
    """Follow only visible official controls; do not build any account/Stripe write."""
    validate_details(details)
    if card_change.read_only or card_change.closed or not card_change.original_frame(page.main_frame):
        raise Stop('upgrade_card_change_not_authorized')
    cancelled()
    progress('upgrade_card_selecting', operation='subscription_upgrade')
    methods = await account_methods(page, target, credential)
    cancelled()
    matches = matching_methods(methods, details)
    if len(matches) > 1:
        raise Stop('upgrade_payment_method_ambiguous')
    identifier = matches[0]['id'] if matches else None
    try:
        if not identifier or await card_radio(page, identifier).count() != 1:
            button = await visible_button(page, CHANGE, 'official_upgrade_change_card_not_found')
            cancelled()
            await button.click()
        cancelled()
        if identifier:
            radio = card_radio(page, identifier)
            if await radio.count() != 1:
                raise Stop('official_upgrade_payment_method_not_found')
            cancelled()
            await select_card_radio(radio)
            card_change.method_id = identifier
        else:
            button = await visible_button(page, ADD, 'official_upgrade_add_card_not_found')
            cancelled()
            progress('upgrade_card_adding', operation='subscription_upgrade')
            card_change.cancelled = cancelled
            card_change.arm(details)  # The modal may request its original SetupIntent on opening.
            cancelled()
            await button.click()
            modal = page.locator("[data-testid='modal-add-payment-method']").filter(visible=True)
            await modal.wait_for(state='visible', timeout=15000)
            if await modal.count() != 1:
                raise Stop('official_upgrade_add_card_not_found')
            prepared = await fill_official_form(page, details)
            await verify_card_fields(page, details)
            await verify_billing_fields(page, details, prepared['billing_fields_filled'])
            button = await visible_button(modal, CONTINUE, 'official_upgrade_add_card_submit_not_found')
            cancelled()
            card_change.authorize_submit()
            cancelled()
            await button.click()
            deadline = time.monotonic() + wait_seconds
            announced = False
            while not card_change.method_id and time.monotonic() < deadline:
                cancelled()
                if card_change.error:
                    raise card_change.error
                if card_change.auth.needs_user:
                    if not announced:
                        progress('upgrade_card_bank_verification_required', operation='subscription_upgrade',
                                 instruction='新卡需要本人银行验证；尚未提交订阅升级付款。')
                        announced = True
                    if os.environ.get('AUTO_RECHARGE_CALLBACK_URL') not in (None, '', 'local-bitbrowser'):
                        raise Stop('upgrade_card_bank_verification_required')
                if card_change.auth.status in {'failed', 'unsupported'}:
                    raise Stop('upgrade_card_setup_failed')
                await asyncio.sleep(.05)
            if not card_change.method_id:
                raise Stop('upgrade_card_setup_unverified')
            identifier = card_change.method_id
            # The official successful callback selects the canonical method. Do not
            # guess a card from its tail or mutate the account's global default.
            radio = card_radio(page, identifier)
            await radio.wait_for(state='attached', timeout=10000)
            if not await radio.is_checked():
                cancelled()
                await select_card_radio(radio)
        await verify_selected_upgrade_card(page, card_change, details, credential=credential)
        cancelled()
        card_change.close()
        progress('upgrade_card_ready', operation='subscription_upgrade')
        return identifier
    except Exception:
        card_change.close()
        raise
