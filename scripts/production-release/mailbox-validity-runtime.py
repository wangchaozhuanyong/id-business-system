"""Finite mailbox-only API/Admin release with one additive, data-preserving migration."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tarfile
import io
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'mailbox-validity'
SCOPE = 'MAILBOX_QUERY_CODE_VALIDITY_20261027'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*UPDATED, *PRESERVED, 'online-recharge')


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_VALIDITY_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('mailbox_validity_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c['sourceReview']['main'] == 'b3dd3bf3e0c59b7905a037e971a71430c6f528ba'
         and c['sourceReview']['head'] == '359316257fc7082559c26e2e5b0ea0f313544539'
         and c['sourceReview']['pullRequest'] == 750, 'SOURCE_REVIEW_CHANGED')
    need(c['scope'] == SCOPE and c['version'] == 1 and c['expectedCurrent'] == 'a7f61aeca2b6ead635f3e0d8858f760da96964de'
         and c['sourceBase'] == c['expectedCurrent'] and set(c['parentUpdatedImages']) == {'api', 'admin', 'online-recharge'}, 'IDENTITY_CHANGED')
    need(c['migration']['name'] == '20261027010000_managed_mailbox_query_code_validity'
         and c['sources'][c['migration']['path']] == c['migration']['sha256']
         and c['migration']['sql'] == '-- Existing codes and their expiration timestamps are preserved.\nALTER TABLE `id_business_v2_managed_mailboxes`\n  ADD COLUMN `query_code_validity_days` INTEGER NOT NULL DEFAULT 30;\n', 'MIGRATION_SCOPE_CHANGED')
    need(c['updatedServices'] == list(UPDATED) and c['preservedServices'] == list(PRESERVED)
         and c['reboundServices'] == ['online-recharge'] and c['businessActions'] == 0, 'SERVICE_SCOPE_CHANGED')
    need(all(n.startswith(('apps/admin/src/v2/', 'apps/api/src/id-business-v2/workspace/', 'apps/api/prisma-mysql/', 'packages/shared/src/v2/'))
             and '..' not in Path(n).parts for n in c['sources']), 'SOURCE_SCOPE_CHANGED')
    need(all(n.startswith('id-business-v2/workspace/') and n.endswith('.js') and '..' not in Path(n).parts for n in c['apiModules']), 'API_SCOPE_CHANGED')


def utilities(c):
    h = load('recharge-record-release.py')
    h.SERVICES = SERVICES
    d = h.load_utilities(HERE / 'remote-deploy.py', c['helperPins']['remote-deploy.py'])
    return d, h


def idle(d, current, states, c, h):
    old = load('online-query-network-release.py')
    old.SERVICES, old.SCOPE = SERVICES, SCOPE
    old.retired_guards(d, current, states, c, h)


def mysql(d, directory, sql):
    return load('shared-bank-card-release.py').mysql_read(d, directory, sql)


def database(d, directory, c):
    ledger = json.loads(mysql(d, directory, "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL)),JSON_ARRAY()) FROM _prisma_migrations"))
    for row in ledger:
        row['finished'], row['rolledBack'] = bool(row['finished']), bool(row['rolledBack'])
    selected = [r for r in ledger if r['name'] == c['migration']['name']]
    old = sorted((r for r in ledger if r['name'] != c['migration']['name']), key=lambda r: r['name'])
    columns = json.loads(mysql(d, directory, "SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('type',DATA_TYPE,'nullable',IS_NULLABLE,'default',COLUMN_DEFAULT)),JSON_ARRAY()) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_managed_mailboxes' AND COLUMN_NAME='query_code_validity_days'"))
    return {'ledgerSha256': sha(canonical(old)), 'pending': sum(not r['finished'] and not r['rolledBack'] for r in ledger), 'selected': selected, 'columns': columns}


def old_codes(d, directory):
    # Only aggregate fingerprints leave MySQL; query codes and encrypted credentials never leave it.
    return json.loads(mysql(d, directory, "SET SESSION group_concat_max_len=16777216; SELECT JSON_OBJECT('count',COUNT(*),'sha256',SHA2(COALESCE(GROUP_CONCAT(SHA2(CONCAT_WS('|',id,query_code_hash,COALESCE(query_code_encrypted,''),CAST(query_code_expires_at AS CHAR)),256) ORDER BY id SEPARATOR ''),''),256)) FROM id_business_v2_managed_mailboxes"))


def check_database(value, parent, c, applied=False):
    expected = [{'name': c['migration']['name'], 'checksum': c['migration']['sha256'], 'finished': True, 'rolledBack': False}] if applied else []
    columns = [{'type': 'int', 'nullable': 'NO', 'default': '30'}] if applied else []
    need(value['pending'] == 0 and value['ledgerSha256'] == parent['ledgerSha256'] and value['selected'] == expected and value['columns'] == columns, 'DATABASE_STATE_CHANGED')


def native_client(d, container):
    code = "const fs=require('fs'),c=require('crypto'),r='/app/node_modules/.prisma/client/';console.log(JSON.stringify({version:require('@prisma/client/package.json').version,native:Object.fromEntries(fs.readdirSync(r).filter(n=>n.endsWith('.node')).map(n=>[n,c.createHash('sha256').update(fs.readFileSync(r+n)).digest('hex')]))}))"
    return json.loads(d.run('docker', 'exec', container, 'node', '-e', code))


def capture(plan, c, d, h):
    current = (BASE / 'current').resolve()
    manifest = json.loads((current / 'release-manifest.json').read_bytes())
    need(current.parent == BASE / 'releases' and manifest['commit'] == c['expectedCurrent'], 'CURRENT_CHANGED')
    proof_raw = (current / c['parentBuildProof']['file']).read_bytes()
    published = json.loads(proof_raw)
    need(sha(proof_raw) == c['parentBuildProof']['sha256'] and published['commit'] == c['expectedCurrent']
         and published['workflowRunId'] == c['parentBuildProof']['workflowRunId'], 'PUBLISHED_PROOF_CHANGED')
    states = h.snapshot(d, current)
    need(all(states[n] == c['parentServices'][n] for n in PRESERVED)
         and all(states[n]['image'] == value['imageId'] for n, value in c['parentUpdatedImages'].items())
         and all(states[n]['environmentSha256'] == c['parentServices'][n]['environmentSha256'] for n in UPDATED), 'PUBLISHED_SERVICES_CHANGED')
    idle(d, current, states, c, h)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['engineFiles'])
    config = json.loads(d.compose(current, 'config', '--format', 'json'))
    ref = config['services']['migrate']['image']
    migration_image = json.loads(d.run('docker', 'image', 'inspect', ref))[0]['Id']
    baseline_modules = {}
    for n in c['apiModules']:
        for ext in ('.js', '.js.map', '.d.ts'):
            name = n.removesuffix('.js') + ext
            line = d.run('docker', 'exec', states['api']['containerId'], 'sha256sum', '/app/apps/api/dist/' + name)
            baseline_modules[name] = line.split()[0]
    raw_config = {n: sha((current / n).read_bytes()) for n in c['configurationFiles']}
    parent = {'current': str(current), 'manifestSha256': sha((current / 'release-manifest.json').read_bytes()),
              'services': states, 'configurationSha256': raw_config, 'baselineApiModules': baseline_modules,
              'runtimeConfigurationSha256': {n: h.configuration(d, states[n]) for n in SERVICES},
              'nativeClient': native_client(d, states['api']['containerId']),
              'migrateImage': {'reference': ref, 'imageId': migration_image}, 'database': database(d, current, c)}
    check_database(parent['database'], parent['database'], c)
    load('shared-bank-card-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
    need(raw_config['apps/api/prisma-mysql/schema.prisma'] == c['beforeSchemaSha256'], 'BASE_SCHEMA_CHANGED')
    return parent


def baseline(parent, c, d, h):
    current = (BASE / 'current').resolve()
    need(str(current) == parent['current'] and sha((current / 'release-manifest.json').read_bytes()) == parent['manifestSha256'], 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    need(states == parent['services'] and all(sha((current / n).read_bytes()) == v for n, v in parent['configurationSha256'].items()), 'BASELINE_CHANGED')
    idle(d, current, states, c, h)
    check_database(database(d, current, c), parent['database'], c)
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and normalizer.is_file() and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'], 'BACKUP_NORMALIZER_CHANGED')
    load('recharge-billing-release.py').verify_migrate_image(d, current, parent)
    return current, states


def verify_proof(proof, plan, c, files):
    need(all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources', 'nativeParentCapture', 'qualitySourceEvidence')), 'BUILD_PROVENANCE_CHANGED')
    need(proof['scope'] == SCOPE and proof['sources'] == c['sources'] and proof['baselineApiModulesReproduced'] is True and proof['baselineAdminReproduced'] is True and proof['migrationPerformed'] is False and proof['businessActions'] == 0, 'BUILD_PROOF_CHANGED')
    need(proof['retainedSourceBase'] == c['sourceBase'] and proof['reviewBase'] == c['reviewBase'], 'RETAINED_SCOPE_CHANGED')
    selected = {n.removesuffix('.js') + e for n in c['apiModules'] for e in ('.js', '.js.map')}
    need(set(proof['apiModules']) == selected and proof['baselineAdminFiles'] == c['baselineAdminFiles'], 'BUILD_SCOPE_CHANGED')
    declarations = {n: v for n, v in plan['nativeParentCapture']['baseline']['baselineApiModules'].items() if n.endswith('.d.ts')}
    need(set(declarations) == {n.removesuffix('.js') + '.d.ts' for n in c['apiModules']}
         and proof.get('preservedApiDeclarations') == declarations, 'PRESERVED_DECLARATIONS_CHANGED')
    expected = {**{'source/' + n: v for n, v in c['sources'].items()}, **{'api/modules/' + n: v for n, v in proof['apiModules'].items()}, **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()}, **{'api/prisma-client/' + n: v for n, v in proof['prismaClientFiles'].items()}, 'api/schema.prisma': c['sources']['apps/api/prisma-mysql/schema.prisma']}
    need(expected == files == proof['files'] and all('/' not in n and not n.endswith('.node') for n in proof['prismaClientFiles']), 'PAYLOAD_SCOPE_CHANGED')


def apply_migration(d, target, c, parent, stage):
    path = target / c['migration']['path']
    need(path.read_text() == c['migration']['sql'] and sha(path.read_bytes()) == c['migration']['sha256'], 'MIGRATION_SOURCE_CHANGED')
    path.parent.chmod(0o755)
    check_database(database(d, target, c), parent['database'], c)
    before = old_codes(d, target)
    need(before['count'] * 64 < 16777216, 'MAILBOX_COUNT_UNBOUNDED')
    journal = stage / 'migration-operation.json'
    need(not journal.exists(), 'MIGRATION_ALREADY_ACCEPTED')
    command = ['run', '--rm', '-T', '--no-deps', '--pull', 'never', '--volume', str(path.parent) + ':/app/apps/api/prisma-mysql/migrations/' + c['migration']['name'] + ':ro', '--entrypoint', 'node', 'migrate', '/app/node_modules/prisma/build/index.js']
    schema = ['--schema', '/app/apps/api/prisma-mysql/schema.prisma']
    journal.write_text(json.dumps({'phase': 'STARTED', 'migration': c['migration']['name']}) + '\n')
    d.compose(target, *command, 'db', 'execute', '--file', '/app/apps/api/prisma-mysql/migrations/' + c['migration']['name'] + '/migration.sql', *schema, timeout=180)
    journal.write_text(json.dumps({'phase': 'SQL_APPLIED'}) + '\n')
    d.compose(target, *command, 'migrate', 'resolve', '--applied', c['migration']['name'], *schema, timeout=180)
    check_database(database(d, target, c), parent['database'], c, True)
    need(old_codes(d, target) == before, 'EXISTING_CODES_CHANGED')
    journal.write_text(json.dumps({'phase': 'VERIFIED', 'existingCodesPreserved': True, 'rowCount': before['count']}) + '\n')
    return {'existingCodesPreserved': True, 'rowCount': before['count']}


def smoke(d, target, states, proof, parent, c, h):
    shared = load('shared-bank-card-release.py')
    shared.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', proof['apiModules'])
    shared.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', proof['preservedApiDeclarations'])
    shared.read_hashes(d, states['api']['containerId'], '/app/node_modules/.prisma/client/', proof['prismaClientFiles'])
    shared.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    need(native_client(d, states['api']['containerId']) == parent['nativeClient'], 'NATIVE_ENGINE_CHANGED')
    need(all(states[n] == parent['services'][n] for n in PRESERVED) and states['online-recharge']['image'] == parent['services']['online-recharge']['image'], 'PRESERVED_SERVICES_CHANGED')
    need(all(states[n]['environmentSha256'] == parent['services'][n]['environmentSha256'] for n in SERVICES), 'ENVIRONMENT_CHANGED')
    equivalence = load('online-unpaid-validation-release.py').configuration_equivalence
    need(all(equivalence(h, d, states[n], parent['runtimeConfigurationSha256'][n])['matched'] for n in SERVICES), 'RUNTIME_CONFIGURATION_CHANGED')
    check_database(database(d, target, c), parent['database'], c, True)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['engineFiles'])
    h.engine_idle(d, states['online-recharge'], c, wait_connected=True)


def verify_api_image(d, reference, proof):
    expected = {**{'/app/apps/api/dist/' + n: v for n, v in {**proof['apiModules'], **proof['preservedApiDeclarations']}.items()},
                **{'/app/node_modules/.prisma/client/' + n: v for n, v in proof['prismaClientFiles'].items()}}
    code = "const fs=require('fs'),c=require('crypto'),v=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(Object.keys(v).map(n=>[n,c.createHash('sha256').update(fs.readFileSync(n)).digest('hex')]))))"
    actual = json.loads(d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', reference,
                              '-e', code, json.dumps(expected), timeout=60))
    need(actual == expected, 'IMAGE_CONTENT_CHANGED')


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes()) and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    d, h = utilities(c)
    if plan['mode'] == 'parent':
        return {'status': 'MAILBOX_VALIDITY_PARENT_VERIFIED', 'baseline': capture(plan, c, d, h), 'businessActions': 0}
    parent = plan['nativeParentCapture']['baseline']
    a, shared = load('recharge-availability-release.py'), load('shared-bank-card-release.py')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve()
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE, 'READBACK_VERSION_CHANGED')
            proof_raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            need(sha(proof_raw) == plan['buildProofSha256'], 'READBACK_PROOF_CHANGED')
            states = h.snapshot(d, target)
            receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
            need(all(states[n]['image'] == receipt['images'][n]['imageId'] for n in UPDATED), 'PUBLISHED_IMAGE_CHANGED')
            need(all(sha((target / n).read_bytes()) == v for n, v in c['sources'].items()), 'PUBLISHED_SOURCE_CHANGED')
            smoke(d, target, states, json.loads(proof_raw), parent, c, h)
            return {'status': 'MAILBOX_VALIDITY_READBACK_VERIFIED', 'commit': plan['commit'], 'migrationPerformed': True, 'businessActions': 0}
        current, before = baseline(parent, c, d, h)
        if plan['mode'] == 'preflight':
            return {'status': 'MAILBOX_VALIDITY_PREFLIGHT_VERIFIED', 'businessActions': 0}
        need(plan['mode'] == 'release', 'MODE_INVALID')
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        expected_url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == expected_url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(expected_url, timeout=60) as response:
            raw = response.read(40 * 1024**2 + 1)
        need(len(raw) < 40 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = shared.safe_archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'BUILD_PROOF_CHANGED')
        proof = json.loads(proof_raw)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        images = {}
        for role in UPDATED:
            context = stage / ('image-' + role)
            context.mkdir()
            if role == 'api':
                shutil.copytree(payload / 'api/modules', context / 'overlay/apps/api/dist')
                shutil.copytree(payload / 'api/prisma-client', context / 'overlay/node_modules/.prisma/client')
                path = context / 'overlay/apps/api/prisma-mysql/schema.prisma'
                path.parent.mkdir(parents=True)
                shutil.copyfile(payload / 'api/schema.prisma', path)
                copy_line = 'COPY overlay/ /app/'
            else:
                shutil.copytree(payload / 'admin/html', context / 'html')
                copy_line = 'COPY html/ /usr/share/nginx/html/'
            a.normalize_image_context(context)
            ref = 'id-business-v2-mailbox-validity:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            base_ref = h.base_image_reference(d, before[role])
            (context / 'Dockerfile').write_text('FROM ' + base_ref + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            h.build_image(d, context, ref, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', ref))[0]
            shared.verify_image(json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0], built, plan)
            images[role] = {'reference': ref, 'imageId': built['Id']}
        verify_api_image(d, images['api']['reference'], proof)
        baseline(parent, c, d, h)
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-' + PREFIX)
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(current, target, symlinks=True)
        for name in c['sources']:
            path = target / name
            need(path.resolve().is_relative_to(target) and not path.is_symlink(), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((payload / 'source' / name).read_bytes())
            path.chmod(0o644)
        for name in plan['controlSources']:
            path = target / 'scripts/production-release' / name
            path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n')
        (target / 'compose.release.json').chmod(0o600)
        baseline(parent, c, d, h)
        retired = load('online-query-network-release.py')
        retired.SCOPE = SCOPE
        marker = retired.claim_retired_markers(d, before, plan)
        fence = load('proxy-result-identity-release.py').sql_fence_class(c)(d, current)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'STARTED', 'target': str(target)}) + '\n')
        try:
            fence.acquire()
            d.compose(current, 'stop', 'online-recharge', timeout=90)
            fence.check_idle()
            d.compose(current, 'stop', 'api', timeout=90)
            fence.check_idle()
            fence.close()
            migrated = apply_migration(d, target, c, parent, stage)
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            for role in UPDATED:
                d.wait_healthy(target, role)
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[n]['image'] == images[n]['imageId'] for n in UPDATED), 'PUBLISHED_IMAGE_CHANGED')
            smoke(d, target, after, proof, parent, c, h)
        except BaseException:
            journal.write_text(json.dumps({'status': 'FAILED', 'target': str(target), 'businessActions': 0}) + '\n')
            raise
        finally:
            fence.close()
        load('proxy-result-identity-release.py').release_markers(marker)
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after, 'images': images, 'backup': backup, 'migration': migrated, 'businessActions': 0}
        (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / (PREFIX + '-build-proof.json')).write_bytes(proof_raw)
        manifest = json.loads((current / 'release-manifest.json').read_bytes())
        manifest.update(commit=plan['commit'], applicationCommit=plan['commit'], controlCommit=plan['commit'], version='v2-' + plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, previousCommit=c['expectedCurrent'], previousRelease=str(current), status='DEPLOYED', servicesUpdated=list(UPDATED), servicesRebound=['online-recharge'], newMigrations=[c['migration']['name']], migrationPerformed=True, paymentActions=0)
        for role in UPDATED:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        manifest['mailboxValidityPublication'] = receipt
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-' + PREFIX)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'commit': plan['commit']}) + '\n')
        return {'status': 'MAILBOX_VALIDITY_DEPLOYED', 'commit': plan['commit'], 'migrationPerformed': True, 'existingCodesPreserved': True, 'businessActions': 0}
