"""Finite ONLINE execution successor using the existing lock, backup and SQL fence."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import traceback

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'ONLINE_EXECUTION_REPAIR_20261022'
RECIPE = 'online-execution-20261022'
CONTRACT_FILE = 'online-execution-contract.json'
SOURCE = 'be11287feb7c2494fc41c9de071fdff9e06563d2'
CURRENT = 'd7d80c357c4954ef28db85e1021a0e19a65ebd81'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
WORKER = 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts'
MODULES = frozenset('id-business-v2/online-recharge/persistence/worker.repository' + suffix
                    for suffix in ('.js', '.js.map', '.d.ts'))
ENGINE_FILES = frozenset(('SOURCE_MANIFEST.json', 'rpc.cjs', 'safe-media.cjs', 'worker.cjs',
    *('upstream/' + n + '.js' for n in ('auth-page-detect', 'browser-pool', 'chatgpt',
        'human-verification', 'index', 'session-auth', 'verification-runtime')),
    *('test/' + n + '.test.cjs' for n in ('checkout-navigation', 'evidence-recovery',
        'execution-budget', 'proxy-worker', 'recharge-flow-acceptance', 'worker-heartbeat'))))
SOURCES = frozenset((WORKER, *(ENGINE + n for n in ENGINE_FILES)))
VALIDATION = frozenset((WORKER.replace('.ts', '.spec.ts'), 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'))
DECLARATION = 'id-business-v2/online-recharge/persistence/worker.repository.d.ts'
LOCAL_DECLARATION = '22bf2373b72952d93c4a7387eadcd5cecd96eb57ce96159e24f49a2aa399d8d2'
NATIVE_DECLARATION = '37bd54208430a2c090e8bafd99f352cac7dfceb0d9ec83998f666dd812109246'
UPDATED = ('api', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
HEALTH = {'activeTasks': 0, 'mode': 'enabled', 'ready': True, 'rpcConnected': True, 'stopping': False}
SOURCE_MERGE = 'ab438aac86cb5fd34efd13db4e1260ac15d3f448'
SOURCE_HEAD = 'c9c6d3f6b744b55101ae15cd95975359740c7ead'
SOURCE_RUN = '39722667668'
CONTROL_PATHS = frozenset(('.github/workflows/online-execution-publication.yml',
    'scripts/ci-online-settings-scope.mjs', 'scripts/ci-online-settings-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs', *('scripts/production-release/online-execution-' + n
    for n in ('release.py', 'publication.py', 'release.test.py', 'contract.json'))))


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_EXECUTION_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def failure_report(error, plan):
    # Never export exception messages, local absolute paths, command arguments or locals.
    code = str(error)
    if not re.fullmatch(r'(?:ONLINE_EXECUTION|SETTLED_CHECKOUT|BITBROWSER_HISTORY|RECHARGE_CHECKOUT|RECHARGE_RECORD|RECHARGE_AVAILABILITY|ONLINE_QUERY_NETWORK|PROXY_RESULT_IDENTITY)_[A-Z0-9_]{1,100}', code):
        code = 'ONLINE_EXECUTION_REMOTE_FAILED'
    frames = []
    for frame in traceback.extract_tb(error.__traceback__):
        name = Path(frame.filename).name
        if name in plan['controlSources'] and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', frame.name):
            frames.append({'file': name, 'function': frame.name, 'line': frame.lineno})
    return {'status': 'FAILED', 'code': code, 'mode': plan['mode'], 'businessActions': 0,
            'exceptionType': type(error).__name__, 'frames': frames[-8:]}


def load(name):
    spec = importlib.util.spec_from_file_location('execution_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('status') == 'FROZEN'
         and c.get('recipe') == RECIPE and c.get('sourceReviewCommit') == SOURCE
         and c.get('expectedCurrent') == CURRENT and c.get('migrationPerformed') is False
         and c.get('businessActions') == 0, 'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES and set(c.get('validationSources', {})) == VALIDATION
         and set(c.get('apiModules', [])) == MODULES and c.get('updatedServices') == list(UPDATED)
         and c.get('preservedServices') == list(PRESERVED) and c.get('reboundServices') == []
         and c.get('engineHealth') == HEALTH, 'FINITE_SCOPE')
    need(c.get('parentPlan', {}).get('commit') == CURRENT
         and c['parentPlan'].get('workflowRunId') == '39603988497'
         and c['parentPlan'].get('buildProofSha256') == '9c436cd452cacc54e96964830acceb56f816539147acf766fe7ce866211eda55'
         and c.get('sqlFenceHelperSha256') == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925'
         and c['controlPins'].get('api-admin-scope.py') == c['sqlFenceHelperSha256'], 'PARENT_IDENTITY')
    need(all(re.fullmatch('[a-f0-9]{64}', value) for group in ('productionSources', 'validationSources',
         'controlPins', 'beforeEngineFiles') for value in c[group].values()), 'HASH_INVALID')
    need(c['controlPins'].get('settled-checkout-contract.json') == c['parentPlan']['contractSha256'],
         'PARENT_CONTRACT_REQUIRED')
    inherited = json.loads((HERE / 'settled-checkout-contract.json').read_bytes())
    need(all(c['controlPins'].get(n) == v for n, v in inherited['controlPins'].items()), 'PARENT_CONTROLS_CHANGED')
    first = json.loads((HERE / 'online-checkout-first-open-contract.json').read_bytes())
    need(c['beforeEngineFiles'] == first['afterEngineFiles'], 'ENGINE_PARENT_CHANGED')
    expected_native = {'id-business-v2/online-recharge/' + n: digest
                       for n, digest in first['baseline']['apiOnlineFiles'].items()
                       if 'id-business-v2/online-recharge/' + n in MODULES}
    need(c.get('nativeParentApiModules') == expected_native, 'API_PARENT_CHANGED')
    verify_parent_modules(c, c.get('buildParentApiModules'), c.get('nativeParentApiModules'))



def verify_parent_modules(c, local, native):
    # The retained native declaration predates the current generated type projection.
    # Runtime JavaScript and its map must reproduce byte-for-byte; the one known
    # declaration difference is pinned independently, never accepted dynamically.
    need(type(local) is dict and type(native) is dict and set(local) == set(native) == MODULES
         and local == c.get('buildParentApiModules') and native == c.get('nativeParentApiModules')
         and {n for n in MODULES if local[n] != native[n]} == {DECLARATION}
         and local[DECLARATION] == LOCAL_DECLARATION and native[DECLARATION] == NATIVE_DECLARATION,
         'PARENT_COMPILE_CHANGED')


def verify_quality(value, commit):
    need(type(value) is dict and set(value) == {'sources', 'controls', 'release'}
         and value['sources'].get('commit') == SOURCE_HEAD
         and str(value['sources'].get('runId')) == SOURCE_RUN
         and value['sources'].get('pullRequest') == 673
         and value['release'].get('commit') == commit
         and all(re.fullmatch('[a-f0-9]{40}', v.get('commit', ''))
             and re.fullmatch('[1-9][0-9]*', str(v.get('runId', '')))
             for v in value.values())
         and all(re.fullmatch('[a-f0-9]{64}', value[n].get('sourceReceiptSha256', ''))
                 and isinstance(value[n].get('pullRequest'), int) for n in ('sources', 'controls')),
         'QUALITY_REQUIRED')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId',
         'workflowRunAttempt', 'contractSha256', 'qualityVerification', 'nativeParentCapture'))
         and proof.get('scope') == SCOPE and proof.get('recipe') == RECIPE
         and proof.get('productionSources') == c['productionSources']
         and proof.get('controlSources') == c['controlPins'] and proof.get('businessActions') == 0
         and proof.get('migrationPerformed') is False and proof.get('baselineSharedUnchanged') is True
         and proof.get('baselineClientUnchanged') is True, 'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualityVerification'], proof['commit'])
    parent = proof['nativeParentCapture']
    need(parent.get('status') == 'ONLINE_EXECUTION_PARENT_VERIFIED'
         and parent.get('commit') == CURRENT and parent.get('businessActions') == 0
         and set(proof.get('apiModules', {})) == MODULES
         and proof.get('parentNativeModules') == parent['baseline']['apiModules'], 'PARENT_COMPILE_CHANGED')
    verify_parent_modules(c, proof.get('parentModulesReproduced'), parent['baseline']['apiModules'])
    engine = {n.removeprefix(ENGINE): v for n, v in c['productionSources'].items() if n.startswith(ENGINE)}
    expected = {**{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'online-recharge/source/' + n: v for n, v in engine.items()},
                **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def capture(c):
    """Authenticate the previous completed release before selecting any new baseline."""
    parent = load('settled-checkout-release.py')
    prior = json.loads((HERE / parent.CONTRACT_FILE).read_bytes())
    plan = {**c['parentPlan'], 'mode': 'readback'}
    result = parent.release(plan, prior)
    need(result['status'] == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    p = load('bitbrowser-history-release.py')
    p.MODULES = MODULES
    h, d, _ = p.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    manifest = json.loads(raw)
    need(manifest.get('commit') == CURRENT and manifest.get('sourceTree') == c['parentPlan']['tree']
         and manifest.get('status') == 'DEPLOYED' and current.parent == BASE / 'releases', 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    normalizer = prior['baseline']['backupNormalizerPath']
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw),
        'services': states, 'configurationSha256': {n: sha((current / n).read_bytes()) for n in p.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
        'proofs': {'bitbrowser-history-build-proof.json': c['parentPlan']['buildProofSha256']},
        **p.runtime(d, states), 'database': p.database(d, states['api']),
        'backupNormalizerPath': normalizer, 'backupNormalizerSha256': sha(Path(normalizer).read_bytes())}
    need(baseline['apiModules'] == c['nativeParentApiModules'], 'API_PARENT_CHANGED')
    need(baseline['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    return {'status': 'ONLINE_EXECUTION_PARENT_VERIFIED', 'commit': CURRENT, 'baseline': baseline,
            'parentProofSha256': c['parentPlan']['buildProofSha256'], 'businessActions': 0}


def engine(c, plan):
    p = load('bitbrowser-history-release.py')
    p.SCOPE, p.RECIPE, p.CURRENT, p.CONTRACT_FILE = SCOPE, RECIPE, CURRENT, CONTRACT_FILE
    p.MODULES, p.UPDATED, p.REBOUND, p.PRESERVED = MODULES, UPDATED, (), PRESERVED
    p.ARTIFACT_LIMIT = 4 * 1024**2
    p.validate_contract, p.verify_proof = validate_contract, verify_proof
    p.production_sources = lambda selected: selected['productionSources']
    original_helpers, original_baseline = p.helpers, p.baseline

    def helpers():
        h, d, retired = original_helpers()
        original_build, original_point = h.build_image, d.point_current

        def build(driver, context, reference, role, before, stage):
            need(role in UPDATED, 'IMAGE_SCOPE')
            if role == 'online-recharge':
                dockerfile = context / 'Dockerfile'
                text = dockerfile.read_text()
                old = 'COPY html/ /usr/share/nginx/html/'
                need(text.count(old) == 1, 'ENGINE_COPY_CHANGED')
                dockerfile.write_text(text.replace(old, 'COPY source/ /workspace/engine/'))
            original_build(driver, context, reference, role, before, stage)

        def point(target, stamp):
            path = target / 'release-manifest.json'
            manifest = json.loads(path.read_bytes())
            projection = manifest['roleSourceProjections']['online-recharge']
            need(manifest['scope'] == SCOPE and projection['commit'] == plan['commit']
                 and projection['sources'] == {}, 'ENGINE_PROJECTION_CHANGED')
            api_projection = manifest['roleSourceProjections']['api']
            need(api_projection['sources'] == c['productionSources'], 'API_PROJECTION_CHANGED')
            api_projection['sources'] = {WORKER: c['productionSources'][WORKER]}
            projection['sources'] = {n: v for n, v in c['productionSources'].items() if n.startswith(ENGINE)}
            manifest['onlineExecutionPublication'] = manifest['bitbrowserHistoryPublication']
            manifest['onlineRechargeCompiledArtifact'] = manifest['apiCompiledArtifact']
            path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            original_point(target, stamp)

        h.build_image, d.point_current = build, point
        return h, d, retired

    def baseline(d, h, selected, expected=None):
        need(plan['nativeParentCapture'].get('status') == 'ONLINE_EXECUTION_PARENT_VERIFIED'
             and plan['nativeParentCapture'].get('commit') == CURRENT, 'CAPTURE_CHANGED')
        selected['baseline'] = plan['nativeParentCapture']['baseline']
        load('proxy-result-identity-release.py').engine_content(d, selected['baseline']['services']['online-recharge'], c['beforeEngineFiles'])
        return original_baseline(d, h, selected, expected)

    def smoke(d, h, retired, target, states, selected, proof, _before_admin=None):
        b = plan['nativeParentCapture']['baseline']
        selected['baseline'] = b
        need(all(states[n] == b['services'][n] for n in PRESERVED)
             and all(states[n]['environmentSha256'] == b['services'][n]['environmentSha256'] for n in UPDATED)
             and {n: h.configuration(d, s) for n, s in states.items()} == b['runtimeConfigurationSha256'], 'SERVICE_SCOPE_CHANGED')
        need(p.runtime(d, states) == {**{n: b[n] for n in ('apiModules', 'apiPreservedInventory',
             'sharedInventory', 'clientInventory', 'adminInventory', 'nginxSha256')}, 'apiModules': proof['apiModules']}
             and p.database(d, states['api']) == b['database'], 'RUNTIME_CONTENT_CHANGED')
        files = {**c['beforeEngineFiles'], **{n.removeprefix(ENGINE): v for n, v in c['productionSources'].items() if n.startswith(ENGINE)}}
        load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], files)
        original = json.loads((Path(b['current']) / 'compose.release.json').read_bytes())
        selected_config = json.loads((target / 'compose.release.json').read_bytes())
        for role in UPDATED:
            selected_config['services'][role]['image'] = original['services'][role]['image']
        need(selected_config == original and all(sha((target / n).read_bytes()) == b['configurationSha256'][n]
             for n in p.CONFIGURATION if n != 'compose.release.json'), 'CONFIGURATION_CHANGED')
        row = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
        need(row['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
        need(all(not (target / n).is_symlink() and (target / n).resolve().is_relative_to(target)
             and sha((target / n).read_bytes()) == digest for n, digest in c['productionSources'].items()), 'HOST_SOURCE_CHANGED')
        manifest = json.loads((target / 'release-manifest.json').read_bytes())
        if manifest.get('scope') == SCOPE:
            old_manifest = json.loads((Path(b['current']) / 'release-manifest.json').read_bytes())
            need(manifest['roleSourceProjections']['api']['sources'] == {WORKER: c['productionSources'][WORKER]}
                 and manifest['roleSourceProjections']['online-recharge']['sources'] == {
                     n: v for n, v in c['productionSources'].items() if n.startswith(ENGINE)}
                 and all(manifest['images'][n] == old_manifest['images'][n] for n in PRESERVED)
                 and manifest.get('newMigrations') == [] and manifest.get('paymentActions') == 0, 'MANIFEST_SCOPE_CHANGED')
        retired.verify_retired_runtime(d, states)
        h.engine_idle(d, states['online-recharge'], selected, wait_connected=True)

    p.helpers, p.baseline, p.smoke = helpers, baseline, smoke
    return p


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and plan.get('controlSources') == {**c['controlPins'], CONTRACT_FILE: plan['contractSha256']}
             and all(not (HERE / n).is_symlink() and sha((HERE / n).read_bytes()) == digest
                 for n, digest in plan['controlSources'].items()), 'CONTRACT_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, c)
