"""Finite engine fix and one API static asset; no migration or business action."""
import copy
import ast
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import tarfile
import time
import urllib.request

BASE = Path('/opt/id-business-v2')
SCOPE = 'PROXY_RESULT_IDENTITY_AND_REGISTRATION_DRAFT'
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('PROXY_RESULT_IDENTITY_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def helper(name):
    return load(Path(__file__).with_name(name), 'engine_identity_' + name.replace('-', '_'))


def sql_fence_class(contract):
    path = Path(__file__).with_name('api-admin-scope.py')
    raw = path.read_bytes()
    need(digest(raw) == contract['sqlFenceHelperSha256'], 'SQL_FENCE_SOURCE_CHANGED')
    node = next(n for n in ast.parse(raw).body if isinstance(n, ast.ClassDef) and n.name == 'OnlineSqlFence')
    old_lock = ('SET SESSION lock_wait_timeout=5; SET SESSION innodb_lock_wait_timeout=5; '
                'LOCK TABLES online_recharge_tasks WRITE, online_recharge_cards WRITE;\n')
    old_query = ("SELECT JSON_OBJECT('version',1,'connectionId',CONNECTION_ID(),'busy',"
        "(SELECT COUNT(*) FROM online_recharge_tasks WHERE status IN ('queued','running') "
        "OR lease_expires_at>UTC_TIMESTAMP(6))+(SELECT COUNT(*) FROM online_recharge_cards "
        "WHERE lease_expires_at>UTC_TIMESTAMP(6)));\n")
    replacements = {old_lock: old_lock.replace('online_recharge_cards WRITE;',
        'online_recharge_cards WRITE, id_business_v2_recharge_jobs WRITE;'),
        old_query: old_query.removesuffix(');\n') + '+(SELECT COUNT(*) FROM id_business_v2_recharge_jobs '
        'WHERE state <> 0x66696e6973686564 AND lease_until > UTC_TIMESTAMP(6)));\n'}
    counts = {key: 0 for key in replacements}

    class ReviewedSqlOnly(ast.NodeTransformer):
        def visit_Constant(self, value):
            if isinstance(value.value, str) and value.value in replacements:
                counts[value.value] += 1
                value.value = replacements[value.value]
            return value

    tree = ast.fix_missing_locations(ast.Module(body=[ReviewedSqlOnly().visit(node)], type_ignores=[]))
    need(all(count == 1 for count in counts.values()), 'SQL_FENCE_CONTEXT_CHANGED')
    namespace = {'time': time, 're': re, 'subprocess': subprocess, 'select': select, 'os': os,
                 'json': json, 'hashlib': hashlib, 'CONFIG_FILES': ('docker-compose.aws-mysql.yml',)}
    exec(compile(tree, str(path), 'exec'), namespace)
    return namespace['OnlineSqlFence']


def registration_marker(d, states):
    row = json.loads(d.run('docker', 'inspect', states['api']['containerId']))[0]
    mounts = [value for value in row['Mounts'] if value['Destination'] == '/app/.runtime/auto-registration']
    need(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0]['RW'] is True, 'SQLITE_VOLUME_CHANGED')
    source = Path(mounts[0]['Source'])
    need(source.is_absolute() and source.parent.parent == Path('/var/lib/docker/volumes')
         and source.name == '_data' and not source.is_symlink(), 'SQLITE_VOLUME_INVALID')
    return source / '.id-release-maintenance.json'


def verify_markers(receipt):
    for name in receipt['paths']:
        path = Path(name)
        need(not path.is_symlink() and path.is_file() and digest(path.read_bytes()) == receipt['ownerSha256'], 'MAINTENANCE_OWNER_CHANGED')


def claim_markers(d, states, plan):
    paths = [BASE / 'maintenance.json', registration_marker(d, states)]
    raw = json.dumps({'scope': SCOPE, 'commit': plan['commit'], 'workflowRunId': plan['workflowRunId']}, sort_keys=True).encode()
    claimed = []
    try:
        for path in paths:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as output:
                output.write(raw)
            claimed.append(path)
    except BaseException:
        for path in claimed:
            need(not path.is_symlink() and digest(path.read_bytes()) == digest(raw), 'MAINTENANCE_OWNER_CHANGED')
            path.unlink()
        raise
    return {'paths': [str(path) for path in paths], 'ownerSha256': digest(raw),
            'globalFileRole': 'PUBLICATION_OWNERSHIP_ONLY', 'registrationFileRole': 'WORKSPACE_WRITE_FENCE'}


