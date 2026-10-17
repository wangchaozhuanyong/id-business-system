"""只为官网明确过期、从未付款的原单申请一次新建资格。"""
import hashlib
from urllib.parse import urlsplit

from attempt_ledger import assert_no_other_payment, unpaid_checkout_replacement_allowed
from browser_checkout import check_session
from checkout_core import Stop
from native_checkout import read_recorded_native_checkout


def unattempted_checkout(record):
    if (not unpaid_checkout_replacement_allowed(record)
            or record.get('operation') == 'subscription_upgrade'
            or record.get('payment_evidence') or record.get('manual_confirmation_accepted')
            or record.get('payment_attempted') is not None and record['payment_attempted'] is not False):
        return False
    return all(record.get(key) is None or type(record[key]) is int and record[key] == 0
               for key in ('payment_requests_sent', 'confirmation_requests_sent',
                           'card_tokenization_requests_sent'))


async def expired_checkout_proof(context, target, state_dir, target_plan, record, budget=None):
    if context is None or not unattempted_checkout(record):
        return None
    sid, entity = record.get('checkout_identifier'), record.get('processor_entity')
    if not isinstance(sid, str) or not sid.startswith('oaics_'):
        return None
    assert_no_other_payment(state_dir, target.account_id)
    pages = [page for page in context.pages if urlsplit(page.url).scheme == 'https'
             and urlsplit(page.url).hostname == 'chatgpt.com']
    if not pages:
        raise Stop('existing_checkout_unverified')
    page = pages[0]
    credential, identity = await check_session(page, target, budget=budget)
    if identity.get('account_matched') is not True:
        raise Stop('official_account_mismatch')
    # 已有订阅使用原有套餐核实/升级路径，不能凭旧单过期另开订阅。
    if identity.get('current_plan') != 'free':
        return None
    read = lambda: read_recorded_native_checkout(page, credential, target_plan, sid, entity)
    session = await budget.run(read, 'quote_read') if budget else await read()
    if session.get('status') != 'expired' or session.get('payment_status') != 'unpaid':
        return None
    return {'checkout_identifier': sid, 'processor_entity': entity, 'target_plan': target_plan,
            'account_key': hashlib.sha256(target.account_id.encode()).hexdigest(),
            'status': 'expired', 'payment_status': 'unpaid'}
