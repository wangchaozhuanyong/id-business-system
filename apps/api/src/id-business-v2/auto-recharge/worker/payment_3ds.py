"""Ephemeral authentication authority for one original Stripe intent.

Stripe.js owns the authentication flow. This module never builds authentication
requests, enters an issuer code, or authorizes another payment confirmation.
"""
import base64
import ipaddress
import json
import re
import time
from urllib.parse import parse_qs, unquote, urljoin, urlsplit

SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}
AUTH_PATHS = {'/v1/3ds2/authenticate', '/v1/3ds2/challenge_complete'}
PAYMENT_PATH = re.compile(r'/(?:payments?|payment_intents|setup_intents|charges?|capture|purchase|tokens?|checkout|billing)(?:/|$)', re.I)
STRIPE_FRAMES = {'https://js.stripe.com', 'https://hooks.stripe.com', 'https://checkout.stripe.com'}


def https_origin(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if (len(value) > 8192 or parsed.scheme != 'https'
                or parsed.username or parsed.password or parsed.port not in {None, 443}
                or parsed.fragment or not re.fullmatch(r'[A-Za-z0-9.-]+', host)
                or '.' not in host or host.endswith(('.', '.local', '.localhost', '.internal'))
                or not host.rsplit('.', 1)[-1].isalpha() or '..' in host):
            return None
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            pass
        return 'https://' + host.lower()
    except (TypeError, ValueError):
        return None


def fields(value):
    if not isinstance(value, str) or len(value) > 65536:
        return None
    try:
        data = json.loads(value) if value.lstrip().startswith('{') else parse_qs(value, keep_blank_values=True)
        if not isinstance(data, dict):
            return None
        return {key: item[0] if isinstance(item, list) and len(item) == 1 else item
                for key, item in data.items()}
    except (TypeError, ValueError):
        return None


def authentication_url(value):
    origin = https_origin(value)
    # A next_action cannot turn the account API or payment API into an issuer.
    if origin in {'https://api.stripe.com', 'https://chatgpt.com'}:
        return None
    return origin


def checkout_resource_url(value):
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    return parsed.scheme == 'https' and (host in {'chatgpt.com', 'challenges.cloudflare.com'}
        or any(host == domain or host.endswith('.' + domain)
               for domain in ('stripe.com', 'stripe.network', 'oaistatic.com', 'oaiusercontent.com')))


def encoded_fields(value):
    try:
        if not isinstance(value, str) or len(value) > 16000:
            return None
        data = json.loads(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)))
        return data if isinstance(data, dict) else None
    except (TypeError, ValueError):
        return None


