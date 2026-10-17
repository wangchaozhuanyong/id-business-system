"""Finite four-feature successor of the accepted API/Admin/engine publisher."""
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
SCOPE = 'ONLINE_PENDING_COPY_CVC_VOICE'
CONTRACT_FILE = 'online-pending-features-contract.json'
WORKFLOW = '.github/workflows/online-pending-features-validation.yml'
SOURCE_BASE = '17591a4e0d02efb55ad2443d586d6b6913895efb'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
SERVICES = (*UPDATED, *PRESERVED)
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
FILES = frozenset(('README.md', 'SOURCE_MANIFEST.json', 'credentials.cjs', 'test/regressions.test.cjs'))
API_MODULES = frozenset('id-business-v2/online-recharge/persistence/' + name + '.js' for name in (
    'admin.repository', 'online-recharge.repository', 'worker.repository', 'recharge-voice-events'))
API_DECLARATIONS = frozenset('id-business-v2/online-recharge/' + name for name in (
    'admin.controller.d.ts', 'admin.service.d.ts', 'order-sync.service.d.ts',
    'persistence/order-sync.repository.d.ts', 'persistence/tasks.repository.d.ts', 'tasks.service.d.ts'))
QUALITY_PARTS = ('guards', 'api', 'admin', 'online-engine')
RECONSTRUCTION_CONTROLS = frozenset((
    'recharge-checkout-build.py', 'recharge-checkout-contract.json', 'recharge-record-build.py',
    'registration-flow-v4-build.py', 'registration-flow-v4-contract.json', 'registration-flow-v4-release.py'))
API_ORDER_ONLY = frozenset(('order-sync.service.d.ts', 'persistence/order-sync.repository.d.ts',
    'persistence/tasks.repository.d.ts', 'tasks.service.d.ts'))
ADMIN_PRELOAD_ORDER = {
    'assets/index-B-cuRus6.js': '6cb6d6e08463bf83696d68f19d49c04c10b1db14bc65229229da0bedc1c10d85',
    'assets/modules-DtbA3XQE.js': 'bd2b9bb0dd6c8fb11b1757c00f44cfbf2b894e725d7cd27188812dcb1e475c62'}
ADMIN_ARTIFACT = {'artifactId': 12098699584,
    'artifactDigest': 'sha256:d60e3aa2940e47324cf389a1ba8b182a92f631c40b3fcbfcbbdd672df5f6c14f',
    'artifactSha256': '0b76039d64798c2a81303fff1f02713d0cc98b93cf0c1e8891ea00cc3daca4d0',
    'proofSha256': '62ed7d268d395aefc34aebf53fa1131f89bf32f5b5511d2a0bdbcaa7bf3e4814'}
NORMALIZATION = {'apiDeclarationOrderOnly': sorted(API_ORDER_ONLY),
    'adminPreloadOrderOnly': ADMIN_PRELOAD_ORDER, 'adminArtifact': ADMIN_ARTIFACT}
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
CONTROLS = frozenset(('online-pending-features-build.py', 'online-pending-features-release.py',
    'online-pending-features-release.test.py', 'online-checkout-build.py', 'online-checkout-release.py',
    'online-checkout-load-release.py',
    'remote-deploy.py', 'recharge-record-release.py', 'recharge-availability-release.py',
    'proxy-result-identity-release.py', 'recharge-source-recovery-release.py', 'shared-bank-card-release.py',
    'api-admin-scope.py', 'registration-closure-dispatch.py'))
APPLICATION = frozenset([
    *['apps/admin/src/v2/features/online-recharge/' + name for name in (
        'OnlineResourceView.vue', 'api.spec.ts', 'api.ts', 'auditPresentation.spec.ts', 'contracts.ts',
        'labels.ts', 'public-api.ts', 'rechargeVoice.spec.ts', 'rechargeVoice.ts', 'sections.ts',
        'useOnlineRechargeVoice.ts')],
    'apps/admin/src/v2/layouts/V2AdminLayout.vue', 'apps/admin/src/v2/styles/v2.css',
    *[ENGINE + '/' + name for name in FILES],
    *['apps/api/src/id-business-v2/online-recharge/persistence/' + name for name in (
        'admin.repository.ts', 'online-recharge.repository.ts', 'recharge-voice-events.spec.ts',
        'recharge-voice-events.ts', 'worker.repository.spec.ts', 'worker.repository.ts')],
    'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md', 'scripts/acceptance-v2-online-recharge-ui.mjs'])
