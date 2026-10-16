"""Finite native checkout publication; preserve the current API/Admin images and all other roles."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('CHATGPT_SALES_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def verify_image_configuration(original, built):
    # Docker clears the deprecated parent-image build marker when inheriting an
    # image. It is not the selected image ID or a container runtime setting.
    for config in (original, built):
        marker = config.get('Image')
        need(marker in (None, '') or (isinstance(marker, str) and re.fullmatch('sha256:[a-f0-9]{64}', marker)), 'IMAGE_PARENT_MARKER_INVALID')
    need({k: v for k, v in built.items() if k not in ('Labels', 'Image')} ==
         {k: v for k, v in original.items() if k not in ('Labels', 'Image')}, 'IMAGE_CONFIGURATION_CHANGED')


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def utilities():
    return load(Path(__file__).with_name('recharge-availability-release.py'), 'billing_generic_helpers')










def validate_proof(proof, plan, contract, payload, h):
    need(proof.get('version') == 1 and proof.get('scope') == contract['scope']
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256'))
         and proof.get('baselineSources') == {'api': contract['apiSourceBaseline'], 'admin': contract['adminSourceBaseline']}
         and proof.get('adminPublishedSources') == contract['adminPublishedSources']
         and proof.get('hostSources') == contract['hostSources']
         and proof.get('databaseVerification') == {'isolated': True, 'migration': contract['migration']['name'], 'legacyDefaultsVerified': True, 'testsPassed': 5, 'testsSkipped': 0, 'businessActions': 0}
         and proof.get('qualityVerification') == plan['qualityVerification']
         and proof.get('browserVerification') == {'status': 'PASS', 'realWrites': 0}
         and proof.get('updatedServices') == ['api', 'admin'] and proof.get('migration') == contract['migration']
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0, 'PROOF_INVALID')
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    allowed = {n.removesuffix('.js') + ext for n in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    need(actual == proof.get('files') and set(proof['apiModules']) == set(proof['baselineApiFiles']) == allowed
         and len(proof['adminFiles']) >= 250 and len(proof['baselineAdminFiles']) >= 250
         and {n.removeprefix('source/'): v for n, v in actual.items() if n.startswith('source/')} == contract['sources']
         and {n.removeprefix('api/modules/'): v for n, v in actual.items() if n.startswith('api/modules/')} == proof['apiModules']
         and {n.removeprefix('admin/html/'): v for n, v in actual.items() if n.startswith('admin/html/')} == proof['adminFiles']
         and {n.removeprefix('host/'): v for n, v in actual.items() if n.startswith('host/')} == contract['hostSources']
         and all(n.startswith(('source/', 'host/', 'api/modules/', 'admin/html/')) for n in actual), 'PAYLOAD_SCOPE_CHANGED')
    return proof


def baseline(d, contract, h, proof, expected=None):
    a = utilities()
    previous = (BASE / 'current').resolve()
    need(previous == Path(contract['current']) and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and digest(normalizer.read_bytes()) == contract['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    a.verify_modules(d, previous, proof['baselineApiFiles'])
    a.verify_admin(d, states['admin'], proof['baselineAdminFiles'])
    h.guards(d, previous, states, contract)
    receipt = a.runtime_receipt(previous, raw, states)
    receipt['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
    if expected is not None:
        need(receipt == expected, 'RUNTIME_BASELINE_MOVED')
    return previous, raw, states, receipt


def smoke(d, target, proof, states, contract, h, nginx):
    a = utilities()
    a.verify_modules(d, target, proof['apiModules'])
    a.verify_admin(d, states['admin'], {**proof['baselineAdminFiles'], **proof['adminFiles']})
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0] == nginx, 'NGINX_CHANGED')
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        html = response.read(2 * 1024**2)
    need(digest(html) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in html, 'PUBLIC_BUILD_CHANGED')
    for name, expected in {**contract['sources'], **contract['hostSources']}.items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target) and digest(path.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')
    h.guards(d, target, states, contract)
    code = """const{PrismaClient,Prisma}=require('@prisma/client');const p=new PrismaClient({log:[]});
