"""Finite manual-settlement adapter over the immutable, audited publication engine."""
import copy
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
CURRENT = 'cb38a1ef351b42f98ce86740b2191fd54207fa32'
SOURCE = 'cb38a1ef351b42f98ce86740b2191fd54207fa32'
PARENT_PROOF = '21ae3a28caa39c7f4c08fdb70b3e20780c4ed639d4d0bc4d11272dbd9d6d0354'
RECIPE = 'manual-settlement-20261019'
SCOPE = 'BITBROWSER_MANUAL_SETTLEMENT_20261019'
CONTRACT_FILE = 'bitbrowser-manual-contract.json'
WORKFLOW = '.github/workflows/bitbrowser-manual-validation.yml'
RECONSTRUCTED_PARENT_SOURCES = frozenset({
    'apps/api/src/id-business-v2/auto-recharge/recharge-job-list.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-settings-validation.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge-settings.service.ts',
    'apps/admin/src/v2/features/auto-recharge/RechargeProxyOptions.vue'})



def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_MANUAL_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location('manual_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def summary(value):
    return {'count': len(value), 'sha256': sha(canonical(value))}


def validate_contract(c):
    need(c.get('version') == 1 and c.get('status') == 'FROZEN' and c.get('scope') == SCOPE
        and c.get('recipe') == RECIPE and c.get('expectedCurrent') == CURRENT
        and c.get('sourceReviewCommit') == SOURCE and c.get('predecessorProofSha256') == PARENT_PROOF
        and c.get('migrationPerformed') is False and c.get('businessActions') == 0, 'CONTRACT_IDENTITY')
    need(c.get('sourceQualityPolicy') == 'native-full-candidate-with-exact-reviewed-business-and-main-tree'
        and set(c.get('ciControlPins', {})) == {'scripts/ci-bitbrowser-manual-controls.mjs',
            'scripts/ci-bitbrowser-manual-controls.test.mjs', 'scripts/ci-recharge-scope.mjs',
            'scripts/ci-recharge-check.mjs'}, 'CI_POLICY_CHANGED')
    need(len(c.get('sources', {})) == 61 and all(re.fullmatch('[a-f0-9]{64}', v)
        for v in c['sources'].values()), 'SOURCE_SCOPE')
    production = {n: v for n, v in c['sources'].items() if n.startswith(('apps/', 'packages/shared/src/'))
        and not n.endswith(('.spec.ts', '.test.mjs'))}
    need(c.get('productionSources') == production and len(production) == 43
        and set(c.get('sourceParents', {})) == set(production), 'PRODUCTION_SCOPE')
    cycle = 'apps/api/src/id-business-v2/auto-recharge/recharge-cycle-state.ts'
    need(set(c.get('buildParents', {})) == set(production)
        and {n for n in production if c['sourceParents'][n] != c['buildParents'][n]} == {cycle, *RECONSTRUCTED_PARENT_SOURCES}
        and c['sourceParents'][cycle] is None
        and isinstance(c['buildParents'][cycle], str)
        and set(c.get('nativeCycleModules', {})) == {'id-business-v2/auto-recharge/recharge-cycle-state' + suffix
            for suffix in ('.js', '.d.ts', '.js.map')}, 'PARENT_SOURCE_RECONSTRUCTION')
    bindings = c.get('reconstructedParents', {})
    need(set(bindings) == RECONSTRUCTED_PARENT_SOURCES
        and all(c['sourceParents'][name] is None
            and set(row) == {'sourceCommit', 'sourceSha256'}
            and row['sourceCommit'] == c['apiAdminParentCommit']
            and row['sourceSha256'] == c['buildParents'][name]
            and re.fullmatch('[a-f0-9]{64}', row['sourceSha256']) for name, row in bindings.items()),
        'RECONSTRUCTED_PARENT_SOURCES')
    parent_modules = {name.removeprefix('apps/api/src/').removesuffix('.ts') + '.js'
        for name in RECONSTRUCTED_PARENT_SOURCES if name.startswith('apps/api/')}
    need(set(c.get('reconstructedRuntimeModules', {})) == parent_modules
        and all(re.fullmatch('[a-f0-9]{64}', value) for value in c['reconstructedRuntimeModules'].values()),
        'RECONSTRUCTED_RUNTIME_SCOPE')
    chunk = c.get('reconstructedAdminChunk', {})
    need(set(chunk) == {'path', 'sha256'}
        and re.fullmatch(r'assets/V2AutoRechargeView-[A-Za-z0-9_-]+\.js', chunk.get('path', ''))
        and re.fullmatch('[a-f0-9]{64}', chunk.get('sha256', '')), 'RECONSTRUCTED_ADMIN_SCOPE')
    need(all(n.startswith(('apps/admin/src/v2/features/auto-recharge/',
        'apps/api/src/id-business-v2/auto-recharge/',
        'apps/api/src/id-business-v2/bank-card-pool/', 'packages/shared/src/v2/'))
        for n in production), 'PRODUCTION_PATH')
    api = {n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
        for n in production if n.startswith('apps/api/') for suffix in ('.js', '.js.map', '.d.ts')}
    shared = {n.removeprefix('packages/shared/src/').removesuffix('.ts') + suffix
        for n in production if n.startswith('packages/shared/') for suffix in ('.js', '.d.ts')}
    need(set(c.get('apiModules', [])) == api and set(c.get('sharedModules', [])) == shared
        and c.get('updatedServices') == ['api', 'admin']
        and c.get('reboundServices') == ['online-recharge']
        and c.get('preservedServices') == ['mysql', 'caddy', 'media-resolver', 'auto-recharge'], 'OUTPUT_SCOPE')
    need(c.get('sqlFenceHelperSha256') == c['controlPins']['api-admin-scope.py'], 'SQL_FENCE_CHANGED')


def runtime(d, states, c):
    # Only finite selected hashes and aggregate preserved hashes leave containers.
    code = 'const selected=' + json.dumps(c['apiModules']) + ',shared=' + json.dumps(c['sharedModules']) + ';' + r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function files(root){const out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('LINK');if(e.isDirectory())walk(p);else if(e.isFile())out[path.relative(root,p)]=hash(fs.readFileSync(p));else throw Error('KIND');}}walk(root);return out;}
