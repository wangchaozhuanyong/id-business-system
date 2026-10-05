#!/usr/bin/env python3
"""Run one exact, guarded production release on the existing EC2 instance."""

import argparse
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from urllib.parse import quote, urlsplit, urlunsplit
import urllib.request


BASE = Path('/opt/id-business-v2')
SERVICES = ('media-resolver', 'auto-recharge', 'auto-registration', 'api', 'admin')
ALL_SERVICES = (*SERVICES, 'mysql', 'caddy')
REUSE_CONTROL_FILES = frozenset({
    '.github/workflows/production-release.yml',
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.test.mjs',
    'scripts/ci-recharge-release.test.mjs',
    'scripts/production-release/cleanup-reviewed-cache.py',
    'scripts/production-release/cleanup-reviewed-cache.test.py',
    'scripts/production-release/maintain-image-cache.py',
    'scripts/production-release/maintain-image-cache.test.py',
    'scripts/production-release/dispatch.sh',
    'scripts/production-release/remote-deploy.py',
    'scripts/production-release/remote-deploy.test.py',
    'scripts/production-release/reuse-images.py',
    'scripts/production-release/storage-maintenance.py',
    'scripts/production-release/storage-maintenance.test.py',
    'scripts/production-release/audit-retention-mysql.test.py',
    'deploy/aws/cache-cleanup-recharge-names-20261002.json',
    'deploy/aws/cache-cleanup-recharge-execution-20261002.json',
    'deploy/aws/cache-cleanup-storage-20261002.json',
    'deploy/aws/cache-cleanup-bitbrowser-direct-20261003.json',
    'deploy/aws/cache-cleanup-legacy-20261002.json',
    'deploy/aws/cache-cleanup-unused-legacy-20261003.json',
    'docs/PRODUCTION_RELEASE_OIDC.md',
    'docs/RECHARGE_NAMES_CACHE_RECOVERY_20261002.md',
    'docs/RECHARGE_EXECUTION_CACHE_RECOVERY_20261002.md',
    'docs/STORAGE_CLEANUP_20261002.md',
    'docs/V2_TASKS.md',
})


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command_failure_summary(data):
    error = data.get('StandardErrorContent', '')
    errors = re.findall(r'(?m)^([A-Za-z]+Error):', error)
    lines = re.findall(r'File "[^"\n]*remote-deploy\.py", line ([0-9]+)', error)
    reasons = (
        'Production baseline changed', 'Active recharge jobs prevent release',
        'Active registration jobs prevent release', 'Registration runtime guard unavailable',
        'A production service is not running', 'A production service is not healthy',
        'Invalid current release path', 'Insufficient free disk after pull',
        'Resource temporarily unavailable', 'No space left on device',
        'Permission denied', 'invalid syntax',
    )
    status = data.get('Status')
    return {
        'status': status if status in ('Success', 'Failed', 'Cancelled', 'TimedOut',
                                       'InProgress', 'Pending', 'Cancelling') else 'Unknown',
        'responseCode': data.get('ResponseCode') if isinstance(data.get('ResponseCode'), int) else None,
        'errorType': errors[-1] if errors and errors[-1] in (
            'SyntaxError', 'RuntimeError', 'BlockingIOError', 'FileNotFoundError',
            'PermissionError', 'OSError', 'TypeError', 'ValueError', 'AssertionError',
            'ConnectionError', 'UnicodeDecodeError', 'ModuleNotFoundError', 'NameError'
        ) else 'Unclassified',
        'sourceLine': int(lines[-1]) if lines else None,
        'reason': next((reason for reason in reasons if reason in error), 'raw error suppressed'),
    }


def require_reusable_paths(paths):
    require(set(paths) <= REUSE_CONTROL_FILES, 'Application or build source changed since image build')


