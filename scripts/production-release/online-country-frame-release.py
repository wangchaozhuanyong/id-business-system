"""Frozen executor-only iframe host scroll publication; no business actions."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-country-frame'
SCOPE = 'ONLINE_COUNTRY_FRAME_20261027'
CURRENT = 'c2e6f43a48ad471a5cab0a7f40da796a4d19c1c0'
SOURCE = '33e5c69cafddd44fcfa4787f62eca70be9343eb7'
SOURCE_TREE = 'a47cdf54a176695ad40ef19157aa80706de10491'
SOURCE_PR = 746
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-form.cjs', 'test/checkout-form.test.cjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
PARENT_PROOF = 'dbe1dfb0364a83e1bea6a43d229f111bdbeaa23aac661da98629fce6ee461b25'
SEALED = {'beforeEngineFiles': 'e2935930dd85a57e8cc707761f691591a98b04eb0a1742c2865a1ee662fbe49b', 'afterEngineFiles': 'd5d697db2cbe59c9bf5165552289f123d9135c8a402774254cd59aa64c700699', 'runtimeSources': '66cb562a9f96fe3ed5374283bbed1439d9203b09e9fd5d75ed116715d3981c57', 'validationSources': '07cdfc4da779e9528ee0e995b9b576aef752ae253d5bed3447dd248d92764483', 'parentAdminFiles': 'cb069d3fdde1a6a7848d0a24c4908adc991a34c1cba76bc408a93af32fe37050', 'backupNormalizerPath': '7d678c7771c072ec77e01a7001abc3434ac14cea56c9f5484a00402e3ca1acf6', 'backupNormalizerSha256': '7371b48a0ec5a08e6cfa32da2c14ce588f6269f2a9335cc97397db8f75168d08'}


def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('country_frame_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == SOURCE_PR
         and c.get('awsTargetAccount') == '098208446664'
         and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('updatedServices') == ['online-recharge']
         and c.get('preservedServices') == list(PRESERVED)
         and type(c.get('businessActions')) is int and c['businessActions'] == 0
         and c.get('migrationPerformed') is False, 'CONTRACT_IDENTITY')
    need(all(sha(canonical(c.get(key))) == digest for key, digest in SEALED.items()), 'FROZEN_INPUT_CHANGED')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) == set(after) and {n for n in after if before[n] != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and set(c['validationSources']) == {'docs/V2_TASKS.md', 'docs/ONLINE_RECHARGE.md',
             'scripts/ci-recharge-scope.mjs', 'scripts/ci-unpaid-validation-scope.mjs',
             'scripts/ci-unpaid-validation-scope.test.mjs'}
         and c['parentProofSha256'] == PARENT_PROOF
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FINITE_SCOPE')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('tree') == SOURCE_TREE
         and q['source'].get('pullRequest') == SOURCE_PR
         and q.get('control', {}).get('pullRequest', 0) > SOURCE_PR
         and q['control'].get('tree') == tree and q.get('main', {}).get('head') == commit,
         'QUALITY_REQUIRED')
    for name in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{64}', q[name].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[name].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    keys = ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256',
            'controlSources', 'qualitySourceEvidence', 'nativeParentCapture')
    need(all(proof.get(n) == plan.get(n) for n in keys) and proof.get('scope') == SCOPE
         and proof.get('runtimeSources') == c['runtimeSources']
         and proof.get('beforeEngineFiles') == c['beforeEngineFiles']
         and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False
         and files == proof.get('files') == {'engine/' + n: c['afterEngineFiles'][n] for n in FILES},
         'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], plan['commit'], plan['tree'])
    parent = proof['nativeParentCapture']
    need(parent.get('status') == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED'
         and parent.get('businessActions') == 0 and parent.get('parentProofSha256') == PARENT_PROOF
         and parent['baseline']['commit'] == CURRENT, 'PARENT_CHANGED')


def capture(c):
    validate_contract(c)
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, _ = history.helpers()
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'PARENT_PATH_CHANGED')
        raw = (current / 'release-manifest.json').read_bytes()
        manifest = json.loads(raw)
        need(manifest.get('commit') == CURRENT and manifest.get('status') == 'DEPLOYED', 'PARENT_CHANGED')
        proof_raw = (current / 'online-checkout-build-proof.json').read_bytes()
        need(sha(proof_raw) == PARENT_PROOF, 'PARENT_PROOF_CHANGED')
        proof = json.loads(proof_raw)
        need(proof.get('commit') == CURRENT and proof.get('afterEngineFiles') == c['beforeEngineFiles']
             and proof.get('adminFiles') == c['parentAdminFiles'], 'PARENT_RUNTIME_CHANGED')
        states = h.snapshot(d, current)
        receipt = json.loads((current / 'online-checkout-preservation.json').read_bytes())
        need(states == receipt['after'] and set(states) == set(PRESERVED) | {'online-recharge'}, 'PARENT_SERVICES_CHANGED')
        load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
        normalizer = Path(c['backupNormalizerPath'])
        need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
             and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'], 'NORMALIZER_CHANGED')
        b = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
             'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
             'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
             'runtime': history.runtime(d, states), 'database': history.database(d, states['api']),
             'backupNormalizerPath': str(normalizer), 'backupNormalizerSha256': c['backupNormalizerSha256']}
        need(b['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
        h.guards(d, current, states, c)
        need((BASE / 'current').resolve() == current and h.snapshot(d, current) == states
             and (current / 'release-manifest.json').read_bytes() == raw, 'PARENT_MOVED')
        return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': b,
                'parentProofSha256': PARENT_PROOF, 'businessActions': 0}


def engine(c, plan):
    impl = load('online-native-fetch-release.py')
    for name in ('PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'ENGINE', 'FILES', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    original = impl.load

    def helpers(name):
        module = original(name)
        if name == 'shared-bank-card-release.py':
            equivalence = load('online-unpaid-validation-release.py').configuration_equivalence
            module.configuration_matches = lambda h, d, state, digest: equivalence(h, d, state, digest)['matched']
        return module

    impl.load = helpers
    impl.validate_contract, impl.verify_quality, impl.verify_proof = validate_contract, verify_quality, verify_proof
    core = impl.engine(c, plan)
    original_helpers = core.LEGACY.helpers

    def runtime_helpers():
        h, old, d, a, p, retired = original_helpers()
        point = d.point_current

        def point_current(target, stamp):
            path = target / 'release-manifest.json'
            value = json.loads(path.read_bytes())
            value.update(applicationCommit=value['commit'], controlCommit=value['commit'],
                         version='v2-' + value['commit'],
                         sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_COUNTRY_FRAME_OVERLAY')
            path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
            return point(target, stamp)

        d.point_current = point_current
        return h, old, d, a, p, retired

    core.LEGACY.helpers = runtime_helpers
    return core


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    if plan['mode'] == 'parent':
        return capture(c)
    return engine(c, plan).release(plan, copy.deepcopy(c))


def failure_report(error, plan):
    return load('online-native-fetch-release.py').failure_report(error, plan)
