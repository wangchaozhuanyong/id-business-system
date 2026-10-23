"""Publish reviewed checkout-await evidence diagnostics using the existing executor switch."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-readonly-probe'
SCOPE = 'ONLINE_READONLY_PROBE_20261023'
CURRENT = 'ed580a608d038980b3501df3a718c2801564bb88'
SOURCE = 'e65f6daae1d5112c1601d93feb9fc2e60bc53175'
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('SOURCE_MANIFEST.json', 'checkout-readonly-diagnostic.cjs', 'test/checkout-readonly-diagnostic.test.cjs'))
ADDED = frozenset()
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
PARENT_PROOF = 'f14d692f07e740233e2256db537131567951df5389a586b30690ef791c8f301b'


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_READONLY_PROBE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('subscription_challenge_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('updatedServices') == ['online-recharge']
         and c.get('preservedServices') == list(PRESERVED) and c.get('businessActions') == 0
         and c.get('migrationPerformed') is False, 'CONTRACT_IDENTITY')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) <= set(after) and set(after) - set(before) == ADDED
         and {n for n in after if before.get(n) != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and set(c['validationSources']) == {'docs/V2_TASKS.md', 'docs/ONLINE_RECHARGE.md'}
         and c['parentPlan']['commit'] == CURRENT
         and c['parentPlan']['workflowRunId'] == '39976781287'
         and c['parentPlan']['buildProofSha256'] == PARENT_PROOF
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FINITE_SCOPE')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for group in
             ('beforeEngineFiles', 'afterEngineFiles', 'runtimeSources', 'validationSources', 'controlPins')
             for v in c[group].values()), 'HASH_INVALID')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree and type(q.get('pullRequest')) is int
         and q['pullRequest'] > 686 and q.get('sourceReviewCommit') == SOURCE
         and re.fullmatch('[a-f0-9]{40}', q.get('head', ''))
         and re.fullmatch('[a-f0-9]{64}', q.get('sourceReceiptSha256', ''))
         and re.fullmatch('[1-9][0-9]*', q.get('runId', '')), 'QUALITY_REQUIRED')


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


def load_parent(c, current):
    # Read the predecessor with its own immutable controls, not this successor's
    # replaced module. Authenticate every helper before importing any of them.
    parent_here = current / 'scripts' / 'production-release'
    for name, digest in c['parentPlan']['controlSources'].items():
        path = parent_here / name
        need(Path(name).name == name and not path.is_symlink() and path.is_file()
             and sha(path.read_bytes()) == digest, 'PARENT_CONTROL_CHANGED')
    need(sha((parent_here / CONTRACT_FILE).read_bytes()) == c['parentPlan']['contractSha256'],
         'PARENT_CONTRACT_CHANGED')
    spec = importlib.util.spec_from_file_location('readonly_probe_frozen_parent', parent_here / (PREFIX + '-release.py'))
    prior = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prior)
    return prior, json.loads((parent_here / prior.CONTRACT_FILE).read_bytes())


def capture(c):
    current = (BASE / 'current').resolve(strict=True)
    need(current.parent == BASE / 'releases', 'PARENT_PATH_CHANGED')
    prior, parent_contract = load_parent(c, current)
    parent = prior.release({**c['parentPlan'], 'mode': 'readback'}, parent_contract)
    need(parent.get('status') == SCOPE + '_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, _ = history.helpers()
    need((BASE / 'current').resolve(strict=True) == current, 'PARENT_MOVED')
    raw = (current / 'release-manifest.json').read_bytes()
    need(current.parent == BASE / 'releases' and json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    ancestor = c['parentPlan']['nativeParentCapture']['baseline']
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
        'runtime': history.runtime(d, states), 'database': history.database(d, states['api']),
        'backupNormalizerPath': ancestor['backupNormalizerPath'],
        'backupNormalizerSha256': ancestor['backupNormalizerSha256']}
    need(sha((current / (PREFIX + '-build-proof.json')).read_bytes()) == PARENT_PROOF
         and baseline['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    h.guards(d, current, states, c)
    need((BASE / 'current').resolve() == current and h.snapshot(d, current) == states, 'PARENT_MOVED')
    return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': baseline, 'businessActions': 0}


def engine(c, plan):
    # Reuse the deployed switch and recovery protection. Do not rewrite it.
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