def verify_reusable_archive(release, source, commit):
    prefix = f'id-business-system-{commit}/'
    hashes = {}
    seen = set()
    for member in source.getmembers():
        require((member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and (member.isfile() or member.isdir()), 'Unsafe reusable source archive entry')
        if not member.isfile():
            continue
        name = member.name[len(prefix):]
        require(name not in seen, 'Duplicate reusable archive entry')
        seen.add(name)
        if name not in REUSE_CONTROL_FILES:
            hashes[name] = (hashlib.sha256(source.extractfile(member).read()).hexdigest(),
                            member.mode & 0o111)
    actual = {str(p.relative_to(release)): (hashlib.sha256(p.read_bytes()).hexdigest(),
                                         p.stat().st_mode & 0o111)
              for p in release.rglob('*') if p.is_file()
              and str(p.relative_to(release)) not in REUSE_CONTROL_FILES}
    require(actual == hashes, 'Reusable image source differs from release application source')


def release_services(admin_only, additions, edge_changed=False):
    require(not (admin_only and additions), 'Admin-only release contains migrations')
    services = ('admin',) if admin_only else SERVICES
    require(not (admin_only and edge_changed), 'Admin-only release contains edge configuration changes')
    images = tuple(dict.fromkeys(image_service(service) for service in services))
    if not admin_only:
        images = (*images, 'migrate')
    return (*services, 'caddy') if edge_changed else services, images


def image_service(service):
    # Independent processes reuse one Worker build; the runtime role is Compose config.
    return 'auto-recharge' if service == 'auto-registration' else service


def release_image_references(services, images, repository, tags):
    targets = (*[service for service in services if service in SERVICES],
               *[service for service in images if service not in SERVICES])
    return {service: f'{repository}:{tags[image_service(service)]}' for service in targets}


def has_registration_worker(directory):
    return bool(re.search(r'(?m)^  auto-registration:$',
                          (directory / 'docker-compose.aws-mysql.yml').read_text()))


def production_services(directory):
    # The first split release has no registration container in its old baseline.
    return tuple(service for service in ALL_SERVICES
                 if service != 'auto-registration' or has_registration_worker(directory))


def rollback_service(previous, release, service, before):
    if service not in before:
        require(service == 'auto-registration', 'Unexpected added production service')
        compose(release, 'rm', '-s', '-f', service, timeout=300)
        require(not compose(release, 'ps', '-q', '--all', service),
                'Rollback added registration worker remains')
        return
    compose(previous, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
            '--force-recreate', service, timeout=300)
    require(service_state(previous, service)['image'] == before[service]['image'],
            'Rollback image mismatch')
    wait_healthy(previous, service)


def run(*args, env=None, timeout=300):
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}); output suppressed')
    return result.stdout.strip()


def compose(directory, *args, env=None, timeout=300):
    return run(
        'docker', 'compose', '--env-file', str(directory / '.env.aws.production'),
        '-f', str(directory / 'docker-compose.aws-mysql.yml'),
        '-f', str(directory / 'compose.release.json'), *args,
        env=env, timeout=timeout,
    )


def environment_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip().strip('"').strip("'")
    return values


def service_state(directory, service):
    container = compose(directory, 'ps', '-q', service)
    require(bool(container), f'{service} container missing')
    data = json.loads(run('docker', 'inspect', container))[0]
    return {
        'image': data['Image'],
        'reference': data['Config']['Image'],
        'status': data['State']['Status'],
        'health': data['State'].get('Health', {}).get('Status'),
    }


def wait_healthy(directory, service):
    for _ in range(90):
        state = service_state(directory, service)
        if state['status'] == 'running' and (state['health'] == 'healthy'
                                           or (service == 'caddy' and state['health'] is None)):
            return state
        if state['status'] not in ('running', 'created'):
            break
        time.sleep(2)
    raise RuntimeError(f'{service} did not become healthy')


def prepare_historical_before_receipt(directory, receipt):
    # The previous root-owned 0600 receipt must remain private while its existing
    # non-root audit reader can read the bind mount. Never change directory modes.
    probe = ("const os=require('node:os'); const user=os.userInfo(); "
             "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),user:user.username}));")
    try:
        identity = json.loads(compose(directory, 'run', '--rm', '--no-deps',
            '--entrypoint', 'node', 'migrate', '-e', probe, timeout=30))
    except Exception:
        raise RuntimeError('Historical audit reader identity unavailable') from None
    require(isinstance(identity, dict) and set(identity) == {'uid', 'gid', 'user'}
            and identity['user'] == 'node'
            and all(type(identity[key]) is int and 0 < identity[key] <= 2147483647
                    for key in ('uid', 'gid')), 'Historical audit reader identity unavailable')
    try:
        descriptor = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise RuntimeError('Historical before audit receipt unavailable') from None
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and stat.S_IMODE(metadata.st_mode) in (0o600, 0o400)
                and metadata.st_uid in (os.geteuid(), identity['uid']),
                'Historical before audit receipt is not private')
        os.fchown(descriptor, identity['uid'], identity['gid'])
        os.fchmod(descriptor, 0o400)
    except OSError:
        raise RuntimeError('Historical before audit ownership unavailable') from None
    finally:
        os.close(descriptor)


