"""Finite forward publication with exact parent, one migration and independent readback."""
import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
SCOPE = 'RECHARGE_PLAN_BILLING_20261026'
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
PREFIX = 'recharge-plan-billing'
CONTRACT = PREFIX + '-contract.json'


def need(value, code):
    if not value:
        raise RuntimeError('RECHARGE_PLAN_BILLING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('billing_release_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_files(d, container, root, files):
    need(files and all(re.fullmatch(r'[A-Za-z0-9_./-]+', n) and '..' not in Path(n).parts
                       and not n.startswith('/') and re.fullmatch('[a-f0-9]{64}', v)
                       for n, v in files.items()), 'FILE_MANIFEST')
    actual = {}
    for line in d.run('docker', 'exec', container, 'sha256sum', *(root + n for n in files), timeout=60).splitlines():
        value, path = line.split('  ', 1)
        need(path.startswith(root), 'FILE_PATH')
        actual[path.removeprefix(root)] = value
    need(actual == files, 'RUNTIME_CONTENT')


def db_state(d, directory, database=None):
    name = '20261026010000_recharge_billing_uniqueness'
    query = ("SELECT JSON_OBJECT('pending',(SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),"
             "'applied',(SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name='" + name + "' AND finished_at IS NOT NULL AND rolled_back_at IS NULL),"
             "'checksum',(SELECT checksum FROM _prisma_migrations WHERE migration_name='" + name + "' LIMIT 1),"
             "'allocationTable',(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_recharge_billing_allocations'),"
             "'referenceColumn',(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_recharge_address_uses' AND COLUMN_NAME='address_reference'),"
             "'nullableUses',(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='id_business_v2_recharge_address_uses' AND COLUMN_NAME='address_id' AND IS_NULLABLE='YES'),"
             "'nullableFks',(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN ('recharge_address_use_nullable_fkey','recharge_card_billing_address_nullable_fkey','recharge_billing_allocation_address_fkey') AND DELETE_RULE='SET NULL'));\n")
    database = database or d.current_job_database(directory)
    need(re.fullmatch('[A-Za-z0-9_]+', database), 'DATABASE_TARGET')
    return json.loads(d.compose(directory, 'exec', '-T', '-e', 'MYSQL_DATABASE=' + database, 'mysql',
        'sh', '-c', 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --batch --skip-column-names -u root "$MYSQL_DATABASE"', input_data=query))


def verify_db(state, c, applied=False):
    expected = {'pending': 0, 'applied': int(applied), 'checksum': c['migration']['sha256'] if applied else None,
                'allocationTable': int(applied), 'referenceColumn': int(applied),
                'nullableUses': int(applied), 'nullableFks': 3 if applied else 0}
    need(state == expected, 'MIGRATION_STATE')


def baseline(d, h, c):
    b = c['baseline']
    previous = (BASE / 'current').resolve(strict=True)
    need(str(previous) == b['current'] and previous.parent == BASE / 'releases', 'PARENT_PATH')
    raw = (previous / 'release-manifest.json').read_bytes()
    need(sha(raw) == b['manifestSha256'] and json.loads(raw)['commit'] == b['expectedCurrent'], 'PARENT_MOVED')
    states = h.snapshot(d, previous)
    need(states == b['services'], 'PARENT_SERVICES')
    need(all(sha((previous / n).read_bytes()) == v for n, v in b['configurationSha256'].items()), 'PARENT_CONFIGURATION')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    h.guards(d, previous, states, c)
    verify_files(d, states['api']['containerId'], '/app/node_modules/.prisma/client/',
                 {'schema.prisma': b['apiGroups']['schema']})
    config = json.loads(d.compose(previous, 'config', '--format', 'json'))
    api = urlsplit(config['services']['api']['environment']['DATABASE_URL'])
    migration = urlsplit(config['services']['migrate']['environment']['DATABASE_URL'])
    need(api.scheme == 'mysql' and api.hostname == 'mysql' and migration.username and migration.password
         and (api.scheme, api.hostname, api.port or 3306, api.path) ==
             (migration.scheme, migration.hostname, migration.port or 3306, migration.path), 'MIGRATION_DATABASE_TARGET')
    verify_db(db_state(d, previous), c)
    return previous, raw, states


def safe_payload(raw, directory):
    need(not directory.exists(), 'PAYLOAD_ALREADY_ACCEPTED')
    directory.mkdir(mode=0o700)
    names = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            parts = Path(member.name).parts
            total += member.size
            need(parts and parts[0] == 'payload' and not member.name.startswith('/')
                 and '..' not in parts and member.name not in names and (member.isfile() or member.isdir())
                 and member.size <= 40 * 1024**2 and total <= 160 * 1024**2, 'PAYLOAD_PATH')
            names.add(member.name)
            path = directory / member.name
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(member).read())
                path.chmod(0o644)
    return directory / 'payload'


def validate_proof(proof, plan, c, files):
    need(proof['version'] == 1 and proof['scope'] == SCOPE
         and proof['sourceLayout'] == 'PUBLISHED_PREDECESSOR_WITH_REVIEWED_MAIN_BILLING_OVERLAY'
         and all(proof[k] == plan[k] for k in ['commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256'])
         and proof['sources'] == c['sources'] and proof['businessActions'] == 0
         and proof['baselineApiGroups'] == c['baseline']['apiGroups']['groups']
         and fingerprint(proof['baselineAdminFiles']) == c['baseline']['adminFilesSha256'], 'BUILD_IDENTITY')
    modules = {n.removeprefix('apps/api/src/').removesuffix('.ts') + ext for n in c['sources']
               if n.startswith('apps/api/src/') and not n.endswith('.spec.ts')
               for ext in ('.js', '.js.map', '.d.ts')}
    need(set(proof['apiModules']) == modules and proof['adminFiles'].get('index.html')
         and re.fullmatch(r'098208446664\.dkr\.ecr\.ap-northeast-1\.amazonaws\.com/id-business-v2-release@sha256:[a-f0-9]{64}', proof['migrationImage']), 'PAYLOAD_SCOPE')
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'api/prisma-client/' + n: v for n, v in proof['prismaClientFiles'].items()},
                **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
                **{'source/' + n: v for n, v in c['sources'].items()},
                **{'controls/' + n: v for n, v in proof['controlSources'].items()}}
    need(files == expected == proof['files'] and proof['contractSha256'] == sha((HERE / CONTRACT).read_bytes()), 'PAYLOAD_HASH')
    return proof


