"""Memory-only, frame-scoped human actions for the original payment challenge."""
import asyncio
import base64
from datetime import datetime, timedelta, timezone
import math
import re
import time
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from checkout_core import Stop, verify_official_session
from payment_3ds import https_origin, STRIPE_FRAMES, ThreeDSAuthentication

KEYS = {'Tab', 'Enter', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'}
SENSITIVE = ('input[type="password"],input[autocomplete^="cc-"],'
             'input[name*="card" i],input[id*="card" i],input[name*="pan" i],'
             'input[name*="cvc" i],input[id*="cvc" i],input[name*="cvv" i],'
             'input[id*="cvv" i],input[name*="password" i],input[id*="password" i]')


def hcaptcha_url(url):
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ''
        return (parsed.scheme == 'https' and not parsed.username and not parsed.password
                and parsed.port in (None, 443)
                and (host == 'hcaptcha.com' or host.endswith('.hcaptcha.com')))
    except ValueError:
        return False


def uuid_value(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, TypeError):
        return False


def controller_cancelled(controller):
    deadline = getattr(controller, 'handoff_deadline', None)
    return bool(getattr(controller, 'cancelled', False) or getattr(controller, 'handoff_revoked', False)
                or deadline and time.monotonic() >= deadline)


def command_value(value):
    if not isinstance(value, dict):
        raise Stop('handoff_command_invalid')
    common = {'commandId', 'sessionId', 'frameId', 'revision', 'type'}
    fields = {'click': {'x', 'y'}, 'key': {'key'}, 'text': {'text'}, 'scroll': {'deltaY'}}
    kind = value.get('type')
    if (not isinstance(kind, str) or kind not in fields or set(value) != common | fields[kind]
            or any(not uuid_value(value.get(key)) for key in ('commandId', 'sessionId', 'frameId'))
            or type(value.get('revision')) is not int or value['revision'] < 1):
        raise Stop('handoff_command_invalid')
    if kind == 'click' and any(type(value[key]) not in (int, float) or not math.isfinite(value[key])
                               for key in ('x', 'y')):
        raise Stop('handoff_command_invalid')
    if kind == 'key' and (not isinstance(value['key'], str) or value['key'] not in KEYS):
        raise Stop('handoff_command_invalid')
    if kind == 'text' and (not isinstance(value['text'], str) or not 1 <= len(value['text']) <= 64
                           or re.search(r'[\x00-\x1f\x7f]', value['text'])):
        raise Stop('handoff_command_invalid')
    if kind == 'scroll' and (type(value['deltaY']) is not int or not -600 <= value['deltaY'] <= 600):
        raise Stop('handoff_command_invalid')
    return value


def payment_binding(guard):
    ledger = getattr(guard, 'payment_ledger', None) or getattr(guard, 'upgrade_ledger', None)
    record = ledger.record if ledger else None
    if not record or record.get('payment_attempted') is not True:
        raise Stop('handoff_binding_invalid')
    identifier = record.get('checkout_identifier') or record.get('upgrade_identifier')
    if not identifier or (getattr(guard, 'checkout_id', identifier) != identifier
                          and not getattr(guard, 'upgrade_ledger', None)):
        raise Stop('handoff_binding_invalid')
    return (identifier, record.get('quote_digest'), guard.target.account_id,
            record.get('upgrade_payment_intent_identifier') or getattr(guard, 'linked_intent', None))


def frame_ancestor(frame, page):
    current = frame.parent_frame
    for _ in range(10):
        if current is page.main_frame:
            return True
        if current is None or (https_origin(current.url) not in STRIPE_FRAMES and not hcaptcha_url(current.url)):
            return False
        current = current.parent_frame
    return False


async def challenge_frames(page, guard, kind=None):
    found = []
    for frame in page.frames:
        if frame is page.main_frame:
            continue
        bank = (guard.three_ds.active and guard.three_ds.needs_user
                and frame in guard.three_ds.frames
                and https_origin(frame.url) == guard.three_ds.frames[frame])
        captcha = hcaptcha_url(frame.url) and frame_ancestor(frame, page)
        candidate_kind = 'bank' if bank else 'hcaptcha' if captcha else None
        if not candidate_kind or kind and candidate_kind != kind:
            continue
        if captcha and await frame.locator('[role="checkbox"][aria-checked="true"]').count():
            continue
        element = await frame.frame_element()
        box = await element.bounding_box()
        if (await element.is_visible() and box and 8 <= box['width'] <= 2048
                and 8 <= box['height'] <= 2048):
            found.append((box['width'] * box['height'], candidate_kind, frame, element, box))
    found.sort(key=lambda item: item[0], reverse=True)
    return found


async def sensitive_visible(field, owner, page, area, crop):
    x = (max(area['x'], crop['x']) + min(area['x'] + area['width'], crop['x'] + crop['width'])) / 2
    y = (max(area['y'], crop['y']) + min(area['y'] + area['height'], crop['y'] + crop['height'])) / 2
    visible = await field.evaluate('''(el, p) => {
        const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+p.x,r.y+p.y);
        return hit === el || el.contains(hit);
    }''', {'x': x - area['x'], 'y': y - area['y']})
    while visible and owner is not page.main_frame:
        surface = await owner.frame_element()
        box = await surface.bounding_box()
        if not box:
            return False
        visible = await surface.evaluate('''(el, p) => {
            const r=el.getBoundingClientRect();
            return document.elementFromPoint(r.x+p.x,r.y+p.y) === el;
        }''', {'x': x - box['x'], 'y': y - box['y']})
        owner = owner.parent_frame
    return visible


async def hcaptcha_resource_allowed(request, target, *, enabled):
    """Only official widget traffic, never siteverify or another payment continuation."""
    if not enabled or not hcaptcha_url(request.url):
        return None
    frame = getattr(request, 'frame', None)
    current = frame
    ancestry = False
    for _ in range(10):
        if current is None:
            break
        origin = https_origin(current.url)
        if origin in {'https://chatgpt.com', 'https://checkout.stripe.com'}:
            ancestry = True
            break
        initial_widget = (current is frame and current.url in {'', 'about:blank'}
            and request.method == 'GET' and request.is_navigation_request())
        if not initial_widget and not hcaptcha_url(current.url) and origin not in STRIPE_FRAMES:
            break
        current = current.parent_frame
    if not ancestry or not await ThreeDSAuthentication().safe_headers(request, target):
        return False
    parsed = urlsplit(request.url)
    if request.method in {'GET', 'HEAD', 'OPTIONS'}:
        return parsed.path != '/siteverify'
    return (request.method == 'POST' and (hcaptcha_url(getattr(frame, 'url', '')) or parsed.path == '/checksiteconfig')
            and bool(re.fullmatch(r'/(?:checksiteconfig|getcaptcha(?:/[A-Za-z0-9_-]{1,100})?|checkcaptcha/[A-Za-z0-9_-]{1,100})', parsed.path)))


class PaymentHandoff:
    def __init__(self, job, page, guard, kind, *, deadline=None, expires_at=None):
        self.job, self.page, self.context, self.guard, self.kind = job, page, page.context, guard, kind
        self.page_url, self.pages = page.url, tuple(page.context.pages)
        if https_origin(self.page_url) not in {'https://chatgpt.com', 'https://checkout.stripe.com'}:
            raise Stop('handoff_page_untrusted')
        identity_pages = [candidate for candidate in self.pages if https_origin(candidate.url) == 'https://chatgpt.com']
        self.identity_page = page if page in identity_pages else identity_pages[0] if len(identity_pages) == 1 else None
        if self.identity_page is None:
            raise Stop('handoff_identity_page_unavailable')
        self.identity_url = self.identity_page.url
        self.binding = payment_binding(guard)
        self.intent = guard.three_ds.intent_id
        self.session_id, self.frame_id = str(uuid4()), str(uuid4())
        self.revision, self.frame, self.frame_url, self.box = 1, None, None, None
        self.dom_stamp = None
        self.deadline = deadline or time.monotonic() + 300
        self.expires_at = expires_at or (datetime.now(timezone.utc) + timedelta(seconds=300)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        self.closed = False
        self.revoked = False
        self.commands = set()
        self.lock = asyncio.Lock()
        self.operations = set()
        self.input_operations = set()
        self.browser_operations = set()
        self.loop = asyncio.get_running_loop()
        self.closing_context = False

    def check_page(self):
        if self.job.cancelled or self.job.done:
            raise Stop('operation_cancelled')
        if self.closed or time.monotonic() >= self.deadline:
            raise Stop('handoff_expired')
        if (self.page.is_closed() or self.page.context is not self.context or self.page.url != self.page_url
                or tuple(self.context.pages) != self.pages or payment_binding(self.guard)[:3] != self.binding[:3]
                or self.identity_page.is_closed()
                or self.identity_page.url != self.identity_url):
            raise Stop('handoff_binding_changed')

    def check(self):
        self.check_page()
        if payment_binding(self.guard) != self.binding or self.guard.three_ds.intent_id != self.intent:
            raise Stop('handoff_binding_changed')

    async def validate(self, *, verify_identity=True):
        self.check()
        # Read the current original page's session; never create another tab or return its contents.
        from browser_checkout import browser_read
        if verify_identity:
            session = await asyncio.wait_for(browser_read(self.identity_page, '/api/auth/session'), timeout=2)
            verify_official_session(session, self.guard.target)
        self.check()
        found = await challenge_frames(self.page, self.guard, self.kind)
        if not found:
            raise Stop('handoff_frame_unavailable')
        _, _, frame, element, box = found[0]
        stamp = await frame.locator('body').evaluate('''async el => {
            const copy=el.cloneNode(true);
            copy.querySelectorAll('[style]').forEach(n=>n.setAttribute('style',n.style.cssText));
            const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(copy.innerHTML));
            return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2,'0')).join('');
        }''')
        if (self.frame is not frame or self.frame_url != frame.url or self.box != box):
            self.frame, self.frame_url, self.box = frame, frame.url, box
            self.frame_id, self.revision = str(uuid4()), self.revision + 1
        elif self.dom_stamp != stamp:
            self.revision += 1
        self.dom_stamp = stamp
        if await frame.locator(SENSITIVE).count():
            raise Stop('handoff_sensitive_frame')
        if await frame.locator('body').evaluate("el => /(?:\\d[ -]?){13,19}/.test(el.innerText)"):
            raise Stop('handoff_sensitive_frame')
        # A crop must not include an overlay or a sibling card/password frame.
        ancestor = frame
        while ancestor is not self.page.main_frame:
            surface = await ancestor.frame_element()
            if not await surface.evaluate('''el => {
                const r = el.getBoundingClientRect(), style = getComputedStyle(el);
                if (+style.opacity < .99 || style.visibility !== 'visible') return false;
                if (![.01,.25,.5,.75,.99].every(x => [.01,.25,.5,.75,.99].every(y =>
                    document.elementFromPoint(r.x+r.width*x,r.y+r.height*y) === el))) return false;
                return Array.from(document.querySelectorAll('*')).every(n => {
                    if (n === el || n.contains(el)) return true;
                    const a=n.getBoundingClientRect();
                    if (!a.width || !a.height || a.right<=r.left || a.left>=r.right || a.bottom<=r.top || a.top>=r.bottom) return true;
                    const x=(Math.max(a.left,r.left)+Math.min(a.right,r.right))/2;
                    const y=(Math.max(a.top,r.top)+Math.min(a.bottom,r.bottom))/2;
                    return document.elementFromPoint(x,y) === el;
                });
            }'''):
                raise Stop('handoff_frame_obscured')
            ancestor = ancestor.parent_frame
        for other in self.page.frames:
            for field in await other.locator(SENSITIVE).all():
                area = await field.bounding_box()
                if (area and area['x'] < box['x'] + box['width'] and box['x'] < area['x'] + area['width']
                        and area['y'] < box['y'] + box['height'] and box['y'] < area['y'] + area['height']
                        and await sensitive_visible(field, other, self.page, area, box)):
                    raise Stop('handoff_sensitive_frame')
        self.check()
        return frame, element, box

    async def snapshot(self):
        operation = asyncio.current_task()
        self.operations.add(operation)
        try:
            return await self._snapshot()
        finally:
            self.operations.discard(operation)

    async def _snapshot(self):
        async with self.lock:
            frame, element, box = await self.validate()
            capture = (self.frame_id, self.revision, self.dom_stamp)
            masks = [frame.locator('input,textarea,[contenteditable=true]')]
            masks.extend(other.locator(SENSITIVE) for other in self.page.frames if other is not frame)
            image = await element.screenshot(type='jpeg', quality=55, scale='css', timeout=3000,
                mask=masks, mask_color='#000000',
                style='iframe { background-color: #ffffff !important; }')
            self.check()
            latest_frame, _, latest_box = await self.validate()
            if (frame.is_detached() or latest_frame is not frame or latest_box != box
                    or capture != (self.frame_id, self.revision, self.dom_stamp)):
                raise Stop('handoff_binding_changed')
            if len(image) > 1_000_000:
                raise Stop('handoff_image_too_large')
            return {'sessionId': self.session_id, 'frameId': self.frame_id, 'revision': self.revision,
                    'kind': self.kind, 'image': 'data:image/jpeg;base64,' + base64.b64encode(image).decode(),
                    'width': math.floor(box['width']), 'height': math.floor(box['height']), 'expiresAt': self.expires_at}

    async def command(self, value):
        value = command_value(value)
        operation = asyncio.current_task()
        self.operations.add(operation)
        self.input_operations.add(operation)
        try:
            return await self._command(value)
        finally:
            self.operations.discard(operation)
            self.input_operations.discard(operation)

    async def _command(self, value):
        async with self.lock:
            frame, element, box = await self.validate()
            if (value['sessionId'] != self.session_id or value['frameId'] != self.frame_id
                    or value['revision'] != self.revision):
                raise Stop('handoff_binding_changed')
            if value['commandId'] in self.commands or len(self.commands) >= 600:
                raise Stop('handoff_command_replayed')
            self.commands.add(value['commandId'])  # reserve before an action can yield
            binding = (frame, self.frame_url, box, self.dom_stamp)
            observer = asyncio.create_task(self.observe_action(asyncio.current_task(), binding))
            try:
                return await self.apply_command(value, frame, element, box)
            finally:
                observer.cancel()
                await asyncio.gather(observer, return_exceptions=True)

    async def observe_action(self, operation, binding):
        try:
            while not operation.done():
                await asyncio.sleep(.05)
                await self.validate(verify_identity=False)
                if binding != (self.frame, self.frame_url, self.box, self.dom_stamp):
                    raise Stop('handoff_binding_changed')
        except asyncio.CancelledError:
            raise
        except Exception:
            self.close(revoke=True)

    async def apply_command(self, value, frame, element, box):
        kind = value['type']
        if await frame.locator(SENSITIVE).count():
            raise Stop('handoff_sensitive_frame')
        if kind == 'click':
            if not 0 <= value['x'] < math.floor(box['width']) or not 0 <= value['y'] < math.floor(box['height']):
                raise Stop('handoff_command_invalid')
            if not await element.evaluate('''(el, p) => {
                const r = el.getBoundingClientRect();
                return document.elementFromPoint(r.x+p.x,r.y+p.y) === el;
            }''', {'x': value['x'], 'y': value['y']}):
                raise Stop('handoff_frame_obscured')
            self.check()
            await self.perform_input(lambda: element.click(position={'x': value['x'], 'y': value['y']}, timeout=2000))
        elif kind in {'key', 'text'}:
            if not await element.evaluate('el => document.activeElement === el'):
                raise Stop('handoff_focus_invalid')
            focus = frame.locator(':focus')
            if await focus.count() != 1:
                raise Stop('handoff_focus_invalid')
            if kind == 'text':
                if not await focus.evaluate('''(el, blocked) =>
                    !el.matches(blocked) && el.matches('input:not([type=password]),textarea,[contenteditable=true]')''', SENSITIVE):
                    raise Stop('handoff_focus_invalid')
                await self.perform_input(lambda: focus.fill(value['text'], timeout=2000))
            else:
                await self.perform_input(lambda: focus.press(value['key'], timeout=2000))
        else:
            if not await element.evaluate('el => document.activeElement === el'):
                raise Stop('handoff_focus_invalid')
            await self.perform_input(lambda: frame.locator('body').evaluate('(el, delta) => window.scrollBy(0, delta)', value['deltaY']))
        self.check()
        if frame.is_detached() or frame.url != self.frame_url:
            raise Stop('handoff_binding_changed')
        self.revision += 1
        return {'commandId': value['commandId'], 'accepted': True}

    async def perform_input(self, action):
        self.check()
        operation = asyncio.current_task()
        self.browser_operations.add(operation)
        result = await action()
        # Only a completed browser call can release the pending-input fence.
        # Cancellation of its Python caller alone cannot establish completion.
        self.browser_operations.discard(operation)
        return result

    def close(self, *, revoke=False):
        revoke = revoke or bool(self.input_operations or self.browser_operations)
        self.closed = True
        if revoke:
            self.revoked = True
            self.job.handoff_revoked = True
            self.guard.approved = False
            self.guard.read_only = True
            self.guard.three_ds.close()
            card_change = getattr(self.guard, 'card_change', None)
            if card_change:
                card_change.close()
        self.frame = None
        if revoke and (self.operations or self.browser_operations) and not self.closing_context:
            # Cancelling a Python await alone may leave browser-side auto-wait
            # alive. End this revoked window before it can dispatch late input.
            self.closing_context = True
            def end_window():
                task = self.loop.create_task(self.context.close())
                def settled(done):
                    self.browser_operations.clear()
                    if not done.cancelled():
                        done.exception()
                task.add_done_callback(settled)
            self.loop.call_soon_threadsafe(end_window)
        for operation in tuple(self.operations):
            self.loop.call_soon_threadsafe(operation.cancel)