def audit(directory, receipt, *, historical_exception=False, stage=None,
          source=None, before_receipt=None):
    values = environment_values(directory / '.env.aws.production')
    audit_url = values.get('V2_DATA_INTEGRITY_DATABASE_URL')
    require(bool(audit_url), 'Read-only audit database URL missing')
    parts = urlsplit(audit_url)
    require(parts.scheme == 'mysql' and parts.hostname in ('127.0.0.1', 'localhost'),
            'Unexpected read-only audit database host')
    userinfo, separator, _host = parts.netloc.rpartition('@')
    require(bool(separator and userinfo), 'Read-only audit database credentials missing')
    container_url = urlunsplit(parts._replace(
        netloc=f'{userinfo}@mysql' + (f':{parts.port}' if parts.port else '')))
    env = os.environ.copy()
    env['V2_DATA_INTEGRITY_DATABASE_URL'] = container_url
    audit_args = ['node', 'scripts/v2-data-integrity-audit.mjs']
    mounts = ['-v', f'{directory / "scripts"}:/app/scripts:ro']
    if historical_exception:
        require(stage in ('before', 'after') and source is not None,
                'Historical exception audit source missing')
        mounts = ['-v', f'{source / "scripts"}:/app/scripts:ro',
                  '-v', f'{source / "deploy/aws"}:/release-policy:ro']
        audit_args = ['node', 'scripts/v2-release-history-audit.mjs',
                      '--policy=/release-policy/historical-finance-20261005.json',
                      '--expected-current=ed2f75b0f4075347224ce3b2c82a90ed514d8d22',
                      f'--stage={stage}']
        if stage == 'after':
            require(before_receipt is not None, 'Historical before audit missing')
            prepare_historical_before_receipt(directory, before_receipt)
            mounts.extend(['-v', f'{before_receipt}:/release-before-audit.json:ro'])
            audit_args.append('--before-receipt=/release-before-audit.json')
    output = compose(
        directory, 'run', '--rm', '--no-deps',
        *mounts,
        '-e', 'V2_DATA_INTEGRITY_DATABASE_URL',
        'migrate', *audit_args,
        env=env, timeout=240,
    )
    report = json.loads(output)
    if historical_exception:
        gate = report.get('gate', {})
        require(gate.get('accepted') is True and gate.get('policyId') == 'historical-finance-20261005'
                and gate.get('expectedCurrent') == 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22'
                and gate.get('stage') == stage and gate.get('checkCount') == 48
                and report.get('violationCount') == gate.get('violationCount') == 10
                and (stage != 'after' or gate.get('unavailableCheckCount') == 0),
                'Approved historical integrity gate failed')
    else:
        require(report.get('ok') is True and report.get('violationCount') == 0,
                'Financial data integrity audit failed')
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    receipt.chmod(0o600)
    return {'checkCount': report.get('checkCount'), 'violationCount': report.get('violationCount'),
            **({'historicalException': report['gate']} if historical_exception else {})}


def assert_no_active_recharge(directory):
    count = compose(
        directory, 'exec', '-T', 'mysql', 'sh', '-c',
        "mysql --batch --skip-column-names -u root --password=\"$MYSQL_ROOT_PASSWORD\" "
        "\"$MYSQL_DATABASE\" -e \"SELECT COUNT(*) FROM id_business_v2_recharge_jobs "
        "WHERE state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)\"",
    )
    require(count == '0', 'Active recharge jobs prevent release')


