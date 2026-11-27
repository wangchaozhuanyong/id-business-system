"""Private workspace relays with validated and pinned upstream connections."""

import asyncio
from contextlib import suppress
from dataclasses import dataclass
import errno
import ipaddress
import os
from pathlib import Path
import re
import socket
import stat
import sys
from urllib.parse import unquote_to_bytes, urlsplit

from worker.recharge_proxy import renewal_host_allowed


SOCKET_NAME = 'egress.sock'
CHUNK_SIZE = 64 * 1024
DNS_LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', re.ASCII)
USERINFO = re.compile(r"(?:[a-zA-Z0-9!$&'()*+,;=_.~:-]|%[0-9a-fA-F]{2})+")
HTTP_PORT = re.compile(r'[1-9][0-9]{0,4}', re.ASCII)
IPV4_EXCLUDED = tuple(map(ipaddress.ip_network, ('192.0.0.0/24', '192.88.99.0/24')))
IPV6_GLOBAL_UNICAST = ipaddress.ip_network('2000::/3')
IPV6_EXCLUDED = tuple(map(ipaddress.ip_network, ('2001::/23', '2002::/16', '3fff::/20')))
LOCAL_SUFFIXES = ('.local', '.localhost', '.internal', '.lan', '.home.arpa')


class EgressError(ValueError):
    """A safe diagnostic that does not include addresses, URLs or credentials."""


def _public_address(value):
    if not isinstance(value, str) or '%' in value:
        raise EgressError('Proxy address is not publicly routable')
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise EgressError('Proxy address is invalid') from None
    if (not address.is_global or address.is_multicast or address.is_reserved or address.is_loopback
            or address.is_link_local or address.is_unspecified):
        raise EgressError('Proxy address is not publicly routable')
    if address.version == 4:
        if any(address in network for network in IPV4_EXCLUDED):
            raise EgressError('Proxy address is not publicly routable')
    elif (address.ipv4_mapped is not None or address.is_site_local or address not in IPV6_GLOBAL_UNICAST
          or any(address in network for network in IPV6_EXCLUDED)):
        raise EgressError('Proxy address is not publicly routable')
    return address


@dataclass(frozen=True)
class PinnedProxy:
    address: str
    port: int

    def __post_init__(self):
        object.__setattr__(self, 'address', str(_public_address(self.address)))
        if type(self.port) is not int or not 1 <= self.port <= 65535:
            raise EgressError('Proxy port is invalid')

    @property
    def family(self):
        return socket.AF_INET6 if ':' in self.address else socket.AF_INET


def _parse_proxy(url):
    if (not isinstance(url, str) or not 1 <= len(url) <= 2048 or not url.startswith('http://')
            or any(not 33 <= ord(char) <= 126 for char in url) or any(char in url for char in '#?\\')):
        raise EgressError('Expected a canonical HTTP proxy URL')
    try:
        parts = urlsplit(url)
    except ValueError:
        raise EgressError('Expected a canonical HTTP proxy URL') from None
    if parts.path not in ('', '/') or not parts.netloc or parts.netloc.count('@') > 1:
        raise EgressError('Expected a canonical HTTP proxy URL')
    credentials, separator, authority = parts.netloc.rpartition('@')
    if separator:
        name, colon, password = credentials.partition(':')
        if not colon or not USERINFO.fullmatch(name) or not USERINFO.fullmatch(password):
            raise EgressError('Proxy credentials are invalid')
        username_bytes = unquote_to_bytes(name)
        if b':' in username_bytes or any(
            octet < 32 or octet == 127 for octet in username_bytes + unquote_to_bytes(password)
        ):
            raise EgressError('Proxy credentials are invalid')
    host, separator, raw_port = authority.rpartition(':')
    if not separator or not HTTP_PORT.fullmatch(raw_port) or int(raw_port) > 65535:
        raise EgressError('An explicit HTTP proxy port is required')
    port = int(raw_port)
    if host.startswith('[') and host.endswith(']'):
        numeric = _public_address(host[1:-1])
        if numeric.version != 6:
            raise EgressError('Proxy address is invalid')
        return str(numeric), port, True
    try:
        numeric = ipaddress.IPv4Address(host)
    except ValueError:
        hostname = host.lower().removesuffix('.')
        labels = hostname.split('.')
        if (len(hostname) > 253 or len(labels) < 2 or hostname.endswith(LOCAL_SUFFIXES)
                or labels[-1].isdigit() or not all(DNS_LABEL.fullmatch(label) for label in labels)):
            raise EgressError('Proxy hostname is invalid') from None
        # An absolute DNS name excludes local suffix search in the resolver.
        return hostname + '.', port, False
    return str(_public_address(str(numeric))), port, True


