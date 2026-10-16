"""Independent loopback registration connector. No recharge runner or server database imports."""
from __future__ import annotations

import argparse
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import ipaddress
import json
import re
import secrets
import threading
import time
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from browser_registration_flow import RegistrationFlow, Stop, observe_browser_exit


PORT = 55324
SERVICE = 'id-business-v2-auto-registration-connector'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
PROFILE = re.compile(r'[A-Za-z0-9_-]{1,191}')
MAX_BODY = 16_384
MAX_RESPONSE = 262_144
ACTIONS = frozenset({'claim', 'event', 'code', 'result', 'fail'})
FAIL_REASONS = {'browser_unavailable', 'browser_disconnected', 'official_rejected',
                'existing_account', 'human_verification_required', 'identity_missing',
                'identity_mismatch', 'flow_changed', 'timeout', 'cancelled', 'connector_error'}
SYNC_FIELDS = ('syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization')
PROXY_FIELDS = ('proxyMethod', 'proxyType', 'host', 'port', 'proxyUserName', 'proxyPassword')


def profile_readback_diagnostic(profile_id, detail, expected, *, observed=True):
    """Only fixed field names and closed comparisons; never arbitrary detail keys or values."""
    sync = {}
    for key in SYNC_FIELDS:
        sync[key] = ('absent' if key not in detail else 'false' if detail[key] is False
                     else 'true' if detail[key] is True else 'wrong_type')
    proxy = {key: ('absent' if key not in detail else 'matches'
                   if str(detail[key]) == str(expected[key]) else 'mismatch')
             for key in PROXY_FIELDS if key in expected}
    return {'event': 'registration_profile_readback', 'version': 1, 'profileId': profile_id,
            'readback': 'observed' if observed else 'unavailable',
            'id': 'absent' if 'id' not in detail else 'matches' if detail['id'] == profile_id else 'mismatch',
            'sync': sync, 'proxy': proxy}


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Stop('body_invalid')
        result[key] = value
    return result


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def origin(value):
    try:
        p = urlsplit(value)
        hostname = (p.hostname or '').rstrip('.')
        try:
            loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            loopback = hostname == 'localhost' or hostname.endswith('.localhost')
        if (p.scheme != 'https' or not p.hostname or p.username or p.password
                or p.path not in {'', '/'} or p.query or p.fragment
                or loopback
                or p.port not in {None, 443} or any(ord(c) < 33 for c in value)):
            raise ValueError()
        normalized = 'https://' + p.hostname
        if value.rstrip('/') != normalized:
            raise ValueError()
        return normalized
    except (TypeError, ValueError):
        raise Stop('configuration_invalid') from None


def local_url(value, *, websocket=False):
    try:
        p = urlsplit(value)
        if (p.scheme not in ({'ws', 'http'} if websocket else {'http'})
                or p.hostname not in {'127.0.0.1', 'localhost'} or not p.port
                or p.username or p.password or p.query or p.fragment
                or (not websocket and p.path not in {'', '/'})):
            raise ValueError()
        return value.rstrip('/') if not websocket else value
    except (TypeError, ValueError):
        raise Stop('debug_endpoint_invalid' if websocket else 'configuration_invalid') from None


def launch_payload(value, allowed_origins, request_origin):
    if not isinstance(value, dict) or set(value) != {'taskUuid', 'launchToken', 'callbackBaseUrl'}:
        raise Stop('invalid_payload')
    task, token, callback = value.get('taskUuid'), value.get('launchToken'), value.get('callbackBaseUrl')
    if (not isinstance(task, str) or not UUID.fullmatch(task)
            or not isinstance(token, str) or not 32 <= len(token) <= 4096
            or not re.fullmatch(r'[A-Za-z0-9._~-]+', token)
            or not isinstance(callback, str)):
        raise Stop('invalid_payload')
    prefix = request_origin + '/api/id-business-v2/auto-registration/browser/tasks/' + task
    if request_origin not in allowed_origins or callback != prefix:
        raise Stop('invalid_payload')
    return dict(value)


