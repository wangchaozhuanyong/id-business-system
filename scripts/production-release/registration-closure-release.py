"""Finite forward publication; existing roles, encrypted volume and rollback stay intact."""
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import io
import tarfile
import urllib.request

BASE = Path('/opt/id-business-v2')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
SCOPE = 'REGISTRATION_INVENTORY_AND_PROXY_CLOSURE'


def need(value, code):
    if not value:
        raise RuntimeError('REGISTRATION_CLOSURE_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extra():
    return load(Path(__file__).with_name('recharge-availability-release.py'), 'registration_helpers')


def projected_source_hashes(contract):
    result = dict(contract['changedSources'])
    for name, binding in contract.get('engineSourceProjection', {}).items():
        result['apps/api/src/id-business-v2/online-recharge/engine/' + name] = binding['candidateSha256']
    return result


def verify_proof(proof, plan, contract, payload, h):
    fields = ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources')
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(n) == plan[n] for n in fields)
         and proof.get('engineSourceProjection', {}) == contract.get('engineSourceProjection', {})
         and proof.get('baselinePublishedRecoveryNativeVerified') == {
              'runId': contract['protectedPublishedRecovery']['nativeRunId'],
              'artifactDigest': contract['protectedPublishedRecovery']['nativeArtifactDigest'], 'verified': True}
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminReproduced') is True
         and proof.get('databaseVerification') == {'isolated': True, 'registrationMysqlSqlite': 'PASS',
              'proxyMysql': 'PASS', 'externalRequests': 0, 'businessActions': 0}
         and proof.get('plannedMigration') == contract['migration']
         and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
         and proof['businessActions'] == 0 and proof.get('updatedServices') == ['api', 'admin', 'online-recharge'], 'PROOF_INVALID')
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    need(files == proof.get('files') and
         {n.removeprefix('source/'): v for n, v in files.items() if n.startswith('source/')} == projected_source_hashes(contract), 'PAYLOAD_CHANGED')
    allowed_api = {name.removesuffix('.js') + suffix for name in contract['apiModules'] for suffix in ('.js', '.js.map', '.d.ts')}
    need(set(proof['apiModules']) <= allowed_api and proof['apiModules']
         and set(proof['engineFiles']) == set(contract['engineFiles'])
         and all(n == 'api/schema.prisma' or n.startswith(('source/', 'api/modules/', 'api/worker/', 'api/prisma-client/',
                               'admin/html/', 'online-recharge/engine/')) for n in files), 'PAYLOAD_SCOPE_CHANGED')
    for prefix, field in [('api/modules/', 'apiModules'), ('api/worker/', 'workerFiles'),
                          ('api/prisma-client/', 'prismaClientFiles'), ('admin/html/', 'adminFiles'),
                          ('online-recharge/engine/', 'engineFiles')]:
        need({n.removeprefix(prefix): v for n, v in files.items() if n.startswith(prefix)} == proof[field], 'PAYLOAD_SCOPE_CHANGED')
    need(len(proof['adminFiles']) > 200 and 'index.js' in proof['prismaClientFiles']
         and 'schema.prisma' in proof['prismaClientFiles'], 'GENERATED_CLIENT_MISSING')
    expected_engine = {**contract['baselineEngineInventory'], **proof['engineFiles']}
    expected_engine.pop('SOURCE_MANIFEST.json', None)
    need(proof.get('engineManifestFiles') == expected_engine, 'ENGINE_MANIFEST_CHANGED')
    need(proof.get('adminBuildEnvironment') == {
        'baseline': {'nodeEnv': contract['adminBuildNodeEnv'], 'buildId': contract['baselineBuildId'],
                     'configuration': 'TRACKED_UNCHANGED', 'artifactPostProcessing': False},
        'candidate': {'nodeEnv': contract['adminBuildNodeEnv'], 'buildId': 'v2-' + plan['commit'],
                      'configuration': 'TRACKED_UNCHANGED', 'artifactPostProcessing': False}}
         and proof.get('observedAdminNativeBuild') == contract['observedAdminNativeBuild'], 'ADMIN_BUILD_ENVIRONMENT_CHANGED')
    need(files.get('api/schema.prisma') == contract['changedSources']['apps/api/prisma-mysql/schema.prisma'], 'CANONICAL_SCHEMA_CHANGED')
    return proof


