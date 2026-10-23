"""Finite Go tax-clear and Pro tier successor; only the Admin image may change."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
SCOPE = 'BITBROWSER_QUOTE_TIER_20261024'
RECIPE = 'quote-tier-20261024'
CONTRACT_FILE = 'bitbrowser-quote-contract.json'
CURRENT = 'ed580a608d038980b3501df3a718c2801564bb88'
SOURCE = '5eb95635a5f2ff4b35b9bcc6fc19106cc16b008a'
SOURCE_PR = 687
RECONSTRUCTION_SHA256 = '8f81748ca60224c4435e62d0ecc86f08d4d0c3a578d8b056ebb50483c14b4d0b'
PRIOR_CAPTURE = {'runId': 39991066742, 'runAttempt': 1, 'jobId': 120542648820, 'commit': 'a38ae9687c1bf27ca3b8b4546db0531cb69f038c', 'logSha256': '44a670a3c80eb2795c8ccccb81c9125d9ef22a0af9b32f4175dcc0848343d3e5', 'commandId': '8a9b0d50-39ea-456c-99a7-a3545a46cad0'}
PARENT_PLAN_SHA = '18e937143ff9b0d4d1747b7dd24c4cc3a7ec202640369cf454860fd9fa818b07'
ADMIN_COMMIT = 'd7d80c357c4954ef28db85e1021a0e19a65ebd81'
ADMIN_PROOF = '9c436cd452cacc54e96964830acceb56f816539147acf766fe7ce866211eda55'
PREFIX = 'apps/admin/src/v2/features/auto-recharge/'
SOURCES = frozenset(PREFIX + n for n in (
    'bitbrowser-direct-payment.ts', 'bitbrowser-native-quote.ts',
    'bitbrowser-stripe-quote.ts', 'bitbrowser-pro-tier.ts'))
TESTS = frozenset((*(PREFIX + n for n in (
    'bitbrowser-direct-payment.spec.ts', 'bitbrowser-native-quote.spec.ts',
    'bitbrowser-native-observer.spec.ts', 'bitbrowser-payment-page.spec.ts',
    'bitbrowser-pro-tier.spec.ts')), 'scripts/ci-recharge-scope.test.mjs', 'docs/V2_TASKS.md'))
ADDED = PREFIX + 'bitbrowser-pro-tier.ts'
UPDATED = ('admin',)
REBOUND = ()
PRESERVED = ('api', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
SERVICES = frozenset((*UPDATED, *PRESERVED))
MODULES = frozenset()


def need(value, code):
    if not value:
        raise RuntimeError('BITBROWSER_QUOTE_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('quote_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('status') == 'FROZEN'
         and c.get('scope') == SCOPE and c.get('recipe') == RECIPE
         and c.get('expectedCurrent') == CURRENT and c.get('sourceReviewCommit') == SOURCE
         and c.get('sourcePullRequest') == SOURCE_PR, 'CONTRACT_IDENTITY')
    need(set(c.get('productionSources', {})) == SOURCES
         and set(c.get('validationSources', {})) == TESTS
         and set(c.get('sourceParents', {})) == SOURCES - {ADDED}
         and c.get('absentSources') == [ADDED] and c.get('apiModules') == []
         and c.get('updatedServices') == list(UPDATED) and c.get('reboundServices') == []
         and c.get('preservedServices') == list(PRESERVED), 'FINITE_SCOPE')
    need(c.get('migrationPerformed') is False and c.get('businessActions') == 0
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'SIDE_EFFECT_SCOPE')
    refs = c.get('reconstructionCommits', [])
    need(type(refs) is list and len(refs) == 54 and refs == sorted(set(refs))
         and all(re.fullmatch('[a-f0-9]{40}', v) for v in refs)
         and sha(canonical(refs)) == RECONSTRUCTION_SHA256
         and c.get('previousReadOnlyCapture') == PRIOR_CAPTURE, 'RECONSTRUCTION_INPUTS_CHANGED')
    parent = c['adminParent']
    need(parent['commit'] == ADMIN_COMMIT and parent['proofSha256'] == ADMIN_PROOF
         and len(parent['adminFiles']) == 263 and 'index.html' in parent['adminFiles'], 'ADMIN_PARENT_CHANGED')
    plan = c['parentPlan']
    need(plan['commit'] == CURRENT and plan['workflowRunId'] == '39976781287'
         and plan['workflowRunAttempt'] == '1' and sha(canonical(plan)) == c['parentPlanSha256'] == PARENT_PLAN_SHA
         and sha((HERE / 'online-readonly-probe-contract.json').read_bytes()) == plan['contractSha256'],
         'PARENT_PLAN_CHANGED')
    need(all(re.fullmatch('[a-f0-9]{64}', v) for group in (
        c['productionSources'], c['validationSources'], c['sourceParents'], c['controlPins'], parent['adminFiles'])
        for v in group.values()), 'HASH_INVALID')


def verify_capture(value, c):
    need(type(value) is dict and set(value) == {'status', 'baseline', 'parentPlanSha256', 'businessActions'}
         and value['status'] == 'BITBROWSER_QUOTE_PARENT_VERIFIED'
         and value['businessActions'] == 0 and value['parentPlanSha256'] == c['parentPlanSha256'], 'PARENT_CAPTURE_CHANGED')
    b = value['baseline']
    need(b['commit'] == CURRENT and Path(b['current']).parent == BASE / 'releases'
         and set(b['services']) == SERVICES and b['apiModules'] == {}
         and b['database']['pending'] == 0
         and b['proofs'] == {'online-readonly-probe-build-proof.json': c['parentPlan']['buildProofSha256']}
         and set(b['configurationSha256']) == {'.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml'}
         and set(b['runtimeConfigurationSha256']) == SERVICES, 'PARENT_SCOPE_CHANGED')
    if 'baseline' in c:
        need(b == c['baseline'], 'NATIVE_BASELINE_CHANGED')


def capture(c):
    validate_contract(c)
    prior = load('online-readonly-probe-release.py')
    result = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(result['status'] == 'ONLINE_READONLY_PROBE_20261023_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    hst = load('bitbrowser-history-release.py')
    hst.MODULES = frozenset()
    h, d, _ = hst.helpers()
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    need(current.parent == BASE / 'releases' and json.loads(raw)['commit'] == CURRENT, 'CURRENT_CHANGED')
    states = h.snapshot(d, current)
    ancestor = c['parentPlan']['nativeParentCapture']['baseline']
    proof = (current / 'online-readonly-probe-build-proof.json').read_bytes()
    normalizer = Path(ancestor['backupNormalizerPath'])
    need(sha(proof) == c['parentPlan']['buildProofSha256']
         and normalizer.is_relative_to(BASE / 'releases') and not normalizer.is_symlink()
         and sha(normalizer.read_bytes()) == ancestor['backupNormalizerSha256']
         and shutil.disk_usage(BASE).free > 6 * 1024**3, 'PARENT_NOT_READY')
    for name, digest in c['sourceParents'].items():
        path = current / name
        need(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(current)
             and sha(path.read_bytes()) == digest, 'SOURCE_PARENT_CHANGED')
    need(not (current / ADDED).exists(), 'ADDED_SOURCE_ALREADY_PRESENT')
    baseline = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
        'configurationSha256': {n: sha((current / n).read_bytes()) for n in hst.CONFIGURATION},
        'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
        'proofs': {'online-readonly-probe-build-proof.json': sha(proof)}, **hst.runtime(d, states),
        'database': hst.database(d, states['api']), 'backupNormalizerPath': str(normalizer),
        'backupNormalizerSha256': sha(normalizer.read_bytes())}
    h.guards(d, current, states, c)
    need((BASE / 'current').resolve() == current and (current / 'release-manifest.json').read_bytes() == raw
         and h.snapshot(d, current) == states, 'PARENT_MOVED')
    value = {'status': 'BITBROWSER_QUOTE_PARENT_VERIFIED', 'baseline': baseline,
             'parentPlanSha256': c['parentPlanSha256'], 'businessActions': 0}
    verify_capture(value, c)
    return value


def verify_quality(value, commit):
    need(type(value) is dict and set(value) == {'sources', 'release'}
         and value['sources']['commit'] == SOURCE and value['sources']['pullRequest'] == SOURCE_PR
         and value['release']['commit'] == commit
         and all(re.fullmatch('[1-9][0-9]*', str(v['runId'])) for v in value.values())
         and re.fullmatch('[a-f0-9]{64}', value['sources']['sourceReceiptSha256']), 'QUALITY_REQUIRED')


def verify_proof(proof, plan, c, payload, h):
    validate_contract(c)
    need(all(proof.get(n) == plan.get(n) for n in ('commit', 'tree', 'workflowRunId',
         'workflowRunAttempt', 'contractSha256', 'qualityVerification', 'nativeParentCapture'))
         and proof.get('version') == 1 and proof.get('scope') == SCOPE and proof.get('recipe') == RECIPE
         and proof.get('productionSources') == c['productionSources'] and proof.get('controlSources') == c['controlPins']
         and proof.get('baselineAdminReproduced') is True
         and proof.get('baselineAdminFiles') == c['adminParent']['adminFiles'] and proof.get('apiModules') == {}
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False, 'BUILD_PROOF_CHANGED')
    verify_capture(proof['nativeParentCapture'], c)
    verify_quality(proof['qualityVerification'], proof['commit'])
    files = proof.get('adminFiles', {})
    need(len(files) >= 250 and 'index.html' in files
         and files['index.html'] != c['adminParent']['adminFiles']['index.html']
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in files.values()), 'ADMIN_SCOPE')
    expected = {**{'admin/html/' + n: v for n, v in files.items()},
                **{'source/' + n: v for n, v in c['productionSources'].items()}}
    actual = h.file_inventory(payload)
    actual.pop('build-proof.json', None)
    need(actual == proof.get('files') == expected, 'PAYLOAD_CHANGED')
    return proof


def engine(c):
    legacy = load('settled-checkout-release.py')
    for name in ('SCOPE', 'RECIPE', 'CONTRACT_FILE', 'CURRENT', 'SOURCE', 'SOURCES', 'TESTS', 'MODULES',
                 'UPDATED', 'REBOUND', 'PRESERVED'):
        setattr(legacy, name, globals()[name])
    legacy.validate_contract, legacy.verify_proof = validate_contract, verify_proof
    return legacy.engine(c)


def release(plan, c):
    validate_contract(c)
    need(plan.get('mode') in ('parent', 'preflight', 'release', 'readback')
         and plan.get('recipe') == RECIPE
         and all(re.fullmatch('[a-f0-9]{40}', plan.get(n, '')) for n in ('commit', 'tree'))
         and all(re.fullmatch('[1-9][0-9]*', plan.get(n, '')) for n in ('workflowRunId', 'workflowRunAttempt')),
         'PLAN_IDENTITY_INVALID')
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())},
         'PLAN_CHANGED')
    if plan['mode'] == 'parent':
        return capture(c)
    verify_capture(plan.get('nativeParentCapture'), c)
    runtime = {**copy.deepcopy(c), 'baseline': copy.deepcopy(plan['nativeParentCapture']['baseline'])}
    return engine(runtime).release(plan, runtime)
