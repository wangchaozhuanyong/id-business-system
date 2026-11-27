"""Private Unix-socket bridge between the authenticated website and isolated desktops."""

import argparse
import asyncio
import contextlib
from contextvars import ContextVar
import fcntl
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct
import sys
import tempfile
from urllib.parse import quote, unquote

from aiohttp import WSMsgType, web

# Isolated Python (-I) omits the script directory, including these installed
# broker modules. Trust only this script's own directory for sibling imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import egress
from egress import EgressError, SOCKET_NAME as EGRESS_SOCKET, open_relay, resolve_proxy


SYSTEMCTL = "/usr/bin/systemctl"
CLAIM_LOCKS = ContextVar("claim_locks", default=())
KEY = re.compile(r"manual-v1-[0-9a-f]{64}")
OWNER = re.compile(r"owner-v1-[0-9a-f]{64}")
ASSET_DIRECTORY = re.compile(r"[A-Za-z0-9_-]+")
ASSET_FILENAME = re.compile(r"[A-Za-z0-9_.-]+\.js")
MAX_ASSET_PATH = 1024
RECHARGE_BODY_LIMIT = 8 * 1024
RECHARGE_REPLY_LIMIT = 512
COUNTRY = re.compile(r"[A-Z]{2}")
PROXY_SESSION = re.compile(r"([-_:]session[-_:])([a-zA-Z0-9_-]{1,2048}?)((?:[-_:]sessiontime[-_:]|\b|$))",
                           re.IGNORECASE | re.ASCII)
WORKER_UID = WORKER_GID = 10001
RFB_VERSION = re.compile(rb"RFB 003\.00[378]\n")


def socket_identity(info):
    if not stat.S_ISSOCK(info.st_mode):
        raise ConnectionRefusedError()
    return info.st_dev, info.st_ino