function pick(all,names){return Object.fromEntries(names.filter(n=>n in all).sort().map(n=>[n,all[n]]));}
function inv(all,except=[]){const o=Object.fromEntries(Object.keys(all).filter(n=>!except.includes(n)).sort().map(n=>[n,all[n]]));return{count:Object.keys(o).length,sha256:hash(JSON.stringify(o))};}
const api=files('/app/apps/api/dist'),sh=files('/app/packages/shared/dist');
console.log(JSON.stringify({apiModules:pick(api,selected),apiPreservedInventory:inv(api,selected),sharedModules:pick(sh,shared),sharedPreservedInventory:inv(sh,shared),clientInventory:inv(files('/app/node_modules/.prisma/client'))}));
'''
    out = json.loads(d.run('docker', 'exec', states['api']['containerId'], 'node', '-e', code, timeout=90))
    admin = load('recharge-checkout-release.py').admin_inventory(d, states['admin'])
    out['adminInventory'] = summary(admin)
    out['nginxSha256'] = d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
        '/etc/nginx/conf.d/default.conf').split()[0]
    return out


def observe(c):
    validate_contract(c)
    p = engine(c)
    h, d, _ = p.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(current.parent == BASE / 'releases' and manifest.get('commit') == CURRENT
        and manifest.get('status') == 'DEPLOYED'
        and all(manifest.get('roleSourceProjections', {}).get(role, {}).get('commit') == c['apiAdminParentCommit'] for role in ('api', 'admin'))
        and sha((current / 'bitbrowser-history-build-proof.json').read_bytes()) == PARENT_PROOF,
        'PUBLISHED_PARENT_CHANGED')
    states = h.snapshot(d, current)
    need(states['api']['image'] == c['parentApiImage'] and states['admin']['image'] == c['parentAdminImage']
        and states['online-recharge']['image'] == c['parentOnlineImage'],
        'PARENT_IMAGE_CHANGED')
    need(json.loads(d.run('docker', 'image', 'inspect', states['admin']['image']))[0]['Config']['Labels'].get('org.opencontainers.image.revision') == c['apiAdminParentCommit'], 'ADMIN_PARENT_REVISION')
    h.guards(d, current, states, c)
    normalizer = Path(json.loads((HERE / 'bitbrowser-recovery-contract.json').read_bytes())['baseline']['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink(), 'NORMALIZER_PATH')
    for n, expected in c['sourceParents'].items():
        path = current / n
        need(not path.is_symlink() and (not path.exists() if expected is None else path.is_file()
            and sha(path.read_bytes()) == expected), 'PARENT_SOURCE_CHANGED')
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
        'proofs': {'bitbrowser-history-build-proof.json': PARENT_PROOF},
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in p.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
        **runtime(d, states, c), 'database': p.database(d, states['api']),
        'backupNormalizerPath': str(normalizer), 'backupNormalizerSha256': sha(normalizer.read_bytes())}
    need(all(baseline['apiModules'].get(n) == v for n, v in c['nativeCycleModules'].items()),
        'RECONSTRUCTED_CYCLE_RUNTIME_CHANGED')
    need(all(baseline['apiModules'].get(n) == v for n, v in c['reconstructedRuntimeModules'].items()),
        'RECONSTRUCTED_RUNTIME_CHANGED')
    chunk = c['reconstructedAdminChunk']
    need(d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum',
        '/usr/share/nginx/html/' + chunk['path']).split()[0] == chunk['sha256'], 'RECONSTRUCTED_ADMIN_CHANGED')
    need(baseline['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    return {'status': 'BITBROWSER_MANUAL_READONLY_PARENT', 'baseline': baseline,
        'businessActions': 0, 'databaseWrites': 0}


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(k) == plan.get(k) for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
        'contractSha256', 'qualityVerification', 'isolatedMysqlVerification'))
        and proof.get('scope') == SCOPE and proof.get('recipe') == RECIPE
        and proof.get('sources') == c['sources'] and proof.get('productionSources') == c['productionSources']
        and proof.get('controlSources') == c['controlPins']
        and proof.get('predecessorProofSha256') == PARENT_PROOF
        and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False,
        'PROOF_IDENTITY')
    need(set(proof.get('apiModules', {})) == set(c['apiModules'])
        and set(proof.get('sharedModules', {})) == set(c['sharedModules'])
        and len(proof.get('adminFiles', {})) >= 250 and 'index.html' in proof['adminFiles']
        and proof.get('nativeParentCapture', {}).get('status') == 'BITBROWSER_MANUAL_READONLY_PARENT'
        and proof['nativeParentCapture']['baseline'] == c['baseline'], 'PROOF_OUTPUTS')
    verify_mysql(proof['isolatedMysqlVerification'], plan, c)
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
        **{'api/shared/' + n: v for n, v in proof['sharedModules'].items()},
        **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
        **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def verify_mysql(value, identity, c):
    source = identity.get('qualityVerification', {}).get('sources', {})
    need(value.get('sourceCommit') == SOURCE and value.get('runId') == source.get('runId')
        and re.fullmatch('[1-9][0-9]*', str(value.get('runId', '')))
        and value.get('testedCommit') == source.get('commit')
        and re.fullmatch('[a-f0-9]{40}', value.get('testedCommit', ''))
        and value.get('manualTestsPassed') == 4 and value.get('manualTestsSkipped') == 0
        and value.get('financialStepPassed') is True and value.get('rollbackStepPassed') is True
        and re.fullmatch('[a-f0-9]{64}', value.get('nativeLogSha256', '')),
        'ISOLATED_MYSQL_EVIDENCE')


def engine(c):
    """Keep inherited locking, backup, image provenance and activation guards intact."""
    p = load('bitbrowser-history-release.py')
    p.select_recipe(p.FOLLOWUP)
    p.RECIPE = p.FOLLOWUP = RECIPE
    p.SCOPE, p.CURRENT, p.CONTRACT_FILE = SCOPE, CURRENT, CONTRACT_FILE
    p.PREDECESSOR_PROOF = PARENT_PROOF
    p.MODULES = frozenset(c['apiModules'])
    p.PRESERVED = tuple(c['preservedServices'])
    p.validate_contract = validate_contract
    p.production_sources = lambda contract: contract['productionSources']
    p.verify_proof, p.verify_mysql = verify_proof, verify_mysql
    p.runtime = lambda driver, states, modules=None: runtime(driver, states, c)
    original_helpers = p.helpers

    def helpers():
        h, d, retired = original_helpers()
        build = h.build_image

        def image(driver, context, reference, role, before, stage):
            if role == 'api':
                dockerfile = context / 'Dockerfile'
                text = dockerfile.read_text()
                line = 'COPY modules/ /app/apps/api/dist/'
                need(text.count(line) == 1, 'API_OVERLAY_LAYOUT')
                shutil.copytree(context / 'modules', context / 'overlay/app/apps/api/dist')
                shutil.copytree(context / 'shared', context / 'overlay/app/packages/shared/dist')
                dockerfile.write_text(text.replace(line, 'COPY overlay/ /'))
            return build(driver, context, reference, role, before, stage)

        h.build_image = image
        return h, d, retired

    p.helpers = helpers

    def baseline(d, h, contract, expected=None):
        b = contract['baseline']
        actual = observe(contract)['baseline']
        need(actual == b, 'BASELINE_MOVED')
        current = Path(b['current'])
        raw = (current / 'release-manifest.json').read_bytes()
        receipt = load('recharge-availability-release.py').runtime_receipt(current, raw, b['services'])
        if expected is not None:
            need(expected == receipt, 'PREFLIGHT_MOVED')
        return current, raw, b['services'], receipt

    def smoke(d, h, retired, target, states, contract, proof, before_admin=None):
        b, before = contract['baseline'], contract['baseline']['services']
        need(all(states[n] == before[n] for n in p.PRESERVED)
            and states['online-recharge']['image'] == before['online-recharge']['image']
            and all(states[n]['environmentSha256'] == before[n]['environmentSha256']
                for n in (*p.UPDATED, 'online-recharge'))
            and {n: h.configuration(d, s) for n, s in states.items()} == b['runtimeConfigurationSha256'],
            'PRESERVATION_CHANGED')
        expected_runtime = {k: b[k] for k in runtime(d, states, contract)}
        expected_runtime.update(apiModules=proof['apiModules'], sharedModules=proof['sharedModules'])
        need(type(before_admin) is dict, 'ADMIN_BASELINE_MISSING')
        expected_runtime['adminInventory'] = p.verify_admin_merge(before_admin, proof['adminFiles'],
            load('recharge-checkout-release.py').admin_inventory(d, states['admin']), b['adminInventory'])
        need(runtime(d, states, contract) == expected_runtime and p.database(d, states['api']) == b['database'],
            'RUNTIME_CONTENT_CHANGED')
        old = json.loads((Path(b['current']) / 'compose.release.json').read_bytes())
        new = json.loads((target / 'compose.release.json').read_bytes())
        for role in p.UPDATED:
            new['services'][role]['image'] = old['services'][role]['image']
        need(new == old and all(sha((target / n).read_bytes()) == b['configurationSha256'][n]
            for n in p.CONFIGURATION if n != 'compose.release.json'), 'CONFIGURATION_CHANGED')
        row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
        need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING')
        for name, digest in contract['productionSources'].items():
            path = target / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target)
                and sha(path.read_bytes()) == digest, 'HOST_SOURCE_CHANGED')
        request = urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=25) as response:
            public = response.read(2 * 1024**2 + 1)
        need(sha(public) == proof['adminFiles']['index.html']
            and ('v2-' + proof['commit']).encode() in public, 'PUBLIC_BUILD_CHANGED')
        retired.verify_retired_runtime(d, states)
        h.engine_idle(d, states['online-recharge'], contract, wait_connected=True)

    p.baseline, p.smoke = baseline, smoke
    return p


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        return observe(c)
    need(plan.get('nativeParentCapture', {}).get('status') == 'BITBROWSER_MANUAL_READONLY_PARENT', 'PARENT_CAPTURE_MISSING')
    selected = {**c, 'baseline': plan['nativeParentCapture']['baseline']}
    return _publish(engine(selected), plan, c)


# Derived from the pinned history executor. The new adapter adds shared runtime
# overlay support and a separately authenticated native parent, retaining the
# original single-release lock, exact image layers, backup, switch and readback.
def _publish(engine, plan, c):
    engine.validate_contract(c)
    raw_contract = (HERE / engine.CONTRACT_FILE).read_bytes()
    need(c == json.loads(raw_contract) and plan.get('contractSha256') == sha(raw_contract) and (plan.get('controlSources') == {**c['controlPins'], engine.CONTRACT_FILE: sha(raw_contract)}), 'PLAN_CHANGED')
    need(plan.get('recipe', 'history-20261019') == engine.RECIPE, 'PLAN_RECIPE_CHANGED')
    need(plan.get('mode') in (('parent', 'preflight', 'release', 'readback') if engine.RECIPE == engine.BOUNDED else ('preflight', 'release', 'readback')) and all((re.fullmatch('[a-f0-9]{40}', plan.get(n, '')) for n in ('commit', 'tree'))) and all((re.fullmatch('[1-9][0-9]*', plan.get(n, '')) for n in ('workflowRunId', 'workflowRunAttempt'))), 'PLAN_IDENTITY_INVALID')
    for (name, digest) in plan['controlSources'].items():
        path = HERE / name
        need(path.is_file() and (not path.is_symlink()) and (sha(path.read_bytes()) == digest), 'CONTROL_CHANGED')
    c = {**c, 'baseline': plan['nativeParentCapture']['baseline']}
    (h, d, retired) = engine.helpers()
    (a, p) = (engine.load('recharge-availability-release.py'), engine.load('proxy-result-identity-release.py'))
    with (engine.BASE / '.deploy.lock').open('a') as lock:
        a.acquire_release_lock(lock)
        if engine.RECIPE == engine.BOUNDED:
            if plan['mode'] == 'parent':
                return engine.bounded_capture(d, h, c, plan)
            c = engine.bounded_runtime_contract(d, h, c, plan)
        elif engine.RECIPE == engine.ENTRY:
            c = engine.entry_runtime_contract(d, h, c, plan)
        elif engine.RECIPE == engine.ADDRESS:
            c = engine.address_runtime_contract(d, h, c, plan)
        if plan['mode'] == 'readback':
            target = (engine.BASE / 'current').resolve(strict=True)
            manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / 'bitbrowser-history-build-proof.json').read_bytes()
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == engine.SCOPE and (sha(raw) == plan['buildProofSha256']), 'READBACK_IDENTITY_CHANGED')
            proof = json.loads(raw)
            receipt = json.loads((target / 'bitbrowser-history-preservation.json').read_bytes())
            states = h.snapshot(d, target)
            need(states == receipt['after'] and states[engine.UPDATED[0]]['image'] == receipt['image']['imageId'] and (engine.RECIPE not in (engine.FOLLOWUP, engine.BOUNDED) or all((states[role]['image'] == receipt['images'][role]['imageId'] for role in engine.UPDATED))), 'READBACK_SERVICES_CHANGED')
            need(all((sha((target / 'scripts/production-release' / n).read_bytes()) == v for (n, v) in plan['controlSources'].items())), 'READBACK_EXECUTOR_CHANGED')
            if engine.RECIPE in (engine.ENTRY, engine.ADDRESS, engine.BOUNDED):
                need(receipt.get('verifiedParentBaseline') == c['baseline'] and receipt.get('entryParentSealSha256') == plan['runtimeBaseline']['entryParentSealSha256'], 'ENTRY_PARENT_SEAL_CHANGED')
            engine.smoke(d, h, retired, target, states, c, proof, receipt.get('beforeAdminFiles'))
            h.guards(d, target, states, c)
            old_manifest = json.loads((Path(c['baseline']['current']) / 'release-manifest.json').read_bytes())
            old_projections = old_manifest['roleSourceProjections']
            if engine.RECIPE == engine.ENTRY:
                need(manifest['roleSourceProjections']['admin'] == old_projections['admin'] and manifest.get('adminSourceProjection') == old_manifest.get('adminSourceProjection') and all((manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'api')), 'ENTRY_PRESERVED_IDENTITY_CHANGED')
            if engine.RECIPE == engine.ADDRESS:
                need(manifest['roleSourceProjections']['api'] == old_projections['api'] and manifest.get('apiCompiledArtifact') == old_manifest.get('apiCompiledArtifact') and all((manifest['images'][n] == old_manifest['images'][n] for n in old_manifest['images'] if n != 'admin')), 'ADDRESS_PRESERVED_IDENTITY_CHANGED')
            need(all((manifest['roleSourceProjections'][role]['parentProjection'] == old_projections[role] for role in engine.UPDATED)), 'SOURCE_INHERITANCE_CHANGED')
            return {'status': 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'updatedServices': list(engine.UPDATED), 'preservedServices': list(engine.PRESERVED), 'businessActions': 0, 'migrationPerformed': False}
        if plan['mode'] == 'release':
            need(type(plan.get('runtimeBaseline')) is dict, 'PREFLIGHT_RECEIPT_MISSING')
        (previous, raw_manifest, before, receipt) = engine.baseline(d, h, c, plan.get('runtimeBaseline'))
        if plan['mode'] == 'preflight':
            return {'status': 'BITBROWSER_HISTORY_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'runtimeBaseline': receipt, 'businessActions': 0, 'migrationPerformed': False}
        stage = engine.BASE / '.staging' / ('bitbrowser-history-' + plan['commit'] + '-' + plan['workflowRunId'])
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED')
        stage.mkdir(mode=448)
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/bitbrowser-history-' + plan['commit'] + '/bitbrowser-history-artifact.tar.gz'
        need(plan.get('artifactUrl') == url, 'ARTIFACT_LOCATION_CHANGED')
        with urllib.request.urlopen(url, timeout=60) as response:
            bundle = response.read(engine.ARTIFACT_LIMIT + 1)
        need(0 < len(bundle) <= engine.ARTIFACT_LIMIT and sha(bundle) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = h.safe_archive(bundle, stage / 'content')
        raw_proof = (payload / 'build-proof.json').read_bytes()
        need(sha(raw_proof) == plan['buildProofSha256'], 'PROOF_CHANGED')
        proof = engine.verify_proof(json.loads(raw_proof), plan, c, payload, h)
        images = {}
        for role in engine.UPDATED:
            context = payload / role
            a.normalize_image_context(context)
            reference = 'id-business-v2-history:' + plan['commit'] + '-' + plan['workflowRunId'] + '-' + role
            copy_line = 'COPY modules/ /app/apps/api/dist/' if role == 'api' else 'COPY html/ /usr/share/nginx/html/'
            (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before[role]) + '\n' + copy_line + '\nLABEL org.opencontainers.image.revision="' + plan['commit'] + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
            original = json.loads(d.run('docker', 'image', 'inspect', before[role]['image']))[0]
            h.build_image(d, context, reference, role, before[role], stage)
            built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]
            p.verify_overlay_image(original, built, plan, 1, engine.load('recharge-checkout-release.py'))
            images[role] = {'reference': reference, 'imageId': built['Id']}
        before_admin = engine.load('recharge-checkout-release.py').admin_inventory(d, before['admin']) if engine.RECIPE in (engine.FOLLOWUP, engine.ADDRESS, engine.BOUNDED) else None
        engine.baseline(d, h, c, plan['runtimeBaseline'])
        backup = h.fresh_scoped_backup(d, previous, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = engine.BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-bitbrowser-history')
        need(not target.exists(), 'TARGET_EXISTS')
        shutil.copytree(previous, target, symlinks=True)
        for name in engine.production_sources(c):
            destination = target / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'SOURCE_PATH_CHANGED')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((payload / 'source' / name).read_bytes())
            destination.chmod(420)
        for name in plan['controlSources']:
            destination = target / 'scripts/production-release' / name
            need(not destination.is_symlink() and destination.resolve().is_relative_to(target), 'CONTROL_PATH_CHANGED')
            destination.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes())
        for role in engine.UPDATED:
            override['services'][role]['image'] = images[role]['reference']
        a.write_release_override(target / 'compose.release.json', override)
        engine.baseline(d, h, c, plan['runtimeBaseline'])
        retired.SCOPE = engine.SCOPE
        markers = retired.claim_retired_markers(d, before, plan)
        fence = p.sql_fence_class(c)(d, previous)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'SWITCH_STARTED', 'target': str(target), 'maintenance': markers}) + '\n')
        try:
            fence.acquire()
            p.verify_markers(markers)
            engine.activate_services(d, target, before, fence)
            after = h.snapshot(d, target)
            need(all((after[role]['image'] == images[role]['imageId'] for role in engine.UPDATED)), 'IMAGE_CHANGED')
            engine.smoke(d, h, retired, target, after, c, proof, before_admin)
        except BaseException:
            journal.write_text(json.dumps({'status': 'NEEDS_FORWARD_DIAGNOSIS', 'target': str(target), 'maintenanceHeld': True, 'rollbackPerformed': False}) + '\n')
            raise
        finally:
            fence.close()
        image = images[engine.UPDATED[0]]
        preservation = {'status': 'BITBROWSER_HISTORY_DEPLOYED', 'commit': plan['commit'], 'tree': plan['tree'], 'before': before, 'after': after, 'image': image, 'images': images, 'beforeAdminFiles': before_admin, 'backup': backup, 'workflowRunId': plan['workflowRunId'], 'businessActions': 0, 'migrationPerformed': False}
        if engine.RECIPE in (engine.ENTRY, engine.ADDRESS, engine.BOUNDED):
            preservation['verifiedParentBaseline'] = copy.deepcopy(c['baseline'])
            preservation['entryParentSealSha256'] = plan['runtimeBaseline']['entryParentSealSha256']
        (target / 'bitbrowser-history-preservation.json').write_text(json.dumps(preservation, sort_keys=True, indent=2) + '\n')
        (target / 'bitbrowser-history-build-proof.json').write_bytes(raw_proof)
        manifest = json.loads(raw_manifest)
        for role in engine.UPDATED:
            manifest['roleSourceProjections'][role] = {'kind': engine.SCOPE, 'commit': plan['commit'], 'parentProjection': copy.deepcopy(manifest['roleSourceProjections'][role]), 'sources': {n: v for (n, v) in engine.production_sources(c).items() if n.startswith('apps/' + role + '/') or (role == 'api' and n.startswith('packages/shared/'))}, 'buildProofSha256': plan['buildProofSha256']}
            manifest['images'][role] = {'reference': images[role]['reference'], 'digest': images[role]['imageId'], 'sourceCommit': plan['commit']}
        if engine.RECIPE in (engine.FOLLOWUP, engine.ADDRESS, engine.BOUNDED):
            manifest['previousAdminSourceProjection'] = copy.deepcopy(manifest.get('adminSourceProjection'))
            manifest['adminSourceProjection'] = copy.deepcopy(manifest['roleSourceProjections']['admin'])
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=engine.SCOPE, previousCommit=engine.CURRENT, previousRelease=str(previous), previousManifestSha256=sha(raw_manifest), status='DEPLOYED', servicesUpdated=list(engine.UPDATED), servicesRebound=list(engine.REBOUND), newMigrations=[], migrationPerformed=False, paymentActions=0, bitbrowserHistoryPublication=preservation, compiledArtifactSelection=list(engine.UPDATED))
        artifact = {'url': url, 'sha256': plan['artifactSha256'], 'validationRun': plan['workflowRunId']}
        if 'api' in engine.UPDATED:
            manifest['apiCompiledArtifact'] = artifact
        if 'admin' in engine.UPDATED:
            manifest['adminCompiledArtifact'] = artifact
        (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        d.point_current(target, stamp + '-bitbrowser-history')
        p.release_markers(markers)
        h.guards(d, target, after, c)
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {n: preservation[n] for n in ('status', 'commit', 'tree', 'image', 'workflowRunId', 'businessActions', 'migrationPerformed')}
