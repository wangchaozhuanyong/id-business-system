"""原生结算的受控读取与报价投影；不构造建单、计税或付款请求。"""
import hashlib
import json
import re
from urllib.parse import urlsplit

from checkout_core import CHECKOUT_PATH, MAX_BYTES, Stop, parse_credential, unique_object
from plans import plan_spec


def request_document(request):
    """正文只在内存解析；读取失败不能当作官网建单失败。"""
    try:
        value = request.post_data_json
        if isinstance(value, dict):
            return value, 'object'
    except Exception:
        pass
    try:
        raw = request.post_data_buffer
        if raw and len(raw) <= MAX_BYTES:
            value = json.loads(raw, object_pairs_hook=unique_object)
            if isinstance(value, dict):
                return value, 'object'
    except Exception:
        pass
    return None, 'unavailable'


def account_request_matches(headers, target):
    try:
        token = headers.get('authorization', '')
        if not token.startswith('Bearer '):
            return False
        credential = parse_credential(json.dumps({'accessToken': token[7:]}).encode())
        return (credential.account_id == target.account_id
                and headers.get('chatgpt-account-id', credential.account_id) == target.account_id)
    except (Stop, TypeError, ValueError):
        return False


def official_checkout_request(url):
    p = urlsplit(url)
    return (p.scheme == 'https' and p.hostname == 'chatgpt.com' and p.port in (None, 443)
            and p.username is None and p.password is None and p.path == CHECKOUT_PATH)


def billing_fingerprint(address, name):
    if not isinstance(address, dict) or not isinstance(name, str) or not name.strip():
        return None
    fields = ('country', 'line1', 'line2', 'city', 'state', 'postal_code')
    address = dict(address)
    # 官网可选字段可能返回 null；空第二行和不要求州的国家与表单留空等价。
    for key in ('line2', 'state'):
        if address.get(key) is None:
            address[key] = ''
    if any(not isinstance(address.get(k, ''), str) for k in fields):
        return None
    values = {k: ' '.join(address.get(k, '').strip().casefold().split()) for k in fields}
    if any(not values[k] for k in ('country', 'line1', 'city', 'postal_code')):
        return None
    if values['country'] in {'us', 'ca', 'au'} and not values['state']:
        return None
    values['name'] = ' '.join(name.strip().casefold().split())
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def native_session(data, checkout_id, entity, target_plan):
    session = data.get('checkout_session', data) if isinstance(data, dict) else None
    if (not isinstance(session, dict) or not checkout_id.startswith('oaics_')
            or session.get('checkout_session_id') != checkout_id
            or session.get('processor_entity') != entity
            or session.get('plan_name') != plan_spec(target_plan)['official_name']):
        return None
    state = session.get('checkout_state')
    if not isinstance(state, dict) or state.get('id') != checkout_id:
        return None
    return session


def native_quote_binding(data, checkout_id, entity, target_plan):
    session = native_session(data, checkout_id, entity, target_plan)
    if not session or session.get('status') != 'open' or session.get('payment_status') != 'unpaid':
        return None
    state = session['checkout_state']
    currency = str(state.get('currency', '')).upper()
    total, items, taxes = state.get('total'), state.get('lineItems'), state.get('taxAmounts')
    if not isinstance(total, dict) or not isinstance(items, list) or len(items) != 1 or not isinstance(taxes, list):
        return None
    item = items[0]
    if (not isinstance(item, dict) or item.get('quantity') != 1
            or not isinstance(item.get('recurring'), dict)
            or item['recurring'].get('interval') != 'month'
            or item['recurring'].get('intervalCount', 1) != 1):
        return None
    due = total.get('total')
    due = due.get('minorUnitsAmount') if isinstance(due, dict) else None
    tax_values = [tax.get('minorUnitsAmount') if isinstance(tax, dict) else None for tax in taxes]
    if (not re.fullmatch(r'[A-Z]{3}', currency) or type(due) is not int or not 0 < due <= 10**12
            or any(type(n) is not int or not 0 <= n <= due for n in tax_values)):
        return None
    billing = state.get('billingAddress')
    fingerprint = (billing_fingerprint(billing.get('address'), billing.get('name'))
                   if isinstance(billing, dict) else None)
    return {'amount_minor': due, 'currency': currency, 'tax_minor': sum(tax_values),
            'billing_fingerprint': fingerprint, 'native': True}