def safe_archive(raw, directory):
    need(not directory.exists(), 'ARTIFACT_OUTPUT_EXISTS')
    directory.mkdir(mode=0o700)
    total, names = 0, set()
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive.getmembers():
            parts = Path(item.name).parts
            total += item.size
            need(parts and parts[0] == 'payload' and not item.name.startswith('/')
                 and '..' not in parts and item.name not in names
                 and (item.isfile() or item.isdir()) and item.size <= 32 * 1024**2
                 and total <= 160 * 1024**2, 'ARTIFACT_PATH_INVALID')
            names.add(item.name)
            path = directory / item.name
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(item).read())
                path.chmod(0o644)
    return directory / 'payload'


def registration_volume(d, states):
    row = json.loads(d.run('docker', 'inspect', states['api']['containerId']))[0]
    mounts = [m for m in row['Mounts'] if m['Destination'] == '/app/.runtime/auto-registration']
    need(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['RW'] is True, 'REGISTRATION_VOLUME_CHANGED')
    path = Path(mounts[0]['Source'])
    need(path.is_absolute() and path.parent.parent == Path('/var/lib/docker/volumes')
         and path.name == '_data' and not path.is_symlink(), 'REGISTRATION_VOLUME_INVALID')
    return path


def inspect_sqlite(d, directory, expected=None, database_path='/app/.runtime/auto-registration/database.db'):
    # FIELD_ENCRYPTION_KEY travels only from API environment through a private child stdin pipe.
    config = {'mode': 'inspect', 'databasePath': database_path}
    if expected is not None:
        config['expectedLogicalSha256'] = expected
    code = """const{spawnSync}=require('child_process');const config=CONFIG;
config.encryptionKey=process.env.FIELD_ENCRYPTION_KEY;
const r=spawnSync('/opt/id-registration/venv/bin/python',['-B','/app/apps/api/src/id-business-v2/auto-registration/worker/release_safety.py'],{input:JSON.stringify(config)+'\\n',encoding:'utf8',env:{PATH:process.env.PATH},timeout:30000});
if(r.status!==0)process.exit(2);let v;try{v=JSON.parse(r.stdout)}catch{process.exit(2)};
console.log(JSON.stringify(v));""".replace('CONFIG', json.dumps(config))
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code, timeout=45))
    need(value.get('status') == 'PASS' and value.get('businessActions') == 0
         and value.get('activeAppleLeaseCount') == 0 and value.get('corruptEncryptedValueCount') == 0,
         'SQLITE_SAFETY_FAILED')
    return value


def preserve_sqlite(d, directory, plan, states, safety_source):
    volume = registration_volume(d, states)
    marker = volume / '.id-release-maintenance.json'
    content = json.dumps({'scope': SCOPE, 'commit': plan['commit'], 'runId': plan['workflowRunId']}, sort_keys=True).encode()
    descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(content)
    try:
        return backup_sqlite_locked(d, directory, plan, states, volume, marker, content, safety_source)
    except BaseException:
        # No migration or switch has started. Remove only this attempt's marker.
        release_owned_marker(marker, digest(content))
        raise


def release_owned_marker(marker, expected):
    need(not marker.is_symlink() and digest(marker.read_bytes()) == expected, 'MAINTENANCE_OWNER_CHANGED')
    marker.unlink()


