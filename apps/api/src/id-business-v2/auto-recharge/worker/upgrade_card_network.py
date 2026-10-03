"""Temporary authority for the official Add Payment Method UI, never an upgrade charge."""
import asyncio
import json
import re
from urllib.parse import urlsplit

from checkout_core import MAX_BYTES, Stop, parse_credential
from payment_3ds import AUTH_PATHS, ThreeDSAuthentication, fields, https_origin

BASE = '/backend-api/payments/payment_method'
METHOD_ID = re.compile(r'^pm_[A-Za-z0-9]{1,180}$')
SETUP_ID = re.compile(r'^seti_[A-Za-z0-9]{1,180}$')
TOKEN_ID = re.compile(r'^ctoken_[A-Za-z0-9]{1,180}$')


def method_matches_card(method, details):
    card = method.get('card') if isinstance(method, dict) and method.get('type') == 'card' else None
    month, year = (int(value) for value in details.expiry.split('/'))
    return (isinstance(card, dict) and card.get('last4') == details.last4
            and card.get('exp_month') == month and card.get('exp_year') == 2000 + year)


def native_account(request, target):
    try:
        token = request.headers.get('authorization', '')
        if not token.startswith('Bearer '):
            return False
        credential = parse_credential(json.dumps({'accessToken': token[7:]}).encode())
        return (credential.account_id == target.account_id
                and request.headers.get('chatgpt-account-id', target.account_id) == target.account_id)
    except (Stop, AttributeError, TypeError):
        return False


