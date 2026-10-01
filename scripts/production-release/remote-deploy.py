#!/usr/bin/env python3
"""Run one exact, guarded production release on the existing EC2 instance."""

import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.parse import quote, urlsplit, urlunsplit
import urllib.request


BASE = Path('/opt/id-business-v2')
SERVICES = ('media-resolver', 'auto-recharge', 'api', 'admin')
ALL_SERVICES = (*SERVICES, 'mysql', 'caddy')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def release_services(admin_only, additions):
    require(not (admin_only and additions), 'Admin-only release contains migrations')
    services = ('admin',) if admin_only else SERVICES
    return services, services if admin_only else (*services, 'migrate')


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
        if state['status'] == 'running' and state['health'] == 'healthy':
            return state
        if state['status'] not in ('running', 'created'):
            break
        time.sleep(2)
    raise RuntimeError(f'{service} did not become healthy')


def audit(directory, receipt):
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
    output = compose(
        directory, 'run', '--rm', '--no-deps',
        '-v', f'{directory / "scripts"}:/app/scripts:ro',
        '-e', 'V2_DATA_INTEGRITY_DATABASE_URL',
        'migrate', 'node', 'scripts/v2-data-integrity-audit.mjs',
        env=env, timeout=240,
    )
    report = json.loads(output)
    require(report.get('ok') is True and report.get('violationCount') == 0,
            'Financial data integrity audit failed')
    receipt.write_text(json.dumps(report, indent=2) + '\n')
    receipt.chmod(0o600)
    return {'checkCount': report.get('checkCount'), 'violationCount': 0}


def assert_no_active_recharge(directory):
    count = compose(
        directory, 'exec', '-T', 'mysql', 'sh', '-c',
        "mysql --batch --skip-column-names -u root --password=\"$MYSQL_ROOT_PASSWORD\" "
        "\"$MYSQL_DATABASE\" -e \"SELECT COUNT(*) FROM id_business_v2_recharge_jobs "
        "WHERE state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)\"",
    )
    require(count == '0', 'Active recharge jobs prevent release')


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
    parser.add_argument('--admin-only', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch(r'[0-9a-f]{40}', args.commit), 'Invalid commit')
    require(re.fullmatch(r'[0-9a-f]{40}', args.source_tree), 'Invalid source tree')
    require(re.fullmatch(r'[0-9a-f]{40}', args.expected_current), 'Invalid current commit')
    require(re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository), 'Invalid image repository')
    require(re.fullmatch(r'[0-9]+', args.run_id), 'Invalid workflow run')
    require(re.fullmatch(r'[1-9][0-9]*', args.run_attempt), 'Invalid workflow attempt')
    require(re.fullmatch(r'[1-9][0-9]*', args.ci_run_id), 'Invalid Quality Gate run')
    os.umask(0o077)
    lock = (BASE / '.deploy.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = (BASE / 'current').resolve()
    require(previous.parent == BASE / 'releases', 'Invalid current release path')
    old_manifest = json.loads((previous / 'release-manifest.json').read_text())
    require(old_manifest['commit'] == args.expected_current, 'Production baseline changed')
    before = {service: service_state(previous, service) for service in ALL_SERVICES}
    require(all(state['status'] == 'running' for state in before.values()),
            'A production service is not running')
    require(all(state['health'] == 'healthy' for service, state in before.items()
                if service != 'caddy'), 'A production service is not healthy')
    assert_no_active_recharge(previous)

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
        shutil.copy2(previous / '.env.aws.production', release / '.env.aws.production')
        (release / '.env.aws.production').chmod(0o600)
        require((release / 'docker-compose.aws-mysql.yml').read_bytes() ==
                (previous / 'docker-compose.aws-mysql.yml').read_bytes(),
                'Production compose definition changed')
        additions = migration_plan(previous, release)
        updated_services, image_services = release_services(args.admin_only, additions)
        override = json.loads((previous / 'compose.release.json').read_text())
        image_tags = {service: f'{args.commit}-{args.run_id}-{args.run_attempt}-{service}'
                      for service in image_services}
        for service in image_services:
            override['services'].setdefault(service, {})['image'] = (
                f'{args.repository}:{image_tags[service]}')
            override['services'][service]['pull_policy'] = 'never'
        (release / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require(json.loads(compose(release, 'config', '--format', 'json'))['name'] ==
                json.loads(compose(previous, 'config', '--format', 'json'))['name'],
                'Compose project changed')

        step = 'audit-before'
        before_audit = audit(previous, release / 'before-audit.json')
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
                        and image['Config']['Labels'].get('org.opencontainers.image.revision') == args.commit,
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
        assert_no_active_recharge(previous)

        step = 'migration'
        if not args.admin_only:
            compose(release, 'run', '--rm', '--no-deps', 'migrate', timeout=900)
        step = 'database-grants'
        database_grants = sync_new_table_grants(release, additions)
        step = 'switch'
        for service in updated_services:
            compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    '--force-recreate', service, timeout=300)
            changed.append(service)
            wait_healthy(release, service)
            print(f'HEALTHY {service}', flush=True)

        step = 'audit-after'
        after_audit = audit(release, release / 'after-audit.json')
        after = {service: service_state(release, service) for service in ALL_SERVICES}
        require(all(after[s] == before[s] for s in ALL_SERVICES if s not in updated_services),
                'Unrelated service changed')
        public_url = environment_values(release / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        with urllib.request.urlopen(public_url + '/api/health/ready', timeout=20) as response:
            require(response.status == 200, 'Public API readiness failed')
        with urllib.request.urlopen(public_url + '/', timeout=20) as response:
            require(response.status == 200, 'Public admin readiness failed')

        manifest = dict(old_manifest)
        manifest.update({
            'commit': args.commit, 'sourceBranch': 'main', 'sourceTree': args.source_tree,
            'releaseTag': f'v2-production-{stamp}',
            'ciWorkflow': 'Quality Gate', 'ciWorkflowRunId': int(args.ci_run_id),
            'deployedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'deploymentRun': f'github-actions-{args.run_id}-{args.run_attempt}',
            'previousCommit': args.expected_current, 'previousRelease': str(previous),
            'servicesUpdated': list(updated_services), 'sourceArchiveSha256': source_digest,
            'images': {**old_manifest.get('images', {}), **{
                service: {'reference': f'{args.repository}:{image_tags[service]}',
                          'digest': after[service]['image'] if service in SERVICES
                          else pulled_images[service], 'sourceCommit': args.commit}
                for service in image_services}},
            'backupBeforeRelease': backup['name'],
            'migrationApplied': bool(additions), 'newMigrations': additions,
            'dataAuditBefore': before_audit, 'dataAuditAfter': after_audit,
            'databaseGrants': database_grants,
            'rollback': {'release': str(previous),
                         'images': {s: before[s]['image'] for s in updated_services}},
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
                compose(previous, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                        '--force-recreate', service, timeout=300)
                require(service_state(previous, service)['image'] == before[service]['image'],
                        'Rollback image mismatch')
                wait_healthy(previous, service)
            except Exception:
                rollback_ok = False
        print(json.dumps({'status': 'DEPLOY_FAILED', 'step': step,
                          'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                          'servicesStarted': changed}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
