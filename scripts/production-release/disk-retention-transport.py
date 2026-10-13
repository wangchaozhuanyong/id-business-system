"""Maintenance-only OIDC/SSM transport; no application publication or database I/O."""
import argparse
import ast
import base64
import fcntl
import gzip
import hashlib
import importlib.util
import inspect
import json
import lzma
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import time
import zlib
from datetime import datetime, timezone


HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
BASE = Path('/opt/id-business-v2')
INSTALL = BASE / 'maintenance/disk-retention'
INSTANCE = 'i-05836da38606e633c'
REGION = 'ap-northeast-1'
GITHUB_REPOSITORY = 'wangchaozhuanyong/id-business-system'
REPOSITORY = '079740175286.dkr.ecr.ap-northeast-1.amazonaws.com/id-business-v2-release'
SERVICE = 'id-business-v2-disk-retention.service'
TIMER = 'id-business-v2-disk-retention.timer'
POLICY_PATH = 'deploy/aws/disk-retention-policy-20261014.json'
RUNNER_PATHS = ('scripts/production-release/disk-retention.py',
                'scripts/production-release/candidate-retention.py',
                'scripts/production-release/disk-retention-install.py', POLICY_PATH)
CURRENT_PATHS = ('scripts/production-release/maintain-image-cache.py',
                 'scripts/production-release/retire-orphan-retention.py')
PATHS = (*RUNNER_PATHS, *CURRENT_PATHS)
OPERATIONS = ('verify_install', 'install', 'verify_cleanup', 'cleanup')
HEX40 = re.compile(r'[a-f0-9]{40}\Z')
HEX64 = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
POSITIVE = re.compile(r'[1-9][0-9]{0,19}\Z')
MAX_BODY = 2 * 1024**2
MAX_COMMAND = 19500
MAX_STDOUT = 24000
WIRE_KIND = 'ID_DISK_MAINTENANCE_WIRE_V1'


class Rejected(RuntimeError):
    pass


def need(condition, code='MAINTENANCE_INPUT_INVALID'):
    if not condition:
        raise Rejected(code)


def matches(pattern, value):
    return type(value) is str and pattern.fullmatch(value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return sha(canonical(value))


def closed(raw, limit=MAX_BODY):
    need(type(raw) in (str, bytes) and 0 < len(raw.encode() if type(raw) is str else raw) <= limit,
         'MAINTENANCE_JSON_BOUND')
    def unique(items):
        value = {}
        for key, item in items:
            need(key not in value, 'MAINTENANCE_DUPLICATE_FIELD'); value[key] = item
        return value
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: need(False, 'MAINTENANCE_NONFINITE_JSON'))
    except Rejected:
        raise
    except Exception:
        raise Rejected('MAINTENANCE_JSON_INVALID') from None


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def regular(path, limit=MAX_BODY, *, owner=0, mode=None):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path and not path.is_symlink(), 'MAINTENANCE_PATH_INVALID')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == owner
             and before.st_gid == (0 if owner == 0 else os.getegid()) and 0 < before.st_size <= limit,
             'MAINTENANCE_FILE_INVALID')
        if mode is not None:
            need(stat.S_IMODE(before.st_mode) == mode, 'MAINTENANCE_FILE_MODE')
        raw = stream.read(limit + 1)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(stream.fileno()))
             == identity(path.lstat()), 'MAINTENANCE_FILE_CHANGED')
        return raw, before


def command(arguments, *, limit=MAX_BODY, timeout=90):
    child_environment = {**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'}
    process = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             timeout=timeout, env=child_environment)
    need(process.returncode == 0 and len(process.stdout) <= limit, 'MAINTENANCE_COMMAND_FAILED')
    return process.stdout


