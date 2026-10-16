"""One compiled API module over the measured current image; no migration or UI update."""
import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

BASE = Path('/opt/id-business-v2')
HERE = Path(__file__).resolve().parent
SCOPE = 'MAILBOX_SCOPE_VERSION_RECOVERY'
SOURCE = 'apps/api/src/common/prisma/bump-v2-scope-versions.ts'
MODULES = tuple('common/prisma/bump-v2-scope-versions' + suffix for suffix in ('.js', '.js.map', '.d.ts'))
CURRENT = 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e'


def need(value, code):
    if not value:
        raise RuntimeError('MAILBOX_VERSION_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('mail_version_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_contract(c):
    need(c['version'] == 1 and c['scope'] == SCOPE and c['expectedCurrent'] == CURRENT
         and set(c['sources']) == {SOURCE} and c['migration'] is None
         and c['updatedServices'] == ['api'] and c['reboundServices'] == ['online-recharge']
         and set(c['baseline']['runtime']['modules']) == set(MODULES), 'CONTRACT_SCOPE_CHANGED')
    for name, value in c['helperHashes'].items():
        need(re.fullmatch('[a-z0-9.-]+', name) and sha((HERE / name).read_bytes()) == value, 'INHERITED_HELPER_CHANGED')
    need(set(c['controlFiles']) == {*c['helperHashes'], 'mailbox-version-release.py'}, 'CONTROL_SCOPE_CHANGED')
    for key, status in [('finalize', 'SHARED_BANK_CARD_FORWARD_FINALIZED'), ('readback', 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED')]:
        native = c['predecessorNative'][key]
        result = json.loads(native['StandardOutputContent'])
        need(native['Status'] == 'Success' and native['ResponseCode'] == 0 and not native['StandardErrorContent']
             and native['InstanceId'] == 'i-05836da38606e633c' and result['status'] == status
             and result['commit'] == CURRENT and result['businessActions'] == 0, 'PREDECESSOR_NOT_FINALIZED')


INVENTORY_JS = r"""
const f=require('fs'),p=require('path'),c=require('crypto');
const sha=b=>c.createHash('sha256').update(b).digest('hex');
const inv=(root,except=[])=>{const out={};function walk(dir){for(const e of f.readdirSync(dir,{withFileTypes:true})){const x=p.join(dir,e.name),n=p.relative(root,x);if(e.isSymbolicLink())throw Error('SYMLINK');if(e.isDirectory())walk(x);else if(e.isFile()&&!except.includes(n))out[n]=sha(f.readFileSync(x));}}walk(root);const rows=Object.fromEntries(Object.entries(out).sort(([a],[b])=>a<b?-1:a>b?1:0));return {count:Object.keys(rows).length,sha256:sha(JSON.stringify(rows))};};
const names=['common/prisma/bump-v2-scope-versions.js','common/prisma/bump-v2-scope-versions.js.map','common/prisma/bump-v2-scope-versions.d.ts'];
console.log(JSON.stringify({api:inv('/app/apps/api/dist',names),modules:Object.fromEntries(names.map(n=>[n,sha(f.readFileSync('/app/apps/api/dist/'+n))])),shared:inv('/app/packages/shared/dist'),client:inv('/app/node_modules/.prisma/client'),worker:inv('/app/apps/api/src/id-business-v2/auto-registration/worker')}));
"""
DATABASE_JS = r"""
const{PrismaClient}=require('@prisma/client'),c=require('crypto');const p=new PrismaClient();
(async()=>{const rows=await p.$queryRawUnsafe('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');const pending=await p.$queryRawUnsafe('SELECT COUNT(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');const cols=await p.$queryRawUnsafe('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');const hash=v=>c.createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex');console.log(JSON.stringify({ledger:hash(rows),columns:hash(cols),pending:Number(pending[0].n)}));})().catch(()=>process.exitCode=1).finally(()=>p.$disconnect());
"""


def contents(d, states):
    runtime = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', INVENTORY_JS, timeout=60))
    rows = {}
    output = d.run('docker', 'exec', states['admin']['containerId'], 'sh', '-c',
                   'cd /usr/share/nginx/html && find . -type f -exec sha256sum {} +', timeout=60)
    for line in output.splitlines():
        digest, name = line.split('  ', 1)
        need(name.startswith('./') and name not in rows and re.fullmatch('[a-f0-9]{64}', digest), 'ADMIN_INVENTORY_INVALID')
        rows[name.removeprefix('./')] = digest
    return runtime, {'count': len(rows), 'sha256': sha(canonical(rows))}


def database(d, states):
    return json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', DATABASE_JS, timeout=60))


def check_runtime(d, h, states, c, modules):
    runtime, admin = contents(d, states)
    expected = copy.deepcopy(c['baseline']['runtime'])
    expected.pop('inputs', None)
    expected['modules'] = modules
    need(runtime == expected and admin == c['baseline']['admin'], 'RUNTIME_CONTENT_CHANGED')
    need(database(d, states) == c['baseline']['database'], 'DATABASE_STRUCTURE_CHANGED')
    bank = load('shared-bank-card-release.py')
    need(all(bank.configuration_matches(h, d, state, c['baseline']['runtimeConfigurationSha256'][role])
             for role, state in states.items()), 'RUNTIME_CONFIGURATION_CHANGED')
    need(states['online-recharge']['image'] == c['baseline']['services']['online-recharge']['image'], 'SIDECAR_IMAGE_CHANGED')
    load('recharge-record-release.py').engine_idle(d, states['online-recharge'], c, wait_connected=True)


def baseline(d, h, c):
    b = c['baseline']
    current = (BASE / 'current').resolve(strict=True)
    need(str(current) == b['current'] and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(sha(raw) == b['manifestSha256'] and json.loads(raw)['commit'] == CURRENT, 'MANIFEST_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'], 'SERVICES_CHANGED')
    need(all(sha((current / name).read_bytes()) == value for name, value in b['configurationSha256'].items()), 'CONFIGURATION_CHANGED')
    need(all(sha((current / name).read_bytes()) == value for name, value in b['proofs'].items()), 'PREDECESSOR_PROOF_CHANGED')
    need(sha((current / SOURCE).read_bytes()) == c['baselineSourceSha256'], 'BASE_SOURCE_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')
    check_runtime(d, h, states, c, b['runtime']['modules'])
    h.guards(d, current, states, c)
    return current, raw, states


def verify_proof(proof, plan, c, files):
    need(all(proof.get(n) == plan[n] for n in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('scope') == SCOPE and proof.get('sources') == c['sources']
         and proof.get('baselineModulesReproduced') == c['baseline']['runtime']['modules']
         and proof.get('databaseVerification') == {'isolated': True, 'passed': 4}
         and set(proof['modules']) == set(MODULES) and proof.get('migrationPerformed') is False
         and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    expected = {'source/' + SOURCE: c['sources'][SOURCE], **{'api/modules/' + n: v for n, v in proof['modules'].items()}}
    need(files == proof['files'] == expected, 'PAYLOAD_SCOPE_CHANGED')


def smoke(d, h, target, states, c, proof):
    before = c['baseline']['services']
    need(all(states[n] == before[n] for n in before if n not in ('api', 'online-recharge')), 'PRESERVED_SERVICE_CHANGED')
    check_runtime(d, h, states, c, proof['modules'])
    need(all(sha((target / n).read_bytes()) == value for n, value in c['baseline']['configurationSha256'].items()
             if n != 'compose.release.json'), 'CONFIGURATION_CHANGED')
    need(sha((target / SOURCE).read_bytes()) == c['sources'][SOURCE], 'HOST_SOURCE_CHANGED')
    original = json.loads((Path(c['baseline']['current']) / 'compose.release.json').read_bytes())
    changed = json.loads((target / 'compose.release.json').read_bytes())
    changed['services']['api']['image'] = original['services']['api']['image']
    need(changed == original, 'COMPOSE_SCOPE_CHANGED')
    info = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(info['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')


def release(plan, c):
    verify_contract(c)
    need(plan['mode'] in ('preflight', 'release', 'readback') and all(re.fullmatch('[a-f0-9]{40}', plan[n]) for n in ('commit', 'tree'))
         and re.fullmatch('[1-9][0-9]*', plan['workflowRunId']) and re.fullmatch('[1-9][0-9]*', plan['workflowRunAttempt']), 'IDENTITY_INVALID')
    need(sha((HERE / 'mailbox-version-contract.json').read_bytes()) == plan['contractSha256']
         and set(plan['controlSources']) == set(c['controlFiles']), 'CONTRACT_CHANGED')
    for n, value in plan['controlSources'].items():
        need(sha((HERE / n).read_bytes()) == value, 'CONTROL_CHANGED')
    h = load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    a, p = load('recharge-availability-release.py'), load('proxy-result-identity-release.py')
    p.SCOPE = SCOPE
    with (BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            proof_raw = (target / 'mailbox-version-build-proof.json').read_bytes()
            need(manifest['commit'] == plan['commit'] and manifest['scope'] == SCOPE and sha(proof_raw) == plan['buildProofSha256'], 'READBACK_IDENTITY_CHANGED')
            proof = json.loads(proof_raw)
            receipt = json.loads((target / 'mailbox-version-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'], 'READBACK_SERVICES_CHANGED')
            smoke(d, h, target, states, c, proof)
            h.guards(d, target, states, c)
            need(manifest['roleSourceProjections']['api']['parentProjection'] == json.loads((Path(c['baseline']['current']) / 'release-manifest.json').read_bytes())['roleSourceProjections']['api'], 'SOURCE_INHERITANCE_CHANGED')
            return {'status': SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'updatedServices': ['api'], 'migrationPerformed': False, 'businessActions': 0}
        previous, raw_manifest, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': SCOPE + '_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0}
        stage = BASE / '.staging' / ('mailbox-version-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=0o700)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/mailbox-version-' + plan['commit'] + '/mailbox-version-artifact.tar.gz'
        need(plan['artifactUrl'] == url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read(2 * 1024**2 + 1)
        need(len(raw) <= 2 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = load('shared-bank-card-release.py').safe_archive(raw, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = json.loads(raw_proof)
        files = h.file_inventory(payload)
        files.pop('build-proof.json')
        verify_proof(proof, plan, c, files)
        context = payload / 'api'
        a.normalize_image_context(context)
        reference = 'id-business-v2-mailbox-version:' + plan['commit'] + '-' + plan['workflowRunId']
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['api']) + '\nCOPY modules/ /app/apps/api/dist/\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        original = json.loads(d.run('docker', 'image', 'inspect', before['api']['image']))[0]
        h.build_image(d, context, reference, 'api', before['api'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
        load('shared-bank-card-release.py').verify_image(original, built, plan)
        baseline(d, h, c)
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-mailbox-version')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        source = target / SOURCE
        need(not source.is_symlink() and source.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
        source.write_bytes((payload / 'source' / SOURCE).read_bytes())
        for n in [*plan['controlSources'], 'mailbox-version-contract.json']:
            (target / 'scripts/production-release' / n).write_bytes((HERE / n).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        override['services']['api']['image'] = reference
        a.write_release_override(target / 'compose.release.json', override)
        baseline(d, h, c)
        markers = p.claim_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': markers}) + '\n')
        try:
            fence.acquire()
            fence.check_idle()
            p.verify_markers(markers)
            fence.stop(before['api'], grace=30)
            fence.stop(before['online-recharge'], grace=45)
            fence.close()
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', timeout=180)
            d.wait_healthy(target, 'api')
            d.compose(target, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'online-recharge', timeout=180)
            d.wait_healthy(target, 'online-recharge')
            after = h.snapshot(d, target)
            need(after['api']['image'] == built['Id'], 'IMAGE_CHANGED')
            smoke(d, h, target, after, c, proof)
        except BaseException:
            journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target), 'maintenance': markers}) + '\n')
            raise
        finally:
            fence.close()
        receipt = {'status': 'DEPLOYED', 'commit': plan['commit'], 'before': before, 'after': after, 'backup': backup,
                   'buildProofSha256': plan['buildProofSha256'], 'migrationPerformed': False, 'businessActions': 0}
        (target / 'mailbox-version-preservation.json').write_bytes(canonical(receipt))
        (target / 'mailbox-version-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE, previousCommit=CURRENT,
                        previousRelease=str(previous), previousManifestSha256=sha(raw_manifest), status='DEPLOYED',
                        servicesUpdated=['api'], servicesRebound=['online-recharge'], newMigrations=[], migrationPerformed=False,
                        paymentActions=0, mailboxVersionPublication=receipt)
        manifest['images']['api'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest['roleSourceProjections']
        projections['api'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': copy.deepcopy(projections['api']),
                              'sources': c['sources'], 'buildProofSha256': plan['buildProofSha256']}
        (target / 'release-manifest.json').write_bytes(canonical(manifest))
        d.point_current(target, stamp + '-mailbox-version')
        p.release_markers(markers)
        h.guards(d, target, after, c)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {'status': SCOPE + '_DEPLOYED', 'commit': plan['commit'], 'updatedServices': ['api'], 'migrationPerformed': False, 'businessActions': 0}