def backup_sqlite_locked(d, directory, plan, states, volume, marker, content, safety_source):
    before = inspect_sqlite(d, directory)
    backup_dir = BASE / 'backups' / ('registration-closure-' + plan['commit'] + '-' + plan['workflowRunId'])
    need(not backup_dir.exists(), 'SQLITE_BACKUP_ALREADY_ACCEPTED')
    backup_dir.mkdir(mode=0o700)
    path = backup_dir / 'registration.sqlite'
    source = volume / 'database.db'
    need(source.is_file() and not source.is_symlink(), 'SQLITE_DATABASE_UNAVAILABLE')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
        original.execute('PRAGMA query_only=ON')
        with sqlite3.connect(path) as copied:
            original.backup(copied)
            need(copied.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLITE_BACKUP_CORRUPT')
    path.chmod(0o600)
    # A temporary read-only mount checks the encrypted backup with the already-running API's key.
    # No new container or execution service is created for this check: compare all ciphertext rows.
    safety = load(safety_source, 'registration_stdlib_safety')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as copied:
        copied.execute('PRAGMA query_only=ON')
        need(safety.logical_summary(copied)['logicalSha256'] == before['logicalSha256'], 'SQLITE_BACKUP_CHANGED')
    need(inspect_sqlite(d, directory, before['logicalSha256']) == before, 'SQLITE_SOURCE_MOVED')
    values = d.environment_values(directory / '.env.aws.production')
    bucket = values['MYSQL_BACKUP_S3_BUCKET']
    region = values.get('MYSQL_BACKUP_S3_REGION') or 'ap-northeast-1'
    prefix = values.get('MYSQL_BACKUP_S3_PREFIX') or 'mysql/daily'
    need(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket)
         and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', prefix)
         and '..' not in Path(prefix).parts, 'SQLITE_BACKUP_LOCATION_INVALID')
    key = prefix.rstrip('/') + '/registration-closure/' + plan['commit'] + '-' + plan['workflowRunId'] + '/registration.sqlite'
    raw = path.read_bytes()
    d.run('aws', 's3api', 'put-object', '--region', region, '--bucket', bucket, '--key', key,
          '--body', str(path), '--server-side-encryption', 'AES256', '--checksum-algorithm', 'SHA256', timeout=180)
    head = json.loads(d.run('aws', 's3api', 'head-object', '--region', region, '--bucket', bucket,
                            '--key', key, '--checksum-mode', 'ENABLED', timeout=60))
    need(head.get('ContentLength') == len(raw) and head.get('ChecksumSHA256') == base64.b64encode(hashlib.sha256(raw).digest()).decode()
         and head.get('ServerSideEncryption') == 'AES256', 'SQLITE_S3_BACKUP_UNVERIFIED')
    return {'path': str(path), 'sha256': digest(raw), 's3Verified': True, 's3Key': key,
            'logical': before, 'markerPath': str(marker), 'markerSha256': digest(content)}


def finalize_failed_attempt(stage, sqlite):
    # Once SQL may have been accepted, retain the registration fence for a
    # forward repair. Earlier preparation failures have no uncertain writes.
    uncertain = (stage / 'migration-operation.json').exists() or (stage / 'switch-state.json').exists()
    marker = Path(sqlite['markerPath'])
    receipt = {'status': 'FAILED', 'databaseOrSwitchMayHaveStarted': uncertain,
               'markerPath': str(marker), 'markerOwnerSha256': sqlite['markerSha256'],
               'maintenanceHeld': True, 'businessActions': 0}
    if not uncertain:
        release_owned_marker(marker, sqlite['markerSha256'])
        receipt['maintenanceHeld'] = False
    (stage / 'failure-maintenance.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')
    return receipt


def migration_state(d, directory, contract):
    code = """const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
(async()=>{const columns=await p.$queryRawUnsafe("SELECT COLUMN_NAME,IS_NULLABLE,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_chatgpt_accounts' AND COLUMN_NAME IN ('registration_ip_encrypted','registered_at') ORDER BY COLUMN_NAME");
const rows=await p.$queryRawUnsafe('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=?',NAME);
const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
const protectedNames=PROTECTED_NAMES;const protectedRows=await p.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name IN ('+protectedNames.map(()=>'?').join(',')+') ORDER BY migration_name',...protectedNames);
console.log(JSON.stringify({columns,rows:rows.map(r=>({checksum:r.checksum,finished:r.finished_at!==null,rolledBack:r.rolled_back_at!==null})),protectedRows:protectedRows.map(r=>({name:r.migration_name,checksum:r.checksum,finished:r.finished_at!==null,rolledBack:r.rolled_back_at!==null})),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());""".replace('PROTECTED_NAMES', json.dumps(sorted(Path(n).parent.name for n in contract['protectedPublishedRecovery']['migrations']))).replace('NAME', json.dumps(contract['migration']['name']))
    return json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code))


