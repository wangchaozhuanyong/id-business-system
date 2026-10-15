"""Forward-only billing publication, preserving the current application roles."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request
from urllib.parse import urlsplit

BASE = Path('/opt/id-business-v2')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_BILLING_' + code)


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


def migration_state(d, directory, contract):
    name = contract['migration']['name']
    need(re.fullmatch('[0-9]{14}_[a-z_]+', name), 'MIGRATION_NAME_INVALID')
    code = """const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
(async()=>{const checks=await p.$queryRawUnsafe("SELECT c.CONSTRAINT_NAME,c.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='id_business_v2_recharge_addresses' ORDER BY c.CONSTRAINT_NAME");
const rows=await p.$queryRawUnsafe('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=?',MIGRATION_NAME_VALUE);
const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
console.log(JSON.stringify({checks,rows:rows.map(r=>({checksum:r.checksum,finished:r.finished_at!==null,rolledBack:r.rolled_back_at!==null})),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());""".replace('MIGRATION_NAME_VALUE', json.dumps(name))
    return json.loads(d.compose(directory, 'exec', '-T', 'api', 'node', '-e', code))


def verify_migration_state(state, contract, *, applied=False):
    need(state.get('pending') == 0, 'MIGRATION_IN_PROGRESS')
    checks = {r['CONSTRAINT_NAME']: r['CHECK_CLAUSE'] for r in state['checks']}
    original = {r['CONSTRAINT_NAME']: r['CHECK_CLAUSE'] for r in contract['addressChecksBefore']}
    migration = contract['migration']
    if not applied:
        need(checks == original and state['rows'] == [], 'MIGRATION_BASELINE_CHANGED')
        return
    original.pop(migration['oldCheck'])
    need(set(checks) == set(original) | {migration['newCheck']}
         and all(checks[n] == value for n, value in original.items())
         and state['rows'] == [{'checksum': migration['sha256'], 'finished': True, 'rolledBack': False}], 'MIGRATION_READBACK_CHANGED')


def verify_migrate_image(d, directory, contract):
    config = json.loads(d.compose(directory, 'config', '--format', 'json'))
    migration = config['services']['migrate']
    need(migration.get('image') == contract['migrateImage']['reference'], 'MIGRATE_REFERENCE_CHANGED')
    image = json.loads(d.run('docker', 'image', 'inspect', migration['image']))[0]
    need(image['Id'] == contract['migrateImage']['imageId'], 'MIGRATE_IMAGE_CHANGED')
    api_url = urlsplit(config['services']['api']['environment']['DATABASE_URL'])
    migration_url = urlsplit(migration['environment']['DATABASE_URL'])
    need((api_url.scheme, api_url.hostname, api_url.port or 3306, api_url.path) ==
         (migration_url.scheme, migration_url.hostname, migration_url.port or 3306, migration_url.path), 'MIGRATE_DATABASE_CHANGED')


def apply_migration(d, target, contract, stage):
    migration = contract['migration']
    directory = target / Path(migration['path']).parent
    need(not directory.is_symlink() and digest((directory / 'migration.sql').read_bytes()) == migration['sha256'], 'MIGRATION_SOURCE_CHANGED')
    directory.chmod(0o755)
    verify_migrate_image(d, target, contract)
    verify_migration_state(migration_state(d, target, contract), contract)
    journal = stage / 'migration-operation.json'
    need(not journal.exists(), 'MIGRATION_ALREADY_ACCEPTED')
    command = ['run', '--rm', '-T', '--no-deps', '--no-build', '--pull', 'never', '--volume',
               str(directory) + ':/app/apps/api/prisma-mysql/migrations/' + migration['name'] + ':ro',
               '--entrypoint', 'node', 'migrate', '/app/node_modules/prisma/build/index.js']
    schema = ['--schema', '/app/apps/api/prisma-mysql/schema.prisma']
    journal.write_text(json.dumps({'phase': 'STARTED', 'migration': migration}) + '\n')
    # Only this atomic ALTER runs. Never deploy unrelated pending migrations.
    d.compose(target, *command, 'db', 'execute', '--file',
              '/app/apps/api/prisma-mysql/migrations/' + migration['name'] + '/migration.sql', *schema, timeout=180)
    journal.write_text(json.dumps({'phase': 'SQL_APPLIED', 'migration': migration}) + '\n')
    d.compose(target, *command, 'migrate', 'resolve', '--applied', migration['name'], *schema, timeout=180)
    state = migration_state(d, target, contract)
    verify_migration_state(state, contract, applied=True)
    receipt = {'phase': 'VERIFIED', 'migration': migration, 'state': state, 'dataDeletion': False}
    journal.write_text(json.dumps(receipt, sort_keys=True) + '\n')
    return receipt


def validate_proof(proof, plan, contract, payload, h):
    reused = contract.get('priorValidationNative')
    database = {'isolated': True, 'suite': 'recharge-billing.mysql.integration.spec.ts'}
    if reused:
        database['reusedFrom'] = reused
        need(proof.get('apiCompilationReused') == {**reused, 'verified': True}, 'REUSED_PROOF_INVALID')
    need(proof.get('version') == 1 and proof.get('scope') == contract['scope']
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controllerSha256', 'releaseUtilitySha256', 'helperSha256'))
         and proof.get('baselineApiReproduced') is True
         and proof.get('baselineNativeVerified') == {**contract['baselineNative'], 'verified': True}
         and proof.get('databaseVerification') == database
         and proof.get('updatedServices') == ['api', 'admin'] and proof.get('migrationPerformed') is False
         and proof.get('plannedMigration') == contract['migration']
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0, 'PROOF_INVALID')
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    allowed = {n.removesuffix('.js') + ext for n in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    need(actual == proof.get('files') and set(proof['apiModules']) == allowed
         and len(proof['adminFiles']) >= 250
         and {n.removeprefix('source/'): v for n, v in actual.items() if n.startswith('source/')} == contract['sources']
         and {n.removeprefix('api/modules/'): v for n, v in actual.items() if n.startswith('api/modules/')} == proof['apiModules']
         and {n.removeprefix('admin/html/'): v for n, v in actual.items() if n.startswith('admin/html/')} == proof['adminFiles']
         and all(n.startswith(('source/', 'api/modules/', 'admin/html/')) for n in actual), 'PAYLOAD_SCOPE_CHANGED')
    return proof


def baseline(d, contract, h, expected=None):
    a = utilities()
    previous = (BASE / 'current').resolve()
    need(previous == Path(contract['current']) and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(digest(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    states = h.snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need(all(digest((previous / n).read_bytes()) == v for n, v in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and digest(normalizer.read_bytes()) == contract['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    a.verify_modules(d, previous, contract['apiModules'])
    a.verify_admin(d, states['admin'], contract['publicFiles'])
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == contract['nginxSha256'], 'NGINX_CHANGED')
    h.guards(d, previous, states, contract)
    verify_migrate_image(d, previous, contract)
    verify_migration_state(migration_state(d, previous, contract), contract)
    if expected is not None:
        a.verify_runtime_receipt(a.runtime_receipt(previous, raw, states), expected)
    return previous, raw, states


def smoke(d, target, proof, states, contract, h):
    a = utilities()
    a.verify_modules(d, target, proof['apiModules'])
    a.verify_admin(d, states['admin'], {**contract['publicFiles'], **proof['adminFiles']})
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == contract['nginxSha256'], 'NGINX_CHANGED')
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        html = response.read(2 * 1024**2)
    need(digest(html) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in html, 'PUBLIC_BUILD_CHANGED')
    for name, expected in contract['sources'].items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target) and digest(path.read_bytes()) == expected, 'HOST_SOURCE_CHANGED')
    h.guards(d, target, states, contract)
    verify_migration_state(migration_state(d, target, contract), contract, applied=True)
    # Pure execution of the deployed availability and generator modules, without DB/network/payment.
    code = """const a=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-availability.js');
const g=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-billing-generator.js');
const r=a.rechargeAvailability({state:'finished',leaseUntil:new Date(0),ownerId:'fixture',accountKey:null,result:{payment_attempted:true,payment_requests_sent:1,payment_status:'unknown'}},[]);
const n=g.generateRechargeBillingName(),b=g.generateRechargeBillingAddress();
console.log(JSON.stringify({released:r.execution==='released',unknownProtected:r.accountPaymentRestricted&&r.payment==='unknown',name:!!n,address:b.country==='US'&&!!b.city&&!!b.state&&!!b.postalCode}));"""
    need(json.loads(d.compose(target, 'exec', '-T', 'api', 'node', '-e', code)) == {
        'released': True, 'unknownProtected': True, 'name': True, 'address': True}, 'BUSINESS_MODULE_SMOKE_FAILED')


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
            receipt = json.loads((target / 'recharge-billing-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES_CHANGED')
            raw = (target / 'recharge-billing-build-proof.json').read_bytes()
            need(digest(raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            need(all(digest((target / 'scripts/production-release' / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'READBACK_EXECUTOR_CHANGED')
            smoke(d, target, json.loads(raw), states, contract, h)
            return {'status': 'RECHARGE_BILLING_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'images': receipt['images'], 'preservedServices': list(PRESERVED), 'businessActions': 0, 'migrationPerformed': True, 'migration': receipt['migration']}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        previous, raw_manifest, before = baseline(d, contract, h, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'RECHARGE_BILLING_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': a.runtime_receipt(previous, raw_manifest, before), 'businessActions': 0, 'migrationPerformed': False}
        stage = BASE / '.staging' / ('recharge-billing-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/recharge-billing-' + plan['commit'] + '/recharge-billing-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_INVALID')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            bundle = response.read(32 * 1024**2 + 1)
        need(0 < len(bundle) <= 32 * 1024**2 and digest(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(digest(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = validate_proof(json.loads(raw_proof), plan, contract, payload, h)
        models = {n: h.configuration(d, before[n]) for n in ('api', 'admin', 'online-recharge')}
        images = {}
        for role in ('api', 'admin'):
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = h.base_image_reference(d, before[role])
            a.normalize_image_context(payload / role)
            lines = 'FROM ' + reference + '\n' + ('COPY modules/ /app/apps/api/dist/\n' if role == 'api' else 'COPY html/ /usr/share/nginx/html/\n')
            label = 'id-business-v2.recharge-record-build-proof-sha256'
            lines += 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" ' + label + '="' + plan['buildProofSha256'] + '"\n'
            (payload / role / 'Dockerfile').write_text(lines)
            image = 'id-business-v2-billing:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            h.build_image(d, payload / role, image, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', image))[0]
            need(built['RootFS']['Layers'][:len(original['RootFS']['Layers'])] == original['RootFS']['Layers'], 'BASE_LAYERS_CHANGED')
            verify_image_configuration(original['Config'], built['Config'])
            need(built['Config']['Labels'] == {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'], label: plan['buildProofSha256']}, 'IMAGE_LABELS_CHANGED')
            images[role] = {'reference': image, 'imageId': built['Id']}
        d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '101:101', '--entrypoint', 'sh', images['admin']['reference'], '-c', 'test -r /usr/share/nginx/html/index.html && test -x /usr/share/nginx/html/assets')
        need(baseline(d, contract, h, plan['runtimeBaseline']) == (previous, raw_manifest, before), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-recharge-billing')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
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
            need(not path.is_symlink(), 'EXECUTOR_PATH_INVALID')
            path.write_bytes(raw)
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in images:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        need(baseline(d, contract, h, plan['runtimeBaseline']) == (previous, raw_manifest, before), 'BASELINE_MOVED')
        migration_receipt = apply_migration(d, target, contract, stage)
        h.guards(d, previous, before, contract)
        state_path = stage / 'switch-state.json'
        state_path.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
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
        smoke(d, target, proof, after, contract, h)
        receipt = {'status': 'RECHARGE_BILLING_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before, 'after': after, 'images': images, 'backup': backup, 'workflowRunId': plan['workflowRunId'], 'businessActions': 0, 'migrationPerformed': True, 'migration': migration_receipt}
        (target / 'recharge-billing-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'recharge-billing-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest['previousAdminSourceProjection'] = manifest.get('adminSourceProjection')
        manifest['adminSourceProjection'] = {'kind': 'PUBLISHED_ADMIN_WITH_BILLING_OVERLAY', 'commit': plan['commit'], 'sourceTree': plan['tree'], 'sourceBaseline': contract['sourceBaseline'], 'changedSources': {n: v for n, v in contract['sources'].items() if n.startswith('apps/admin/')}, 'buildProofSha256': plan['buildProofSha256'], 'preservedNginxSha256': contract['nginxSha256']}
        manifest['roleSourceProjections'] = {**manifest.get('roleSourceProjections', {}), 'admin': manifest['adminSourceProjection']}
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=contract['scope'], status='DEPLOYED', previousCommit=contract['expectedCurrent'], previousRelease=str(previous), previousManifestSha256=digest(raw_manifest), servicesUpdated=['api', 'admin'], dependentServiceRebound='online-recharge', newMigrations=[], migrationPerformed=False, paymentActions=0, validationRun=plan['workflowRunId'], actualDeployment=receipt, sourceProjection={'sourceBaseline': contract['sourceBaseline'], 'changedSources': contract['sources'], 'apiModules': proof['apiModules'], 'buildProofSha256': plan['buildProofSha256']}, sourceLayout='PUBLISHED_PREDECESSOR_WITH_BILLING_OVERLAY', deploymentMethod='NATIVE_CI_APPROVED_SSM_FORWARD', compiledArtifact={'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']})
        for field in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun'):
            manifest.pop(field, None)
        for role in images:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        manifest['newMigrations'] = [contract['migration']['name']]
        manifest['migrationPerformed'] = True
        manifest['billingAddressMigration'] = migration_receipt
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-recharge-billing')
        state_path.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {k: receipt[k] for k in ('status', 'commit', 'tree', 'images', 'workflowRunId', 'businessActions', 'migrationPerformed')}
