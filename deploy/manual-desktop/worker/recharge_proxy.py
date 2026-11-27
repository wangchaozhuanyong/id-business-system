"""A private HTTPS CONNECT adapter for the manual recharge desktop."""

import asyncio
import base64
from contextlib import suppress
import http.client
import ipaddress
import json
import re
import socket
import ssl


RELAY_PATH = '/run/workspace-input/egress.sock'
PROBE_HOST = 'api.country.is'
APPROVED_DOMAIN_SUFFIXES = (
    'chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com', 'oaistatsig.com',
    'js.stripe.com',
)
# Narrow third-party dependencies from OpenAI's published network requirements
# and the Stripe-hosted checkout.
SUPPORT_HOSTS = frozenset({
    PROBE_HOST,
    'cdn.openaimerge.com', 'challenges.cloudflare.com',
    'cdn.workos.com', 'frontend-apps-multi-region.workos.com', 'forwarder.workos.com',
    'images.workoscdn.com', 'setup.workos.com', 'workos.imgix.net',
    'api.stripe.com', 'checkout.stripe.com', 'hooks.stripe.com',
})
HEADER_LIMIT = 16 * 1024
BUFFER_SIZE = 64 * 1024
MAX_CONNECTIONS = 24
HANDSHAKE_TIMEOUT = 8
STREAM_IDLE_TIMEOUT = 90
STREAM_LIFETIME = 900
PROBE_TIMEOUT = 12
PROBE_BODY_LIMIT = 4096
IPV4_EXCLUDED = tuple(map(ipaddress.ip_network, ('192.0.0.0/24', '192.88.99.0/24')))
IPV6_GLOBAL_UNICAST = ipaddress.ip_network('2000::/3')
IPV6_EXCLUDED = tuple(map(ipaddress.ip_network, ('2001::/23', '2002::/16', '3fff::/20')))
AUTHORITY = re.compile(rb'([a-zA-Z0-9.-]{1,253}):443')
DNS_LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
CONNECT = re.compile(rb'CONNECT ([^ ]+) HTTP/1\.[01]')
RESPONSE_OK = re.compile(rb'HTTP/1\.[01] 200(?: [ -~]*)?')
HEADER_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9a-zA-Z-]+")


class ProxyError(ValueError):
    """A diagnostic that omits credentials and upstream-supplied data."""


def _basic_auth(credentials):
    if credentials is None:
        return b''
    if (not isinstance(credentials, tuple) or len(credentials) != 2
            or any(not isinstance(value, str) or not value for value in credentials)
            or ':' in credentials[0]):
        raise ProxyError('Proxy credentials are invalid')
    try:
        value = ':'.join(credentials).encode('utf-8')
    except UnicodeError:
        raise ProxyError('Proxy credentials are invalid') from None
    if len(value) > 2048 or any(byte < 32 or byte == 127 for byte in value):
        raise ProxyError('Proxy credentials are invalid')
    return b'Proxy-Authorization: Basic ' + base64.b64encode(value) + b'\r\n'


def _allowed_host(host):
    return host in SUPPORT_HOSTS or any(
        host == domain or host.endswith('.' + domain) for domain in APPROVED_DOMAIN_SUFFIXES
    )


async def _head(reader):
    headers = await reader.readuntil(b'\r\n\r\n')
    if len(headers) > HEADER_LIMIT:
        raise ProxyError('Proxy headers exceed the allowed size')
    return headers[:-4].split(b'\r\n')


