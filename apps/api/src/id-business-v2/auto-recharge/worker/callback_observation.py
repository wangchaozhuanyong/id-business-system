"""回调失败只提取白名单诊断；请求及服务端原正文不进入结果。"""
import json
import re
import time

from checkout_core import unique_object

CALLBACK_METADATA_KEYS = {'callback_http_status', 'callback_operation', 'callback_phase',
    'callback_error_code', 'callback_request_id', 'callback_failure_kind', 'callback_business_reason'}
CALLBACK_TYPES = {'progress', 'restore', 'ledger', 'finished', 'prepare_next_subscription_cycle',
    'resolve_unknown_payment', 'stale_profile_cleanup'}
ERROR_REASONS = {
    (409, '该账户仍有未核实付款或订阅待生效，只能复查原订单'): 'callback_previous_payment_unverified',
    (409, '该账户仍有未完成的原结算，不能创建新周期订单'): 'callback_previous_checkout_unfinished',
    (409, '原订单持久化记录缺失，禁止创建新订单'): 'callback_original_checkout_missing',
    (409, '原订单记录未核实，禁止创建新订单'): 'callback_original_checkout_unverified',
    (409, '原订单编号未核实，禁止创建新订单'): 'callback_original_checkout_unverified',
    (409, '原订单编号不一致，禁止创建新订单'): 'callback_original_checkout_mismatch',
    (409, '原付款记录未核实，禁止创建新订单'): 'callback_original_payment_unverified',
    (409, '原订单编号不一致，历史付款状态未核实'): 'callback_original_payment_unverified',
    (403, '该账户属于另一操作人的原任务'): 'callback_account_owned_by_another_operator',
    (409, '本次任务已绑定另一比特窗口，不能覆盖原窗口'): 'callback_profile_binding_conflict',
    (409, '原单付款状态未安全核实，不能更换比特窗口'): 'callback_original_payment_profile_unverified',
    (409, '本次任务已绑定原比特窗口，不能更换窗口'): 'callback_profile_replacement_conflict',
}


def operation_metadata(body):
    result = {}
    if isinstance(body, dict) and isinstance(body.get('type'), str) and body['type'] in CALLBACK_TYPES:
        result['callback_operation'] = body['type']
        if (body['type'] == 'prepare_next_subscription_cycle' and isinstance(body.get('phase'), str)
                and body['phase'] in {'inspect', 'status', 'commit'}):
            result['callback_phase'] = body['phase']
    return result


def secret_values(body, token):
    values = [token] if isinstance(token, str) and token else []
    sensitive = {'token', 'agenttoken', 'accesstoken', 'sessiontoken', 'sessionjson', 'oldtoken',
        'password', 'cvc', 'number', 'cardnumber', 'authorization', 'localapitoken', 'totpsecret', 'cookie'}
    def walk(value, depth):
        if depth > 8:
            return
        if isinstance(value, list):
            for item in value:
                walk(item, depth + 1)
            return
        if not isinstance(value, dict):
            return
        for key, item in value.items():
            if isinstance(key, str) and key.lower().replace('_', '') in sensitive and isinstance(item, str) and item:
                values.append(item)
                if key.lower().replace('_', '') == 'sessionjson':
                    try:
                        walk(json.loads(item, object_pairs_hook=unique_object), depth + 1)
                    except (ValueError, TypeError):
                        pass
            elif isinstance(item, (dict, list)):
                walk(item, depth + 1)
    walk(body, 0)
    return values


def safe_identifier(value, pattern, secrets):
    return (isinstance(value, str) and re.fullmatch(pattern, value) is not None
        and not any(secret in value for secret in secrets))


def read_callback_bytes(response, deadline, expired, limit):
    chunks, size = [], 0
    while True:
        remaining = deadline - time.monotonic()
        if expired.is_set() or remaining <= 0:
            raise TimeoutError()
        sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
        if sock is not None:
            sock.settimeout(remaining)
        read = getattr(response, 'read1', response.read)
        chunk = read(min(65536, limit + 1 - size))
        if not chunk:
            return b''.join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            raise ValueError()


def http_failure_metadata(error, body, token):
    metadata = {**operation_metadata(body), 'callback_failure_kind': 'http'}
    if type(error.code) is int and 400 <= error.code <= 599:
        metadata['callback_http_status'] = error.code
    request_id = error.headers.get('X-Request-Id') if error.headers is not None else None
    if safe_identifier(request_id, r'[A-Za-z0-9._:-]{8,128}', secret_values(body, token)):
        metadata['callback_request_id'] = request_id
    return metadata


def enrich_http_failure(metadata, data, body, token):
    if not isinstance(data, dict):
        return
    secrets = secret_values(body, token)
    code, request_id = data.get('errorCode'), data.get('requestId')
    if safe_identifier(code, r'[A-Z][A-Z0-9_]{0,63}', secrets):
        metadata['callback_error_code'] = code
    if safe_identifier(request_id, r'[A-Za-z0-9._:-]{8,128}', secrets):
        metadata.setdefault('callback_request_id', request_id)
    message = data.get('message')
    if isinstance(message, str):
        reason = ERROR_REASONS.get((metadata.get('callback_http_status'), message))
        if reason:
            metadata['callback_business_reason'] = reason


def parse_http_failure(raw):
    return json.loads(raw, object_pairs_hook=unique_object)
