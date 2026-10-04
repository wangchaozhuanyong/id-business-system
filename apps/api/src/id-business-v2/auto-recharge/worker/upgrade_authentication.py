"""原升级唯一 update 后的临时认证权限；不构造认证或付款请求。"""
import asyncio
import os
import time
from urllib.parse import urlsplit

from payment_3ds import AUTH_PATHS, ThreeDSAuthentication, checkout_resource_url


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


async def drain_upgrade_responses(tasks):
    deadline = time.monotonic() + 5
    while tasks:
        observed = set(tasks)
        _, pending = await asyncio.wait(observed, timeout=max(0, deadline - time.monotonic()))
        for task in pending:
            task.cancel()
        await asyncio.gather(*observed, return_exceptions=True)
        tasks.difference_update(observed)


class UpgradeResponseObservers:
    """Fence new observations and settle every captured response before a receipt."""
    def __init__(self, context, guard):
        self.context, self.guard = context, guard
        self.tasks = set()
        self.attached = True
        context.on('response', self.observe)

    def observe(self, response):
        task = asyncio.create_task(self.guard.response(response))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def finish(self):
        self.guard.approved = False
        self.guard.three_ds.finish()
        if getattr(self.guard, 'card_change', None) is not None:
            self.guard.card_change.close()
        if self.attached:
            self.context.remove_listener('response', self.observe)
            self.attached = False
        await drain_upgrade_responses(self.tasks)


async def route_upgrade_card_change(guard, route):
    decision = await guard.card_change.decision(route.request)
    if decision is None:
        return False
    if decision and guard.operation_cancelled():
        decision = False
    guard.blocked_unknown_writes += int(not decision and route.request.method not in {'GET', 'HEAD', 'OPTIONS'})
    await (route.fallback() if decision else route.abort('blockedbyclient'))
    return True


def upgrade_authentication_summary(guard, record):
    status = record.get('three_ds_status', guard.three_ds.status)
    details = {'three_ds_status': status}
    if record.get('payment_status') == 'requires_action':
        details['reason'] = ('three_ds_binding_unverified' if status == 'unsupported' else
                             'three_ds_authentication_failed' if status == 'failed' else
                             'bank_verification_required')
    return details