(async()=>{const m=Prisma.dmmf.datamodel.models.find(m=>m.name==='IdBusinessV2ChatgptAccount');
const fields=m.fields.filter(f=>['saleStatus','soldAt'].includes(f.name)).map(f=>f.name).sort();
const row=await p.idBusinessV2ChatgptAccount.findFirst({select:{registered:true,saleStatus:true,soldAt:true}});
const s=require('/app/apps/api/dist/id-business-v2/auto-recharge/bank-recharge-account-sales.js');
console.log(JSON.stringify({fields,queryOk:true,helperLoaded:Object.keys(s).length>0}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());"""
    need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code)) == {'fields': ['saleStatus', 'soldAt'], 'queryOk': True, 'helperLoaded': True}, 'SALE_MODULE_SMOKE_FAILED')
    check_migration(migration_state(d, target, contract), contract, True)


def migration_state(d, directory, contract):
    code = """const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
(async()=>{const columns=await p.$queryRawUnsafe("SELECT COLUMN_NAME,IS_NULLABLE,COLUMN_TYPE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_chatgpt_accounts' AND COLUMN_NAME IN ('sale_status','sold_at') ORDER BY COLUMN_NAME");
const rows=await p.$queryRawUnsafe('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=?',__SALE_MIGRATION_JSON__);
const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
const indexes=await p.$queryRawUnsafe("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_chatgpt_accounts' AND INDEX_NAME='chatgpt_accounts_sale_list_idx' ORDER BY SEQ_IN_INDEX");
console.log(JSON.stringify({columns,rows:rows.map(r=>({checksum:r.checksum,finished:r.finished_at!==null,rolledBack:r.rolled_back_at!==null})),indexes:indexes.map(r=>r.COLUMN_NAME),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());""".replace('__SALE_MIGRATION_JSON__', json.dumps(contract['migration']['name']))
    return json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code))


def check_migration(state, contract, applied=False):
    need(state['pending'] == 0, 'MIGRATION_IN_PROGRESS')
    if not applied:
        need(state['columns'] == [] and state['rows'] == [] and state['indexes'] == [], 'MIGRATION_BASELINE_CHANGED')
    else:
        need(state['columns'] == [
            {'COLUMN_NAME': 'sale_status', 'IS_NULLABLE': 'NO', 'COLUMN_TYPE': "enum('unsold','sold')", 'COLUMN_DEFAULT': 'unsold'},
            {'COLUMN_NAME': 'sold_at', 'IS_NULLABLE': 'YES', 'COLUMN_TYPE': 'datetime(6)', 'COLUMN_DEFAULT': None}]
            and state['indexes'] == ['deleted_at', 'sale_status', 'sold_at', 'id']
            and state['rows'] == [{'checksum': contract['migration']['sha256'], 'finished': True, 'rolledBack': False}], 'MIGRATION_READBACK_CHANGED')


def migrate_image(d, directory):
    model = json.loads(d.compose(directory, 'config', '--format', 'json'))
    reference = model['services']['migrate']['image']
    need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./:_@-]+', reference) is not None, 'MIGRATE_REFERENCE_INVALID')
    row = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
    return {'reference': reference, 'imageId': row['Id']}


def generate_client(d, previous, payload, stage, contract, before):
    image = migrate_image(d, previous)
    (stage / 'migrate-image.json').write_text(json.dumps(image, sort_keys=True) + '\n')
    schema = payload / 'source/apps/api/prisma-mysql/schema.prisma'
    need(digest(schema.read_bytes()) == contract['sources']['apps/api/prisma-mysql/schema.prisma'], 'CLIENT_SCHEMA_CHANGED')
    # Native generation inside the exact migrate runtime, without production env,
    # credentials, network or database. Do not commit container environment to an image.
    name = 'idv2-sales-prisma-' + stage.name[-24:]
    container = d.run('docker', 'create', '--name', name, '--network', 'none', '--user', '0',
        '--env', 'DATABASE_URL=mysql://placeholder:placeholder@127.0.0.1:3306/placeholder',
        '--mount', 'type=bind,source=' + str(schema) + ',target=/app/apps/api/prisma-mysql/schema.prisma,readonly',
        '--entrypoint', 'node', image['imageId'], '/app/node_modules/prisma/build/index.js', 'generate',
        '--schema', '/app/apps/api/prisma-mysql/schema.prisma').strip()
    need(re.fullmatch('[a-f0-9]{64}', container) is not None, 'CLIENT_CONTAINER_INVALID')
    try:
        d.run('docker', 'start', '--attach', container, timeout=180)
        state = json.loads(d.run('docker', 'inspect', container))[0]
        need(state['Id'] == container and state['Image'] == image['imageId'] and state['State']['Status'] == 'exited'
             and state['State']['ExitCode'] == 0 and state['HostConfig']['NetworkMode'] == 'none', 'CLIENT_GENERATION_FAILED')
        destination = payload / 'api/prisma-client'
        destination.mkdir()
        d.run('docker', 'cp', container + ':/app/node_modules/.prisma/client/.', str(destination))
        need((destination / 'schema.prisma').read_bytes() == schema.read_bytes(), 'CLIENT_SCHEMA_CHANGED')
        expected = d.run('docker', 'exec', before['api']['containerId'], 'node', '-e',
            "console.log(JSON.stringify({v:require('@prisma/client/package.json').version,engines:require('fs').readdirSync('/app/node_modules/.prisma/client').filter(n=>n.startsWith('libquery_engine-')).sort()}))")
        actual = {'v': json.loads((destination / 'package.json').read_bytes())['version'],
                  'engines': sorted(p.name for p in destination.glob('libquery_engine-*'))}
        # Generated client package version is Prisma's generated package version,
        # so compare its Prisma clientVersion instead of its package placeholder.
        version = re.search(r'"clientVersion":\s*"([0-9.]+)"', (destination / 'index.js').read_text())
        need(version is not None and version.group(1) == json.loads(expected)['v']
             and actual['engines'] == json.loads(expected)['engines'], 'CLIENT_RUNTIME_CHANGED')
        (stage / 'generated-client-files.json').write_text(json.dumps(load(Path(__file__).with_name('recharge-record-release.py'), 'sales_client_inventory').file_inventory(destination), sort_keys=True) + '\n')
        shutil.copyfile(schema, payload / 'api/schema.prisma')
    finally:
        state = json.loads(d.run('docker', 'inspect', container))[0]
        need(state['Id'] == container and not state['State']['Running'], 'CLIENT_CONTAINER_STILL_RUNNING')
        d.run('docker', 'rm', '--volumes', container)


def apply_migration(d, target, contract, stage):
    migration = contract['migration']
    path = target / migration['path']
    need(not path.is_symlink() and digest(path.read_bytes()) == migration['sha256'], 'MIGRATION_SOURCE_CHANGED')
    path.parent.chmod(0o755)
    need(migrate_image(d, target) == json.loads((stage / 'migrate-image.json').read_bytes()), 'MIGRATE_IMAGE_CHANGED')
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
    check_migration(migration_state(d, target, contract), contract, True)
    journal.write_text(json.dumps({'phase': 'VERIFIED', 'migration': migration}) + '\n')
    return {'name': migration['name'], 'sha256': migration['sha256'], 'verified': True, 'dataDeletion': False}


def restore_runtime(d, previous, target, before, contract, h):
    # Restore only this operation's service switch after proving no work began.
    d.assert_no_active_recharge(target)
    d.assert_no_active_registration(target)
    states = h.snapshot(d, target)
    if states['online-recharge']['status'] == 'running':
        h.engine_idle(d, states['online-recharge'], contract)
    d.compose(target, 'stop', 'online-recharge', timeout=90)
    d.compose(previous, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
    for role in ('api', 'admin'):
        d.wait_healthy(previous, role)
    d.compose(previous, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
    d.wait_healthy(previous, 'online-recharge')
    after = h.snapshot(d, previous)
    h.engine_idle(d, after['online-recharge'], contract, wait_connected=True)
    need(all(after[n] == before[n] for n in PRESERVED)
         and all(after[n]['image'] == before[n]['image'] and after[n]['environmentSha256'] == before[n]['environmentSha256']
                 for n in ('api', 'admin', 'online-recharge')), 'RECOVERY_READBACK_CHANGED')


def seed_audit_context(target, payload, contract):
    # Admin-only predecessors intentionally carry config and metadata only.
    # Add only the frozen, independently hashed read-only audit and its imports.
    for n, expected in contract['hostSources'].items():
        raw = (payload / 'host' / n).read_bytes()
        need(n.startswith('scripts/') and '..' not in Path(n).parts and digest(raw) == expected, 'AUDIT_SOURCE_CHANGED')
        p = target / n
        need(not p.is_symlink() and p.resolve().is_relative_to(target), 'AUDIT_SOURCE_PATH_INVALID')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)
        p.chmod(0o644)
    (target / 'scripts').chmod(0o755)
    (target / 'scripts/lib').chmod(0o755)


def release(plan, contract, d, h):
    a = utilities()
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == contract['scope'], 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'chatgpt-sales-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
            raw = (target / 'chatgpt-sales-build-proof.json').read_bytes()
            need(digest(raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            need(all(digest((target / 'scripts/production-release' / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            smoke(d, target, json.loads(raw), states, contract, h, receipt['nginxSha256'])
            return {'status': 'CHATGPT_SALES_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'images': receipt['images'], 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': True}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        stage = BASE / '.staging' / ('chatgpt-sales-' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + plan['mode'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/chatgpt-sales-' + plan['commit'] + '/chatgpt-sales-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            bundle = response.read(32 * 1024**2 + 1)
        need(0 < len(bundle) <= 32 * 1024**2 and digest(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(digest(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = validate_proof(json.loads(raw_proof), plan, contract, payload, h)
        previous, raw_manifest, before, observation = baseline(d, contract, h, proof, plan.get('runtimeBaseline'))
        check_migration(migration_state(d, previous, contract), contract)
        if plan['mode'] == 'preflight':
            return {'status': 'CHATGPT_SALES_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': observation, 'publishedBaselinesReproduced': True, 'businessActions': 0, 'migrationPerformed': False}
        generate_client(d, previous, payload, stage, contract, before)
        models = {n: h.configuration(d, before[n]) for n in ('api', 'admin', 'online-recharge')}
        images = {}
        for role in ('api', 'admin'):
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            a.normalize_image_context(payload / role)
            lines = 'FROM ' + reference + '\n' + ('COPY modules/ /app/apps/api/dist/\nCOPY prisma-client/ /app/node_modules/.prisma/client/\nCOPY schema.prisma /app/apps/api/prisma-mysql/schema.prisma\n' if role == 'api' else 'COPY html/ /usr/share/nginx/html/\n')
            label = 'id-business-v2.recharge-record-build-proof-sha256'
            lines += 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" ' + label + '="' + plan['buildProofSha256'] + '"\n'
            (payload / role / 'Dockerfile').write_text(lines)
            image = 'id-business-v2-sales:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, payload / role, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
            verify_image_configuration(original['Config'], built['Config'])
            need(built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'], label: plan['buildProofSha256']}, 'IMAGE_LABELS_CHANGED')
            images[role] = {'reference': image, 'imageId': built['Id']}
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101', '--entrypoint', 'sh', images['admin']['reference'], '-c', 'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets')
        need(baseline(d, contract, h, proof, plan['runtimeBaseline']) == (previous, raw_manifest, before, observation), 'BASELINE_MOVED')
        audit_context = stage / 'audit-before'
        shutil.copytree(previous, audit_context, symlinks=True)
        seed_audit_context(audit_context, payload, contract)
        before_audit = d.audit(audit_context, stage / 'integrity-before.json', api_admin_only=True)
        need(before_audit == {'checkCount': 49, 'violationCount': 0}, 'PRE_MIGRATION_INTEGRITY_FAILED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-chatgpt-sales')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        seed_audit_context(target, payload, contract)
        for name in contract['sources']:
            destination = target / name
            need(destination.resolve().is_relative_to(target) and not destination.is_symlink(), 'HOST_SOURCE_PATH_INVALID')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(0o644)
        for name, expected in plan['controlSources'].items():
            raw = Path(__file__).with_name(name).read_bytes()
            need(digest(raw) == expected, 'EXECUTOR_CHANGED')
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'EXECUTOR_PATH_INVALID')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in images:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        need(baseline(d, contract, h, proof, plan['runtimeBaseline']) == (previous, raw_manifest, before, observation), 'BASELINE_MOVED')
        h.guards(d, previous, before, contract)
        migration = apply_migration(d, target, contract, stage)
        state_path = stage / 'switch-state.json'
        state_path.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        try:
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            for role in ('api', 'admin'):
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            h.engine_idle(d, h.snapshot(d, target)['online-recharge'], contract, wait_connected=True)
            after = h.snapshot(d, target)
            need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
            for role in ('api', 'admin', 'online-recharge'):
                need(h.configuration(d, after[role]) == models[role] and after[role]['environmentSha256'] == before[role]['environmentSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
            need(all(after[n]['image'] == images[n]['imageId'] for n in images) and after['online-recharge']['image'] == before['online-recharge']['image'], 'RUNTIME_IMAGE_CHANGED')
            online = json.loads(d.run('docker', 'inspect', after['online-recharge']['containerId']))[0]
            need(online['HostConfig']['NetworkMode'] == 'container:' + after['api']['containerId'], 'ONLINE_BINDING_CHANGED')
            smoke(d, target, proof, after, contract, h, observation['nginxSha256'])
            after_audit = d.audit(target, stage / 'integrity-after.json', api_admin_only=True)
            need(after_audit == {'checkCount': 49, 'violationCount': 0}, 'POST_MIGRATION_INTEGRITY_FAILED')
        except Exception:
            recovery = {'status': 'SWITCH_FAILED', 'migrationRetained': True, 'automaticRecovery': False}
            try:
                restore_runtime(d, previous, target, before, contract, h)
                recovery['automaticRecovery'] = True
                recovery['status'] = 'PREDECESSOR_SERVICES_RESTORED'
            finally:
                (stage / 'failure-recovery.json').write_text(json.dumps(recovery, sort_keys=True) + '\n')
            raise
        receipt = {'status': 'CHATGPT_SALES_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before, 'after': after, 'images': images, 'backup': backup, 'migration': migration, 'integrity': {'before': before_audit, 'after': after_audit}, 'nginxSha256': observation['nginxSha256'], 'workflowRunId': plan['workflowRunId'], 'businessActions': 0, 'migrationPerformed': True}
        (target / 'chatgpt-sales-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'chatgpt-sales-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest['previousAdminSourceProjection'] = manifest.get('adminSourceProjection')
        manifest['adminSourceProjection'] = {'kind': 'PUBLISHED_ADMIN_WITH_NATIVE_SALE_OVERLAY', 'commit': plan['commit'], 'sourceTree': plan['tree'], 'sourceBaseline': contract['adminSourceBaseline'], 'changedSources': {n: v for n, v in contract['sources'].items() if n.startswith('apps/admin/')}, 'buildProofSha256': plan['buildProofSha256'], 'preservedNginxSha256': observation['nginxSha256']}
        manifest['roleSourceProjections'] = {**manifest.get('roleSourceProjections', {}), 'admin': manifest['adminSourceProjection'], 'api': {'kind': 'PUBLISHED_API_WITH_NATIVE_SALE_OVERLAY', 'commit': plan['commit'], 'sourceTree': plan['tree'], 'sourceBaseline': contract['apiSourceBaseline'], 'apiModules': proof['apiModules'], 'buildProofSha256': plan['buildProofSha256']}}
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=contract['scope'], status='DEPLOYED', previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest), servicesUpdated=['api', 'admin'], dependentServiceRebound='online-recharge', newMigrations=[contract['migration']['name']], migrationPerformed=True, paymentActions=0, validationRun=plan['workflowRunId'], actualDeployment=receipt, sourceProjection={'sourceBaseline': contract['apiSourceBaseline'], 'changedSources': contract['sources'], 'apiModules': proof['apiModules'], 'buildProofSha256': plan['buildProofSha256']}, sourceLayout='PUBLISHED_PREDECESSOR_WITH_NATIVE_SALE_OVERLAY', deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD', compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
        for field in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun'):
            manifest.pop(field, None)
        for role in images:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-chatgpt-sales')
        state_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {k: receipt[k] for k in ('status', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions', 'migrationPerformed')}
