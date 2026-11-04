"""线上代充出站派单适配；复用当前连接器 Registry 和比特付款核心。"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import secrets
import ssl
import stat
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from uuid import UUID, uuid5

PROJECT = Path(__file__).resolve().parents[6]
MAX_RESPONSE = 512 * 1024

class OnlineError(Exception):
    def __init__(self, message, *, failure='request_rejected', status=None, retryable=False):
        super().__init__(message)
        self.failure, self.status, self.retryable = failure, status, retryable


# These calls are read-only or idempotent within the same device/lease/quote.
# Never replay claims, preparation, callbacks or payment writes here.
RETRYABLE_METHODS = frozenset({'connection', 'heartbeat', 'lease', 'quote', 'quote-status'})
TRANSIENT_HTTP = frozenset({408, 429, 500, 502, 503, 504})


def report_failure(method, attempt, error):
    # Do not log exception messages, response bodies, arguments or credentials.
    print(json.dumps({'event': 'online_recharge_rpc_failed',
        'method': method if method in RETRYABLE_METHODS else 'other',
        'attempt': attempt, 'failure': error.failure,
        'httpStatus': error.status, 'retryable': error.retryable}), flush=True)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class RpcClient:
    def __init__(self, config_file):
        self.path = Path(config_file).resolve()
        if not self.path.is_relative_to(PROJECT / '.runtime'):
            raise OnlineError('配对文件须放在本项目 .runtime 内')
        if Path(config_file).is_symlink() or not self.path.is_file() or (os.name != 'nt' and stat.S_IMODE(self.path.stat().st_mode) & 0o077):
            raise OnlineError('配对文件须是权限为 0600 的普通文件')
        data = json.loads(self.path.read_text(encoding='utf-8-sig'))
        parsed = urlsplit(str(data.get('serverUrl', '')))
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1'})) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
            raise OnlineError('线上地址须为 HTTPS 网站来源')
        self.origin = f'{parsed.scheme}://{parsed.netloc}'
        self.device_id = data.get('deviceId', '')
        self.key = data.get('deviceKey', '')
        if not self.key:
            paired = self._post('pair', {'pairingToken': data.get('pairingToken', '')})
            self.device_id, self.key = paired['deviceId'], paired['deviceKey']
            clean = {'serverUrl': self.origin, 'deviceId': self.device_id, 'deviceKey': self.key}
            temporary = self.path.with_name('.' + self.path.name + '.' + secrets.token_hex(8))
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump(clean, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)
        if not isinstance(self.key, str) or len(self.key) < 32:
            raise OnlineError('执行电脑凭据无效')

    def _post(self, endpoint, body):
        request = Request(self.origin + '/api/id-business-v2/online-recharge/connector/' + endpoint,
            data=json.dumps(body, separators=(',', ':')).encode(),
            headers={'Content-Type': 'application/json', 'X-Online-Recharge-Device-Token': getattr(self, 'key', '')}, method='POST')
        try:
            with build_opener(NoRedirect, ProxyHandler({})).open(request, timeout=8) as response:
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise OnlineError('派单响应超出限制', failure='response_too_large')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise OnlineError('派单响应无效', failure='invalid_response')
                if result.get('success') is False:
                    raise OnlineError('派单请求未完成')
                return result.get('data', result)
        except HTTPError as exc:
            raise OnlineError('派单请求未完成', failure='http_rejected', status=exc.code,
                retryable=exc.code in TRANSIENT_HTTP) from None
        except (URLError, OSError) as exc:
            reason = getattr(exc, 'reason', exc)
            raise OnlineError('派单连接暂不可用', failure='network_unavailable',
                retryable=not isinstance(reason, ssl.SSLError)) from None
        except ValueError:
            raise OnlineError('派单响应无效', failure='invalid_response') from None

    def rpc(self, method, args=None, scope=None):
        body = {'deviceId': self.device_id, 'method': method, 'args': args or {}, **{key: value for key, value in (scope or {}).items() if key in {'taskId', 'leaseId', 'leaseVersion'}}}
        for attempt in range(1, 4):
            try:
                return self._post('rpc', body)
            except OnlineError as exc:
                report_failure(method, attempt, exc)
                if method not in RETRYABLE_METHODS or not exc.retryable or attempt == 3:
                    raise
                # At most two retry waits (0.75s total); keep the 8s request timeout.
                # Each retry still performs the server's live lease/auth checks.
                time.sleep(attempt * .25)

class OnlineCallback:
    def __init__(self, client, scope, core):
        self.client, self.scope, self.core = client, scope, core
        # LocalJob 的清理协议；实际认证仅由受控 HTTPS 客户端持有。
        self.token, self.url = '', ''

    def send(self, body, **_kwargs):
        try:
            return self.client.rpc('callback', body, self.scope)
        except OnlineError:
            raise self.core.Stop('online_callback_unavailable') from None


def online_job_type(core):
    class OnlineJob(core.LocalJob):
        def signal_confirm(self, _nonce, _digest):
            raise core.Stop('online_payment_confirmation_requires_server')
    return OnlineJob


def payload_for(prepared, task, client):
    from bitbrowser_options import DEFAULTS
    proxy = prepared['proxy']
    connection = dict(prepared['connection'])
    protocol = str(proxy.get('protocol', 'http'))
    if protocol not in {'http', 'https', 'socks5'}:
        raise OnlineError('代理协议不支持')
    connection.update(proxyType=protocol, expectedCountryCode=prepared['policy']['proxyCountryCode'])
    if proxy.get('connectionMode') == 'extraction':
        connection.update(dynamicProxyUrl=proxy['proxy_url'], browserOptions={**DEFAULTS, 'proxyMode': 'dynamic'})
    else:
        parsed = urlsplit(proxy['proxy_url'])
        if not parsed.hostname:
            raise OnlineError('代理配置无效')
        connection.update(dynamicProxyUrl='', browserOptions={**DEFAULTS, 'proxyMode': 'static', 'staticHost': parsed.hostname,
            'staticPort': parsed.port or (1080 if protocol == 'socks5' else 443 if protocol == 'https' else 80)})
        if parsed.username or parsed.password:
            if not parsed.username or not parsed.password:
                raise OnlineError('代理认证资料不完整')
            connection['staticProxyCredentials'] = {'username': unquote(parsed.username), 'password': unquote(parsed.password)}
    common = {
        'id': task['id'], 'mode': 'recheck' if prepared.get('checkOnly') else 'payment', 'plan': prepared['plan'],
        'windowName': '线上代充 ' + task['id'][:8], 'bitBrowser': connection,
        'sessionJson': prepared['sessionJson'],
        'callbackUrl': client.origin + '/api/id-business-v2/online-recharge/connector/rpc',
        'agentToken': hashlib.sha256(task['leaseId'].encode()).hexdigest()
    }
    if prepared.get('checkOnly'):
        return {**common, 'accountKey': prepared['accountKey'], **({'upgradeIdentifier': prepared['upgradeIdentifier']} if prepared.get('upgradeIdentifier') else {})}
    return {**common, 'details': prepared['details'], 'address': prepared['address'],
        'safety': {'lockedCurrency': prepared['policy']['currency'], 'authorizeSinglePayment': True, 'manualPaymentConfirmation': True},
        'authorizeSinglePayment': True}

class OnlineAgent:
    def __init__(self, config_file, registry, core):
        self.client, self.registry, self.core = RpcClient(config_file), registry, core
        self.stop_event = threading.Event()
        self.current = None
        self.registered_quote = None
        self.next_heartbeat = 0
        self.next_quote_check = 0
        self.ready = False
        self.resume_version = 0
        self.thread = threading.Thread(target=self.run, name='online-recharge-dispatch', daemon=True)

    def stop(self):
        self.stop_event.set()
        if self.current:
            self.cancel_local(self.current[1])
        self.thread.join(timeout=5)

    def cancel_local(self, job):
        job.cancelled = True
        job.resume_event.set()
        job.code_event.set()
        job.confirmation_event.set()

    def heartbeat(self):
        busy = self.registry.busy()
        if not busy:
            connection = self.client.rpc('connection')
            try:
                if not connection.get('localApiToken'):
                    raise OnlineError('比特接口未配置')
                browser = self.core.BitBrowserClient(connection['localApiUrl'], connection['localApiToken'])
                catalog = self.core.bitbrowser_catalog.read_catalog(browser)
                self.core.bitbrowser_catalog.selected_id(catalog['groups'], connection['groupName'], 'group')
                self.core.bitbrowser_catalog.selected_id(catalog['tags'], connection['tagName'], 'tag')
                self.ready = True
            except Exception:
                self.ready = False
            finally:
                connection.clear()
        self.client.rpc('heartbeat', {'protocol': 1, 'ready': self.ready, 'busy': busy})
        if self.current and not self.current[1].done:
            try:
                control = self.client.rpc('lease', scope=self.current[0])
                version = control.get('resumeVersion', 0)
                if version > self.resume_version and self.current[1].waiting_for_user:
                    self.current[1].signal_resume()
                    self.resume_version = version
            except OnlineError:
                self.cancel_local(self.current[1])
                raise
        self.next_heartbeat = time.monotonic() + 10

    def approve_pending(self, scope, job):
        with job.confirmation_lock:
            pending = dict(job.pending_confirmation) if job.pending_confirmation else None
        if not pending or time.monotonic() < self.next_quote_check:
            return
        self.next_quote_check = time.monotonic() + 2
        args = {'accountKey': job.account_key, 'quote': pending['quote'], 'quoteDigest': pending['quote_digest']}
        if self.registered_quote != pending['quote_digest']:
            response = self.client.rpc('quote', args, scope)
            self.registered_quote = pending['quote_digest']
        else:
            response = self.client.rpc('quote-status', {'quoteDigest': pending['quote_digest']}, scope)
        if response.get('approved') is True:
            self.core.LocalJob.signal_confirm(job, pending['nonce'], pending['quote_digest'])
        elif response.get('expired'):
            print(json.dumps({'event': 'online_recharge_quote_expired'}), flush=True)
            self.cancel_local(job)

    def claim(self):
        task = self.client.rpc('claim')
        if not task:
            return
        scope = {'taskId': task['id'], 'leaseId': task['leaseId'], 'leaseVersion': task['leaseVersion']}
        try:
            prepared = self.client.rpc('prepare', scope=scope)
            if prepared.get('pendingCredentials'):
                return
            payload = payload_for(prepared, task, self.client)
            # Registry 按本机执行实例去重；业务原单和租约仍由 callback scope 校验。
            # 同租约重复领取保留缓存，新租约才能执行只读核对或付款前恢复。
            payload['id'] = str(uuid5(UUID(task['id']),
                'online-lease:' + str(UUID(task['leaseId'])) + ':' + str(task['leaseVersion'])))
            job_type = online_job_type(self.core)
            callback = OnlineCallback(self.client, scope, self.core)
            job = self.registry.start(payload, job_factory=lambda body: job_type(body, callback=callback))
            self.current = (scope, job)
            self.registered_quote = None
            self.resume_version = 0
            self.next_quote_check = 0
        except Exception as exc:
            if isinstance(exc, self.core.Stop) and exc.report.get('reason') == 'another_local_job_is_running':
                self.client.rpc('release', scope=scope)
            else:
                self.client.rpc('callback', {'type': 'finished', 'result': {'status': 'blocked', 'reason': 'online_preparation_failed', 'payment_attempted': False}}, scope)

    def run(self):
        while not self.stop_event.is_set():
            try:
                if self.current and self.current[1].done:
                    self.current = None
                    self.next_heartbeat = 0
                if time.monotonic() >= self.next_heartbeat:
                    self.heartbeat()
                if self.current:
                    self.approve_pending(*self.current)
                elif self.ready and not self.registry.busy():
                    self.claim()
            except Exception as exc:
                if not isinstance(exc, OnlineError):
                    print(json.dumps({'event': 'online_recharge_dispatch_failed',
                        'failure': 'unexpected_error', 'errorType': type(exc).__name__}), flush=True)
                if self.current and not self.current[1].done:
                    self.cancel_local(self.current[1])
                self.next_heartbeat = time.monotonic() + 10
            self.stop_event.wait(1)


def start_online_agent(config_file, registry, core):
    agent = OnlineAgent(config_file, registry, core)
    agent.thread.start()
    return agent