async def resolve_proxy(url, *, blocked_networks=(), timeout=3):
    """Resolve a bounded URL once. Reject the set if any DNS answer is unsafe."""
    host, port, numeric = _parse_proxy(url)
    networks = tuple(ipaddress.ip_network(network) for network in blocked_networks)
    return await _resolve_target(host, port, numeric, networks, timeout)


def _assigned_to_host(address):
    # A local bind tests kernel interface ownership without sending any packets.
    # Public IPs translated to this host upstream are covered by blocked_networks.
    family = socket.AF_INET if address.version == 4 else socket.AF_INET6
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as probe:
            probe.bind((str(address), 0))
    except OSError as error:
        if error.errno in (errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT):
            return False
        raise EgressError('Could not verify workspace network boundaries') from None
    return True


async def _resolve_target(host, port, numeric, networks, timeout, *, reject_host_addresses=False):
    if numeric:
        addresses = [_public_address(host)]
    else:
        try:
            records = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(
                    host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
                ),
                timeout,
            )
        except (OSError, asyncio.TimeoutError):
            raise EgressError('Proxy DNS resolution failed') from None
        if not 1 <= len(records) <= 64:
            raise EgressError('Proxy DNS returned an invalid address set')
        addresses = []
        for family, _, _, _, destination in records:
            if family not in (socket.AF_INET, socket.AF_INET6) or destination[1] != port:
                raise EgressError('Proxy DNS returned an invalid address set')
            address = _public_address(destination[0])
            if (family == socket.AF_INET) != (address.version == 4) or (
                family == socket.AF_INET6 and destination[3]
            ):
                raise EgressError('Proxy DNS returned an invalid address set')
            addresses.append(address)
    if any(address in network for address in addresses for network in networks):
        raise EgressError('Proxy address is blocked by the workspace policy')
    if reject_host_addresses and any(_assigned_to_host(address) for address in set(addresses)):
        raise EgressError('Workspace destinations cannot be hosted locally')
    selected = min(addresses, key=lambda address: (address.version, address.packed))
    return PinnedProxy(str(selected), port)


@dataclass(frozen=True)
class RelayLimits:
    connections: int = 24
    connect_timeout: float = 8
    idle_timeout: float = 90
    lifetime: float = 900

    def __post_init__(self):
        if (type(self.connections) is not int or not 1 <= self.connections <= 64
                or not 0 < self.connect_timeout <= 30 or not 0 < self.idle_timeout <= 300
                or not 0 < self.lifetime <= 3600):
            raise ValueError('Invalid relay limits')