class UpgradeCardChange:
    def __init__(self, target, origin_frame, *, read_only=False):
        self.target, self.origin_frame = target, origin_frame
        self.origin_url = origin_frame.url if origin_frame is not None else None
        self.read_only, self.closed, self.active = read_only, False, False
        self.submit_authorized = False
        self.details = None
        self.method_id = self.setup_id = self.setup_secret = self.token_id = None
        self.setup_method_id = self.token_method_id = None
        self.setup_succeeded = False
        self.requests, self.reserved = {}, set()
        self.native_confirms = 0
        self.ready = asyncio.Event()
        self.error = None
        self.cancelled = lambda: None
        self.auth = ThreeDSAuthentication(origin_frame, intent_kind='setup_intent')

    def arm(self, details):
        if self.read_only or self.closed or self.active or self.method_id or not self.original_frame(self.origin_frame):
            raise Stop('upgrade_card_change_not_authorized')
        self.details, self.active = details, True

    def authorize_submit(self):
        if not self.active or self.closed or self.read_only:
            raise Stop('upgrade_card_change_not_authorized')
        self.submit_authorized = True

    def close(self):
        self.closed, self.active, self.submit_authorized = True, False, False
        self.details = self.setup_secret = self.token_id = None
        self.auth.close()
        self.auth.client_secret = None
        self.ready.set()

    def fail(self, reason='upgrade_card_setup_unverified'):
        self.error = Stop(reason)
        self.close()
        return False

    def still_active(self):
        if self.closed or not self.active or self.read_only:
            return False
        try:
            if self.cancelled() is True:
                return self.fail('operation_cancelled')
        except Stop:
            return self.fail('operation_cancelled')
        return True

    def original_frame(self, frame):
        return (self.origin_frame is not None and frame is self.origin_frame and frame.url == self.origin_url
                and https_origin(frame.url) == 'https://chatgpt.com')

    def stripe_frame(self, frame):
        return self.auth.frame_allowed(frame, None)

    async def settle(self, predicate):
        if predicate():
            return True
        self.ready.clear()
        try:
            await asyncio.wait_for(self.ready.wait(), 5)
        except asyncio.TimeoutError:
            return False
        return not self.closed and predicate()

    def native_body(self, request, keys):
        try:
            body = request.post_data_json
            return (body if isinstance(body, dict) and set(body) == keys
                    and body.get('account_id') == self.target.account_id
                    and body.get('caller_surface') == 'plan_management'
                    and self.original_frame(request.frame) and native_account(request, self.target) else None)
        except (TypeError, ValueError, AttributeError):
            return None

    def card_body(self, data):
        if (not data or any(isinstance(value, (dict, list)) for value in data.values())
                or any(re.match(r'^(?:amount|currency|payment_intent|charge)(?:$|\[)', key) for key in data)):
            return False
        kind = data.get('type') or data.get('payment_method_data[type]')
        if kind not in (None, 'card'):
            return False
        for key, expected in [('number', self.details.number), ('exp_month', self.details.expiry[:2]),
                              ('exp_year', self.details.expiry[3:]), ('cvc', self.details.cvc)]:
            values = [data[name] for name in ('card[' + key + ']', 'payment_method_data[card][' + key + ']') if name in data]
            for value in values:
                if not isinstance(value, str):
                    return False
                actual = re.sub(r'\D', '', value)
                if key in {'exp_month', 'exp_year'}:
                    if not actual or int(actual) not in {int(expected), 2000 + int(expected) if key == 'exp_year' else int(expected)}:
                        return False
                elif actual != re.sub(r'\D', '', expected):
                    return False
        return True

    async def decision(self, request):
        p = urlsplit(request.url)
        native = https_origin(request.url) == 'https://chatgpt.com' and p.path.startswith(BASE)
        stripe = https_origin(request.url) == 'https://api.stripe.com'
        if not native and not stripe:
            if self.active and self.auth.active:
                allowed = await self.auth.decision(request, self.target, None)
                return bool(allowed and self.still_active() and self.auth.active and not self.auth.closed) if allowed is not None else None
            return None
        if self.read_only or self.closed or not self.active:
            card_path = native or stripe and (p.path in {'/v1/payment_methods', '/v1/confirmation_tokens', '/v1/tokens'}
                                              or p.path.startswith('/v1/setup_intents/'))
            return False if card_path and request.method not in {'GET', 'HEAD', 'OPTIONS'} else None
        if not self.still_active():
            return False
        if native and request.method == 'POST':
            if p.query:
                return False
            name = None
            if p.path == BASE:
                name = 'setup_create'
                if not self.native_body(request, {'account_id', 'caller_surface'}):
                    return False
            elif p.path == BASE + '/confirm' and self.submit_authorized:
                body = self.native_body(request, {'account_id', 'caller_surface', 'confirmation_token_id'})
                if not body or not await self.settle(lambda: bool(self.token_id)) or body['confirmation_token_id'] != self.token_id:
                    return False
                if self.native_confirms >= 2 or self.native_confirms == 1 and not self.setup_succeeded:
                    return False
                name = 'token_confirm_' + str(self.native_confirms)
                self.native_confirms += 1
            elif p.path.endswith('/finalize') and self.submit_authorized:
                body = self.native_body(request, {'account_id', 'caller_surface', 'setup_intent_id'})
                if (not body or not await self.settle(lambda: self.setup_succeeded)
                        or body['setup_intent_id'] != self.setup_id
                        or p.path != BASE + '/' + str(self.setup_method_id) + '/finalize'):
                    return False
                name = 'setup_finalize'
            if not name or name in self.reserved:
                return False
            self.reserved.add(name)
            self.requests[request] = name
            return self.still_active() and self.original_frame(request.frame)
        if native:
            return None if request.method in {'GET', 'HEAD', 'OPTIONS'} else False
        if not self.stripe_frame(getattr(request, 'frame', None)):
            return False
        if p.path in AUTH_PATHS:
            if not await self.settle(lambda: self.auth.active):
                return False
            allowed = await self.auth.decision(request, self.target, None)
            return bool(allowed and self.still_active() and self.auth.active and not self.auth.closed)
        if request.method == 'OPTIONS':
            known = (p.path in {'/v1/payment_methods', '/v1/confirmation_tokens'}
                     or self.setup_id and p.path in {'/v1/setup_intents/' + self.setup_id,
                                                   '/v1/setup_intents/' + self.setup_id + '/confirm'})
            return bool(known and await self.auth.safe_headers(request, self.target)
                        and self.still_active() and self.original_frame(self.origin_frame))
        if request.method in {'GET', 'HEAD', 'OPTIONS'}:
            if p.path.startswith('/v1/setup_intents/'):
                if not await self.settle(lambda: bool(self.setup_id)) or p.path != '/v1/setup_intents/' + self.setup_id:
                    return False
                if (not await self.auth.safe_headers(request, self.target) or not self.still_active()
                        or not self.original_frame(self.origin_frame)):
                    return False
                self.requests[request] = 'setup_read'
                return True
            if p.path.startswith('/v1/'):
                return False
            return None
        if request.method != 'POST' or not self.submit_authorized:
            return False
        data = fields(request.post_data)
        if not self.card_body(data):
            return False
        name = None
        if p.path == '/v1/payment_methods' and self.setup_id and not self.token_id:
            if data.get('type') != 'card':
                return False
            name = 'method_create'
        elif p.path == '/v1/confirmation_tokens' and not self.setup_id:
            name = 'token_create'
        elif p.path.startswith('/v1/setup_intents/') and p.path.endswith('/confirm'):
            if (data.get('payment_method') and 'method_create' in self.reserved
                    and not await self.settle(lambda: bool(self.token_method_id))):
                return False
            if (not await self.settle(lambda: bool(self.setup_id))
                    or self.token_id is not None
                    or p.path != '/v1/setup_intents/' + self.setup_id + '/confirm'
                    or data.get('client_secret') != self.setup_secret
                    or data.get('payment_method') and data['payment_method'] != self.token_method_id):
                return False
            name = 'setup_confirm'
        if not name or name in self.reserved:
            return False
        self.reserved.add(name)  # Reserve before the asynchronous header inspection.
        if (not await self.auth.safe_headers(request, self.target) or not self.still_active()
                or not self.original_frame(self.origin_frame)):
            return False
        self.requests[request] = name
        return True

    def observe_setup(self, intent):
        if self.closed:
            return False
        if (not isinstance(intent, dict) or intent.get('object') != 'setup_intent'
                or intent.get('id') != self.setup_id
                or intent.get('client_secret') not in (None, self.setup_secret)
                or any(key in intent for key in ('amount', 'amount_received', 'currency'))
                or any(intent.get(key) is not None for key in ('payment_intent', 'charge', 'charges', 'invoice'))):
            return self.fail()
        method = intent.get('payment_method')
        method = method.get('id') if isinstance(method, dict) else method
        if method is not None:
            if (not isinstance(method, str) or not METHOD_ID.fullmatch(method)
                    or self.setup_method_id not in (None, method)
                    or self.token_method_id not in (None, method)):
                return self.fail()
            self.setup_method_id = method
        if intent.get('status') == 'requires_action':
            if not self.auth.bind(intent, self.setup_id):
                return self.fail()
        elif intent.get('status') == 'succeeded' and self.setup_method_id:
            self.setup_succeeded = True
            self.auth.close('completed')
        elif intent.get('status') in {'canceled', 'requires_payment_method'}:
            return self.fail('upgrade_card_setup_failed')
        return True

    async def response(self, response):
        await self.auth.observe_redirect(response)
        name = self.requests.get(response.request)
        authentication = self.auth.requests.get(response.request) in AUTH_PATHS
        if self.closed or not (name or authentication):
            return
        try:
            if not 200 <= response.status < 300:
                self.fail('upgrade_card_setup_failed')
                return
            raw = await response.body()
            if self.closed:
                return
            if len(raw) > MAX_BYTES:
                self.fail()
                return
            data = json.loads(raw)
            if not isinstance(data, dict):
                self.fail()
                return
            if (any(data.get(key) is not None for key in ('payment_intent', 'charge', 'charges', 'invoice', 'amount', 'amount_received', 'currency'))):
                self.fail()
                return
            if name == 'setup_create':
                secret = data.get('client_secret')
                identifier = secret.split('_secret_', 1)[0] if isinstance(secret, str) else None
                if not identifier or not SETUP_ID.fullmatch(identifier) or '_secret_' not in secret:
                    self.fail()
                    return
                self.setup_id, self.setup_secret = identifier, secret
            elif name == 'method_create':
                if not METHOD_ID.fullmatch(str(data.get('id', ''))) or not method_matches_card(data, self.details):
                    self.fail()
                    return
                self.token_method_id = data['id']
            elif name == 'token_create':
                if (not TOKEN_ID.fullmatch(str(data.get('id', '')))
                        or not method_matches_card(data.get('payment_method_preview'), self.details)):
                    self.fail()
                    return
                self.token_id = data['id']
            elif name and name.startswith('token_confirm_'):
                if data.get('status') == 'requires_action' and self.native_confirms == 1:
                    secret = data.get('client_secret')
                    identifier = secret.split('_secret_', 1)[0] if isinstance(secret, str) else None
                    if (not identifier or not SETUP_ID.fullmatch(identifier) or '_secret_' not in secret
                            or self.setup_id not in (None, identifier)):
                        self.fail()
                        return
                    self.setup_id, self.setup_secret = identifier, secret
                elif data.get('status') == 'succeeded' and METHOD_ID.fullmatch(str(data.get('payment_method_id', ''))):
                    self.method_id = data['payment_method_id']
                else:
                    self.fail()
            elif name == 'setup_finalize':
                identifier = data.get('canonical_payment_method_id')
                if not isinstance(identifier, str) or not METHOD_ID.fullmatch(identifier):
                    self.fail()
                    return
                self.method_id = identifier
            elif authentication:
                if not self.auth.observe_authentication(response.request, data):
                    self.fail()
                    return
                intent = data.get('setup_intent') or (data if data.get('object') == 'setup_intent' else None)
                if intent:
                    self.observe_setup(intent)
            elif name in {'setup_confirm', 'setup_read'}:
                self.observe_setup(data)
        except (TypeError, ValueError, AttributeError):
            self.fail()
        finally:
            self.ready.set()
