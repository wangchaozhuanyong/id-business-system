"""Finite network-query overlay; reuse the accepted three-role switch controller."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'ONLINE_QUERY_NETWORK_REPAIR'
SOURCE_BASE = 'b8c37f1262a42398a43a1acd3ff4504d17c1bed8'
REVIEW_BASE = '320b5281b27b1e5c0fda1b6abfcbe87f16ff9dde'
CONTRACT_FILE = 'online-query-network-contract.json'
WORKFLOW = '.github/workflows/online-query-network-validation.yml'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration')
SERVICES = (*UPDATED, *PRESERVED)
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
FILES = frozenset(('SOURCE_MANIFEST.json', 'task-runner.cjs', 'upstream/subscription-check.js',
    'test/dispatch.test.cjs', 'test/query-network-browser.test.cjs'))
ADDED = frozenset(('test/query-network-browser.test.cjs',))
API_MODULES = frozenset('id-business-v2/online-recharge/' + name + '.js'
    for name in ('tasks.service', 'validation', 'persistence/tasks.repository'))
APPLICATION = frozenset((
    *['apps/admin/src/v2/features/online-recharge/' + name for name in
      ('OnlineActionDrawer.vue', 'OnlineActionDrawer.spec.ts', 'OnlineResultDialog.vue',
       'api.spec.ts', 'auditPresentation.spec.ts', 'sections.ts')],
    *['apps/api/src/id-business-v2/online-recharge/' + name for name in
      ('tasks.service.ts', 'validation.ts', 'persistence/tasks.repository.ts', 'query-transport-mode.spec.ts')],
    *[ENGINE + '/' + name for name in FILES], 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'))
QUALITY_PARTS = ('guards', 'api', 'admin', 'online-engine')
SCOPE_CONTROLS = frozenset(('scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.test.mjs'))
RECONSTRUCTION_FILES = frozenset(('online-session-preflight-build.py', 'online-session-preflight-release.py',
    'online-session-preflight-contract.json', 'online-pending-features-build.py',
    'online-pending-features-release.py', 'online-pending-features-contract.json',
    'recharge-checkout-build.py', 'recharge-checkout-contract.json', 'recharge-record-build.py',
    'registration-flow-v4-build.py', 'registration-flow-v4-contract.json', 'registration-flow-v4-release.py',
    'registration-closure-dispatch.py'))
CONTROLS = frozenset(('online-query-network-build.py', 'online-query-network-release.py',
    'online-query-network-release.test.py', 'online-checkout-build.py', 'online-checkout-release.py', 'online-checkout-load-release.py',
    'online-pending-features-release.py',
    'remote-deploy.py', 'recharge-record-release.py', 'recharge-availability-release.py',
    'proxy-result-identity-release.py', 'recharge-source-recovery-release.py', 'shared-bank-card-release.py',
    'api-admin-scope.py'))
PUBLIC_CONTROLS = frozenset((WORKFLOW, *SCOPE_CONTROLS, *['scripts/production-release/online-query-network-' +
    suffix for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json')]))
PREDECESSOR_PROOF = '3c2fc9c546614f04448e86389d9c4b7bd0430170f955c1bd8f95f984869a137b'
PREDECESSOR_ADMIN_FILES = 'f536c43416056ddde289e80fcdf1c3215834fe2e63f9218b146daba7928f637b'
PREDECESSOR_API_FILES = 'c9c1ce71933b48d200ff4fd5afcb14bcd99f7194b09191fe453654a93a5dc766'
PREDECESSOR_ENGINE_FILES = 'b4a5e4540f33d2714704713f6372556df7651ea67b8a2efe9ad1383a63a1e427'
HISTORICAL_CONTROLS_TREE = '639abbd4474211a1219406e9a3ef5667c44a4e81'
PREDECESSOR_IMAGES = {
    'admin': 'sha256:7822cd48f03a4d2ae1d6cfdf1ce5b7f6e0c4e304ddcfabb3cbba01f340fa6975',
    'api': 'sha256:6f8842763065a5b9bfee7e39e6966d27224f2b56c9e689bfd2f6011ca45026ce',
    'online-recharge': 'sha256:def4b82d0bc092356d67ec4ad098623ca7902bd6913375c34a12ab10bf205697'}
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}


def need(ok, code):
    if not ok:
        raise RuntimeError('ONLINE_QUERY_NETWORK_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    spec = importlib.util.spec_from_file_location('query_network_' + name.replace('-', '_'), HERE / name)
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
    need(c.get('version') == 1 and c.get('scope') == SCOPE
        and c.get('reviewBase') == REVIEW_BASE and c.get('expectedCurrent') == SOURCE_BASE
        and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('sourceReviewTag') == 'online-query-network-source-review-' + c['sourceReviewCommit'][:12]
        and c.get('engineRoot') == ENGINE and c.get('requiredQualityParts') == list(QUALITY_PARTS)
        and c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
        and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
        and c['businessActions'] == 0, 'CONTRACT_IDENTITY_INVALID')
    need(inventory_valid(c.get('sources')) and set(c['sources']) == APPLICATION
        and inventory_valid(c.get('reviewedControlSources')) and set(c['reviewedControlSources']) == SCOPE_CONTROLS
        and inventory_valid(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')), 'SOURCE_SCOPE_CHANGED')
    before, after = c.get('beforeEngineFiles'), c.get('afterEngineFiles')
    need(inventory_valid(before) and inventory_valid(after) and set(after) == set(before) | ADDED
        and fingerprint(before) == PREDECESSOR_ENGINE_FILES
        and not set(before) & ADDED and {name for name in after if before.get(name) != after[name]} == FILES
        and all(c['sources'][ENGINE + '/' + name] == after[name] for name in FILES), 'ENGINE_SCOPE_CHANGED')
    need(set(c.get('apiModules', [])) == API_MODULES and len(c['apiModules']) == len(API_MODULES)
        and c.get('apiDeclarationOnly') == {}, 'API_SCOPE_CHANGED')
    r = c.get('reconstruction', {})
    need(r.get('predecessorProofSha256') == PREDECESSOR_PROOF and r.get('publishedAdminCommit') == SOURCE_BASE
        and r.get('historicalControlsTree') == HISTORICAL_CONTROLS_TREE
        and r.get('apiSourceCommit') == '17591a4e0d02efb55ad2443d586d6b6913895efb'
        and r.get('apiOverlayReview') == 'a1e65b996b0c527a562a14c470b5c7650a00bd25'
        and inventory_valid(r.get('pins')) and set(r['pins']) == RECONSTRUCTION_FILES
        and inventory_valid(r.get('publishedAdminSources')) and inventory_valid(r.get('publishedAdminFiles'))
        and len(r['publishedAdminFiles']) == 262 and fingerprint(r['publishedAdminFiles']) == PREDECESSOR_ADMIN_FILES,
        'RECONSTRUCTION_CHANGED')
    b = c.get('baseline')
    if b is None:
        need(not require_baseline, 'BASELINE_NOT_BOUND')
        return
    need(type(b) is dict and b.get('commit') == SOURCE_BASE
        and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', b.get('current', ''))
        and re.fullmatch('[a-f0-9]{64}', b.get('manifestSha256', ''))
        and set(b.get('services', {})) == set(SERVICES)
        and all(b['services'][role].get('image') == digest for role, digest in PREDECESSOR_IMAGES.items())
        and inventory_valid(b.get('runtimeConfigurationSha256')) and set(b['runtimeConfigurationSha256']) == set(SERVICES)
        and inventory_valid(b.get('configurationSha256')) and set(b['configurationSha256']) ==
          {'.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
        and inventory_valid(b.get('apiOnlineFiles')) and fingerprint(b['apiOnlineFiles']) == PREDECESSOR_API_FILES
        and inventory_valid(b.get('adminFiles'))
        and b.get('engineFiles') == before and b.get('engineHealth') == HEALTH
        and all(b['adminFiles'].get(name) == digest for name, digest in r['publishedAdminFiles'].items())
        and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', ''))
        and b.get('backupNormalizerSha256') == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
        and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+/scripts/mysql-dump-restore-normalizer.sed',
                        b.get('backupNormalizerPath', '')), 'BASELINE_CHANGED')


def legacy_contract(c):
    b = c['baseline']
    return {**c, 'current': b['current'], 'manifestSha256': b['manifestSha256'], 'services': b['services'],
        'configurationSha256': b['configurationSha256'], 'runtimeConfigurationSha256': b['runtimeConfigurationSha256'],
        'beforeApiOnlineFiles': b['apiOnlineFiles'], 'engineHealth': b['engineHealth'],
        'baselineAdminFilesSha256': fingerprint(c['reconstruction']['publishedAdminFiles']), 'nginxSha256': b['nginxSha256'],
        'backupNormalizerPath': b['backupNormalizerPath'], 'publishedOverlays': [],
        'sqlFenceHelperSha256': c['controlPins']['api-admin-scope.py']}


def artifact_url(commit):
    return ('https://github.com/wangchaozhuanyong/id-business-system/releases/download/'
        'online-query-network-' + commit + '/online-query-network-artifact.tar.gz')


def validate_quality(evidence, commit, tree):
    load('online-checkout-load-release.py').validate_quality(evidence, commit, tree)


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
        and all(re.fullmatch('[a-f0-9]{40}', plan.get(key, '')) for key in ('commit', 'tree'))
        and all(re.fullmatch('[1-9][0-9]*', plan.get(key, '')) for key in ('workflowRunId', 'workflowRunAttempt'))
        and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
        and c == json.loads((HERE / CONTRACT_FILE).read_bytes())
        and plan.get('controlSources') == c['controlPins'] and plan.get('artifactUrl') == artifact_url(plan['commit'])
        and all(re.fullmatch('[a-f0-9]{64}', plan.get(key, '')) for key in ('artifactSha256', 'buildProofSha256')),
        'PLAN_BINDING_CHANGED')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    parts, quality = proof.get('qualityPartEvidence', {}), proof.get('qualitySourceEvidence', {})
    need(type(proof.get('businessActions')) is int and proof['businessActions'] == 0
        and proof.get('controlSources') == c['controlPins']
        and inventory_valid(proof.get('adminFiles')) and inventory_valid(proof.get('apiModules'))
        and inventory_valid(files) and proof.get('baselineAdminFiles') == c['reconstruction']['publishedAdminFiles']
        and proof.get('beforeApiOnlineFiles') == c['baseline']['apiOnlineFiles']
        and proof.get('workflow') == WORKFLOW and proof.get('workflowSha256') == c['workflowSha256']
        and proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence')
        and proof.get('updatedServices') == list(UPDATED) and proof.get('preservedServices') == list(PRESERVED)
        and parts.get('parts') == list(QUALITY_PARTS) and parts.get('runId') == quality.get('runId')
        and parts.get('runAttempt') == quality.get('runAttempt') and parts.get('testedTree') == plan.get('tree')
        and set(parts.get('jobs', {})) == set(QUALITY_PARTS)
        and all(type(value) is int and value > 0 for value in parts['jobs'].values()), 'FINITE_PROOF_CHANGED')
    validate_quality(quality, plan['commit'], plan['tree'])
    p = load('online-checkout-release.py')
    p.SCOPE = SCOPE
    p.verify_proof(proof, plan, legacy_contract(c), files)


def download_artifact(plan):
    need(plan.get('artifactUrl') == artifact_url(plan['commit']), 'ARTIFACT_LOCATION_INVALID')
    with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
        raw = response.read(24 * 1024**2 + 1)
    need(0 < len(raw) <= 24 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
    return raw


def verify_runtime_inventory(d, states, c, proof=None):
    p = load('online-pending-features-release.py')
    expected = {**c, 'baseline': {**c['baseline'], 'adminBuiltFiles': c['reconstruction']['publishedAdminFiles']}}
    p.verify_runtime_inventory(d, states, expected, proof)


def verify_host(d, target, states, proof, c, h):
    need(all((target / name).is_file() and not (target / name).is_symlink() and sha((target / name).read_bytes()) == digest
        for name, digest in c['sources'].items()), 'HOST_SOURCE_CHANGED')
    need(sha((target / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == sha((HERE / CONTRACT_FILE).read_bytes())
        and all(not (target / 'scripts/production-release' / name).is_symlink()
            and sha((target / 'scripts/production-release' / name).read_bytes()) == digest
            for name, digest in c['controlPins'].items()), 'READBACK_CONTROL_CHANGED')
    b = c['baseline']
    need(all(sha((target / name).read_bytes()) == digest for name, digest in b['configurationSha256'].items()
        if name != 'compose.release.json'), 'HOST_CONFIGURATION_CHANGED')
    expected = json.loads((Path(b['current']) / 'compose.release.json').read_bytes())
    for role in UPDATED:
        expected['services'][role]['image'] = states[role]['reference']
    need(json.loads((target / 'compose.release.json').read_bytes()) == expected, 'OVERRIDE_SCOPE_CHANGED')


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
        original_smoke(d, target, states, proof, legacy_contract(c), h)
        verify_runtime_inventory(d, states, c, proof)
        verify_host(d, target, states, proof, c, h)

    p.baseline, p.smoke = baseline, smoke
    result = p.release(plan, legacy_contract(c))
    result['status'] = result['status'].replace('ONLINE_CHECKOUT_', 'ONLINE_QUERY_NETWORK_')
    result.update(updatedServices=list(UPDATED), preservedServices=list(PRESERVED), migrationPerformed=False, businessActions=0)
    return result
