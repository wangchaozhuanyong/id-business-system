"""Plan or install one reviewed disk timer without replacing unknown files."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

SOURCE_DIRECTORY = Path(__file__).resolve().parent
PROJECT = SOURCE_DIRECTORY.parents[1]
BASE = Path('/opt/id-business-v2')
UNIT_DIRECTORY = Path('/etc/systemd/system')
SERVICE = 'id-business-v2-disk-retention.service'
TIMER = 'id-business-v2-disk-retention.timer'
ROOT_UID = 0
ROOT_GID = 0
HEX = re.compile(r'[a-f0-9]{64}')
CODES = frozenset({'INPUT_INVALID', 'ROOT_REQUIRED', 'SOURCE_INVALID', 'POLICY_INVALID',
    'BASELINE_INVALID', 'STATE_CHANGED', 'TARGET_INVALID', 'UNIT_INVALID', 'SERVICE_BUSY',
    'COMMAND_FAILED', 'PLAN_APPROVAL_REQUIRED', 'PLAN_CHANGED', 'IO_FAILURE'})
SERVICE_PROPERTIES = ('Id', 'Names', 'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState',
    'UnitFileState', 'MainPID', 'ControlPID')
TIMER_PROPERTIES = ('Id', 'Names', 'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState',
    'UnitFileState', 'Triggers')
LEGACY_READY = 'LEGACY_RETENTION_CONFIRMED_READY_TO_RETIRE'
LEGACY_SOURCE_SHA256 = '0ff2fd93f9a9a90d86e04dce0d04459cddf13522e11c0058fbfbc59ecbf64ecf'
LEGACY_KNOWN = frozenset({LEGACY_READY, 'LEGACY_RETENTION_ALREADY_RETIRED',
    'LEGACY_RETENTION_UNITS_ABSENT'})


class Rejected(RuntimeError):
    pass


def need(condition, code):
    if not condition:
        raise Rejected(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def closed(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'POLICY_INVALID')
            result[key] = value
        return result
    def constant(_):
        raise Rejected('POLICY_INVALID')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'mode': stat.S_IMODE(info.st_mode),
        'uid': info.st_uid, 'gid': info.st_gid, 'links': info.st_nlink, 'bytes': info.st_size,
        'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns}


def regular(path, *, mode=None, root=False, limit=2 * 1024 * 1024, code='TARGET_INVALID'):
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), code)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 < before.st_size <= limit, code)
        if root:
            need(before.st_uid == ROOT_UID and before.st_gid == ROOT_GID
                and not before.st_mode & 0o022, code)
        if mode is not None:
            need(stat.S_IMODE(before.st_mode) == mode, code)
        raw = source.read(limit + 1)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(source.fileno()))
            == identity(path.lstat()), code)
    return raw, identity(before)


def directory(path, *, missing=False, exact_mode=None):
    need(path.is_absolute(), 'TARGET_INVALID')
    if not path.exists() and not path.is_symlink():
        need(missing, 'TARGET_INVALID')
        return None
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and path.resolve() == path
        and info.st_uid == ROOT_UID and info.st_gid == ROOT_GID
        and not info.st_mode & 0o022, 'TARGET_INVALID')
    if exact_mode is not None:
        need(stat.S_IMODE(info.st_mode) == exact_mode, 'TARGET_INVALID')
    return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
        'mode': stat.S_IMODE(info.st_mode)}


def command(*arguments, timeout=45):
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=timeout)
    need(result.returncode == 0, 'COMMAND_FAILED')
    need(len(result.stdout.encode()) <= 128 * 1024, 'COMMAND_FAILED')
    return result.stdout.strip()


def snapshot(expected):
    need(type(expected) is str and re.fullmatch('[a-f0-9]{40}', expected), 'INPUT_INVALID')
    directory(BASE)
    directory(BASE / 'releases')
    link = BASE / 'current'
    need(link.is_symlink(), 'BASELINE_INVALID')
    release = link.resolve()
    need(release.parent == BASE / 'releases' and re.fullmatch(
        r'[0-9]{8}T[0-9]{6}Z-' + expected[:12], release.name), 'BASELINE_INVALID')
    directory(release)
    raw, metadata = regular(release / 'release-manifest.json', root=True,
        limit=128 * 1024, code='BASELINE_INVALID')
    value = closed(raw)
    need(type(value) is dict and value.get('commit') == expected, 'BASELINE_INVALID')
    containers = command('docker', 'ps', '-a', '--no-trunc', '--quiet').splitlines()
    need(len(containers) <= 500 and len(containers) == len(set(containers))
        and all(HEX.fullmatch(item) for item in containers), 'BASELINE_INVALID')
    need(link.resolve() == release, 'STATE_CHANGED')
    return {'currentCommit': expected, 'currentDirectory': str(release),
        'manifestSha256': sha(raw), 'manifestIdentity': metadata, 'containerIds': sorted(containers)}


def sources(policy_path):
    source = SOURCE_DIRECTORY / 'disk-retention.py'
    helper = SOURCE_DIRECTORY / 'maintain-image-cache.py'
    candidate_registry = SOURCE_DIRECTORY / 'candidate-retention.py'
    native_raw, unused = regular(source, code='SOURCE_INVALID')
    helper_raw, unused = regular(helper, code='SOURCE_INVALID')
    candidate_raw, unused = regular(candidate_registry, code='SOURCE_INVALID')
    need(policy_path.is_absolute() and policy_path.resolve().is_relative_to(PROJECT.resolve())
        and policy_path.resolve() == policy_path, 'POLICY_INVALID')
    policy_raw, unused = regular(policy_path, limit=128 * 1024, code='POLICY_INVALID')
    policy = closed(policy_raw)
    need(type(policy) is dict and policy.get('approved') is False
        and policy.get('sourceSha256') == sha(native_raw)
        and policy.get('maintainerSha256') == sha(helper_raw)
        and policy.get('candidateRegistrySha256') == sha(candidate_raw), 'POLICY_INVALID')
    namespace = {'__name__': 'disk_retention_install_validation', '__file__': str(source)}
    try:
        exec(compile(native_raw, str(source), 'exec'), namespace)
    except Exception:
        raise Rejected('SOURCE_INVALID') from None
    validate = namespace.get('validate_policy')
    need(callable(validate), 'SOURCE_INVALID')
    try:
        validated = validate(policy)
        need(type(validated) is dict and validated == policy, 'POLICY_INVALID')
    except Exception:
        raise Rejected('POLICY_INVALID') from None
    approved = {**policy, 'approved': True}
    try:
        need(validate(approved) == approved, 'POLICY_INVALID')
    except Exception:
        raise Rejected('POLICY_INVALID') from None
    return native_raw, helper_raw, candidate_raw, canonical(approved) + b'\n', sha(policy_raw)


def units(native_sha):
    destination = BASE / 'maintenance/disk-retention'
    service = ('[Unit]\nDescription=Reviewed ID business disk retention\nAfter=docker.service\n\n'
        '[Service]\nType=oneshot\nUser=root\nGroup=root\nUMask=0077\n'
        'ExecStart=/usr/bin/python3 -B ' + str(destination / 'disk-retention.py')
        + ' --scheduled --config ' + str(destination / 'config.json')
        + ' --expected-source-sha256 ' + native_sha
        + '\nTimeoutStartSec=1500\nNice=10\n')
    timer = ('[Unit]\nDescription=Daily reviewed ID business disk retention\n\n'
        '[Timer]\nOnCalendar=*-*-* 03:15:00 UTC\nRandomizedDelaySec=15m\n'
        'Persistent=true\nUnit=' + SERVICE + '\n\n[Install]\nWantedBy=timers.target\n')
    return service.encode(), timer.encode()


def properties(unit, *, timeout=None):
    names = SERVICE_PROPERTIES if unit == SERVICE else TIMER_PROPERTIES
    arguments = ('systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(names))
    output = command(*arguments) if timeout is None else command(*arguments, timeout=timeout)
    result = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        need(separator and key in names and key not in result, 'UNIT_INVALID')
        result[key] = value
    need(set(result) == set(names) and result['Id'] == unit, 'UNIT_INVALID')
    return result


def unit_state(unit, present, *, timeout=None):
    state = properties(unit) if timeout is None else properties(unit, timeout=timeout)
    need(state['DropInPaths'] == '', 'UNIT_INVALID')
    if state['LoadState'] == 'not-found':
        need(not present and state['FragmentPath'] == '' and state['ActiveState'] == 'inactive'
            and state['SubState'] == 'dead' and state['Names'] in ('', unit), 'UNIT_INVALID')
    else:
        need(present and state['LoadState'] == 'loaded'
            and state['Names'] == unit
            and state['FragmentPath'] == str(UNIT_DIRECTORY / unit)
            and state['UnitFileState'] in ('static', 'disabled', 'enabled', 'enabled-runtime'), 'UNIT_INVALID')
        if unit == SERVICE:
            need((state['ActiveState'], state['SubState']) in {
                ('inactive', 'dead'), ('failed', 'failed'), ('activating', 'start-pre'),
                ('activating', 'start'), ('activating', 'start-post'), ('active', 'running'),
                ('active', 'exited'), ('reloading', 'reload'), ('deactivating', 'stop'),
                ('deactivating', 'stop-sigterm'), ('deactivating', 'stop-sigkill'),
                ('deactivating', 'stop-post'), ('deactivating', 'final-sigterm'),
                ('deactivating', 'final-sigkill'), ('activating', 'auto-restart')}
                and all(re.fullmatch('[0-9]{1,20}', state[field])
                    for field in ('MainPID', 'ControlPID')), 'UNIT_INVALID')
            need(state['ActiveState'] in ('inactive', 'failed') and state['SubState'] in ('dead', 'failed')
                and state['MainPID'] == state['ControlPID'] == '0', 'SERVICE_BUSY')
        else:
            need(state['ActiveState'] in ('active', 'inactive') and state['SubState'] in ('waiting', 'dead')
                and state['Triggers'] == SERVICE, 'UNIT_INVALID')
    return state


def wait_service_idle():
    deadline = time.monotonic() + 15
    while True:
        remaining = deadline - time.monotonic()
        need(remaining > 0, 'SERVICE_BUSY')
        try:
            return unit_state(SERVICE, True, timeout=remaining)
        except Rejected as error:
            if str(error) != 'SERVICE_BUSY':
                raise
            remaining = deadline - time.monotonic()
            need(remaining > 0, 'SERVICE_BUSY')
            time.sleep(min(0.5, remaining))


def target_state(path, raw, mode):
    if not path.exists() and not path.is_symlink():
        return {'exists': False}
    actual, metadata = regular(path, mode=mode, root=True)
    need(actual == raw, 'TARGET_INVALID')
    return {'exists': True, 'sha256': sha(actual), 'identity': metadata}


def load_legacy():
    path = SOURCE_DIRECTORY / 'retire-orphan-retention.py'
    raw, unused = regular(path, code='SOURCE_INVALID')
    need(sha(raw) == LEGACY_SOURCE_SHA256, 'SOURCE_INVALID')
    scope = {'__name__': 'disk_retention_legacy_validation', '__file__': str(path)}
    try:
        exec(compile(raw, str(path), 'exec'), scope)
    except Exception:
        raise Rejected('SOURCE_INVALID') from None
    need(scope.get('SERVICE') == 'id-business-v2-production-retention.service'
        and scope.get('TIMER') == 'id-business-v2-production-retention.timer'
        and callable(scope.get('retire')), 'SOURCE_INVALID')
    return sha(raw), scope['retire']


def legacy_plan():
    source_sha, retire = load_legacy()
    value = {'sourceSha256': source_sha, 'status': 'SKIPPED_UNKNOWN_LEGACY',
        'confirmation': None, 'confirmationSha256': None}
    try:
        confirmation = retire(False)
        if (type(confirmation) is dict and confirmation.get('ok') is True
                and confirmation.get('status') in LEGACY_KNOWN
                and all(type(confirmation.get(field)) is int and confirmation[field] == 0
                    for field in ('timerMutations', 'deletedFiles', 'databaseWrites'))):
            value.update(status=confirmation['status'], confirmation=confirmation,
                confirmationSha256=sha(canonical(confirmation)))
    except Exception:
        pass
    return value, retire


def retire_confirmed_legacy(approved):
    # Only the fixed removed-script/203 failure may be retired. An unknown or
    # changed old unit stays untouched; it never authorizes generic stopping.
    result = {'status': 'SKIPPED_UNKNOWN_LEGACY', 'timerMutations': 0,
        'unitsDeleted': 0, 'failureHistoryReset': False}
    fresh, retire = legacy_plan()
    if fresh != approved:
        return result
    if fresh['status'] != LEGACY_READY:
        return {**result, 'status': fresh['status']}
    value = retire(True)
    need(type(value) is dict and value.get('ok') is True
        and value.get('status') == 'LEGACY_RETENTION_TIMER_RETIRED_FAILURE_HISTORY_PRESERVED'
        and type(value.get('timerMutations')) is int and value['timerMutations'] == 1
        and value.get('unitsDeleted') == 0 and value.get('failureHistoryReset') is False,
        'UNIT_INVALID')
    return value


def plan(expected, policy_path):
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    native, helper, candidate_registry, config, policy_sha = sources(policy_path)
    baseline = snapshot(expected)
    service, timer = units(sha(native))
    destination = BASE / 'maintenance/disk-retention'
    payloads = {destination / 'disk-retention.py': (native, 0o600),
        destination / 'maintain-image-cache.py': (helper, 0o600),
        destination / 'candidate-retention.py': (candidate_registry, 0o600),
        destination / 'config.json': (config, 0o600),
        UNIT_DIRECTORY / SERVICE: (service, 0o644), UNIT_DIRECTORY / TIMER: (timer, 0o644)}
    directories = {str(path): directory(path, missing=optional, exact_mode=mode)
        for path, optional, mode in ((UNIT_DIRECTORY, False, None),
            (BASE / 'maintenance', True, None), (destination, True, 0o700),
            (destination / 'receipts', True, 0o700))}
    if directories[str(BASE / 'maintenance')] is None:
        need(directories[str(destination)] is None and directories[str(destination / 'receipts')] is None,
            'TARGET_INVALID')
    targets = {str(path): {'sha256': sha(raw), 'bytes': len(raw), 'mode': mode,
        'before': target_state(path, raw, mode)} for path, (raw, mode) in payloads.items()}
    states = {unit: unit_state(unit, targets[str(UNIT_DIRECTORY / unit)]['before']['exists'])
        for unit in (SERVICE, TIMER)}
    legacy, unused = legacy_plan()
    need(snapshot(expected) == baseline, 'STATE_CHANGED')
    value = {'kind': 'ID_DISK_RETENTION_INSTALL_PLAN_V1', 'version': 1, 'baseline': baseline,
        'sourcePolicySha256': policy_sha, 'targets': targets, 'directories': directories,
        'unitStates': states, 'legacyRetention': legacy, 'scheduleUtc': '03:15', 'randomizedDelaySeconds': 900,
        'legacyTimerChanged': False, 'websiteServicesChanged': False}
    return value, payloads


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def new_file(path, raw, mode):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as target:
        os.fchmod(target.fileno(), mode)
        target.write(raw)
        target.flush()
        os.fsync(target.fileno())
    sync_directory(path.parent)


def private_receipt(directory_path, value):
    path = directory_path / (str(time.time_ns()) + '.json')
    new_file(path, canonical(value) + b'\n', 0o600)
    return path.name


def install(expected, policy_path, *, apply=False, approved_plan_sha256=None):
    value, payloads = plan(expected, policy_path)
    digest = sha(canonical(value))
    result = {'status': 'PLAN_ONLY', 'planSha256': digest, 'plan': value,
        'mutationAttempted': False, 'filesCreated': [], 'currentUnchanged': True,
        'containersUnchanged': True, 'legacyTimerChanged': False, 'websiteServicesChanged': False}
    if not apply:
        need(approved_plan_sha256 is None, 'INPUT_INVALID')
        return result
    need(type(approved_plan_sha256) is str and HEX.fullmatch(approved_plan_sha256), 'PLAN_APPROVAL_REQUIRED')
    need(approved_plan_sha256 == digest, 'PLAN_CHANGED')
    lock_path = BASE / '.deploy.lock'
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and info.st_gid == ROOT_GID
            and info.st_nlink == 1 and not info.st_mode & 0o022
            and identity(info) == identity(lock_path.lstat()), 'BASELINE_INVALID')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fresh, fresh_payloads = plan(expected, policy_path)
        need(fresh == value and fresh_payloads == payloads, 'PLAN_CHANGED')
        receipt_directory = BASE / 'maintenance/disk-retention/receipts'
        for path in (BASE / 'maintenance', receipt_directory.parent, receipt_directory):
            if not path.exists():
                result['mutationAttempted'] = True
                path.mkdir(mode=0o700)
                sync_directory(path.parent)
            directory(path, exact_mode=0o700 if path != BASE / 'maintenance' else None)
        result['status'] = 'INSTALLING'
        private_receipt(receipt_directory, result)
        try:
            for path, (raw, mode) in payloads.items():
                if not target_state(path, raw, mode)['exists']:
                    result['mutationAttempted'] = True
                    new_file(path, raw, mode)
                    result['filesCreated'].append(str(path))
                target_state(path, raw, mode)
            need(snapshot(expected) == value['baseline'], 'STATE_CHANGED')
            result['mutationAttempted'] = True
            command('systemctl', 'daemon-reload')
            for unit in (SERVICE, TIMER):
                unit_state(unit, True)
            command('systemctl', 'enable', '--now', TIMER)
            timer = unit_state(TIMER, True)
            need(timer['ActiveState'] == 'active' and timer['SubState'] == 'waiting'
                and timer['UnitFileState'] == 'enabled', 'UNIT_INVALID')
            wait_service_idle()
            need(snapshot(expected) == value['baseline'], 'STATE_CHANGED')
            for path, (raw, mode) in payloads.items():
                target_state(path, raw, mode)
            result['legacyRetention'] = retire_confirmed_legacy(value['legacyRetention'])
            result['legacyTimerChanged'] = bool(result['legacyRetention']['timerMutations'])
            need(snapshot(expected) == value['baseline'], 'STATE_CHANGED')
            result.update(status='INSTALLED', timerEnabled=True, sourceSha256=sha(payloads[
                BASE / 'maintenance/disk-retention/disk-retention.py'][0]))
            result['receipt'] = private_receipt(receipt_directory, result)
            return result
        except BaseException as error:
            result.update(status='FAILED_CLOSED', currentUnchanged=None, containersUnchanged=None,
                errorType=type(error).__name__, reason=safe_reason(error))
            try:
                result['receipt'] = private_receipt(receipt_directory, result)
            except Exception:
                result['receiptPersisted'] = False
            raise Rejected(safe_reason(error)) from None
    finally:
        os.close(descriptor)


def safe_reason(error):
    return str(error) if type(error) is Rejected and str(error) in CODES else 'IO_FAILURE'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--policy-json', required=True, type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--approved-plan-sha256')
    args = parser.parse_args()
    try:
        result = install(args.expected_current, args.policy_json.absolute(), apply=args.apply,
            approved_plan_sha256=args.approved_plan_sha256)
        print(json.dumps(result, sort_keys=True))
        return 0
    except BaseException as error:
        print(json.dumps({'status': 'FAILED_CLOSED', 'errorType': type(error).__name__,
            'reason': safe_reason(error), 'rawOutputSuppressed': True}, sort_keys=True))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
