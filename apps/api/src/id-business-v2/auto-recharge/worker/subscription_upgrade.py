"""官网 Plus→Pro 原订阅变更：只读预览、持久化后唯一 update、原单只读复查。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

from attempt_ledger import atomic_json
from browser_checkout import NetworkGuard, browser_read, check_session, money, progress, quote_from_text, observe_page_network
from checkout_core import MAX_BYTES, Stop, parse_credential, unique_object
from payment_3ds import AUTH_PATHS
from upgrade_authentication import (UpgradeAuthentication, UpgradeResponseObservers,
                                    wait_upgrade_authentication, upgrade_authentication_summary, route_upgrade_card_change)
from upgrade_card_network import UpgradeCardChange
from upgrade_card_selection import prepare_upgrade_card, verify_selected_upgrade_card
from payment_state import quote_digest, validate_evidence, outcome
from plans import plan_spec, subscription_match, subscription_transition
from plan_selection import plan_scope, select_plan, verify_selected_plan

UPGRADE_PATH = '/backend-api/subscriptions/update'
PREVIEW_PATH = UPGRADE_PATH + '/preview'
SUBSCRIPTION_PATH = '/backend-api/subscriptions'
INVOICES_PATH = '/backend-api/invoices'
UPGRADE_ID = re.compile(r'^upg_[a-f0-9]{32}$')
INVOICE_ID = re.compile(r'^in_[A-Za-z0-9]{1,180}$')
INTENT_ID = re.compile(r'^pi_[A-Za-z0-9]{1,180}$')
PAY_NOW = re.compile(r'^\s*(?:Pay now|Confirm|立即付款|立即支付|确认|確認)\s*$', re.I)
PERIOD = re.compile(r'\bBilled monthly\b|按月(?:收费|计费|付费)|每月(?:收费|計費|计费)', re.I)
YEARLY = re.compile(r'\b(?:annual(?:ly)?|yearly)\b|按年|年付|年度|年缴|年繳', re.I)


def minor_money(currency, amount):
    if (not isinstance(currency, str) or not re.fullmatch(r'[A-Z]{3}', currency)
            or type(amount) is not int or amount < 0):
        raise Stop('upgrade_quote_unverified')
    units = 0 if currency in {'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'PYG', 'RWF', 'XAF', 'XOF', 'XPF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'VUV'} else 2
    value = format(Decimal(amount) / (Decimal(10) ** units), f'.{units}f')
    result = money(currency + ' ' + value)
    if not result or result['amount_minor'] != amount:
        raise Stop('upgrade_quote_unverified')
    return result


def preview_quote(data, target_plan, renewal=None):
    """金额为官网公开客户端使用的 minor units，不从当地币种推算套餐。"""
    if not isinstance(data, dict):
        raise Stop('upgrade_quote_unverified')
    currency = data.get('currency')
    currency = currency.upper() if isinstance(currency, str) else None
    due = data.get('amount_due')
    if not isinstance(due, dict):
        raise Stop('upgrade_quote_unverified')
    positive, negative = data.get('positive_line_item_total'), data.get('negative_line_item_total')
    amount, excluding, tax = due.get('amount'), due.get('amount_excluding_tax'), due.get('tax_amount')
    if (any(type(v) is not int for v in (positive, negative, amount, excluding, tax))
            or positive <= 0 or negative > 0 or tax < 0 or amount <= 0
            or positive + negative != excluding or excluding + tax != amount
            or data.get('applied_balance', 0) != 0 or data.get('discount_amount', 0) != 0):
        raise Stop('upgrade_quote_unverified')
    if renewal != minor_money(currency, positive):
        raise Stop('upgrade_renewal_unverified')
    quote = {'plan': target_plan, 'today': minor_money(currency, amount),
             'tax': minor_money(currency, tax), 'renewal': renewal,
             'renewal_interval': 'monthly'}
    quote_digest(quote)
    return quote


def paid_evidence(data, record):
    """只接受 update 回包绑定的真实 invoice/PI 的明确实付金额。"""
    if not isinstance(data, dict):
        return None
    today = record['quote']['today']
    pi = record.get('upgrade_payment_intent_identifier')
    invoice = record.get('upgrade_invoice_identifier')
    if (pi and data.get('object') == 'payment_intent' and data.get('id') == pi
            and data.get('status') == 'succeeded' and type(data.get('amount_received')) is int
            and data['amount_received'] == today['amount_minor']
            and str(data.get('currency', '')).upper() == today['currency']):
        return {'kind': 'payment_intent', 'identifier': pi,
                'amount_minor': today['amount_minor'], 'currency': today['currency']}
    intent = data.get('payment_intent')
    linked_pi = intent.get('id') if isinstance(intent, dict) else intent
    id_ = data.get('id')
    if (data.get('object') == 'invoice' and isinstance(id_, str) and INVOICE_ID.fullmatch(id_)
            and (id_ == invoice or pi and linked_pi == pi)
            and data.get('status') == 'paid' and data.get('paid') is True
            and type(data.get('amount_paid')) is int and data['amount_paid'] == today['amount_minor']
            and str(data.get('currency', '')).upper() == today['currency']):
        return {'kind': 'invoice', 'identifier': id_,
                'amount_minor': today['amount_minor'], 'currency': today['currency']}
    return None


def validate_upgrade_record(record, account_key, target_plan, upgrade_id=None):
    if (not isinstance(record, dict) or record.get('schema_version') != 1
            or record.get('operation') != 'subscription_upgrade'
            or record.get('account_key') != account_key or record.get('target_plan') != target_plan
            or not UPGRADE_ID.fullmatch(str(record.get('upgrade_identifier', '')))
            or upgrade_id and record['upgrade_identifier'] != upgrade_id
            or record.get('current_plan_before') != 'plus' or record.get('payment_attempted') is not True
            or type(record.get('confirmation_requests_sent')) is not int
            or record['confirmation_requests_sent'] not in (0, 1)
            or record.get('payment_status') not in {'unknown', 'paid', 'declined', 'requires_action'}
            or record.get('quote_authority') != 'official_upgrade_preview'
            or record.get('quote', {}).get('plan') != target_plan
            or quote_digest(record['quote']) != record.get('quote_digest')):
        raise Stop('invalid_upgrade_record')
    for key, pattern in (('upgrade_invoice_identifier', INVOICE_ID),
                         ('upgrade_payment_intent_identifier', INTENT_ID)):
        if record.get(key) is not None and not pattern.fullmatch(str(record[key])):
            raise Stop('invalid_upgrade_record')
    evidence = record.get('payment_evidence')
    if evidence:
        expected = record.get('upgrade_invoice_identifier' if evidence.get('kind') == 'invoice'
                              else 'upgrade_payment_intent_identifier')
        if (evidence.get('kind') not in {'invoice', 'payment_intent'} or evidence.get('identifier') != expected
                or evidence.get('amount_minor') != record['quote']['today']['amount_minor']
                or evidence.get('currency') != record['quote']['today']['currency']
                or set(evidence) != {'kind', 'identifier', 'amount_minor', 'currency'}):
            raise Stop('invalid_upgrade_record')
    if record['payment_status'] == 'paid' and not evidence:
        raise Stop('invalid_upgrade_record')
    return record


class UpgradeLedger:
    def __init__(self, root, account_id, target_plan, upgrade_id=None):
        self.root, self.account_id, self.target_plan = Path(root), account_id, target_plan
        subscription_transition('plus', target_plan)
        if upgrade_id is not None and not UPGRADE_ID.fullmatch(upgrade_id):
            raise Stop('invalid_upgrade_identifier')
        self.account_key = hashlib.sha256(account_id.encode()).hexdigest()
        self.upgrade_id, self.record, self.fd = upgrade_id, None, None
        self.path = None

    def __enter__(self):
        if self.root.is_symlink():
            raise Stop('unsafe_state_directory')
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.fd = os.open(self.root / (self.account_key + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            folder = self.root / 'payments'
            if folder.is_symlink():
                raise Stop('unsafe_state_directory')
            folder.mkdir(mode=0o700, exist_ok=True)
            for path in folder.glob('*.json'):
                if path.is_symlink() or path.stat().st_size > 65536:
                    raise Stop('invalid_payment_record')
                data = json.loads(path.read_text(), object_pairs_hook=unique_object)
                if not isinstance(data, dict):
                    raise Stop('invalid_payment_record')
                if data.get('account_key') != self.account_key:
                    continue
                if data.get('operation') == 'subscription_upgrade':
                    validate_upgrade_record(data, self.account_key, data.get('target_plan'))
                    if self.upgrade_id and data['upgrade_identifier'] == self.upgrade_id and data['target_plan'] == self.target_plan:
                        if self.record is not None:
                            raise Stop('invalid_upgrade_record')
                        self.path, self.record = path, data
                        continue
                    raise Stop('previous_upgrade_attempt_exists', upgrade_identifier=data['upgrade_identifier'],
                               recheck_plan=data['target_plan'], action='recheck_original_order_only')
                # 只有同账户、明确已付款且已核实 Plus 的旧记录可作为升级历史。
                if data.get('payment_attempted') is not True:
                    raise Stop('invalid_payment_record')
                if (data.get('target_plan', 'plus') != 'plus' or data.get('payment_status') != 'paid'
                        or data.get('status') != 'subscription_activated' or data.get('subscription_status') != 'plus'
                        or data.get('current_plan') != 'plus' or data.get('confirmation_requests_sent') != 1):
                    raise Stop('account_has_other_payment_attempt', action='recheck_original_order_only',
                               recheck_plan=data.get('target_plan', 'plus'), checkout_identifier=data.get('checkout_identifier'))
                validate_evidence(data.get('payment_evidence'), data.get('checkout_identifier'), data.get('quote'))
                if quote_digest(data['quote']) != data.get('quote_digest'):
                    raise Stop('invalid_payment_record')
            if self.upgrade_id and self.record is None:
                raise Stop('no_original_upgrade_attempt')
            return self
        except BaseException:
            self.__exit__()
            raise

    def begin(self, quote, last4):
        if self.record is not None or self.fd is None:
            raise Stop('previous_upgrade_attempt_exists', action='recheck_original_order_only')
        self.upgrade_id = quote.get('upgrade_identifier') or 'upg_' + uuid.uuid4().hex
        if not UPGRADE_ID.fullmatch(self.upgrade_id):
            raise Stop('invalid_upgrade_identifier')
        self.path = self.root / 'payments' / (hashlib.sha256(self.upgrade_id.encode()).hexdigest() + '.json')
        if self.path.exists() or self.path.is_symlink():
            raise Stop('upgrade_marker_conflict')
        record = {'schema_version': 1, 'operation': 'subscription_upgrade',
                  'upgrade_identifier': self.upgrade_id, 'account_key': self.account_key,
                  'target_plan': self.target_plan, 'current_plan_before': 'plus', 'quote': quote,
                  'quote_digest': quote_digest(quote), 'quote_authority': 'official_upgrade_preview',
                  'payment_attempted': True, 'confirmation_requests_sent': 0, 'payment_status': 'unknown',
                  'payment_evidence': None, 'card_last4': last4, 'created_at': int(time.time()),
                  'subscription_status': 'not_verified', 'status': 'payment_result_unknown'}
        atomic_json(self.path, record)
        self.record = record

    def update(self, **details):
        updated = {**self.record, **details, 'updated_at': int(time.time())}
        validate_upgrade_record(updated, self.account_key, self.target_plan, self.upgrade_id)
        atomic_json(self.path, updated)
        self.record = updated

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def request_account(headers, target):
    authorization = headers.get('authorization', '')
    if not authorization.startswith('Bearer '):
        return False
    try:
        cred = parse_credential(json.dumps({'accessToken': authorization[7:]}).encode())
        return cred.account_id == target.account_id and headers.get('chatgpt-account-id', cred.account_id) == target.account_id
    except Stop:
        return False


class UpgradeGuard(NetworkGuard):
    def __init__(self, target, ledger, origin_frame=None):
        super().__init__(target)
        self.upgrade_ledger = ledger
        self.target_plan = ledger.target_plan
        self.approved = False
        self.reserved = False
        self.update_request = None
        self.done = asyncio.Event()
        self.error = None
        self.preflight = None
        self.method_id = None
        self.read_only = ledger.record is not None
        self.three_ds = UpgradeAuthentication(origin_frame)
        self.card_change = UpgradeCardChange(target, origin_frame, read_only=self.read_only)

    async def route(self, route):
        request = route.request
        p = urlsplit(request.url)
        if request.method == 'POST' and p.scheme == 'https' and p.hostname == 'chatgpt.com' and p.path == UPGRADE_PATH:
            if self.reserved or self.sent:
                self.blocked_duplicates += 1
                await route.abort('blockedbyclient')
                return
            try:
                body = request.post_data_json
                allowed_keys = {'account_id', 'updated_plan', 'payment_method_id'}
                if (not isinstance(body, dict) or set(body) - allowed_keys
                        or body.get('account_id') != self.target.account_id
                        or body.get('updated_plan') != plan_spec(self.target_plan)['official_name']
                        or not isinstance(self.method_id, str)
                        or body.get('payment_method_id') != self.method_id
                        or not self.three_ds.original_frame_matches(getattr(request, 'frame', None))
                        or not request_account(request.headers, self.target)):
                    raise Stop('upgrade_request_mismatch')
                if not self.approved or self.sent:
                    raise Stop('duplicate_payment_blocked' if self.sent else 'upgrade_not_authorized')
                self.reserved = True  # 第一个 await 前预留；并发第二次 update 不能通过。
                await self.preflight()
                if not self.approved or self.three_ds.closed:
                    raise Stop('operation_cancelled')
                self.upgrade_ledger.update(confirmation_requests_sent=1, stage='upgrade_request_sending')
                self.sent, self.approved, self.update_request = 1, False, request
                await route.fallback()
                return
            except Exception as exc:
                self.approved = False
                self.error = exc if isinstance(exc, Stop) else Stop('upgrade_marker_write_failed')
                self.done.set()
                await route.abort('blockedbyclient')
                return
        if await route_upgrade_card_change(self, route):
            return
        decision = await self.three_ds.original_request_decision(request, self.target, sent=self.sent,
            read_only=self.read_only, payment_status=lambda: (self.upgrade_ledger.record or {}).get('payment_status'))
        if decision is not None:
            if decision:
                await route.fallback()
            else:
                self.blocked_unknown_writes += int(request.method not in {'GET', 'HEAD', 'OPTIONS'})
                await route.abort('blockedbyclient')
            return
        if request.method in {'GET', 'HEAD'} and p.hostname == 'api.stripe.com':
            pi = self.upgrade_ledger.record.get('upgrade_payment_intent_identifier') if self.upgrade_ledger.record else None
            if not pi or p.path != '/v1/payment_intents/' + pi:
                await route.abort('blockedbyclient')
                return
        # new checkout、追加confirm/绑卡/续订/取消等所有写均继承默认拒绝。
        await super().route(route)

    async def response(self, response):
        await self.card_change.response(response)
        await self.three_ds.observe_redirect(response)
        p = urlsplit(response.url)
        update = response.request is self.update_request
        authentication = self.three_ds.requests.get(response.request) in AUTH_PATHS
        record = self.upgrade_ledger.record or {}
        linked_read = (response.request.method == 'GET' and p.scheme == 'https' and p.hostname == 'api.stripe.com'
                       and p.path == '/v1/payment_intents/' + str(record.get('upgrade_payment_intent_identifier')))
        if not (update or authentication or linked_read):
            return
        try:
            if not 200 <= response.status < 300:
                if record.get('payment_status') != 'paid':
                    self.upgrade_ledger.update(payment_status='unknown')
                if authentication:
                    self.three_ds.close('failed')
                raise Stop('upgrade_request_failed', http_status=response.status)
            raw = await response.body()
            if len(raw) > MAX_BYTES:
                raise Stop('upgrade_result_unknown')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise Stop('upgrade_result_unknown')
            if authentication and not self.three_ds.observe_authentication(
                    response.request, data, allow_challenge=not self.three_ds.closed):
                raise Stop('three_ds_binding_unverified')
            if authentication:
                self.upgrade_ledger.update(three_ds_status=self.three_ds.status)
            updates = {}
            intent = data if data.get('object') == 'payment_intent' else data.get('payment_intent')
            if update:
                invoice = data.get('pending_update_invoice_id')
                pi = intent.get('id') if isinstance(intent, dict) else data.get('pending_update_payment_intent_id')
                for key, identifier, pattern in [('upgrade_invoice_identifier', invoice, INVOICE_ID),
                                                  ('upgrade_payment_intent_identifier', pi, INTENT_ID)]:
                    if isinstance(identifier, str) and pattern.fullmatch(identifier):
                        if record.get(key) not in (None, identifier):
                            raise Stop('upgrade_payment_evidence_conflict')
                        updates[key] = identifier
            if updates:
                self.upgrade_ledger.update(**updates)
            self.observe(intent)
            record = self.upgrade_ledger.record
            if record.get('payment_status') == 'paid':
                return
            if (data.get('status') == 'requires_action'
                    or isinstance(intent, dict) and intent.get('status') == 'requires_action'):
                self.upgrade_ledger.update(payment_status='requires_action')
                if not self.read_only and not self.three_ds.closed and self.sent == 1:
                    self.three_ds.bind_action(intent, record)
                    self.upgrade_ledger.update(three_ds_status=self.three_ds.status)
            elif update and data.get('status') == 'payment_method_failed':
                self.upgrade_ledger.update(payment_status='declined')
                self.three_ds.close('failed')
            elif authentication and (data.get('state') == 'failed'
                    or isinstance(intent, dict) and intent.get('status') in {'requires_payment_method', 'canceled'}):
                self.three_ds.close('failed')
                raise Stop('three_ds_authentication_failed')
        except Stop as exc:
            self.error = exc
            if authentication:
                self.three_ds.close('failed')
        except Exception:
            self.error = Stop('upgrade_result_unknown')
            if authentication:
                self.three_ds.close('failed')
        finally:
            if update or authentication:
                self.three_ds.ready.set()
            self.done.set()

    def observe(self, data):
        record = self.upgrade_ledger.record
        if isinstance(data, dict) and data.get('status') in {'paid', 'succeeded'}:
            id_ = data.get('id')
            bound = (data.get('object') == 'invoice' and id_ == record.get('upgrade_invoice_identifier')
                     or data.get('object') == 'payment_intent' and id_ == record.get('upgrade_payment_intent_identifier'))
            charged = data.get('amount_paid') if data.get('object') == 'invoice' else data.get('amount_received')
            if bound and (type(charged) is not int or charged != record['quote']['today']['amount_minor']
                          or str(data.get('currency', '')).upper() != record['quote']['today']['currency']):
                raise Stop('upgrade_payment_evidence_conflict')
        evidence = paid_evidence(data, self.upgrade_ledger.record)
        if evidence:
            updates = {'payment_status': 'paid'}
            if self.three_ds.intent_id:
                self.three_ds.close('completed')
                updates['three_ds_status'] = 'completed'
            if not record.get('payment_evidence'):
                updates['payment_evidence'] = evidence
            if evidence['kind'] == 'invoice':
                if record.get('upgrade_invoice_identifier') not in (None, evidence['identifier']):
                    raise Stop('upgrade_payment_evidence_conflict')
                updates['upgrade_invoice_identifier'] = evidence['identifier']
            self.upgrade_ledger.update(**updates)


def safe_period(subscription, ledger):
    if not isinstance(subscription, dict):
        return None
    try:
        start, end = (datetime.fromisoformat(subscription[k].replace('Z', '+00:00')) for k in ('active_start', 'active_until'))
        if not start.tzinfo or not end.tzinfo or not 0 < (end - start).total_seconds() <= 32 * 86400:
            return None
        iso = lambda value: value.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        return {'source': 'official_subscription_response', 'start': iso(start), 'end': iso(end),
                'account_key': ledger.account_key, 'target_plan': ledger.target_plan}
    except (ValueError, KeyError, TypeError, AttributeError):
        return None


async def read_subscription(page, target):
    refreshed, identity = await check_session(page, target)
    data = await browser_read(page, SUBSCRIPTION_PATH + '?' + urlencode({'account_id': target.account_id}), refreshed)
    if not isinstance(data, dict) or data.get('account_id', target.account_id) != target.account_id:
        raise Stop('official_account_mismatch')
    return refreshed, identity, data


async def inspect_upgrade(page, target, ledger, guard, *, poll_count=1, poll_interval=20):
    for i in range(poll_count):
        refreshed, identity, subscription = await read_subscription(page, target)
        if ledger.record.get('upgrade_invoice_identifier') or ledger.record.get('upgrade_payment_intent_identifier'):
            invoices = await browser_read(page, INVOICES_PATH + '?' + urlencode({'account_id': target.account_id, 'limit': 100}), refreshed)
            rows = invoices.get('data', invoices.get('invoices', [])) if isinstance(invoices, dict) else []
            for invoice in rows if isinstance(rows, list) else []:
                guard.observe(invoice)
        match = subscription_match(ledger.target_plan, identity['current_plan'], identity.get('current_tier'))
        # 本次官网 subscription 对象必须与核实的目标套餐一致，不能附旧Plus账期。
        raw_plan = {'pro-5x': 'prolite', 'pro-20x': 'pro', 'pro-500': 'promax'}[ledger.target_plan]
        period = safe_period(subscription, ledger) if (match == 'matched' and subscription.get('plan_type') == raw_plan
                 and ledger.record.get('payment_evidence')) else None
        record = ledger.record
        status = outcome(record['payment_status'], identity['current_plan'], record.get('payment_evidence'),
                         target_plan=ledger.target_plan, current_tier=identity.get('current_tier'))
        ledger.update(status=status, current_plan=identity['current_plan'], current_tier=identity.get('current_tier'),
                      subscription_status=ledger.target_plan if match == 'matched' else match,
                      **({'subscription_period': period} if period else {}))
        if status == 'subscription_activated' or record['payment_status'] != 'paid' or i + 1 == poll_count:
            return {**ledger.record, **identity, 'status': status, 'stage': 'original_payment_recheck',
                    'payment_outcome': status, 'payment_requests_sent': guard.sent,
                    **upgrade_authentication_summary(guard, ledger.record),
                    'repeated_payment': 'blocked', 'recheck_only': guard.sent == 0}
        await asyncio.sleep(poll_interval)


async def visible_renewal(page, currency):
    scope = await plan_scope(page)
    lines = [line.strip() for line in (await scope.inner_text()).splitlines() if line.strip()]
    candidates = []
    for i, line in enumerate(lines):
        if not PERIOD.search(line):
            continue
        # 官网 Kwt 目标套餐价格行紧邻 Billed monthly；年度或不明条款不推断。
        if YEARLY.search(line) or i < 2 or not re.search(r'\bPro\b', lines[i - 2], re.I):
            raise Stop('upgrade_renewal_unverified')
        amount = money(lines[i - 1], currency)
        if not amount:
            raise Stop('upgrade_renewal_unverified')
        candidates.append(amount)
    if len(candidates) != 1:
        raise Stop('upgrade_renewal_unverified')
    return candidates[0]


async def verify_preview_dom(page, quote, *, check_button=True):
    scope = await plan_scope(page)
    text = await scope.inner_text()
    parsed = quote_from_text(text, quote['today']['currency'])
    if (parsed.get('today') != quote['today'] or parsed.get('tax') not in (None, quote['tax'])
            or quote['tax']['amount_minor'] and parsed.get('tax') != quote['tax']):
        raise Stop('upgrade_quote_changed')
    cadence = [line for line in text.splitlines() if PERIOD.search(line)]
    if len(cadence) != 1 or YEARLY.search(cadence[0]):
        raise Stop('upgrade_quote_unverified')
    if not re.search(r'\bPro\b', text, re.I):
        raise Stop('upgrade_quote_plan_mismatch')
    if not check_button:
        return None
    button = scope.get_by_role('button', name=PAY_NOW).filter(visible=True)
    if await button.count() != 1 or not await button.is_enabled():
        raise Stop('official_upgrade_confirmation_not_found')
    return button


async def run_upgrade_in_context(page, target, state_dir, target_plan, *, details_reader=None,
                                 confirmer=None, wait_seconds=120, poll_count=6, poll_interval=20,
                                 session_budget=None, expected_country=None, upgrade_id=None):
    with UpgradeLedger(state_dir, target.account_id, target_plan, upgrade_id) as ledger:
        guard = UpgradeGuard(target, ledger, origin_frame=page.main_frame)
        context = page.context
        await context.route('**/*', guard.route)
        observers = UpgradeResponseObservers(context, guard)
        details = None
        def cancelled():
            if session_budget and session_budget.cancelled():
                raise Stop('operation_cancelled')
        try:
            if ledger.record:
                await observers.finish()
                return await inspect_upgrade(page, target, ledger, guard, poll_count=poll_count, poll_interval=poll_interval)
            refreshed, identity, subscription = await read_subscription(page, target)
            subscription_transition(identity['current_plan'], target_plan)
            if (identity['current_plan'] != 'plus' or subscription.get('plan_type') != 'plus'
                    or subscription.get('is_processor_stripe') is not True
                    or subscription.get('is_delinquent') is True
                    or subscription.get('will_renew') is not True
                    or subscription.get('scheduled_billing_period') is not None):
                raise Stop('incompatible_existing_subscription')
            button = await select_plan(page, target_plan, progress, require_upgrade=True)
            await verify_selected_plan(page, target_plan, require_upgrade=True)
            cancelled()
            await button.click()
            preview_path = PREVIEW_PATH + '?' + urlencode({'account_id': target.account_id,
                                                           'updated_plan': plan_spec(target_plan)['official_name']})
            preview = await browser_read(page, preview_path, refreshed)
            renewal = await visible_renewal(page, str(preview.get('currency', '')).upper())
            quote = {**preview_quote(preview, target_plan, renewal), 'operation': 'subscription_upgrade',
                     'upgrade_identifier': 'upg_' + uuid.uuid4().hex,
                     'quote_authority': 'official_upgrade_preview'}
            button = await verify_preview_dom(page, quote)
            progress('upgrade_quote_ready', operation='subscription_upgrade', quote=quote,
                     quote_authority='official_upgrade_preview', upgrade_identifier=quote['upgrade_identifier'],
                     current_plan='plus', current_plan_before='plus', target_plan=target_plan, account_matched=True)
            details = await asyncio.to_thread(details_reader, quote)
            method_id = await prepare_upgrade_card(page, target, details, guard.card_change,
                credential=refreshed, wait_seconds=wait_seconds, cancelled=cancelled, progress=progress)
            # 换卡后重新读取官方差额、税费和月度续费，再授权本次唯一升级。
            preview = await browser_read(page, preview_path, refreshed)
            renewal = await visible_renewal(page, str(preview.get('currency', '')).upper())
            quote = {**quote, **preview_quote(preview, target_plan, renewal)}
            button = await verify_preview_dom(page, quote)
            network_before = await observe_page_network(page) if expected_country else None
            if expected_country and network_before.get('country') != expected_country:
                raise Stop('proxy_country_mismatch')
            cancelled()
            if not await asyncio.to_thread(confirmer, quote, details.last4):
                return {'status': 'payment_cancelled', 'stage': 'confirmation_cancelled', 'operation': 'subscription_upgrade'}
            cancelled()
            async def preflight(*, network_request=False):
                cancelled()
                latest, current, subscription_now = await read_subscription(page, target)
                if current['current_plan'] != 'plus' or subscription_now.get('plan_type') != 'plus':
                    raise Stop('incompatible_existing_subscription')
                if expected_country and await observe_page_network(page) != network_before:
                    raise Stop('proxy_ip_changed_during_login')
                current_preview = await browser_read(page, preview_path, latest)
                renewal_now = await visible_renewal(page, quote['today']['currency'])
                if quote_digest(preview_quote(current_preview, target_plan, renewal_now)) != quote_digest(quote):
                    raise Stop('upgrade_quote_changed')
                if await verify_selected_upgrade_card(page, guard.card_change, details, credential=latest) != method_id:
                    raise Stop('upgrade_payment_method_changed')
                await verify_preview_dom(page, quote, check_button=not network_request)
                cancelled()
            await preflight()
            ledger.begin(quote, details.last4)
            guard.preflight, guard.method_id, guard.approved = lambda: preflight(network_request=True), method_id, True
            cancelled()
            await button.click()
            await wait_upgrade_authentication(guard, wait_seconds, cancelled, progress)
            await observers.finish()
            result = await inspect_upgrade(page, target, ledger, guard, poll_count=poll_count, poll_interval=poll_interval)
            result.update(stage='payment_result', recheck_only=False)
            if guard.error and not ledger.record.get('payment_evidence'):
                result.update(guard.error.report)
            return result
        except Stop as exc:
            await observers.finish()
            result = {**exc.report, 'operation': 'subscription_upgrade', 'account_matched': True,
                      'target_plan': target_plan, 'stage': 'upgrade_checkout', 'payment_requests_sent': guard.sent}
            if ledger.record:
                result.update({k: v for k, v in ledger.record.items() if k in {
                    'upgrade_identifier', 'upgrade_invoice_identifier', 'upgrade_payment_intent_identifier',
                    'payment_status', 'payment_evidence', 'payment_attempted', 'confirmation_requests_sent', 'quote',
                    'quote_authority'}})
                if ledger.record['payment_status'] == 'paid':
                    status = outcome('paid', ledger.record.get('current_plan', 'unknown'), ledger.record['payment_evidence'],
                                     target_plan=target_plan, current_tier=ledger.record.get('current_tier'))
                    result.update(status=status, payment_outcome=status,
                                  **upgrade_authentication_summary(guard, ledger.record))
            return result
        finally:
            await observers.finish()
            await context.unroute('**/*', guard.route)
            if details is not None:
                details.clear()


async def recheck_upgrade_in_context(context, target, state_dir, target_plan, upgrade_id):
    from browser_checkout import run_browser
    async def dispatch(page, guard, identity):
        await context.unroute('**/*', guard.route)
        return await run_upgrade_in_context(page, target, state_dir, target_plan, upgrade_id=upgrade_id)
    return await run_browser(target, state_dir=state_dir, target_plan=target_plan,
                             browser_context=context, session_handler=dispatch)