def check_migration(state, contract, applied=False):
    need(state['pending'] == 0, 'MIGRATION_IN_PROGRESS')
    protected = contract.get('protectedPublishedRecovery', {}).get('migrations', {})
    if protected:
        expected = sorted(({'name': Path(name).parent.name, 'checksum': sha, 'finished': True, 'rolledBack': False}
                           for name, sha in protected.items()), key=lambda row: row['name'])
        need(state.get('protectedRows') == expected, 'PUBLISHED_MIGRATION_CHANGED')
    if not applied:
        need(state['columns'] == [] and state['rows'] == [], 'MIGRATION_BASELINE_CHANGED')
    else:
        need(state['columns'] == [{'COLUMN_NAME': 'registered_at', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'datetime'},
                                 {'COLUMN_NAME': 'registration_ip_encrypted', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'text'}]
             and state['rows'] == [{'checksum': contract['migration']['sha256'], 'finished': True, 'rolledBack': False}],
             'MIGRATION_READBACK_CHANGED')


def apply_migration(d, target, contract, stage):
    migration = contract['migration']
    path = target / migration['path']
    need(digest(path.read_bytes()) == migration['sha256'] and not path.is_symlink(), 'MIGRATION_SOURCE_CHANGED')
    path.parent.chmod(0o755)
    billing = load(Path(__file__).with_name('recharge-billing-release.py'), 'registration_migrate_helpers')
    billing.verify_migrate_image(d, target, contract)
    check_migration(migration_state(d, target, contract), contract)
    journal = stage / 'migration-operation.json'
    need(not journal.exists(), 'MIGRATION_ALREADY_ACCEPTED')
    command = ['run', '--rm', '-T', '--no-deps', '--pull', 'never', '--volume',
               str(path.parent) + ':/app/apps/api/prisma-mysql/migrations/' + migration['name'] + ':ro',
               '--entrypoint', 'node', 'migrate', '/app/node_modules/prisma/build/index.js']
    schema = ['--schema', '/app/apps/api/prisma-mysql/schema.prisma']
    journal.write_text(json.dumps({'phase': 'STARTED', 'migration': migration}) + '\n')
    d.compose(target, *command, 'db', 'execute', '--file', '/app/apps/api/prisma-mysql/migrations/' + migration['name'] + '/migration.sql', *schema, timeout=180)
    journal.write_text(json.dumps({'phase': 'SQL_APPLIED', 'migration': migration}) + '\n')
    d.compose(target, *command, 'migrate', 'resolve', '--applied', migration['name'], *schema, timeout=180)
    after = migration_state(d, target, contract)
    check_migration(after, contract, True)
    journal.write_text(json.dumps({'phase': 'VERIFIED', 'migration': migration, 'state': after}) + '\n')
    return {'migration': migration, 'verified': True, 'dataDeletion': False}


