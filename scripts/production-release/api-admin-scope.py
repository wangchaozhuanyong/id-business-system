"""Explicit API/Admin publication; no worker, schema or historical-policy mutations."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
import urllib.request

UPDATED = ('api', 'admin')
CONFIG_FILES = ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                'apps/api/prisma-mysql/schema.prisma')
PROOF_FILE = 'api-admin-build-proof.json'
STATE_FILE = 'api-admin-preservation.json'
FAILURE_FILE = 'api-admin-failure.json'


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def content_command(service):
    roots = '/app/apps/api/dist /app/packages/shared/dist' if service == 'api' else '/usr/share/nginx/html'
    return ('set -eu; export LC_ALL=C; for p in ' + roots + '; do test -d "$p"; done; '
            'files="$(find ' + roots + ' -type f -exec sha256sum {} +)"; '
            "printf '%s\\n' \"$files\" | sort")


def content_summary(d, service, output):
    lines = output.splitlines()
    prefixes = ('/app/apps/api/dist/', '/app/packages/shared/dist/') if service == 'api' else ('/usr/share/nginx/html/',)
    d.require(0 < len(lines) < 30000 and len(output) < 8 * 1024 * 1024
              and all(re.fullmatch(r'[a-f0-9]{64}  /[^\r\n]+', line)
                      and line[66:].startswith(prefixes) for line in lines), 'API_ADMIN_CONTENT_INVALID')
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(lines) + '\n').encode()).hexdigest()}


def build_proof(d):
    commit, tree = os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit
              and d.run('git', 'rev-parse', 'HEAD^{tree}') == tree, 'API_ADMIN_BUILD_SOURCE_CHANGED')
    result = {'version': 1, 'commit': commit, 'sourceTree': tree, 'images': {}}
    for service in UPDATED:
        reference = (os.environ['RELEASE_REPOSITORY'] + ':' + commit + '-'
                     + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + service)
        metadata = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        labels = metadata['Config'].get('Labels', {})
        d.require(metadata['Architecture'] == 'amd64'
                  and labels.get('org.opencontainers.image.revision') == commit
                  and labels.get('id-business-v2.source-tree') == tree, 'API_ADMIN_BUILD_LABEL_CHANGED')
        content = content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', reference, '-c', content_command(service)))
        result['images'][service] = {'reference': reference, 'imageId': metadata['Id'], **content}
    target = Path('.deploy/production-release') / PROOF_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': 'API_ADMIN_BUILD_PROVEN', 'proofSha256': fingerprint(result)}))


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    d.require(isinstance(value, dict) and set(value) == {'version', 'commit', 'sourceTree', 'images'}
              and value['version'] == 1 and value['commit'] == commit and value['sourceTree'] == tree
              and set(value['images']) == set(UPDATED), 'API_ADMIN_BUILD_PROOF_INVALID')
    for service, row in value['images'].items():
        d.require(set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
                  and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'])
                  and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
                  and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000
                  and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                                   + commit + r'-[1-9][0-9]*-[1-9][0-9]*-' + service, row['reference']),
                  'API_ADMIN_BUILD_IMAGE_INVALID')
        if repository is not None:
            d.require(row['reference'] == f'{repository}:{commit}-{run_id}-{attempt}-{service}',
                      'API_ADMIN_BUILD_RUN_CHANGED')
    return value


def snapshot(d, directory):
    d.require(set(d.production_services(directory)) == set(d.ALL_SERVICES), 'API_ADMIN_SPLIT_WORKERS_REQUIRED')
    states = {}
    for service in d.ALL_SERVICES:
        row = d.service_state(directory, service, include_container_id=True, include_environment_hash=True)
        metadata = json.loads(d.run('docker', 'inspect', row['containerId']))[0]
        d.require(metadata['Id'] == row['containerId'] and metadata['Image'] == row['image'],
                  'API_ADMIN_CONTAINER_CHANGED')
        mounts = metadata.get('Mounts')
        d.require(isinstance(mounts, list) and all(isinstance(mount, dict)
                  and isinstance(mount.get('Destination'), str) and mount['Destination'].startswith('/')
                  for mount in mounts) and len({mount['Destination'] for mount in mounts}) == len(mounts),
                  'API_ADMIN_CONTAINER_MOUNTS_INVALID')
        # Docker can emit this destination-keyed collection in map iteration order.
        # Preserve every mount field; only collection order is non-semantic.
        configuration = {key: metadata.get(key) for key in ('Config', 'HostConfig')}
        configuration['Mounts'] = sorted(mounts, key=lambda mount: mount['Destination'])
        row['configurationSha256'] = fingerprint(configuration)
        states[service] = row
    d.require(all(row['status'] == 'running' for row in states.values())
              and all(row['health'] == 'healthy' for name, row in states.items() if name != 'caddy'),
              'API_ADMIN_SERVICE_UNHEALTHY')
    return states


def jobs_idle(d, directory):
    d.assert_no_active_recharge(directory)
    runtime = d.registration_runtime_state(directory)
    d.require(runtime.get('supported') is True and runtime.get('registrationBusy') is False
              and type(runtime.get('registrationWindowRetained')) is bool, 'API_ADMIN_REGISTRATION_BUSY')
    database = d.current_job_database(directory)
    count = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM id_business_v2_registration_jobs '
        'WHERE state IN (0x72756e6e696e67, 0x6177616974696e675f656d61696c, '
        '0x6177616974696e675f75736572) AND lease_until > UTC_TIMESTAMP(6)"')
    d.require(count == '0', 'API_ADMIN_REGISTRATION_LEASE_ACTIVE')
    return {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
            'registrationWindowRetained': runtime['registrationWindowRetained']}


def baseline(d, expected, *, check_jobs=True):
    stage = 'MANIFEST'
    try:
        previous = (d.BASE / 'current').resolve()
        d.require(previous.parent == d.BASE / 'releases', 'API_ADMIN_BASELINE_PATH_INVALID')
        raw = (previous / 'release-manifest.json').read_bytes()
        manifest = json.loads(raw)
        d.require(manifest.get('commit') == expected, 'API_ADMIN_BASELINE_CHANGED')
        stage = 'SNAPSHOT'
        states = snapshot(d, previous)
        stage = 'IMAGES'
        for service in d.SERVICES:
            row = manifest.get('images', {}).get(service, {})
            d.require(row.get('reference') == states[service]['reference']
                      and row.get('digest') == states[service]['image'], 'API_ADMIN_BASELINE_IMAGE_CHANGED')
        metadata = json.loads(d.run('docker', 'image', 'inspect', states['api']['image']))[0]
        labels = metadata.get('Config', {}).get('Labels', {})
        d.require(metadata['Id'] == states['api']['image'] and labels.get('org.opencontainers.image.revision')
                  == manifest['images']['api']['sourceCommit'], 'API_ADMIN_BASELINE_API_REVISION_CHANGED')
        source = {'imageId': metadata['Id'], 'revision': labels['org.opencontainers.image.revision']}
        stage = 'PROJECTION'
        if manifest.get('apiAdminPublication'):
            proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
            verify_running(d, previous, proof)
            source['kind'] = 'API_ADMIN_BUILD_PROVEN'
        elif labels.get('id-business-v2.api-projection-sha256'):
            # A later worker-only publication changes the manifest commit/classification,
            # while this immutable API image still comes from the fixed92 build.
            profile_raw = (previous / d.REGISTRATION_RECOVERY_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            d.require(source['revision'] == d.RECHARGE_2F_CURRENT
                      and profile_sha256 == d.RECHARGE_2F_PROFILE_RAW,
                      'API_ADMIN_UNKNOWN_API_PROJECTION')
            profile = d.registration_profile(json.loads(profile_raw), profile_id=d.REGISTRATION_RECOVERY_ID)
            d.registration_recovery_api_hashes(previous, profile)
            d.registration_recovery_image_labels('api', metadata, profile)
            source.update(kind='VERIFIED_EXISTING_API_PROJECTION',
                          profileId=d.REGISTRATION_RECOVERY_ID, profileRawSha256=profile_sha256,
                          projectionSha256=profile['apiProjectionSha256'],
                          compiledSourceSha256=profile['apiCompiledSourceProjectionSha256'])
        else:
            source['kind'] = 'IMMUTABLE_RELEASE_IMAGE'
        free_bytes = shutil.disk_usage(d.BASE).free
        if check_jobs:
            d.require(free_bytes > 6 * 1024**3, 'API_ADMIN_DISK_LOW_BEFORE_PULL')
        stage = 'JOBS'
        guards = jobs_idle(d, previous) if check_jobs else None
        stage = 'SNAPSHOT'
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_POINTER_MOVED')
        d.require((previous / 'release-manifest.json').read_bytes() == raw, 'API_ADMIN_BASELINE_MANIFEST_CHANGED')
        d.require(snapshot(d, previous) == states, 'API_ADMIN_BASELINE_SERVICES_CHANGED')
        return previous, manifest, states, {'manifestSha256': hashlib.sha256(raw).hexdigest(),
            'environmentSha256': hashlib.sha256((previous / '.env.aws.production').read_bytes()).hexdigest(),
            'apiSource': source, 'guards': guards, 'freeBytes': free_bytes}
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = f'API_ADMIN_BASELINE_{stage}_FAILED'
        raise RuntimeError(code) from None


def verify_running(d, directory, proof):
    for service in UPDATED:
        expected = proof['images'][service]
        state = d.service_state(directory, service)
        image = json.loads(d.run('docker', 'image', 'inspect', state['image']))[0]
        labels = image.get('Config', {}).get('Labels', {})
        d.require(state['image'] == image['Id'] == expected['imageId']
                  and state['reference'] == expected['reference'] and image['Architecture'] == 'amd64'
                  and labels.get('org.opencontainers.image.revision') == proof['commit']
                  and labels.get('id-business-v2.source-tree') == proof['sourceTree'],
                  'API_ADMIN_RUNNING_IMAGE_CHANGED')
        measured = content_summary(d, service, d.compose(directory, 'exec', '-T', service,
            '/bin/sh', '-c', content_command(service)))
        d.require(measured == {key: expected[key] for key in ('fileCount', 'sha256')},
                  'API_ADMIN_RUNNING_CONTENT_CHANGED')


def configuration_hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in (*CONFIG_FILES, 'compose.release.json')}


def require_preserved(d, previous, release, before, environment, *, all_services=False):
    d.require((previous / '.env.aws.production').read_bytes() == environment
              and (release / '.env.aws.production').read_bytes() == environment,
              'API_ADMIN_ENVIRONMENT_CHANGED')
    for name in CONFIG_FILES:
        d.require((previous / name).read_bytes() == (release / name).read_bytes(), 'API_ADMIN_CONFIG_OR_SCHEMA_CHANGED')
    d.require(d.migration_plan(previous, release) == [], 'API_ADMIN_MIGRATIONS_FORBIDDEN')
    states = snapshot(d, previous)
    d.require(all(states[name] == before[name] for name in before if all_services or name not in UPDATED),
              'API_ADMIN_PRESERVED_CONTAINER_CHANGED')
    old = json.loads((previous / 'compose.release.json').read_text())
    new = json.loads((release / 'compose.release.json').read_text())
    d.require(set(old) == set(new) == {'services'} and set(old['services']) == set(new['services'])
              and all(old['services'][name] == new['services'][name] for name in old['services'] if name not in UPDATED),
              'API_ADMIN_PRESERVED_IMAGE_REFERENCE_CHANGED')
    return states


def audit_receipt(d, receipt):
    report = json.loads(receipt.read_text())
    checks = report.get('checks', [])
    d.require(report.get('ok') is True and report.get('checkCount') == 49 and report.get('violationCount') == 0
              and isinstance(checks, list) and len(checks) == 49 and len({r.get('code') for r in checks}) == 49
              and all(r.get('count') == 0 for r in checks) and 'gate' not in report, 'API_ADMIN_STRICT_49_FAILED')
    return {'checkCount': 49, 'violationCount': 0, 'mode': 'STRICT_ZERO_49', 'checksSha256': fingerprint(checks)}


def strict_audit(d, directory, receipt):
    d.audit(directory, receipt, api_admin_only=True)
    return audit_receipt(d, receipt)


def source_tree(d, directory):
    tree = {}
    for path in directory.rglob('*'):
        if path.is_dir():
            continue
        d.require(path.is_file() and not path.is_symlink(), 'API_ADMIN_SOURCE_ENTRY_INVALID')
        raw = path.read_bytes()
        parent = tree
        parts = path.relative_to(directory).parts
        for part in parts[:-1]:
            parent = parent.setdefault(part, {})
        parent[parts[-1]] = ('100755' if path.stat().st_mode & 0o111 else '100644',
                            hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).digest())
    def encode(entries):
        raw = b''
        for name, value in sorted(entries.items(), key=lambda item: (item[0] + '/' if isinstance(item[1], dict) else item[0]).encode()):
            mode, oid = ('40000', encode(value)) if isinstance(value, dict) else value
            raw += mode.encode() + b' ' + name.encode() + b'\0' + oid
        return hashlib.sha1(b'tree ' + str(len(raw)).encode() + b'\0' + raw).digest()
    return encode(tree).hex()


def readback(d, expected):
    previous, manifest, states, evidence = baseline(d, expected, check_jobs=False)
    record = json.loads((previous / STATE_FILE).read_text())
    proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
    d.require(manifest.get('servicesUpdated') == list(UPDATED) and manifest.get('migrationApplied') is False
              and manifest.get('newMigrations') == [] and record['buildProofSha256'] == fingerprint(proof)
              and evidence['environmentSha256'] == record['environmentSha256']
              and all(states[name] == record['before'][name] for name in states if name not in UPDATED),
              'API_ADMIN_READBACK_PRESERVATION_FAILED')
    origin = Path(manifest['previousRelease'])
    d.require(origin.parent == d.BASE / 'releases'
              and configuration_hashes(previous) == record['configurationAfter']
              and configuration_hashes(origin) == record['configurationBefore'], 'API_ADMIN_READBACK_CONFIG_CHANGED')
    require_preserved(d, origin, previous, record['before'], (previous / '.env.aws.production').read_bytes())
    d.require(audit_receipt(d, previous / 'before-audit.json') == manifest['dataAuditBefore']
              and audit_receipt(d, previous / 'after-audit.json') == manifest['dataAuditAfter']
              and manifest['dataAuditBefore']['checksSha256'] == manifest['dataAuditAfter']['checksSha256'],
              'API_ADMIN_READBACK_AUDIT_CHANGED')
    verify_running(d, previous, proof)
    d.require(snapshot(d, previous) == states and (d.BASE / 'current').resolve() == previous,
              'API_ADMIN_READBACK_MOVED')
    return {'status': 'API_ADMIN_VERIFIED', 'commit': expected, 'sourceTree': proof['sourceTree'],
            'servicesUpdated': list(UPDATED), 'preservedServiceCount': 5,
            'runningImagesAndContentMatched': True, 'buildProofSha256': fingerprint(proof),
            'environmentUnchanged': True, 'services': states}


def release(d, args):
    os.umask(0o077)
    try:
        with (d.BASE / '.deploy.lock').open('a') as lock:
            d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
            return _release_locked(d, args)
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_CONTROLLER_FAILED'
        print(json.dumps({'status': 'API_ADMIN_FAILED_STATE_UNVERIFIED', 'step': 'controller',
                          'code': code, 'errorType': type(error).__name__}))
        return 1


def _release_locked(d, args):
    d.require(not args.admin_only and not any(value for key, value in vars(args).items()
        if key.startswith(('historical_', 'registration_worker_', 'recharge_pro_')))
        and not any((args.image_commit, args.image_run_id, args.image_run_attempt,
                     args.post_cleanup_seal_sha256, args.order_archive_seal_sha256,
                     args.order_archive_prepared_images_sha256)), 'API_ADMIN_SCOPE_CONFLICT')
    d.require(all(re.fullmatch(r'[a-f0-9]{40}', value or '') for value in
                  (args.commit, args.source_tree, args.expected_current))
              and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release', args.repository)
              and all(re.fullmatch(r'[1-9][0-9]*', value or '') for value in
                      (args.run_id, args.run_attempt, args.ci_run_id)), 'API_ADMIN_INPUT_INVALID')
    proof_raw = base64.b64decode(args.api_admin_build_proof, validate=True)
    d.require(len(proof_raw) < 16384, 'API_ADMIN_BUILD_PROOF_TOO_LARGE')
    proof = validate_proof(d, json.loads(proof_raw), args.commit, args.source_tree,
                          args.repository, args.run_id, args.run_attempt)
    os.umask(0o077)
    previous, old, before, evidence = baseline(d, args.expected_current)
    environment = (previous / '.env.aws.production').read_bytes()
    original_configuration = configuration_hashes(previous)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    target = d.BASE / 'releases' / f'{stamp}-{args.commit[:12]}'
    d.require(not target.exists(), 'API_ADMIN_RELEASE_EXISTS')
    target.mkdir(mode=0o700)
    changed, step = [], 'source'
    try:
        with urllib.request.urlopen(f'https://github.com/wangchaozhuanyong/id-business-system/archive/{args.commit}.tar.gz', timeout=60) as response:
            data = response.read(128 * 1024 * 1024 + 1)
        d.require(len(data) <= 128 * 1024 * 1024, 'API_ADMIN_SOURCE_TOO_LARGE')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            prefix = f'id-business-system-{args.commit}/'
            d.require(all((m.name == prefix[:-1] or m.name.startswith(prefix))
                          and '..' not in Path(m.name).parts and (m.isfile() or m.isdir()) for m in archive.getmembers()),
                      'API_ADMIN_SOURCE_ARCHIVE_INVALID')
            archive.extractall(target)
        extracted = target / prefix[:-1]
        for item in extracted.iterdir():
            item.rename(target / item.name)
        extracted.rmdir()
        d.require(source_tree(d, target) == args.source_tree, 'API_ADMIN_SOURCE_TREE_CHANGED')
        d.require((target / 'scripts/production-release/api-admin-scope.py').read_bytes() == Path(__file__).read_bytes()
                  and (target / 'scripts/production-release/remote-deploy.py').read_bytes() == Path(d.__file__).read_bytes(),
                  'API_ADMIN_EXECUTOR_SOURCE_CHANGED')
        shutil.copy2(previous / '.env.aws.production', target / '.env.aws.production')
        override = json.loads((previous / 'compose.release.json').read_text())
        for name in UPDATED:
            override['services'][name] = {'image': proof['images'][name]['reference'], 'pull_policy': 'never'}
        (target / 'compose.release.json').write_text(json.dumps(override, indent=2) + '\n')
        require_preserved(d, previous, target, before, environment, all_services=True)
        step = 'images'
        d.require(shutil.disk_usage(d.BASE).free > 6 * 1024**3, 'API_ADMIN_DISK_LOW_BEFORE_PULL')
        password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
        registry = args.repository.split('/')[0]
        login = subprocess.run(['docker', 'login', '--username', 'AWS', '--password-stdin', registry], input=password, capture_output=True, text=True)
        d.require(login.returncode == 0, 'API_ADMIN_ECR_LOGIN_FAILED')
        try:
            for name in UPDATED:
                row = proof['images'][name]
                d.run('docker', 'pull', row['reference'], timeout=900)
                image = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
                labels = image['Config'].get('Labels', {})
                d.require(image['Id'] == row['imageId'] and image['Architecture'] == 'amd64'
                          and labels.get('org.opencontainers.image.revision') == args.commit
                          and labels.get('id-business-v2.source-tree') == args.source_tree, 'API_ADMIN_IMAGE_PROVENANCE_FAILED')
        finally:
            subprocess.run(['docker', 'logout', registry], capture_output=True, text=True)
        d.require(shutil.disk_usage(d.BASE).free > 2 * 1024**3, 'API_ADMIN_DISK_LOW')
        step = 'audit-before'
        first = strict_audit(d, target, target / 'before-audit.json')
        step = 'backup'
        backup = d.fresh_backup(previous)
        (target / 'backup-verification.json').write_text(json.dumps(backup, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous and
                  hashlib.sha256((previous / 'release-manifest.json').read_bytes()).hexdigest() == evidence['manifestSha256'],
                  'API_ADMIN_BASELINE_MOVED')
        require_preserved(d, previous, target, before, environment, all_services=True)
        jobs_idle(d, previous)
        step = 'switch'
        for name in ('admin', 'api'):
            require_preserved(d, previous, target, before, environment)
            if name == 'api':
                jobs_idle(d, previous)
            changed.append(name)
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', name, timeout=300)
            d.wait_healthy(target, name)
        step = 'audit-after'
        second = strict_audit(d, target, target / 'after-audit.json')
        d.require(first['checksSha256'] == second['checksSha256'], 'API_ADMIN_AUDIT_RULES_CHANGED')
        verify_running(d, target, proof)
        after = require_preserved(d, previous, target, before, environment)
        public = d.environment_values(target / '.env.aws.production')['APP_PUBLIC_URL'].rstrip('/')
        for suffix in ('/api/health/ready', '/'):
            with urllib.request.urlopen(public + suffix, timeout=20) as response:
                d.require(response.status == 200, 'API_ADMIN_PUBLIC_HEALTH_FAILED')
        after = require_preserved(d, previous, target, before, environment)
        record = {'before': before, 'after': after, 'environmentSha256': evidence['environmentSha256'],
                  'baselineEvidence': evidence, 'buildProofSha256': fingerprint(proof),
                  'configurationBefore': configuration_hashes(previous), 'configurationAfter': configuration_hashes(target)}
        (target / STATE_FILE).write_text(json.dumps(record, indent=2) + '\n')
        (target / PROOF_FILE).write_text(json.dumps(proof, indent=2) + '\n')
        manifest = {'images': old['images'],
                    'previousManifestSha256': evidence['manifestSha256']}
        manifest.update(commit=args.commit, sourceBranch='main', sourceTree=args.source_tree,
            previousCommit=args.expected_current, previousRelease=str(previous),
            releaseTag=f'v2-production-{stamp}', deployedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            ciWorkflow='Quality Gate', ciWorkflowRunId=int(args.ci_run_id),
            deploymentRun=f'github-actions-{args.run_id}-{args.run_attempt}',
            imageBuildRun=f'github-actions-{args.run_id}-{args.run_attempt}',
            servicesUpdated=list(UPDATED), sourceArchiveSha256=hashlib.sha256(data).hexdigest(),
            images={**old['images'], **{name: {'reference': proof['images'][name]['reference'],
                'digest': proof['images'][name]['imageId'], 'sourceCommit': args.commit} for name in UPDATED}},
            backupBeforeRelease=backup['name'], migrationApplied=False, newMigrations=[],
            dataAuditBefore=first, dataAuditAfter=second,
            databaseGrants={'status': 'SKIPPED', 'reason': 'API_ADMIN_UNCHANGED_SCHEMA'},
            rollback={'release': str(previous), 'images': {name: before[name]['image'] for name in UPDATED}, 'servicesAdded': []},
            apiAdminPublication={'version': 1, 'scope': 'API_ADMIN', 'buildProofSha256': fingerprint(proof),
                                 'workersPublished': False, 'cacheStatus': 'SKIPPED', 'configurationChanged': False})
        (target / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_MOVED')
        d.point_current(target, f'{stamp}-publish')
        result = readback(d, args.commit)
        result.update(backupVerified=True, checkCount=49, violationCount=0)
        print(json.dumps(result))
        return 0
    except Exception as error:
        # A new task may start after the last idle read. Do not interrupt it to
        # force rollback. Keep an explicit partial-state receipt for recovery.
        rollback_ok = True
        rollback = {}
        for name in reversed(changed):
            try:
                if name == 'api':
                    jobs_idle(d, target)
                d.rollback_service(previous, target, name, before)
                rollback[name] = 'RESTORED'
            except Exception:
                rollback[name] = 'BLOCKED_OR_FAILED'
                rollback_ok = False
        if rollback_ok:
            try:
                restored = snapshot(d, previous)
                d.require((previous / '.env.aws.production').read_bytes() == environment
                          and configuration_hashes(previous) == original_configuration
                          and all(restored[name] == before[name] for name in before if name not in UPDATED)
                          and all(restored[name]['image'] == before[name]['image']
                                  and restored[name]['reference'] == before[name]['reference'] for name in UPDATED),
                          'API_ADMIN_ROLLBACK_NOT_RESTORED')
            except Exception:
                rollback_ok = False
        if rollback_ok and (d.BASE / 'current').resolve() == target:
            try:
                d.point_current(previous, f'{stamp}-recover')
            except Exception:
                rollback_ok = False
        actual = {}
        for name in d.ALL_SERVICES:
            try:
                actual[name] = d.service_state(previous, name, include_container_id=True,
                                               include_environment_hash=True)
            except Exception:
                actual[name] = {'status': 'UNAVAILABLE'}
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_STEP_FAILED'
        result = {'status': 'API_ADMIN_FAILED_RESTORED' if changed and rollback_ok
                  else 'API_ADMIN_FAILED_BEFORE_SWITCH' if not changed and rollback_ok else 'API_ADMIN_PARTIAL_RECOVERY_REQUIRED',
                  'step': step, 'code': code, 'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                  'servicesAttempted': changed, 'rollback': rollback, 'actualServices': actual,
                  'candidateCommit': args.commit, 'previousCommit': args.expected_current,
                  'currentPointsToCandidate': (d.BASE / 'current').resolve() == target}
        result['receiptPersisted'] = True
        try:
            (target / FAILURE_FILE).write_text(json.dumps(result, indent=2) + '\n')
        except Exception:
            result['receiptPersisted'] = False
        print(json.dumps(result))
        return 1