def json_post(url, body, headers, *, timeout=15):
    request = Request(url, data=json.dumps(body, separators=(',', ':'), allow_nan=False).encode(),
                      headers={'Content-Type': 'application/json', **headers}, method='POST')
    try:
        # Exact destinations only: neither redirects nor machine HTTP proxy settings.
        with build_opener(ProxyHandler({}), NoRedirect).open(request, timeout=timeout) as response:
            if response.status not in {200, 201, 202}:
                raise Stop('callback_rejected')
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise Stop('callback_invalid')
        value = json.loads(raw, object_pairs_hook=object_pairs)
        if not isinstance(value, dict):
            raise Stop('callback_invalid')
        return value
    except Stop:
        raise
    except Exception:
        raise Stop('callback_unavailable') from None


class CallbackClient:
    def __init__(self, payload):
        self.base, self.token = payload['callbackBaseUrl'], payload['launchToken']
        self.nonce = secrets.token_hex(32)

    def send(self, action, body):
        if action not in ACTIONS:
            raise Stop('invalid_payload')
        value = json_post(self.base + '/' + action, body, {
            'Authorization': 'Bearer ' + self.token,
            'X-Registration-Browser-Nonce': self.nonce},
            timeout=75 if action == 'result' else 20 if action == 'code' else 15)
        if 'success' in value and value['success'] is not True:
            raise Stop('callback_rejected')
        if isinstance(value.get('data'), dict):
            value = value['data']
        return value

    def clear(self):
        self.token = self.nonce = ''


def fixed_proxy(value):
    if value is None:
        return {'proxyMethod': 2, 'proxyType': 'noproxy'}
    try:
        p = urlsplit(value)
        if (p.scheme not in {'http', 'https', 'socks5'} or not p.hostname or not p.port
                or p.path not in {'', '/'} or p.query or p.fragment
                or any(ord(c) < 32 for c in value)):
            raise ValueError()
        username, password = unquote(p.username or ''), unquote(p.password or '')
        if any(ord(c) < 32 for c in username + password) or len(username + password) > 2048:
            raise ValueError()
        return {'proxyMethod': 2, 'proxyType': p.scheme, 'host': p.hostname, 'port': p.port,
                'proxyUserName': username, 'proxyPassword': password}
    except (TypeError, ValueError):
        raise Stop('configuration_invalid') from None


def validate_claim(data, task_uuid):
    if (not isinstance(data, dict) or data.get('taskUuid') != task_uuid
            or not isinstance(data.get('email'), str)
            or not re.fullmatch(r'[^\s@]{1,128}@[^\s@]{1,253}', data['email'])
            or not isinstance(data.get('password'), str) or not 8 <= len(data['password']) <= 256
            or 'proxy' not in data or not isinstance(data.get('bitBrowser'), dict)):
        raise Stop('callback_invalid')
    fixed_proxy(data['proxy'])
    bit = data['bitBrowser']
    if not isinstance(bit.get('apiToken'), str) or not 8 <= len(bit['apiToken']) <= 4096:
        raise Stop('configuration_invalid')
    if any(ord(c) < 32 for c in bit['apiToken']):
        raise Stop('configuration_invalid')
    local_url(bit.get('apiUrl'))
    return data