async def _open_pinned(proxy):
    loop = asyncio.get_running_loop()
    upstream = socket.socket(proxy.family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
    try:
        upstream.setblocking(False)
        # sock_connect sees an address already validated by inet_pton-compatible
        # parsing, so there is no hostname or resolver on the relay path.
        address = (proxy.address, proxy.port)
        if proxy.family == socket.AF_INET6:
            address += (0, 0)
        await loop.sock_connect(upstream, address)
        return await asyncio.open_connection(sock=upstream, limit=CHUNK_SIZE)
    except BaseException:
        upstream.close()
        raise


async def _copy(source, target, touch, deadline):
    while True:
        chunk = await source.read(CHUNK_SIZE)
        if not chunk:
            if target.can_write_eof():
                target.write_eof()
            return
        touch()
        target.write(chunk)
        await asyncio.wait_for(target.drain(), deadline)
        touch()


async def _bridge(client_reader, client_writer, upstream_reader, upstream_writer, limits):
    loop = asyncio.get_running_loop()
    last_activity = loop.time()

    def touch():
        nonlocal last_activity
        last_activity = loop.time()

    async def deadline():
        while True:
            remaining = last_activity + limits.idle_timeout - loop.time()
            if remaining <= 0:
                return
            await asyncio.sleep(remaining)

    for writer in (client_writer, upstream_writer):
        writer.transport.set_write_buffer_limits(high=CHUNK_SIZE, low=CHUNK_SIZE // 4)
    copies = asyncio.gather(
        _copy(client_reader, upstream_writer, touch, limits.idle_timeout),
        _copy(upstream_reader, client_writer, touch, limits.idle_timeout),
    )
    idle = asyncio.create_task(deadline())
    try:
        done, _ = await asyncio.wait(
            (copies, idle), timeout=limits.lifetime, return_when=asyncio.FIRST_COMPLETED
        )
        if copies in done:
            copies.result()
    finally:
        copies.cancel()
        idle.cancel()
        await asyncio.gather(copies, idle, return_exceptions=True)


async def _close_writer(writer):
    writer.close()
    with suppress(OSError, asyncio.TimeoutError):
        await asyncio.wait_for(writer.wait_closed(), 1)
    # A blocked peer must not keep the connection alive after its deadline.
    writer.transport.abort()


def _unlink_created_socket(directory, identity):
    if identity is None:
        return
    try:
        info = os.stat(SOCKET_NAME, dir_fd=directory, follow_symlinks=False)
        if (info.st_dev, info.st_ino) == identity and stat.S_ISSOCK(info.st_mode):
            os.unlink(SOCKET_NAME, dir_fd=directory)
    except FileNotFoundError:
        pass


class Relay:
    def __init__(self, directory, identity, connect, limits, *, answer_connect):
        self._directory = directory
        self._identity = identity
        self._connect = connect
        self._answer_connect = answer_connect
        self._limits = limits
        self._clients = {}
        self._stopped = None
        self._listener = None

    def _accept(self, reader, writer):
        if self._stopped is not None or len(self._clients) >= self._limits.connections:
            writer.close()
            return
        task = asyncio.create_task(self._serve(reader, writer))
        self._clients[task] = writer
        task.add_done_callback(self._clients.pop)

    async def _serve(self, reader, writer):
        upstream_writer = None
        try:
            try:
                upstream_reader, upstream_writer = await asyncio.wait_for(
                    self._connect(reader), self._limits.connect_timeout
                )
            except (EgressError, OSError, asyncio.TimeoutError) as error:
                if self._answer_connect:
                    status = b'403 Forbidden' if isinstance(error, RenewalRequestError) else b'502 Bad Gateway'
                    writer.write(b'HTTP/1.1 ' + status + b'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
                    await asyncio.wait_for(writer.drain(), self._limits.connect_timeout)
                return
            if self._answer_connect:
                writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                await asyncio.wait_for(writer.drain(), self._limits.connect_timeout)
            await _bridge(reader, writer, upstream_reader, upstream_writer, self._limits)
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            writers = (writer,) if upstream_writer is None else (writer, upstream_writer)
            await asyncio.gather(*(_close_writer(connection) for connection in writers))

    async def _shutdown(self):
        self._listener.close()
        clients = tuple(self._clients.items())
        for task, writer in clients:
            writer.close()
            task.cancel()
        try:
            await asyncio.gather(*(task for task, _ in clients), return_exceptions=True)
            await self._listener.wait_closed()
        finally:
            try:
                _unlink_created_socket(self._directory, self._identity)
            finally:
                os.close(self._directory)

    async def close(self):
        if self._stopped is None:
            self._stopped = asyncio.create_task(self._shutdown())
        await asyncio.shield(self._stopped)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


async def open_relay(workspace_dir, proxy, *, uid=None, gid=None, limits=RelayLimits()):
    if type(proxy) is not PinnedProxy:
        raise EgressError('A validated, pinned proxy is required')
    return await _listen_relay(workspace_dir, lambda _: _open_pinned(proxy), uid, gid, limits, answer_connect=False)


class RenewalRequestError(EgressError):
    """The worker did not send an approved, unauthenticated HTTPS CONNECT."""


async def _renewal_destination(reader):
    # Only the canonical two-line request generated by the workspace adapter is
    # accepted. No client headers or authorization reach the destination.
    try:
        headers = await reader.readuntil(b'\r\n\r\n')
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        raise RenewalRequestError('Invalid renewal request') from None
    if len(headers) > 1024:
        raise RenewalRequestError('Invalid renewal request')
    first, _, rest = headers.partition(b'\r\n')
    fields = first.split(b' ')
    if len(fields) != 3 or fields[0] != b'CONNECT' or fields[2] != b'HTTP/1.1':
        raise RenewalRequestError('Invalid renewal request')
    authority = fields[1]
    if not authority.endswith(b':443') or rest != b'Host: ' + authority + b'\r\n\r\n':
        raise RenewalRequestError('Invalid renewal request')
    try:
        host = authority[:-4].decode('ascii')
    except UnicodeError:
        raise RenewalRequestError('Invalid renewal request') from None
    if not renewal_host_allowed(host):
        raise RenewalRequestError('Destination unavailable in renewal workspaces')
    return host


async def open_renewal_relay(workspace_dir, *, uid, gid, blocked_networks, limits=RelayLimits()):
    """Expose only approved HTTPS sites to a network-isolated manual browser."""
    networks = tuple(ipaddress.ip_network(network) for network in blocked_networks)
    if not networks:
        raise EgressError('Renewal workspaces require configured host network exclusions')

    async def connect(reader):
        host = await _renewal_destination(reader)
        target = await _resolve_target(host + '.', 443, False, networks, 3, reject_host_addresses=True)
        return await _open_pinned(target)

    return await _listen_relay(workspace_dir, connect, uid, gid, limits, answer_connect=True)


async def _listen_relay(workspace_dir, connect, uid, gid, limits, *, answer_connect):
    """Listen privately. Mount this broker-owned directory read-only in the worker."""
    directory = None
    listener = None
    identity = None
    try:
        directory = os.open(workspace_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(directory)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise EgressError('Proxy relay directory is not private')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        # The Linux bind goes through the opened directory, even if an
        # ancestor is renamed. A caller supplies only a trusted workspace path.
        address = (Path('/proc/self/fd') / str(directory) if sys.platform == 'linux'
                   else Path(workspace_dir)) / SOCKET_NAME
        listener.bind(os.fspath(address))
        info = os.stat(SOCKET_NAME, dir_fd=directory, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        os.chmod(SOCKET_NAME, 0o600, dir_fd=directory)
        if uid is not None or gid is not None:
            os.chown(SOCKET_NAME, uid if uid is not None else -1, gid if gid is not None else -1,
                     dir_fd=directory, follow_symlinks=False)
        relay = Relay(directory, identity, connect, limits, answer_connect=answer_connect)
        relay._listener = await asyncio.start_unix_server(
            relay._accept, sock=listener, backlog=limits.connections, limit=CHUNK_SIZE
        )
        return relay
    except BaseException as error:
        if listener is not None:
            listener.close()
        if directory is not None:
            try:
                _unlink_created_socket(directory, identity)
            finally:
                os.close(directory)
        if isinstance(error, OSError):
            raise EgressError('Private proxy relay could not start') from None
        raise
