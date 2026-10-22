"""Finite API/admin/ONLINE successor; keeps the existing release lock and SQL fence."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import traceback
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'ONLINE_HUMAN_VERIFICATION_20261022'
RECIPE = 'online-human-verification-20261022'
CONTRACT_FILE = 'online-human-verification-contract.json'
CURRENT = 'f2b092ba034d18cfe4fbea6b997ffc46bfb6f99b'
SOURCE = '4b89b347fdff737cb1267c4c3f523a8c67316ede'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
API = frozenset('apps/api/src/id-business-v2/online-recharge/' + n + '.ts' for n in (
    'admin.controller', 'human-verification.service', 'online-recharge.module',
    'persistence/worker-rpc.repository', 'persistence/worker.repository'))
ADMIN = frozenset('apps/admin/src/v2/features/online-recharge/' + n for n in (
    'OnlineHumanVerification.vue', 'OnlineResultDialog.vue', 'api.ts', 'labels.ts', 'online-recharge.css'))
ENGINE_NAMES = frozenset(('SOURCE_MANIFEST.json', 'human-verification.cjs', 'upstream/index.js',
    'upstream/session-auth.js', 'test/human-verification.test.cjs', 'test/checkout-navigation.test.cjs', 'test/recharge-flow-acceptance.test.cjs'))
SOURCES = API | ADMIN | frozenset(ENGINE + n for n in ENGINE_NAMES)
MODULES = frozenset(n.removeprefix('apps/api/src/').removesuffix('.ts') + suffix
                    for n in API for suffix in ('.js', '.js.map', '.d.ts'))
ABSENT = frozenset('id-business-v2/online-recharge/human-verification.service' + suffix
                   for suffix in ('.js', '.js.map', '.d.ts'))
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_HUMAN_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('human_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def failure_report(error, plan):
    code = str(error)
    if not re.fullmatch(r'(?:ONLINE_HUMAN|ONLINE_EXECUTION|SETTLED_CHECKOUT|BITBROWSER_HISTORY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK|PROXY_RESULT_IDENTITY)_[A-Z0-9_]{1,100}', code):
        code = 'ONLINE_HUMAN_REMOTE_FAILED'
    frames = [{'file': Path(f.filename).name, 'function': f.name, 'line': f.lineno}
              for f in traceback.extract_tb(error.__traceback__)
              if Path(f.filename).name in plan['controlSources']]
    return {'status': 'FAILED', 'code': code, 'exceptionType': type(error).__name__,
            'mode': plan['mode'], 'frames': frames[-8:], 'businessActions': 0}


def validate_contract(c):
    need(c.get('version') == 1 and c.get('status') == 'FROZEN' and c.get('scope') == SCOPE
         and c.get('recipe') == RECIPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 676, 'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES and len(c.get('validationSources', {})) == 11
         and c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('reboundServices') == [] and c.get('businessActions') == 0
         and c.get('migrationPerformed') is False, 'FINITE_SCOPE')
    parent = c.get('parentPlan', {})
    need(parent.get('commit') == CURRENT and parent.get('workflowRunId') == '39726132608'
         and parent.get('buildProofSha256') == 'ceb809fb43fd5872755f9af738d0932711b2f30e67336eee7c18078b7d00cc32'
         and parent.get('contractSha256') == 'a43f983ff3a29d49e29ec34ee94aa654f4670d65f0d7c9d1b51f0e86f58bd3a5', 'PARENT_IDENTITY')
    need(c['controlPins'].get('online-execution-contract.json') == parent['contractSha256']
         and all(c['controlPins'].get(n) == v for n, v in parent['controlSources'].items())
         and c.get('sqlFenceHelperSha256') == c['controlPins'].get('api-admin-scope.py')
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_CONTROLS_CHANGED')
    need(sha(canonical(c.get('nativeParentApiModules'))) == 'ae4119cb747956559eb48c60fe12161b5a79dfb759851f1610f6c86b0dfbbcb5', 'NATIVE_PARENT_MODULES_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for group in ('productionSources', 'validationSources', 'controlPins')
             for v in c[group].values()), 'HASH_INVALID')


def verify_quality(value, commit):
    need(set(value) == {'sources', 'release'} and value['sources'].get('reviewedBusinessCommit') == SOURCE and re.fullmatch('[a-f0-9]{40}', value['sources'].get('commit', ''))
         and value['sources']['pullRequest'] == 676 and value['release']['commit'] == commit
         and re.fullmatch('[a-f0-9]{64}', value['sources']['sourceReceiptSha256'])
         and all(re.fullmatch('[1-9][0-9]*', str(v['runId'])) for v in value.values()), 'QUALITY_REQUIRED')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(k) == plan.get(k) for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
         'contractSha256', 'qualityVerification', 'nativeParentCapture'))
         and proof.get('scope') == SCOPE and proof.get('recipe') == RECIPE
         and proof.get('productionSources') == c['productionSources'] and proof.get('controlSources') == c['controlPins']
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False
         and proof.get('baselineSharedUnchanged') is True and proof.get('baselineClientUnchanged') is True,
         'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualityVerification'], proof['commit'])
    parent = proof['nativeParentCapture']
    need(parent.get('status') == 'ONLINE_HUMAN_PARENT_VERIFIED' and parent.get('commit') == CURRENT
         and set(proof.get('apiModules', {})) == MODULES and len(proof.get('adminFiles', {})) >= 250
         and proof.get('parentNativeModules') == parent['baseline']['apiModules'], 'BUILD_SCOPE_CHANGED')
    verify_parent_modules(proof['parentModulesReproduced'], parent['baseline']['apiModules'])
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
                **{'online-recharge/source/' + n.removeprefix(ENGINE): v for n, v in c['productionSources'].items() if n.startswith(ENGINE)},
                **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def verify_parent_modules(local, native):
    expected = json.loads((HERE / CONTRACT_FILE).read_bytes())['nativeParentApiModules']
    need(set(native) == MODULES - ABSENT and local == native == expected, 'PARENT_COMPILE_CHANGED')


def capture(c):
    prior = load('online-execution-release.py')
    result = prior.release({**c['parentPlan'], 'mode': 'readback'}, json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(result['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    p = engine(c, {})
    h, d, _ = p.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    need(json.loads(raw).get('commit') == CURRENT and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    normalizer = c['parentPlan']['nativeParentCapture']['baseline']['backupNormalizerPath']
    admin_files = load('recharge-checkout-release.py').admin_inventory(d, states['admin'])
    ancestor = c['parentPlan']['nativeParentCapture']['baseline']
    admin_proof_raw = (Path(ancestor['current']) / 'bitbrowser-history-build-proof.json').read_bytes()
    need(sha(admin_proof_raw) == ancestor['proofs']['bitbrowser-history-build-proof.json'], 'ADMIN_PARENT_PROOF_CHANGED')
    published_admin = json.loads(admin_proof_raw)['adminFiles']
    need(all(admin_files.get(n) == v for n, v in published_admin.items()), 'ADMIN_PARENT_CONTENT_CHANGED')
    capture_path = HERE / 'online-human-parent-admin-files.json'
    capture_raw = canonical(admin_files)
    if capture_path.exists():
        need(not capture_path.is_symlink() and capture_path.read_bytes() == capture_raw, 'ADMIN_CAPTURE_CHANGED')
    else:
        with capture_path.open('xb') as output:
            output.write(capture_raw)
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in p.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
        'proofs': {'bitbrowser-history-build-proof.json': c['parentPlan']['buildProofSha256']},
        **p.runtime(d, states), 'database': p.database(d, states['api']),
        'adminPublishedInventory': {'count': len(published_admin), 'sha256': sha(canonical(published_admin))},
        'backupNormalizerPath': normalizer, 'backupNormalizerSha256': sha(Path(normalizer).read_bytes())}
    need(set(baseline['apiModules']) == MODULES - ABSENT and baseline['database']['pending'] == 0
         and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    return {'status': 'ONLINE_HUMAN_PARENT_VERIFIED', 'commit': CURRENT, 'baseline': baseline, 'businessActions': 0}


def verify_parent_admin_files(files, baseline):
    need(type(files) is dict and {'count': len(files), 'sha256': sha(canonical(files))} == baseline['adminInventory'], 'ADMIN_CAPTURE_CHANGED')
    return files


def project_manifest(manifest, c):
    need(manifest['scope'] == SCOPE, 'MANIFEST_SCOPE_CHANGED')
    for role, selected in (('api', API), ('admin', ADMIN), ('online-recharge', {ENGINE + n for n in ENGINE_NAMES})):
        manifest['roleSourceProjections'][role]['sources'] = {n: c['productionSources'][n] for n in selected}
    manifest['previousAdminSourceProjection'] = copy.deepcopy(manifest.get('adminSourceProjection'))
    manifest['adminSourceProjection'] = copy.deepcopy(manifest['roleSourceProjections']['admin'])
    manifest['onlineHumanVerificationPublication'] = manifest['bitbrowserHistoryPublication']
    manifest['onlineRechargeCompiledArtifact'] = manifest['apiCompiledArtifact']
    return manifest


def engine(c, plan):
    p = load('bitbrowser-history-release.py')
    p.SCOPE, p.RECIPE, p.CURRENT, p.CONTRACT_FILE = SCOPE, RECIPE, CURRENT, CONTRACT_FILE
    p.MODULES, p.UPDATED, p.REBOUND, p.PRESERVED = MODULES, UPDATED, (), PRESERVED
    p.ARTIFACT_LIMIT = 16 * 1024**2
    p.validate_contract, p.verify_proof = validate_contract, verify_proof
    p.production_sources = lambda selected: selected['productionSources']
    original_helpers, original_baseline, original_runtime = p.helpers, p.baseline, p.runtime

    def runtime(d, states, modules=None):
        # Only the three explicitly absent new-service outputs may be missing.
        old = p.RECIPE
        p.RECIPE = p.BOUNDED
        try:
            value = original_runtime(d, states, modules)
        finally:
            p.RECIPE = old
        need(set(value['apiModules']) in (MODULES, MODULES - ABSENT), 'API_MODULE_ABSENCE_CHANGED')
        return value

    def helpers():
        h, d, retired = original_helpers()
        original_build, original_point = h.build_image, d.point_current
        def build(driver, context, reference, role, before, stage):
            need(role in UPDATED, 'IMAGE_SCOPE')
            if role == 'online-recharge':
                dockerfile = context / 'Dockerfile'
                text = dockerfile.read_text()
                need(text.count('COPY html/ /usr/share/nginx/html/') == 1, 'ENGINE_COPY_CHANGED')
                dockerfile.write_text(text.replace('COPY html/ /usr/share/nginx/html/', 'COPY source/ /workspace/engine/'))
            original_build(driver, context, reference, role, before, stage)
        def point(target, stamp):
            path = target / 'release-manifest.json'
            manifest = project_manifest(json.loads(path.read_bytes()), c)
            path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            original_point(target, stamp)
        h.build_image, d.point_current = build, point
        return h, d, retired

    def baseline(d, h, selected, expected=None):
        need(plan['nativeParentCapture']['status'] == 'ONLINE_HUMAN_PARENT_VERIFIED'
             and plan['nativeParentCapture']['commit'] == CURRENT, 'CAPTURE_CHANGED')
        selected['baseline'] = plan['nativeParentCapture']['baseline']
        return original_baseline(d, h, selected, expected)

    def smoke(d, h, retired, target, states, selected, proof, _before_admin=None):
        b = plan['nativeParentCapture']['baseline']
        selected['baseline'] = b
        need(all(states[n] == b['services'][n] for n in PRESERVED)
             and all(states[n]['environmentSha256'] == b['services'][n]['environmentSha256'] for n in UPDATED)
             and {n: h.configuration(d, s) for n, s in states.items()} == b['runtimeConfigurationSha256'], 'SERVICE_SCOPE_CHANGED')
        expected = {n: b[n] for n in ('apiPreservedInventory', 'sharedInventory', 'clientInventory', 'nginxSha256')}
        expected.update(apiModules=proof['apiModules'])
        original_admin = verify_parent_admin_files(json.loads((HERE / 'online-human-parent-admin-files.json').read_bytes()), b)
        merged = {**original_admin, **proof['adminFiles']}
        expected['adminInventory'] = {'count': len(merged), 'sha256': sha(canonical(merged))}
        need(runtime(d, states) == expected and p.database(d, states['api']) == b['database'], 'RUNTIME_CONTENT_CHANGED')
        with urllib.request.urlopen(urllib.request.Request('https://54-249-61-238.sslip.io/', headers={'Cache-Control': 'no-cache'}), timeout=25) as response:
            public = response.read(2 * 1024**2 + 1)
        need(sha(public) == proof['adminFiles']['index.html'] and ('v2-' + proof['commit']).encode() in public, 'PUBLIC_BUILD_CHANGED')
        prior = json.loads((HERE / 'online-execution-contract.json').read_bytes())
        files = {**prior['beforeEngineFiles'], **{n.removeprefix(ENGINE): v for n, v in prior['productionSources'].items() if n.startswith(ENGINE)},
                 **{n.removeprefix(ENGINE): v for n, v in c['productionSources'].items() if n.startswith(ENGINE)}}
        load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], files)
        original = json.loads((Path(b['current']) / 'compose.release.json').read_bytes())
        selected_config = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            selected_config['services'][role]['image'] = original['services'][role]['image']
        need(selected_config == original and all(sha((target / n).read_bytes()) == b['configurationSha256'][n]
             for n in p.CONFIGURATION if n != 'compose.release.json'), 'CONFIGURATION_CHANGED')
        row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
        need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
        need(all(not (target / n).is_symlink() and sha((target / n).read_bytes()) == digest
             for n, digest in c['productionSources'].items()), 'HOST_SOURCE_CHANGED')
        retired.verify_retired_runtime(d, states)
        h.engine_idle(d, states['online-recharge'], selected, wait_connected=True)

    p.helpers, p.baseline, p.smoke, p.runtime = helpers, baseline, smoke, runtime
    return p


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, c)
