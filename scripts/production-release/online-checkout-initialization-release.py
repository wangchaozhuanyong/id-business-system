"""Finite initialization overlay: one engine image, no migration or business action."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import time
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-checkout-initialization'
SCOPE = 'ONLINE_CHECKOUT_INITIALIZATION'
CURRENT = '523bf8173e46823c05e9641428263f17b1ca3906'
REVIEW_BASE = '523bf8173e46823c05e9641428263f17b1ca3906'
ENGINE_BASE = '827ede8b4f32bd43f699413d9630d094bdd33a4c'
ENGINE_IMAGE = 'sha256:5affbc4fc1adf9794d55408138ae93be1a9209a7c4efaed72282bd29fa3c6b24'
MANIFEST_SHA = '6248c88223ed7c64c3aa4832e2ff64cf535195678f3cda701a3a37416c7493a1'
PRESERVATION_FILE = 'bitbrowser-history-preservation.json'
PRESERVATION_SHA = '9011711a9fc23fd5b62cb27b97faf42bc09dbe26f3faf6d5163ad2b48efedd9b'
NORMALIZER_PATH = '/opt/id-business-v2/releases/20261015T091200Z-e197218c8b38-recharge-record/scripts/mysql-dump-restore-normalizer.sed'
NORMALIZER_SHA = 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
PREDECESSOR_PROOFS = {
    'online-checkout-actionability-build-proof.json': 'e2cea0e27318da7e9cb4c143f2cd26d7b87dc9cc90361eb5ef4f0db17d86f388',
    'bitbrowser-history-build-proof.json': '21ae3a28caa39c7f4c08fdb70b3e20780c4ed639d4d0bc4d11272dbd9d6d0354'}
CONTRACT_FILE = PREFIX + '-contract.json'
WORKFLOW = '.github/workflows/' + PREFIX + '-validation.yml'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine'
FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'checkout-recovery.cjs', 'upstream/session-auth.js',
    'upstream/auth-page-detect.js', 'upstream/human-verification.js', 'upstream/stripe-payment.js',
    'upstream/chatgpt.js', 'upstream/index.js', 'test/checkout-form.test.cjs', 'test/checkout-recovery.test.cjs', 'test/session-routing-browser.test.cjs',
    'test/checkout-card-preparation.test.cjs', 'test/checkout-reload-request-diagnostics.test.cjs',
    'test/recharge-flow-acceptance.test.cjs', 'test/regressions.test.cjs', 'test/auth-navigation.test.cjs',
    'test/login-evidence-browser.test.cjs', 'test/session-probe.test.cjs', 'test/upstream-session-transition.test.cjs'))
ADDED = frozenset(('test/session-routing-browser.test.cjs', 'test/checkout-card-preparation.test.cjs',
    'test/checkout-reload-request-diagnostics.test.cjs', 'test/auth-navigation.test.cjs',
    'test/login-evidence-browser.test.cjs', 'test/session-probe.test.cjs', 'test/upstream-session-transition.test.cjs'))
VALIDATION = frozenset(('docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'))
REVIEW_CONTROLS = frozenset('scripts/ci-' + name for name in (
    'online-settings-scope.mjs', 'online-settings-scope.test.mjs', 'recharge-scope.mjs', 'recharge-scope.test.mjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*PRESERVED, 'online-recharge')
QUALITY_PARTS = ('guards', 'online-engine')
INITIALIZATION_TESTS = ('test/session-routing-browser.test.cjs', 'test/checkout-card-preparation.test.cjs',
    'test/login-evidence-browser.test.cjs', 'test/session-probe.test.cjs',
    'test/upstream-session-transition.test.cjs', 'test/auth-navigation.test.cjs')
INITIALIZATION_REPORTS = (
    ('session-routing-native.tap', 'SESSION_ROUTING', 'native', 9),
    ('session-routing-standalone.tap', 'SESSION_ROUTING', 'standalone', 9),
    ('session-routing-pool.tap', 'SESSION_ROUTING', 'pool', 9),
    ('card-preparation.tap', 'CARD_PREPARATION', 'native', 13),
    ('login-evidence-browser.tap', 'LOGIN_EVIDENCE_BROWSER', 'native', 11),
    ('session-probe.tap', 'SESSION_PROBE', 'native', 8),
    ('upstream-session-transition.tap', 'UPSTREAM_SESSION_TRANSITION', 'native', 16),
    ('auth-navigation.tap', 'AUTH_NAVIGATION', 'native', 4))
HEALTH = {'ready': True, 'mode': 'enabled', 'activeTasks': 0, 'stopping': False, 'rpcConnected': True}
SQL_FENCE = '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925'


def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def load(name):
    need(re.fullmatch('[a-z0-9.-]+', name) is not None, 'HELPER_NAME_INVALID')
    spec = importlib.util.spec_from_file_location('initialization_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LEGACY = load('online-checkout-actionability-release.py')
CONTROLS = frozenset((*LEGACY.CONTROLS, 'recharge-checkout-release.py', *(PREFIX + '-' + suffix for suffix in ('build.py', 'release.py', 'release.test.py'))))
PUBLIC_CONTROLS = frozenset((WORKFLOW, *REVIEW_CONTROLS, *('scripts/production-release/' + PREFIX + '-' + suffix
    for suffix in ('build.py', 'release.py', 'release.test.py', 'contract.json'))))


def inventory(value):
    return type(value) is dict and bool(value) and all(type(name) is str
        and re.fullmatch('[A-Za-z0-9_./-]+', name) and not name.startswith('/')
        and all(part not in ('', '.', '..') for part in name.split('/'))
        and type(digest) is str and re.fullmatch('[a-f0-9]{64}', digest) for name, digest in value.items())


def validate_contract(c):
    need(c.get('frozen') is True and c.get('admission') == 'FROZEN_REVIEWED_SOURCE'
        and c.get('pendingBindings') == [], 'SOURCE_NOT_FROZEN')
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
        and c.get('engineSourceBase') == ENGINE_BASE and c.get('reviewBase') == REVIEW_BASE
        and c.get('engineRoot') == ENGINE and re.fullmatch('[a-f0-9]{40}', c.get('sourceReviewCommit', ''))
        and c.get('sourceReviewTag') == PREFIX + '-source-review-' + c['sourceReviewCommit'][:12]
        and c.get('upstreamSource') == LEGACY.UPSTREAM_SOURCE
        and c.get('requiredQualityParts') == list(QUALITY_PARTS)
        and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
        and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
        and c['businessActions'] == 0 and c.get('sqlFenceHelperSha256') == SQL_FENCE
        and c.get('engineHealth') == HEALTH, 'CONTRACT_IDENTITY_INVALID')
    before, after = c.get('beforeEngineFiles'), c.get('afterEngineFiles')
    need(inventory(before) and inventory(after) and set(after) - set(before) == ADDED
        and set(before) <= set(after) and {n for n in after if before.get(n) != after[n]} == FILES
        and c.get('runtimeSources') == {ENGINE + '/' + n: after[n] for n in FILES}
        and inventory(c.get('validationSources')) and set(c['validationSources']) == VALIDATION
        and inventory(c.get('reviewedControlSources')) and set(c['reviewedControlSources']) == REVIEW_CONTROLS
        and inventory(c.get('controlPins')) and set(c['controlPins']) == CONTROLS
        and c['controlPins']['api-admin-scope.py'] == SQL_FENCE
        and all(c['controlPins'][n] == v for n, v in LEGACY.LEGACY_CONTROL_PINS.items())
        and re.fullmatch('[a-f0-9]{64}', c.get('workflowSha256', '')), 'SOURCE_SCOPE_CHANGED')
    b = c.get('baseline', {})
    baseline_keys = {'commit', 'current', 'manifestSha256', 'proofs', 'services', 'runtimeConfigurationSha256',
        'configurationSha256', 'engineFiles', 'engineHealth', 'apiOnlineFiles', 'adminFiles', 'nginxSha256',
        'backupNormalizerPath', 'backupNormalizerSha256', 'businessActions', 'databaseWrites', 'preservationReceiptSha256'}
    need(type(b) is dict and baseline_keys <= set(b) <= baseline_keys | {'freeBytes'}, 'BASELINE_FIELDS_INVALID')
    state_keys = {'containerId', 'environmentSha256', 'health', 'image', 'reference', 'startedAtSha256', 'status'}
    need(type(b.get('services')) is dict and set(b['services']) == set(SERVICES)
        and all(type(s) is dict and set(s) == state_keys and s['status'] == 'running'
            and (s['health'] == 'healthy' or n == 'caddy' and s['health'] is None)
            and re.fullmatch('[a-f0-9]{64}', s['containerId'])
            and re.fullmatch('sha256:[a-f0-9]{64}', s['image'])
            and re.fullmatch('[a-z0-9][a-z0-9._:/@-]{1,255}', s['reference'])
            and all(re.fullmatch('[a-f0-9]{64}', s[k]) for k in ('environmentSha256', 'startedAtSha256'))
            for n, s in b['services'].items()), 'BASELINE_SERVICE_IDENTITY_INVALID')
    need(type(b) is dict and b.get('commit') == CURRENT and b.get('manifestSha256') == MANIFEST_SHA
        and b.get('preservationReceiptSha256') == PRESERVATION_SHA
        and b.get('proofs') == PREDECESSOR_PROOFS
        and re.fullmatch('/opt/id-business-v2/releases/[A-Za-z0-9_-]+', b.get('current', ''))
        and set(b.get('services', {})) == set(SERVICES)
        and b['services']['online-recharge'].get('image') == ENGINE_IMAGE
        and b.get('engineHealth') == HEALTH
        and b.get('engineFiles') == before
        and inventory(b.get('runtimeConfigurationSha256')) and set(b['runtimeConfigurationSha256']) == set(SERVICES)
        and inventory(b.get('configurationSha256')) and set(b['configurationSha256']) == {
            '.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
        and inventory(b.get('apiOnlineFiles')) and inventory(b.get('adminFiles'))
        and re.fullmatch('[a-f0-9]{64}', b.get('nginxSha256', ''))
        and b.get('backupNormalizerSha256') == NORMALIZER_SHA and b.get('backupNormalizerPath') == NORMALIZER_PATH
        and b.get('businessActions') == b.get('databaseWrites') == 0,
        'BASELINE_INVALID')


def validate_quality(value, commit, tree):
    LEGACY.validate_quality(value, commit, tree)


def artifact_url(commit):
    return 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + commit + '/' + PREFIX + '-artifact.tar.gz'


def validate_browser(value, identity, c):
    expected_runs = [(suite, mode, total) for _, suite, mode, total in INITIALIZATION_REPORTS]
    need(type(value) is dict and value.get('platform') == 'linux'
        and re.fullmatch(r'22\.\d+\.\d+', value.get('nodeVersion', ''))
        and all(value.get(k) == identity[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt'))
        and value.get('testFiles') == {n: c['afterEngineFiles'][n] for n in INITIALIZATION_TESTS}
        and value.get('sessionRoutingHeadful') is True and value.get('passed') == 79
        and value.get('failed') == value.get('skipped') == value.get('todo') == 0
        and value.get('businessActions') == value.get('paymentActions') == 0
        and re.fullmatch('[a-f0-9]{64}', value.get('reportSha256', '')), 'LINUX_INITIALIZATION_TESTS_REQUIRED')
    runs = value.get('runs', [])
    need(type(runs) is list and len(runs) == len(expected_runs)
        and [(r.get('suite'), r.get('mode'), r.get('passed')) for r in runs] == expected_runs
        and all(re.fullmatch('[a-f0-9]{64}', r.get('reportSha256', '')) for r in runs)
        and value['reportSha256'] == fingerprint(runs), 'INITIALIZATION_COVERAGE_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    need(all(proof.get(k) == plan.get(k) for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt',
        'contractSha256', 'controlSources', 'qualitySourceEvidence'))
        and proof.get('scope') == SCOPE and proof.get('runtimeSources') == c['runtimeSources']
        and proof.get('beforeEngineFiles') == c['beforeEngineFiles'] and proof.get('afterEngineFiles') == c['afterEngineFiles']
        and proof.get('baselineSha256') == fingerprint(c['baseline'])
        and proof.get('workflowSha256') == c['workflowSha256']
        and proof.get('updatedServices') == ['online-recharge'] and proof.get('preservedServices') == list(PRESERVED)
        and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0
        and proof.get('files') == files == {'engine/' + n: c['afterEngineFiles'][n] for n in FILES}, 'PROOF_CHANGED')
    validate_quality(proof.get('qualitySourceEvidence'), plan['commit'], plan['tree'])
    parts = proof.get('qualityPartEvidence', {})
    need(parts.get('parts') == list(QUALITY_PARTS) and parts.get('testedTree') == plan['tree']
        and parts.get('runId') == proof['qualitySourceEvidence'].get('runId')
        and parts.get('runAttempt') == proof['qualitySourceEvidence'].get('runAttempt')
        and set(parts.get('jobs', {})) == set(QUALITY_PARTS)
        and all(type(v) is int and v > 0 for v in parts['jobs'].values())
        and len(set(parts['jobs'].values())) == len(QUALITY_PARTS), 'QUALITY_PARTS_CHANGED')
    validate_browser(proof.get('initializationBrowserEvidence'), plan, c)


def validate_plan(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('preflight', 'release', 'readback')
        and all(re.fullmatch('[a-f0-9]{40}', plan.get(k, '')) for k in ('commit', 'tree'))
        and all(re.fullmatch('[1-9][0-9]*', plan.get(k, '')) for k in ('workflowRunId', 'workflowRunAttempt'))
        and plan.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
        and c == json.loads((HERE / CONTRACT_FILE).read_bytes())
        and plan.get('controlSources') == c['controlPins'] and plan.get('artifactUrl') == artifact_url(plan['commit'])
        and all(re.fullmatch('[a-f0-9]{64}', plan.get(k, '')) for k in ('artifactSha256', 'buildProofSha256')), 'PLAN_INVALID')
    validate_quality(plan.get('qualitySourceEvidence'), plan['commit'], plan['tree'])


def connected_engine(d, state, _c, *, wait_connected=False):
    """After admission, legitimate task activity is not a publication failure."""
    code = ("require('/workspace/engine/healthcheck.cjs').check().then(v=>console.log(JSON.stringify({"
        "ready:v.ready,mode:v.mode,activeTasks:v.activeTasks,stopping:v.stopping,rpcConnected:v.rpcConnected})))"
        ".catch(()=>process.exit(1))")
    result = json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=15))
    need(type(result) is dict and set(result) == set(HEALTH)
        and type(result['activeTasks']) is int and result['activeTasks'] >= 0
        and {k: v for k, v in result.items() if k != 'activeTasks'} == {k: v for k, v in HEALTH.items() if k != 'activeTasks'},
        'ENGINE_NOT_CONNECTED')
    probe = "require('/workspace/engine/rpc.cjs').rpc('getRuntimeConfig',{}).then(v=>console.log(JSON.stringify({readOnlyRpcReady:!!v&&typeof v==='object'&&!Array.isArray(v)}))).catch(()=>process.exit(1))"
    need(json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', probe, timeout=15))
        == {'readOnlyRpcReady': True}, 'ONLINE_RPC_UNAVAILABLE')
    return result


def verify_runtime(d, h, states, c, original, files, *, admitted=False):
    need(set(states) == set(SERVICES) and all(states[n] == original[n] for n in PRESERVED), 'PRESERVED_SERVICE_CHANGED')
    # helpers() loads this private module per publication. Preserve every legacy
    # configuration/source check, changing only the post-admission health read.
    engine_health = h.engine_idle
    try:
        if admitted: h.engine_idle = connected_engine
        LEGACY.verify_runtime(d, h, states, c, original, files)
    finally:
        h.engine_idle = engine_health


def verify_adopted(d, h, target, c, plan, receipt):
    need(source_selected(target, plan, receipt['candidateImageId'])
        and json.loads((target / 'release-manifest.json').read_bytes()).get('status') == 'DEPLOYED', 'READBACK_CHANGED')
    states = h.snapshot(d, target)
    need(states == receipt['after'] and receipt.get('before') == c['baseline']['services']
        and states['online-recharge']['image'] == receipt['candidateImageId']
        and states['online-recharge']['reference'] == 'id-business-v2-' + PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId'],
        'READBACK_SERVICES_CHANGED')
    verify_runtime(d, h, states, c, receipt['before'], c['afterEngineFiles'], admitted=True)
    verify_host(target, states, c, plan)
    need(not (BASE / 'maintenance.json').exists(), 'MAINTENANCE_PRESENT')
    need(source_selected(target, plan, receipt['candidateImageId']) and h.snapshot(d, target) == states, 'READBACK_MOVED_DURING_OBSERVATION')
    return states


def read_baseline():
    """Pure observation for an explicitly authorized private transport; never saves or publishes."""
    h, _old, d, _a, _p, _retired = LEGACY.helpers()
    current = (BASE / 'current').resolve()
    need(current.parent == BASE / 'releases', 'BASELINE_PATH_CHANGED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(sha(raw) == MANIFEST_SHA and json.loads(raw).get('commit') == CURRENT, 'BASELINE_MOVED')
    need(all(sha((current / n).read_bytes()) == v for n, v in PREDECESSOR_PROOFS.items()), 'PREDECESSOR_PROOF_CHANGED')
    preservation_raw = (current / PRESERVATION_FILE).read_bytes()
    need(sha(preservation_raw) == PRESERVATION_SHA, 'PRESERVATION_PROOF_CHANGED')
    proof = json.loads((current / 'online-checkout-actionability-build-proof.json').read_bytes())
    need(proof.get('commit') == ENGINE_BASE and inventory(proof.get('afterEngineFiles')), 'ENGINE_PROVENANCE_CHANGED')
    before = h.snapshot(d, current)
    state_keys = {'containerId', 'environmentSha256', 'health', 'image', 'reference', 'startedAtSha256', 'status'}
    need(before == json.loads(preservation_raw).get('after')
        and set(before) == set(SERVICES) and all(set(s) == state_keys for s in before.values())
        and before['online-recharge']['image'] == ENGINE_IMAGE, 'BASELINE_SERVICE_CHANGED')
    load('proxy-result-identity-release.py').engine_content(d, before['online-recharge'], proof['afterEngineFiles'])
    # API inventory contains hashes only. The root and request are fixed; no
    # credentials, source text, URLs or response payloads are returned.
    code = "const fs=require('fs'),p=require('path'),c=require('crypto'),root='/app/apps/api/dist/id-business-v2/online-recharge',out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=p.join(dir,e.name),name=p.relative(root,file);if(name.split(p.sep)[0]==='engine')continue;if(e.isSymbolicLink())throw Error('SOURCE_LINK');if(e.isDirectory())walk(file);else if(e.isFile())out[name]=c.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}}walk(root);console.log(JSON.stringify(out))"
    api_files = json.loads(d.run('docker', 'exec', before['api']['containerId'], 'node', '-e', code, timeout=60))
    admin_files = load('recharge-checkout-release.py').admin_inventory(d, before['admin'])
    need(inventory(api_files) and inventory(admin_files), 'BASELINE_INVENTORY_INVALID')
    normalizer = Path(NORMALIZER_PATH)
    need(normalizer.is_file() and not normalizer.is_symlink() and all(not parent.is_symlink() for parent in normalizer.parents)
        and normalizer.is_relative_to(BASE / 'releases') and sha(normalizer.read_bytes()) == NORMALIZER_SHA, 'BACKUP_NORMALIZER_CHANGED')
    result = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'proofs': dict(PREDECESSOR_PROOFS),
        'preservationReceiptSha256': sha(preservation_raw),
        'services': before, 'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in before.items()},
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
        'engineFiles': proof['afterEngineFiles'], 'engineHealth': h.engine_idle(d, before['online-recharge'], {'engineHealth': HEALTH}),
        'apiOnlineFiles': api_files, 'adminFiles': admin_files,
        'nginxSha256': d.run('docker', 'exec', before['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
        'backupNormalizerPath': str(normalizer), 'backupNormalizerSha256': sha(normalizer.read_bytes()),
        'freeBytes': shutil.disk_usage(BASE).free, 'businessActions': 0, 'databaseWrites': 0}
    h.guards(d, current, before, {'engineHealth': HEALTH})
    need(inventory(result['runtimeConfigurationSha256']) and inventory(result['configurationSha256'])
        and re.fullmatch('[a-f0-9]{64}', result['nginxSha256']) and result['engineHealth'] == HEALTH,
        'BASELINE_HASH_OUTPUT_INVALID')
    need((BASE / 'current').resolve() == current and sha((current / 'release-manifest.json').read_bytes()) == MANIFEST_SHA
        and h.snapshot(d, current) == before, 'BASELINE_MOVED_DURING_READ')
    return result


def baseline(d, h, c):
    b = c['baseline']; current = (BASE / 'current').resolve()
    raw = (current / 'release-manifest.json').read_bytes()
    need(str(current) == b['current'] and current.parent == BASE / 'releases'
        and sha(raw) == MANIFEST_SHA and json.loads(raw).get('commit') == CURRENT, 'BASELINE_MOVED')
    need(all(sha((current / n).read_bytes()) == v for n, v in PREDECESSOR_PROOFS.items()), 'PREDECESSOR_PROOF_CHANGED')
    need(sha((current / PRESERVATION_FILE).read_bytes()) == PRESERVATION_SHA, 'PRESERVATION_PROOF_CHANGED')
    states = h.snapshot(d, current)
    need(states == b['services'] and all(sha((current / n).read_bytes()) == v for n, v in b['configurationSha256'].items()), 'BASELINE_MOVED')
    normalizer = Path(b['backupNormalizerPath'])
    need(str(normalizer) == NORMALIZER_PATH and normalizer.is_file() and not normalizer.is_symlink()
        and all(not parent.is_symlink() for parent in normalizer.parents) and sha(normalizer.read_bytes()) == b['backupNormalizerSha256']
        and shutil.disk_usage(BASE).free > 6 * 1024**3, 'BASELINE_STORAGE_CHANGED')
    verify_runtime(d, h, states, c, states, c['beforeEngineFiles'])
    h.guards(d, current, states, c)
    return current, raw, states


def verify_host(target, states, c, plan):
    need(all(not (target / n).is_symlink() and sha((target / n).read_bytes()) == v for n, v in c['runtimeSources'].items()), 'HOST_SOURCE_CHANGED')
    need(sha((target / 'scripts/production-release' / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
        and all(sha((target / 'scripts/production-release' / n).read_bytes()) == v for n, v in c['controlPins'].items()), 'HOST_CONTROL_CHANGED')
    expected = json.loads((Path(c['baseline']['current']) / 'compose.release.json').read_bytes())
    expected['services']['online-recharge']['image'] = states['online-recharge']['reference']
    need(json.loads((target / 'compose.release.json').read_bytes()) == expected
        and all(sha((target / n).read_bytes()) == v for n, v in c['baseline']['configurationSha256'].items() if n != 'compose.release.json'), 'HOST_CONFIGURATION_CHANGED')


def source_selected(target, plan, image):
    try:
        manifest = json.loads((target / 'release-manifest.json').read_bytes())
        receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
        return ((BASE / 'current').resolve() == target and manifest.get('commit') == plan['commit']
            and manifest.get('sourceTree') == plan['tree'] and manifest.get('scope') == SCOPE
            and manifest.get('status') in ('SWITCH_STARTED', 'DEPLOYED')
            and manifest.get('images', {}).get('online-recharge', {}).get('digest') == image
            and manifest['images']['online-recharge'].get('sourceCommit') == plan['commit']
            and manifest['images']['online-recharge'].get('reference') ==
                'id-business-v2-' + PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId']
            and receipt.get('commit') == plan['commit'] and receipt.get('candidateImageId') == image
            and receipt.get('buildProofSha256') == plan['buildProofSha256']
            and receipt.get('status') == manifest.get('status')
            and sha((target / (PREFIX + '-build-proof.json')).read_bytes()) == plan['buildProofSha256'])
    except (OSError, ValueError):
        return False


def quiet_candidate(d, identity):
    """Only this exact candidate; a stop command error never counts as evidence."""
    def state():
        metadata = json.loads(d.run('docker', 'inspect', identity['containerId'], timeout=5))[0]
        need(metadata.get('Id') == identity['containerId'] and metadata.get('Image') == identity['image']
            and sha(metadata['State']['StartedAt'].encode()) == identity['startedAtSha256'], 'CANDIDATE_IDENTITY_CHANGED')
        return metadata['State']
    for command in (('stop', '--time', '3'), ('kill',), ('pause',)):
        observed = state()
        if observed.get('Running') is False: return 'STOPPED'
        if observed.get('Paused') is True: return 'PAUSED'
        try:
            d.run('docker', *command, identity['containerId'], timeout=8)
        except Exception:
            pass
        observed = state()
        if observed.get('Running') is False: return 'STOPPED'
        if observed.get('Paused') is True: return 'PAUSED'
    raise RuntimeError(SCOPE + '_CANDIDATE_QUIET_UNCONFIRMED')


def switch_selected_source(d, current, target, before, image, fence, plan, journal, select, verify, finish):
    """Select source identity before any candidate request; SQL-fence its activation."""
    candidate = None
    candidate_attempted = False
    deadline = time.monotonic() + 120
    original_run = d.run
    cleanup = False
    def bounded_run(*args, **kwargs):
        remaining = min(deadline, getattr(fence, 'deadline', deadline)) - time.monotonic() - (0 if cleanup else 45)
        need(remaining > 0, 'SWITCH_BUDGET_EXHAUSTED')
        kwargs['timeout'] = min(float(kwargs.get('timeout', 300)), remaining)
        return original_run(*args, **kwargs)
    d.run = bounded_run
    try:
        fence.acquire()
        fence.stop(before, grace=3)
        select()
        need(source_selected(target, plan, image), 'SOURCE_SELECTION_UNCONFIRMED')
        # No candidate is started until the exact source/proof/current identity
        # has been written and independently read back by this controller.
        candidate_attempted = True
        d.compose(target, 'up', '-d', '--no-deps', 'online-recharge', timeout=15)
        healthy_deadline = min(time.monotonic() + 20, fence.deadline - 45)
        while True:
            observed = d.service_state(target, 'online-recharge', include_container_id=True, include_environment_hash=True)
            need(observed['image'] == image and observed['containerId'] != before['containerId'], 'CANDIDATE_IDENTITY_CHANGED')
            candidate = observed
            if candidate['status'] == 'running' and candidate['health'] == 'healthy': break
            need(candidate['status'] in ('running', 'created') and time.monotonic() < healthy_deadline, 'CANDIDATE_NOT_HEALTHY')
            time.sleep(min(1, max(0, healthy_deadline - time.monotonic())))
        after = verify()
        finish(after)
        need(source_selected(target, plan, image)
            and json.loads((target / 'release-manifest.json').read_bytes()).get('status') == 'DEPLOYED', 'PUBLICATION_COMMIT_UNCONFIRMED')
        fence.check_idle()
        return after
    except BaseException:
        cleanup = True
        quiet = 'NOT_STARTED'
        try:
            if candidate is None and candidate_attempted:
                observed = d.service_state(target, 'online-recharge', include_container_id=True, include_environment_hash=True)
                if observed['image'] == image and observed['containerId'] != before['containerId']: candidate = observed
                else: quiet = 'NO_MATCHING_CANDIDATE_OBSERVED'
            if candidate is not None:
                quiet = quiet_candidate(d, candidate)
        except Exception:
            quiet = 'UNCONFIRMED'
        # This is a factual failure state, never a rollback or a claim that an
        # API transaction was cancelled by stopping its browser-side caller.
        manifest = json.loads((target / 'release-manifest.json').read_bytes())
        if manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE:
            manifest['status'] = 'SWITCH_FAILED'
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        journal.write_text(json.dumps({'status': 'SWITCH_FAILED', 'target': str(target),
            'sourceSelected': (BASE / 'current').resolve() == target, 'candidateQuiet': quiet,
            'apiTransactionsCancelled': False}) + '\n')
        raise
    finally:
        d.run = original_run
        fence.close()


def release(plan, c):
    validate_plan(plan, c)
    need(all(not (HERE / n).is_symlink() and sha((HERE / n).read_bytes()) == v for n, v in c['controlPins'].items()), 'CONTROL_CHANGED')
    h, old, d, a, p, retired = LEGACY.helpers()
    p.SCOPE = retired.SCOPE = SCOPE
    # Existing lock only: preflight/readback do not create markers or stage files.
    with (BASE / '.deploy.lock').open('r') as lock:
        a.acquire_release_lock(lock)
        if plan['mode'] == 'readback':
            target = (BASE / 'current').resolve(); manifest = json.loads((target / 'release-manifest.json').read_bytes())
            raw = (target / (PREFIX + '-build-proof.json')).read_bytes()
            receipt = json.loads((target / (PREFIX + '-preservation.json')).read_bytes())
            need(manifest.get('commit') == plan['commit'] and manifest.get('scope') == SCOPE
                and manifest.get('status') == 'DEPLOYED' and sha(raw) == plan['buildProofSha256'], 'READBACK_CHANGED')
            proof = json.loads(raw); verify_proof(proof, plan, c, proof.get('files'))
            verify_adopted(d, h, target, c, plan, receipt)
            return {'status': SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'commit': plan['commit'], 'businessActions': 0,
                'updatedServices': ['online-recharge'], 'preservedServices': list(PRESERVED), 'migrationPerformed': False}
        current, manifest_raw, before = baseline(d, h, c)
        if plan['mode'] == 'preflight':
            return {'status': SCOPE + '_PREFLIGHT_VERIFIED', 'commit': plan['commit'], 'businessActions': 0,
                'updatedServices': ['online-recharge'], 'preservedServices': list(PRESERVED), 'migrationPerformed': False}
        stage = BASE / '.staging' / (PREFIX + '-' + plan['commit'] + '-' + plan['workflowRunId'])
        # Exclusive acceptance: a partial/unknown operation cannot be re-triggered.
        need(not stage.exists(), 'RELEASE_ALREADY_ACCEPTED'); stage.mkdir(mode=0o700)
        journal = stage / 'switch-state.json'
        journal.write_text(json.dumps({'status': 'ACCEPTED', 'commit': plan['commit']}) + '\n')
        with urllib.request.urlopen(plan['artifactUrl'], timeout=60) as response:
            raw = response.read(4 * 1024**2 + 1)
        need(0 < len(raw) <= 4 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        payload = load('shared-bank-card-release.py').safe_archive(raw, stage / 'content')
        proof_raw = (payload / 'build-proof.json').read_bytes()
        need(sha(proof_raw) == plan['buildProofSha256'], 'PROOF_BYTES_CHANGED')
        files = h.file_inventory(payload); files.pop('build-proof.json')
        verify_proof(json.loads(proof_raw), plan, c, files)
        context = stage / 'image'; shutil.copytree(payload / 'engine', context / 'source'); a.normalize_image_context(context)
        reference = 'id-business-v2-' + PREFIX + ':' + plan['commit'] + '-' + plan['workflowRunId']
        original = json.loads(d.run('docker', 'image', 'inspect', before['online-recharge']['image']))[0]
        (context / 'Dockerfile').write_text('FROM ' + h.base_image_reference(d, before['online-recharge'])
            + '\nCOPY source/ /workspace/engine/\nLABEL org.opencontainers.image.revision="' + plan['commit']
            + '" id-business-v2.recharge-record-build-proof-sha256="' + plan['buildProofSha256'] + '"\n')
        h.build_image(d, context, reference, 'online-recharge', before['online-recharge'], stage)
        built = json.loads(d.run('docker', 'image', 'inspect', reference))[0]; old.verify_image(original, built, plan)
        need(baseline(d, h, c)[1:] == (manifest_raw, before), 'BASELINE_MOVED')
        backup = h.fresh_scoped_backup(d, current, plan, normalizer_path=Path(c['baseline']['backupNormalizerPath']))
        need(backup.get('s3Verified') is True, 'BACKUP_UNVERIFIED')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        target = BASE / 'releases' / (stamp + '-' + plan['commit'][:12] + '-' + PREFIX)
        need(not target.exists(), 'TARGET_EXISTS'); shutil.copytree(current, target, symlinks=True)
        for name in FILES:
            path = target / ENGINE / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_SOURCE_PATH_CHANGED')
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes((payload / 'engine' / name).read_bytes()); path.chmod(0o644)
        for name in (*CONTROLS, CONTRACT_FILE):
            path = target / 'scripts/production-release' / name
            need(not path.is_symlink() and path.resolve().is_relative_to(target), 'HOST_CONTROL_PATH_CHANGED'); path.write_bytes((HERE / name).read_bytes())
        override = json.loads((target / 'compose.release.json').read_bytes()); override['services']['online-recharge']['image'] = reference
        (target / 'compose.release.json').write_text(json.dumps(override, sort_keys=True, indent=2) + '\n'); (target / 'compose.release.json').chmod(0o600)
        need(baseline(d, h, c)[1:] == (manifest_raw, before), 'BASELINE_MOVED')
        # Maintenance=true makes getRuntimeConfig count task rows. Refuse it
        # before holding the task fence rather than deadlocking startup health.
        probe = "require('/workspace/engine/rpc.cjs').rpc('getRuntimeConfig',{}).then(v=>console.log(JSON.stringify({maintenance:v.maintenance===true,known:typeof v.maintenance==='boolean'}))).catch(()=>process.exit(1))"
        need(json.loads(d.run('docker', 'exec', before['online-recharge']['containerId'], 'node', '-e', probe, timeout=10))
            == {'maintenance': False, 'known': True}, 'RUNTIME_MAINTENANCE_BLOCKS_SWITCH')
        receipt = {'commit': plan['commit'], 'before': before, 'candidateImageId': built['Id'], 'backup': backup,
            'buildProofSha256': plan['buildProofSha256'], 'preservedServices': list(PRESERVED),
            'updatedServices': ['online-recharge'], 'migrationPerformed': False, 'businessActions': 0, 'status': 'SWITCH_STARTED'}
        manifest = json.loads(manifest_raw)
        manifest.update(commit=plan['commit'], sourceTree=plan['tree'], sourceBranch='main', scope=SCOPE,
            previousCommit=CURRENT, previousRelease=str(current), previousManifestSha256=sha(manifest_raw),
            status='SWITCH_STARTED', servicesUpdated=['online-recharge'], migrationPerformed=False, newMigrations=[], paymentActions=0)
        manifest['images']['online-recharge'] = {'reference': reference, 'digest': built['Id'], 'sourceCommit': plan['commit']}
        projections = manifest.setdefault('roleSourceProjections', {})
        projections['online-recharge'] = {'kind': SCOPE, 'commit': plan['commit'], 'parentProjection': projections.get('online-recharge'),
            'buildProofSha256': plan['buildProofSha256'], 'sources': c['runtimeSources']}
        def select():
            (target / (PREFIX + '-build-proof.json')).write_bytes(proof_raw)
            (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            journal.write_text(json.dumps({'status': 'SOURCE_SELECTED_PENDING_ACTIVATION', 'target': str(target)}) + '\n')
            d.point_current(target, stamp + '-' + PREFIX)
        def verify():
            after = h.snapshot(d, target)
            need(after['online-recharge']['image'] == built['Id'], 'IMAGE_CHANGED')
            verify_runtime(d, h, after, c, before, c['afterEngineFiles']); verify_host(target, after, c, plan)
            return after
        def finish(after):
            receipt.update(status='DEPLOYED', after=after, image=built['Id'])
            manifest['status'] = 'DEPLOYED'
            (target / (PREFIX + '-preservation.json')).write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
            (target / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        marker = p.claim_markers(d, before, plan); fence = p.sql_fence_class(c)(d, current)
        after = switch_selected_source(d, current, target, before['online-recharge'], built['Id'], fence, plan, journal, select, verify, finish)
        try:
            p.release_markers(marker)
            verify_adopted(d, h, target, c, plan, receipt)
        except BaseException:
            journal.write_text(json.dumps({'status': 'COMMITTED_NEEDS_READBACK', 'target': str(target),
                'candidateQuiet': 'ADMITTED', 'apiTransactionsCancelled': False}) + '\n')
            raise
        journal.write_text(json.dumps({'status': 'DEPLOYED', 'target': str(target)}) + '\n')
        return {'status': SCOPE + '_DEPLOYED', 'commit': plan['commit'], 'updatedServices': ['online-recharge'],
            'preservedServices': list(PRESERVED), 'migrationPerformed': False, 'businessActions': 0}