async def connect_display(path, expected=None):
    # Linux O_PATH pins the actual socket in the assigned directory. A worker
    # cannot substitute a symlink to a neighbouring display during connection.
    directory = os.open(path.parent, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        fd = os.open('rfb.sock', os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
        try:
            identity = socket_identity(os.fstat(fd))
            if expected is not None and identity != expected:
                raise ConnectionRefusedError()
            return await asyncio.open_unix_connection('/proc/self/fd/' + str(fd))
        finally:
            os.close(fd)
    finally:
        os.close(directory)


async def desktop_ready(key, connect_worker):
    try:
        reader, writer = await asyncio.wait_for(connect_worker(key), 1)
        try:
            version = await asyncio.wait_for(reader.readexactly(12), 1)
            return bool(RFB_VERSION.fullmatch(version))
        finally:
            writer.close()
            await writer.wait_closed()
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        return False


async def systemd_output(*args, timeout=3, mutation=False):
    command = [SYSTEMCTL, '--no-ask-password', '--no-pager', *args]
    locks = CLAIM_LOCKS.get() if mutation else ()
    if locks:
        # This separate monitor owns copies of the locks until systemctl has exited,
        # even if the broker is killed before systemd receives a pending start/stop.
        command = ['/usr/bin/timeout', '--foreground', '--kill-after=1', str(timeout), *command]
    try:
        process = await asyncio.create_subprocess_exec(
            *command, pass_fds=locks, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        raise web.HTTPServiceUnavailable(reason='Host service manager unavailable') from None
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout + (3 if locks else 0))
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        if not locks:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
        # A mutation monitor enforces its own deadline and retains ownership
        # through command termination. Other requests must not overtake it.
        if isinstance(error, asyncio.CancelledError):
            raise
        raise web.HTTPServiceUnavailable(reason='Host service state uncertain') from None
    if locks and process.returncode in (124, 125, 137):
        raise web.HTTPServiceUnavailable(reason='Host service state uncertain')
    return output.decode('utf-8', errors='replace') if process.returncode == 0 else None


async def start_unit(key):
    return await systemd_output('--no-block', 'start', 'id-manual-workspace@' + key + '.service',
                               timeout=5, mutation=True) is not None


async def stop_unit(key):
    unit = 'id-manual-workspace@' + key + '.service'
    if await systemd_output('stop', unit, timeout=32, mutation=True) is None:
        return False
    status = await systemd_output('show', '-p', 'Result', '-p', 'ActiveState', '-p', 'ExecMainStatus', unit)
    values = dict(line.split('=', 1) for line in (status or '').splitlines() if '=' in line)
    return (values.get('Result') == 'success' and values.get('ActiveState') == 'inactive'
            and values.get('ExecMainStatus') == '0')


async def unit_state(key):
    try:
        output = await systemd_output('show', '--all', '-p', 'LoadState', '-p', 'ActiveState',
                                     '-p', 'Job', '-p', 'MainPID', '-p', 'ControlPID',
                                     'id-manual-workspace@' + key + '.service')
    except web.HTTPServiceUnavailable:
        return 'unknown'
    props = dict(line.split('=', 1) for line in (output or '').splitlines() if '=' in line)
    if props.get('LoadState') != 'loaded' or 'Job' not in props:
        return 'unknown'
    if (props['Job'] not in ('', '0') or
            props.get('ActiveState') in ('activating', 'active', 'deactivating', 'reloading', 'refreshing')):
        return 'busy'
    if (props.get('ActiveState') in ('inactive', 'failed') and
            props.get('MainPID') == '0' and props.get('ControlPID') == '0'):
        return 'idle'
    return 'unknown'


async def running_units():
    output = await systemd_output('list-units', '--no-legend', '--plain',
                                 '--state=activating,active,deactivating,reloading,refreshing,maintenance',
                                 'id-manual-workspace@*.service')
    if output is None:
        return None
    result = set()
    for line in output.splitlines():
        if not line.strip():
            return None
        match = re.fullmatch(r'id-manual-workspace@(manual-v1-[0-9a-f]{64})\.service', line.split()[0])
        if not match:
            return None
        result.add(match[1])
    return result


class WorkspaceLocked(web.HTTPClientError):
    status_code = 423


class Claims:
    """Small, host-owned journal. A directory lock serializes atomic index updates."""
    def __init__(self, directory):
        self.root = Path(directory)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('claims directory must be owned by the broker with mode 0700')
        self.index = self.root / 'bindings.json'
        with self.map_lock():
            if not tuple(self.root.iterdir()):
                self.write({})
                (self.root / 'initialized').touch(mode=0o600)
                self.sync_directory()
            self.read()

    @contextlib.contextmanager
    def map_lock(self):
        fd = os.open(self.root, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def sync_directory(self):
        fd = os.open(self.root, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def read(self):
        try:
            for path in (self.index, self.root / 'initialized'):
                info = path.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600):
                    raise ValueError()
            data = json.loads(self.index.read_bytes())
            values = set()
            if not isinstance(data, dict):
                raise ValueError()
            for owner, entry in data.items():
                if not (OWNER.fullmatch(owner) and isinstance(entry, dict) and set(entry) == {'key', 'phase'}
                        and isinstance(entry['key'], str) and KEY.fullmatch(entry['key'])
                        and entry['phase'] in ('starting', 'tracking', 'stopping') and entry['key'] not in values):
                    raise ValueError()
                values.add(entry['key'])
            return data
        except (OSError, ValueError, TypeError):
            raise web.HTTPServiceUnavailable(reason='Workspace claims unavailable') from None

    def write(self, data):
        fd, name = tempfile.mkstemp(dir=self.root, prefix='.bindings-')
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(data, out, separators=(',', ':'))
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, self.index)
            self.sync_directory()
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name)

    def set(self, owner, key, phase):
        # Callers hold the owner lock. The shared index lock also enforces inverse uniqueness.
        with self.map_lock():
            data = self.read()
            if any(other != owner and entry['key'] == key for other, entry in data.items()):
                raise web.HTTPForbidden()
            if owner in data and data[owner]['key'] != key:
                raise WorkspaceLocked()
            old = data.get(owner)
            new = {'key': key, 'phase': phase} if phase else None
            if old != new:
                if new is None:
                    del data[owner]
                else:
                    data[owner] = new
                self.write(data)

    @contextlib.asynccontextmanager
    async def lock(self, name, timeout, on_busy=None):
        if name == 'admission':
            filename = 'admission.lock'
        elif OWNER.fullmatch(name):
            owner_id = int(name[len('owner-v1-'):], 16)
            filename = f'owner-v1-{owner_id:064x}.lock'
        else:
            raise web.HTTPForbidden()
        root = os.path.abspath(self.root)
        path = os.path.abspath(os.path.join(root, filename))
        if not path.startswith(root + os.sep):
            raise web.HTTPForbidden()
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        except OSError:
            raise web.HTTPServiceUnavailable(reason='Workspace lock unavailable') from None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise web.HTTPServiceUnavailable(reason='Workspace lock unavailable')
            deadline = asyncio.get_running_loop().time() + timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if on_busy:
                        on_busy()
                    if asyncio.get_running_loop().time() >= deadline:
                        raise web.HTTPServiceUnavailable(headers={'Retry-After': '1'})
                    await asyncio.sleep(0.05)
            token = CLAIM_LOCKS.set((*CLAIM_LOCKS.get(), fd))
            try:
                yield
            finally:
                CLAIM_LOCKS.reset(token)
        finally:
            os.close(fd)


async def host_has_capacity(max_active, min_available_mib):
    info = Path('/proc/meminfo').read_text()
    available = re.search(r'^MemAvailable:\s+(\d+) kB$', info, re.MULTILINE)
    if not available or int(available[1]) < min_available_mib * 1024:
        return False
    active = await running_units()
    return active is not None and len(active) < max_active


async def read_recharge_config(request):
    if request.content_type != 'application/json' or 'Content-Encoding' in request.headers:
        raise web.HTTPBadRequest()
    with contextlib.suppress(ValueError):
        body = await request.json()
        if isinstance(body, dict) and set(body) == {'email', 'proxyUrl', 'expectedCountry'}:
            email, proxy_url, country = body['email'], body['proxyUrl'], body['expectedCountry']
            if (valid_account_email(email)
                    and isinstance(proxy_url, str) and 1 <= len(proxy_url) <= 2048
                    and isinstance(country, str) and (not country or COUNTRY.fullmatch(country))):
                return body
    raise web.HTTPBadRequest()


def valid_account_email(email):
    if (not isinstance(email, str) or not 1 <= len(email) <= 254 or not email.isprintable()
            or any(character.isspace() for character in email)):
        return False
    account, marker, domain = email.partition('@')
    name, dot, suffix = domain.rpartition('.')
    return bool(account and marker and name and dot and suffix and '@' not in domain)


def materialize_proxy_session(url):
    # Only a provider username participates in rotation. Preserve the selected
    # host, port and encoded password so the same connection is probed and used.
    scheme, marker, remainder = url.partition('://')
    authority, slash, suffix = remainder.partition('/')
    credentials, separator, destination = authority.rpartition('@')
    name, colon, password = credentials.partition(':')
    if scheme != 'http' or not separator or not name or not colon or not password:
        return url
    try:
        username = unquote(name, errors='strict')
    except UnicodeError:
        return url
    if '{session}' in username:
        identifier = str(10_000_000 + secrets.randbelow(90_000_000))
        username = username.replace('{session}', identifier)
    else:
        match = PROXY_SESSION.search(username)
        if match is None:
            return url
        identifier = str(10_000_000 + secrets.randbelow(90_000_000))
        username = username[:match.start(2)] + identifier + username[match.end(2):]
    resolved = quote(username, safe="-_.~!*'()")
    return scheme + marker + resolved + colon + password + separator + destination + slash + suffix


def recharge_result(data, expected_country):
    if (not isinstance(data, dict) or set(data) != {'exitIp', 'country', 'accountStatus'}
            or not isinstance(data['country'], str) or not COUNTRY.fullmatch(data['country'])
            or (expected_country and data['country'] != expected_country)
            or data['accountStatus'] != 'check-in-browser' or not isinstance(data['exitIp'], str)
            or '%' in data['exitIp']):
        raise web.HTTPUnprocessableEntity()
    with contextlib.suppress(ValueError):
        ip = ipaddress.ip_address(data['exitIp'])
        if ip.is_global and not ip.is_multicast:
            return {'exitIp': str(ip), 'country': data['country'], 'accountStatus': 'check-in-browser'}
    raise web.HTTPUnprocessableEntity()


async def recharge_unit_available():
    probe = 'id-manual-workspace@manual-v1-' + '0' * 64 + '.service'
    state = await systemd_output('show', '-p', 'LoadState', '--value', probe)
    return state is not None and state.strip() == 'loaded'


class RechargeInputs:
    def __init__(self, root, blocked_networks=(), uid=WORKER_UID, gid=WORKER_GID):
        self.root = Path(root)
        self.blocked_networks = tuple(ipaddress.ip_network(network) for network in blocked_networks)
        self.uid = uid
        self.gid = gid
        self.fd = None

    def check(self):
        info = self.root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('Recharge input root must be broker-owned with mode 0700')

    @contextlib.contextmanager
    def exclusive(self):
        self.check()
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.fd = fd
            yield
        finally:
            self.fd = None
            os.close(fd)

    def workspace(self, key):
        if self.fd is None or not KEY.fullmatch(key):
            raise web.HTTPServiceUnavailable()
        identifier = int(key[len('manual-v1-'):], 16)
        root = os.path.abspath(self.root)
        path = os.path.abspath(os.path.join(root, f'manual-v1-{identifier:064x}'))
        if not path.startswith(root + os.sep):
            raise web.HTTPServiceUnavailable()
        # Keep a relative socket path where a fixture runs on macOS. Linux
        # binds the real listener through an open descriptor below.
        directory = Path(path) if self.root.is_absolute() else self.root / Path(path).name
        with contextlib.suppress(FileExistsError):
            directory.mkdir(mode=0o710)
            os.chown(directory, -1, self.gid)
            directory.chmod(0o710)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != self.gid
                or stat.S_IMODE(info.st_mode) != 0o710):
            raise web.HTTPServiceUnavailable()
        # The caller confirmed that the worker ended. Only the exclusive
        # broker can write here, so an existing relay is left by a dead broker.
        stale = directory / EGRESS_SOCKET
        with contextlib.suppress(FileNotFoundError):
            info = stale.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != self.uid or info.st_gid != self.gid:
                raise web.HTTPServiceUnavailable()
            stale.unlink()
        return directory

    async def relay(self, directory, url):
        pinned = await resolve_proxy(url, blocked_networks=self.blocked_networks)
        return await open_relay(directory, pinned, uid=self.uid, gid=self.gid)

    async def renewal_relay(self, directory):
        return await egress.open_renewal_relay(directory, uid=self.uid, gid=self.gid,
                                              blocked_networks=self.blocked_networks)

    @contextlib.asynccontextmanager
    async def bootstrap(self, directory, config):
        loop = asyncio.get_running_loop()
        outcome = loop.create_future()
        client = None
        connection = None

        async def exchange(reader, writer):
            try:
                payload = json.dumps(config, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
                if len(payload) > RECHARGE_BODY_LIMIT:
                    raise ValueError()
                writer.write(payload)
                await writer.drain()
                reply = await reader.readuntil(b'\n')
                if len(reply) > RECHARGE_REPLY_LIMIT:
                    raise ValueError()
                result = json.loads(reply)
                if config == {'mode': 'renewal'}:
                    if result != {'mode': 'renewal', 'ready': True} or result['ready'] is not True:
                        raise ValueError()
                else:
                    result = recharge_result(result, config['expectedCountry'])
                outcome.set_result(result)
            except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError,
                    web.HTTPUnprocessableEntity):
                if not outcome.done():
                    outcome.set_result(None)
            finally:
                writer.close()
                with contextlib.suppress(OSError, asyncio.TimeoutError):
                    await asyncio.wait_for(writer.wait_closed(), 1)

        def accept(reader, writer):
            nonlocal client, connection
            if client is not None:
                writer.close()
                return
            try:
                if hasattr(socket, 'SO_PEERCRED'):
                    peer = writer.get_extra_info('socket')
                    _, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if (uid, gid) != (self.uid, self.gid):
                        writer.close()
                        return
            except OSError:
                writer.close()
                return
            client = writer
            connection = asyncio.create_task(exchange(reader, writer))

        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            base = Path('/proc/self/fd') / str(fd) if Path('/proc/self/fd').is_dir() else directory
            target = base / 'bootstrap.sock'
            with broker_listener(target) as listener:
                os.chown(target, -1, self.gid)
                server = await asyncio.start_unix_server(accept, sock=listener, limit=RECHARGE_REPLY_LIMIT)
                try:
                    yield outcome
                finally:
                    server.close()
                    await server.wait_closed()
                    if client is not None:
                        client.close()
                    if connection is not None:
                        connection.cancel()
                        await asyncio.gather(connection, return_exceptions=True)
                    outcome.cancel()
        finally:
            os.close(fd)