def release_markers(receipt):
    verify_markers(receipt)
    for name in receipt['paths']:
        Path(name).unlink()


def database_receipt(d, directory, contract):
    # Only fixed SELECTs execute. Business rows stay inside the child; only their hash leaves it.
    config = {'names': sorted(contract['protectedMigrations']), 'columns': ['registered_at', 'registration_ip_encrypted']}
    source = "const input=" + json.dumps(config) + ";" + """const{PrismaClient}=require('@prisma/client'),c=require('node:crypto');const p=new PrismaClient({log:[]});
(async()=>{const columns=await p.$queryRawUnsafe("SELECT COLUMN_NAME,IS_NULLABLE,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_chatgpt_accounts' AND COLUMN_NAME IN ('registration_ip_encrypted','registered_at') ORDER BY COLUMN_NAME");
const migrations=await p.$queryRawUnsafe('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name IN ('+input.names.map(()=>'?').join(',')+') ORDER BY migration_name',...input.names);
const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
const accounts=await p.idBusinessV2ChatgptAccount.findMany({orderBy:{id:'asc'}});
console.log(JSON.stringify({columns,migrations:migrations.map(r=>({name:r.migration_name,checksum:r.checksum,finished:r.finished_at!==null,rolledBack:r.rolled_back_at!==null})),pending:Number(pending[0].n),accountCount:accounts.length,accountsSha256:c.createHash('sha256').update(JSON.stringify(accounts)).digest('hex')}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());"""
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source))
    need(value['columns'] == [{'COLUMN_NAME': 'registered_at', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'datetime'},
                             {'COLUMN_NAME': 'registration_ip_encrypted', 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'text'}]
         and value['pending'] == 0 and value['accountCount'] == contract['accountCount']
         and re.fullmatch('[a-f0-9]{64}', value['accountsSha256'])
         and value['migrations'] == [{'name': name, 'checksum': checksum, 'finished': True, 'rolledBack': False}
             for name, checksum in sorted(contract['protectedMigrations'].items())], 'DATABASE_PRESERVATION_FAILED')
    return value


def engine_content(d, state, expected):
    source = """const fs=require('fs'),c=require('crypto'),files={};function walk(relative=''){for(const entry of fs.readdirSync('/workspace/engine/'+relative,{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(name==='upstream/node_modules'||name==='runtime')continue;if(entry.isSymbolicLink())throw Error('SOURCE_LINK');if(entry.isDirectory())walk(name);else if(entry.isFile())files[name]=c.createHash('sha256').update(fs.readFileSync('/workspace/engine/'+name)).digest('hex');else throw Error('SOURCE_KIND')}}walk();console.log(JSON.stringify(files));"""
    need(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', source)) == expected,
         'ENGINE_CONTENT_CHANGED')


def verify_overlay_image(original, built, plan, copies, billing):
    layers = original['RootFS']['Layers']
    need(built['RootFS']['Layers'][:len(layers)] == layers
         and len(built['RootFS']['Layers']) == len(layers) + copies, 'BASE_LAYERS_CHANGED')
    billing.verify_image_configuration(original['Config'], built['Config'])
    labels = {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'],
              'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}
    need(built['Config'].get('Labels') == labels, 'IMAGE_LABELS_CHANGED')


def api_static_hash(d, directory, contract):
    source = "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(" + json.dumps('/app/' + contract['apiStaticPath']) + ")).digest('hex'))"
    return d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source)


