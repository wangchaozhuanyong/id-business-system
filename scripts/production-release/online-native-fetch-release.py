"""Publish four reviewed executor files through the existing engine-only switch."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import traceback

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-native-fetch'
SCOPE = 'ONLINE_NATIVE_FETCH_20261022'
CURRENT = '957407e571e7ac629393d6355a09506a196e5f91'
SOURCE = '0213263506afbf62ac6601d91694a302051e6afc'
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('SOURCE_MANIFEST.json', 'upstream/session-auth.js',
                   'test/regressions.test.cjs', 'test/session-routing-browser.test.cjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_NATIVE_FETCH_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('native_fetch_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 679
         and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
         and c.get('businessActions') == 0 and c.get('migrationPerformed') is False, 'CONTRACT_IDENTITY')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) == set(after) and {n for n in before if before[n] != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and c['parentPlan']['commit'] == CURRENT
         and c['parentPlan']['workflowRunId'] == '39750166040'
         and c['parentPlan']['buildProofSha256'] == '354a73bf0427c8c3f94de447cc94695831db51b8a3f5bdb525607fc99c1a86b0'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FINITE_SCOPE')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for group in
             ('beforeEngineFiles', 'afterEngineFiles', 'runtimeSources', 'validationSources', 'controlPins')
             for v in c[group].values()), 'HASH_INVALID')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree and q.get('pullRequest') == 679
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


def capture(c):
    prior = load('online-human-verification-release.py')
    result = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(result.get('status') == 'BITBROWSER_HISTORY_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    h, d, _ = history.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    need(current.parent == BASE / 'releases' and json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    ancestor = c['parentPlan']['nativeParentCapture']['baseline']
    b = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
         'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
         'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
         'runtime': history.runtime(d, states), 'database': history.database(d, states['api']),
         'backupNormalizerPath': ancestor['backupNormalizerPath'],
         'backupNormalizerSha256': ancestor['backupNormalizerSha256']}
    need(sha((current / 'bitbrowser-history-build-proof.json').read_bytes()) == c['parentPlan']['buildProofSha256']
         and b['database']['pending'] == 0 and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    h.guards(d, current, states, c)
    need((BASE / 'current').resolve() == current and h.snapshot(d, current) == states, 'PARENT_MOVED')
    return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': b, 'businessActions': 0}


def engine(c, plan):
    core = load('online-checkout-initialization-release.py')
    core.PREFIX, core.SCOPE, core.CURRENT = PREFIX, SCOPE, CURRENT
    core.CONTRACT_FILE, core.FILES, core.CONTROLS = CONTRACT_FILE, FILES, frozenset(c['controlPins'])
    core.ENGINE = ENGINE.rstrip('/')
    core.artifact_url = lambda commit: 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + commit + '/' + PREFIX + '-artifact.tar.gz'
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()

    def validate_plan(selected, contract):
        validate_contract(contract)
        need(contract == json.loads((HERE / CONTRACT_FILE).read_bytes())
             and selected.get('mode') in ('preflight', 'release', 'readback')
             and all(re.fullmatch('[a-f0-9]{40}', selected.get(n, '')) for n in ('commit', 'tree'))
             and all(re.fullmatch('[1-9][0-9]*', selected.get(n, '')) for n in ('workflowRunId', 'workflowRunAttempt'))
             and selected.get('contractSha256') == sha((HERE / CONTRACT_FILE).read_bytes())
             and selected.get('controlSources') == contract['controlPins']
             and selected.get('artifactUrl') == core.artifact_url(selected['commit'])
             and all(re.fullmatch('[a-f0-9]{64}', selected.get(n, '')) for n in ('artifactSha256', 'buildProofSha256')),
             'PLAN_CHANGED')
        verify_quality(selected['qualitySourceEvidence'], selected['commit'], selected['tree'])
        parent = selected['nativeParentCapture']
        need(parent['status'] == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED' and parent['baseline']['commit'] == CURRENT,
             'PARENT_CHANGED')
        contract['baseline'] = copy.deepcopy(parent['baseline'])

    def runtime(d, h, states, contract, original, files, *, admitted=False, fenced=False):
        b = contract['baseline']
        shared = load('shared-bank-card-release.py')
        need(set(states) == set(PRESERVED) | {'online-recharge'}
             and all(states[n] == original[n] for n in PRESERVED)
             and all(states[n]['environmentSha256'] == original[n]['environmentSha256'] for n in states)
             and all(shared.configuration_matches(h, d, st, b['runtimeConfigurationSha256'][n])
                     for n, st in states.items())
             and history.runtime(d, states) == b['runtime'] and history.database(d, states['api']) == b['database'],
             'PRESERVED_RUNTIME_CHANGED')
        load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], files)
        metadata = json.loads(d.run('docker', 'inspect', states['online-recharge']['containerId']))[0]
        need(metadata['HostConfig']['NetworkMode'] == 'container:' + states['api']['containerId'], 'SIDECAR_BINDING_CHANGED')
        load('online-query-network-release.py').verify_retired_runtime(d, states)
        health = core.fenced_engine if fenced else core.connected_engine if admitted else h.engine_idle
        health(d, states['online-recharge'], contract)

    def baseline(d, h, contract):
        b = contract['baseline']
        current = (BASE / 'current').resolve(strict=True)
        raw = (current / 'release-manifest.json').read_bytes()
        need(str(current) == b['current'] and sha(raw) == b['manifestSha256']
             and json.loads(raw).get('commit') == CURRENT
             and all(sha((current / n).read_bytes()) == v for n, v in b['configurationSha256'].items()), 'BASELINE_MOVED')
        states = h.snapshot(d, current)
        need(states == b['services'], 'SERVICES_MOVED')
        normalizer = Path(b['backupNormalizerPath'])
        need(normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
             and sha(normalizer.read_bytes()) == b['backupNormalizerSha256']
             and shutil.disk_usage(BASE).free > 6 * 1024**3, 'STORAGE_CHANGED')
        runtime(d, h, states, contract, states, contract['beforeEngineFiles'])
        h.guards(d, current, states, contract)
        return current, raw, states

    core.validate_plan, core.verify_proof = validate_plan, verify_proof
    core.verify_runtime, core.baseline = runtime, baseline
    return core


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and plan['controlSources'] == c['controlPins'], 'PARENT_PLAN_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, c)


def failure_report(error, plan):
    code = str(error)
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,140}', code):
        code = 'ONLINE_NATIVE_FETCH_REMOTE_FAILED'
    return {'status': 'FAILED', 'code': code, 'mode': plan['mode'], 'businessActions': 0,
            'exceptionType': type(error).__name__, 'frames': [
                {'file': Path(f.filename).name, 'function': f.name, 'line': f.lineno}
                for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in plan['controlSources']][-8:]}