def client_assets(root):
    root = Path(root).resolve(strict=True)
    assets = {}
    for directory in ('core', 'vendor'):
        for candidate in (root / directory).rglob('*.js'):
            relative = candidate.relative_to(root)
            name = relative.as_posix()
            if (len(name) > MAX_ASSET_PATH or not ASSET_FILENAME.fullmatch(relative.name)
                    or any(not ASSET_DIRECTORY.fullmatch(part) for part in relative.parts[:-1])):
                continue
            try:
                path = candidate.resolve()
            except (OSError, RuntimeError):
                continue
            if path.is_relative_to(root) and path.is_file():
                assets[name] = path
    return assets


def create_app(workers, assets, activate=None, admit=None, startup_seconds=30, connect=connect_display, stop=None,
               *, claims, inspect_unit=unit_state, inventory=running_units,
               recharge=None, recharge_available=recharge_unit_available):
    app = web.Application(client_max_size=RECHARGE_BODY_LIMIT)
    workers = Path(workers)
    assets = client_assets(assets)
    journal = Claims(claims)
    stops = {}
    prepared = {}
    selection_key = secrets.token_bytes(32)

    def worker_display(key):
        # Look up the registered directory on disk. The request identifies a
        # workspace but never supplies a path component to the socket opener.
        with os.scandir(workers) as entries:
            path = next((entry.path for entry in entries
                         if entry.name == key and entry.is_dir(follow_symlinks=False)), None)
        if path is None:
            raise FileNotFoundError()
        return Path(path) / 'rfb.sock'

    async def connect_worker(key, expected=None):
        path = worker_display(key)
        if expected is not None:
            if socket_identity(path.lstat()) != expected:
                raise ConnectionRefusedError()
            if connect is connect_display:
                return await connect_display(path, expected)
        return await connect(path)

    def desktop(request):
        key = request.match_info['key']
        if not KEY.fullmatch(key) or request.query_string:
            raise web.HTTPNotFound()
        owners = request.headers.getall('X-Manual-Owner', [])
        if len(owners) != 1 or not OWNER.fullmatch(owners[0]):
            raise web.HTTPForbidden()
        return owners[0], key

    def entry_for(owner, key):
        data = journal.read()
        if any(other != owner and entry['key'] == key for other, entry in data.items()):
            raise web.HTTPForbidden()
        return data.get(owner)

    def on_contention(owner, key, action):
        entry = entry_for(owner, key)
        if entry and entry['key'] != key:
            raise WorkspaceLocked()
        if entry and entry['phase'] == 'stopping' and action != 'stop':
            raise web.HTTPConflict()

    async def stopped(key):
        return (await inspect_unit(key) == 'idle' and
                not await desktop_ready(key, connect_worker))

    async def release_previous(owner, key):
        entry = entry_for(owner, key)
        if entry and entry['key'] != key:
            # An interrupted start may not yet have reached systemd. Keep its reservation
            # until its owner retries that record or explicitly stops it.
            if entry['phase'] == 'starting':
                if await desktop_ready(entry['key'], connect_worker):
                    journal.set(owner, entry['key'], 'tracking')
                raise WorkspaceLocked()
            if not await stopped(entry['key']):
                raise WorkspaceLocked()
            journal.set(owner, entry['key'], None)
            await clear_session(entry['key'])
        return entry if entry and entry['key'] == key else None

    async def await_ready(key):
        deadline = asyncio.get_running_loop().time() + startup_seconds
        while not await desktop_ready(key, connect_worker):
            if await inspect_unit(key) == 'idle':
                return False
            if asyncio.get_running_loop().time() >= deadline:
                raise web.HTTPServiceUnavailable()
            await asyncio.sleep(0.25)
        return True

    async def admission_state(key):
        # Untracked units and earlier unresolved commands block new starts.
        active = await inventory()
        bindings = journal.read()
        tracked = {value['key'] for value in bindings.values()}
        unresolved = {value['key'] for value in bindings.values() if value['phase'] == 'starting'}
        if active is None or active - tracked or unresolved - active - {key}:
            raise web.HTTPServiceUnavailable()
        return await inspect_unit(key)

    def renewal_marker(key):
        # Stored beside the host's ownership journal and never mounted inside a worker.
        return journal.root / ('renewal-display-%064x' % int(key[len('manual-v1-'):], 16))

    async def clear_session(key):
        renewal_marker(key).unlink(missing_ok=True)
        session = prepared.pop(key, None)
        if session:
            await session['relay'].close()

    def current_session(key):
        session = prepared.get(key)
        with contextlib.suppress(OSError):
            if session and session['display'] == socket_identity(worker_display(key).lstat()):
                return session
        return None

    def require_session(key, mode):
        session = current_session(key)
        if not session or session['mode'] != mode:
            raise web.HTTPConflict()
        return session

    async def recharge_status(request):
        if request.query_string or not await recharge_enabled():
            raise web.HTTPServiceUnavailable()
        return web.json_response({'rechargeBootstrap': 1})

    async def recharge_enabled():
        return recharge is not None and activate and admit and stop and await recharge_available()

    async def renewal_enabled():
        return (await recharge_enabled() and recharge.fd is not None and bool(recharge.blocked_networks) and
                callable(getattr(egress, 'open_renewal_relay', None)))

    async def renewal_status(request):
        if request.query_string or not await renewal_enabled():
            raise web.HTTPServiceUnavailable()
        return web.json_response({'renewalWorkspace': 1})

    async def recharge_workspace_status(request):
        owner, key = desktop(request)
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'stream')):
            entry = entry_for(owner, key)
            if entry and entry['key'] != key:
                raise WorkspaceLocked()
            if not entry or entry['phase'] != 'tracking':
                raise web.HTTPConflict()
            session = require_session(key, 'recharge')
            return web.json_response(session['result'])

    async def prepare_recharge(request):
        owner, key = desktop(request)
        if not await recharge_enabled():
            raise web.HTTPServiceUnavailable()
        config = await read_recharge_config(request)
        selected_input = json.dumps([config['email'], config['proxyUrl']], separators=(',', ':')).encode()
        selection = hmac.digest(selection_key, selected_input, 'sha256')
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'open')):
            entry = await release_previous(owner, key)
            session = current_session(key)
            if session and entry and entry['phase'] == 'tracking':
                if session['mode'] != 'recharge':
                    raise web.HTTPConflict()
                if (session['selection'] != selection or (config['expectedCountry']
                        and session['result']['country'] != config['expectedCountry'])):
                    raise web.HTTPConflict()
                return web.json_response(session['result'])

            result = await start_managed(owner, key, 'recharge', config, selection)
        return web.json_response(result)

    async def start_managed(owner, key, mode, config, selection=None):
        async with journal.lock('admission', startup_seconds + 5):
            state = await admission_state(key)
            if state == 'unknown':
                raise web.HTTPServiceUnavailable()
            if state != 'idle' or await desktop_ready(key, connect_worker):
                raise web.HTTPConflict()
            if not await admit():
                raise web.HTTPTooManyRequests()
            await clear_session(key)
            try:
                directory = recharge.workspace(key)
                if mode == 'renewal':
                    relay = await recharge.renewal_relay(directory)
                else:
                    config = {**config, 'proxyUrl': materialize_proxy_session(config['proxyUrl'])}
                    relay = await recharge.relay(directory, config['proxyUrl'])
            except EgressError:
                if mode == 'renewal':
                    raise web.HTTPServiceUnavailable() from None
                raise web.HTTPUnprocessableEntity() from None
            except OSError:
                raise web.HTTPServiceUnavailable() from None
            session = {'mode': mode, 'relay': relay}
            launched = False
            try:
                if mode == 'renewal':
                    session['egress'] = directory / EGRESS_SOCKET
                    session['egress_identity'] = socket_identity(session['egress'].lstat())
                async with recharge.bootstrap(directory, config) as receipt:
                    journal.set(owner, key, 'starting')
                    launched = True
                    if await activate(key) is not True:
                        raise web.HTTPServiceUnavailable()
                    result = await asyncio.wait_for(asyncio.shield(receipt), startup_seconds)
                    if result is None:
                        if mode == 'renewal':
                            raise web.HTTPServiceUnavailable()
                        raise web.HTTPUnprocessableEntity()
                    if not await await_ready(key):
                        raise web.HTTPServiceUnavailable()
                    display = socket_identity(worker_display(key).lstat())
                if mode == 'renewal':
                    fd = os.open(renewal_marker(key), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    with os.fdopen(fd, 'wb') as marker:
                        marker.write(('%d:%d' % display).encode('ascii'))
                        marker.flush()
                        os.fsync(marker.fileno())
                journal.set(owner, key, 'tracking')
                session.update(display=display, selection=selection, result=result)
                prepared[key] = session
                return result
            except BaseException as error:
                await relay.close()
                if launched:
                    journal.set(owner, key, 'stopping')
                    if not await stop(key) or not await stopped(key):
                        raise web.HTTPServiceUnavailable() from None
                    journal.set(owner, key, None)
                if isinstance(error, (OSError, asyncio.TimeoutError)):
                    raise web.HTTPServiceUnavailable() from None
                raise

    async def reap_sessions():
        while True:
            await asyncio.sleep(5)
            for key, session in tuple(prepared.items()):
                if current_session(key) is None and prepared.get(key) is session:
                    await clear_session(key)

    async def manage_recharge(_app):
        with recharge.exclusive():
            reaper = asyncio.create_task(reap_sessions())
            try:
                yield
            finally:
                reaper.cancel()
                await asyncio.gather(reaper, return_exceptions=True)
                await asyncio.gather(*(session['relay'].close() for session in prepared.values()))

    if recharge is not None:
        app.cleanup_ctx.append(manage_recharge)

    async def reconnect_renewal(key):
        if key in prepared:
            session = require_session(key, 'renewal')
            try:
                if socket_identity(session['egress'].lstat()) != session['egress_identity']:
                    raise web.HTTPServiceUnavailable()
            except OSError:
                raise web.HTTPServiceUnavailable() from None
            return
        # The broker's relay listener closes on restart while Chromium keeps its
        # desktop. Rebind the same private path only for this exact live display.
        try:
            display = socket_identity(worker_display(key).lstat())
            if renewal_marker(key).read_bytes() != ('%d:%d' % display).encode('ascii'):
                raise web.HTTPConflict()
            directory = recharge.workspace(key)
            relay = await recharge.renewal_relay(directory)
        except FileNotFoundError:
            raise web.HTTPConflict() from None
        except (OSError, EgressError):
            raise web.HTTPServiceUnavailable() from None
        try:
            path = directory / EGRESS_SOCKET
            prepared[key] = {'mode': 'renewal', 'display': display, 'relay': relay,
                             'egress': path, 'egress_identity': socket_identity(path.lstat())}
        except OSError:
            await relay.close()
            raise web.HTTPServiceUnavailable() from None

    async def open_workspace(request):
        owner, key = desktop(request)
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'open')):
            entry = await release_previous(owner, key)
            if entry and entry['phase'] == 'stopping':
                if not await stopped(key):
                    raise web.HTTPConflict()
                journal.set(owner, key, None)
                entry = None
            if entry and await desktop_ready(key, connect_worker):
                if recharge is not None:
                    await reconnect_renewal(key)
                journal.set(owner, key, 'tracking')
                return web.Response(status=204)
            if recharge is not None:
                if not await renewal_enabled():
                    raise web.HTTPServiceUnavailable()
                await start_managed(owner, key, 'renewal', {'mode': 'renewal'})
                return web.Response(status=204)
            if not activate or not admit:
                raise web.HTTPServiceUnavailable()
            async with journal.lock('admission', startup_seconds + 5):
                state = await admission_state(key)
                if state == 'unknown' or (not entry and (state != 'idle' or await desktop_ready(key, connect_worker))):
                    raise web.HTTPServiceUnavailable()
                if state == 'idle':
                    if not await admit():
                        raise web.HTTPTooManyRequests()
                    journal.set(owner, key, 'starting')
                    launched = await activate(key)
                    if launched is not True:
                        if launched is False and await stopped(key):
                            journal.set(owner, key, None)
                        raise web.HTTPServiceUnavailable()
                journal.set(owner, key, 'tracking')
                if not await await_ready(key):
                    journal.set(owner, key, None)
                    raise web.HTTPServiceUnavailable()
        return web.Response(status=204)

    async def finish_stop(owner, key):
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'stop')):
            entry = entry_for(owner, key)
            if entry and entry['key'] != key:
                raise WorkspaceLocked()
            if not entry:
                if await stopped(key):
                    return
                raise web.HTTPServiceUnavailable()
            if entry['phase'] != 'starting' and await stopped(key):
                journal.set(owner, key, None)
                await clear_session(key)
                return
            if not stop:
                raise web.HTTPServiceUnavailable()
            journal.set(owner, key, 'stopping')
            await clear_session(key)
            if not await stop(key) or not await stopped(key):
                raise web.HTTPServiceUnavailable()
            journal.set(owner, key, None)

    async def stop_workspace(request):
        identity = desktop(request)
        if identity not in stops:
            task = asyncio.create_task(finish_stop(*identity))
            stops[identity] = task
            task.add_done_callback(lambda _: stops.pop(identity, None))
        await asyncio.shield(stops[identity])
        return web.Response(status=204)

    async def asset(request):
        name = request.match_info['asset']
        if len(name) > MAX_ASSET_PATH or request.query_string:
            raise web.HTTPNotFound()
        path = assets.get(name)
        if path is None:
            raise web.HTTPNotFound()
        response = web.FileResponse(path)
        response.content_type = 'application/javascript'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    async def recharge_stream(request):
        return await stream(request, recharge_only=True)

    async def stream(request, recharge_only=False):
        owner, key = desktop(request)
        ws = web.WebSocketResponse(protocols=('binary',), compress=False, max_msg_size=1024 * 1024)
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'stream')):
            entry = entry_for(owner, key)
            if entry and entry['key'] != key:
                raise WorkspaceLocked()
            if not entry or entry['phase'] != 'tracking':
                raise web.HTTPConflict()
            if not ws.can_prepare(request).ok:
                raise web.HTTPBadRequest()
            expected = None
            if recharge_only or recharge is not None:
                expected = require_session(key, 'recharge' if recharge_only else 'renewal')['display']
            try:
                reader, writer = await asyncio.wait_for(connect_worker(key, expected), 2)
            except (OSError, asyncio.TimeoutError):
                raise web.HTTPServiceUnavailable()

        async def receive():
            async for msg in ws:
                if msg.type != WSMsgType.BINARY:
                    await ws.close(code=1003)
                    break
                writer.write(msg.data)
                await writer.drain()

        async def send():
            while True:
                block = await reader.read(65536)
                if not block:
                    return
                await ws.send_bytes(block)

        pumps = set()
        try:
            try:
                version = await asyncio.wait_for(reader.readexactly(12), 2)
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
                raise web.HTTPServiceUnavailable()
            if not RFB_VERSION.fullmatch(version):
                raise web.HTTPServiceUnavailable()
            await ws.prepare(request)
            await ws.send_bytes(version)
            pumps = {asyncio.create_task(receive()), asyncio.create_task(send())}
            await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in pumps:
                task.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
            if ws.prepared:
                await ws.close()
        return ws

    app.router.add_post('/v1/workspaces/{key}/open', open_workspace)
    app.router.add_post('/v1/workspaces/{key}/stop', stop_workspace)
    app.router.add_get('/v1/workspaces/{key}/stream', stream, allow_head=False)
    app.router.add_get('/v1/renewal/status', renewal_status, allow_head=False)
    app.router.add_get('/v1/recharge/status', recharge_status, allow_head=False)
    app.router.add_post('/v1/workspaces/{key}/prepare', prepare_recharge)
    app.router.add_get('/v1/workspaces/{key}/recharge-status', recharge_workspace_status, allow_head=False)
    app.router.add_get('/v1/workspaces/{key}/recharge-stream', recharge_stream, allow_head=False)
    app.router.add_get('/v1/client/{asset:.*}', asset)
    return app


