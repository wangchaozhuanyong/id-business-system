"""Explicit two-service publication with a separately approved, finite migration mode."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.request

SCOPE = globals().get('SCOPE', 'API_ADMIN')
if SCOPE not in ('API_ADMIN', 'API_REGISTRATION', 'API_ADMIN_MIGRATION'):
    raise ValueError('API_ADMIN_SCOPE_CONFLICT')
REGISTRATION = SCOPE == 'API_REGISTRATION'
MIGRATION_MODE = SCOPE == 'API_ADMIN_MIGRATION'
UPDATED = ('api', 'auto-registration') if REGISTRATION else ('api', 'admin')
IMAGE_SERVICES = (*UPDATED, 'migrate') if MIGRATION_MODE else UPDATED
SWITCH_ORDER = ('api', 'auto-registration') if REGISTRATION else ('admin', 'api')
PREFIX = SCOPE.lower().replace('_', '-')
CONFIG_FILES = ('docker-compose.aws-mysql.yml', 'deploy/caddy/Caddyfile.aws',
                'apps/api/prisma-mysql/schema.prisma')
PROOF_FILE = PREFIX + '-build-proof.json'
STATE_FILE = PREFIX + '-preservation.json'
FAILURE_FILE = PREFIX + '-failure.json'
WORKER_PREFIX = 'apps/api/src/id-business-v2/auto-recharge/worker/'
WORKER_PAIR = frozenset(WORKER_PREFIX + n for n in ('registration_browser.py', 'test_registration_browser.py'))
# These reviewed main-only Python changes are absent from the API runtime.
# Registration still uses its sealed 60-file projection; Pro is preserved.
UNPUBLISHED_PRICING = {WORKER_PREFIX + 'plan_selection.py':
    '123f6f30d4b01db6efef213100f4b5b90f211064d2eacfc7ffb3bcf28ecf8604',
    WORKER_PREFIX + 'test_pro.py':
    '3898ba5a47a9911eca8c05bdec4c48768d4ad2499f1bba6b39c4d6039c53a5f6'}
API_CHANGES = frozenset('apps/api/src/id-business-v2/auto-registration/' + n for n in (
    'registration-events.service.ts', 'registration-events.service.spec.ts',
    'registration-mail-delivery.service.ts', 'registration-mail-delivery.service.spec.ts'))
API_INPUTS = ('apps/api', 'packages/shared', 'apps/admin/package.json', 'package.json', 'package-lock.json',
              'npm-shrinkwrap.json', '.npmrc', 'tsconfig.base.json', '.dockerignore')
# The measured current release is the starting point, not an exception to its gates.
REGISTRATION_CURRENT = 'e7c9862d58599995954883f1c1f6038283afffab'
REGISTRATION_DIRECTORY = '/opt/id-business-v2/releases/20261008T020705Z-e7c9862d5859'
REGISTRATION_MANIFEST_SHA = '52f2582e5edeb9e1c9af63c70fff4ca5a5bdad11c0fd7fb8f090fd1670b4c2eb'
REGISTRATION_PROFILE = 'deploy/aws/registration-worker-96-20261008.json'
REGISTRATION_PROFILE_SHA = '642440292a6a1f25a73cb155398c03eb396453e59f9bd229d617b5f60b079299'
REGISTRATION_PUBLIC = {'fileCount': 2202, 'sha256': 'f5ab426496c2fd55733d7c5f660139e3d496c04c1e72279870cf08e5de2a1bce'}
REGISTRATION_STATES_SHA = 'ff4e380eff0b5ae323bb6faf62649d0b1be47ba39b7dcd75dd66701fd86f5e21'
REGISTRATION_API_CONTENT = {'fileCount': 1574, 'sha256': '5834bc435b9e9296d5cc482368d631cb18a06504bb5535d983f46c9fe0cfd2b5'}
REGISTRATION_PRIVATE = frozenset(('.env.aws.production', 'compose.release.json', 'release-manifest.json',
    'before-audit.json', 'after-audit.json', 'backup-verification.json', 'order-archive-seal.reader.json',
    'order-archive-cleanup.reader.json', 'registration-recovery-audit.compose.json',
    'api-admin-build-proof.json', 'api-admin-preservation.json'))
TASK_ID = '252ab243-d96b-4928-8116-b83dedc1d240'
TASK_ATTEMPT = 12 if MIGRATION_MODE else 10
TASK_BINDING = {'accountSha256': '4764c0440ec5bde3d20c74064096b3720a3d7d6ac637361452b9f544b9287ba5',
    'profileSha256': '052ad861dc0da2f8611d422bd384e328e1d856a126bc86434846861f90728f00',
    'ownerSha256': 'ed198d0daf9ef5910f54dc16b3a7a6f4db0cf55c1935309f838071365ab7196d'}
# Captured by the read-only 18e task inspection; these are keyed digests, not credentials.
MIGRATION_TASK = {'taskId': TASK_ID, 'attempt': 12, 'state': 'partial', 'step': 'password',
    'reason': 'session_load_timeout', 'updatedAt': '2026-10-08T14:18:32.726Z',
    'registered': True, 'passwordVerified': False, 'mfaVerified': False, 'leaseActive': False,
    'noncePresent': False, 'passwordCandidatePresent': True, 'binding': TASK_BINDING,
    'emailHashHmac': '99e7d0edf61acf0d0228c67fa52bdf3065e86dda2356d06b8dc6f44125a3429b',
    'jobHmac': '78bc1a85e9857512b534e8b23d6beae677f15cd45bbc76253812bc65396003f9',
    'accountHmac': '763310b009d8c2c099ac94d2265570d9ca9d2886dcd6eb31d3133556571f3e9a',
    'auditHmac': '500789997c0d6f006b7c70a07f21be06b1785b355eba2c36e10f3eb37d75edac',
    'auditCount': 5}
HANDOFF_FAILURE = {'confirmed': False, 'privatePostAttempted': True, 'failurePhase': 'close',
    'privatePostHttpStatus': 409, 'controlledReason': 'fingerprint_cleanup_failed', 'rawOutputSuppressed': True}
MIGRATION_NAME = '20261008180000_quick_action_user_order'
MIGRATION_FILE = MIGRATION_NAME + '/migration.sql'
MIGRATION_ROOT = 'apps/api/prisma-mysql/migrations'
MIGRATION_SCHEMA = 'apps/api/prisma-mysql/schema.prisma'
MIGRATION_IDENTITY = {
    'name': MIGRATION_NAME,
    'sha256': '2617684e1c9c4f7ecf5cc40009239c2972d9569c3c1cea1324ecfe5d58871678',
    'schemaBeforeSha256': 'c70cbcb110bb48c395b7e7284dedc0486a9afc125d940c455c0bafc1cffc701d',
    'schemaAfterSha256': '8006d3ce6f0b44cf62f3b47bb7b4a0b14d0ddc18ddf113a5da34a901b62fb197',
    'baselineFilesSha256': 'c2179090dd600b3b33a56fe8384e8a7020a4e0cb6eb9a97f509352ee22f4df0a'}


def image_service(service):
    return 'auto-recharge' if service == 'auto-registration' else service


def registration_profile(d, root):
    raw = (root / REGISTRATION_PROFILE).read_bytes()
    d.require(hashlib.sha256(raw).hexdigest() == REGISTRATION_PROFILE_SHA, 'API_ADMIN_REGISTRATION_PROFILE_CHANGED')
    value = json.loads(raw)
    rows = value['workerProjection']
    d.require(value['enabled'] is True and len(rows) == 60
              and value['workerProjectionSha256'] == fingerprint(rows)
              and all(n.startswith(WORKER_PREFIX) and re.fullmatch(r'[A-Za-z0-9_.-]+', n[len(WORKER_PREFIX):])
                      and set(r) == {'mode', 'sha256'} and r['mode'] in ('100644', '100755')
                      and re.fullmatch(r'[a-f0-9]{64}', r['sha256']) for n, r in rows.items()),
              'API_ADMIN_REGISTRATION_PROFILE_CHANGED')
    return value


def registration_candidate_scope(d, commit):
    known = frozenset(WORKER_PREFIX + n for n in ('plan_selection.py', 'registration_browser.py',
                                                'test_pro.py', 'test_registration_browser.py'))
    old = d.run('git', 'diff', '--name-only', '815fae391b172d6c368ea2ad25225f52a1272808',
                REGISTRATION_CURRENT, '--', *API_INPUTS).splitlines()
    changed = d.run('git', 'diff', '--name-only', REGISTRATION_CURRENT, commit, '--', *API_INPUTS).splitlines()
    carried = set(changed) & set(UNPUBLISHED_PRICING)
    d.require(set(old) == known and carried in (set(), set(UNPUBLISHED_PRICING))
              and set(changed) == API_CHANGES | WORKER_PAIR | carried,
              'API_ADMIN_REGISTRATION_API_SCOPE_CHANGED')
    d.require(all(hashlib.sha256(subprocess.check_output(['git', 'show', commit + ':' + name])).hexdigest()
                  == UNPUBLISHED_PRICING[name] for name in carried), 'API_ADMIN_REGISTRATION_API_SCOPE_CHANGED')


def prepare_registration_build(d):
    root = Path.cwd()
    commit = os.environ['RELEASE_COMMIT']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit
              and d.run('git', 'rev-parse', 'HEAD^{tree}') == os.environ['SOURCE_TREE'],
              'API_ADMIN_BUILD_SOURCE_CHANGED')
    registration_candidate_scope(d, commit)
    profile = registration_profile(d, root)
    target = root / '.deploy/production-release/api-registration-build-context'
    d.require(not target.exists() and not target.is_symlink(), 'API_ADMIN_REGISTRATION_CONTEXT_EXISTS')
    files = {}
    for name, row in profile['workerProjection'].items():
        revision = profile['carriedSourceCommits'].get(name, profile['workerBasisCommit'])
        if name in profile['registrationSourceSha256']:
            revision = profile['registrationSourceCommit']
        raw = subprocess.check_output(['git', 'show', revision + ':' + name])
        d.require(hashlib.sha256(raw).hexdigest() == row['sha256'], 'API_ADMIN_REGISTRATION_BASIS_CHANGED')
        if name in WORKER_PAIR:
            raw = (root / name).read_bytes()
            d.require(raw == subprocess.check_output(['git', 'show', commit + ':' + name])
                      and hashlib.sha256(raw).hexdigest() != row['sha256'], 'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        files[name] = raw
    projection = {n: {'mode': profile['workerProjection'][n]['mode'],
                      'sha256': hashlib.sha256(raw).hexdigest()} for n, raw in files.items()}
    d.require({n for n in projection if projection[n] != profile['workerProjection'][n]} == WORKER_PAIR,
              'API_ADMIN_REGISTRATION_PAIR_CHANGED')
    for name, digest in profile['buildInputSha256'].items():
        raw = (root / name).read_bytes()
        d.require(hashlib.sha256(raw).hexdigest() == digest, 'API_ADMIN_REGISTRATION_BUILD_INPUT_CHANGED')
        files[name] = raw
    target.mkdir(parents=True, mode=0o700)
    for name, raw in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        path.chmod(0o755 if projection.get(name, {}).get('mode') == '100755' else 0o644)
    record = {'workerProjection': projection, 'workerProjectionSha256': fingerprint(projection)}
    path = target.parent / 'api-registration-build-projection.json'
    with path.open('x') as stream:
        json.dump(record, stream, sort_keys=True)
    path.chmod(0o600)
    # Build the API from the exact Git archive, never ignored/uncommitted files
    # in the runner checkout. The existing API Dockerfile and dependencies apply.
    api_target = target.parent / 'api-registration-api-build-context'
    archive = subprocess.check_output(['git', 'archive', '--format=tar', '--prefix=id-business-system-' + commit + '/', commit])
    source = d.registration_archive(archive, commit)
    d.write_registration_files(api_target, source)
    d.require(source_tree(d, api_target) == os.environ['SOURCE_TREE'], 'API_ADMIN_BUILD_SOURCE_CHANGED')
    return record


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def migration_files(d, directory):
    root = directory / MIGRATION_ROOT
    paths = list(root.rglob('*'))
    d.require(root.is_dir() and not root.is_symlink() and len(paths) < 200,
              'API_ADMIN_MIGRATION_SOURCE_INVALID')
    rows = {}
    for path in paths:
        d.require(not path.is_symlink(), 'API_ADMIN_MIGRATION_SOURCE_INVALID')
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        d.require(path.is_file() and path.stat().st_size < 8 * 1024**2
                  and (name == 'migration_lock.toml' or re.fullmatch(r'[0-9]{14}_[a-z0-9_]+/migration.sql', name)),
                  'API_ADMIN_MIGRATION_SOURCE_INVALID')
        rows[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return rows


def migration_source_check(d, directory=None, *, candidate=True):
    d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
    directory = Path.cwd() if directory is None else directory
    rows = migration_files(d, directory)
    schema = directory / MIGRATION_SCHEMA
    d.require(schema.is_file() and not schema.is_symlink(), 'API_ADMIN_MIGRATION_SOURCE_INVALID')
    digest = hashlib.sha256(schema.read_bytes()).hexdigest()
    added = rows.pop(MIGRATION_FILE, None)
    d.require(len(rows) == 46 and fingerprint(rows) == MIGRATION_IDENTITY['baselineFilesSha256']
              and ((added == MIGRATION_IDENTITY['sha256'] and digest == MIGRATION_IDENTITY['schemaAfterSha256'])
                   or (not candidate and added is None and digest == MIGRATION_IDENTITY['schemaBeforeSha256'])),
              'API_ADMIN_MIGRATION_SCOPE_CHANGED')
    return dict(MIGRATION_IDENTITY)


def migration_database_state(d, directory):
    migration_source_check(d, directory, candidate=False)
    expected = {n.split('/')[0]: digest for n, digest in migration_files(d, directory).items() if n.endswith('/migration.sql')}
    expected[MIGRATION_NAME] = MIGRATION_IDENTITY['sha256']
    query = """SELECT JSON_OBJECT('rows', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
        'name', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL,
        'rolledBack', rolled_back_at IS NOT NULL)) FROM _prisma_migrations),
        'columns', (SELECT JSON_ARRAYAGG(JSON_OBJECT('type', DATA_TYPE, 'columnType', COLUMN_TYPE,
        'nullable', IS_NULLABLE, 'default', COLUMN_DEFAULT, 'extra', EXTRA))
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_quick_actions' AND COLUMN_NAME='sort_order'),
        'indexes', (SELECT JSON_ARRAYAGG(JSON_OBJECT('column', COLUMN_NAME, 'sequence', SEQ_IN_INDEX,
        'nonUnique', NON_UNIQUE, 'type', INDEX_TYPE, 'prefix', SUB_PART))
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='id_business_v2_quick_actions'
        AND INDEX_NAME='id_business_v2_quick_actions_user_id_deleted_at_sort_order_idx'))"""
    database = d.current_job_database(directory)
    raw = d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'mysql --batch --skip-column-names -u root --password="$MYSQL_ROOT_PASSWORD" '
        '"$MYSQL_DATABASE" -e "' + ' '.join(query.split()) + '"', timeout=60)
    d.require(len(raw) < 65536, 'API_ADMIN_MIGRATION_DATABASE_INVALID')
    value = json.loads(raw)
    d.require(isinstance(value, dict) and set(value) == {'rows', 'columns', 'indexes'}
              and isinstance(value['rows'], list) and len(value['rows']) < 200,
              'API_ADMIN_MIGRATION_DATABASE_INVALID')
    completed = {}
    for row in value['rows']:
        d.require(isinstance(row, dict) and set(row) == {'name', 'checksum', 'finished', 'rolledBack'}
                  and row['name'] in expected and row['checksum'] == expected[row['name']]
                  and all(type(row[n]) in (bool, int) and row[n] in (0, 1) for n in ('finished', 'rolledBack'))
                  and row['finished'] + row['rolledBack'] == 1,
                  'API_ADMIN_MIGRATION_HISTORY_CHANGED')
        if row['finished']:
            d.require(row['name'] not in completed, 'API_ADMIN_MIGRATION_HISTORY_CHANGED')
            completed[row['name']] = row['checksum']
    applied = MIGRATION_NAME in completed
    d.require(set(completed) == set(expected) if applied else set(completed) == set(expected) - {MIGRATION_NAME},
              'API_ADMIN_MIGRATION_HISTORY_CHANGED')
    columns, indexes = value['columns'] or [], value['indexes'] or []
    if applied:
        d.require(columns == [{'type': 'int', 'columnType': 'int', 'nullable': 'YES', 'default': None, 'extra': ''}]
                  and isinstance(indexes, list) and len(indexes) == 3
                  and sorted(indexes, key=lambda row: row.get('sequence', 0)) == [
                      {'column': name, 'sequence': index, 'nonUnique': 1, 'type': 'BTREE', 'prefix': None}
                      for index, name in enumerate(('user_id', 'deleted_at', 'sort_order'), 1)],
                  'API_ADMIN_MIGRATION_SCHEMA_CHANGED')
    else:
        d.require(columns == [] and indexes == [], 'API_ADMIN_MIGRATION_SCHEMA_CHANGED')
    return {'name': MIGRATION_NAME, 'sha256': MIGRATION_IDENTITY['sha256'],
            'status': 'APPLIED' if applied else 'PENDING', 'schemaVerified': True,
            'appliedMigrationsSha256': fingerprint(completed)}


def migration_task_guard(d, directory, task, guards):
    d.require(guards.get('registrationWindowRetained') is True
              and jobs_idle(d, directory) == guards and registration_task(d, directory) == task,
              'API_ADMIN_REGISTRATION_TASK_CHANGED')
    registration_private(d, directory, retained=guards['registrationWindowRetained'])


def migration_preflight(d, expected):
    d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
    directory, manifest, states, evidence = baseline(d, expected)
    task = registration_task(d, directory)
    migration_task_guard(d, directory, task, evidence['guards'])
    audit = strict_audit(d, directory, Path(__file__).parent / (PREFIX + '-preflight-audit.json'))
    d.require(snapshot(d, directory) == states, 'API_ADMIN_REGISTRATION_PREFLIGHT_CHANGED')
    migration_task_guard(d, directory, task, evidence['guards'])
    return {'status': SCOPE + '_BASELINE_VERIFIED', 'commit': expected, 'services': states,
            **evidence, 'task': task, 'audit': audit, 'migration': dict(MIGRATION_IDENTITY),
            'windowPreserved': True, 'requiresWindowHandoff': False}


def apply_migration(d, directory):
    before = migration_database_state(d, directory)
    if before['status'] == 'APPLIED':
        return {**before, 'performed': False}
    try:
        d.compose(directory, 'run', '--rm', '--no-deps', '--pull', 'never', 'migrate', timeout=600)
    except Exception:
        raise RuntimeError('API_ADMIN_MIGRATION_EXECUTION_FAILED') from None
    after = migration_database_state(d, directory)
    d.require(after['status'] == 'APPLIED', 'API_ADMIN_MIGRATION_NOT_APPLIED')
    return {**after, 'performed': True}


def migration_content(d, directory):
    rows = {('/app/' + MIGRATION_ROOT + '/' + name): digest for name, digest in migration_files(d, directory).items()}
    rows['/app/' + MIGRATION_SCHEMA] = hashlib.sha256((directory / MIGRATION_SCHEMA).read_bytes()).hexdigest()
    return content_summary(d, 'migrate', '\n'.join(sorted(digest + '  ' + name for name, digest in rows.items())))


def verify_migration_image(d, directory, proof, *, inspect_content=False):
    row = proof['images']['migrate']
    override = json.loads((directory / 'compose.release.json').read_text())
    d.require(override['services']['migrate'] == {'image': row['reference'], 'pull_policy': 'never'},
              'API_ADMIN_MIGRATION_IMAGE_CHANGED')
    image = json.loads(d.run('docker', 'image', 'inspect', row['reference']))[0]
    labels = image['Config'].get('Labels', {})
    d.require(image['Id'] == row['imageId'] and image['Architecture'] == 'amd64'
              and labels.get('org.opencontainers.image.revision') == proof['commit']
              and labels.get('id-business-v2.source-tree') == proof['sourceTree'],
              'API_ADMIN_MIGRATION_IMAGE_CHANGED')
    expected = migration_content(d, directory)
    d.require({k: row[k] for k in ('fileCount', 'sha256')} == expected,
              'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')
    if inspect_content:
        measured = content_summary(d, 'migrate', d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', row['reference'], '-c', content_command('migrate')))
        d.require(measured == expected, 'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')


def content_command(service):
    roots = '/app/apps/api/dist /app/packages/shared/dist' if service == 'api' else '/app/apps/api/prisma-mysql' if service == 'migrate' else '/app' if service == 'auto-registration' else '/usr/share/nginx/html'
    return ('set -eu; export LC_ALL=C; for p in ' + roots + '; do test -d "$p"; done; '
            'files="$(find ' + roots + ' -type f -exec sha256sum {} +)"; '
            "printf '%s\\n' \"$files\" | sort")


def content_summary(d, service, output):
    lines = output.splitlines()
    prefixes = ('/app/apps/api/dist/', '/app/packages/shared/dist/') if service == 'api' else ('/app/apps/api/prisma-mysql/',) if service == 'migrate' else ('/app/',) if service == 'auto-registration' else ('/usr/share/nginx/html/',)
    d.require(0 < len(lines) < 30000 and len(output) < 8 * 1024 * 1024
              and all(re.fullmatch(r'[a-f0-9]{64}  /[^\r\n]+', line)
                      and line[66:].startswith(prefixes) for line in lines), 'API_ADMIN_CONTENT_INVALID')
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(lines) + '\n').encode()).hexdigest()}


def build_proof(d):
    commit, tree = os.environ['RELEASE_COMMIT'], os.environ['SOURCE_TREE']
    d.require(d.run('git', 'rev-parse', 'HEAD') == commit
              and d.run('git', 'rev-parse', 'HEAD^{tree}') == tree, 'API_ADMIN_BUILD_SOURCE_CHANGED')
    result = {'version': 1, 'commit': commit, 'sourceTree': tree, 'images': {}}
    if MIGRATION_MODE:
        result.update(scope=SCOPE, migration=migration_source_check(d))
    if REGISTRATION:
        projection = json.loads(Path('.deploy/production-release/api-registration-build-projection.json').read_text())
        validate_worker_projection(d, projection['workerProjection'])
        d.require(projection['workerProjectionSha256'] == fingerprint(projection['workerProjection']),
                  'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
        d.require(all(hashlib.sha256(subprocess.check_output(['git', 'show', commit + ':' + n])).hexdigest()
                      == projection['workerProjection'][n]['sha256'] for n in WORKER_PAIR),
                  'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        result.update(scope=SCOPE, **projection)
    for service in IMAGE_SERVICES:
        reference = (os.environ['RELEASE_REPOSITORY'] + ':' + commit + '-'
                     + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + image_service(service))
        metadata = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        labels = metadata['Config'].get('Labels', {})
        d.require(metadata['Architecture'] == 'amd64'
                  and labels.get('org.opencontainers.image.revision') == commit
                  and labels.get('id-business-v2.source-tree') == tree, 'API_ADMIN_BUILD_LABEL_CHANGED')
        content = content_summary(d, service, d.run('docker', 'run', '--rm', '--network', 'none',
            '--read-only', '--entrypoint', '/bin/sh', reference, '-c', content_command(service)))
        if service == 'migrate':
            d.require(content == migration_content(d, Path.cwd()), 'API_ADMIN_MIGRATION_IMAGE_CONTENT_CHANGED')
        if service == 'auto-registration':
            d.require(labels.get('id-business-v2.worker-projection-sha256') == result['workerProjectionSha256'],
                      'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
            expected = worker_content(result['workerProjection'])
            d.require(content == expected, 'API_ADMIN_REGISTRATION_CONTENT_CHANGED')
        result['images'][service] = {'reference': reference, 'imageId': metadata['Id'], **content}
    target = Path('.deploy/production-release') / PROOF_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps({'status': SCOPE + '_BUILD_PROVEN', 'proofSha256': fingerprint(result)}))


def validate_proof(d, value, commit, tree, repository=None, run_id=None, attempt=None):
    fields = {'version', 'commit', 'sourceTree', 'images'} | ({'scope', 'workerProjection', 'workerProjectionSha256'} if REGISTRATION else {'scope', 'migration'} if MIGRATION_MODE else set())
    d.require(isinstance(value, dict) and set(value) == fields
              and value['version'] == 1 and value['commit'] == commit and value['sourceTree'] == tree
              and set(value['images']) == set(IMAGE_SERVICES), 'API_ADMIN_BUILD_PROOF_INVALID')
    if MIGRATION_MODE:
        d.require(value['scope'] == SCOPE and value['migration'] == MIGRATION_IDENTITY,
                  'API_ADMIN_MIGRATION_BUILD_PROOF_CHANGED')
    for service, row in value['images'].items():
        d.require(set(row) == {'reference', 'imageId', 'fileCount', 'sha256'}
                  and re.fullmatch(r'sha256:[a-f0-9]{64}', row['imageId'])
                  and re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
                  and type(row['fileCount']) is int and 0 < row['fileCount'] < 30000
                  and re.fullmatch(r'[0-9]{12}\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release:'
                                   + commit + r'-[1-9][0-9]*-[1-9][0-9]*-' + image_service(service), row['reference']),
                  'API_ADMIN_BUILD_IMAGE_INVALID')
        if repository is not None:
            d.require(row['reference'] == f'{repository}:{commit}-{run_id}-{attempt}-{image_service(service)}',
                      'API_ADMIN_BUILD_RUN_CHANGED')
    if REGISTRATION:
        validate_worker_projection(d, value['workerProjection'])
        d.require(value['scope'] == SCOPE and value['workerProjectionSha256'] == fingerprint(value['workerProjection'])
                  and {k: value['images']['auto-registration'][k] for k in ('fileCount', 'sha256')}
                  == worker_content(value['workerProjection']), 'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
    return value


def validate_worker_projection(d, rows):
    root = Path(__file__).resolve().parents[2]
    if not (root / REGISTRATION_PROFILE).exists():
        root = Path(REGISTRATION_DIRECTORY)
    profile = registration_profile(d, root)
    old = profile['workerProjection']
    d.require(isinstance(rows, dict) and set(rows) == set(old) and len(rows) == 60
              and all(isinstance(r, dict) and set(r) == {'mode', 'sha256'} and r['mode'] == old[n]['mode']
                      and re.fullmatch(r'[a-f0-9]{64}', r['sha256']) for n, r in rows.items())
              and {n for n in rows if rows[n] != old[n]} == WORKER_PAIR, 'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')


def worker_content(rows):
    lines = sorted(row['sha256'] + '  /app/' + name[len(WORKER_PREFIX):] for name, row in rows.items())
    return {'fileCount': len(lines), 'sha256': hashlib.sha256(('\n'.join(lines) + '\n').encode()).hexdigest()}


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


def jobs_idle(d, directory, *, allow_retained=False):
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
    result = {'rechargeIdle': True, 'registrationBusy': False, 'registrationLeaseActive': False,
              'registrationWindowRetained': runtime['registrationWindowRetained']}
    if REGISTRATION and not allow_retained and runtime['registrationWindowRetained']:
        path = handoff_directory(d) / 'confirmed.json'
        d.require(path.exists(), 'API_ADMIN_REGISTRATION_WINDOW_RETAINED')
        record = handoff_json(d, handoff_directory(d), 'confirmed.json')
        d.require(record.get('version') == 2, 'API_ADMIN_REGISTRATION_WINDOW_RETAINED')
        require_native_handoff(d, directory, record)
        result['registrationResourceClosed'] = True
    return result


TASK_SOURCE = r'''const {PrismaClient}=require('@prisma/client'),c=require('node:crypto');
const p=new PrismaClient({log:[]}),id=__TASK__,attempt=__ATTEMPT__,binding=__BINDING__;
const migration=__MIGRATION__,observed=__OBSERVED__;
const need=x=>{if(!x)throw Error();},bit=x=>x===true||x===1||x===1n;
const sha=x=>c.createHash('sha256').update(x||'').digest('hex');
const canon=x=>typeof x==='bigint'?x.toString():x instanceof Date?x.toISOString():Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const key=process.env.AUTO_RECHARGE_WORKER_TOKEN;
const mac=x=>c.createHmac('sha256',key).update('api-registration-handoff:').update(JSON.stringify(canon(x))).digest('hex');
async function read(tx){
 const rows=await tx.$queryRaw`SELECT * FROM id_business_v2_registration_jobs WHERE id=${id}`;
 need(rows.length===1);const j=rows[0];
 need(j.id===id&&j.attempt===attempt&&j.state==='partial'&&j.step==='password'&&j.reason===(migration?observed.reason:'session_network_error')
  &&bit(j.registered)&&!bit(j.password_verified)&&!bit(j.mfa_verified)&&j.nonce_hash===null&&j.lease_until===null
  &&j.updated_at.toISOString()===(migration?observed.updatedAt:'2026-10-08T02:15:59.029Z')&&typeof j.password_encrypted==='string'&&j.password_encrypted.length>0
  &&sha(j.account_id)===binding.accountSha256&&sha(j.browser_profile_id)===binding.profileSha256&&sha(j.owner_id)===binding.ownerSha256);
 const accounts=await tx.$queryRaw`SELECT * FROM id_business_v2_chatgpt_accounts WHERE email_hash=${j.email_hash} ORDER BY id`;
 need(accounts.length===1&&accounts[0].id===j.account_id&&bit(accounts[0].registered)&&accounts[0].deleted_at===null
  &&accounts[0].password_encrypted===null&&accounts[0].totp_secret_encrypted===null);
 const audits=await tx.auditLog.findMany({where:{module:'id_business_v2',objectType:'registration_job',objectId:id,
  action:{in:['id_business_v2.auto_registration.launch','id_business_v2.auto_registration.profile_rebound','id_business_v2.auto_registration.cancel']},
  createdAt:{gte:new Date('2026-10-08T02:14:14.768Z')}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001});
 need(audits.length<1001);
 if(migration)need(audits.length===observed.auditCount);
 else{
 const launch=audits.filter(x=>x.action.endsWith('.launch')),rebound=audits.filter(x=>x.action.endsWith('.profile_rebound'));
 need(launch.length===1&&launch[0].afterData?.attempt===attempt&&launch[0].createdAt.toISOString()==='2026-10-08T02:14:16.979Z'
  &&rebound.length===1&&rebound[0].afterData?.attempt===attempt&&sha(rebound[0].afterData.browserProfileId)===binding.profileSha256
  &&sha(rebound[0].afterData.accountId)===binding.accountSha256&&rebound[0].createdAt.toISOString()==='2026-10-08T02:14:39.680Z');
 }
 const value={taskId:id,attempt,registered:true,passwordVerified:false,mfaVerified:false,leaseActive:false,noncePresent:false,
  passwordCandidatePresent:true,binding,emailHashHmac:mac('email:'+j.email_hash),jobHmac:mac(rows),accountHmac:mac(accounts),auditHmac:mac(audits)};
 return migration?{...value,state:j.state,step:j.step,reason:j.reason,updatedAt:j.updated_at.toISOString(),auditCount:audits.length}:value;
}
(async()=>{need(typeof key==='string'&&key.length>=32);const value=await p.$transaction(async tx=>{
 const a=await read(tx),b=await read(tx);need(JSON.stringify(a)===JSON.stringify(b));return b;
},{isolationLevel:'RepeatableRead',timeout:25000});console.log(JSON.stringify(value));})()
.catch(()=>{console.log('{"diagnosticError":"API_ADMIN_REGISTRATION_TASK_UNAVAILABLE"}');})
.finally(async()=>{try{await p.$disconnect();}catch{process.exitCode=1;}});'''


PRIVATE_SOURCE = r'''import json,os
from urllib.error import HTTPError
from urllib.request import Request,build_opener,HTTPRedirectHandler
class NoRedirect(HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def pairs(rows):
 value={}
 for k,v in rows:
  if k in value:raise ValueError()
  value[k]=v
 return value
phase='status';attempted=False;http_status=None;reason='none'
def read(path,body=None,status=200):
 global attempted,http_status,reason
 if body is not None:attempted=True
 request=Request('http://127.0.0.1:8051'+path,headers={'X-Recharge-Worker':token,'Content-Type':'application/json'},
  data=body,method='GET' if body is None else 'POST')
 try:
  with opener.open(request,timeout=10) as response:
   if body is not None:http_status=response.status
   if response.status!=status:raise ValueError()
   raw=response.read(4097)
 except HTTPError as error:
  if body is not None:
   http_status=error.code
   try:
    raw=error.read(4097);assert len(raw)<=4096
    value=json.loads(raw,object_pairs_hook=pairs)
    if error.code==409 and type(value)is dict and set(value)=={'ok','reason'} and value['ok']is False and value['reason']in{
     'worker_busy','builtin_original_window_pending','builtin_profile_missing','invalid_registration_payload','fingerprint_cleanup_failed'}:reason=value['reason']
   except BaseException:pass
  raise ValueError()from None
 if not 0<len(raw)<=4096:raise ValueError()
 return json.loads(raw,object_pairs_hook=pairs)
def status_ok(value,cancelled):
 return type(value)is dict and set(value)=={'accepted','attempt','cancelled','done'} and value['accepted']is True and type(value['attempt'])is int and value['attempt']==__ATTEMPT__ and value['done']is True and value['cancelled']is cancelled
def health_ok(value,retained):
 return type(value)is dict and set(value)=={'ready','workerRole','engine','mailDeliveryVersion','registrationBusy','registrationWindowRetained'} and value['ready']is True and value['workerRole']=='registration' and value['engine']=='camoufox' and type(value['mailDeliveryVersion'])is int and value['mailDeliveryVersion']==1 and value['registrationBusy']is False and value['registrationWindowRetained']is retained
try:
 token=os.environ['AUTO_RECHARGE_WORKER_TOKEN'];assert len(token)>=32;opener=build_opener(NoRedirect)
 path='/registration/jobs/__TASK__'
 first=read(path+'/status');assert status_ok(first,__CANCELLED__)
 phase='health';h=read('/registration/health');assert health_ok(h,__RETAINED__)
 if __CLOSE__:
  phase='close';ack=read(path+'/cancel',b'{"attempt":__ATTEMPT__}',202);assert type(ack)is dict and set(ack)=={'ok'} and ack['ok']is True
  phase='after_status';assert status_ok(read(path+'/status'),True)
  phase='after_health';assert health_ok(read('/registration/health'),False)
 print(json.dumps({'confirmed':True,'privatePostAttempted':attempted,'cancelled':True if __CLOSE__ else __CANCELLED__,
  'retained':False if __CLOSE__ else __RETAINED__,'busy':False,'attempt':__ATTEMPT__}))
except BaseException:
 print(json.dumps({'confirmed':False,'privatePostAttempted':attempted,'failurePhase':phase,
  'privatePostHttpStatus':http_status,'controlledReason':reason,'rawOutputSuppressed':True}))
'''


def registration_task(d, directory):
    code = TASK_SOURCE.replace('__TASK__', json.dumps(TASK_ID)).replace('__ATTEMPT__', str(TASK_ATTEMPT)).replace('__BINDING__', json.dumps(TASK_BINDING))
    code = code.replace('__MIGRATION__', json.dumps(MIGRATION_MODE)).replace('__OBSERVED__', json.dumps(MIGRATION_TASK if MIGRATION_MODE else None))
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    fields = {'taskId', 'attempt', 'registered', 'passwordVerified', 'mfaVerified', 'leaseActive',
              'noncePresent', 'passwordCandidatePresent', 'binding', 'emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac'}
    if MIGRATION_MODE:
        fields = set(MIGRATION_TASK)
    d.require(isinstance(value, dict) and set(value) == fields and value['taskId'] == TASK_ID
              and type(value['attempt']) is int and value['attempt'] == TASK_ATTEMPT and value['binding'] == TASK_BINDING
              and all(value[n] is True for n in ('registered', 'passwordCandidatePresent'))
              and all(value[n] is False for n in ('passwordVerified', 'mfaVerified', 'leaseActive', 'noncePresent'))
              and all(re.fullmatch(r'[a-f0-9]{64}', value[n]) for n in ('emailHashHmac', 'jobHmac', 'accountHmac', 'auditHmac')),
              'API_ADMIN_REGISTRATION_TASK_UNAVAILABLE')
    if MIGRATION_MODE:
        d.require(value == MIGRATION_TASK and type(value['auditCount']) is int,
                  'API_ADMIN_REGISTRATION_TASK_CHANGED')
    return value


def registration_private(d, directory, *, close=False, retained=True):
    d.require(not MIGRATION_MODE or (close is False and retained is True), 'API_ADMIN_SCOPE_CONFLICT')
    code = PRIVATE_SOURCE.replace('__TASK__', TASK_ID).replace('__ATTEMPT__', str(TASK_ATTEMPT))
    code = code.replace('__CANCELLED__', repr(not retained)).replace('__RETAINED__', repr(retained)).replace('__CLOSE__', repr(close))
    value = json.loads(d.compose(directory, 'exec', '-T', 'auto-registration', 'python', '-B', '-c', code, timeout=45))
    if value.get('confirmed') is not True:
        # Fixed, bounded diagnostics retain the first failure; no second POST.
        allowed = {'confirmed', 'privatePostAttempted', 'failurePhase', 'privatePostHttpStatus', 'controlledReason', 'rawOutputSuppressed'}
        d.require(set(value) == allowed and value['confirmed'] is False and value['rawOutputSuppressed'] is True
                  and type(value['privatePostAttempted']) is bool
                  and value['failurePhase'] in ('status', 'health', 'close', 'after_status', 'after_health')
                  and value['controlledReason'] in ('none', 'worker_busy', 'builtin_original_window_pending',
                      'builtin_profile_missing', 'invalid_registration_payload', 'fingerprint_cleanup_failed')
                  and (value['privatePostHttpStatus'] is None or type(value['privatePostHttpStatus']) is int
                       and 100 <= value['privatePostHttpStatus'] <= 599), 'API_ADMIN_REGISTRATION_PRIVATE_UNAVAILABLE')
        raise RegistrationHandoffError(value)
    d.require(set(value) == {'confirmed', 'privatePostAttempted', 'cancelled', 'retained', 'busy', 'attempt'}
              and value['privatePostAttempted'] is close and value['busy'] is False
              and type(value['attempt']) is int and value['attempt'] == TASK_ATTEMPT
              and value['retained'] is (False if close else retained)
              and value['cancelled'] is (True if close else not retained), 'API_ADMIN_REGISTRATION_PRIVATE_UNAVAILABLE')
    return value


class RegistrationHandoffError(RuntimeError):
    def __init__(self, diagnostic):
        super().__init__('API_ADMIN_REGISTRATION_PRIVATE_UNCONFIRMED')
        self.diagnostic = diagnostic


NATIVE_HANDOFF_SOURCE = r'''import ast,hashlib,json,os,select,signal,stat,sys,time
from pathlib import Path
recover=__RECOVER__;expected_module=__MODULE_SHA__
proc=Path('/proc');engine=Path('/opt/camoufox');module=Path('/app/fingerprint_runtime.py')
result={'status':'FAILED','nativeCount':0,'nativeCountObserved':False,'signalsAttempted':0,
 'zeroObservations':0,'resourceClosed':False,'readOnly':not recover,'code':'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE'}
def need(value,code):
 if not value:raise RuntimeError('API_ADMIN_REGISTRATION_NATIVE_'+code)
def process(pid):
 raw=(proc/str(pid)/'stat').read_text();parts=raw.rsplit(')',1)[1].split()
 need(len(parts)>19 and parts[19].isdigit(),'PROC_READ');return (int(parts[19]),parts[0])
def inactive(pid,observed):
 path=proc/str(pid)
 need(observed[1] in ('Z','X') and os.readlink(path/'ns/pid')==namespace,'PROC_READ')
 need(hasattr(os,'pidfd_open') and hasattr(select,'poll'),'SIGNAL_UNAVAILABLE')
 fd=os.pidfd_open(pid,0)
 try:
  need(process(pid)==observed,'PID_REUSED')
  poll=select.poll();poll.register(fd,select.POLLIN)
  events=[flags for n,flags in poll.poll(0) if n==fd]
  need(len(events)==1 and events[0]&select.POLLIN and not events[0]&(select.POLLERR|select.POLLNVAL),'PROC_READ')
  need(process(pid)==observed,'PID_REUSED')
  need(os.readlink(path/'ns/pid')==namespace,'PID_NAMESPACE');return True
 finally:os.close(fd)
def row(pid):
 path=proc/str(pid)
 try:
  observed=process(pid)
  if observed[1] in ('Z','X'):
   inactive(pid,observed);return None
  first=observed[0];exe=os.readlink(path/'exe')
 except (FileNotFoundError,ProcessLookupError):
  need(not path.exists(),'PROC_READ');return None
 need(not exe.endswith(' (deleted)'),'DELETED_EXECUTABLE')
 need(exe!='/run/rosetta/rosetta','EXECUTION_EMULATED')
 if not exe.startswith(str(engine)+'/'):return None
 actual=Path(exe).resolve(strict=True)
 need(actual==kernel and actual.is_file() and (actual.stat().st_dev,actual.stat().st_ino)==kernel_identity,'EXECUTABLE_CHANGED')
 need(os.readlink(path/'ns/pid')==namespace,'PID_NAMESPACE')
 need(process(pid)[0]==first,'PID_REUSED')
 return (pid,first,exe)
def inventory():
 names=[p for p in proc.iterdir() if p.name.isdigit()]
 need(len(names)<=2048,'PROC_BOUND');rows=[]
 for path in names:
  try:value=row(int(path.name))
  except (FileNotFoundError,ProcessLookupError):
   need(not path.exists(),'PROC_READ');continue
  if value is not None:rows.append(value)
 need(len(rows)<=128,'PROC_BOUND');return sorted(rows)
fds=[]
try:
 need(os.geteuid()==10001 and os.getegid()==10001,'OWNER_CHANGED')
 need(Path(os.readlink(proc/'self/exe')).resolve(strict=True)==Path(sys.executable).resolve(strict=True),'EXECUTION_EMULATED')
 raw=module.read_bytes();need(hashlib.sha256(raw).hexdigest()==expected_module,'MODULE_CHANGED')
 tree=ast.parse(raw);paths=[n.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='ENGINE_PATH' for t in n.targets)]
 need(len(paths)==1 and isinstance(paths[0],ast.Call) and isinstance(paths[0].func,ast.Name) and paths[0].func.id=='Path'
  and len(paths[0].args)==1 and isinstance(paths[0].args[0],ast.Constant) and paths[0].args[0].value=='/opt/camoufox/camoufox','MODULE_CHANGED')
 need(engine.resolve(strict=True)==engine and engine.is_dir() and engine.stat().st_uid==0,'ENGINE_CHANGED')
 kernel=(engine/'camoufox').resolve(strict=True);need(kernel.parent==engine and kernel.is_file() and kernel.stat().st_uid==0,'ENGINE_CHANGED')
 kernel_identity=(kernel.stat().st_dev,kernel.stat().st_ino);namespace=os.readlink(proc/'self/ns/pid');need(namespace.startswith('pid:['),'PID_NAMESPACE')
 deadline=time.monotonic()+10;rows=inventory();result.update(nativeCount=len(rows),nativeCountObserved=True)
 if recover:
  need(all(pid>1 and pid!=os.getpid() for pid,_,_ in rows),'PID_OWNER')
  need(not rows or hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'),'SIGNAL_UNAVAILABLE')
  for owned in rows:
   pid=owned[0]
   try:fd=os.pidfd_open(pid,0)
   except ProcessLookupError:
    need(not (proc/str(pid)).exists(),'PID_REUSED');continue
   fds.append((fd,owned));current=row(pid);need(current is None or current==owned,'PID_REUSED')
  for fd,owned in fds:
   need(time.monotonic()<deadline,'BUDGET_EXHAUSTED');current=row(owned[0])
   need(current is None or current==owned,'PID_REUSED')
   if current is None:continue
   result['signalsAttempted']+=1
   try:signal.pidfd_send_signal(fd,signal.SIGTERM,None,0)
   except ProcessLookupError:pass
  zero=0
  while time.monotonic()<deadline:
   remaining=inventory();alive=False
   for pid,original,_ in rows:
    try:
     observed=process(pid);need(observed[0]==original,'PID_REUSED')
     if observed[1] in ('Z','X'):inactive(pid,observed)
     else:alive=True
    except (FileNotFoundError,ProcessLookupError):need(not (proc/str(pid)).exists(),'PROC_READ')
   result['nativeCount']=len(remaining)
   zero=zero+1 if not remaining and not alive else 0;result['zeroObservations']=zero
   if zero==2:break
   time.sleep(.1)
  need(result['zeroObservations']==2,'REMAINS')
  result.update(status='RECOVERED',resourceClosed=True,code='none')
 else:
  time.sleep(.1);need(inventory()==rows,'OBSERVATION_CHANGED')
  result.update(status='OBSERVED',zeroObservations=2 if not rows else 0,resourceClosed=not rows,code='none')
except Exception as error:
 code=str(error);allowed={'OWNER_CHANGED','PROC_READ','DELETED_EXECUTABLE','EXECUTABLE_CHANGED','PID_NAMESPACE',
  'PID_REUSED','PROC_BOUND','MODULE_CHANGED','ENGINE_CHANGED','PID_OWNER','SIGNAL_UNAVAILABLE','BUDGET_EXHAUSTED','REMAINS','OBSERVATION_CHANGED','EXECUTION_EMULATED'}
 if code in {'API_ADMIN_REGISTRATION_NATIVE_'+n for n in allowed}:result['code']=code
finally:
 for fd,_ in fds:
  try:os.close(fd)
  except OSError:pass
print(json.dumps(result,separators=(',',':')))
'''


class RegistrationRecoveryError(RuntimeError):
    def __init__(self, code, diagnostic):
        super().__init__(code)
        self.diagnostic = diagnostic


def handoff_json(d, folder, name):
    d.require(folder.resolve() == folder and stat.S_ISDIR(folder.lstat().st_mode)
              and stat.S_IMODE(folder.lstat().st_mode) == 0o700 and folder.lstat().st_uid == 0,
              'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    path = folder / name
    d.require(path.lstat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    raw = d.fixed_recharge_bytes(path, modes=(0o400,), limit=16384)
    d.require(path.lstat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
    return d.fixed_recharge_json(raw)


def handoff_failed_attempt(d, *, require_unconfirmed=True):
    folder = handoff_directory(d)
    attempt = handoff_json(d, folder, 'attempt.json')
    failure = handoff_json(d, folder, 'failure.json')
    d.require(fingerprint(attempt) == fingerprint({'taskId': TASK_ID, 'attempt': TASK_ATTEMPT, 'privatePostBudget': 1})
              and fingerprint(failure) == fingerprint(HANDOFF_FAILURE), 'API_ADMIN_REGISTRATION_RECOVERY_FAILURE_CHANGED')
    if require_unconfirmed:
        d.require(not (folder / 'confirmed.json').exists() and not (folder / 'confirmed.json').is_symlink(),
                  'API_ADMIN_REGISTRATION_RECOVERY_ALREADY_CONFIRMED')
    return folder


def native_handoff(d, directory, container_id, *, recover=False):
    d.require(re.fullmatch(r'[a-f0-9]{64}', container_id), 'API_ADMIN_REGISTRATION_NATIVE_CONTAINER_CHANGED')
    module_sha = registration_profile(d, Path(REGISTRATION_DIRECTORY))['workerProjection'][WORKER_PREFIX + 'fingerprint_runtime.py']['sha256']
    source = NATIVE_HANDOFF_SOURCE.replace('__RECOVER__', repr(recover)).replace('__MODULE_SHA__', repr(module_sha))
    try:
        value = json.loads(d.run('docker', 'exec', '--user', '10001:10001', '-i', container_id, 'python', '-B', '-c', source, timeout=20))
    except Exception:
        raise RegistrationRecoveryError('API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE', {
            'confirmed': False, 'signalsAttempted': None if recover else 0, 'nativeCount': 0,
            'nativeCountObserved': False, 'rawOutputSuppressed': True}) from None
    fields = {'status', 'nativeCount', 'nativeCountObserved', 'signalsAttempted', 'zeroObservations',
              'resourceClosed', 'readOnly', 'code'}
    d.require(isinstance(value, dict) and set(value) == fields
              and all(type(value[n]) is int and 0 <= value[n] <= 128 for n in ('nativeCount', 'signalsAttempted'))
              and type(value['zeroObservations']) is int and 0 <= value['zeroObservations'] <= 2
              and all(type(value[n]) is bool for n in ('nativeCountObserved', 'resourceClosed', 'readOnly'))
              and value['readOnly'] is (not recover) and value['status'] in ('OBSERVED', 'RECOVERED', 'FAILED')
              and isinstance(value['code'], str), 'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
    if value['status'] == 'FAILED':
        allowed = {'OWNER_CHANGED', 'PROC_READ', 'DELETED_EXECUTABLE', 'EXECUTABLE_CHANGED', 'PID_NAMESPACE',
                   'PID_REUSED', 'PROC_BOUND', 'MODULE_CHANGED', 'ENGINE_CHANGED', 'PID_OWNER', 'SIGNAL_UNAVAILABLE',
                   'BUDGET_EXHAUSTED', 'REMAINS', 'OBSERVATION_CHANGED', 'EXECUTION_EMULATED', 'UNAVAILABLE'}
        d.require(value['code'] in {'API_ADMIN_REGISTRATION_NATIVE_' + name for name in allowed},
                  'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
        raise RegistrationRecoveryError(value['code'], {'confirmed': False, 'signalsAttempted': value['signalsAttempted'],
            'nativeCount': value['nativeCount'], 'nativeCountObserved': value['nativeCountObserved'], 'rawOutputSuppressed': True})
    d.require(value['status'] == ('RECOVERED' if recover else 'OBSERVED') and value['code'] == 'none'
              and value['nativeCountObserved'] is True and value['resourceClosed'] is (value['nativeCount'] == 0)
              and (recover and value['resourceClosed'] is True and value['zeroObservations'] == 2
                   or not recover and value['signalsAttempted'] == 0
                   and value['zeroObservations'] == (2 if value['resourceClosed'] else 0)),
              'API_ADMIN_REGISTRATION_NATIVE_UNAVAILABLE')
    return value


BUSINESS_SOURCE = r'''const {PrismaClient}=require('@prisma/client'),c=require('node:crypto');
const p=new PrismaClient({log:[]}),id=__TASK__,binding=__BINDING__,emailMac=__EMAIL_MAC__;
const need=x=>{if(!x)throw Error();},bit=x=>x===true||x===1||x===1n,sha=x=>c.createHash('sha256').update(x||'').digest('hex');
const key=process.env.AUTO_RECHARGE_WORKER_TOKEN;
const mac=x=>c.createHmac('sha256',key).update('api-registration-handoff:').update(JSON.stringify(x)).digest('hex');
const states=['queued','running','awaiting_email','awaiting_user','partial','completed','cancelled'];
const steps=['queued','email','email_code','profile','registered','password','password_verified','mfa','mfa_verified','offer','completed'];
const reasons=new Set(['session_load_timeout','session_network_error','browser_operation_failed','operation_cancelled','verification_required',
 'http_error','form_unrecognized','official_login_email_mismatch','official_login_not_verified','registration_authorization_expired',
 'mailbox_timeout','password_unverified','mfa_unverified','unsupported_login_provider','login_form_ambiguous','window_missing','mail_value_invalid']);
async function read(tx){
 const jobs=await tx.$queryRaw`SELECT id,owner_id,email_hash,account_id,browser_profile_id,state,step,reason,attempt,registered,password_verified,mfa_verified,lease_until,updated_at FROM id_business_v2_registration_jobs WHERE id=${id}`;
 need(jobs.length===1);const j=jobs[0];need(j.id===id&&Number.isInteger(j.attempt)&&j.attempt>=10&&j.attempt<=2147483647
  &&states.includes(j.state)&&steps.includes(j.step)&&sha(j.account_id)===binding.accountSha256&&sha(j.owner_id)===binding.ownerSha256
  &&mac('email:'+j.email_hash)===emailMac);
 const accounts=await tx.$queryRaw`SELECT id,email_hash,registered,password_encrypted IS NOT NULL AS password_present,totp_secret_encrypted IS NOT NULL AS mfa_present,deleted_at FROM id_business_v2_chatgpt_accounts WHERE email_hash=${j.email_hash} ORDER BY id`;
 need(accounts.length===1&&accounts[0].id===j.account_id&&accounts[0].email_hash===j.email_hash&&accounts[0].deleted_at===null);
 const where=action=>({module:'id_business_v2',action:'id_business_v2.auto_registration.'+action,objectType:'registration_job',objectId:id});
 const launches=await tx.auditLog.findMany({where:where('launch'),orderBy:[{createdAt:'desc'},{id:'desc'}],take:1001,select:{userId:true,createdAt:true,afterData:true}});
 need(launches.length<1001);const launch=launches.find(x=>x.afterData?.attempt===j.attempt);
 need(launch&&launch.userId===j.owner_id&&launch===launches[0]);
 const since=launch.createdAt;
 const events=await tx.auditLog.findMany({where:{...where('progress'),createdAt:{gte:since}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001,select:{userId:true,createdAt:true,afterData:true}});
 const rebound=await tx.auditLog.findMany({where:{...where('profile_rebound'),createdAt:{gte:since}},take:1001,select:{userId:true,createdAt:true,afterData:true}});
 need(rebound.length<1001&&events.every(x=>x.userId===j.owner_id));
 const matches=rebound.filter(x=>x.userId===j.owner_id&&x.afterData?.attempt===j.attempt&&sha(x.afterData.accountId)===binding.accountSha256&&x.afterData.browserProfileId===j.browser_profile_id);
 need(matches.length<=1);const bound=matches.length===1;
 const codes=await tx.auditLog.findMany({where:{...where('code_read'),createdAt:{gte:since}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:1001,select:{afterData:true}});
 const valid=events.length<=1000&&bound;
 const first=predicate=>valid?events.find(x=>predicate(x.afterData))?.createdAt?.toISOString()||null:null;
 const passwordAt=first(x=>x?.passwordVerified===true&&x.step==='password_verified');
 const mfaAt=first(x=>x?.mfaVerified===true&&x.step==='mfa_verified');
 // Both independent login verifiers check the same official email identity.
 // An inherited registered flag or email-only checkpoint cannot supply this.
 const officialAt=passwordAt||mfaAt;
 return {taskId:id,attempt:j.attempt,state:j.state,step:j.step,reason:j.reason===null?'none':reasons.has(j.reason)?j.reason:'other',
  registered:bit(j.registered),passwordVerified:bit(j.password_verified),mfaVerified:bit(j.mfa_verified),
  accountRegistered:bit(accounts[0].registered),encryptedPasswordPresent:bit(accounts[0].password_present),encryptedMfaPresent:bit(accounts[0].mfa_present),
  leaseActive:j.lease_until!==null&&j.lease_until>new Date(),profileBindingConfirmed:bound,launchAt:since.toISOString(),updatedAt:j.updated_at.toISOString(),
  progressCount:Math.min(events.length,1000),progressTruncated:events.length>1000,codeReadCount:Math.min(codes.length,1000),codeReadTruncated:codes.length>1000,
  officialThisAttempt:officialAt!==null,passwordThisAttempt:passwordAt!==null,mfaThisAttempt:mfaAt!==null,officialAt,passwordAt,mfaAt};
}
(async()=>{need(typeof key==='string'&&key.length>=32);const value=await p.$transaction(async tx=>{
 const a=await read(tx),b=await read(tx);need(JSON.stringify(a)===JSON.stringify(b));return b;
},{isolationLevel:'RepeatableRead',timeout:25000});console.log(JSON.stringify(value));})()
.catch(()=>{console.log('{"diagnosticError":"API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE"}');})
.finally(async()=>{try{await p.$disconnect();}catch{process.exitCode=1;}});'''


def business_logs(d, directory, task):
    state = d.service_state(directory, 'auto-registration', include_container_id=True)
    d.require(re.fullmatch(r'[a-f0-9]{64}', state['containerId']), 'API_ADMIN_REGISTRATION_LOGS_UNAVAILABLE')
    result = subprocess.run(['docker', 'logs', '--since', task['launchAt'], '--tail', '1000', state['containerId']],
                            capture_output=True, text=True, timeout=20)
    raw = result.stdout + result.stderr
    d.require(result.returncode == 0 and len(raw.encode()) <= 256 * 1024, 'API_ADMIN_REGISTRATION_LOGS_UNAVAILABLE')
    base = re.escape(TASK_ID) + r' attempt=' + str(task['attempt'])
    checkpoint = re.compile(r'Registration verification checkpoint job=' + base
        + r' checkpoint=(email_code_returned|same_email_identity_confirmed) owned_context=(True|False) after_email_code_returned=(True|False)(?:\s|$)')
    failure = re.compile(r'Registration verification failed job=' + base
        + r' phase=([a-z_]+) error_type=(TimeoutError|AssertionError|Error|TargetClosedError|Stop|UnexpectedError)'
          r' browser_code=((?:net::)?[A-Z_]+|none) cleanup=(True|False) reason=([a-z_]+) subphase=([a-z_]+)(?:\s|$)')
    phases = {'context_create', 'context_route', 'page_create', 'navigation', 'navigation_guard', 'body_read',
        'field_read', 'email_code_wait', 'email_code_fill', 'email_code_submit', 'identity_read', 'email_fill',
        'mail_prepare', 'email_submit', 'password_choice', 'password_fill', 'password_submit', 'totp_fill',
        'totp_submit', 'secret_cleanup', 'context_cleanup', 'cleanup'}
    subphases = {'none', 'get_first', 'get_retry', 'url_guard', 'http_403', 'http_other', 'retry_budget',
        'retry_guard_install', 'retry_guard_remove', 'official_guard', 'text_read', 'title_read', 'challenge_scan',
        'phone_scan', 'challenge_text', 'challenge_visible', 'phone_verification', 'email_field_read',
        'email_field_missing', 'email_code_already_submitted', 'email_code_wait', 'email_code_wait_timeout',
        'email_code_field_read', 'email_code_field_missing', 'email_code_type_read', 'email_code_type_unconfirmed',
        'mail_value_invalid', 'login_code_type_read', 'unknown_code_type', 'unsupported_code_type',
        'password_form_wait_exhausted', 'password_identity_unconfirmed', 'post_code_identity_unconfirmed',
        'password_rejected', 'secret_cleanup', 'context_cleanup', 'identity_first', 'identity_retry',
        'identity_guard_install', 'identity_code_guard', 'identity_get', 'identity_after_get', 'identity_guard_remove',
        'owned_onboarding', 'email_form_readiness', 'email_form_changed', 'challenge_loading',
        'challenge_loading_exhausted', 'email_code_catchup'}
    reasons = {'none', 'session_load_timeout', 'session_network_error', 'browser_operation_failed',
        'operation_cancelled', 'verification_required', 'http_error', 'form_unrecognized', 'official_login_email_mismatch',
        'official_login_not_verified', 'registration_authorization_expired', 'mailbox_timeout', 'password_unverified',
        'mfa_unverified', 'unsupported_login_provider', 'login_form_ambiguous'}
    codes = {'none', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_RESET',
        'net::ERR_CONNECTION_CLOSED', 'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED',
        'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NETWORK_CHANGED', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_CONNECTION_REFUSED',
        'net::ERR_INTERNET_DISCONNECTED', 'NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_NET_INTERRUPT',
        'NS_ERROR_CONNECTION_REFUSED', 'NS_ERROR_PROXY_CONNECTION_REFUSED', 'NS_ERROR_UNKNOWN_HOST', 'NS_ERROR_UNKNOWN_PROXY_HOST'}
    checkpoints = {'email_code_returned': 0, 'same_email_identity_confirmed': 0}
    failures, cleanup = 0, 0
    first_failure = None
    last_failure = None
    for line in raw.splitlines():
        value = checkpoint.search(line)
        if value:
            checkpoints[value[1]] += 1
        value = failure.search(line)
        if value:
            failures += 1
            cleanup += int(value[4] == 'True')
            if value[4] == 'False':
                last_failure = {'phase': value[1] if value[1] in phases else 'none', 'errorType': value[2],
                    'browserCode': value[3] if value[3] in codes else 'none',
                    'reason': value[5] if value[5] in reasons else 'none',
                    'subphase': value[6] if value[6] in subphases else 'none'}
                if first_failure is None:
                    first_failure = last_failure
    return {'checkpoints': checkpoints, 'failureCount': failures, 'cleanupFailureCount': cleanup,
            'firstFailure': first_failure, 'lastFailure': last_failure,
            'provesOfficialOtpAcceptance': False, 'rawOutputSuppressed': True}


def registration_business(d, expected):
    # A business read may follow a registered cold resume with a new profile.
    # Full runtime/unchanged-service proof remains required; only a10's job
    # snapshot comparison is left to the publication and handoff entry points.
    runtime = readback(d, expected, check_task=False)
    directory = (d.BASE / 'current').resolve()
    record = json.loads((directory / STATE_FILE).read_text())
    email_mac = record['registrationTask']['emailHashHmac']
    d.require(re.fullmatch(r'[a-f0-9]{64}', email_mac), 'API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE')
    code = BUSINESS_SOURCE.replace('__TASK__', json.dumps(TASK_ID)).replace('__BINDING__', json.dumps(TASK_BINDING)).replace('__EMAIL_MAC__', json.dumps(email_mac))
    task = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    fields = {'taskId', 'attempt', 'state', 'step', 'reason', 'registered', 'passwordVerified', 'mfaVerified',
        'accountRegistered', 'encryptedPasswordPresent', 'encryptedMfaPresent', 'leaseActive', 'profileBindingConfirmed',
        'launchAt', 'updatedAt', 'progressCount', 'progressTruncated', 'codeReadCount', 'codeReadTruncated',
        'officialThisAttempt', 'passwordThisAttempt', 'mfaThisAttempt', 'officialAt', 'passwordAt', 'mfaAt'}
    booleans = {'registered', 'passwordVerified', 'mfaVerified', 'accountRegistered', 'encryptedPasswordPresent',
        'encryptedMfaPresent', 'leaseActive', 'profileBindingConfirmed', 'progressTruncated', 'codeReadTruncated',
        'officialThisAttempt', 'passwordThisAttempt', 'mfaThisAttempt'}
    d.require(isinstance(task, dict) and set(task) == fields and task['taskId'] == TASK_ID
              and type(task['attempt']) is int and 10 <= task['attempt'] <= 2147483647
              and task['state'] in ('queued', 'running', 'awaiting_email', 'awaiting_user', 'partial', 'completed', 'cancelled')
              and task['step'] in ('queued', 'email', 'email_code', 'profile', 'registered', 'password', 'password_verified', 'mfa', 'mfa_verified', 'offer', 'completed')
              and task['reason'] in ('none', 'other', 'session_load_timeout', 'session_network_error', 'browser_operation_failed',
                  'operation_cancelled', 'verification_required', 'http_error', 'form_unrecognized', 'official_login_email_mismatch',
                  'official_login_not_verified', 'registration_authorization_expired', 'mailbox_timeout', 'password_unverified',
                  'mfa_unverified', 'unsupported_login_provider', 'login_form_ambiguous', 'window_missing', 'mail_value_invalid')
              and all(type(task[n]) is bool for n in booleans)
              and all(type(task[n]) is int and 0 <= task[n] <= 1000 for n in ('progressCount', 'codeReadCount'))
              and all(isinstance(task[n], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', task[n])
                  for n in ('launchAt', 'updatedAt'))
              and all(task[n] is None or isinstance(task[n], str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', task[n])
                  for n in ('officialAt', 'passwordAt', 'mfaAt'))
              and all(task[flag] is (task[at] is not None) for flag, at in (
                  ('officialThisAttempt', 'officialAt'), ('passwordThisAttempt', 'passwordAt'), ('mfaThisAttempt', 'mfaAt'))),
              'API_ADMIN_REGISTRATION_BUSINESS_UNAVAILABLE')
    logs = business_logs(d, directory, task)
    after_task = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=40))
    d.require(after_task == task and (d.BASE / 'current').resolve() == directory and snapshot(d, directory) == runtime['services'],
              'API_ADMIN_REGISTRATION_BUSINESS_MOVED')
    confirmed = all(task[n] is True for n in ('registered', 'passwordVerified', 'mfaVerified', 'accountRegistered',
        'encryptedPasswordPresent', 'encryptedMfaPresent', 'profileBindingConfirmed', 'officialThisAttempt',
        'passwordThisAttempt', 'mfaThisAttempt')) and task['progressTruncated'] is False
    confirmed = confirmed and task['state'] == 'completed' and task['step'] == 'completed' and task['leaseActive'] is False
    return {'status': 'API_REGISTRATION_BUSINESS_OBSERVED', 'commit': expected, 'task': task,
            'diagnostic': logs, 'businessAcceptanceConfirmed': confirmed, 'readOnly': True}


def handoff_directory(d):
    return d.BASE / '.staging' / ('api-registration-handoff-' + REGISTRATION_CURRENT)


def ordinary_handoff_record(task):
    return {'version': 1, 'scope': SCOPE, 'commit': REGISTRATION_CURRENT,
            'task': task, 'privateCancelConfirmed': True, 'databaseWrites': 0,
            'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
            'windowRetained': False}


def recovery_marker(task, states):
    return {'version': 1, 'scope': SCOPE, 'taskId': TASK_ID, 'attempt': TASK_ATTEMPT,
            'privatePostBudget': 0, 'signalPassBudget': 1, 'signal': 'SIGTERM',
            'containerId': states['auto-registration']['containerId'], 'taskSha256': fingerprint(task),
            'servicesSha256': fingerprint(states), 'firstFailureSha256': fingerprint(HANDOFF_FAILURE),
            'nativeProbeSourceSha256': hashlib.sha256(NATIVE_HANDOFF_SOURCE.encode()).hexdigest()}


def require_native_handoff(d, directory, record):
    folder = handoff_failed_attempt(d, require_unconfirmed=False)
    d.require(not (folder / 'recovery-failure.json').exists() and not (folder / 'recovery-failure.json').is_symlink(),
              'API_ADMIN_REGISTRATION_RECOVERY_FAILED')
    marker = handoff_json(d, folder, 'recovery-attempt.json')
    task = registration_task(d, directory)
    fields = {'version', 'scope', 'commit', 'task', 'privateCancelConfirmed', 'windowClosure',
              'privateMemoryRetained', 'resourceClosed', 'databaseWrites', 'accountPreserved', 'taskPreserved',
              'passwordCandidatePreserved', 'servicesSha256', 'audit', 'auditFile', 'auditRawSha256', 'recoveryAttemptSha256'}
    d.require(isinstance(record, dict) and set(record) == fields and type(record['version']) is int and record['version'] == 2
              and record['scope'] == SCOPE and record['commit'] == REGISTRATION_CURRENT and fingerprint(record['task']) == fingerprint(task)
              and record['privateCancelConfirmed'] is False and record['windowClosure'] == 'owned_native_process_exit'
              and all(record[n] is True for n in ('privateMemoryRetained', 'resourceClosed', 'accountPreserved',
                  'taskPreserved', 'passwordCandidatePreserved')) and type(record['databaseWrites']) is int
              and record['databaseWrites'] == 0 and record['servicesSha256'] == REGISTRATION_STATES_SHA
              and re.fullmatch(r'handoff-recover-[0-9]+-[0-9]+-after-audit\.json', record['auditFile'])
              and re.fullmatch(r'[a-f0-9]{64}', record['auditRawSha256']),
              'API_ADMIN_REGISTRATION_NATIVE_RECORD_CHANGED')
    wanted = {'version': 1, 'scope': SCOPE, 'taskId': TASK_ID, 'attempt': TASK_ATTEMPT,
              'privatePostBudget': 0, 'signalPassBudget': 1, 'signal': 'SIGTERM', 'containerId': marker.get('containerId'),
              'taskSha256': fingerprint(task), 'servicesSha256': REGISTRATION_STATES_SHA,
              'firstFailureSha256': fingerprint(HANDOFF_FAILURE),
              'nativeProbeSourceSha256': hashlib.sha256(NATIVE_HANDOFF_SOURCE.encode()).hexdigest()}
    d.require(fingerprint(marker) == fingerprint(wanted) and fingerprint(marker) == record['recoveryAttemptSha256'],
              'API_ADMIN_REGISTRATION_RECOVERY_MARKER_CHANGED')
    audit_path = folder / record['auditFile']
    d.require(audit_path.lstat().st_uid == 0 and hashlib.sha256(d.fixed_recharge_bytes(
        audit_path, modes=(0o400,), limit=128 * 1024)).hexdigest() == record['auditRawSha256']
        and audit_receipt(d, audit_path) == record['audit'], 'API_ADMIN_REGISTRATION_RECOVERY_AUDIT_CHANGED')
    state = d.service_state(directory, 'auto-registration', include_container_id=True, include_environment_hash=True)
    d.require(state['containerId'] == marker['containerId'], 'API_ADMIN_REGISTRATION_NATIVE_CONTAINER_CHANGED')
    registration_private(d, directory, retained=True)
    observed = native_handoff(d, directory, marker['containerId'])
    d.require(observed['resourceClosed'] is True and observed['zeroObservations'] == 2,
              'API_ADMIN_REGISTRATION_NATIVE_REMAINS')
    d.require(registration_task(d, directory) == task and d.service_state(directory, 'auto-registration',
        include_container_id=True, include_environment_hash=True) == state,
        'API_ADMIN_REGISTRATION_RECOVERY_MOVED')
    registration_private(d, directory, retained=True)
    return record


def registration_handoff_recovery(d, expected, *, recover=False):
    d.require(REGISTRATION and expected == REGISTRATION_CURRENT, 'API_ADMIN_SCOPE_CONFLICT')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
        folder = handoff_failed_attempt(d)
        marker_path = folder / 'recovery-attempt.json'
        if recover:
            d.require(not marker_path.exists() and not marker_path.is_symlink(),
                      'API_ADMIN_REGISTRATION_RECOVERY_ALREADY_ATTEMPTED')
        directory, manifest, states, evidence = baseline(d, expected, check_jobs=False)
        configuration = configuration_hashes(directory)
        task = registration_task(d, directory)
        guards = jobs_idle(d, directory, allow_retained=True)
        private = registration_private(d, directory, retained=guards['registrationWindowRetained'])
        stem = f'handoff-{"recover" if recover else "observe"}-{time.time_ns()}-{os.getpid()}'
        before_audit = strict_audit(d, directory, folder / (stem + '-before-audit.json'))
        first = native_handoff(d, directory, states['auto-registration']['containerId'])
        if recover and not guards['registrationWindowRetained']:
            d.require(first['resourceClosed'] is True, 'API_ADMIN_REGISTRATION_NATIVE_REMAINS')
        marker = recovery_marker(task, states)
        if recover:
            with marker_path.open('x') as stream:
                json.dump(marker, stream, sort_keys=True)
            marker_path.chmod(0o400)
        native, signal_started = None, False
        try:
            if recover and guards['registrationWindowRetained']:
                signal_started = True
                native = native_handoff(d, directory, marker['containerId'], recover=True)
            else:
                native = first
            after_directory, after_manifest, after_states, after_evidence = baseline(d, expected, check_jobs=False)
            after_task = registration_task(d, directory)
            after_guards = jobs_idle(d, directory, allow_retained=True)
            after_private = registration_private(d, directory, retained=after_guards['registrationWindowRetained'])
            after_audit_path = folder / (stem + '-after-audit.json')
            after_audit = strict_audit(d, directory, after_audit_path)
            last = native_handoff(d, directory, marker['containerId'])
            d.require(after_directory == directory and after_manifest == manifest and after_states == states
                      and configuration_hashes(directory) == configuration and after_task == task
                      and after_guards == guards and after_private == private and after_audit == before_audit
                      and all(after_evidence[k] == evidence[k] for k in ('manifestSha256', 'environmentSha256', 'apiSource'))
                      and (last['resourceClosed'] is True if recover else last == first),
                      'API_ADMIN_REGISTRATION_RECOVERY_MOVED')
            handoff_failed_attempt(d)
            if not recover:
                return {'status': 'API_REGISTRATION_HANDOFF_OBSERVED', 'commit': expected, 'readOnly': True,
                        'services': states, 'task': task, 'guards': guards, 'audit': after_audit,
                        'private': private, 'native': last, 'firstFailure': HANDOFF_FAILURE,
                        'recoveryAlreadyAttempted': marker_path.exists()}
            d.require(fingerprint(handoff_json(d, folder, 'recovery-attempt.json')) == fingerprint(marker),
                      'API_ADMIN_REGISTRATION_RECOVERY_MARKER_CHANGED')
            if not guards['registrationWindowRetained']:
                record = ordinary_handoff_record(task)
            else:
                after_audit_path.chmod(0o400)
                record = {'version': 2, 'scope': SCOPE, 'commit': expected, 'task': task,
                    'privateCancelConfirmed': False, 'windowClosure': 'owned_native_process_exit',
                    'privateMemoryRetained': True, 'resourceClosed': True, 'databaseWrites': 0,
                    'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
                    'servicesSha256': fingerprint(states), 'audit': after_audit, 'auditFile': after_audit_path.name,
                    'auditRawSha256': hashlib.sha256(after_audit_path.read_bytes()).hexdigest(),
                    'recoveryAttemptSha256': fingerprint(marker)}
            with (folder / 'confirmed.json').open('x') as stream:
                json.dump(record, stream, sort_keys=True)
            (folder / 'confirmed.json').chmod(0o400)
            require_registration_handoff(d, directory, manifest)
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected,
                    'privateCancelPerformed': False, 'signalsAttempted': native['signalsAttempted'],
                    'resourceClosed': True, 'privateMemoryRetained': guards['registrationWindowRetained'],
                    'accountPreserved': True, 'taskPreserved': True, 'passwordCandidatePreserved': True,
                    'databaseWrites': 0, 'businessAcceptanceConfirmed': False}
        except Exception as error:
            if recover:
                diagnostic = dict(error.diagnostic) if isinstance(error, RegistrationRecoveryError) else {
                    'confirmed': False, 'signalsAttempted': native['signalsAttempted'] if native is not None else
                        None if signal_started else 0, 'nativeCount': 0, 'nativeCountObserved': False,
                    'rawOutputSuppressed': True}
                if native is not None:
                    diagnostic['signalsAttempted'] = native['signalsAttempted']
                path = folder / 'recovery-failure.json'
                with path.open('x') as stream:
                    json.dump(diagnostic, stream, sort_keys=True)
                path.chmod(0o400)
                code = str(error)
                if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
                    code = 'API_ADMIN_REGISTRATION_RECOVERY_UNAVAILABLE'
                raise RegistrationRecoveryError(code, diagnostic) from None
            raise


def require_registration_handoff(d, directory, manifest):
    if manifest.get('apiRegistrationPublication'):
        return
    record = handoff_json(d, handoff_directory(d), 'confirmed.json')
    if record.get('version') == 2:
        return require_native_handoff(d, directory, record)
    current = registration_task(d, directory)
    d.require(fingerprint(record) == fingerprint(ordinary_handoff_record(current)), 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
    registration_private(d, directory, retained=False)
    return record


def registration_preflight(d, expected, *, require_closed=False):
    directory, manifest, states, evidence = baseline(d, expected, check_jobs=False)
    guards = jobs_idle(d, directory, allow_retained=True)
    task = registration_task(d, directory)
    registration_private(d, directory, retained=guards['registrationWindowRetained'])
    closed = require_closed or (handoff_directory(d) / 'confirmed.json').exists()
    if closed:
        require_registration_handoff(d, directory, manifest)
    folder = Path(__file__).parent
    audit_path = folder / 'api-registration-preflight-audit.json'
    audit = strict_audit(d, directory, audit_path)
    d.require(snapshot(d, directory) == states and registration_task(d, directory) == task,
              'API_ADMIN_REGISTRATION_PREFLIGHT_CHANGED')
    return {'status': 'API_REGISTRATION_BASELINE_VERIFIED', 'commit': expected, 'services': states,
            **evidence, 'guards': guards, 'task': task, 'audit': audit,
            'requiresWindowHandoff': guards['registrationWindowRetained'] and not closed}


def registration_handoff(d, expected):
    d.require(REGISTRATION and expected == REGISTRATION_CURRENT, 'API_ADMIN_SCOPE_CONFLICT')
    os.umask(0o077)
    with (d.BASE / '.deploy.lock').open('a') as lock:
        d.fcntl.flock(lock, d.fcntl.LOCK_EX | d.fcntl.LOCK_NB)
        proof = registration_preflight(d, expected)
        directory = Path(REGISTRATION_DIRECTORY)
        folder = handoff_directory(d)
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        d.require(folder.resolve() == folder and stat.S_IMODE(folder.stat().st_mode) == 0o700
                  and folder.stat().st_uid == 0, 'API_ADMIN_REGISTRATION_HANDOFF_OWNER_CHANGED')
        if not proof['requiresWindowHandoff']:
            require_registration_handoff(d, directory, {'commit': expected})
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected, 'privateCancelPerformed': False}
        marker = folder / 'attempt.json'
        d.require(not marker.exists(), 'API_ADMIN_REGISTRATION_HANDOFF_ALREADY_ATTEMPTED')
        with marker.open('x') as stream:
            json.dump({'taskId': TASK_ID, 'attempt': TASK_ATTEMPT, 'privatePostBudget': 1}, stream)
        marker.chmod(0o400)
        try:
            registration_private(d, directory, close=True)
            d.require(snapshot(d, directory) == proof['services'] and registration_task(d, directory) == proof['task'],
                      'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
            jobs_idle(d, directory)
            record = {'version': 1, 'scope': SCOPE, 'commit': expected, 'task': proof['task'],
                      'privateCancelConfirmed': True, 'databaseWrites': 0, 'accountPreserved': True,
                      'taskPreserved': True, 'passwordCandidatePreserved': True, 'windowRetained': False}
            path = folder / 'confirmed.json'
            with path.open('x') as stream:
                json.dump(record, stream, sort_keys=True)
            path.chmod(0o400)
            require_registration_handoff(d, directory, {'commit': expected})
            return {'status': 'API_REGISTRATION_HANDOFF_VERIFIED', 'commit': expected,
                    'privateCancelPerformed': True, 'accountPreserved': True, 'taskPreserved': True,
                    'databaseWrites': 0, 'windowRetained': False, 'businessAcceptanceConfirmed': False}
        except RegistrationHandoffError as error:
            path = folder / 'failure.json'
            with path.open('x') as stream:
                json.dump(error.diagnostic, stream, sort_keys=True)
            path.chmod(0o400)
            raise


def registration_public_map(d, directory):
    d.require(directory.resolve() == directory, 'API_ADMIN_REGISTRATION_SOURCE_LOCATION_CHANGED')
    paths = list(directory.rglob('*'))
    d.require(len(paths) <= 7000, 'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
    result, total = {}, 0
    for path in paths:
        d.require(not path.is_symlink(), 'API_ADMIN_REGISTRATION_SOURCE_CHANGED')
        if path.is_dir():
            continue
        name = path.relative_to(directory).as_posix()
        if name in REGISTRATION_PRIVATE:
            continue
        d.require(len(result) < 5000, 'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
        limit = 1024 * 1024 if name == 'scripts/production-release/remote-deploy.py' else 8 * 1024 * 1024
        raw = d.fixed_recharge_bytes(path, modes=(0o644, 0o755, 0o664), limit=limit)
        total += len(raw)
        mode = stat.S_IMODE(path.lstat().st_mode)
        d.require(total <= 64 * 1024 * 1024
                  and (mode in (0o644, 0o755) or name == 'docker-compose.aws-mysql.yml' and mode == 0o664),
                  'API_ADMIN_REGISTRATION_SOURCE_TOO_LARGE')
        result[name] = (hashlib.sha256(raw).hexdigest(), mode)
    return {'fileCount': len(result), 'sha256': hashlib.sha256(json.dumps(result,
        ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def worker_source(d, directory, service, rows):
    expected = {n[len(WORKER_PREFIX):]: r['sha256'] for n, r in rows.items()}
    code = ('import hashlib,json\nfrom pathlib import Path\nnames=' + repr(sorted(expected))
            + '\nprint(json.dumps({n:hashlib.sha256((Path("/app")/n).read_bytes()).hexdigest() for n in names}))')
    value = json.loads(d.compose(directory, 'exec', '-T', service, 'python', '-B', '-c', code, timeout=20))
    d.require(value == expected and len(value) == 60, 'API_ADMIN_REGISTRATION_RUNTIME_SOURCE_CHANGED')
    return fingerprint(value)


def registration_native_baseline(d, previous, manifest, states, raw):
    d.require(str(previous) == REGISTRATION_DIRECTORY and manifest['commit'] == REGISTRATION_CURRENT
              and hashlib.sha256(raw).hexdigest() == REGISTRATION_MANIFEST_SHA
              and fingerprint(states) == REGISTRATION_STATES_SHA
              and registration_public_map(d, previous) == REGISTRATION_PUBLIC,
              'API_ADMIN_REGISTRATION_CURRENT_CHANGED')
    profile = registration_profile(d, previous)
    provenance = manifest['fixedRegistrationRelease']
    d.require(provenance['id'] == profile['id'] and provenance['profileRawSha256'] == REGISTRATION_PROFILE_SHA
              and provenance['workerProjectionSha256'] == profile['workerProjectionSha256']
              and manifest['servicesUpdated'] == ['auto-registration'] and manifest['migrationApplied'] is False
              and manifest['newMigrations'] == [], 'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
    metadata = json.loads(d.run('docker', 'image', 'inspect', states['auto-registration']['image']))[0]
    labels = metadata['Config'].get('Labels', {})
    d.require(metadata['Id'] == states['auto-registration']['image'] and metadata['Architecture'] == 'amd64'
              and labels.get('org.opencontainers.image.revision') == REGISTRATION_CURRENT
              and labels.get('id-business-v2.worker-projection-sha256') == profile['workerProjectionSha256'],
              'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
    worker_source(d, previous, 'auto-registration', profile['workerProjection'])
    pro = json.loads((previous / 'deploy/aws/recharge-pro-6f5-20261008.json').read_text())
    pro_sha = worker_source(d, previous, 'auto-recharge', pro['workerProjection'])
    d.require(pro_sha == profile['runtimeBaseline']['proWorkerSourceSha256'],
              'API_ADMIN_REGISTRATION_PRESERVED_PRO_CHANGED')
    content = content_summary(d, 'api', d.compose(previous, 'exec', '-T', 'api', '/bin/sh', '-c', content_command('api')))
    d.require(content == REGISTRATION_API_CONTENT, 'API_ADMIN_REGISTRATION_RETAINED_API_CHANGED')
    compiled = profile['runtimeBaseline']['apiCompiledSourceSha256']
    code = ('const fs=require("node:fs"),c=require("node:crypto");const names=' + json.dumps(sorted(compiled))
            + ';console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash("sha256").update(fs.readFileSync("/app/"+n)).digest("hex")]))));')
    measured = json.loads(d.compose(previous, 'exec', '-T', 'api', 'node', '-e', code, timeout=20))
    proof = json.loads((previous / 'api-admin-build-proof.json').read_text())
    d.require(measured == compiled and fingerprint(proof) == profile['runtimeBaseline']['apiBuildProofSha256']
              and proof['commit'] == profile['runtimeBaseline']['apiRuntimeRevision']
              and proof['images']['api']['imageId'] == states['api']['image']
              and {k: proof['images']['api'][k] for k in ('fileCount', 'sha256')} == content,
              'API_ADMIN_REGISTRATION_RETAINED_API_CHANGED')
    return {'kind': 'VERIFIED_EXISTING_API_REGISTRATION_SOURCE', 'profileRawSha256': REGISTRATION_PROFILE_SHA,
            'workerProjectionSha256': profile['workerProjectionSha256'], 'apiContent': content,
            'apiCompiledSourceSha256': fingerprint(measured), 'proWorkerSourceSha256': pro_sha}


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
        if manifest.get('apiAdminMigrationPublication'):
            d.require(MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
            proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
            d.require(manifest['apiAdminMigrationPublication'] == {'version': 1, 'scope': SCOPE,
                'buildProofSha256': fingerprint(proof), 'workersPublished': False,
                'cacheStatus': 'SKIPPED', 'configurationChanged': False, 'schemaChanged': True,
                'migration': MIGRATION_IDENTITY} and manifest.get('migrationApplied') is True
                and manifest.get('newMigrations') == [MIGRATION_FILE],
                'API_ADMIN_MIGRATION_PROVENANCE_CHANGED')
            migration_source_check(d, previous)
            verify_running(d, previous, proof)
            verify_migration_image(d, previous, proof)
            source['kind'] = 'API_ADMIN_MIGRATION_BUILD_PROVEN'
        elif manifest.get('apiRegistrationPublication'):
            d.require(REGISTRATION or MIGRATION_MODE, 'API_ADMIN_SCOPE_CONFLICT')
            origin, _ = d.api_admin_scope('API_REGISTRATION')
            proof = origin.validate_proof(d, json.loads((previous / origin.PROOF_FILE).read_text()),
                                          expected, manifest['sourceTree'])
            d.require(manifest['apiRegistrationPublication'] == {'version': 1, 'scope': 'API_REGISTRATION',
                'buildProofSha256': fingerprint(proof), 'workersPublished': True,
                'cacheStatus': 'SKIPPED', 'configurationChanged': False}, 'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
            if MIGRATION_MODE:
                d.require(manifest.get('servicesUpdated') == ['api', 'auto-registration']
                          and manifest.get('migrationApplied') is False and manifest.get('newMigrations') == [],
                          'API_ADMIN_REGISTRATION_PROVENANCE_CHANGED')
            origin.verify_running(d, previous, proof)
            source['kind'] = 'API_REGISTRATION_BUILD_PROVEN'
        elif REGISTRATION or MIGRATION_MODE:
            source.update(registration_native_baseline(d, previous, manifest, states, raw))
        elif manifest.get('apiAdminPublication'):
            proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
            verify_running(d, previous, proof)
            source['kind'] = 'API_ADMIN_BUILD_PROVEN'
        elif manifest.get('fixedRegistrationRelease', {}).get('id') == d.REGISTRATION_FOLLOWUP_ID:
            # 94 keeps the 815 API/Admin image; its own manifest revision describes only the Worker.
            d.require('apiAdminPublication' not in manifest, 'API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS')
            profile_raw = (previous / d.REGISTRATION_FOLLOWUP_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            receipt = d.check_registration_followup_deployment(expected, manifest['sourceTree'], profile_sha256)
            provenance = manifest['fixedRegistrationRelease']
            d.require(receipt['apiRuntimeRevision'] == source['revision'] == provenance['apiRuntimeRevision']
                      and receipt['apiBuildProofSha256'] == provenance['apiBuildProofSha256']
                      and receipt['apiContentSha256'] == provenance['apiContentSha256']
                      and receipt['adminContentSha256'] == provenance['adminContentSha256'],
                      'API_ADMIN_RETAINED_PUBLICATION_CHANGED')
            source.update(kind='VERIFIED_RETAINED_API_ADMIN_PUBLICATION',
                          profileId=d.REGISTRATION_FOLLOWUP_ID, profileRawSha256=profile_sha256,
                          buildProofSha256=receipt['apiBuildProofSha256'],
                          apiContentSha256=receipt['apiContentSha256'], adminContentSha256=receipt['adminContentSha256'])
        elif manifest.get('fixedRegistrationRelease', {}).get('id') == 'registration-worker-95-20261008':
            d.load_registration_interstitial95()
            # 95 keeps the 815 API/Admin image; its own manifest revision describes only the Worker.
            d.require('apiAdminPublication' not in manifest, 'API_ADMIN_RETAINED_PUBLICATION_AMBIGUOUS')
            profile_raw = (previous / d.REGISTRATION_INTERSTITIAL_FILE).read_bytes()
            profile_sha256 = hashlib.sha256(profile_raw).hexdigest()
            receipt = d.check_registration_interstitial_deployment(expected, manifest['sourceTree'], profile_sha256)
            provenance = manifest['fixedRegistrationRelease']
            d.require(receipt['apiRuntimeRevision'] == source['revision'] == provenance['apiRuntimeRevision']
                      and receipt['apiBuildProofSha256'] == provenance['apiBuildProofSha256']
                      and receipt['apiContentSha256'] == provenance['apiContentSha256']
                      and receipt['adminContentSha256'] == provenance['adminContentSha256'],
                      'API_ADMIN_RETAINED_PUBLICATION_CHANGED')
            source.update(kind='VERIFIED_RETAINED_API_ADMIN_PUBLICATION',
                          profileId=d.REGISTRATION_INTERSTITIAL_ID, profileRawSha256=profile_sha256,
                          buildProofSha256=receipt['apiBuildProofSha256'],
                          apiContentSha256=receipt['apiContentSha256'], adminContentSha256=receipt['adminContentSha256'])
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
        if REGISTRATION and check_jobs:
            require_registration_handoff(d, previous, manifest)
        migration_state = migration_database_state(d, previous) if MIGRATION_MODE else None
        stage = 'SNAPSHOT'
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_POINTER_MOVED')
        d.require((previous / 'release-manifest.json').read_bytes() == raw, 'API_ADMIN_BASELINE_MANIFEST_CHANGED')
        d.require(snapshot(d, previous) == states, 'API_ADMIN_BASELINE_SERVICES_CHANGED')
        evidence = {'manifestSha256': hashlib.sha256(raw).hexdigest(),
            'environmentSha256': hashlib.sha256((previous / '.env.aws.production').read_bytes()).hexdigest(),
            'apiSource': source, 'guards': guards, 'freeBytes': free_bytes}
        if MIGRATION_MODE:
            evidence['migrationState'] = migration_state
        return previous, manifest, states, evidence
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
        if service == 'auto-registration':
            d.require(labels.get('id-business-v2.worker-projection-sha256') == proof['workerProjectionSha256'],
                      'API_ADMIN_REGISTRATION_PROJECTION_CHANGED')
            worker_source(d, directory, service, proof['workerProjection'])


def configuration_hashes(directory):
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in (*CONFIG_FILES, 'compose.release.json')}


def require_preserved(d, previous, release, before, environment, *, all_services=False):
    d.require((previous / '.env.aws.production').read_bytes() == environment
              and (release / '.env.aws.production').read_bytes() == environment,
              'API_ADMIN_ENVIRONMENT_CHANGED')
    for name in CONFIG_FILES:
        if MIGRATION_MODE and name == MIGRATION_SCHEMA:
            continue
        d.require((previous / name).read_bytes() == (release / name).read_bytes(), 'API_ADMIN_CONFIG_OR_SCHEMA_CHANGED')
    if MIGRATION_MODE:
        migration_source_check(d, previous, candidate=False)
        migration_source_check(d, release)
        d.require(d.migration_plan(previous, release) in ([], [MIGRATION_FILE]), 'API_ADMIN_MIGRATION_SCOPE_CHANGED')
    else:
        d.require(d.migration_plan(previous, release) == [], 'API_ADMIN_MIGRATIONS_FORBIDDEN')
    states = snapshot(d, previous)
    d.require(all(states[name] == before[name] for name in before if all_services or name not in UPDATED),
              'API_ADMIN_PRESERVED_CONTAINER_CHANGED')
    old = json.loads((previous / 'compose.release.json').read_text())
    new = json.loads((release / 'compose.release.json').read_text())
    d.require(set(old) == set(new) == {'services'} and set(old['services']) == set(new['services'])
              and all(old['services'][name] == new['services'][name] for name in old['services'] if name not in IMAGE_SERVICES),
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


def readback(d, expected, *, check_task=True):
    d.require(not MIGRATION_MODE or check_task, 'API_ADMIN_SCOPE_CONFLICT')
    previous, manifest, states, evidence = baseline(d, expected, check_jobs=False)
    record = json.loads((previous / STATE_FILE).read_text())
    proof = validate_proof(d, json.loads((previous / PROOF_FILE).read_text()), expected, manifest['sourceTree'])
    d.require(manifest.get('servicesUpdated') == list(UPDATED)
              and manifest.get('migrationApplied') is (True if MIGRATION_MODE else False)
              and manifest.get('newMigrations') == ([MIGRATION_FILE] if MIGRATION_MODE else [])
              and record['buildProofSha256'] == fingerprint(proof)
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
    if REGISTRATION and check_task:
        jobs_idle(d, previous)
        d.require(registration_task(d, previous) == record['registrationTask'], 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
    migration = {}
    if MIGRATION_MODE:
        state = migration_database_state(d, previous)
        d.require(state['status'] == 'APPLIED' and all(record['migration'][n] == state[n] for n in state)
                  and type(manifest.get('migrationPerformed')) is bool
                  and record['migration']['performed'] is manifest['migrationPerformed'],
                  'API_ADMIN_MIGRATION_READBACK_CHANGED')
        backup = json.loads((previous / 'backup-verification.json').read_text())
        d.require(backup.get('name') == manifest.get('backupBeforeRelease') and backup.get('s3Verified') is True
                  and type(backup.get('size')) is int and backup['size'] > 0
                  and re.fullmatch(r'[a-f0-9]{64}', backup.get('sha256', '')),
                  'API_ADMIN_MIGRATION_BACKUP_CHANGED')
        migration_task_guard(d, previous, record['registrationTask'], record['registrationGuards'])
        verify_migration_image(d, previous, proof)
        migration = {'migration': dict(MIGRATION_IDENTITY), 'migrationState': state,
                     'migrationApplied': True, 'migrationPerformed': manifest['migrationPerformed'],
                     'taskHmacMatched': True, 'windowPreserved': True,
                     'registrationWindowRetained': record['registrationGuards']['registrationWindowRetained']}
    return {'status': SCOPE + '_VERIFIED', 'commit': expected, 'sourceTree': proof['sourceTree'],
            'servicesUpdated': list(UPDATED), 'preservedServiceCount': 5,
            'runningImagesAndContentMatched': True, 'buildProofSha256': fingerprint(proof),
            'environmentUnchanged': True, 'services': states, **migration}


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
        print(json.dumps({'status': SCOPE + '_FAILED_STATE_UNVERIFIED', 'step': 'controller',
                          'code': code, 'errorType': type(error).__name__}))
        return 1


def _release_locked(d, args):
    d.require(not args.admin_only and not any(value for key, value in vars(args).items()
        if key.startswith(('historical_', 'registration_worker_', 'recharge_pro_')))
        and not any((args.image_commit, args.image_run_id, args.image_run_attempt,
                     args.post_cleanup_seal_sha256, args.order_archive_seal_sha256,
                     args.order_archive_prepared_images_sha256))
        and not (REGISTRATION and getattr(args, 'api_admin_only', False))
        and not (not REGISTRATION and getattr(args, 'api_registration_only', False))
        and not (MIGRATION_MODE and getattr(args, 'api_admin_only', False))
        and (getattr(args, 'api_admin_migration_only', False) is MIGRATION_MODE), 'API_ADMIN_SCOPE_CONFLICT')
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
    original_task = registration_task(d, previous) if REGISTRATION or MIGRATION_MODE else None
    if MIGRATION_MODE:
        migration_task_guard(d, previous, original_task, evidence['guards'])
    migration_result = {**evidence['migrationState'], 'performed': False} if MIGRATION_MODE else None
    migration_attempted = False
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
        if MIGRATION_MODE:
            migration_source_check(d, target)
        if REGISTRATION:
            d.require(all(hashlib.sha256((target / n).read_bytes()).hexdigest() == proof['workerProjection'][n]['sha256']
                          and stat.S_IMODE((target / n).stat().st_mode) in (0o644, 0o664) for n in WORKER_PAIR),
                      'API_ADMIN_REGISTRATION_PAIR_CHANGED')
        d.require((target / 'scripts/production-release/api-admin-scope.py').read_bytes() == Path(__file__).read_bytes()
                  and (target / 'scripts/production-release/remote-deploy.py').read_bytes() == Path(d.__file__).read_bytes(),
                  'API_ADMIN_EXECUTOR_SOURCE_CHANGED')
        shutil.copy2(previous / '.env.aws.production', target / '.env.aws.production')
        override = json.loads((previous / 'compose.release.json').read_text())
        for name in IMAGE_SERVICES:
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
            for name in IMAGE_SERVICES:
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
        if MIGRATION_MODE:
            verify_migration_image(d, target, proof, inspect_content=True)
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
        if MIGRATION_MODE:
            step = 'migration'
            migration_task_guard(d, previous, original_task, evidence['guards'])
            migration_attempted = migration_result['status'] == 'PENDING'
            migration_result = apply_migration(d, target)
            require_preserved(d, previous, target, before, environment, all_services=True)
            migration_task_guard(d, previous, original_task, evidence['guards'])
        step = 'switch'
        for name in SWITCH_ORDER:
            require_preserved(d, previous, target, before, environment)
            if MIGRATION_MODE:
                migration_task_guard(d, previous, original_task, evidence['guards'])
            if name == 'api' or REGISTRATION:
                jobs_idle(d, previous)
                if REGISTRATION:
                    require_registration_handoff(d, previous, old)
                    d.require(registration_task(d, previous) == original_task, 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
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
        if REGISTRATION or MIGRATION_MODE:
            d.require(registration_task(d, target) == original_task, 'API_ADMIN_REGISTRATION_HANDOFF_CHANGED')
            record['registrationTask'] = original_task
        if MIGRATION_MODE:
            migration_task_guard(d, target, original_task, evidence['guards'])
            record.update(registrationGuards=evidence['guards'], migration=migration_result)
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
                'digest': proof['images'][name]['imageId'], 'sourceCommit': args.commit} for name in IMAGE_SERVICES}},
            backupBeforeRelease=backup['name'], migrationApplied=MIGRATION_MODE,
            newMigrations=[MIGRATION_FILE] if MIGRATION_MODE else [],
            dataAuditBefore=first, dataAuditAfter=second,
            databaseGrants={'status': 'SKIPPED', 'reason': 'API_ADMIN_EXISTING_TABLE_COLUMN_INDEX' if MIGRATION_MODE else 'API_ADMIN_UNCHANGED_SCHEMA'},
            rollback={'release': str(previous), 'images': {name: before[name]['image'] for name in UPDATED}, 'servicesAdded': []},
            **{'apiAdminMigrationPublication' if MIGRATION_MODE else 'apiRegistrationPublication' if REGISTRATION else 'apiAdminPublication':
                {'version': 1, 'scope': SCOPE, 'buildProofSha256': fingerprint(proof),
                 'workersPublished': REGISTRATION, 'cacheStatus': 'SKIPPED', 'configurationChanged': False,
                 **({'schemaChanged': True, 'migration': dict(MIGRATION_IDENTITY)} if MIGRATION_MODE else {})}})
        if MIGRATION_MODE:
            manifest['migrationPerformed'] = migration_result['performed']
        (target / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        d.require((d.BASE / 'current').resolve() == previous, 'API_ADMIN_BASELINE_MOVED')
        d.point_current(target, f'{stamp}-publish')
        result = readback(d, args.commit)
        result.update(backupVerified=True, checkCount=49, violationCount=0)
        print(json.dumps(result))
        return 0
    except Exception as error:
        if MIGRATION_MODE and migration_attempted:
            try:
                observed = migration_database_state(d, target)
                migration_result = {**observed, 'performed': observed['status'] == 'APPLIED'}
            except Exception:
                migration_result = {'status': 'UNVERIFIED', 'performed': None}
        # A new task may start after the last idle read. Do not interrupt it to
        # force rollback. Keep an explicit partial-state receipt for recovery.
        rollback_ok = True
        rollback = {}
        for name in reversed(changed):
            try:
                if name == 'api' or REGISTRATION or MIGRATION_MODE:
                    jobs_idle(d, target)
                if MIGRATION_MODE:
                    d.require(jobs_idle(d, target) == evidence['guards'], 'API_ADMIN_REGISTRATION_TASK_CHANGED')
                    registration_private(d, target, retained=evidence['guards']['registrationWindowRetained'])
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
                if MIGRATION_MODE:
                    migration_task_guard(d, previous, original_task, evidence['guards'])
            except Exception:
                rollback_ok = False
        if rollback_ok and (d.BASE / 'current').resolve() == target:
            try:
                d.point_current(previous, f'{stamp}-recover')
            except Exception:
                rollback_ok = False
        if MIGRATION_MODE and migration_result['status'] == 'UNVERIFIED':
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
        result = {'status': SCOPE + '_FAILED_RESTORED' if changed and rollback_ok
                  else SCOPE + '_FAILED_BEFORE_SWITCH' if not changed and rollback_ok else SCOPE + '_PARTIAL_RECOVERY_REQUIRED',
                  'step': step, 'code': code, 'errorType': type(error).__name__, 'rollbackOk': rollback_ok,
                  'servicesAttempted': changed, 'rollback': rollback, 'actualServices': actual,
                  'candidateCommit': args.commit, 'previousCommit': args.expected_current,
                  'currentPointsToCandidate': (d.BASE / 'current').resolve() == target}
        result['receiptPersisted'] = True
        if MIGRATION_MODE:
            result.update(migration=migration_result,
                migrationApplied=None if migration_result['status'] == 'UNVERIFIED' else migration_result['status'] == 'APPLIED',
                migrationPerformed=migration_result['performed'], migrationAttempted=migration_attempted,
                inverseMigrationPerformed=False)
        try:
            (target / FAILURE_FILE).write_text(json.dumps(result, indent=2) + '\n')
        except Exception:
            result['receiptPersisted'] = False
        print(json.dumps(result))
        return 1


def registration_cli(d, tokens):
    try:
        operation = tokens[0]
        if tokens == ['--write-api-registration-build-proof']:
            build_proof(d)
            return 0
        if tokens == ['--prepare-api-registration-build']:
            result = prepare_registration_build(d)
            print(json.dumps({'status': 'API_REGISTRATION_CONTEXT_PROVEN',
                              'workerProjectionSha256': result['workerProjectionSha256']}))
            return 0
        d.require(len(tokens) == 3 and tokens[1] == '--expected-current'
                  and re.fullmatch(r'[a-f0-9]{40}', tokens[2]), 'API_ADMIN_INPUT_INVALID')
        if operation == '--api-registration-readback':
            result = readback(d, tokens[2])
        elif operation == '--api-registration-business':
            result = registration_business(d, tokens[2])
        elif operation == '--api-registration-handoff':
            result = registration_handoff(d, tokens[2])
        elif operation in ('--api-registration-handoff-observe', '--api-registration-handoff-recover'):
            result = registration_handoff_recovery(d, tokens[2], recover=operation.endswith('-recover'))
        else:
            d.require(operation in ('--api-registration-preflight', '--api-registration-verify'), 'API_ADMIN_INPUT_INVALID')
            result = registration_preflight(d, tokens[2], require_closed=operation.endswith('-preflight'))
        print(json.dumps(result))
        return 0
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'API_ADMIN_[A-Z0-9_]+', code):
            code = 'API_ADMIN_REGISTRATION_READ_UNAVAILABLE'
        result = {'status': 'API_REGISTRATION_VERIFICATION_FAILED', 'code': code, 'errorType': type(error).__name__}
        if isinstance(error, RegistrationHandoffError):
            result['privateDiagnostic'] = error.diagnostic
        if isinstance(error, RegistrationRecoveryError):
            result['recoveryDiagnostic'] = error.diagnostic
        print(json.dumps(result))
        return 1
