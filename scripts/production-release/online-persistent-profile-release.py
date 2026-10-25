"""Publish only the reviewed persistent browser executor overlay; no business actions."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-persistent-profile'
SCOPE = 'ONLINE_PERSISTENT_PROFILE_20261025'
CURRENT = 'b2f56d5d09198c6e620925a15659760a4976d7dd'
SOURCE = '47b28b0361ba0e3dd2d24e9e947c17a6ef3b61eb'
SOURCE_TREE = 'a4bbd22c729416164d579820d3c1623e4f063c0d'
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('.env.example', 'SOURCE_MANIFEST.json', 'browser-profile.cjs', 'safe-media.cjs', 'task-runner.cjs', 'test/browser-profile.test.cjs', 'test/checkout-navigation.test.cjs', 'test/checkout-recovery.test.cjs', 'test/debug-checkout.test.cjs', 'test/evidence-recovery.test.cjs', 'test/execution-budget.test.cjs', 'test/session-routing-browser.test.cjs', 'test/worker-heartbeat.test.cjs', 'upstream/browser-pool-client.js', 'upstream/browser-pool.js', 'upstream/browser-runtime.js', 'upstream/browser-standalone.js', 'upstream/index.js', 'upstream/session-auth.js', 'upstream/subscription-check.js', 'worker.cjs'))
ADDED = frozenset(('browser-profile.cjs', 'test/browser-profile.test.cjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
PARENT_PROOF = '3cbb15b81dfc5268def1d6841defa448108491ea8d24d7d3e0c1b759d52ee909'


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_PERSISTENT_PROFILE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 705
         and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
         and c.get('businessActions') == 0 and c.get('migrationPerformed') is False, 'CONTRACT_IDENTITY')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) <= set(after) and set(after) - set(before) == ADDED
         and {n for n in after if before.get(n) != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and set(c['validationSources']) == {'.env.example', 'docs/V2_TASKS.md', 'docs/ONLINE_RECHARGE.md'}
         and c['parentPlan']['commit'] == CURRENT and c['parentPlan']['workflowRunId'] == '40125577641'
         and c['parentPlan']['buildProofSha256'] == PARENT_PROOF
         and c['backupNormalizerSha256'] == 'ca9b05f832e9ed73bb36b7e76c083c99a40b13e067850166f8715bae469e5202'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FINITE_SCOPE')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for group in
             ('beforeEngineFiles', 'afterEngineFiles', 'runtimeSources', 'validationSources', 'controlPins')
             for v in c[group].values()), 'HASH_INVALID')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 705
         and q['source'].get('tree') == SOURCE_TREE
         and q.get('control', {}).get('pullRequest', 0) > 705 and q['control'].get('tree') == tree
         and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for name in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[name].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[name].get('sourceReceiptSha256', ''))
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
         and files == proof.get('files') == {'engine/' + n: c['afterEngineFiles'][n] for n in FILES}, 'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], proof['commit'], proof['tree'])
    need(proof['nativeParentCapture'].get('status') == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED'
         and proof['nativeParentCapture']['baseline']['commit'] == CURRENT, 'PARENT_CHANGED')


def capture(c):
    prior = load('online-checkout-resume-release.py')
    parent = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(parent.get('status') == 'ONLINE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, _ = history.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    need(current.parent == BASE / 'releases' and json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    normalizer = Path(c['backupNormalizerPath'])
    need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == c['backupNormalizerSha256'], 'NORMALIZER_CHANGED')
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
        'runtime': history.runtime(d, states), 'database': history.database(d, states['api']),
        'backupNormalizerPath': str(normalizer), 'backupNormalizerSha256': c['backupNormalizerSha256']}
    need(sha((current / 'online-checkout-build-proof.json').read_bytes()) == PARENT_PROOF
         and baseline['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    h.guards(d, current, states, c)
    need((BASE / 'current').resolve() == current and h.snapshot(d, current) == states, 'PARENT_MOVED')
    return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': baseline, 'businessActions': 0}


def engine(c, plan):
    impl = load('online-native-fetch-release.py')
    for name in ('PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'ENGINE', 'FILES', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.validate_contract, impl.verify_quality, impl.verify_proof = validate_contract, verify_quality, verify_proof
    return impl.engine(c, plan)


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}, 'PARENT_PLAN_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, copy.deepcopy(c))


def failure_report(error, plan):
    return load('online-native-fetch-release.py').failure_report(error, plan)