def _destination(lines):
    request = CONNECT.fullmatch(lines[0])
    authority = AUTHORITY.fullmatch(request[1]) if request else None
    if not authority:
        raise ProxyError('Expected an HTTPS CONNECT request')
    host = authority[1].decode('ascii').lower()
    if not all(DNS_LABEL.fullmatch(label) for label in host.split('.')):
        raise ProxyError('CONNECT hostname is invalid')
    host_header = None
    for header in lines[1:]:
        key, separator, value = header.partition(b':')
        if (not separator or not HEADER_NAME.fullmatch(key)
                or any(byte != 9 and not 32 <= byte <= 126 for byte in value)):
            raise ProxyError('CONNECT header is invalid')
        key = key.lower()
        if key in (b'content-length', b'transfer-encoding', b'proxy-authorization'):
            raise ProxyError('CONNECT header is forbidden')
        if key == b'host':
            if host_header is not None or value.strip().lower() != request[1].lower():
                raise ProxyError('CONNECT Host header is invalid')
            host_header = value
    return host


def _connect_request(authority, authorization=b''):
    host = authority.encode('ascii')
    return b'CONNECT ' + host + b' HTTP/1.1\r\nHost: ' + host + b'\r\n' + authorization + b'\r\n'


async def _copy(reader, writer, activity):
    while True:
        data = await reader.read(BUFFER_SIZE)
        if not data:
            if writer.can_write_eof():
                writer.write_eof()
            return
        activity.set()
        writer.write(data)
        await asyncio.wait_for(writer.drain(), STREAM_IDLE_TIMEOUT)


async def _tunnel(reader, writer, upstream_reader, upstream_writer):
    for connection in (writer, upstream_writer):
        connection.transport.set_write_buffer_limits(high=BUFFER_SIZE, low=BUFFER_SIZE // 4)
    activity = asyncio.Event()

    async def expire_idle():
        while True:
            try:
                await asyncio.wait_for(activity.wait(), STREAM_IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                return
            activity.clear()

    copies = asyncio.gather(
        _copy(reader, upstream_writer, activity),
        _copy(upstream_reader, writer, activity),
    )
    idle = asyncio.create_task(expire_idle())
    try:
        done, _ = await asyncio.wait(
            (copies, idle), timeout=STREAM_LIFETIME, return_when=asyncio.FIRST_COMPLETED
        )
        if copies in done:
            copies.result()
    finally:
        copies.cancel()
        idle.cancel()
        await asyncio.gather(copies, idle, return_exceptions=True)


async def _write(writer, data):
    writer.write(data)
    await asyncio.wait_for(writer.drain(), HANDSHAKE_TIMEOUT)


async def _close(writer):
    writer.close()
    with suppress(OSError, asyncio.TimeoutError):
        await asyncio.wait_for(writer.wait_closed(), 1)
    writer.transport.abort()


class WorkerProxy:
    def __init__(self, relay_path, authorization):
        self._relay_path = relay_path
        self._authorization = authorization
        self._listener = None
        self._clients = {}
        self._shutdown_task = None

    @property
    def port(self):
        return self._listener.sockets[0].getsockname()[1]

    def _accept(self, reader, writer):
        if self._shutdown_task is not None or len(self._clients) >= MAX_CONNECTIONS:
            writer.close()
            return
        task = asyncio.create_task(self._serve(reader, writer))
        self._clients[task] = writer
        task.add_done_callback(self._clients.pop)

    async def _serve(self, reader, writer):
        upstream_writer = None
        error = None
        try:
            error = b'400 Bad Request'
            host = _destination(await asyncio.wait_for(_head(reader), HANDSHAKE_TIMEOUT))
            error = b'403 Forbidden'
            if not _allowed_host(host):
                return
            error = b'502 Bad Gateway'
            upstream_reader, upstream_writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self._relay_path, limit=HEADER_LIMIT),
                HANDSHAKE_TIMEOUT,
            )
            await _write(upstream_writer, _connect_request(host + ':443', self._authorization))
            response = await asyncio.wait_for(_head(upstream_reader), HANDSHAKE_TIMEOUT)
            if not RESPONSE_OK.fullmatch(response[0]):
                return
            error = None
            await _write(writer, b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await _tunnel(reader, writer, upstream_reader, upstream_writer)
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError, ProxyError):
            pass
        except asyncio.CancelledError:
            error = None
            raise
        finally:
            try:
                if error is not None:
                    with suppress(OSError, asyncio.TimeoutError):
                        await _write(
                            writer, b'HTTP/1.1 ' + error + b'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
                        )
            finally:
                writers = (writer,) if upstream_writer is None else (writer, upstream_writer)
                await asyncio.gather(*(_close(connection) for connection in writers))

    async def _shutdown(self):
        self._listener.close()
        for task in tuple(self._clients):
            self._clients[task].close()
            task.cancel()
        await asyncio.gather(*self._clients, return_exceptions=True)
        await self._listener.wait_closed()
        self._authorization = b''

    async def close(self):
        if self._shutdown_task is None:
            self._shutdown_task = asyncio.create_task(self._shutdown())
        await asyncio.shield(self._shutdown_task)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