def baseline(d, contract, h, expected=None):
    a = extra()
    previous = (BASE / 'current').resolve()
    need(previous == Path(contract['current']) and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need(all(digest((previous / n).read_bytes()) == v for n, v in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    a.verify_modules(d, previous, contract['baselineApiFiles'])
    a.verify_modules(d, previous, contract['apiModules'])
    a.verify_admin(d, states['admin'], contract['baselineAdminFiles'])
    code = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(FILES.map(n=>[n,fs.existsSync('/workspace/engine/'+n)?c.createHash('sha256').update(fs.readFileSync('/workspace/engine/'+n)).digest('hex'):null]))))".replace('FILES', json.dumps(list({**contract['baselineEngineInventory'], **contract['engineFiles']})))
    need(json.loads(d.run('docker', 'exec', states['online-recharge']['containerId'], 'node', '-e', code)) == {**contract['baselineEngineInventory'], **contract['engineFiles']}, 'ENGINE_CONTENT_CHANGED')
    worker_code = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(FILES.map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/apps/api/src/id-business-v2/auto-registration/worker/'+n)).digest('hex')]))))".replace('FILES', json.dumps(list(contract['baselineWorkerFiles'])))
    need(json.loads(d.compose(previous, 'exec', '-T', 'api', 'node', '-e', worker_code)) == contract['baselineWorkerFiles'], 'BASE_WORKER_CHANGED')
    h.guards(d, previous, states, contract)
    inspect_sqlite(d, previous)
    check_migration(migration_state(d, previous, contract), contract)
    if expected is not None:
        a.verify_runtime_receipt(a.runtime_receipt(previous, raw, states), expected)
    return previous, raw, states


def smoke(d, target, proof, states, contract, h, sqlite):
    a = extra()
    a.verify_modules(d, target, {**contract['baselineApiFiles'],
          **{n: value for n, value in proof['apiModules'].items() if n.endswith('.js')}})
    a.verify_modules(d, target, proof['apiModules'])
    a.verify_admin(d, states['admin'], {**contract['baselineAdminFiles'], **proof['adminFiles']})
    need(inspect_sqlite(d, target, sqlite['logical']['logicalSha256']) == sqlite['logical'], 'SQLITE_RUNTIME_CHANGED')
    check_migration(migration_state(d, target, contract), contract, True)
    for relative, expected in proof['workerFiles'].items():
        code = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(PATH)).digest('hex'))".replace('PATH', json.dumps('/app/apps/api/src/id-business-v2/auto-registration/worker/' + relative))
        need(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code) == expected, 'WORKER_CONTENT_CHANGED')
    code = "const{Prisma}=require('@prisma/client');const m=Prisma.dmmf.datamodel.models.find(x=>x.name==='IdBusinessV2ChatgptAccount');console.log(JSON.stringify({fields:m.fields.filter(x=>['registrationIpEncrypted','registeredAt'].includes(x.name)).map(x=>x.name).sort()}))"
    need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code)) == {'fields': ['registeredAt', 'registrationIpEncrypted']}, 'PRISMA_CLIENT_CHANGED')
    schema_code = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/app/apps/api/prisma-mysql/schema.prisma')).digest('hex'))"
    need(d.compose(target, 'exec', '-T', 'api', 'node', '-e', schema_code)
         == contract['changedSources']['apps/api/prisma-mysql/schema.prisma'], 'RUNTIME_SCHEMA_CHANGED')
    h.engine_idle(d, states['online-recharge'], contract, wait_connected=True)
    code = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(FILES.map(n=>[n,fs.existsSync('/workspace/engine/'+n)?c.createHash('sha256').update(fs.readFileSync('/workspace/engine/'+n)).digest('hex'):null]))))".replace('FILES', json.dumps(list({**contract['baselineEngineInventory'], **proof['engineFiles']})))
    need(json.loads(d.run('docker', 'exec', states['online-recharge']['containerId'], 'node', '-e', code)) == {**contract['baselineEngineInventory'], **proof['engineFiles']}, 'ENGINE_CONTENT_CHANGED')
    request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(2 * 1024**2)
    need(digest(raw) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in raw, 'PUBLIC_BUILD_CHANGED')


