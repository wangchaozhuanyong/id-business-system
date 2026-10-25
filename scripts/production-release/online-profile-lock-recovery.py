"""Offline recovery of Chromium singletons on the dedicated local Docker volume.

Called only between the fenced executor stop and start, under .deploy.lock.
Never infer that a foreign container is dead from a PID in our own namespace.
No browser data, socket target, container or process is deleted or terminated.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

RUNTIME = '/workspace/engine/runtime'
NAMES = ('SingletonLock', 'SingletonCookie', 'SingletonSocket')
HEX = re.compile(r'[a-f0-9]{64}\Z')


class Rejected(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise Rejected('ONLINE_CHECKOUT_PROFILE_' + code)


def locked(lock):
    """Check the stable deploy-lock inode without acquiring a substitute lock."""
    file = Path(lock.name)
    need(file.name == '.deploy.lock' and not file.is_symlink(), 'RELEASE_LOCK_REQUIRED')
    current = os.fstat(lock.fileno())
    observed = file.stat()
    need(stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) ==
         (observed.st_dev, observed.st_ino), 'RELEASE_LOCK_REQUIRED')
    with file.open('a') as probe:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    need(False, 'RELEASE_LOCK_REQUIRED')


def stopped(container):
    state = container['State']
    return (state.get('Status') in ('exited', 'created') and state.get('Running') is False
            and state.get('Pid') == 0 and not state.get('Paused') and not state.get('Restarting'))


def inventory(d, container_id):
    """Docker host, local volume and every potential container writer are checked."""
    local_endpoints = ('unix:///var/run/docker.sock', 'unix:///run/docker.sock')
    contexts = json.loads(d.run('docker', 'context', 'inspect', timeout=5))
    need(not os.environ.get('DOCKER_TLS_VERIFY') and
         os.environ.get('DOCKER_HOST', '') in ('', *local_endpoints) and len(contexts) == 1 and
         contexts[0]['Endpoints']['docker'].get('Host') in local_endpoints and
         not contexts[0]['Endpoints']['docker'].get('SkipTLSVerify'), 'DAEMON_NOT_LOCAL')
    need(HEX.fullmatch(container_id or ''), 'CONTAINER_INVALID')
    owner = json.loads(d.run('docker', 'inspect', container_id, timeout=5))[0]
    labels = owner.get('Config', {}).get('Labels') or {}
    need(owner['Id'] == container_id and stopped(owner), 'EXECUTOR_NOT_STOPPED')
    need(labels.get('com.docker.compose.service') == 'online-recharge' and
         labels.get('com.docker.compose.project'), 'SERVICE_INVALID')
    env = owner['Config'].get('Env') or []
    need(all(not item.startswith('ONLINE_RECHARGE_RUNTIME_DIR=') or
             item == 'ONLINE_RECHARGE_RUNTIME_DIR=' + RUNTIME for item in env), 'CUSTOM_ROOT_UNSUPPORTED')
    need(all(not item.startswith('ONLINE_RECHARGE_PROFILE_ROOT=') or
             item in ('ONLINE_RECHARGE_PROFILE_ROOT=', 'ONLINE_RECHARGE_PROFILE_ROOT=' + RUNTIME + '/browser-profiles')
             for item in env), 'CUSTOM_ROOT_UNSUPPORTED')
    mounts = [m for m in owner['Mounts'] if m.get('Destination') == RUNTIME]
    need(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('RW') is True,
         'VOLUME_INVALID')
    mount = mounts[0]
    volume = json.loads(d.run('docker', 'volume', 'inspect', mount['Name'], timeout=5))[0]
    need(volume.get('Name') == mount['Name'] and volume.get('Driver') == 'local' and
         volume.get('Scope') == 'local' and not volume.get('Options') and
         volume.get('Mountpoint') == mount['Source'], 'VOLUME_NOT_LOCAL')
    need((volume.get('Labels') or {}).get('com.docker.compose.volume') == 'online_recharge_data' and
         volume['Labels'].get('com.docker.compose.project') == labels['com.docker.compose.project'],
         'VOLUME_IDENTITY_INVALID')
    source = Path(mount['Source'])
    need(source.is_absolute() and source.resolve(strict=True) == source and source.is_dir(),
         'VOLUME_PATH_INVALID')
    ids = d.run('docker', 'ps', '-aq', '--no-trunc', timeout=5).split()
    need(container_id in ids and all(HEX.fullmatch(item) for item in ids), 'INVENTORY_INVALID')
    containers = json.loads(d.run('docker', 'inspect', *ids, timeout=5))
    need({c['Id'] for c in containers} == set(ids) and len(containers) == len(ids), 'INVENTORY_INVALID')
    users = []
    for item in containers:
        related = False
        for other in item.get('Mounts', []):
            if other.get('Type') not in ('bind', 'volume') or not other.get('Source'):
                continue
            origin = Path(other['Source'])
            overlaps = origin == source or origin in source.parents or source in origin.parents
            if other.get('Name') == mount['Name'] or overlaps:
                related = True
                need(stopped(item), 'VOLUME_IN_USE')
        if related:
            service = (item.get('Config', {}).get('Labels') or {}).get('com.docker.compose.service')
            need(service in ('online-recharge', 'api') and (item['Config'].get('Labels') or {}).get('com.docker.compose.project') ==
                 labels['com.docker.compose.project'], 'VOLUME_SHARED')
            if service == 'online-recharge':
                users.append((item['Id'], item['Config']['Hostname']))
    # Docker may reorder the same mount entries between inspect calls.
    # Preserve every field while comparing the mount set in a stable order.
    need(all(isinstance(c.get('Mounts'), list) for c in containers), 'INVENTORY_INVALID')
    stamp = sorted((c['Id'], c['Config']['Hostname'], stopped(c), c['State'].get('Pid'),
                    json.dumps(sorted(c['Mounts'], key=lambda mount: json.dumps(mount, sort_keys=True)),
                               sort_keys=True)) for c in containers)
    return source, tuple(sorted(users)), tuple(stamp)


def no_browser_writers(directories):
    """Read host /proc, not the new container's PID namespace. Do not signal PIDs."""
    proc = Path('/proc')
    need(proc.is_dir() and (proc / 'self' / 'cmdline').is_file(), 'HOST_PROC_UNAVAILABLE')
    targets = {str(directory) for directory in directories}
    targets.update(RUNTIME + '/browser-profiles/' + directory.name for directory in directories)
    targets.update('/app/.runtime/online-recharge/browser-profiles/' + directory.name for directory in directories)
    deadline = time.monotonic() + 5
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        need(time.monotonic() < deadline, 'PROCESS_INSPECTION_TIMEOUT')
        try:
            args = (process / 'cmdline').read_bytes().split(b'\0')
        except FileNotFoundError:
            continue
        for index, raw in enumerate(args):
            arg = os.fsdecode(raw)
            value = (os.fsdecode(args[index + 1]) if arg == '--user-data-dir' and index + 1 < len(args)
                     else arg.removeprefix('--user-data-dir=') if arg.startswith('--user-data-dir=') else None)
            if value:
                absolute = Path(value) if os.path.isabs(value) else process / 'cwd' / value
                need(str(absolute.resolve()) not in targets, 'BROWSER_STILL_RUNNING')