def registration_runtime_state(directory):
    # Only the running Worker's authenticated loopback health is read. The token
    # remains in that container; neither response bodies nor exceptions are logged.
    probe = '''import json, os, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
request = urllib.request.Request('http://127.0.0.1:8051/registration/health',
    headers={'X-Recharge-Worker': os.environ.get('AUTO_RECHARGE_WORKER_TOKEN', '')})
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=3) as response:
        value = json.loads(response.read(16384))
    if (not isinstance(value, dict) or value.get('ready') is not True
            or value.get('engine') != 'camoufox'
            or (required_role is not None and value.get('workerRole') != required_role)
            or type(value.get('registrationBusy')) is not bool
            or type(value.get('registrationWindowRetained')) is not bool):
        raise ValueError()
    print(json.dumps({'supported': True,
        'registrationBusy': value['registrationBusy'],
        'registrationWindowRetained': value['registrationWindowRetained']}))
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise SystemExit('Registration runtime guard unavailable') from None
    print(json.dumps({'supported': False}))
except Exception:
    raise SystemExit('Registration runtime guard unavailable') from None
'''
    try:
        service = 'auto-registration' if has_registration_worker(directory) else 'auto-recharge'
        probe = 'required_role = ' + repr('registration' if service == 'auto-registration' else None) + '\n' + probe
        value = json.loads(compose(directory, 'exec', '-T', service,
                                   'python', '-c', probe, timeout=15))
    except Exception:
        raise RuntimeError('Registration runtime guard unavailable') from None
    if (isinstance(value, dict) and set(value) == {'supported'}
            and value['supported'] is False):
        require(service == 'auto-recharge', 'Registration runtime guard unavailable')
        return value
    require(isinstance(value, dict) and set(value) == {
        'supported', 'registrationBusy', 'registrationWindowRetained'}
        and value['supported'] is True
        and type(value['registrationBusy']) is bool
        and type(value['registrationWindowRetained']) is bool,
        'Registration runtime guard unavailable')
    return value


def assert_no_active_registration(directory):
    runtime = registration_runtime_state(directory)
    require(not runtime.get('registrationBusy')
            and not runtime.get('registrationWindowRetained'),
            'Active registration jobs prevent release')
    # A new Worker also protects a dispatched attempt before its profile receipt.
    # Legacy Workers have no built-in windows; only explicit reg_ active attempts
    # are protected there. Historical partial rows alone cannot prove occupancy.
    builtin_filter = '' if runtime['supported'] else (
        ' AND LEFT(browser_profile_id, 4) = 0x7265675f')
    count = compose(
        directory, 'exec', '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM id_business_v2_registration_jobs '
        'WHERE state IN (0x72756e6e696e67, 0x6177616974696e675f656d61696c, '
        '0x6177616974696e675f75736572) AND lease_until > UTC_TIMESTAMP(6)'
        + builtin_filter + '"',
    )
    require(count == '0', 'Active registration jobs prevent release')


def assert_no_active_jobs(directory, *, worker_changes):
    assert_no_active_recharge(directory)
    if worker_changes:
        assert_no_active_registration(directory)