def release(plan, contract, d, h):
    need(plan['mode'] in ('preflight', 'release', 'readback') and contract['scope'] == SCOPE
         and re.fullmatch('[a-f0-9]{40}', plan['commit']) and re.fullmatch('[a-f0-9]{40}', plan['tree'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    a = extra()
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'registration-closure-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
            raw = (target / 'registration-closure-build-proof.json').read_bytes()
            need(digest(raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            smoke(d, target, json.loads(raw), states, contract, h, receipt['sqlite'])
            marker = Path(receipt['sqlite']['markerPath'])
            release_owned_marker(marker, receipt['sqlite']['markerSha256'])
            return {'status': 'REGISTRATION_CLOSURE_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'images': receipt['images'], 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': True}
        previous, raw_manifest, before = baseline(d, contract, h, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'REGISTRATION_CLOSURE_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                    'runtimeBaseline': a.runtime_receipt(previous, raw_manifest, before), 'businessActions': 0}
        need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        stage = BASE / '.staging' / ('registration-closure-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/registration-closure-' + plan['commit'] + '/registration-closure-artifact.tar.gz'
        need(plan['artifactUrl'] == url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read(64 * 1024**2 + 1)
        need(0 < len(raw) <= 64 * 1024**2 and digest(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = safe_archive(raw, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(digest(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(raw_proof), plan, contract, payload, h)
        models = {role: h.configuration(d, before[role]) for role in ('api', 'admin', 'online-recharge')}
        images = {}
        billing = load(Path(__file__).with_name('recharge-billing-release.py'), 'registration_image_helpers')
        for role in ('api', 'admin', 'online-recharge'):
            context = payload / role
            a.normalize_image_context(context)
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            copies = {'api': 'COPY modules/ /app/apps/api/dist/\nCOPY worker/ /app/apps/api/src/id-business-v2/auto-registration/worker/\nCOPY prisma-client/ /app/node_modules/.prisma/client/\nCOPY schema.prisma /app/apps/api/prisma-mysql/schema.prisma\n',
                      'admin': 'COPY html/ /usr/share/nginx/html/\n',
                      'online-recharge': 'COPY engine/ /workspace/engine/\n'}
            (context / 'Dockerfile').write_text('FROM ' + reference + '\n' + copies[role]
                 + 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            image = 'id-business-v2-registration-closure:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, context, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
            billing.verify_image_configuration(original['Config'], built['Config'])
            images[role] = {'reference': image, 'imageId': built['Id']}
        need(baseline(d, contract, h, plan['runtimeBaseline']) == (previous, raw_manifest, before), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'MYSQL_BACKUP_UNVERIFIED')
        safety_name = 'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py'
        safety_source = payload / 'source' / safety_name
        need(digest(safety_source.read_bytes()) == contract['changedSources'][safety_name], 'SQLITE_HELPER_CHANGED')
        sqlite = preserve_sqlite(d, previous, plan, before, safety_source)
        try:
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-registration-closure')
            need(not target.exists(), 'TARGET_EXISTS')
            shutil.copytree(previous, target, symlinks=True)
            for name in contract['changedSources']:
                path = target / name
                need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_INVALID')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((payload / 'source' / name).read_bytes())
                path.chmod(0o644)
            for name, expected in plan['controlSources'].items():
                raw = Path(__file__).with_name(name).read_bytes()
                need(digest(raw) == expected, 'CONTROL_CHANGED')
                path = target / 'scripts/production-release' / name
                need(not path.is_symlink(), 'CONTROL_PATH_INVALID')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
            override = json.loads((target / 'compose.release.json').read_bytes())
            for role, image in images.items():
                override['services'][role]['image'] = image['reference']
            a.write_release_override(target / 'compose.release.json', override)
            need((BASE / 'current').resolve() == previous and h.snapshot(d, previous) == before
                 and digest((previous / 'release-manifest.json').read_bytes()) == contract['manifestSha256'], 'BASELINE_MOVED')
            need(inspect_sqlite(d, previous, sqlite['logical']['logicalSha256']) == sqlite['logical'], 'SQLITE_SOURCE_MOVED')
            migration = apply_migration(d, target, contract, stage)
            d.assert_no_active_recharge(previous)
            d.assert_no_active_registration(previous)
            h.engine_idle(d, before['online-recharge'], contract)
            (stage / 'switch-state.json').write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            for role in ('api', 'admin'):
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
            need(all(after[n]['image'] == images[n]['imageId'] for n in images), 'RUNTIME_IMAGE_CHANGED')
            for role in images:
                need(h.configuration(d, after[role]) == models[role]
                     and after[role]['environmentSha256'] == before[role]['environmentSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
            online = json.loads(d.run('docker', 'inspect', after['online-recharge']['containerId']))[0]
            need(online['HostConfig']['NetworkMode'] == 'container:' + after['api']['containerId'], 'ONLINE_BINDING_CHANGED')
            smoke(d, target, proof, after, contract, h, sqlite)
            receipt = {'status': 'REGISTRATION_CLOSURE_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                       'before': before, 'after': after, 'images': images, 'backup': backup, 'sqlite': sqlite,
                       'migration': migration, 'workflowRunId': plan['workflowRunId'], 'businessActions': 0}
            (target / 'registration-closure-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'registration-closure-build-proof.json').write_bytes(raw_proof)
            manifest = json.loads(raw_manifest)
            manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                            status='DEPLOYED', previousCommit=contract['expectedCurrent'], previousRelease=str(previous),
                            previousManifestSha256=digest(raw_manifest), servicesUpdated=list(images),
                            newMigrations=[contract['migration']['name']], migrationPerformed=True,
                            paymentActions=0, subscriptionChanged=False, externalNotification=False,
                            validationRun=plan['workflowRunId'], actualDeployment=receipt,
                            deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD',
                            registrationClosure={'sources': projected_source_hashes(contract), 'gitInputs': contract['changedSources'], 'engineSourceProjection': contract.get('engineSourceProjection', {}), 'apiModules': proof['apiModules'],
                              'engineFiles': proof['engineFiles'], 'workerFiles': proof['workerFiles'],
                              'buildProofSha256': plan['buildProofSha256']},
                            compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
            projections = {}
            for role in images:
                files = (proof['apiModules'] if role == 'api' else
                         proof['adminFiles'] if role == 'admin' else proof['engineFiles'])
                projections[role] = {'kind': 'PUBLISHED_PREDECESSOR_WITH_REGISTRATION_CLOSURE_OVERLAY',
                    'role': role, 'commit': plan['commit'], 'sourceTree': plan['tree'],
                    'sourceBaseline': contract['sourceBaseline'], 'publishedBaseImageId': before[role]['image'],
                    'runtimeImageId': images[role]['imageId'], 'runtimeFiles': files,
                    'buildProofSha256': plan['buildProofSha256'], 'scope': SCOPE,
                    'sourceDelta': (contract.get('engineSourceProjection', {}) if role == 'online-recharge' else
                         {n: value for n, value in projected_source_hashes(contract).items()
                          if n.startswith('apps/admin/' if role == 'admin' else 'apps/api/')})}
                if role == 'api':
                    projections[role]['workerFiles'] = proof['workerFiles']
                    projections[role]['prismaClientFiles'] = proof['prismaClientFiles']
            manifest['previousRoleSourceProjections'] = manifest.get('roleSourceProjections')
            manifest['previousAdminSourceProjection'] = manifest.get('adminSourceProjection')
            manifest['previousSourceProjection'] = manifest.get('sourceProjection')
            manifest['roleSourceProjections'] = {**manifest.get('roleSourceProjections', {}), **projections}
            manifest['adminSourceProjection'] = projections['admin']
            manifest['sourceProjection'] = {'sourceBaseline': contract['sourceBaseline'],
                'gitInputs': contract['changedSources'], 'runtimeSources': projected_source_hashes(contract),
                'apiModules': proof['apiModules'], 'engineFiles': proof['engineFiles'],
                'engineSourceProjection': contract.get('engineSourceProjection', {}),
                'buildProofSha256': plan['buildProofSha256']}
            for field in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun'):
                manifest.pop(field, None)
            for role in images:
                manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            d.point_current(target, stamp + '-registration-closure')
            (stage / 'switch-state.json').write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
            return {k: receipt[k] for k in ('status', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions')}
        except BaseException:
            finalize_failed_attempt(stage, sqlite)
            raise
