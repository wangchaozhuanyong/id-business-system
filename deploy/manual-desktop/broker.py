"""Private Unix-socket bridge between the authenticated website and isolated desktops."""

import argparse
import asyncio
import contextlib
from contextvars import ContextVar
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import stat
import tempfile

from aiohttp import WSMsgType, web


SYSTEMCTL = "/usr/bin/systemctl"
CLAIM_LOCKS = ContextVar("claim_locks", default=())
KEY = re.compile(r"manual-v1-[0-9a-f]{64}")
OWNER = re.compile(r"owner-v1-[0-9a-f]{64}")
ASSET = re.compile(r"(?:core|vendor)/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.js")
RFB_VERSION = re.compile(rb"RFB 003\.00[378]\n")


async def connect_display(path):
    # Linux O_PATH pins the actual socket in the assigned directory. A worker
    # cannot substitute a symlink to a neighbouring display during connection.
    directory = os.open(path.parent, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        fd = os.open(path.name, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
        try:
            if not stat.S_ISSOCK(os.fstat(fd).st_mode):
                raise ConnectionRefusedError()
            return await asyncio.open_unix_connection('/proc/self/fd/' + str(fd))
        finally:
            os.close(fd)
    finally:
        os.close(directory)


async def desktop_ready(path, connect):
    try:
        reader, writer = await asyncio.wait_for(connect(path), 1)
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
        fd = os.open(self.root / (name + '.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
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


def create_app(workers, assets, activate=None, admit=None, startup_seconds=30, connect=connect_display, stop=None,
               *, claims, inspect_unit=unit_state, inventory=running_units):
    app = web.Application(client_max_size=1024)
    assets = Path(assets).resolve(strict=True)
    journal = Claims(claims)
    stops = {}

    def desktop(request):
        key = request.match_info['key']
        if not KEY.fullmatch(key) or request.query_string:
            raise web.HTTPNotFound()
        owners = request.headers.getall('X-Manual-Owner', [])
        if len(owners) != 1 or not OWNER.fullmatch(owners[0]):
            raise web.HTTPForbidden()
        return owners[0], key, Path(workers) / key / 'rfb.sock'

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
                not await desktop_ready(Path(workers) / key / 'rfb.sock', connect))

    async def release_previous(owner, key):
        entry = entry_for(owner, key)
        if entry and entry['key'] != key:
            # An interrupted start may not yet have reached systemd. Keep its reservation
            # until its owner retries that record or explicitly stops it.
            if entry['phase'] == 'starting':
                if await desktop_ready(Path(workers) / entry['key'] / 'rfb.sock', connect):
                    journal.set(owner, entry['key'], 'tracking')
                raise WorkspaceLocked()
            if not await stopped(entry['key']):
                raise WorkspaceLocked()
            journal.set(owner, entry['key'], None)
        return entry if entry and entry['key'] == key else None

    async def await_ready(key, path):
        deadline = asyncio.get_running_loop().time() + startup_seconds
        while not await desktop_ready(path, connect):
            if await inspect_unit(key) == 'idle':
                return False
            if asyncio.get_running_loop().time() >= deadline:
                raise web.HTTPServiceUnavailable()
            await asyncio.sleep(0.25)
        return True

    async def open_workspace(request):
        owner, key, path = desktop(request)
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'open')):
            entry = await release_previous(owner, key)
            if entry and entry['phase'] == 'stopping':
                if not await stopped(key):
                    raise web.HTTPConflict()
                journal.set(owner, key, None)
                entry = None
            if entry and await desktop_ready(path, connect):
                journal.set(owner, key, 'tracking')
                return web.Response(status=204)
            if not activate or not admit:
                raise web.HTTPServiceUnavailable()
            async with journal.lock('admission', startup_seconds + 5):
                # A prestarted unit with no trusted binding has an unknown owner.
                # New starts must wait until the host reconciles it.
                active = await inventory()
                bindings = journal.read()
                tracked = {value['key'] for value in bindings.values()}
                # An interrupted command could still start a unit after the host count.
                unresolved = {value['key'] for value in bindings.values() if value['phase'] == 'starting'}
                if active is None or active - tracked or unresolved - active - {key}:
                    raise web.HTTPServiceUnavailable()
                state = await inspect_unit(key)
                if state == 'unknown' or (not entry and (state != 'idle' or await desktop_ready(path, connect))):
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
                if not await await_ready(key, path):
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
                return
            if not stop:
                raise web.HTTPServiceUnavailable()
            journal.set(owner, key, 'stopping')
            if not await stop(key) or not await stopped(key):
                raise web.HTTPServiceUnavailable()
            journal.set(owner, key, None)

    async def stop_workspace(request):
        identity = desktop(request)[:2]
        if identity not in stops:
            task = asyncio.create_task(finish_stop(*identity))
            stops[identity] = task
            task.add_done_callback(lambda _: stops.pop(identity, None))
        await asyncio.shield(stops[identity])
        return web.Response(status=204)

    async def asset(request):
        name = request.match_info['asset']
        if not ASSET.fullmatch(name) or request.query_string:
            raise web.HTTPNotFound()
        path = (assets / name).resolve()
        if assets not in path.parents or not path.is_file():
            raise web.HTTPNotFound()
        response = web.FileResponse(path)
        response.content_type = 'application/javascript'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    async def stream(request):
        owner, key, path = desktop(request)
        ws = web.WebSocketResponse(protocols=('binary',), compress=False, max_msg_size=1024 * 1024)
        async with journal.lock(owner, startup_seconds + 5, lambda: on_contention(owner, key, 'stream')):
            entry = entry_for(owner, key)
            if entry and entry['key'] != key:
                raise WorkspaceLocked()
            if not entry or entry['phase'] != 'tracking':
                raise web.HTTPConflict()
            if not ws.can_prepare(request).ok:
                raise web.HTTPBadRequest()
            try:
                reader, writer = await asyncio.wait_for(connect(path), 2)
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
    async def admit():
        return await host_has_capacity(args.max_active, args.min_available_mib)

    app = create_app(args.workers, args.assets, start_unit if args.start_units else None, admit,
                     stop=stop_unit if args.start_units else None, claims=args.claims)
    with broker_listener(args.socket) as listener:
        web.run_app(app, sock=listener, print=None, access_log=None)


if __name__ == '__main__':
    main()