@contextlib.contextmanager
def broker_listener(path):
    """Recover this private endpoint after a crash without replacing a live listener."""
    lock_fd = os.open(path.parent / ('.' + path.name + '.lock'),
                      os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    try:
        lock_info = os.fstat(lock_fd)
        if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid()
                or stat.S_IMODE(lock_info.st_mode) != 0o600):
            raise RuntimeError('Invalid broker socket lock')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous_binding = os.pread(lock_fd, 128, 0)
        try:
            previous = path.lstat()
        except FileNotFoundError:
            previous = None
        if previous is not None:
            if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.geteuid():
                raise RuntimeError('Broker socket path belongs to another object')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    if previous_binding != f'{previous.st_dev}:{previous.st_ino}'.encode('ascii'):
                        raise RuntimeError('Stale socket was not created by this broker')
                    current = path.lstat()
                    if (previous.st_dev, previous.st_ino) != (current.st_dev, current.st_ino):
                        raise RuntimeError('Broker socket was replaced during startup')
                    path.unlink()
                else:
                    raise RuntimeError('Broker socket already has a listener')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            previous_mask = os.umask(0o117)
            try:
                listener.bind(str(path))
            finally:
                os.umask(previous_mask)
            bound = path.lstat()
            try:
                binding = f'{bound.st_dev}:{bound.st_ino}'.encode('ascii')
                os.ftruncate(lock_fd, 0)
                os.pwrite(lock_fd, binding, 0)
                os.fsync(lock_fd)
                os.chmod(path, 0o660)
                yield listener
            finally:
                with contextlib.suppress(FileNotFoundError):
                    current = path.lstat()
                    if (bound.st_dev, bound.st_ino) == (current.st_dev, current.st_ino):
                        path.unlink()
                os.ftruncate(lock_fd, 0)
                os.fsync(lock_fd)
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True, type=Path)
    parser.add_argument('--workers', required=True, type=Path)
    parser.add_argument('--claims', required=True, type=Path, help='Private persistent broker state directory (0700)')
    parser.add_argument('--assets', default='/usr/share/novnc', type=Path)
    parser.add_argument('--start-units', action='store_true', help='Activate installed isolated worker units')
    parser.add_argument('--recharge-input', type=Path, help='Existing private broker-owned recharge input root (0700)')
    parser.add_argument('--recharge-block-network', action='append', default=[],
                        help='Additional host or business network to block from recharge worker egress')
    parser.add_argument('--max-active', type=int, help='Measured host limit for concurrent desktop units')
    parser.add_argument('--min-available-mib', type=int, help='Required MemAvailable before a cold start')
    args = parser.parse_args()
    if not hasattr(os, 'O_PATH') or not Path('/proc/self/fd').is_dir():
        parser.error('The desktop broker requires Linux with procfs')
    if not all(path.is_absolute() for path in (args.socket, args.workers, args.claims)):
        parser.error('The socket and worker directory must use absolute paths')
    if args.start_units and (not args.max_active or args.max_active < 1 or
                             not args.min_available_mib or args.min_available_mib < 1):
        parser.error('Cold starts require measured concurrency and available-memory limits')
    if (args.claims.resolve() == args.workers.resolve() or args.claims.resolve().is_relative_to(args.workers.resolve())
            or args.claims.resolve() == args.socket.parent.resolve()):
        parser.error('Claims require a separate broker-owned directory outside all worker mounts')
    parent = args.socket.parent.stat()
    if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        parser.error('The broker must own its private socket directory')
    recharge = None
    if args.recharge_input:
        if not args.start_units or not args.recharge_input.is_absolute():
            parser.error('Recharge preparation requires --start-units and an absolute --recharge-input')
        roots = (args.workers.resolve(), args.claims.resolve(), args.socket.parent.resolve())
        incoming = args.recharge_input.resolve()
        if any(incoming.is_relative_to(root) or root.is_relative_to(incoming) for root in roots):
            parser.error('Recharge input must be separate from socket, claim and mutable worker directories')
        try:
            recharge = RechargeInputs(args.recharge_input, args.recharge_block_network)
            recharge.check()
        except (OSError, ValueError):
            parser.error('Invalid recharge input directory or blocked network')
    elif args.recharge_block_network:
        parser.error('Recharge blocked networks require --recharge-input')

    async def admit():
        return await host_has_capacity(args.max_active, args.min_available_mib)

    app = create_app(args.workers, args.assets, start_unit if args.start_units else None, admit,
                     stop=stop_unit if args.start_units else None, claims=args.claims, recharge=recharge)
    with broker_listener(args.socket) as listener:
        web.run_app(app, sock=listener, print=None, access_log=None)


if __name__ == '__main__':
    main()