SELECTION_CONTROLS = frozenset((
    'scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs', WORKFLOW,
    *['scripts/production-release/online-pending-features-' + suffix for suffix in
      ('build.py', 'release.py', 'release.test.py', 'contract.json')]))


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_CHECKOUT_PENDING_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('pending_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory_valid(value, *, empty=False):
    return type(value) is dict and (bool(value) or empty) and all(
        type(name) is str and re.fullmatch('[A-Za-z0-9_./-]+', name)
        and not name.startswith('/') and '..' not in Path(name).parts
        and type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest)
        for name, digest in value.items())


def validate_contract(c, *, require_baseline=True):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('reviewBase') == SOURCE_BASE
         and c.get('expectedCurrent') == SOURCE_BASE and c.get('engineRoot') == ENGINE,
         'CONTRACT_IDENTITY_INVALID')
    need(c.get('sourceReviewCommit') == '2bf6d333e4ef28ad9381748cc606315153d83f89', 'REVIEW_COMMIT_CHANGED')
    need(inventory_valid(c.get('sources')) and set(c['sources']) == APPLICATION,
         'SOURCE_SCOPE_CHANGED')
    need(inventory_valid(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
         and c.get('requiredQualityParts') == list(QUALITY_PARTS)
         and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')), 'CONTROL_SCOPE_CHANGED')
    need(inventory_valid(c.get('beforeEngineFiles')) and inventory_valid(c.get('afterEngineFiles'))
         and set(c['beforeEngineFiles']) == set(c['afterEngineFiles'])
         and {name for name, digest in c['afterEngineFiles'].items()
              if c['beforeEngineFiles'].get(name) != digest} == FILES
         and all(c['sources'][ENGINE + '/' + name] == c['afterEngineFiles'][name] for name in FILES),
         'ENGINE_SCOPE_CHANGED')
    need(set(c.get('apiModules', [])) == API_MODULES and len(c['apiModules']) == len(API_MODULES)
         and inventory_valid(c.get('apiDeclarationOnly'))
         and set(c['apiDeclarationOnly']) == API_DECLARATIONS, 'API_SCOPE_CHANGED')
    reconstruction = c.get('reconstruction', {})
    need(reconstruction.get('adminPublishedCommit') == '6da10d2e4bd9de6df145899648e234000f84b72b'
         and reconstruction.get('apiSourceCommit') == SOURCE_BASE
         and inventory_valid(reconstruction.get('pins'))
         and set(reconstruction['pins']) == RECONSTRUCTION_CONTROLS
         and reconstruction.get('normalization') == NORMALIZATION
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0,
         'RECONSTRUCTION_CHANGED')
    b = c.get('baseline')
    if b is None:
        need(not require_baseline, 'BASELINE_NOT_BOUND')
        return
    need(type(b) is dict and b.get('commit') == SOURCE_BASE
         and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', b.get('current', ''))
         and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
         and set(b.get('services', {})) == set(SERVICES)
         and set(b.get('runtimeConfigurationSha256', {})) == set(SERVICES)
         and set(b.get('configurationSha256', {})) == {'.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
         and inventory_valid(b.get('runtimeConfigurationSha256'))
         and inventory_valid(b.get('configurationSha256'))
         and b.get('engineFiles') == c['beforeEngineFiles'] and b.get('engineHealth') == HEALTH,
         'BASELINE_CHANGED')
    need(inventory_valid(b.get('apiOnlineFiles')) and inventory_valid(b.get('adminFiles'))
         and inventory_valid(b.get('adminBuiltFiles'))
         and all(b['adminFiles'].get(name) == digest for name, digest in b['adminBuiltFiles'].items())
         and b['adminBuiltFiles'].get('index.html') == b.get('adminIndexSha256')
         and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', '')),
         'RUNTIME_INVENTORY_CHANGED')
    need(b.get('adminBuildProofSha256') == '62ed7d268d395aefc34aebf53fa1131f89bf32f5b5511d2a0bdbcaa7bf3e4814'
         and b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
         and b.get('backupNormalizerPath', '').startswith('/opt/id-business-v2/releases/')
         and type(b.get('freeBytes')) is int and b['freeBytes'] > 6 * 1024**3,
         'BASELINE_PROOF_CHANGED')
    need(b.get('engineNetworkMode') == 'container:' + b['services']['api'].get('containerId', ''),
         'API_NAMESPACE_CHANGED')


def legacy_contract(c):
    b = c['baseline']
    return {**c, 'current': b['current'], 'manifestSha256': b['manifestSha256'], 'services': b['services'],
        'configurationSha256': b['configurationSha256'],
        'runtimeConfigurationSha256': b['runtimeConfigurationSha256'],
        'beforeApiOnlineFiles': b['apiOnlineFiles'], 'engineHealth': b['engineHealth'],
        'baselineAdminFilesSha256': fingerprint(b['adminBuiltFiles']), 'nginxSha256': b['nginxSha256'],
        'backupNormalizerPath': b['backupNormalizerPath'], 'publishedOverlays': [],
        'sqlFenceHelperSha256': c['controlPins']['api-admin-scope.py']}


def artifact_url(commit):
    return ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
            'online-pending-features-' + commit + '/online-pending-features-artifact.tar.gz')


def validate_quality(evidence, commit, tree):
    load('online-checkout-load-release.py').validate_quality(evidence, commit, tree)


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
         and all(re.fullmatch('[a-f0-9]{40}', plan.get(key, '')) for key in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan.get(key, '')) for key in ('workflowRunId', 'workflowRunAttempt'))
         and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
         and c == json.loads((HERE / CONTRACT_FILE).read_bytes())
         and plan.get('controlSources') == c['controlPins']
         and plan.get('artifactUrl') == artifact_url(plan['commit'])
         and all(re.fullmatch('[a-f0-9]{64}', plan.get(key, '')) for key in ('artifactSha256', 'buildProofSha256')),
         'PLAN_BINDING_CHANGED')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    parts = proof.get('qualityPartEvidence', {})
    quality = proof.get('qualitySourceEvidence', {})
    need(proof.get('baselineAdminFiles') == c['baseline']['adminBuiltFiles']
         and proof.get('beforeApiOnlineFiles') == c['baseline']['apiOnlineFiles']
         and proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence')
         and proof.get('workflow') == WORKFLOW and proof.get('workflowSha256') == c['workflowSha256']
         and proof.get('updatedServices') == list(UPDATED) and proof.get('preservedServices') == list(PRESERVED)
         and proof.get('controlSources') == c['controlPins']
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0
         and parts.get('parts') == list(QUALITY_PARTS) and parts.get('runId') == quality.get('runId')
         and parts.get('runAttempt') == quality.get('runAttempt')
         and parts.get('testedTree') == plan.get('tree') and set(parts.get('jobs', {})) == set(QUALITY_PARTS)
         and all(type(value) is int and value > 0 for value in parts['jobs'].values()),
         'FINITE_PROOF_CHANGED')
    validate_quality(proof.get('qualitySourceEvidence'), plan['commit'], plan['tree'])
    reproduction = proof.get('baselineReproduction', {})
    need(set(reproduction) == {'api', 'admin', 'adminArtifact', 'candidateDeclarations'}
         and set(reproduction['api']) <= API_ORDER_ONLY
         and set(reproduction['admin']) <= set(ADMIN_PRELOAD_ORDER)
         and set(reproduction['candidateDeclarations']) <= API_ORDER_ONLY
         and reproduction['adminArtifact'] == (ADMIN_ARTIFACT if reproduction['admin'] else None),
         'REPRODUCTION_SCOPE_CHANGED')
    for group in ('api', 'admin', 'candidateDeclarations'):
        for name, row in reproduction[group].items():
            target = (c['baseline']['adminBuiltFiles'][name] if group == 'admin'
                else c['apiDeclarationOnly']['id-business-v2/online-recharge/' + name]
                if group == 'candidateDeclarations' else c['baseline']['apiOnlineFiles'][name])
            need(set(row) == {'rebuiltSha256', 'publishedSha256'}
                 and re.fullmatch('[a-f0-9]{64}', row.get('rebuiltSha256', ''))
                 and row.get('publishedSha256') == target, 'REPRODUCTION_BINDING_CHANGED')
    p = load('online-checkout-release.py')
    p.SCOPE = SCOPE
    p.verify_proof(proof, plan, legacy_contract(c), files)


