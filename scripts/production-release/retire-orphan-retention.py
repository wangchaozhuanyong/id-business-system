"""Retire one confirmed obsolete timer without deleting data or failure history."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SERVICE = 'id-business-v2-production-retention.service'
TIMER = 'id-business-v2-production-retention.timer'
EXECUTABLE = Path('/opt/id-business-v2/current/scripts/cleanup-aws-production-retention.sh')
UNIT_DIRECTORY = Path('/etc/systemd/system')
SERVICE_PROPERTIES = (
    'Id', 'LoadState', 'FragmentPath', 'Type', 'User', 'Group', 'ExecStart',
    'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus',
    'MainPID', 'ControlPID', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp',
)
TIMER_PROPERTIES = ('Id', 'LoadState', 'FragmentPath', 'Triggers',
                    'ActiveState', 'SubState', 'UnitFileState')


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def command(*arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, 'Retention retirement command failed; raw output suppressed')
    return result.stdout.strip()


def properties(unit, names):
    output = command('systemctl', 'show', unit, '--no-pager',
                     '--property=' + ','.join(names))
    values = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        require(separator and key in names and key not in values,
                'Retention unit properties malformed')
        values[key] = value
    require(set(values) == set(names) and values['Id'] == unit,
            'Retention unit identity or properties missing')
    return values


def unit_identity(unit, state):
    path = UNIT_DIRECTORY / unit
    require(state['FragmentPath'] == str(path) and path.is_file() and not path.is_symlink(),
            'Retention unit fragment differs from the fixed legacy unit')
    before = path.stat()
    require(before.st_uid == 0 and not before.st_mode & 0o022 and before.st_size <= 16384,
            'Retention unit ownership, permissions or size changed')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    after = path.stat()
    require((before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns),
            'Retention unit fragment changed while being inspected')
    return digest


def confirm_service(state):
    require(state['LoadState'] == 'loaded' and state['Type'] == 'oneshot'
            and state['User'] == state['Group'] == 'root', 'Retention service scope changed')
    # Parse only the fixed path and argv from systemd's structured ExecStart;
    # never echo the full property or accept arbitrary executable arguments.
    matches = re.findall(r'\{\s*path=([^;]+);\s*argv\[\]=([^;]+);', state['ExecStart'])
    require(len(matches) == 1 and state['ExecStart'].count('{') == 1
            and matches[0][0].strip() == str(EXECUTABLE)
            and matches[0][1].strip() == str(EXECUTABLE),
            'Retention ExecStart differs from the fixed removed script')
    require(not EXECUTABLE.exists() and not EXECUTABLE.is_symlink(),
            'Retention executable exists or was restored; review required')
    require(state['ActiveState'] in ('failed', 'inactive')
            and state['SubState'] in ('failed', 'dead')
            and state['Result'] == 'exit-code' and state['ExecMainCode'] == '1'
            and state['ExecMainStatus'] == '203'
            and state['MainPID'] == state['ControlPID'] == '0',
            'Retention service is running or differs from the confirmed EXEC failure')


def confirm_timer(state):
    require(state['LoadState'] == 'loaded' and state['Triggers'] == SERVICE
            and state['ActiveState'] in ('active', 'inactive')
            and state['UnitFileState'] in ('enabled', 'enabled-runtime', 'disabled'),
            'Retention timer scope or lifecycle changed')


def safe_service(state):
    return {key: state[key] for key in SERVICE_PROPERTIES if key != 'ExecStart'} | {
        'execStartPath': str(EXECUTABLE), 'execStartArgumentCount': 1,
    }


def retire(apply=False):
    require(os.geteuid() == 0, 'Retention retirement must run as root')
    service = properties(SERVICE, SERVICE_PROPERTIES)
    timer = properties(TIMER, TIMER_PROPERTIES)
    if service['LoadState'] == timer['LoadState'] == 'not-found':
        return {'ok': True, 'status': 'LEGACY_RETENTION_UNITS_ABSENT',
                'timerMutations': 0, 'deletedFiles': 0, 'databaseWrites': 0}
    confirm_service(service)
    confirm_timer(timer)
    identities = {SERVICE: unit_identity(SERVICE, service), TIMER: unit_identity(TIMER, timer)}
    already_retired = timer['ActiveState'] == 'inactive' and timer['UnitFileState'] == 'disabled'
    receipt = {'ok': True, 'status': 'LEGACY_RETENTION_ALREADY_RETIRED' if already_retired else
               'LEGACY_RETENTION_CONFIRMED_READY_TO_RETIRE', 'applyRequested': apply,
               'serviceFailureBefore': safe_service(service), 'timerBefore': timer,
               'unitSha256': identities, 'timerMutations': 0, 'deletedFiles': 0,
               'databaseWrites': 0, 'backupsDeleted': 0, 'unitsDeleted': 0,
               'failureHistoryReset': False}
    if not apply or already_retired:
        return receipt
    # Recheck the exact failure, unit bytes and missing target immediately
    # before the one allowed mutation. Never start/stop the service itself.
    fresh_service = properties(SERVICE, SERVICE_PROPERTIES)
    fresh_timer = properties(TIMER, TIMER_PROPERTIES)
    confirm_service(fresh_service)
    confirm_timer(fresh_timer)
    require(fresh_service == service and fresh_timer == timer
            and identities == {SERVICE: unit_identity(SERVICE, fresh_service),
                               TIMER: unit_identity(TIMER, fresh_timer)},
            'Retention unit state changed before retirement')
    command('systemctl', 'disable', '--now', TIMER)
    after_service = properties(SERVICE, SERVICE_PROPERTIES)
    after_timer = properties(TIMER, TIMER_PROPERTIES)
    confirm_service(after_service)
    confirm_timer(after_timer)
    require(after_service == service and after_timer['ActiveState'] == 'inactive'
            and after_timer['UnitFileState'] == 'disabled'
            and identities == {SERVICE: unit_identity(SERVICE, after_service),
                               TIMER: unit_identity(TIMER, after_timer)},
            'Retention retirement verification failed; service history must be preserved')
    receipt.update({'status': 'LEGACY_RETENTION_TIMER_RETIRED_FAILURE_HISTORY_PRESERVED',
                    'timerMutations': 1, 'timerAfter': after_timer,
                    'serviceFailureAfter': safe_service(after_service)})
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(retire(args.apply), sort_keys=True))
    except Exception as error:
        print(json.dumps({'ok': False, 'status': 'LEGACY_RETENTION_RETIREMENT_REJECTED',
                          'reason': str(error) if isinstance(error, RuntimeError)
                          else 'Failure details suppressed'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