class ThreeDSAuthentication:
    def __init__(self, origin_frame=None, *, intent_kind='payment_intent'):
        if intent_kind not in {'payment_intent', 'setup_intent'}:
            raise ValueError('unsupported authentication intent kind')
        self.intent_kind = intent_kind
        self.status = 'not_required'
        self.active = False
        self.closed = False
        self.intent_id = self.source = self.server_id = self.acs_id = None
        self.client_secret = None
        self.entries = {}
        self.frames = {}
        self.requests = {}
        self.deadline = 0
        self.origin_frame = origin_frame
        self.origin_frame_url = origin_frame.url if origin_frame is not None else None

    @property
    def needs_user(self):
        return self.status == 'awaiting_user'

    def reject(self, status='unsupported'):
        self.close(status)
        return False

    def bind(self, intent, expected_id):
        if self.closed:
            return False
        prefix = 'pi' if self.intent_kind == 'payment_intent' else 'seti'
        other_kind = 'setup_intent' if self.intent_kind == 'payment_intent' else 'payment_intent'
        if (not isinstance(expected_id, str) or not re.fullmatch(prefix + r'_[A-Za-z0-9]{1,180}', expected_id)
                or not isinstance(intent, dict) or intent.get('id') != expected_id
                or intent.get('object') != self.intent_kind or other_kind in intent
                or intent.get('status') != 'requires_action'
                or intent.get('confirmation_method', 'automatic') != 'automatic'):
            return self.reject()
        action = intent.get('next_action')
        if not isinstance(action, dict):
            return self.reject()
        entries = {}
        source = server_id = acs_id = None
        status = 'awaiting_user'
        if action.get('type') == 'redirect_to_url':
            redirect = action.get('redirect_to_url')
            url = redirect.get('url') if isinstance(redirect, dict) else None
            if not authentication_url(url):
                return self.reject()
            entries[url] = 'redirect'
        elif action.get('type') == 'use_stripe_sdk':
            sdk = action.get('use_stripe_sdk')
            if not isinstance(sdk, dict):
                return self.reject()
            kind = sdk.get('type')
            nested = sdk.get('stripe_js')
            data = nested if isinstance(nested, dict) else sdk
            source = data.get('three_d_secure_2_source') or data.get('source')
            if kind not in {'stripe_3ds2_fingerprint', 'stripe_3ds2_challenge', 'three_d_secure_redirect'}:
                return self.reject()
            if source is not None and (not isinstance(source, str) or not re.fullmatch(r'src_[A-Za-z0-9]{1,180}', source)):
                return self.reject()
            server_id, acs_id = data.get('server_transaction_id'), data.get('acs_transaction_id')
            for key, entry in [('three_ds_method_url', 'method'), ('acs_url', 'challenge')]:
                url = data.get(key)
                if url:
                    if not authentication_url(url):
                        return self.reject()
                    entries[url] = entry
            if isinstance(nested, str):
                if not authentication_url(nested):
                    return self.reject()
                entries[nested] = 'redirect'
            if not source and not entries:
                return self.reject()
            status = 'authenticating' if kind == 'stripe_3ds2_fingerprint' else 'awaiting_user'
        else:
            return self.reject()
        if self.intent_id and (self.intent_id != expected_id or self.source != source):
            return self.reject('failed')
        if (server_id and self.server_id and server_id != self.server_id
                or acs_id and self.acs_id and acs_id != self.acs_id):
            return self.reject('failed')
        self.intent_id, self.source = expected_id, source
        self.client_secret = intent.get('client_secret') or self.client_secret
        self.server_id, self.acs_id = server_id or self.server_id, acs_id or self.acs_id
        self.entries.update(entries)
        # A late fingerprint response must not rewind an already observed ARES
        # challenge. Request reservations and the original deadline also survive.
        self.status = 'awaiting_user' if self.needs_user else status
        self.active = True
        self.deadline = self.deadline or time.monotonic() + 1800
        return True

    def close(self, status=None):
        self.closed = True
        self.active = False
        self.entries.clear()
        self.frames.clear()
        if status and self.status != 'completed':
            self.status = status
        # Keep request identity until pending response observers have drained.

    def frame_allowed(self, frame, checkout_id):
        for _ in range(10):
            if frame is None:
                return False
            if frame in self.frames:
                return https_origin(frame.url) == self.frames[frame]
            parsed = urlsplit(frame.url)
            if self.origin_frame is not None and frame is self.origin_frame:
                return (frame.url == self.origin_frame_url
                        and https_origin(frame.url) == 'https://chatgpt.com')
            if (self.origin_frame is None and parsed.scheme == 'https' and parsed.hostname == 'chatgpt.com'
                    and parsed.path.startswith('/checkout/') and parsed.path.rsplit('/', 1)[-1] == checkout_id):
                return True
            if frame.url != 'about:blank' and https_origin(frame.url) not in STRIPE_FRAMES:
                return False
            frame = frame.parent_frame
        return False

    async def safe_headers(self, request, target):
        try:
            headers = {key.lower(): value for key, value in (await request.all_headers()).items()}
        except Exception:
            return False
        if (any(key.lower() in {'chatgpt-account-id', 'x-openai-authorization'} for key in headers)
                or re.search(r'(?:next-auth|authjs)', headers.get('cookie', ''), re.I)):
            return False
        authorization = headers.get('authorization', '')
        if authorization and not (urlsplit(request.url).hostname == 'api.stripe.com'
                                  and re.fullmatch(r'Bearer pk_(?:test|live)_[A-Za-z0-9]+', authorization)):
            return False
        material = unquote(request.url + '\n' + (request.post_data or '') + '\n' + json.dumps(headers))
        return not any(isinstance(secret, str) and len(secret) >= 12 and secret in material
                       for secret in [getattr(target, 'old_token', None), getattr(target, 'session_token', None)])

    async def decision(self, request, target, checkout_id):
        allowed = await self._decision(request, target, checkout_id)
        # Header/form inspection may yield while the payment flow closes the
        # gate. Preserve reservations, but never send after that closing fence.
        if allowed and (self.closed or not self.active or time.monotonic() >= self.deadline):
            self.close('failed' if time.monotonic() >= self.deadline else None)
            return False
        return allowed

    async def _decision(self, request, target, checkout_id):
        if not self.active:
            return None
        if time.monotonic() >= self.deadline:
            self.close('failed')
            return False
        origin = https_origin(request.url)
        parsed = urlsplit(request.url)
        try:
            frame = request.frame
        except Exception:
            frame = None
        if request.is_navigation_request() and request.url not in self.entries:
            # Bind a redirect from its already-authorized response even if the
            # asynchronous response observer has not yet consumed its headers.
            previous = request.redirected_from
            if previous and self.requests.get(previous) == 'navigation' and len(self.entries) < 8:
                try:
                    response = await previous.response()
                    headers = await response.all_headers()
                    location = headers.get('location')
                    url = urljoin(previous.url, location) if location else None
                    if response.status in {301, 302, 303, 307, 308} and url == request.url and authentication_url(url):
                        self.entries[url] = 'redirect'
                except Exception:
                    pass
        if parsed.hostname == 'api.stripe.com' and parsed.path in AUTH_PATHS:
            if request.method == 'OPTIONS' and origin and self.frame_allowed(frame, checkout_id):
                return await self.safe_headers(request, target)
            data = fields(request.post_data)
            intent_fields = {key: value for key, value in (data or {}).items()
                             if re.match(r'^(?:payment_intent|setup_intent)(?:$|\[)', key)}
            if (request.method != 'POST' or not origin or not self.source or not data
                    or data.get('source') != self.source or parsed.path in self.requests.values()
                    or not self.frame_allowed(frame, checkout_id)
                    or any(re.match(r'^(?:payment_method|amount|currency|card)(?:$|\[)', key) for key in data)
                    or any(key != self.intent_kind or value != self.intent_id
                           for key, value in intent_fields.items())
                    or ('client_secret' in data and (not self.client_secret or data['client_secret'] != self.client_secret))):
                return False
            if parsed.path.endswith('/challenge_complete') and not self.needs_user:
                return False
            # Reserve before awaiting headers: concurrent requests cannot authenticate twice.
            self.requests[request] = parsed.path
            return await self.safe_headers(request, target)
        if request.url in self.entries and request.is_navigation_request():
            if not origin or not self.frame_allowed(frame, checkout_id):
                return False
            kind = self.entries[request.url]
            if request.method == 'POST':
                data = fields(request.post_data)
                key = 'threeDSMethodData' if kind in {'method', 'method_notification'} else 'creq' if kind == 'challenge' else None
                decoded = encoded_fields(data.get(key)) if data and key else None
                if (not decoded or set(data) != {key} or not self.server_id or decoded.get('threeDSServerTransID') != self.server_id
                        or kind == 'challenge' and (not self.acs_id or decoded.get('acsTransID') != self.acs_id)):
                    return False
                if kind == 'method' and (set(decoded) != {'threeDSServerTransID', 'threeDSMethodNotificationURL'}
                        or https_origin(decoded['threeDSMethodNotificationURL']) not in {'https://hooks.stripe.com', 'https://js.stripe.com'}):
                    return False
                if kind == 'challenge' and (decoded.get('messageType') != 'CReq' or set(decoded) - {
                        'messageType', 'messageVersion', 'threeDSServerTransID', 'acsTransID', 'challengeWindowSize'}):
                    return False
                if kind == 'method_notification' and set(decoded) != {'threeDSServerTransID'}:
                    return False
            elif request.method not in SAFE_METHODS:
                return False
            if not await self.safe_headers(request, target):
                return False
            self.frames[frame] = origin
            self.requests[request] = 'navigation'
            if kind == 'method' and request.method == 'POST':
                self.entries[decoded['threeDSMethodNotificationURL']] = 'method_notification'
            return True
        if frame not in self.frames:
            return None
        if not origin or origin != self.frames[frame] or PAYMENT_PATH.search(parsed.path):
            return False
        if not await self.safe_headers(request, target):
            return False
        if request.method in SAFE_METHODS:
            return True
        if request.method != 'POST' or https_origin(frame.url) != origin:
            return False
        # Only the issuer's observed form action/current ACS endpoint may receive a
        # user submission; unrelated XHR endpoints and foreign origins stay blocked.
        try:
            actions = await frame.eval_on_selector_all('form', '''forms => forms.filter(form =>
                form.method.toUpperCase() === 'POST' && form.getBoundingClientRect().width > 0 &&
                getComputedStyle(form).visibility !== 'hidden').map(form => form.action)''')
        except Exception:
            return False
        if request.url not in actions:
            return False
        self.requests[request] = 'issuer_form'
        return True

    async def observe_redirect(self, response):
        if self.active and self.requests.get(response.request) == 'navigation' and response.status in {301, 302, 303, 307, 308}:
            location = (await response.all_headers()).get('location')
            if self.closed or not self.active:
                return
            url = urljoin(response.url, location) if location else None
            if authentication_url(url) and len(self.entries) < 8:
                self.entries[url] = 'redirect'

    def observe_authentication(self, request, data, *, allow_challenge=True):
        if self.requests.get(request) not in AUTH_PATHS:
            return False
        if not isinstance(data, dict):
            self.close('failed')
            return False
        source = data.get('source')
        if isinstance(source, dict):
            source = source.get('id')
        other_kind = 'setup_intent' if self.intent_kind == 'payment_intent' else 'payment_intent'
        intent = data.get(self.intent_kind)
        intent_id = intent.get('id') if isinstance(intent, dict) else intent
        if (other_kind in data
                or (data.get('object') in {'payment_intent', 'setup_intent'}
                    and (data.get('object') != self.intent_kind or data.get('id') != self.intent_id))
                or (self.intent_kind in data and (intent_id != self.intent_id
                    or isinstance(intent, dict) and (intent.get('object') != self.intent_kind or other_kind in intent)))
                or ('source' in data and source != self.source)
                or (intent_id is not None and intent_id != self.intent_id)):
            self.close('failed')
            return False
        if not allow_challenge or self.closed:
            return True
        ares = data.get('ares')
        if isinstance(ares, dict) and ares.get('acsURL'):
            url = ares['acsURL']
            if (not authentication_url(url) or not ares.get('threeDSServerTransID') or not ares.get('acsTransID')
                    or self.server_id and self.server_id != ares['threeDSServerTransID']):
                self.close('unsupported')
                return False
            self.server_id, self.acs_id = ares['threeDSServerTransID'], ares['acsTransID']
            self.entries[url] = 'challenge'
            self.status = 'awaiting_user'
        return True