def safe_archive(raw, path):
    return load('shared-bank-card-release.py').safe_archive(raw, path)


def download_artifact(plan):
    need(plan.get('artifactUrl') == artifact_url(plan['commit']), 'ARTIFACT_LOCATION_INVALID')
    with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    need(0 < len(raw) <= 24 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
    return raw


def verify_runtime_inventory(d, states, c, proof=None):
    h = load('recharge-record-release.py')
    def inventory(container, root):
        # Hashes only; no source, credentials or data leave the container.
        code = "const fs=require('fs'),p=require('path'),c=require('crypto'),r=process.argv[1],o={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const n=p.join(d,e.name);if(p.relative(r,n).split(p.sep)[0]==='engine')continue;if(e.isSymbolicLink())throw Error('SYMLINK');if(e.isDirectory())walk(n);else if(e.isFile())o[p.relative(r,n)]=c.createHash('sha256').update(fs.readFileSync(n)).digest('hex')}}walk(r);console.log(JSON.stringify(o))"
        return json.loads(d.run('docker', 'exec', container, 'node', '-e', code, root, timeout=60))
    # Nginx images need not contain Node; use the accepted hash reader for the
    # complete frozen union, and bind its exact member list with find.
    expected_admin = {**c['baseline']['adminFiles'], **(proof['adminFiles'] if proof else {})}
    load('online-checkout-release.py').read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', expected_admin)
    names = d.run('docker', 'exec', states['admin']['containerId'], 'find', '/usr/share/nginx/html', '-type', 'f', timeout=30).splitlines()
    need(set(name.removeprefix('/usr/share/nginx/html/') for name in names) == set(expected_admin), 'ADMIN_INVENTORY_CHANGED')
    actual_api = inventory(states['api']['containerId'], '/app/apps/api/dist/id-business-v2/online-recharge')
    actual_api = {name: digest for name, digest in actual_api.items() if not name.startswith('engine/')}
    expected_api = {**c['baseline']['apiOnlineFiles'], **({name.removeprefix('id-business-v2/online-recharge/'): digest
        for name, digest in proof['apiModules'].items()} if proof else {})}
    need(actual_api == expected_api, 'API_INVENTORY_CHANGED')
    metadata = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
    need(metadata['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'API_NAMESPACE_CHANGED')
    need(shutil.disk_usage(BASE).free > 6 * 1024**3, 'DISK_LOW')


def release(plan, c):
    validate_plan(plan, c)
    p = load('online-checkout-release.py')
    p.SCOPE, p.CONTRACT_FILE = SCOPE, CONTRACT_FILE
    p.download_artifact = download_artifact
    original_baseline, original_smoke = p.baseline, p.smoke
    p.verify_proof = lambda proof, selected, _legacy, files: verify_proof(proof, selected, c, files)
    def baseline(d, _legacy, h):
        value = original_baseline(d, legacy_contract(c), h)
        verify_runtime_inventory(d, value[2], c)
        return value
    def smoke(d, target, states, proof, _legacy, h):
        verify_proof(proof, plan, c, proof['files'])
        need(all(not (target / name).is_symlink() and sha((target / name).read_bytes()) == digest
                 for name, digest in c['sources'].items()), 'HOST_SOURCE_CHANGED')
        need(sha((target / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
             and all(not (target / 'scripts/production-release' / name).is_symlink()
                     and sha((target / 'scripts/production-release' / name).read_bytes()) == digest
                     for name, digest in c['controlPins'].items()), 'READBACK_CONTROL_CHANGED')
        original_smoke(d, target, states, proof, legacy_contract(c), h)
        verify_runtime_inventory(d, states, c, proof)
    p.baseline, p.smoke = baseline, smoke
    result = p.release(plan, legacy_contract(c))
    if plan['mode'] != 'preflight':
        result['updatedServices'] = list(UPDATED)
    return result