def entries(fd):
    result = {}
    for name in NAMES:
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        need(stat.S_ISLNK(info.st_mode), 'SINGLETON_TYPE_INVALID')
        target = os.readlink(name, dir_fd=fd)
        need(0 < len(target) <= 4096, 'SINGLETON_INVALID')
        result[name] = (info.st_dev, info.st_ino, info.st_ctime_ns, target)
    return result


def owner_retired(target, users, stamp):
    match = re.fullmatch(r'([A-Za-z0-9_.-]{1,253})-([1-9][0-9]{0,9})', target)
    need(match and 1 < int(match[2]) < 2**31, 'LOCK_OWNER_UNKNOWN')
    host = match[1]
    # Explicit stopped executor hostname, or a default Docker ID no longer present.
    # Custom/remote hostnames cannot be proved retired by this local Docker engine.
    if host in {hostname for _, hostname in users}:
        need(all(is_stopped for _, hostname, is_stopped, _, _ in stamp if hostname == host),
             'LOCK_OWNER_ACTIVE')
        return
    need(re.fullmatch('[a-f0-9]{12}', host), 'LOCK_OWNER_UNKNOWN')
    matches = [row for row in stamp if row[0].startswith(host) or row[1] == host]
    need(not matches, 'LOCK_OWNER_UNKNOWN')


