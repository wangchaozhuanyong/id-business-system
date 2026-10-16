"""Finite API/Admin/sidecar overlay; preserve all other roles, data and runtime settings."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
SCOPE = 'SHARED_BANK_CARD_POOL_PLAN_AND_CURRENCY'
UPDATED = ('api', 'admin')
REBOUND = ('online-recharge',)
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')


def need(value, code):
    if not value:
        raise RuntimeError('SHARED_BANK_CARD_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def download_artifact(plan):
    expected = ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
                'shared-bank-card-' + plan['commit'] + '/shared-bank-card-artifact.tar.gz')
    need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION_INVALID')
    cap = 40 * 1024**2
    with urllib.request.urlopen(expected, timeout=60) as response:
        raw = response.read(cap + 1)
    need(0 < len(raw) <= cap and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
    return raw


def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_proof(proof, plan, contract, files):
    validated_controls = plan.get('validatedControlSources', plan['controlSources'])
    if validated_controls != plan['controlSources']:
        # Reuse only the exact five-test native artifact whose read-only
        # preflight stopped before any migration or switch was accepted.
        need(plan['commit'] == 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e'
             and plan['workflowRunId'] == '38916394747'
             and validated_controls == {**plan['controlSources'], 'shared-bank-card-release.py': '7b727c352ed133b84e7188df5a54c7776819acee2cebdf02a5ffc5023444f89d'}, 'REUSED_EXECUTOR_SCOPE_CHANGED')
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE == contract['scope']
         and all(proof.get(key) == plan[key] for key in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256'))
         and proof.get('controlSources') == validated_controls
         and proof.get('sources') == contract['sources']
         and proof.get('afterEngineFiles') == contract['afterEngineFiles']
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('migrationPerformed') is False and proof.get('plannedMigration') == contract['migration']
         and proof.get('databaseVerification') == {'isolated': True, 'tests': 5, 'passed': 5} and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    declarations = contract.get('apiDeclarationOnly', {})
    expected_modules = {name.removesuffix('.js') + ext for name in contract['apiModules'] for ext in ('.js', '.js.map', '.d.ts')} | set(declarations)
    need(set(proof.get('apiModules', {})) == expected_modules, 'API_MODULE_SCOPE_CHANGED')
    need(all(name.startswith('id-business-v2/online-recharge/') and name.endswith('.d.ts')
             and '..' not in Path(name).parts and re.fullmatch('[a-f0-9]{64}', digest)
             and proof['apiModules'].get(name) == digest for name, digest in declarations.items()), 'API_DECLARATION_CHANGED')
    expected = {**{'source/' + name: value for name, value in contract['sources'].items()},
                **{'api/modules/' + name: value for name, value in proof['apiModules'].items()},
                **{'admin/html/' + name: value for name, value in proof['adminFiles'].items()},
                **{'api/prisma-client/' + name: value for name, value in proof['prismaClientFiles'].items()},
                'api/schema.prisma': contract['sources']['apps/api/prisma-mysql/schema.prisma']}
    need('index.js' in proof['prismaClientFiles'] and 'schema.prisma' in proof['prismaClientFiles']
         and all('/' not in n and not n.endswith('.node') for n in proof['prismaClientFiles']), 'PRISMA_SCOPE_CHANGED')
    need(files == expected == proof['files'] and 'index.html' in proof['baselineAdminFiles']
         and 'index.html' in proof['adminFiles'], 'PAYLOAD_SCOPE_CHANGED')


def read_hashes(d, container, root, expected):
    names = sorted(expected)
    need(all(re.fullmatch(r'[A-Za-z0-9_./-]+', name) and '..' not in Path(name).parts and not name.startswith('/') for name in names), 'FILE_PATH_INVALID')
    values = {}
    for offset in range(0, len(names), 80):
        result = d.run('docker', 'exec', container, 'sha256sum', *(root + name for name in names[offset:offset + 80]), timeout=60)
        for line in result.splitlines():
            digest, name = line.split('  ', 1)
            values[name.removeprefix(root)] = digest
    need(values == expected, 'RUNTIME_CONTENT_CHANGED')


def verify_image(original, built, plan):
    layers = original['RootFS']['Layers']
    need(built['RootFS']['Layers'] == layers + built['RootFS']['Layers'][len(layers):]
         and len(built['RootFS']['Layers']) == len(layers) + 1, 'BASE_LAYERS_CHANGED')
    load('recharge-source-recovery-release.py').verify_image_configuration(original['Config'], built['Config'])
    expected = {**(original['Config'].get('Labels') or {}), 'org.opencontainers.image.revision': plan['commit'],
                'id-business-v2.recharge-record-build-proof-sha256': plan['buildProofSha256']}
    need(built['Config'].get('Labels') == expected, 'IMAGE_LABELS_CHANGED')


def baseline(d, contract, h):
    previous = (BASE / 'current').resolve()
    need(str(previous) == contract['current'] and previous.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == contract['manifestSha256'] and json.loads(raw)['commit'] == contract['expectedCurrent'], 'MANIFEST_CHANGED')
    for overlay in contract['publishedOverlays']:
        need(re.fullmatch('[a-z0-9-]+-build-proof.json', overlay['proofFile'])
             and sha((previous / overlay['proofFile']).read_bytes()) == overlay['proofSha256'], 'PUBLISHED_OVERLAY_PROOF_CHANGED')
    states = h.snapshot(d, previous)
    need(states == contract['services'], 'SERVICES_CHANGED')
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    need(all(sha((previous / name).read_bytes()) == expected for name, expected in contract['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(contract['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file() and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202', 'BACKUP_NORMALIZER_CHANGED')
    h.guards(d, previous, states, contract)
    read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', contract['baselineApiModules'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], contract['beforeEngineFiles'])
    verify_native_client(d, states['api']['containerId'], contract)
    check_migration(migration_state(d, previous, contract), contract)
    load('recharge-billing-release.py').verify_migrate_image(d, previous, contract)
    return previous, raw, states


def smoke(d, target, states, proof, contract, h):
    read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', proof['apiModules'])
    read_hashes(d, states['api']['containerId'], '/app/node_modules/.prisma/client/', proof['prismaClientFiles'])
    read_hashes(d, states['api']['containerId'], '/app/apps/api/prisma-mysql/', {'schema.prisma': contract['sources']['apps/api/prisma-mysql/schema.prisma']})
    verify_native_client(d, states['api']['containerId'], contract)
    check_migration(migration_state(d, target, contract), contract, applied=True)
    need(states['online-recharge']['image'] == contract['services']['online-recharge']['image'], 'ENGINE_IMAGE_CHANGED')
    read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], contract['afterEngineFiles'])
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0] == contract['nginxSha256'], 'NGINX_CHANGED')
    h.engine_idle(d, states['online-recharge'], contract, wait_connected=True)
    need({role: h.configuration(d, state) for role, state in states.items()} == contract['runtimeConfigurationSha256'], 'RUNTIME_CONFIGURATION_CHANGED')
    need(all(states[role] == contract['services'][role] for role in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    need(all(states[role]['environmentSha256'] == contract['services'][role]['environmentSha256'] for role in UPDATED + REBOUND), 'ENVIRONMENT_CHANGED')


def release(plan, contract):
    verify_contract(contract)
    need(plan['mode'] in ('preflight', 'release', 'readback') and re.fullmatch('[a-f0-9]{40}', plan['commit'])
         and re.fullmatch('[a-f0-9]{40}', plan['tree']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']), 'IDENTITY_INVALID')
    need(sha(Path(__file__).with_name('shared-bank-card-contract.json').read_bytes()) == plan['contractSha256'], 'CONTRACT_CHANGED')
    need(set(plan['controlSources']) == set(contract['controlFiles']), 'CONTROL_SCOPE_CHANGED')
    for name, expected in plan['controlSources'].items():
        need(sha(Path(__file__).with_name(name).read_bytes()) == expected, 'CONTROL_SOURCE_CHANGED')
    h = load('recharge-record-release.py')
    d = h.load_utilities(Path(__file__).with_name('remote-deploy.py'), plan['controlSources']['remote-deploy.py'])
    a = load('recharge-availability-release.py')
    p = load('proxy-result-identity-release.py')
    p.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE, 'READBACK_CURRENT_CHANGED')
            receipt = json.loads((target / 'shared-bank-card-preservation.json').read_bytes())
            raw_proof = (target / 'shared-bank-card-build-proof.json').read_bytes()
            need(sha(raw_proof) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            proof = json.loads(raw_proof)
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, target, states, proof, contract, h)
            h.guards(d, target, states, contract)
            return {'status': 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'preservedServices': list(PRESERVED), 'migrationPerformed': True, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, contract, h)
        if plan['mode'] == 'preflight':
            return {'status': 'SHARED_BANK_CARD_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('shared-bank-card-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        artifact = download_artifact(plan)
        payload = h.safe_archive(artifact, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, contract, files)
        # Reproduce the live Admin source even when older hashed assets are retained.
        read_hashes(d, before['admin']['containerId'], '/usr/share/nginx/html/', proof['baselineAdminFiles'])
        images = {}
        for role, copy_line in [('api', 'COPY overlay/ /app/'), ('admin', 'COPY html/ /usr/share/nginx/html/')]:
            context = stage / ('image-' + role)
            context.mkdir()
            if role == 'api':
                shutil.copytree(payload / 'api/modules', context / 'overlay/apps/api/dist')
                shutil.copytree(payload / 'api/prisma-client', context / 'overlay/node_modules/.prisma/client')
                schema_path = context / 'overlay/apps/api/prisma-mysql/schema.prisma'
                schema_path.parent.mkdir(parents=True)
                shutil.copyfile(payload / 'api/schema.prisma', schema_path)
            else:
                shutil.copytree(payload / 'admin/html', context / 'html')
            a.normalize_image_context(context)
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            reference = 'id-business-v2-shared-bank-card:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            base_ref = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + base_ref + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            verify_image(original, built, plan)
            images[role] = {'reference': reference, 'imageId': built['Id']}
        baseline(d, contract, h)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(contract['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-shared-bank-card')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in contract['sources']:
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name in [*plan['controlSources'], 'shared-bank-card-contract.json']:
            path = target / 'scripts/production-release' / name
            path.write_bytes(Path(__file__).with_name(name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        baseline(d, contract, h)
        marker = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(contract)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'previous': str(previous)}) + '\n')
        try:
            fence.acquire()
            d.compose(previous, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            d.compose(previous, 'stop', 'api', timeout=90)
            fence.check_idle()
            fence.close()
            apply_migration(d, target, contract, stage)
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            d.wait_healthy(target, 'api')
            d.wait_healthy(target, 'admin')
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[role]['image'] == images[role]['imageId'] for role in UPDATED), 'IMAGE_CHANGED')
            smoke(d, target, after, proof, contract, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target), 'previous': str(previous), 'businessActions': 0}) + '\n')
            raise
        finally:
            fence.close()
        # Keep the owned maintenance markers if migration or switch is uncertain.
        p.release_markers(marker)
        h.guards(d, target, after, contract)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after, 'images': images,
                   'backup': backup, 'artifactSha256': plan['artifactSha256'], 'buildProofSha256': plan['buildProofSha256'],
                   'preservedServices': list(PRESERVED), 'migrationPerformed': True, 'businessActions': 0,
                   'controlCommit': plan.get('controlCommit', plan['commit']), 'validationRunId': plan['workflowRunId']}
        (target / 'shared-bank-card-preservation.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / 'shared-bank-card-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
                        previousCommit=contract['expectedCurrent'], previousRelease=str(previous),
                        previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=list(UPDATED), servicesRebound=list(REBOUND),
                        newMigrations=[contract['migration']['name']], migrationPerformed=True, paymentActions=0, sharedBankCardPublication=receipt)
        for role in UPDATED:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            projections = manifest.setdefault('roleSourceProjections', {})
            projections[role] = {'kind': 'PUBLISHED_PREDECESSOR_PLUS_SHARED_BANK_CARDS',
                                 'commit': plan['commit'], 'parentProjection': projections.get(role),
                                 'buildProofSha256': plan['buildProofSha256'],
                                 'sources': {name: value for name, value in contract['sources'].items()
                                             if (name.startswith('apps/admin/') if role == 'admin'
                                                 else name.startswith(contract['engineRoot'] + '/') if role == 'online-recharge'
                                                 else name.startswith('apps/api/') and not name.startswith(contract['engineRoot'] + '/'))}}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-shared-bank-card')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target), 'commit': plan['commit']}) + '\n')
        return {'status': 'SHARED_BANK_CARD_DEPLOYED', 'commit': plan['commit'], 'images': images, 'preservedServices': list(PRESERVED), 'migrationPerformed': True, 'businessActions': 0}


def mysql_read(d, directory, query):
    from urllib.parse import urlsplit
    configuration = json.loads(d.compose(directory, 'config', '--format', 'json'))
    database = urlsplit(configuration['services']['api']['environment']['DATABASE_URL']).path.strip('/')
    need(re.fullmatch(r'[A-Za-z0-9_]{1,64}', database), 'DATABASE_IDENTITY_INVALID')
    # The retained MySQL container can still carry its original database name.
    # Select the verified current application database explicitly for every read.
    return d.compose(directory, 'exec', '-e', 'MYSQL_DATABASE=' + database, '-T', 'mysql', 'sh', '-c',
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --batch --raw --skip-column-names -uroot "$MYSQL_DATABASE" -e "$1"',
        'shared-bank-card-read', query, timeout=60)


def migration_state(d, directory, contract):
    migration = contract['migration']
    need(re.fullmatch('[0-9]{14}_[a-z_]+', migration['name']), 'MIGRATION_NAME_INVALID')
    ledger = json.loads(mysql_read(d, directory, "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL)),JSON_ARRAY()) FROM _prisma_migrations"))
    for row in ledger:
        row['finished'], row['rolledBack'] = bool(row['finished']), bool(row['rolledBack'])
    original = sorted((r for r in ledger if r['name'] != migration['name']), key=lambda r: r['name'])
    return {'ledgerSha256': sha(json.dumps(original, sort_keys=True, separators=(',', ':')).encode()),
        'pending': sum(not r['finished'] and not r['rolledBack'] for r in ledger),
        'rows': [r for r in ledger if r['name'] == migration['name']],
        'columns': int(mysql_read(d, directory, "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='online_recharge_cards' AND COLUMN_NAME='allowed_plans' AND DATA_TYPE='json' AND IS_NULLABLE='NO'"))}


def check_migration(state, contract, applied=False):
    need(state['ledgerSha256'] == contract['migrationLedgerSha256'] and state['pending'] == 0, 'PUBLISHED_MIGRATIONS_CHANGED')
    expected = [{'name': contract['migration']['name'], 'checksum': contract['migration']['sha256'], 'finished': True, 'rolledBack': False}] if applied else []
    need(state['rows'] == expected and state['columns'] == int(applied), 'MIGRATION_STATE_CHANGED')


def apply_migration(d, target, contract, stage):
    migration = contract['migration']
    path = target / migration['path']
    need(sha(path.read_bytes()) == migration['sha256'] and not path.is_symlink(), 'MIGRATION_SOURCE_CHANGED')
    path.parent.chmod(0o755)
    load('recharge-billing-release.py').verify_migrate_image(d, target, contract)
    check_migration(migration_state(d, target, contract), contract)
    # Recheck historical ownership after API and worker have stopped.
    need(int(mysql_read(d, target, contract['conflictQuery'])) == 0, 'CARD_OWNERSHIP_CONFLICT')
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
    check_migration(after, contract, applied=True)
    journal.write_text(json.dumps({'phase': 'VERIFIED', 'migration': migration, 'state': after}) + '\n')


def verify_contract(c):
    need(c['scope'] == SCOPE and c['version'] == 1 and c['beforeEngineFiles'] == c['afterEngineFiles'], 'CONTRACT_INVALID')
    need(c['migration']['name'] == '20261016150000_shared_bank_card_pool'
         and c['sources'].get(c['migration']['path']) == c['migration']['sha256'], 'MIGRATION_SCOPE_INVALID')
    need(all(name.startswith(('apps/admin/src/v2/', 'apps/api/src/id-business-v2/', 'apps/api/prisma-mysql/'))
             and '..' not in Path(name).parts for name in c['sources']), 'SOURCE_SCOPE_INVALID')
    need(all(name.startswith('id-business-v2/') and '..' not in Path(name).parts and name.endswith('.js')
             and '/engine/' not in name for name in c['apiModules']), 'API_SCOPE_INVALID')


def verify_native_client(d, container, contract):
    code = "const fs=require('fs'),c=require('crypto'),root='/app/node_modules/.prisma/client/';console.log(JSON.stringify({version:require('@prisma/client/package.json').version,native:Object.fromEntries(fs.readdirSync(root).filter(n=>n.endsWith('.node')).map(n=>[n,c.createHash('sha256').update(fs.readFileSync(root+n)).digest('hex')]))}))"
    need(json.loads(d.run('docker', 'exec', container, 'node', '-e', code)) == contract['nativeClient'], 'NATIVE_DATABASE_ENGINE_CHANGED')