async def open_proxy(credentials=None, *, relay_path=RELAY_PATH):
    """Listen only on the isolated worker's IPv4 loopback."""
    proxy = WorkerProxy(relay_path, _basic_auth(credentials))
    proxy._listener = await asyncio.start_server(
        proxy._accept, host='127.0.0.1', port=0, family=socket.AF_INET,
        limit=HEADER_LIMIT, backlog=MAX_CONNECTIONS,
    )
    return proxy


def _request_exit(sock):
    # Use a duplicate so the caller can shut down the connection at the
    # overall deadline, including while TLS owns this copy of the descriptor.
    with sock.dup() as probe:
        probe.settimeout(HANDSHAKE_TIMEOUT)
        probe.sendall(_connect_request(PROBE_HOST + ':443'))
        with http.client.HTTPResponse(probe, method='CONNECT') as response:
            response.begin()
            if response.status != 200:
                raise ProxyError('Proxy exit check failed')
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        with context.wrap_socket(probe, server_hostname=PROBE_HOST) as tls:
            tls.sendall(
                f'GET / HTTP/1.1\r\nHost: {PROBE_HOST}\r\n'
                'Accept: application/json\r\nConnection: close\r\n\r\n'.encode('ascii')
            )
            with http.client.HTTPResponse(tls) as response:
                response.begin()
                if response.status != 200 or response.headers.get_content_type() != 'application/json':
                    raise ProxyError('Proxy exit check failed')
                body = response.read(PROBE_BODY_LIMIT + 1)
                if len(body) > PROBE_BODY_LIMIT:
                    raise ProxyError('Proxy exit check failed')
    return json.loads(body)


def _validated_exit(data, expected_country):
    try:
        raw_ip, country = data['ip'], data['country']
        if not isinstance(raw_ip, str) or '%' in raw_ip:
            raise ValueError
        ip = ipaddress.ip_address(raw_ip)
        if (not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local
                or ip.is_unspecified
                or not isinstance(country, str) or not re.fullmatch('[A-Z]{2}', country)):
            raise ValueError
        if ip.version == 4:
            if any(ip in network for network in IPV4_EXCLUDED):
                raise ValueError
        elif ip not in IPV6_GLOBAL_UNICAST or any(ip in network for network in IPV6_EXCLUDED):
            raise ValueError
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProxyError('Proxy exit check returned an invalid address or country') from None
    if expected_country and country != expected_country:
        raise ProxyError('Proxy exit country does not match the selection')
    return {'ip': str(ip), 'country': country}


async def verify_exit(proxy, expected_country=None):
    """Measure the current public exit through the exact same local proxy as Chromium."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
            client.setblocking(False)

            async def request():
                await asyncio.get_running_loop().sock_connect(client, ('127.0.0.1', proxy.port))
                return await asyncio.to_thread(_request_exit, client)

            try:
                data = await asyncio.wait_for(request(), PROBE_TIMEOUT)
            finally:
                with suppress(OSError):
                    client.shutdown(socket.SHUT_RDWR)
    except (OSError, asyncio.TimeoutError, http.client.HTTPException, ValueError):
        raise ProxyError('Proxy exit check failed') from None
    return _validated_exit(data, expected_country)