def migrate(d, target, c, journal, database):
    verify_db(db_state(d, target, database), c)
    journal.write_text(json.dumps({'phase': 'SQL_STARTED', 'name': c['migration']['name']}) + '\n')
    command = ['run', '--rm', '-T', '--no-deps', '--pull', 'never', '--entrypoint', 'node',
               'migrate', '/app/node_modules/prisma/build/index.js']
    schema = ['--schema', '/app/apps/api/prisma-mysql/schema.prisma']
    d.compose(target, *command, 'db', 'execute', '--file', '/app/' + c['migration']['path'], *schema, timeout=180)
    journal.write_text(json.dumps({'phase': 'SQL_APPLIED', 'name': c['migration']['name']}) + '\n')
    d.compose(target, *command, 'migrate', 'resolve', '--applied', c['migration']['name'], *schema, timeout=180)
    verify_db(db_state(d, target, database), c, True)
    journal.write_text(json.dumps({'phase': 'VERIFIED', 'migration': c['migration'], 'dataDeletion': False}) + '\n')


def smoke(d, h, target, states, proof, c):
    verify_files(d, states['api']['containerId'], '/app/apps/api/dist/', proof['apiModules'])
    verify_files(d, states['api']['containerId'], '/app/node_modules/.prisma/client/', proof['prismaClientFiles'])
    verify_files(d, states['admin']['containerId'], '/usr/share/nginx/html/', proof['adminFiles'])
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0]
         == c['baseline']['nginxSha256'], 'NGINX_CHANGED')
    verify_db(db_state(d, target), c, True)
    code = """const r=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-local-validation.js');
const b=require('/app/apps/api/dist/id-business-v2/auto-recharge/persistence/recharge-billing.repository.js');
const {Prisma}=require('@prisma/client');
const {finalizeRechargeCard}=require('/app/apps/api/dist/id-business-v2/auto-recharge/recharge-card-billing.js');
(async()=>{let counted=0,bound=0;const job={id:'pure-fixture',ownerId:'pure-fixture',cardId:'pure-fixture',action:'bitbrowser',accountKey:null,result:{billing_allocation_id:'pure-fixture'}};
await finalizeRechargeCard({tx:{},job,report:{},order:{cardId:'pure-fixture',rechargeJobId:'pure-fixture'},repository:{},cards:{finishSharedCard:async(_tx,_id,_report,verified)=>{if(verified)counted++;return null;},bindVerifiedBilling:async()=>{bound++;return true;}}});
console.log(JSON.stringify({validator:typeof r.validateRechargeBitBrowserStart==='function',allocationModel:Prisma.dmmf.datamodel.models.some(m=>m.name==='IdBusinessV2RechargeBillingAllocation'),unknownProtected:b.billingJobSettled({state:'finished',result:{payment_status:'unknown'}})===false,allocationStillCounts:counted===1&&bound===0}));})().catch(()=>process.exit(1));"""
    need(json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code))
         == {'validator': True, 'allocationModel': True, 'unknownProtected': True,
             'allocationStillCounts': True}, 'DEPLOYED_MODULE_SMOKE')
    h.guards(d, target, states, c)
    with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
        html = response.read(2 * 1024**2)
    need(sha(html) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in html, 'PUBLIC_VERSION')