def sqlite_receipt(d, directory):
    # Existing stdlib inspector opens the existing mounted SQLite read-only.
    # The key stays inside the API environment and the child's private stdin pipe.
    source = """const{spawnSync}=require('child_process');const config={mode:'inspect',databasePath:'/app/.runtime/auto-registration/database.db',encryptionKey:process.env.FIELD_ENCRYPTION_KEY};
const result=spawnSync('/opt/id-registration/venv/bin/python',['-B','/app/apps/api/src/id-business-v2/auto-registration/worker/release_safety.py'],{input:JSON.stringify(config)+'\\n',encoding:'utf8',env:{PATH:process.env.PATH},timeout:30000});
if(result.status!==0)process.exit(2);console.log(JSON.stringify(JSON.parse(result.stdout)));"""
    value = json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', source, timeout=45))
    need(value.get('status') == 'PASS' and value.get('businessActions') == 0 and value.get('activeAppleLeaseCount') == 0
         and value.get('corruptEncryptedValueCount') == 0, 'SQLITE_PRESERVATION_FAILED')
    return value


def baseline(d, contract, h, a, expected=None):
    current = (BASE / 'current').resolve()
    need(str(current) == contract['current'] and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, current)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need(all(digest((current / name).read_bytes()) == value for name, value in contract['configurationSha256'].items()),
         'CONFIGURATION_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'],
         'RUNTIME_CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    need(not registration_marker(d, states).exists(), 'REGISTRATION_MAINTENANCE_PRESENT')
    h.guards(d, current, states, contract)
    engine_content(d, states['online-recharge'], contract['beforeEngineFiles'])
    need(api_static_hash(d, current, contract) == contract['beforeApiStaticSha256'], 'API_STATIC_BASELINE_CHANGED')
    database = database_receipt(d, current, contract)
    receipt = {**a.runtime_receipt(current, raw, states), 'database': database, 'sqlite': sqlite_receipt(d, current)}
    if expected is not None:
        need(receipt == expected, 'PREFLIGHT_MOVED')
    return current, raw, states, receipt


def extract_payload(raw, directory):
    need(not directory.exists(), 'ARTIFACT_OUTPUT_EXISTS')
    directory.mkdir(mode=0o700)
    names, total = set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        for item in archive.getmembers():
            parts = Path(item.name).parts
            total += item.size
            need(parts and parts[0] == 'payload' and not item.name.startswith('/') and '..' not in parts
                 and item.name not in names and (item.isfile() or item.isdir())
                 and item.size <= 4 * 1024**2 and total <= 16 * 1024**2, 'ARTIFACT_PATH_INVALID')
            names.add(item.name)
            path = directory / item.name
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(item).read())
    return directory / 'payload'


def verify_identity(proof, plan, contract):
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(name) == plan[name] for name in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == contract['sources'] and proof.get('beforeEngineFiles') == contract['beforeEngineFiles']
         and proof.get('validationSources') == contract['validationSources']
         and proof.get('afterEngineFiles') == {**contract['beforeEngineFiles'], **contract['engineFiles']}
         and proof.get('fixtureFiles') == contract['fixtureFiles'] and proof.get('migrationPerformed') is False
         and proof.get('updatedServices') == ['api', 'online-recharge'] and proof.get('businessActions') == 0
         and proof.get('baselineNative') == contract['baselineNative'], 'PROOF_INVALID')


def verify_proof(proof, plan, contract, payload, h):
    verify_identity(proof, plan, contract)
    files = h.file_inventory(payload)
    files.pop('build-proof.json', None)
    expected = {**{'engine/' + n: value for n, value in contract['engineFiles'].items()},
                **{'fixtures/api/' + n: value for n, value in contract['fixtureFiles'].items()},
                'api-static/id-workspace.js': contract['sources'][contract['apiStaticPath']]}
    need(files == expected, 'PAYLOAD_SCOPE_CHANGED')
    manifest = json.loads((payload / 'engine/SOURCE_MANIFEST.json').read_bytes())
    rows = manifest['files']
    entries = {row['path']: row['adaptedSha256'] for row in rows}
    need(len(entries) == len(rows) and entries == {n: value for n, value in proof['afterEngineFiles'].items()
                                                  if n != 'SOURCE_MANIFEST.json'}, 'ENGINE_MANIFEST_CHANGED')
    return proof