def quarantine(fd, snapshot):
    """Move only exact, re-read symlinks; preserve every native profile data file."""
    need(entries(fd) == snapshot, 'SINGLETON_CHANGED')
    try:
        os.mkdir('.retired-singletons', 0o700, dir_fd=fd)
    except FileExistsError:
        pass
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open('.retired-singletons', flags, dir_fd=fd)
    try:
        need(os.fstat(parent).st_mode & 0o077 == 0, 'ARCHIVE_PERMISSIONS_INVALID')
        name = secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=parent)
        archive = os.open(name, flags, dir_fd=parent)
        moved = []
        try:
            for item in NAMES:
                if item not in snapshot:
                    continue
                # A change, including a new inode with identical contents, closes the path.
                need(entries(fd).get(item) == snapshot[item], 'SINGLETON_CHANGED')
                os.rename(item, item, src_dir_fd=fd, dst_dir_fd=archive)
                moved.append(item)
        except BaseException:
            for item in reversed(moved):
                # Restore only into a vacant source slot. Never overwrite a changed lock.
                try:
                    os.stat(item, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    os.rename(item, item, src_dir_fd=archive, dst_dir_fd=fd)
            raise
        finally:
            os.close(archive)
    finally:
        os.close(parent)
    return len(moved)


def recover(d, container_id, lock):
    """Run inside the publisher's idle fence, after stop and before any restart."""
    opened = []
    try:
        locked(lock)
        baseline = inventory(d, container_id)
        source, users, stamp = baseline
        root = source / 'browser-profiles'
        receipt = {'version': 1, 'profilesExamined': 0, 'profilesRecovered': 0,
                   'lockEntriesArchived': 0, 'profileDataModified': False}
        if not root.exists() and not root.is_symlink():
            return receipt
        need(root.resolve(strict=True) == root and root.is_dir() and
             root.stat().st_mode & 0o077 == 0, 'ROOT_INVALID')
        directories = []
        for directory in root.iterdir():
            if not HEX.fullmatch(directory.name):
                continue
            info = directory.lstat()
            need(stat.S_ISDIR(info.st_mode) and info.st_mode & 0o077 == 0, 'DIRECTORY_INVALID')
            directories.append(directory)
        need(len(directories) <= 4096, 'PROFILE_COUNT_EXCEEDED')
        no_browser_writers(directories)
        plans = []
        for directory in sorted(directories):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            opened.append(fd)
            receipt['profilesExamined'] += 1
            snapshot = entries(fd)
            if 'SingletonLock' in snapshot:
                owner_retired(snapshot['SingletonLock'][3], users, stamp)
                plans.append((fd, snapshot))
        # Read-only preparation of the whole batch precedes any mutation.
        locked(lock)
        need(inventory(d, container_id) == baseline, 'HOST_INVENTORY_CHANGED')
        no_browser_writers(directories)
        need(all(entries(fd) == snapshot for fd, snapshot in plans), 'SINGLETON_CHANGED')
        for fd, snapshot in plans:
            receipt['lockEntriesArchived'] += quarantine(fd, snapshot)
            receipt['profilesRecovered'] += 1
        return receipt
    except Rejected:
        raise
    except Exception:
        # Docker output and paths can contain private configuration: never project them.
        raise RuntimeError('ONLINE_CHECKOUT_PROFILE_RECOVERY_UNCONFIRMED') from None
    finally:
        for fd in opened:
            os.close(fd)