def release(plan):
    os.umask(0o077)
    c = json.loads((HERE / CONTRACT).read_bytes())
    need(c['scope'] == SCOPE and plan['mode'] in ('preflight', 'release', 'readback')
         and re.fullmatch('[a-f0-9]{40}', plan['commit']) and re.fullmatch('[a-f0-9]{40}', plan['tree'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunId'])
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'PLAN_IDENTITY')
    need(plan['contractSha256'] == sha((HERE / CONTRACT).read_bytes()), 'CONTRACT_CHANGED')
    h = load('recharge-record-release.py')
    h.SERVICES = SERVICES
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    a = load('recharge-availability-release.py')
    for name, value in plan['controlSources'].items():
        need(sha((HERE / name).read_bytes()) == value, 'CONTROL_CHANGED')
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE, 'READBACK_VERSION')
            receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and all(states[n] == receipt['before'][n] for n in PRESERVED), 'READBACK_SERVICES')
            raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            need(sha(raw) == plan['buildProofSha256'], 'READBACK_PROOF')
            smoke(d, h, target, states, json.loads(raw), c)
            return {'status': 'BILLING_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'migrationPerformed': True, 'businessActions': 0}
        previous, manifest_raw, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': 'BILLING_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'parentManifestSha256': sha(manifest_raw), 'businessActions': 0}
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'PUBLICATION_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == url, 'ARTIFACT_LOCATION')
        with urllib.request.urlopen(url, timeout=90) as response:
            raw = response.read(96 * 1024**2 + 1)
        need(0 < len(raw) <= 96 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = safe_payload(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'BUILD_PROOF_CHANGED')
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        proof = validate_proof(json.loads(proof_raw), plan, c, files)
        verify_files(d, before['admin']['containerId'], '/usr/share/nginx/html/', proof['baselineAdminFiles'])
        models = {n: h.configuration(d, before[n]) for n in ('api', 'admin', 'online-recharge')}
        images = {}
        for role, copies in [('api', 'COPY modules/ /app/apps/api/dist/\nCOPY prisma-client/ /app/node_modules/.prisma/client/\n'),
                             ('admin', 'COPY html/ /usr/share/nginx/html/\n')]:
            context = payload / role
            a.normalize_image_context(context)
            reference = 'id-business-v2-billing-plan:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            parent = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before[role]) + '\n' + copies
                + 'LABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            need(built['RootFS']['Layers'][:len(parent['RootFS']['Layers'])] == parent['RootFS']['Layers'], 'IMAGE_PARENT')
            load('recharge-billing-release.py').verify_image_configuration(parent['Config'], built['Config'])
            images[role] = {'reference': reference, 'imageId': built['Id']}
        # Standard ECR login stays in an ephemeral Docker credential directory.
        with tempfile.TemporaryDirectory(prefix='id-billing-ecr-') as credentials:
            docker_env = {**os.environ, 'DOCKER_CONFIG': credentials}
            password = d.run('aws', 'ecr', 'get-login-password', '--region', 'ap-northeast-1')
            d.run('docker', 'login', '--username', 'AWS', '--password-stdin',
                  '098208446664.dkr.ecr.ap-northeast-1.amazonaws.com',
                  env=docker_env, input_data=password + '\n')
            d.run('docker', 'pull', proof['migrationImage'], env=docker_env, timeout=300)
        code = ("const fs=require('fs'),c=require('crypto');const files="
                + json.dumps({c['migration']['path']: c['migration']['sha256'],
                              'apps/api/prisma-mysql/schema.prisma': c['sources']['apps/api/prisma-mysql/schema.prisma']})
                + ";if(!Object.entries(files).every(([n,v])=>c.createHash('sha256').update(fs.readFileSync('/app/'+n)).digest('hex')===v))process.exit(1);console.log('MIGRATION_SOURCE_VERIFIED');")
        need(d.run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                   proof['migrationImage'], '-e', code) == 'MIGRATION_SOURCE_VERIFIED', 'MIGRATION_IMAGE_SOURCE')
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_REQUIRED')
        baseline(d, h, c)
        database = d.current_job_database(previous)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-billing-plan')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in c['sources']:
            destination = target / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'HOST_SOURCE_PATH')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in images:
            override['services'][role]['image'] = images[role]['reference']
        override['services']['migrate']['image'] = proof['migrationImage']
        a.write_release_override(target / 'compose.release.json', override)
        for name in plan['controlSources']:
            (target / 'scripts/production-release' / name).write_bytes((HERE / name).read_bytes())
        p = load('proxy-result-identity-release.py')
        p.SCOPE = SCOPE
        markers = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class({'sqlFenceHelperSha256': plan['controlSources']['api-admin-scope.py']})(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target)}) + '\n')
        try:
            fence.acquire()
            recovery = load('online-profile-lock-recovery.py')
            profile = load('online-checkout-release.py').stop_recharge_and_recover(d, previous, before, lock, fence, recovery)
            migrate(d, target, c, stage / 'migration-operation.json', database)
            d.compose(target, 'up', '-d', '--no-deps', 'api', 'admin', timeout=180)
            d.wait_healthy(target, 'api')
            d.wait_healthy(target, 'admin')
            d.compose(target, 'up', '-d', '--no-deps', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(all(after[n] == before[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
            for role in ('api', 'admin', 'online-recharge'):
                need(h.configuration(d, after[role]) == models[role]
                     and after[role]['environmentSha256'] == before[role]['environmentSha256'], 'SERVICE_CONFIGURATION_CHANGED')
            need(all(after[n]['image'] == images[n]['imageId'] for n in images)
                 and after['online-recharge']['image'] == before['online-recharge']['image'], 'SERVICE_IMAGE_CHANGED')
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target), 'automaticRollback': False}) + '\n')
            raise
        finally:
            fence.close()
        p.release_markers(markers)
        smoke(d, h, target, after, proof, c)
        receipt = {'status': 'BILLING_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'],
                   'workflowRunId': plan['workflowRunId'], 'before': before, 'after': after,
                   'images': images, 'backup': backup, 'profileLockRecovery': profile,
                   'migration': c['migration'], 'migrationPerformed': True, 'businessActions': 0}
        (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
        (target / (PREFIX + '-build-proof.json')).write_bytes(proof_raw)
        manifest = json.loads(manifest_raw)
        manifest.update(commit=plan['commit'], applicationCommit=plan['commit'], controlCommit=plan['commit'],
                        version='v2-' + plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, status='DEPLOYED',
                        previousCommit=c['baseline']['expectedCurrent'], previousRelease=str(previous),
                        previousManifestSha256=sha(manifest_raw), migrationPerformed=True,
                        newMigrations=[c['migration']['name']], paymentActions=0, validationRun=plan['workflowRunId'],
                        servicesUpdated=['api', 'admin'], dependentServiceRebound='online-recharge', actualDeployment=receipt)
        manifest.update(sourceLayout=proof['sourceLayout'], deploymentMethod='NATIVE_MAIN_REBUILD_AND_SSM_FORWARD',
                        sourceProjection={'changedSources': c['sources'], 'apiModules': proof['apiModules'],
                                          'buildProofSha256': plan['buildProofSha256']})
        artifact = {'url': plan['artifactUrl'], 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']}
        manifest.update(buildProofSha256=plan['buildProofSha256'], compiledArtifact=artifact,
                        apiCompiledArtifact=artifact, adminCompiledArtifact=artifact)
        for name in ('acceptedSwitchCommandId', 'publicationFinalization', 'deploymentRun'):
            manifest.pop(name, None)
        for role in images:
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
            projections = manifest.setdefault('roleSourceProjections', {})
            projections[role] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get(role),
                'buildProofSha256': plan['buildProofSha256'], 'sources': {n: v for n, v in c['sources'].items() if n.startswith('apps/' + role + '/')}}
        migration_image = json.loads(d.run('docker', 'image', 'inspect', proof['migrationImage']))[0]
        manifest['images']['migrate'] = {'reference': proof['migrationImage'], 'digest': migration_image['Id'], 'sourceCommit': plan['commit']}
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-billing-plan')
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'commit': plan['commit'], 'target': str(target)}) + '\n')
        return {'status': 'BILLING_DEPLOYED', 'commit': plan['commit'], 'migrationPerformed': True, 'businessActions': 0}


if __name__ == '__main__':
    import sys
    result = release(json.loads(Path(sys.argv[1]).read_bytes()))
    print(json.dumps(result, sort_keys=True))