def migration_plan(previous, release):
    old_root = previous / 'apps/api/prisma-mysql/migrations'
    new_root = release / 'apps/api/prisma-mysql/migrations'
    old_files = {str(path.relative_to(old_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in old_root.rglob('*') if path.is_file()}
    new_files = {str(path.relative_to(new_root)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in new_root.rglob('*') if path.is_file()}
    require(all(new_files.get(name) == digest for name, digest in old_files.items()),
            'Existing migration changed or disappeared')
    additions = sorted(set(new_files) - set(old_files))
    for name in additions:
        require(name.endswith('/migration.sql'), 'Unexpected new migration file')
        sql = (new_root / name).read_text()
        require(not re.search(
            r'\bDROP\s+(?:TABLE|COLUMN|INDEX|DATABASE)\b|\bTRUNCATE\s+TABLE\b|'
            r'(?m:^\s*(?:DELETE\s+FROM|UPDATE\s+`?\w+))', sql, re.I),
                f'Migration requires a separate review: {name}')
    return additions


def fresh_backup(previous):
    run('systemctl', 'start', 'id-business-v2-mysql-backup.service', timeout=600)
    require(run('systemctl', 'show', 'id-business-v2-mysql-backup.service',
                '--property=ExecMainStatus', '--value') == '0', 'Backup service failed')
    backups = sorted((BASE / 'backups/mysql').glob('id-business-v2-*.sql.gz'))
    require(bool(backups) and time.time() - backups[-1].stat().st_mtime < 600,
            'No fresh verified backup')
    backup = backups[-1]
    values = environment_values(previous / '.env.aws.production')
    bucket = values['MYSQL_BACKUP_S3_BUCKET']
    region = values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'
    key = values.get('MYSQL_BACKUP_S3_PREFIX', 'mysql/daily').rstrip('/') + '/' + backup.name
    head = json.loads(run('aws', 's3api', 'head-object', '--bucket', bucket, '--key', key,
                          '--checksum-mode', 'ENABLED', '--region', region))
    digest = hashlib.sha256(backup.read_bytes()).digest()
    require(head['ContentLength'] == backup.stat().st_size
            and head.get('ChecksumSHA256') == base64.b64encode(digest).decode()
            and head.get('ServerSideEncryption') == 'AES256', 'S3 backup verification failed')
    return {'name': backup.name, 'sha256': digest.hex(), 'size': backup.stat().st_size,
            's3Verified': True}


def sync_new_table_grants(release, additions):
    tables = []
    for name in additions:
        sql = (release / 'apps/api/prisma-mysql/migrations' / name).read_text()
        tables.extend(re.findall(r'\bCREATE\s+TABLE\s+`([A-Za-z0-9_]+)`', sql, re.I))
    values = environment_values(release / '.env.aws.production')
    parts = urlsplit(values['MIGRATION_DATABASE_URL'])
    require(parts.scheme == 'mysql' and parts.hostname == 'mysql',
            'Unexpected migration database host')
    root_url = urlunsplit(parts._replace(
        netloc=f'root:{quote(values["MYSQL_ROOT_PASSWORD"], safe="")}@mysql'
        + (f':{parts.port}' if parts.port else '')))
    env = os.environ.copy()
    env['DATABASE_URL'] = root_url
    output = compose(
        release, 'run', '--rm', '--no-deps',
        '-v', f'{release / "scripts"}:/app/scripts:ro', '-e', 'DATABASE_URL',
        'migrate', 'node', 'scripts/sync-v2-new-table-grants.mjs', *sorted(set(tables)),
        env=env, timeout=240,
    )
    report = json.loads(output)
    require(report.get('ok') is True, 'New table database grants failed')
    return report


def normalize_worker_isolation(compose_text):
    """Undo only the reviewed split layout for the existing Compose change gate."""
    def worker_block(service):
        matches = re.findall(r'(?ms)^  ' + re.escape(service)
                             + r':\n.*?(?=^  [a-z][a-z0-9-]*:\n|\Z)', compose_text)
        require(len(matches) == 1, 'Invalid independent worker compose layout')
        return matches[0]

    recharge = worker_block('auto-recharge')
    registration = worker_block('auto-registration')
    image = ('    image: &browser-worker-image '
             '${AUTO_RECHARGE_WORKER_IMAGE:-id-business-v2-auto-recharge:local}\n')
    build = ('    build:\n      context: .\n'
             '      dockerfile: apps/api/src/id-business-v2/auto-recharge/worker/Dockerfile\n')
    role = '      AUTO_RECHARGE_WORKER_ROLE: recharge\n'
    require(recharge.count(image) == 1 and recharge.count(build) == 1
            and recharge.count(role) == 1, 'Invalid independent worker compose layout')
    expected = recharge.replace('  auto-recharge:\n', '  auto-registration:\n', 1)
    expected = expected.replace(image, '    image: *browser-worker-image\n', 1)
    expected = expected.replace(build, '', 1).replace(role,
        '      AUTO_RECHARGE_WORKER_ROLE: registration\n', 1)
    expected = expected.replace('      - recharge-control\n', '      - registration-control\n', 1)
    expected = expected.replace('      - recharge-egress\n', '      - registration-egress\n', 1)
    require(registration == expected, 'Invalid independent worker compose layout')
    normalized = compose_text.replace(registration, '', 1)
    normalized = normalized.replace(recharge, recharge.replace(image, '', 1).replace(role, '', 1), 1)
    for binding in (
        '      AUTO_REGISTRATION_WORKER_URL: http://auto-registration:8051\n',
        '      - registration-control\n',
        '  registration-control:\n    internal: true\n  registration-egress:\n',
    ):
        require(normalized.count(binding) == 1, 'Invalid independent worker compose layout')
        normalized = normalized.replace(binding, '', 1)
    return normalized


def configure_google_drive_sync(previous, release):
    old_compose = (previous / 'docker-compose.aws-mysql.yml').read_bytes()
    new_compose = (release / 'docker-compose.aws-mysql.yml').read_bytes()
    old_split = has_registration_worker(previous)
    new_split = has_registration_worker(release)
    require(not old_split or new_split, 'Independent registration worker removed')
    if new_split and not old_split:
        new_compose = normalize_worker_isolation(new_compose.decode()).encode()
    mail_binding = b'      VENDURE_MAILBOX_WEBHOOK_SECRET: ${VENDURE_MAILBOX_WEBHOOK_SECRET:-}\n'
    require(old_compose.count(mail_binding) <= 1 and new_compose.count(mail_binding) <= 1,
            'Duplicate mailbox webhook compose binding')
    if new_compose.count(mail_binding) != old_compose.count(mail_binding):
        require(old_compose.count(mail_binding) == 0 and new_compose.count(mail_binding) == 1,
                'Mailbox webhook compose binding removed')
        new_compose = new_compose.replace(mail_binding, b'')
    config = release / 'deploy/aws/google-drive-sync-folder.json'
    if not config.exists():
        require(new_compose == old_compose, 'Production compose definition changed')
        return None
    destination = json.loads(config.read_text())
    require(isinstance(destination, dict) and set(destination) == {'folderId'}
            and isinstance(destination['folderId'], str)
            and re.fullmatch(r'[A-Za-z0-9_-]{10,200}', destination['folderId']),
            'Invalid reviewed Google Drive folder')
    folder_line = b'      GOOGLE_DRIVE_SYNC_FOLDER_ID: ${GOOGLE_DRIVE_SYNC_FOLDER_ID:-}\n'
    require(new_compose.count(folder_line) == 1, 'Google Drive compose binding changed')
    require(new_compose == old_compose or new_compose.replace(folder_line, b'') == old_compose,
            'Production compose definition changed beyond Google Drive folder binding')
    environment = release / '.env.aws.production'
    text = environment.read_text()
    pattern = r'^GOOGLE_DRIVE_SYNC_FOLDER_ID=.*$'
    require(len(re.findall(pattern, text, re.M)) <= 1, 'Duplicate Google Drive folder setting')
    setting = 'GOOGLE_DRIVE_SYNC_FOLDER_ID=' + destination['folderId']
    if re.search(pattern, text, re.M):
        text = re.sub(pattern, setting, text, flags=re.M)
    else:
        text = text.rstrip('\n') + '\n' + setting + '\n'
    environment.write_text(text)
    environment.chmod(0o600)
    return destination['folderId']


def point_current(directory, suffix):
    link = BASE / f'.current-{suffix}'
    require(not link.exists() and not link.is_symlink(), 'Temporary current link exists')
    link.symlink_to(directory)
    os.replace(link, BASE / 'current')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--source-tree', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--expected-current', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--run-attempt', required=True)
    parser.add_argument('--ci-run-id', required=True)
    parser.add_argument('--image-commit')
    parser.add_argument('--image-run-id')
    parser.add_argument('--image-run-attempt')
    parser.add_argument('--admin-only', action='store_true')
    parser.add_argument('--historical-finance-exception', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch(r'[0-9a-f]{40}', args.commit), 'Invalid commit')
    require(re.fullmatch(r'[0-9a-f]{40}', args.source_tree), 'Invalid source tree')
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_current), 'Invalid current commit')
    require(not args.historical_finance_exception or
            args.expected_current == 'ed2f75b0f4075347224ce3b2c82a90ed514d8d22',
            'Historical release exception cannot be reused after publication')
    require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository), 'Invalid image repository')
    require(re.fullmatch(r'[0-9]+', args.run_id), 'Invalid workflow run')
    require(re.fullmatch(r'[1-9][0-9]*', args.run_attempt), 'Invalid workflow attempt')
    require(re.fullmatch(r'[1-9][0-9]*', args.ci_run_id), 'Invalid Quality Gate run')
    image_commit = args.image_commit or args.commit
    image_run = args.image_run_id or args.run_id
    image_attempt = args.image_run_attempt or args.run_attempt
    require(re.fullmatch(r'[0-9a-f]{40}', image_commit), 'Invalid image commit')
    require(re.fullmatch(r'[1-9][0-9]*', image_run), 'Invalid image workflow run')
    require(re.fullmatch(r'[1-9][0-9]*', image_attempt), 'Invalid image workflow attempt')
    os.umask(0o077)
    lock = (BASE / '.deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = (BASE / 'current').resolve()
    require(previous.parent == BASE / 'releases', 'Invalid current release path')
    old_manifest = json.loads((previous / 'release-manifest.json').read_text())
    require(old_manifest['commit'] == args.expected_current, 'Production baseline changed')
    before = {service: service_state(previous, service) for service in production_services(previous)}
    require(all(state['status'] == 'running' for state in before.values()),
            'A production service is not running')
    require(all(state['health'] == 'healthy' for service, state in before.items()
                if service != 'caddy'), 'A production service is not healthy')
    assert_no_active_jobs(previous, worker_changes=not args.admin_only)

    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    release = BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    require(not release.exists(), 'Release directory already exists')
    release.mkdir(mode=0o700)
    step = 'source'
    changed = []
    try:
        archive = release / '.source.tar.gz'
        url = f'https://github.com/wangchaozhuanyong/id-business-system/archive/{args.commit}.tar.gz'
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        source_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        with tarfile.open(archive, 'r:gz') as source:
            prefix = f'id-business-system-{args.commit}/'
            members = source.getmembers()
            require(all(
                (member.name == prefix[:-1] or member.name.startswith(prefix))
                and '..' not in Path(member.name).parts
                and not member.issym() and not member.islnk()
                for member in members), 'Unsafe source archive entry')
            source.extractall(release)
        extracted = release / f'id-business-system-{args.commit}'
        require(extracted.is_dir(), 'Source archive layout changed')
        for item in extracted.iterdir():
            item.rename(release / item.name)
        extracted.rmdir()
        archive.unlink()
        if image_commit != args.commit:
            url = f'https://github.com/wangchaozhuanyong/id-business-system/archive/{image_commit}.tar.gz'
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read(64 * 1024 * 1024 + 1)
            require(len(data) <= 64 * 1024 * 1024, 'Reusable source archive is too large')
            reusable = io.BytesIO(data)
            with tarfile.open(fileobj=reusable, mode='r:gz') as source:
                verify_reusable_archive(release, source, image_commit)
        shutil.copy2(previous / '.env.aws.production', release / '.env.aws.production')
        (release / '.env.aws.production').chmod(0o600)
        google_drive_folder = configure_google_drive_sync(previous, release)
        additions = migration_plan(previous, release)
        edge_changed = ((previous / 'deploy/caddy/Caddyfile.aws').read_bytes()
                        != (release / 'deploy/caddy/Caddyfile.aws').read_bytes())
        updated_services, image_services = release_services(args.admin_only, additions, edge_changed)
        override = json.loads((previous / 'compose.release.json').read_text())
        image_tags = {service: f'{image_commit}-{image_run}-{image_attempt}-{service}'
                      for service in image_services}
        image_references = release_image_references(
            updated_services, image_services, args.repository, image_tags)
        for service, reference in image_references.items():
            override['services'].setdefault(service, {})['image'] = reference
            override['services'][service]['pull_policy'] = 'never'
        (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require(json.loads(compose(release, 'config', '--format', 'json'))['name'] ==
                json.loads(compose(previous, 'config', '--format', 'json'))['name'],
                'Compose project changed')

        if edge_changed:
            step = 'edge-validation'
            compose(release, 'run', '--rm', '--no-deps', '--pull', 'never',
                    '--entrypoint', 'caddy', 'caddy', 'validate',
                    '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')

        step = 'audit-before'
        before_audit = audit(previous, release / 'before-audit.json',
                             historical_exception=args.historical_finance_exception,
                             stage='before', source=release)
        step = 'images'
        pulled_images = {}
        registry = args.repository.split('/')[0]
        password = run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
        result = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry],
                                input=password, capture_output=True, text=True)
        require(result.returncode == 0, 'ECR login failed')
        try:
            for service in image_services:
                run('docker', 'pull', f'{args.repository}:{image_tags[service]}', timeout=900)
                image = json.loads(run('docker', 'image', 'inspect',
                                       f'{args.repository}:{image_tags[service]}'))[0]
                require(image['Architecture'] == 'amd64'
                        and image['Config']['Labels'].get('org.opencontainers.image.revision') == image_commit,
                        f'{service} image provenance mismatch')
                pulled_images[service] = image['Id']
        finally:
            subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
        require(shutil.disk_usage(BASE).free > 2 * 1024**3, 'Insufficient free disk after pull')

        step = 'backup'
        backup = fresh_backup(previous)
        (release / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
        (release / 'backup-verification.json').chmod(0o600)
        require((BASE / 'current').resolve() == previous, 'Production changed before switch')
        assert_no_active_jobs(previous, worker_changes=not args.admin_only)

        step = 'migration'
        if not args.admin_only:
            compose(release, 'run', '--rm', '--no-deps', 'migrate', timeout=900)
        step = 'database-grants'
        database_grants = sync_new_table_grants(release, additions)
        step = 'switch'
        for service in updated_services:
            changed.append(service)
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    '--force-recreate', service, timeout=300)
            wait_healthy(release, service)
            print(f'HEALTHY {service}', flush=True)

        step = 'audit-after'
        after_audit = audit(release, release / 'after-audit.json',
                            historical_exception=args.historical_finance_exception,
                            stage='after', source=release,
                            before_receipt=release / 'before-audit.json')
        after = {service: service_state(release, service) for service in production_services(release)}
        require(all(after[s] == before[s] for s in before if s not in updated_services),
                'Unrelated service changed')
        require(all(after[s]['image'] == pulled_images[image_service(s)]
                    for s in updated_services if s in SERVICES), 'Running image differs from release')
        public_url = environment_values(release / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        with urllib.request.urlopen(public_url + '/api/health/ready', timeout=20) as response:
            require(response.status == 200, 'Public API readiness failed')
        with urllib.request.urlopen(public_url + '/', timeout=20) as response:
            require(response.status == 200, 'Public admin readiness failed')
            if edge_changed:
                config = (release / 'deploy/caddy/Caddyfile.aws').read_text()
                expected_policy = re.search(r'Content-Security-Policy \"([^\"]+)\"', config)
                require(expected_policy is not None
                        and response.headers.get('Content-Security-Policy') == expected_policy.group(1),
                        'Public edge policy differs from release configuration')

        manifest = dict(old_manifest)
        manifest.update({
            'commit': args.commit, 'sourceBranch': 'main', 'sourceTree': args.source_tree,
            'releaseTag': f'v2-production-{stamp}',
            'ciWorkflow': 'Quality Gate', 'ciWorkflowRunId': int(args.ci_run_id),
            'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'deploymentRun': f'github-actions-{args.run_id}-{args.run_attempt}',
            'imageBuildRun': f'github-actions-{image_run}-{image_attempt}',
            'previousCommit': args.expected_current, 'previousRelease': str(previous),
            'googleDriveSyncFolderId': google_drive_folder,
            'servicesUpdated': list(updated_services), 'sourceArchiveSha256': source_digest,
            'images': {**old_manifest.get('images', {}), **{
                service: {'reference': reference,
                          'digest': after[service]['image'] if service in SERVICES
                          else pulled_images[service], 'sourceCommit': image_commit}
                for service, reference in image_references.items()}},
            'backupBeforeRelease': backup['name'],
            'migrationApplied': bool(additions), 'newMigrations': additions,
            'dataAuditBefore': before_audit, 'dataAuditAfter': after_audit,
            'databaseGrants': database_grants,
            'rollback': {'release': str(previous),
                         'images': {s: before[s]['image'] for s in updated_services if s in before},
                         'servicesAdded': [s for s in updated_services if s not in before]},
        })
        manifest.pop('prCiRunId', None)
        (release / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        point_current(release, f'{stamp}-publish')
        print(json.dumps({'status': 'DEPLOYED', 'commit': args.commit,
                          'releaseTag': manifest['releaseTag'],
                          'servicesUpdated': list(updated_services),
                          'migrationApplied': bool(additions),
                          'backupVerified': True,
                          'auditViolations': after_audit['violationCount']}), flush=True)
    except Exception as error:
        rollback_ok = True
        if (BASE / 'current').resolve() == release:
            try:
                point_current(previous, f'{stamp}-recover')
            except Exception:
                rollback_ok = False
        for service in reversed(changed):
            try:
                rollback_service(previous, release, service, before)
            except Exception:
                rollback_ok = False
        print(json.dumps({'status': 'DEPLOY_FAILED', 'step': step,
                          'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                          'servicesStarted': changed}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--summarize-command-result']:
        print('RELEASE_FAILURE_DIAGNOSTIC ' + json.dumps(command_failure_summary(json.load(sys.stdin))))
    else:
        sys.exit(main())