def snapshot(expected, base=BASE, owner=0):
    need(matches(HEX40, expected), 'MAINTENANCE_CURRENT_INVALID')
    link = base / 'current'
    first = link.lstat()
    need(stat.S_ISLNK(first.st_mode) and first.st_uid == owner, 'MAINTENANCE_CURRENT_INVALID')
    release = link.resolve()
    need(release.parent == base / 'releases' and re.fullmatch(
        r'[0-9]{8}T[0-9]{6}Z-' + expected[:12], release.name), 'MAINTENANCE_CURRENT_INVALID')
    manifest, unused = regular(release / 'release-manifest.json', 128 * 1024, owner=owner)
    need(closed(manifest)['commit'] == expected, 'MAINTENANCE_CURRENT_CHANGED')
    identifiers = command(['docker', 'ps', '-a', '--no-trunc', '--quiet'], limit=65536).decode().splitlines()
    need(len(identifiers) <= 500 and len(set(identifiers)) == len(identifiers)
         and all(matches(HEX64, item) for item in identifiers), 'MAINTENANCE_CONTAINER_INVALID')
    states = []
    format_string = ('{"id":{{json .Id}},"image":{{json .Image}},"reference":{{json .Config.Image}},'
                     '"running":{{json .State.Running}},"status":{{json .State.Status}},'
                     '"started":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},'
                     '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}')
    if identifiers:
        raw = command(['docker', 'inspect', '--format', format_string, *sorted(identifiers)], limit=512 * 1024)
        for line in raw.decode().splitlines():
            row = closed(line)
            need(type(row) is dict and set(row) == {'id', 'image', 'reference', 'running', 'status', 'started', 'restartCount', 'health'}
                 and row['id'] in identifiers and re.fullmatch(r'sha256:[a-f0-9]{64}', row['image'])
                 and row['status'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead')
                 and type(row['reference']) is str and 0 < len(row['reference']) <= 500
                 and type(row['running']) is bool and type(row['restartCount']) is int and 0 <= row['restartCount'] < 2**31
                 and row['health'] in (None, 'starting', 'healthy', 'unhealthy')
                 and type(row['started']) is str and 0 < len(row['started']) <= 80,
                 'MAINTENANCE_CONTAINER_INVALID')
            states.append(row)
        need(len(states) == len(identifiers) and {row['id'] for row in states} == set(identifiers),
             'MAINTENANCE_CONTAINER_INVALID')
    need(identity(link.lstat()) == identity(first) and link.resolve() == release, 'MAINTENANCE_CURRENT_CHANGED')
    return {'currentRelease': str(release), 'currentManifestSha256': sha(manifest),
            'currentPointerIdentity': list(identity(first)), 'containers': sorted(states, key=lambda row: row['id'])}


def validate_binding(binding):
    need(type(binding) is dict and set(binding) == {'kind', 'version', 'operation', 'producer',
         'qualityRunId', 'expectedCurrent', 'planSha256', 'policySha256', 'sourcePins'}, 'MAINTENANCE_BINDING_FIELDS')
    need(binding['kind'] == 'ID_DISK_MAINTENANCE_BINDING_V1' and binding['version'] == 1
         and type(binding['version']) is int and binding['operation'] in OPERATIONS,
         'MAINTENANCE_OPERATION_INVALID')
    producer = binding['producer']
    need(type(producer) is dict and set(producer) == {'commit', 'sourceTree', 'workflowRunId', 'workflowRunAttempt'}
         and all(matches(HEX40, producer[field]) for field in ('commit', 'sourceTree'))
         and all(matches(POSITIVE, producer[field]) for field in ('workflowRunId', 'workflowRunAttempt'))
         and matches(POSITIVE, binding['qualityRunId']) and matches(HEX40, binding['expectedCurrent'])
         and matches(HEX64, binding['policySha256']), 'MAINTENANCE_PRODUCER_INVALID')
    applying = binding['operation'] in ('install', 'cleanup')
    need(matches(HEX64, binding['planSha256']) if applying else binding['planSha256'] is None,
         'MAINTENANCE_PLAN_APPROVAL_REQUIRED')
    pins = binding['sourcePins']
    need(type(pins) is dict and set(pins) == set(PATHS), 'MAINTENANCE_SOURCE_SET_INVALID')
    for path, pin in pins.items():
        need(type(pin) is dict and set(pin) == {'sha256', 'bytes'} and matches(HEX64, pin['sha256'])
             and type(pin['bytes']) is int and 0 < pin['bytes'] <= MAX_BODY, 'MAINTENANCE_SOURCE_PIN_INVALID')
    return binding


def stage_file(binding, path, payload, *, base=BASE, owner=0):
    validate_binding(binding)
    need(binding['operation'] in ('verify_install', 'install') and path in PATHS
         and os.geteuid() == owner, 'MAINTENANCE_STAGE_SCOPE')
    pin = binding['sourcePins'][path]
    lock_path = base / '.deploy.lock'
    descriptor = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as lock:
        before_lock = os.fstat(lock.fileno())
        need(stat.S_ISREG(before_lock.st_mode) and before_lock.st_uid == owner and before_lock.st_nlink == 1
             and not stat.S_IMODE(before_lock.st_mode) & 0o022
             and identity(before_lock) == identity(lock_path.lstat()), 'MAINTENANCE_DEPLOY_LOCK_INVALID')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = snapshot(binding['expectedCurrent'], base, owner)
        if path in CURRENT_PATHS:
            need(payload is None, 'MAINTENANCE_CURRENT_SOURCE_REQUIRED')
            raw, unused = regular(Path(before['currentRelease']) / path, owner=owner)
        else:
            need(type(payload) is str and len(payload) <= 20000, 'MAINTENANCE_STAGE_PAYLOAD_BOUND')
            decoder = lzma.LZMADecompressor(memlimit=64 * 1024**2)
            raw = decoder.decompress(base64.b64decode(payload, validate=True), max_length=pin['bytes'] + 1)
            need(decoder.eof and not decoder.unused_data, 'MAINTENANCE_STAGE_PAYLOAD_INVALID')
        need(len(raw) == pin['bytes'] and sha(raw) == pin['sha256'], 'MAINTENANCE_SOURCE_CHANGED')
        staging = base / '.staging'
        info = staging.lstat()
        need(staging.resolve() == staging and stat.S_ISDIR(info.st_mode) and info.st_uid == owner
             and not stat.S_IMODE(info.st_mode) & 0o022, 'MAINTENANCE_STAGE_PARENT_INVALID')
        root = staging / ('disk-retention-' + binding['producer']['commit'])
        target = root / path
        for directory in (root, *reversed(tuple(target.parent.parents)[:len(target.parent.relative_to(root).parts)]), target.parent):
            if directory == root or root in directory.parents:
                if not directory.exists() and not directory.is_symlink():
                    directory.mkdir(mode=0o700)
                info = directory.lstat()
                need(directory.resolve() == directory and stat.S_ISDIR(info.st_mode) and info.st_uid == owner
                     and stat.S_IMODE(info.st_mode) == 0o700, 'MAINTENANCE_STAGE_DIRECTORY_INVALID')
        reused = target.exists() or target.is_symlink()
        if reused:
            actual, unused = regular(target, owner=owner, mode=0o600)
            need(actual == raw, 'MAINTENANCE_UNKNOWN_STAGE_TARGET')
        else:
            output = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(output, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        actual, unused = regular(target, owner=owner, mode=0o600)
        need(actual == raw and snapshot(binding['expectedCurrent'], base, owner) == before
             and identity(os.fstat(lock.fileno())) == identity(lock_path.lstat()) == identity(before_lock),
             'MAINTENANCE_STAGE_STATE_CHANGED')
        return {'kind': 'ID_DISK_MAINTENANCE_STAGE_ACK_V1', 'status': 'STAGED',
                'producer': binding['producer'], 'expectedCurrent': binding['expectedCurrent'],
                'path': path, 'sha256': pin['sha256'], 'bytes': pin['bytes'], 'reused': reused,
                'currentUnchanged': True, 'containersUnchanged': True}


def installed_targets(binding, policy):
    pins = binding['sourcePins']
    targets = {INSTALL / name: (pins['scripts/production-release/' + name]['sha256'], 0o600)
               for name in ('disk-retention.py', 'maintain-image-cache.py', 'candidate-retention.py')}
    targets[INSTALL / 'config.json'] = (sha(canonical({**policy, 'approved': True}) + b'\n'), 0o600)
    native_sha = pins['scripts/production-release/disk-retention.py']['sha256']
    service = ('[Unit]\nDescription=Reviewed ID business disk retention\nAfter=docker.service\n\n'
        '[Service]\nType=oneshot\nUser=root\nGroup=root\nUMask=0077\n'
        'ExecStart=/usr/bin/python3 -B ' + str(INSTALL / 'disk-retention.py')
        + ' --scheduled --config ' + str(INSTALL / 'config.json')
        + ' --expected-source-sha256 ' + native_sha + '\nTimeoutStartSec=1500\nNice=10\n')
    timer = ('[Unit]\nDescription=Daily reviewed ID business disk retention\n\n'
        '[Timer]\nOnCalendar=*-*-* 03:15:00 UTC\nRandomizedDelaySec=15m\n'
        'Persistent=true\nUnit=' + SERVICE + '\n\n[Install]\nWantedBy=timers.target\n')
    targets[Path('/etc/systemd/system') / SERVICE] = (sha(service.encode()), 0o644)
    targets[Path('/etc/systemd/system') / TIMER] = (sha(timer.encode()), 0o644)
    return targets


def service_arguments(binding):
    return ['/usr/bin/python3', '-B', str(INSTALL / 'disk-retention.py'), '--scheduled', '--config',
            str(INSTALL / 'config.json'), '--expected-source-sha256',
            binding['sourcePins'][RUNNER_PATHS[0]]['sha256']]


def service_readback(binding):
    properties = ('Id', 'Names', 'LoadState', 'FragmentPath', 'DropInPaths', 'Type', 'User', 'Group',
                  'ExecStart', 'Result', 'ActiveState', 'SubState', 'MainPID', 'ControlPID',
                  'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp')
    raw = command(['env', 'TZ=UTC', 'systemctl', 'show', SERVICE, '--no-pager',
                   '--property=' + ','.join(properties)], limit=16384)
    values = {}
    for line in raw.decode().splitlines():
        key, separator, value = line.partition('=')
        need(separator and key in properties and key not in values, 'MAINTENANCE_SERVICE_INVALID')
        values[key] = value
    need(set(values) == set(properties) and values['Id'] == values['Names'] == SERVICE
         and values['LoadState'] == 'loaded' and values['FragmentPath'] == '/etc/systemd/system/' + SERVICE
         and values['DropInPaths'] == '' and values['Type'] == 'oneshot'
         and values['User'] == values['Group'] == 'root'
         and (values['ActiveState'], values['SubState']) in (('inactive', 'dead'), ('failed', 'failed'))
         and values['MainPID'] == values['ControlPID'] == '0', 'MAINTENANCE_SERVICE_INVALID')
    expected = service_arguments(binding)
    serialized = values.pop('ExecStart')
    need(serialized.startswith('{ ') and serialized.endswith(' }'), 'MAINTENANCE_SERVICE_EXECSTART_CHANGED')
    execution = {}
    for field in serialized[2:-2].split(' ; '):
        key, separator, value = field.partition('=')
        need(separator and key not in execution, 'MAINTENANCE_SERVICE_EXECSTART_CHANGED')
        execution[key] = value
    need(set(execution) == {'path', 'argv[]', 'ignore_errors', 'start_time', 'stop_time', 'pid', 'code', 'status'}
         and execution['path'] == expected[0] and execution['argv[]'] == ' '.join(expected)
         and execution['ignore_errors'] == 'no'
         and all(re.fullmatch(r'\[[^\[\]{}\r\n]{0,64}\]', execution[key]) for key in ('start_time', 'stop_time'))
         and re.fullmatch(r'[0-9]{1,10}', execution['pid'])
         and execution['code'] in ('(null)', 'exited', 'killed', 'dumped', 'trapped', 'stopped', 'continued')
         and re.fullmatch(r'[0-9]{1,3}(?:/[A-Z0-9+-]{1,32})?', execution['status']),
         'MAINTENANCE_SERVICE_EXECSTART_CHANGED')
    need(values['Result'] in ('success', 'resources', 'protocol', 'timeout', 'exit-code', 'signal', 'core-dump',
                             'watchdog', 'start-limit-hit', 'exec-condition', 'oom-kill')
         and all(re.fullmatch(r'[0-9]{1,3}', values[key]) for key in ('ExecMainCode', 'ExecMainStatus')),
         'MAINTENANCE_SERVICE_RESULT_INVALID')
    timestamps = []
    for key in ('ExecMainStartTimestamp', 'ExecMainExitTimestamp'):
        stamp = values[key]
        measured = None
        if stamp not in ('', 'n/a'):
            for pattern in ('%a %Y-%m-%d %H:%M:%S UTC', '%a %Y-%m-%d %H:%M:%S.%f UTC'):
                try:
                    measured = datetime.strptime(stamp, pattern).replace(tzinfo=timezone.utc); break
                except ValueError:
                    pass
            need(measured is not None, 'MAINTENANCE_SERVICE_RESULT_INVALID')
        timestamps.append(measured)
    need((timestamps[0] is None) == (timestamps[1] is None)
         and (timestamps[0] is None or timestamps[0] <= timestamps[1] <= datetime.now(timezone.utc)),
         'MAINTENANCE_SERVICE_RESULT_INVALID')
    observed = timestamps[0] is not None
    values.update(execStartMatched=True, execStartExpectedSha256=digest({'path': expected[0], 'argv': expected}),
                  executionObserved=observed, executionSucceeded=observed and values['Result'] == 'success'
                  and values['ExecMainCode'] == '1' and values['ExecMainStatus'] == '0'
                  and values['ActiveState'] == 'inactive')
    return values


def installation_readback(binding, policy):
    files = []
    for path, (expected_sha, mode) in installed_targets(binding, policy).items():
        raw, info = regular(path, mode=mode)
        need(sha(raw) == expected_sha, 'MAINTENANCE_INSTALLED_SOURCE_CHANGED')
        files.append({'path': str(path), 'sha256': sha(raw), 'bytes': len(raw),
                      'mode': mode, 'uid': info.st_uid, 'gid': info.st_gid})
    properties = ('Id', 'LoadState', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState',
                  'UnitFileState', 'Triggers', 'NextElapseUSecRealtime')
    raw = command(['systemctl', 'show', TIMER, '--no-pager', '--property=' + ','.join(properties)], limit=16384)
    values = {}
    for line in raw.decode().splitlines():
        key, separator, value = line.partition('=')
        need(separator and key in properties and key not in values, 'MAINTENANCE_TIMER_INVALID')
        values[key] = value
    need(set(values) == set(properties) and values['Id'] == TIMER and values['LoadState'] == 'loaded'
         and values['FragmentPath'] == '/etc/systemd/system/' + TIMER and values['DropInPaths'] == ''
         and values['ActiveState'] == 'active' and values['SubState'] == 'waiting'
         and values['UnitFileState'] == 'enabled' and values['Triggers'] == SERVICE,
         'MAINTENANCE_TIMER_INVALID')
    stamp = values['NextElapseUSecRealtime']
    need(type(stamp) is str and stamp.endswith(' UTC'), 'MAINTENANCE_TIMER_NEXT_UNMEASURED')
    next_trigger = None
    for pattern in ('%a %Y-%m-%d %H:%M:%S UTC', '%a %Y-%m-%d %H:%M:%S.%f UTC'):
        try:
            next_trigger = datetime.strptime(stamp, pattern).replace(tzinfo=timezone.utc); break
        except ValueError:
            pass
    need(next_trigger is not None and next_trigger > datetime.now(timezone.utc), 'MAINTENANCE_TIMER_NEXT_UNMEASURED')
    return {'status': 'INSTALLATION_READBACK_VERIFIED', 'targets': files, 'timer': values,
            'service': service_readback(binding),
            'nextTriggerUtc': next_trigger.isoformat(), 'sourceSha256': binding['sourcePins'][RUNNER_PATHS[0]]['sha256']}


def cleanup_plan(result, binding):
    path = Path(result.get('planFile', ''))
    need(path.is_absolute() and path.parent == INSTALL / 'receipts'
         and re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[1-9][0-9]{0,24}\.plan\.json', path.name),
         'MAINTENANCE_PLAN_PATH_INVALID')
    stored, unused = regular(path, MAX_BODY, mode=0o600)
    stored = closed(stored)
    plan = stored.get('plan') if type(stored) is dict else None
    need(type(plan) is dict and plan.get('kind') == 'ID_DISK_RETENTION_PLAN_V1'
         and plan.get('currentCommit') == binding['expectedCurrent']
         and plan.get('policySha256') == binding['policySha256']
         and digest(plan) == result.get('planSha256') == stored.get('planSha256'),
         'MAINTENANCE_PLAN_BINDING_CHANGED')
    return plan


def apply_receipt_budget(binding, planned, probe, policy):
    plan = planned['plan']
    model = {**planned, 'status': 'INSTALLED' if binding['operation'] == 'install' else 'APPLIED',
             'sourceProbe': probe, 'baselineSha256': digest(probe), 'currentUnchanged': True,
             'containersUnchanged': True, 'websiteServicesChanged': False, 'mutationAttempted': True,
             'timerEnabled': True, 'sourceSha256': binding['sourcePins'][RUNNER_PATHS[0]]['sha256'],
             'receipt': str(INSTALL / 'receipts/20991231T235959Z-99999999999999999999.result.json')}
    items = plan.get('corePlan', {}).get('items', [])
    need(type(items) is list and len(items) <= 500
         and all(type(item) is dict and type(item.get('tag')) is str for item in items),
         'MAINTENANCE_BUDGET_PLAN_INVALID')
    model['removed'] = [item['tag'] for item in items]
    model['applyState'] = {'item': max(items, key=lambda item: len(canonical(item))) if items else None,
                           'state': 'VERIFIED_CANDIDATE_REMOVAL_COMPLETED', 'removedCount': len(items)}
    targets = plan.get('targets', {})
    need(type(targets) is dict, 'MAINTENANCE_BUDGET_PLAN_INVALID')
    need(binding['operation'] != 'install' or len(targets) == 6, 'MAINTENANCE_BUDGET_PLAN_INVALID')
    if not targets:
        targets = {str(path): {'sha256': expected_sha, 'mode': mode, 'bytes': MAX_BODY}
                   for path, (expected_sha, mode) in installed_targets(binding, policy).items()}
    if targets:
        model['filesCreated'] = list(targets)
        measured = []
        for path, target in targets.items():
            need(type(path) is str and type(target) is dict
                 and matches(HEX64, target.get('sha256')) and type(target.get('bytes')) is int
                 and type(target.get('mode')) is int, 'MAINTENANCE_BUDGET_PLAN_INVALID')
            measured.append({'path': path, 'sha256': target['sha256'], 'bytes': target['bytes'],
                             'mode': target['mode'], 'uid': 0, 'gid': 0})
    expected = service_arguments(binding)
    model['installationReadback'] = {'status': 'INSTALLATION_READBACK_VERIFIED', 'targets': measured if targets else [],
        'sourceSha256': binding['sourcePins'][RUNNER_PATHS[0]]['sha256'],
        'nextTriggerUtc': '2099-12-31T23:59:59.999999+00:00',
        'timer': {'Id': TIMER, 'LoadState': 'loaded', 'FragmentPath': '/etc/systemd/system/' + TIMER,
                  'DropInPaths': '', 'ActiveState': 'active', 'SubState': 'waiting',
                  'UnitFileState': 'enabled', 'Triggers': SERVICE,
                  'NextElapseUSecRealtime': 'Thu 2099-12-31 23:59:59.999999 UTC'},
        'service': {'Id': SERVICE, 'Names': SERVICE, 'LoadState': 'loaded',
                    'FragmentPath': '/etc/systemd/system/' + SERVICE, 'DropInPaths': '',
                    'Type': 'oneshot', 'User': 'root', 'Group': 'root', 'Result': 'start-limit-hit',
                    'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0', 'ControlPID': '0',
                    'ExecMainCode': '255', 'ExecMainStatus': '255',
                    'ExecMainStartTimestamp': 'Thu 2099-12-31 23:59:59.999999 UTC',
                    'ExecMainExitTimestamp': 'Thu 2099-12-31 23:59:59.999999 UTC',
                    'execStartMatched': True, 'execStartExpectedSha256': digest({'path': expected[0], 'argv': expected}),
                    'executionObserved': False, 'executionSucceeded': False}}
    need(len(canonical(wire(binding, model))) <= 20000, 'MAINTENANCE_APPLY_RECEIPT_BUDGET')


def execute_native(binding):
    validate_binding(binding)
    need(os.geteuid() == 0, 'MAINTENANCE_ROOT_REQUIRED')
    operation = binding['operation']
    before = snapshot(binding['expectedCurrent'])
    if operation in ('verify_install', 'install'):
        root = BASE / '.staging' / ('disk-retention-' + binding['producer']['commit'])
        for path, pin in binding['sourcePins'].items():
            raw, unused = regular(root / path, mode=0o600)
            need(len(raw) == pin['bytes'] and sha(raw) == pin['sha256'], 'MAINTENANCE_STAGED_SOURCE_CHANGED')
        policy = closed(regular(root / POLICY_PATH, mode=0o600)[0])
        need(policy.get('approved') is False
             and digest({key: value for key, value in policy.items() if key != 'approved'}) == binding['policySha256'],
             'MAINTENANCE_POLICY_CHANGED')
        arguments = ['python3', '-B', str(root / 'scripts/production-release/disk-retention-install.py'),
                     '--expected-current', binding['expectedCurrent'], '--policy-json', str(root / POLICY_PATH)]
    else:
        for name in ('disk-retention.py', 'maintain-image-cache.py', 'candidate-retention.py'):
            raw, unused = regular(INSTALL / name, mode=0o600)
            need(sha(raw) == binding['sourcePins']['scripts/production-release/' + name]['sha256'],
                 'MAINTENANCE_INSTALLED_SOURCE_CHANGED')
        policy = closed(regular(INSTALL / 'config.json', mode=0o600)[0])
        need(policy.get('approved') is True
             and digest({key: value for key, value in policy.items() if key != 'approved'}) == binding['policySha256'],
             'MAINTENANCE_POLICY_CHANGED')
        arguments = ['python3', '-B', str(INSTALL / 'disk-retention.py'), '--config', str(INSTALL / 'config.json'),
                     '--expected-current', binding['expectedCurrent'], '--expected-source-sha256',
                     binding['sourcePins'][RUNNER_PATHS[0]]['sha256']]
    applying = operation in ('install', 'cleanup')
    for mutate in ((False, True) if applying else (False,)):
        final_arguments = arguments + (['--apply', '--approved-plan-sha256', binding['planSha256']] if mutate else [])
        process = subprocess.run(final_arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1500)
        need(process.returncode == 0 and process.stderr == b'' and len(process.stdout) <= MAX_BODY
             and len(process.stdout.strip().splitlines()) == 1, 'MAINTENANCE_NATIVE_FAILED')
        result = closed(process.stdout)
        wanted = ('INSTALLED' if operation == 'install' else 'APPLIED') if mutate else 'PLAN_ONLY'
        need(type(result) is dict and result.get('status') == wanted and matches(HEX64, result.get('planSha256')),
             'MAINTENANCE_NATIVE_RESULT_INVALID')
        if applying:
            need(result['planSha256'] == binding['planSha256'], 'MAINTENANCE_APPROVED_PLAN_CHANGED')
        if operation in ('verify_cleanup', 'cleanup'):
            result['plan'] = cleanup_plan(result, binding)
        else:
            need(type(result.get('plan')) is dict and digest(result['plan']) == result['planSha256'],
                 'MAINTENANCE_INSTALL_PLAN_CHANGED')
        if applying and not mutate:
            apply_receipt_budget(binding, result, before, policy)
            need(snapshot(binding['expectedCurrent']) == before, 'MAINTENANCE_PRODUCTION_CHANGED')
    if operation in ('install', 'verify_cleanup', 'cleanup'):
        result['installationReadback'] = installation_readback(binding, policy)
    need(snapshot(binding['expectedCurrent']) == before, 'MAINTENANCE_PRODUCTION_CHANGED')
    result.update(currentUnchanged=True, containersUnchanged=True,
                  baselineSha256=digest(before), sourceProbe=before, websiteServicesChanged=False)
    return result


def wire(binding, result):
    validate_binding(binding)
    raw = canonical(result)
    need(len(raw) <= MAX_BODY, 'MAINTENANCE_RESULT_BODY_BOUND')
    value = {'kind': WIRE_KIND, 'version': 1, 'bindingSha256': digest(binding),
             'operation': binding['operation'], 'producer': binding['producer'],
             'encoding': 'gzip-base64', 'bodyBytes': len(raw), 'bodySha256': sha(raw),
             'payload': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    need(len(canonical(value)) < MAX_STDOUT, 'MAINTENANCE_RESULT_WIRE_BOUND')
    return value


def remote_program(binding, *, path=None, payload=None):
    validate_binding(binding)
    functions = (need, matches, canonical, sha, digest, closed, identity, regular, command, snapshot,
                 validate_binding, wire)
    functions += ((stage_file,) if path is not None else
                  (installed_targets, service_arguments, service_readback, installation_readback,
                   cleanup_plan, apply_receipt_budget, execute_native))
    header = ('import base64,fcntl,gzip,hashlib,json,lzma,os,re,stat,subprocess,time,zlib\n'
              'from pathlib import Path\nfrom datetime import datetime,timezone\nclass Rejected(RuntimeError):pass\n')
    for name in ('BASE', 'INSTALL', 'INSTANCE', 'SERVICE', 'TIMER', 'POLICY_PATH', 'RUNNER_PATHS',
                 'CURRENT_PATHS', 'PATHS', 'OPERATIONS', 'MAX_BODY', 'MAX_STDOUT', 'WIRE_KIND'):
        value = globals()[name]
        header += name + '=' + ('Path(' + repr(str(value)) + ')' if isinstance(value, Path) else repr(value)) + '\n'
    for name in ('HEX40', 'HEX64', 'UUID', 'POSITIVE'):
        header += name + '=re.compile(' + repr(globals()[name].pattern) + ')\n'
    header += '\n'.join(inspect.getsource(function) for function in functions)
    header += '\nbinding=' + repr(binding) + '\ntry:\n'
    expression = 'execute_native(binding)' if path is None else 'stage_file(binding,' + repr(path) + ',' + repr(payload) + ')'
    header += ' result=' + expression + '\n print(json.dumps(wire(binding,result),sort_keys=True))\n'
    header += ('except Exception as error:\n code=str(error) if type(error)is Rejected and re.fullmatch(' 
               "'MAINTENANCE_[A-Z_]+',str(error))else'MAINTENANCE_REMOTE_FAILED_CLOSED'\n"
               " print(json.dumps({'kind':'ID_DISK_MAINTENANCE_FAILURE_V1','bindingSha256':digest(binding),"
               "'operation':binding['operation'],'producer':binding['producer'],'status':'FAILED_CLOSED','code':code}))\n"
               ' raise SystemExit(1)\n')
    compile(header, '<disk-maintenance-remote>', 'exec')
    packed = base64.b64encode(lzma.compress(header.encode())).decode()
    loader = ('import base64,hashlib,lzma;d=lzma.LZMADecompressor(memlimit=64*1024**2);'
              'r=d.decompress(base64.b64decode(' + repr(packed) + ',validate=True),max_length=' + str(len(header.encode())+1) + ');'
              'assert len(r)==' + str(len(header.encode())) + ' and d.eof and not d.unused_data and '
              'hashlib.sha256(r).hexdigest()==' + repr(sha(header.encode())) + ';exec(compile(r,"<disk-maintenance-remote>","exec"))')
    text = 'python3 -B -c ' + shlex.quote(loader)
    parameters = {'commands': [text], 'executionTimeout': ['1500' if path is None else '180']}
    need(len(text.encode()) <= MAX_COMMAND and len(canonical(parameters)) < 24 * 1024,
         'MAINTENANCE_SSM_COMMAND_BOUND')
    return parameters


def storage_module():
    spec = importlib.util.spec_from_file_location('disk_maintenance_common', HERE / 'release-storage.py')
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def selection(environment):
    operation = environment.get('DISK_MAINTENANCE_OPERATION')
    plan = environment.get('DISK_MAINTENANCE_PLAN_SHA256', '')
    need(operation in OPERATIONS, 'MAINTENANCE_OPERATION_INVALID')
    need(matches(HEX64, plan) if operation in ('install', 'cleanup') else plan == '',
         'MAINTENANCE_PLAN_APPROVAL_REQUIRED')
    producer = {'commit': environment.get('RELEASE_COMMIT'), 'sourceTree': environment.get('SOURCE_TREE'),
                'workflowRunId': environment.get('GITHUB_RUN_ID'), 'workflowRunAttempt': environment.get('GITHUB_RUN_ATTEMPT')}
    need(all(matches(HEX40, producer[field]) for field in ('commit', 'sourceTree'))
         and all(matches(POSITIVE, producer[field]) for field in ('workflowRunId', 'workflowRunAttempt'))
         and matches(POSITIVE, environment.get('QUALITY_RUN_ID')) and matches(HEX40, environment.get('EXPECTED_CURRENT')),
         'MAINTENANCE_PRODUCER_INVALID')
    need(producer['workflowRunAttempt'] == '1', 'MAINTENANCE_RERUN_RECONCILIATION_REQUIRED')
    need(environment.get('GITHUB_REF') == 'refs/heads/main'
         and environment.get('GITHUB_REPOSITORY') == GITHUB_REPOSITORY
         and environment.get('PRODUCTION_INSTANCE_ID') == INSTANCE and environment.get('AWS_REGION') == REGION
         and environment.get('RELEASE_REPOSITORY') == REPOSITORY, 'MAINTENANCE_TARGET_INVALID')
    return {'operation': operation, 'producer': producer, 'qualityRunId': environment['QUALITY_RUN_ID'],
            'expectedCurrent': environment['EXPECTED_CURRENT'], 'planSha256': plan or None}


def source_binding(selected, commands):
    common = storage_module()
    common.verify_source(selected, commands)
    sources = {path: common.read_file(PROJECT / path, MAX_BODY) for path in PATHS}
    for path, raw in sources.items():
        unused, committed = commands.git('show', selected['producer']['commit'] + ':' + path, limit=MAX_BODY)
        need(committed == raw, 'MAINTENANCE_GIT_SOURCE_CHANGED')
    policy = closed(sources[POLICY_PATH])
    need(policy.get('approved') is False and policy.get('sourceSha256') == sha(sources[RUNNER_PATHS[0]])
         and policy.get('candidateRegistrySha256') == sha(sources[RUNNER_PATHS[1]])
         and policy.get('maintainerSha256') == sha(sources[CURRENT_PATHS[0]]), 'MAINTENANCE_POLICY_SOURCE_CHANGED')
    syntax = ast.parse(sources[RUNNER_PATHS[2]])
    values = [node.value for node in syntax.body if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == 'LEGACY_SOURCE_SHA256' for target in node.targets)]
    need(len(values) == 1 and ast.literal_eval(values[0]) == sha(sources[CURRENT_PATHS[1]]),
         'MAINTENANCE_LEGACY_SOURCE_CHANGED')
    binding = {'kind': 'ID_DISK_MAINTENANCE_BINDING_V1', 'version': 1, **selected,
               'policySha256': digest({key: value for key, value in policy.items() if key != 'approved'}),
               'sourcePins': {path: {'sha256': sha(raw), 'bytes': len(raw)} for path, raw in sources.items()}}
    validate_binding(binding)
    return binding, sources


def decode_wire(value, binding):
    need(type(value) is dict and set(value) == {'kind', 'version', 'bindingSha256', 'operation', 'producer',
         'encoding', 'bodyBytes', 'bodySha256', 'payload'} and value['kind'] == WIRE_KIND and value['version'] == 1
         and type(value['version']) is int and value['bindingSha256'] == digest(binding)
         and value['operation'] == binding['operation'] and value['producer'] == binding['producer']
         and value['encoding'] == 'gzip-base64' and type(value['bodyBytes']) is int
         and 0 < value['bodyBytes'] <= MAX_BODY and matches(HEX64, value['bodySha256'])
         and type(value['payload']) is str and len(value['payload']) <= MAX_STDOUT, 'MAINTENANCE_WIRE_INVALID')
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(base64.b64decode(value['payload'], validate=True), value['bodyBytes'] + 1)
        need(len(raw) == value['bodyBytes'] and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
             and sha(raw) == value['bodySha256'], 'MAINTENANCE_WIRE_BINDING_CHANGED')
    except Rejected:
        raise
    except Exception:
        raise Rejected('MAINTENANCE_WIRE_INVALID') from None
    return closed(raw)


def private_directory(selected):
    root = PROJECT / '.deploy/production-release/disk-retention-maintenance'
    leaf = root / (selected['producer']['workflowRunId'] + '-' + selected['producer']['workflowRunAttempt'])
    current = PROJECT
    for component in leaf.relative_to(PROJECT).parts:
        current = current / component
        if not current.exists() and not current.is_symlink(): current.mkdir(mode=0o700)
        need(current.resolve() == current and current.is_dir() and current.stat().st_uid == os.geteuid()
             and not stat.S_IMODE(current.stat().st_mode) & 0o022, 'MAINTENANCE_LOCAL_DIRECTORY_INVALID')
    need(stat.S_IMODE(leaf.stat().st_mode) == 0o700, 'MAINTENANCE_LOCAL_DIRECTORY_INVALID')
    return leaf


class SsmClient:
    def __init__(self, commands, directory, sleep=time.sleep, monotonic=time.monotonic):
        self.commands, self.directory, self.sleep, self.monotonic = commands, directory, sleep, monotonic
        self.confirmed = set()
        self.unsettled = set()

    def check_prior_commands(self):
        need(not self.unsettled, 'MAINTENANCE_PRIOR_COMMAND_UNSETTLED')
        commands = self.commands.aws('ssm', 'list-commands', '--instance-id', INSTANCE,
            '--query', 'Commands[].{CommandId:CommandId,Status:Status,InstanceIds:InstanceIds}')
        need(type(commands) is list and len(commands) <= 10000, 'MAINTENANCE_COMMAND_LIST_INVALID')
        seen = set()
        statuses = {'Pending', 'InProgress', 'Delayed', 'Cancelling', 'Success', 'Cancelled', 'Failed', 'TimedOut'}
        terminal = {'Success', 'Cancelled', 'Failed', 'TimedOut'}
        for value in commands:
            need(type(value) is dict and set(value) == {'CommandId', 'Status', 'InstanceIds'}
                 and matches(UUID, value['CommandId']) and value['CommandId'] not in seen
                 and value['Status'] in statuses and type(value['InstanceIds']) is list
                 and len(value['InstanceIds']) <= 50
                 and (not value['InstanceIds'] or INSTANCE in value['InstanceIds'])
                 and all(type(instance) is str and re.fullmatch(r'(?:i-[a-f0-9]{8}(?:[a-f0-9]{9})?|mi-[a-f0-9]{17})', instance)
                         for instance in value['InstanceIds']), 'MAINTENANCE_COMMAND_LIST_INVALID')
            seen.add(value['CommandId'])
            need(value['Status'] in terminal or value['CommandId'] in self.confirmed,
                 'MAINTENANCE_PRIOR_COMMAND_UNSETTLED')

    def execute(self, name, parameters, binding):
        need(re.fullmatch(r'[a-z0-9-]{1,80}', name), 'MAINTENANCE_RECEIPT_NAME_INVALID')
        common = storage_module()
        intent = self.directory / (name + '.intent.json')
        acceptance = self.directory / (name + '.accepted.json')
        terminal = self.directory / (name + '.result.json')
        request = {'bindingSha256': digest(binding), 'parametersSha256': digest(parameters), 'instanceId': INSTANCE}
        if terminal.exists():
            prior = closed(common.read_file(terminal, MAX_BODY, private=True))
            need(prior.get('request') == request, 'MAINTENANCE_PRIOR_RESULT_CHANGED')
            need(prior.get('status') == 'Success' and matches(UUID, prior.get('commandId')),
                 'MAINTENANCE_PRIOR_TERMINAL_FAILED')
            result = decode_wire(prior['wire'], binding)
            self.confirmed.add(prior['commandId'])
            return result
        if acceptance.exists():
            accepted = closed(common.read_file(acceptance, private=True))
            need(accepted.get('request') == request and matches(UUID, accepted.get('commandId')),
                 'MAINTENANCE_ACCEPTANCE_CHANGED')
            command_id = accepted['commandId']
            self.unsettled.add(command_id)
        else:
            need(not intent.exists() and not intent.is_symlink(), 'MAINTENANCE_SEND_RESULT_UNKNOWN_RECONCILIATION_REQUIRED')
            self.check_prior_commands()
            common.save(intent, {'request': request, 'status': 'SEND_INTENT_RECORDED'})
            value = self.commands.aws('ssm', 'send-command', '--cli-input-json', canonical({
                'InstanceIds': [INSTANCE], 'DocumentName': 'AWS-RunShellScript',
                'Comment': 'ID disk maintenance ' + binding['operation'] + ' ' + name,
                'Parameters': parameters}).decode())
            accepted = value.get('Command') if type(value) is dict else None
            need(type(accepted) is dict and matches(UUID, accepted.get('CommandId'))
                 and accepted.get('InstanceIds') == [INSTANCE] and accepted.get('DocumentName') == 'AWS-RunShellScript',
                 'MAINTENANCE_SSM_ACCEPTANCE_INVALID')
            command_id = accepted['CommandId']
            self.unsettled.add(command_id)
            common.save(acceptance, {'request': request, 'commandId': command_id, 'status': 'ACCEPTED_RESULT_UNKNOWN'})
        deadline = self.monotonic() + 1550
        while self.monotonic() < deadline:
            invocation = self.commands.aws('ssm', 'get-command-invocation', '--command-id', command_id,
                                          '--instance-id', INSTANCE, invocation=True)
            need(type(invocation) is dict, 'MAINTENANCE_SSM_INVOCATION_INVALID')
            if invocation.get('Status') in ('Pending', 'InProgress', 'Delayed'):
                self.sleep(10); continue
            need(invocation.get('CommandId') == command_id and invocation.get('InstanceId') == INSTANCE
                 and invocation.get('DocumentName') == 'AWS-RunShellScript'
                 and invocation.get('PluginName') == 'aws:runShellScript', 'MAINTENANCE_SSM_INVOCATION_INVALID')
            output = invocation.get('StandardOutputContent')
            need(type(output) is str and 0 < len(output.encode()) < MAX_STDOUT
                 and len(output.strip().splitlines()) == 1, 'MAINTENANCE_SSM_OUTPUT_INVALID')
            value = closed(output, MAX_STDOUT)
            if invocation.get('Status') != 'Success' or type(invocation.get('ResponseCode')) is not int or invocation['ResponseCode'] != 0:
                safe = {'kind': 'ID_DISK_MAINTENANCE_FAILURE_V1', 'status': 'FAILED_CLOSED'}
                if (type(value) is dict and value.get('kind') == safe['kind'] and value.get('bindingSha256') == digest(binding)
                        and value.get('producer') == binding['producer'] and value.get('operation') == binding['operation']):
                    if matches(re.compile(r'MAINTENANCE_[A-Z_]+\Z'), value.get('code')): safe['code'] = value['code']
                common.save(terminal, {'request': request, 'commandId': command_id, 'status': 'Failed', 'failure': safe})
                raise Rejected('MAINTENANCE_REMOTE_TERMINAL_FAILED')
            need(invocation.get('StandardErrorContent') == '', 'MAINTENANCE_SSM_STDERR_UNEXPECTED')
            result = decode_wire(value, binding)
            common.save(terminal, {'request': request, 'commandId': command_id, 'status': 'Success',
                                  'invocationCanonicalSha256': digest(invocation), 'wire': value})
            self.unsettled.discard(command_id)
            self.confirmed.add(command_id)
            return result
        raise Rejected('MAINTENANCE_ACCEPTED_RESULT_PENDING')


def validate_ack(result, binding, path):
    pin = binding['sourcePins'][path]
    need(type(result) is dict and set(result) == {'kind', 'status', 'producer', 'expectedCurrent', 'path',
         'sha256', 'bytes', 'reused', 'currentUnchanged', 'containersUnchanged'}
         and result['kind'] == 'ID_DISK_MAINTENANCE_STAGE_ACK_V1' and result['status'] == 'STAGED'
         and result['producer'] == binding['producer'] and result['expectedCurrent'] == binding['expectedCurrent']
         and result['path'] == path and result['sha256'] == pin['sha256'] and result['bytes'] == pin['bytes']
         and type(result['reused']) is bool and result['currentUnchanged'] is True and result['containersUnchanged'] is True,
         'MAINTENANCE_STAGE_ACK_CHANGED')


def validate_result(result, binding):
    wanted = {'verify_install': 'PLAN_ONLY', 'install': 'INSTALLED', 'verify_cleanup': 'PLAN_ONLY', 'cleanup': 'APPLIED'}
    need(type(result) is dict and result.get('status') == wanted[binding['operation']]
         and type(result.get('plan')) is dict and matches(HEX64, result.get('planSha256'))
         and digest(result['plan']) == result['planSha256'] and result.get('currentUnchanged') is True
         and result.get('containersUnchanged') is True and result.get('websiteServicesChanged') is False,
         'MAINTENANCE_RESULT_INVALID')
    if binding['operation'] in ('install', 'cleanup'):
        need(result['planSha256'] == binding['planSha256'], 'MAINTENANCE_APPROVED_PLAN_CHANGED')
    if binding['operation'] in ('install', 'verify_cleanup', 'cleanup'):
        measured = result.get('installationReadback', {})
        need(measured.get('status') == 'INSTALLATION_READBACK_VERIFIED'
             and type(measured.get('targets')) is list and len(measured['targets']) == 6
             and measured.get('sourceSha256') == binding['sourcePins'][RUNNER_PATHS[0]]['sha256']
             and type(measured.get('nextTriggerUtc')) is str, 'MAINTENANCE_INSTALLATION_UNVERIFIED')
        service = measured.get('service', {})
        expected = service_arguments(binding)
        need(service.get('Id') == SERVICE and service.get('Type') == 'oneshot'
             and service.get('User') == service.get('Group') == 'root'
             and service.get('FragmentPath') == '/etc/systemd/system/' + SERVICE and service.get('DropInPaths') == ''
             and service.get('execStartMatched') is True and 'ExecStart' not in service
             and service.get('execStartExpectedSha256') == digest({'path': expected[0], 'argv': expected})
             and type(service.get('executionObserved')) is bool and type(service.get('executionSucceeded')) is bool
             and type(service.get('Result')) is str, 'MAINTENANCE_SERVICE_UNVERIFIED')
    return result


def execute(environment=None, commands=None, client=None):
    selected = selection(os.environ if environment is None else environment)
    common = storage_module(); commands = commands or common.Commands()
    binding, sources = source_binding(selected, commands)
    directory = private_directory(selected)
    source_path = directory / 'source-binding.json'
    if source_path.exists():
        need(closed(common.read_file(source_path, private=True)) == binding, 'MAINTENANCE_PRIOR_BINDING_CHANGED')
    else:
        common.save(source_path, binding)
    client = client or SsmClient(commands, directory)
    if binding['operation'] in ('verify_install', 'install'):
        for index, path in enumerate(PATHS):
            payload = base64.b64encode(lzma.compress(sources[path])).decode() if path in RUNNER_PATHS else None
            result = client.execute('stage-' + str(index), remote_program(binding, path=path, payload=payload), binding)
            validate_ack(result, binding, path)
    result = client.execute('operation', remote_program(binding), binding)
    validate_result(result, binding)
    for name, value in (('complete-plan.json', result['plan']),
                        ('final-result.json', {'bindingSha256': digest(binding), 'result': result})):
        path = directory / name
        if path.exists():
            need(closed(common.read_file(path, MAX_BODY, private=True)) == value, 'MAINTENANCE_PRIOR_RESULT_CHANGED')
        else:
            common.save(path, value)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.validate_only:
            selected = selection(os.environ)
            print(json.dumps({'status': 'MAINTENANCE_SELECTION_VERIFIED', 'operation': selected['operation']})); return 0
        result = execute()
        print(json.dumps({'status': result['status'], 'planSha256': result['planSha256'],
                          'currentUnchanged': True, 'containersUnchanged': True,
                          'timerEnabled': result.get('timerEnabled'), 'freeBytesAfter': result.get('freeBytesAfter')}))
        return 0
    except Exception as error:
        code = str(error) if type(error) is Rejected and re.fullmatch(r'MAINTENANCE_[A-Z_]+', str(error)) else 'MAINTENANCE_FAILED_CLOSED'
        print(json.dumps({'status': 'FAILED_CLOSED', 'code': code, 'rawOutputSuppressed': True})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
