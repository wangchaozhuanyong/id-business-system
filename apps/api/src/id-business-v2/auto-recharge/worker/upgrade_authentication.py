"""原升级唯一 update 后的临时认证权限；不构造认证或付款请求。"""
import asyncio
import os
import re
import time
from urllib.parse import urlsplit

from payment_3ds import AUTH_PATHS, ThreeDSAuthentication, checkout_resource_url
from checkout_core import MAX_BYTES


def consume_task(task):
    if not task.cancelled():
        task.exception()


async def response_body(response, guard):
    """正文等待有绝对截止，取消不依赖正文协程立即响应。"""
    remaining = min(30, max(0, getattr(guard, 'observation_deadline', float('inf')) - time.monotonic()))
    task = asyncio.create_task(response.body())
    try:
        done, _ = await asyncio.wait({task}, timeout=remaining)
        if not done or getattr(guard, 'observations_closed', False):
            raise asyncio.TimeoutError()
        return task.result()
    finally:
        if not task.done():
            task.cancel()
            task.add_done_callback(consume_task)


def authentication_facts(data):
    """只在内存保存关联和结果字段，不保留原响应或支付秘密。"""
    if not isinstance(data, dict):
        return None
    scalar = {'object', 'id', 'status', 'state', 'session_id', 'payment_status',
              'amount', 'amount_received', 'currency', 'confirmation_method'}
    result = {key: value for key, value in data.items()
              if key in scalar and type(value) in (str, int, bool)}
    for key in ('source', 'payment_intent', 'setup_intent'):
        value = data.get(key)
        if isinstance(value, str):
            result[key] = value
        elif isinstance(value, dict):
            result[key] = authentication_facts(value)
    ares = data.get('ares')
    if isinstance(ares, dict):
        result['ares'] = {key: value for key, value in ares.items()
                          if key in {'acsURL', 'threeDSServerTransID', 'acsTransID'}
                          and isinstance(value, str)}
    error = data.get('error')
    if (isinstance(error, dict) and isinstance(error.get('code'), str)
            and re.fullmatch(r'[a-z0-9_]{1,80}', error['code'])):
        result['error'] = {'code': error['code']}
    return result


class AuthenticationReceipts:
    """原确认之后先到的认证回包，绑定原 intent 后才允许作为事实。"""
    def __init__(self, origin_frame=None):
        self.binding = ThreeDSAuthentication(origin_frame)
        self.pending = []
        self.bytes = 0

    def capture(self, request, status, data, raw_size):
        parsed = urlsplit(request.url)
        if (parsed.scheme != 'https' or parsed.hostname != 'api.stripe.com'
                or parsed.path not in AUTH_PATHS or request.method != 'POST'
                or raw_size > MAX_BYTES or len(self.pending) >= 8
                or self.bytes + raw_size > MAX_BYTES
                or any(item[0] is request for item in self.pending)):
            return False
        facts = authentication_facts(data)
        if facts is None:
            return False
        self.pending.append((request, status, facts, raw_size))
        self.bytes += raw_size
        return True

    def bind(self, intent, expected_id):
        return self.binding.bind(intent, expected_id)

    async def verified(self, request, target, checkout_id):
        if request in self.binding.requests:
            return True
        # This separate authority validates receipts only. It never routes a
        # request, starts a challenge or reopens the action gate after cancel.
        verified = await self.binding._decision(request, target, checkout_id) is True
        if not verified:
            self.binding.requests.pop(request, None)
        return verified

    def take(self):
        pending, self.pending, self.bytes = self.pending, [], 0
        return pending

    def clear(self):
        self.pending.clear()
        self.bytes = 0
        self.binding.close()
        self.binding.requests.clear()
        self.binding.client_secret = None


class UpgradeAuthentication(ThreeDSAuthentication):
    def __init__(self, origin_frame=None):
        super().__init__(origin_frame)
        self.ready = asyncio.Event()
        self.closed = False

    def finish(self):
        self.closed = True
        self.close()
        self.ready.set()

    def original_frame_matches(self, frame):
        return self.origin_frame is None or frame is self.origin_frame and self.frame_allowed(frame, None)

    def bind_action(self, intent, record):
        today = record['quote']['today']
        if (isinstance(intent, dict) and type(intent.get('amount')) is int
                and intent['amount'] == today['amount_minor']
                and str(intent.get('currency', '')).upper() == today['currency']
                and intent.get('confirmation_method') == 'automatic'):
            return self.bind(intent, record.get('upgrade_payment_intent_identifier'))
        return self.reject()

    async def original_request_decision(self, request, target, *, sent, read_only, payment_status):
        if read_only or self.closed or sent != 1:
            return None
        p = urlsplit(request.url)
        if (payment_status() in {'unknown', 'requires_action'} and not self.ready.is_set()
                and (p.hostname == 'api.stripe.com' and p.path in AUTH_PATHS
                     and p.path not in self.requests.values()
                     or request.method in {'GET', 'HEAD'} and request.is_navigation_request()
                     and p.hostname != 'chatgpt.com')):
            try:
                await asyncio.wait_for(self.ready.wait(), timeout=5)
            except asyncio.TimeoutError:
                return False
        if self.closed or payment_status() != 'requires_action':
            return None
        decision = await self.decision(request, target, None)
        if decision and (self.closed or not self.active or payment_status() != 'requires_action'):
            return False
        if decision is None and not checkout_resource_url(request.url):
            decision = False
        if decision and p.hostname == 'api.stripe.com' and p.path in AUTH_PATHS and request.method == 'POST':
            self.ready.clear()
        return decision