class BitBrowserClient:
    def __init__(self, settings):
        self.base = local_url(settings['apiUrl'])
        self.token = settings['apiToken']
        self.created_profile_id = None
        self.profile_diagnostic = None

    def post(self, path, body):
        if path not in {'/browser/update', '/browser/detail', '/browser/open'}:
            raise Stop('configuration_invalid')
        try:
            result = json_post(self.base + path, body, {'x-api-key': self.token})
            if result.get('success') is not True or not isinstance(result.get('data'), dict):
                raise Stop('profile_unverified')
            return result['data']
        except Stop:
            raise Stop('bitbrowser_unavailable') from None

    def create(self, task_uuid, proxy, options):
        if options is not None and not isinstance(options, dict):
            raise Stop('configuration_invalid')
        options = options or {}
        fingerprint = {}
        core = options.get('coreVersion')
        if core is not None:
            if not isinstance(core, str) or not re.fullmatch(r'[1-9]\d{1,2}', core):
                raise Stop('configuration_invalid')
            fingerprint['coreVersion'] = core
        for key, low, high in (('openWidth', 800, 7680), ('openHeight', 600, 4320)):
            if key in options:
                if type(options[key]) is not int or not low <= options[key] <= high:
                    raise Stop('configuration_invalid')
                fingerprint[key] = options[key]
        payload = {'name': '注册-' + task_uuid, 'remark': '独立自动注册任务',
                   'platform': '', 'platformIcon': 'chatgpt.com', 'url': 'about:blank',
                   'userName': '', 'password': '', 'cookie': '', 'isValidUsername': False,
                   'credentialsEnableService': False,
                   'syncTabs': False, 'syncCookies': False, 'syncLocalStorage': False,
                   'syncIndexedDb': False, 'syncAuthorization': False,
                   'browserFingerPrint': fingerprint, **fixed_proxy(proxy)}
        result = self.post('/browser/update', payload)
        profile_id = result.get('id')
        if not isinstance(profile_id, str) or not PROFILE.fullmatch(profile_id):
            raise Stop('profile_unverified')
        # Retain the exact created resource even if the subsequent safety readback fails.
        self.created_profile_id = profile_id
        expected = fixed_proxy(proxy)
        self.profile_diagnostic = profile_readback_diagnostic(profile_id, {}, expected, observed=False)
        detail = self.post('/browser/detail', {'id': profile_id})
        self.profile_diagnostic = profile_readback_diagnostic(profile_id, detail, expected)
        if detail.get('id') != profile_id or any(detail.get(key) is not False for key in SYNC_FIELDS):
            raise Stop('profile_unverified')
        for key, value in expected.items():
            if str(detail.get(key)) != str(value):
                raise Stop('profile_unverified')
        return profile_id

    def open(self, profile_id):
        value = self.post('/browser/open', {'id': profile_id, 'queue': True})
        endpoint = value.get('ws') or value.get('http')
        # The official response's HTTP fallback is an authority without a scheme.
        if isinstance(endpoint, str) and re.fullmatch(r'(?:127\.0\.0\.1|localhost):[0-9]{1,5}', endpoint):
            endpoint = 'http://' + endpoint
        return local_url(endpoint, websocket=True)


def failure_reason(reason):
    return {'registration_timeout': 'timeout', 'browser_closed': 'browser_disconnected',
            'identity_mismatch': 'identity_mismatch', 'creation_unverified': 'identity_missing',
            'identity_unverified': 'identity_missing',
            'existing_account_requires_review': 'existing_account',
            'official_source_invalid': 'official_rejected',
            'official_rejected': 'official_rejected',
            'form_ambiguous': 'flow_changed', 'form_action_invalid': 'flow_changed',
            'bitbrowser_unavailable': 'browser_unavailable',
            'browser_unavailable': 'browser_unavailable'}.get(reason, 'connector_error')


async def execute(payload, state):
    callback = CallbackClient(payload)
    claim = flow = bit = None
    try:
        claim = validate_claim(await asyncio.to_thread(callback.send, 'claim', {}), payload['taskUuid'])
        bit = BitBrowserClient(claim['bitBrowser'])
        profile_id = await asyncio.to_thread(bit.create, payload['taskUuid'], claim['proxy'],
                                             claim['bitBrowser'].get('browserOptions'))
        state['profileId'] = profile_id
        endpoint = await asyncio.to_thread(bit.open, profile_id)
        from playwright.async_api import async_playwright
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(endpoint, timeout=30_000)
            if len(browser.contexts) != 1:
                raise Stop('browser_unavailable')
            context = browser.contexts[0]
            if await context.cookies(['https://chatgpt.com', 'https://auth.openai.com']):
                raise Stop('existing_account_requires_review')
            page = await context.new_page()
            observation = await observe_browser_exit(page)
            flow = RegistrationFlow(claim, callback)
            state['status'] = 'running'
            await flow.run(context, page, profile_id, attempt_observation=observation)
        state['status'] = 'completed'
    except Exception as exc:
        reason = 'official_rejected' if flow and flow.official_failure else (
            exc.reason if isinstance(exc, Stop) else 'operation_failed')
        if bit and bit.created_profile_id:
            state['profileId'] = bit.created_profile_id
            if isinstance(bit.profile_diagnostic, dict):
                state['profileDiagnostic'] = bit.profile_diagnostic
                # The independent LaunchAgent captures stdout in its project-owned log.
                # No generic HTTP/exception/BitBrowser response logger is enabled.
                try:
                    print(json.dumps(bit.profile_diagnostic, separators=(',', ':'), ensure_ascii=True), flush=True)
                except OSError:
                    pass
        state.update(status='failed', reason=reason)
        try:
            reply = await asyncio.to_thread(callback.send, 'fail', {
                'reason': failure_reason(reason),
                'sideEffectPossible': bool(flow and flow.side_effect_possible),
                **(flow.official_failure if flow and reason == 'official_rejected' else {}),
                **({'profileId': state['profileId']} if state.get('profileId') else {})})
            state['failureAcknowledged'] = reply.get('accepted') is True
        except Exception:
            state['failureAcknowledged'] = False
    finally:
        if claim:
            claim.clear()
        callback.clear()
        state['endedAt'] = time.monotonic()