def smoke(d, target, states, contract, expected_engine, database, sqlite, h):
    h.engine_idle(d, states['online-recharge'], contract, wait_connected=True)
    row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'API_BINDING_CHANGED')
    engine_content(d, states['online-recharge'], expected_engine)
    need(api_static_hash(d, target, contract) == contract['sources'][contract['apiStaticPath']], 'API_STATIC_CHANGED')
    need(database_receipt(d, target, contract) == database, 'ACCOUNT_OR_SCHEMA_CHANGED')
    need(sqlite_receipt(d, target) == sqlite, 'SQLITE_RECORDS_CHANGED')
    request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=25) as response:
        need(digest(response.read(2 * 1024**2)) == contract['publicIndexSha256'], 'ADMIN_CHANGED')


def release(plan, contract, d, h):
    need(plan['mode'] in ('preflight', 'release', 'readback') and contract['scope'] == SCOPE
         and re.fullmatch('[a-f0-9]{40}', plan['commit']) and re.fullmatch('[a-f0-9]{40}', plan['tree'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']),
         'IDENTITY_INVALID')
    a = helper('recharge-availability-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('sourceTree') == plan['tree']
                 and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'proxy-result-identity-preservation.json').read_bytes())
            proof_raw = (target / 'proxy-result-identity-build-proof.json').read_bytes()
            need(digest(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            verify_identity(json.loads(proof_raw), plan, contract)
            need(all(digest((target / name).read_bytes()) == value for name, value in contract['sources'].items()),
                 'READBACK_SOURCE_CHANGED')
            need(all(digest((target / 'scripts/production-release' / name).read_bytes()) == value
                     for name, value in plan['controlSources'].items()), 'READBACK_CONTROL_CHANGED')
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[role] == receipt['before'][role] for role in PRESERVED),
                 'READBACK_SERVICES_CHANGED')
            need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'],
                 'READBACK_CONFIGURATION_CHANGED')
            smoke(d, target, states, contract, {**contract['beforeEngineFiles'], **contract['engineFiles']},
                  receipt['database'], receipt['sqlite'], h)
            need(manifest['roleSourceProjections']['admin'] == receipt['preservedRoleProjections']['admin']
                 and manifest['roleSourceProjections']['api']['parentProjection'] == receipt['previousApiProjection']
                 and manifest['roleSourceProjections']['api']['assetSource'] == {contract['apiStaticPath']: contract['sources'][contract['apiStaticPath']]}
                 and manifest['roleSourceProjections']['online-recharge']['runtimeFiles'] == {**contract['beforeEngineFiles'], **contract['engineFiles']}
                 and manifest['roleSourceProjections']['online-recharge']['sourceDelta'] == {name: value for name, value in contract['sources'].items() if name.startswith('apps/api/src/id-business-v2/online-recharge/engine/')},
                 'PRESERVED_SOURCE_PROJECTION_CHANGED')
            release_markers(receipt['maintenance'])
            (target / 'proxy-result-identity-readback.json').write_text(json.dumps({'status': 'VERIFIED',
                'commit': plan['commit'], 'maintenanceReleased': True, 'businessRowsWritten': 0}) + '\n')
            return {'status': 'PROXY_RESULT_IDENTITY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'],
                    'images': receipt['images'], 'preservedServices': list(PRESERVED), 'accountCount': contract['accountCount'],
                    'migrationPerformed': False, 'businessActions': 0, 'maintenanceReleased': True,
                    'maintenanceControl': {'ownerFileClaims': 2, 'ownerFileReleases': 2, 'temporarySqlTableLocks': 3,
                                           'businessRowsWritten': 0}}
        previous, raw_manifest, before, observed = baseline(d, contract, h, a, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'PROXY_RESULT_IDENTITY_PREFLIGHT_VERIFIED', 'commit': plan['commit'],
                    'runtimeBaseline': observed, 'businessActions': 0}
        need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_REQUIRED')
        stage = BASE / '.staging' / ('proxy-result-identity-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        need(plan['artifactUrl'] == 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/proxy-result-identity-' + plan['commit'] + '/proxy-result-identity-artifact.tar.gz', 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
            raw = response.read(16 * 1024**2 + 1)
        need(0 < len(raw) <= 16 * 1024**2 and digest(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = extract_payload(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(digest(proof_raw) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = verify_proof(json.loads(proof_raw), plan, contract, payload, h)
        context = payload / 'engine'
        a.normalize_image_context(context)
        original = json.loads(d.run('docker', 'image', 'inspect', before['online-recharge']['image']))[0]
        reference = h.base_image_reference(d, before['online-recharge'])
        copies = ''.join('COPY ' + name + ' /workspace/engine/' + name + '\n' for name in contract['engineFiles'])
        (context / 'Dockerfile').write_text('FROM ' + reference + '\n' + copies + 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        image = 'id-business-v2-proxy-result-identity:' + plan['commit'] + '-' + plan['workflowRunId']
        h.build_image(d, context, image, 'online-recharge', before['online-recharge'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
        billing = helper('recharge-billing-release.py')
        verify_overlay_image(original, built, plan, 3, billing)
        images = {'online-recharge': {'reference': image, 'imageId': built['Id']}}
        api_context = payload / 'api-static'
        a.normalize_image_context(api_context)
        original_api = json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0]
        api_reference = h.base_image_reference(d, before['api'])
        (api_context / 'Dockerfile').write_text('FROM ' + api_reference + '\nCOPY id-workspace.js /app/' + contract['apiStaticPath']
            + '\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        api_image = image + '-api-static'
        h.build_image(d, api_context, api_image, 'api', before['api'], stage)
        built_api = json.loads(d.run('docker', 'image', 'inspect', api_image))[0]
        verify_overlay_image(original_api, built_api, plan, 1, billing)
        images['api'] = {'reference': api_image, 'imageId': built_api['Id']}
        # Run the actual new regression with only two immutable API JS fixtures mounted read-only.
        a.normalize_image_context(payload / 'fixtures')
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
              '--volume', str(payload / 'fixtures/api') + ':/fixture-api:ro', '--env', 'PROXY_RESULT_API_MODULE_ROOT=/fixture-api',
              image, '--test', contract['testFile'], timeout=90)
        need(baseline(d, contract, h, a, plan['runtimeBaseline']) == (previous, raw_manifest, before, observed), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-proxy-result-identity')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name, expected in contract['engineFiles'].items():
            path = target / 'apps/api/src/id-business-v2/online-recharge/engine' / name
            need(not path.is_symlink(), 'SOURCE_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'engine' / name).read_bytes())
            path.chmod(0o644)
        api_path = target / contract['apiStaticPath']
        need(not api_path.is_symlink(), 'API_STATIC_PATH_INVALID')
        api_path.write_bytes((payload / 'api-static/id-workspace.js').read_bytes())
        api_path.chmod(0o644)
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['online-recharge']['image'] = image
        override['services']['api']['image'] = api_image
        a.write_release_override(target / 'compose.release.json', override)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'CONTROL_CHANGED')
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink(), 'CONTROL_PATH_INVALID')
            path.write_bytes(raw)
        baseline(d, contract, h, a, plan['runtimeBaseline'])
        journal = stage / 'switch-state.json'
        maintenance = claim_markers(d, before, plan)
        journal.write_text(json.dumps({'status': 'MAINTENANCE_CLAIMED', 'target': str(target), 'commit': plan['commit'],
                                       'maintenance': maintenance}) + '\n')
        fence = None
        try:
            verify_markers(maintenance)
            d.assert_no_active_recharge(previous)
            d.assert_no_active_registration(previous)
            h.engine_idle(d, before['online-recharge'], contract)
            need(database_receipt(d, previous, contract) == observed['database'] and sqlite_receipt(d, previous) == observed['sqlite'],
                 'DATA_CHANGED_AFTER_FENCE')
            fence = sql_fence_class(contract)(d, previous)
            fence.acquire()
            fence.check_idle()
            verify_markers(maintenance)
            need(sqlite_receipt(d, previous) == observed['sqlite'], 'SQLITE_CHANGED_AFTER_SQL_FENCE')
            journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'commit': plan['commit'],
                                           'maintenance': maintenance}) + '\n')
            fence.stop(before['api'], grace=30)
            fence.stop(before['online-recharge'], grace=45)
            fence.close()
            fence = None
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', timeout=180)
            d.wait_healthy(target, 'api')
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[role] == before[role] for role in PRESERVED)
                 and all(after[role]['image'] == images[role]['imageId'] for role in images), 'PRESERVED_SERVICE_CHANGED')
            need({role: h.configuration(d, state) for role, state in after.items()} == contract['runtimeConfigurationSha256']
                 and after['online-recharge']['environmentSha256'] == before['online-recharge']['environmentSha256'],
                 'RUNTIME_CONFIGURATION_CHANGED')
            smoke(d, target, after, contract, proof['afterEngineFiles'], observed['database'], observed['sqlite'], h)
            manifest = json.loads(raw_manifest)
            projections = copy.deepcopy(manifest['roleSourceProjections'])
            receipt = {'status': 'PROXY_RESULT_IDENTITY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                       'before': before, 'after': after, 'database': observed['database'], 'sqlite': observed['sqlite'], 'backup': backup,
                       'maintenance': maintenance, 'maintenanceControl': {'ownerFileClaims': 2, 'temporarySqlTableLocks': 3,
                                                                        'businessRowsWritten': 0},
                       'images': images, 'previousApiProjection': projections['api'],
                       'preservedRoleProjections': {'admin': projections['admin']},
                       'businessActions': 0, 'migrationPerformed': False, 'workflowRunId': plan['workflowRunId']}
            manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, status='DEPLOYED',
                            previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest),
                            servicesUpdated=['api', 'online-recharge'], newMigrations=[], migrationPerformed=False, paymentActions=0,
                            subscriptionChanged=False, externalNotification=False, validationRun=plan['workflowRunId'], actualDeployment=receipt,
                            compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
            manifest['previousRoleSourceProjections'] = projections
            manifest['roleSourceProjections'] = {**projections, 'online-recharge': {'kind': SCOPE, 'commit': plan['commit'],
                'sourceTree': plan['tree'], 'publishedBaseImageId': before['online-recharge']['image'], 'runtimeImageId': built['Id'],
                'sourceDelta': {name: value for name, value in contract['sources'].items() if name.startswith('apps/api/src/id-business-v2/online-recharge/engine/')},
                'runtimeFiles': proof['afterEngineFiles'], 'buildProofSha256': plan['buildProofSha256']}}
            manifest['roleSourceProjections']['api'] = {'kind': 'PUBLISHED_7C_API_WITH_REGISTRATION_DRAFT_ASSET',
                'commit': plan['commit'], 'sourceTree': plan['tree'], 'parentProjection': projections['api'],
                'publishedBaseImageId': before['api']['image'], 'runtimeImageId': built_api['Id'],
                'assetSource': {contract['apiStaticPath']: contract['sources'][contract['apiStaticPath']]},
                'buildProofSha256': plan['buildProofSha256']}
            manifest['previousSourceProjection'] = manifest.get('sourceProjection')
            manifest['sourceProjection'] = {'kind': SCOPE, 'baselineCommit': contract['expectedCurrent'],
                                           'sources': contract['sources'], 'compiledApiAndAdminCommit': contract['expectedCurrent'],
                                           'buildProofSha256': plan['buildProofSha256']}
            manifest['images']['online-recharge'] = {'reference': image, 'digest': built['Id'], 'sourceCommit': plan['commit']}
            manifest['images']['api'] = {'reference': api_image, 'digest': built_api['Id'], 'sourceCommit': plan['commit']}
            (target / 'proxy-result-identity-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'proxy-result-identity-build-proof.json').write_bytes(proof_raw)
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            d.point_current(target, stamp + '-proxy-result-identity')
            journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
            return {name: receipt[name] for name in ('status', 'commit', 'tree', 'images', 'businessActions', 'migrationPerformed')}
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target), 'commit': plan['commit'],
                                           'maintenance': maintenance, 'maintenanceHeld': True,
                                           'rollbackPerformed': False, 'switchMayHaveStarted': True}) + '\n')
            raise
        finally:
            if fence is not None:
                fence.close()