async def wait_upgrade_authentication(guard, wait_seconds, cancelled, progress, *, page=None, handoff=None):
    from payment_handoff import challenge_frames
    deadline = time.monotonic() + (300 if handoff else wait_seconds)
    announced = False
    handed_off = set()
    while time.monotonic() < deadline:
        cancelled()
        if guard.done.is_set() and (guard.upgrade_ledger.record['payment_status'] != 'requires_action'
                or guard.error or guard.three_ds.status in {'failed', 'unsupported'}):
            break
        if handoff:
            kind = 'bank' if guard.three_ds.needs_user else 'hcaptcha'
            if kind not in handed_off and (kind == 'bank' or await challenge_frames(page, guard, kind)):
                handed_off.add(kind)
                await handoff(page, guard, kind)
                continue
        if guard.done.is_set():
            if (guard.upgrade_ledger.record['payment_status'] != 'requires_action' or guard.error
                    or guard.three_ds.status in {'failed', 'unsupported'}):
                break
            if guard.three_ds.needs_user:
                if not announced:
                    progress('bank_verification_required', operation='subscription_upgrade',
                             instruction='请本人完成官网或银行验证，程序只等待原单结果。')
                    announced = True
                if os.environ.get('AUTO_RECHARGE_CALLBACK_URL') not in (None, '', 'local-bitbrowser'):
                    break  # 服务器无本人可操作窗口；BitBrowser 保留原窗口等待。
        await asyncio.sleep(.05)


async def drain_upgrade_responses(tasks, *, seconds=5):
    deadline = time.monotonic() + seconds
    while tasks:
        observed = set(tasks)
        _, pending = await asyncio.wait(observed, timeout=max(0, deadline - time.monotonic()))
        for task in pending:
            task.cancel()
            task.add_done_callback(consume_task)
        for task in observed - pending:
            consume_task(task)
        tasks.difference_update(observed)
        if time.monotonic() >= deadline:
            for task in list(tasks):
                task.cancel()
                task.add_done_callback(consume_task)
            tasks.clear()
            break


class UpgradeResponseObservers:
    """Fence new observations and settle every captured response before a receipt."""
    def __init__(self, context, guard):
        self.context, self.guard = context, guard
        self.tasks = set()
        self.attached = True
        context.on('request', guard.observe_request)
        context.on('response', self.observe)

    def observe(self, response):
        if not self.attached:
            return
        task = asyncio.create_task(self.guard.response(response))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        task.add_done_callback(consume_task)

    async def finish(self):
        if not self.attached:
            return
        self.guard.armed = False
        self.guard.approved = False
        self.guard.read_only = True
        self.guard.settling = True
        self.guard.observation_deadline = time.monotonic() + 5
        if callable(getattr(self.guard, 'begin_settling', None)):
            self.guard.begin_settling()
        if callable(getattr(self.guard, 'finish_three_ds', None)):
            self.guard.finish_three_ds()
        elif getattr(self.guard, 'three_ds', None) is not None:
            self.guard.three_ds.finish()
        if getattr(self.guard, 'card_change', None) is not None:
            self.guard.card_change.close()
        if self.attached:
            self.context.remove_listener('request', self.guard.observe_request)
            self.context.remove_listener('response', self.observe)
            self.attached = False
        await drain_upgrade_responses(self.tasks)
        self.guard.observations_closed = True
        if getattr(self.guard, 'authentication_receipts', None) is not None:
            self.guard.authentication_receipts.clear()


async def route_upgrade_card_change(guard, route):
    decision = await guard.card_change.decision(route.request)
    if decision is None:
        return False
    if decision and guard.operation_cancelled():
        decision = False
    await route.fallback()
    return True


def upgrade_authentication_summary(guard, record):
    status = record.get('three_ds_status', guard.three_ds.status)
    details = {'three_ds_status': status}
    if record.get('payment_status') == 'requires_action':
        details['reason'] = ('three_ds_binding_unverified' if status == 'unsupported' else
                             'three_ds_authentication_failed' if status == 'failed' else
                             'bank_verification_required')
    return details