class JobRegistry:
    def __init__(self, runner=execute):
        self.jobs, self.lock, self.runner = {}, threading.Lock(), runner

    def start(self, payload):
        task = payload['taskUuid']
        with self.lock:
            existing = self.jobs.get(task)
            if existing:
                if not hmac.compare_digest(existing['token'], payload['launchToken']):
                    raise Stop('job_conflict')
                return
            if any(row['state']['status'] in {'accepted', 'running'} for row in self.jobs.values()):
                raise Stop('connector_busy')
            # Do not silently forget task capabilities and start the same task twice.
            if len(self.jobs) >= 128:
                raise Stop('connector_busy')
            state = {'status': 'accepted'}
            self.jobs[task] = {'token': payload['launchToken'], 'state': state}

        def work():
            try:
                asyncio.run(self.runner(payload, state))
            except Exception:
                state.update(status='failed', reason='operation_failed')

        threading.Thread(target=work, name='registration-browser', daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    allowed_origins = frozenset()
    registry = JobRegistry()

    def log_message(self, *args):
        pass

    def allowed(self):
        if self.headers.get_all('Host', []) != [f'127.0.0.1:{PORT}']:
            raise Stop('host_rejected')
        values = self.headers.get_all('Origin', [])
        if len(values) != 1 or values[0] not in self.allowed_origins:
            raise Stop('origin_rejected')
        return values[0]

    def reply(self, status, data, cors=None):
        body = json.dumps(data, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cors:
            self.send_header('Access-Control-Allow-Origin', cors)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        try:
            cors = self.allowed()
            if self.path not in {'/health', '/jobs'}:
                raise Stop('invalid_payload')
            method = self.headers.get('Access-Control-Request-Method')
            requested = {x.strip().lower() for x in self.headers.get('Access-Control-Request-Headers', '').split(',') if x.strip()}
            if method not in {'GET', 'POST'} or requested - {'content-type'}:
                raise Stop('invalid_payload')
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', cors)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Vary', 'Origin')
            self.send_header('Content-Length', '0')
            self.end_headers()
        except Stop as exc:
            self.reply(403, {'accepted': False, 'reason': exc.reason})

    def do_GET(self):
        try:
            cors = self.allowed()
            if self.path != '/health':
                self.reply(404, {'ok': False}, cors)
                return
            self.reply(200, {'service': SERVICE, 'version': 1, 'ok': True}, cors)
        except Stop as exc:
            self.reply(403, {'ok': False, 'reason': exc.reason})

    def do_POST(self):
        cors = None
        try:
            cors = self.allowed()
            if self.path != '/jobs':
                self.reply(404, {'accepted': False}, cors)
                return
            if (self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1
                    or self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json'):
                raise Stop('body_invalid')
            length = self.headers.get('Content-Length', '')
            if not length.isdigit() or not 1 <= int(length) <= MAX_BODY:
                raise Stop('body_invalid')
            value = json.loads(self.rfile.read(int(length)), object_pairs_hook=object_pairs)
            payload = launch_payload(value, self.allowed_origins, cors)
            self.registry.start(payload)
            self.reply(202, {'accepted': True, 'taskUuid': payload['taskUuid']}, cors)
        except (ValueError, UnicodeError):
            self.reply(400, {'accepted': False, 'reason': 'body_invalid'}, cors)
        except Stop as exc:
            self.reply(409 if exc.reason in {'job_conflict', 'connector_busy'} else 400,
                       {'accepted': False, 'reason': exc.reason}, cors)


def main():
    parser = argparse.ArgumentParser(description='独立自动注册本机连接器')
    parser.add_argument('--allowed-origin', action='append', required=True)
    args = parser.parse_args()
    try:
        Handler.allowed_origins = frozenset(origin(value) for value in args.allowed_origin)
    except Stop:
        parser.error('仅接受精确的线上 HTTPS 来源，不接受本机、路径或通配符')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