def unknown_checkout_recoverable(record):
    return bool(isinstance(record, dict) and record.get('status') == 'blocked'
        and record.get('reason') == 'checkout_unknown_write' and record.get('stage') == 'checkout_create'
        and record.get('account_matched') is True and record.get('payment_status') == 'not_attempted'
        and type(record.get('checkout_requests_sent')) is int and record['checkout_requests_sent'] == 1
        and (record.get('payment_attempted') is None or record.get('payment_attempted') is False)
        and all(record.get(k) is None or type(record[k]) is int and record[k] == 0
                for k in ('payment_requests_sent', 'confirmation_requests_sent', 'card_tokenization_requests_sent'))
        and not any(record.get(k) for k in ('checkout_identifier', 'payment_evidence',
            'manual_confirmation_accepted', 'upgrade_identifier', 'operation')))


async def read_recorded_native_checkout(page, credential, target_plan, sid, entity):
    """从已核实的同源会话后台读取原单；不导航、计税或提交付款。"""
    p = urlsplit(page.url)
    if (p.scheme != 'https' or p.hostname != 'chatgpt.com' or p.port not in (None, 443)
            or p.username or p.password or not isinstance(sid, str)
            or not re.fullmatch(r'oaics_[A-Za-z0-9_]{1,200}', sid)
            or not isinstance(entity, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,40}', entity)):
        raise Stop('existing_checkout_unknown')
    # 复用刚刚由官网会话/账户核对取得的凭据，只用于同源原单 GET，绝不写入诊断。
    result = await page.evaluate("""async ({path, token, account}) => {
        const c = new AbortController(), timer = setTimeout(() => c.abort(), 15000);
        try {
            const r = await fetch(path, {method:'GET', credentials:'same-origin', cache:'no-store',
                headers:{authorization:'Bearer '+token, 'chatgpt-account-id':account}, signal:c.signal});
            if (!r.ok) return null;
            const text = await r.text();
            return text.length <= 65000 ? JSON.parse(text) : null;
        } finally { clearTimeout(timer); }
    }""", {'path': CHECKOUT_PATH + '/' + entity + '/' + sid,
            'token': credential.token if hasattr(credential, 'token') else credential.old_token,
            'account': credential.account_id})
    session = native_session(result, sid, entity, target_plan)
    if not session:
        raise Stop('existing_checkout_unverified')
    if page.url != p.geturl():
        raise Stop('checkout_page_identifier_unverified')
    return session


async def read_original_native_checkout(page, credential, target_plan):
    """只读取唯一原窗口当前编号；不刷新页面，不发送正文，不提交订阅。"""
    p = urlsplit(page.url)
    match = re.fullmatch(r'/checkout/([a-z][a-z0-9_]{0,40})/(oaics_[A-Za-z0-9_]{1,200})/?', p.path)
    if not match:
        raise Stop('existing_checkout_unknown')
    entity, sid = match.groups()
    session = await read_recorded_native_checkout(page, credential, target_plan, sid, entity)
    if session.get('status') != 'open' or session.get('payment_status') != 'unpaid':
        raise Stop('existing_checkout_unverified')
    return session


class NativeQuoteObserver:
    def __init__(self, guard):
        self.guard = guard
        self.requests = {}

    def accept(self, data, version):
        g = self.guard
        binding = native_quote_binding(data, g.checkout_id, (g.result or {}).get('processor_entity'), g.target_plan)
        if binding and version == g.quote_request_version and not g.observations_closed:
            g.official_quote_binding = binding
            g.official_binding_version += 1
            g.official_quote_binding_request_version = version

    def observe(self, request):
        g, p = self.guard, urlsplit(request.url)
        if (not g.account_verified or not g.checkout_id or not g.checkout_id.startswith('oaics_')
                or p.scheme != 'https' or p.hostname != 'chatgpt.com' or p.port not in (None, 443)
                or p.username or p.password):
            return
        entity = (g.result or {}).get('processor_entity')
        if request.method == 'POST' and p.path == CHECKOUT_PATH + '/confirm':
            if g.read_only or not g.approved or g.operation_cancelled() or not g.payment_ledger:
                return
            data, _ = request_document(request)
            g.confirmation_sent += 1
            g.confirmation_reserved = True
            if g.confirm_request is None:
                g.confirm_request = request
                try:
                    g.payment_ledger.mark_confirmation_sent()
                except (OSError, Stop):
                    g.persistence_error = True
            if (not isinstance(data, dict) or data.get('checkout_session_id') != g.checkout_id
                    or not account_request_matches(request.headers, g.target) or g.confirmation_sent != 1):
                g.payment_error = 'payment_order_binding_changed'
            return
        reading = request.method == 'GET' and p.path == CHECKOUT_PATH + '/' + str(entity) + '/' + g.checkout_id
        updating = request.method == 'POST' and p.path in {CHECKOUT_PATH + '/taxes', CHECKOUT_PATH + '/update'}
        if not (reading or updating):
            return
        data, _ = request_document(request) if updating else ({}, None)
        bound = reading or (isinstance(data, dict) and data.get('checkout_session_id') == g.checkout_id
                            and data.get('processor_entity') == entity)
        g.quote_request_version += 1
        g.official_quote_binding = None
        if not g.approved:
            g.final_quote_verified = False
        self.requests[request] = (g.quote_request_version, bound)

    async def response(self, response):
        g = self.guard
        if (response.request is g.confirm_request and g.checkout_id and g.checkout_id.startswith('oaics_')
                and official_checkout_request(response.url.rsplit('/confirm', 1)[0])):
            try:
                from upgrade_authentication import response_body
                raw = await response_body(response, g)
                if (len(raw) > MAX_BYTES or g.confirmation_sent != 1
                        or g.payment_error == 'payment_order_binding_changed'
                        or not account_request_matches(await response.request.all_headers(), g.target)):
                    return True
                data = json.loads(raw, object_pairs_hook=unique_object)
                # 该官网响应明确返回 PI client_secret；只取标识关联后续原生 Stripe 回执。
                # secret 不回传、不保存，也不能单独证明付款成功。
                if isinstance(data, dict) and data.get('type') == 'payment_intent':
                    secret = data.get('client_secret')
                    match = re.fullmatch(r'(pi_[A-Za-z0-9]{1,180})_secret_[A-Za-z0-9]+', secret or '')
                    if match:
                        if g.linked_intent and g.linked_intent != match[1]:
                            g.payment_error = 'payment_intent_binding_changed'
                            return True
                        g.linked_intent = match[1]
                await g.consume_response(response, data, False, True, False, False)
            except (Stop, ValueError, TypeError, AttributeError):
                g.payment_error = 'payment_response_not_verified'
            finally:
                g.three_ds_ready.set()
            return True
        if response.request not in self.requests:
            return False
        version, bound = self.requests[response.request]
        if not bound or version != g.quote_request_version or not 200 <= response.status < 300:
            return True
        try:
            from upgrade_authentication import response_body
            headers = await response.request.all_headers()
            if not account_request_matches(headers, g.target):
                return True
            raw = await response_body(response, g)
            if len(raw) <= MAX_BYTES:
                data = json.loads(raw, object_pairs_hook=unique_object)
                self.accept(data, version)
        except (Stop, ValueError, TypeError, AttributeError):
            pass
        return True
