"""Finite login diagnostics overlay; reuse the measured three-service switch."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-session-diagnostic'
SCOPE = 'ONLINE_SESSION_DIAGNOSTIC_20261026'
CURRENT = '673bb7f60dbfac8c7557231abad1cdc079aecb7f'
SOURCE = '08fae67d07a881e4032d58800e5076c4ebc0d396'
SOURCE_TREE = 'ee672ef428c3d38d0063ac0c619e79190c342e11'
SOURCE_PR = 734
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*UPDATED, *PRESERVED)
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_SESSION_DIAGNOSTIC_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('session_diagnostic_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == SOURCE_PR, 'IDENTITY_CHANGED')
    need(c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0, 'SIDE_EFFECT_SCOPE')
    need(sha(canonical(c['sources'])) == '1d7c623a60911886a19ec6f3cd53d8a4293d982dcfe4d51ff5bc0e3b9bbf75d3' and len(c['sources']) == 21, 'SOURCE_CHANGED')
    need(sha(canonical(c['baseline'])) == '33f4399647ebb2779e7a89e6ca9c79d12b7be8f30286a2ffc994d1818e6720b8' and
         all(c.get(n) == v for n, v in c['baseline'].items()), 'BASELINE_CHANGED')
    need(c['apiModules'] == ['id-business-v2/online-recharge/' + n + '.js'
                            for n in ('validation', 'persistence/artifacts.repository')], 'API_SCOPE')
    need(set(c['beforeEngineFiles']) == set(c['afterEngineFiles']) and
         {ENGINE + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'][n] != v}
         == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_SCOPE')
    need(c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FENCE_CHANGED')


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
    verify_quality(proof['qualitySourceEvidence'], plan['commit'], plan['tree'])
    need(proof.get('nativeParentCapture') == plan.get('nativeParentCapture')
         and proof['nativeParentCapture']['baseline'] == c['baseline'], 'PARENT_CHANGED')
    core = load('online-checkout-release.py')
    core.SCOPE = SCOPE
    core.verify_proof(proof, plan, c, files)


def helpers(name):
    module = load(name)
    retired = load('online-query-network-release.py')
    retired.SCOPE, retired.SERVICES = SCOPE, SERVICES
    if name == 'recharge-record-release.py':
        module.SERVICES = SERVICES
        module.guards = lambda d, directory, states, c: retired.retired_guards(d, directory, states, c, module)
        original = module.load_utilities

        def utilities(*args):
            d = original(*args)
            point = d.point_current

            def point_current(target, stamp):
                path = target / 'release-manifest.json'
                value = json.loads(path.read_bytes())
                value.update(applicationCommit=value['commit'], controlCommit=value['commit'],
                             version='v2-' + value['commit'],
                             sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_SESSION_DIAGNOSTIC_OVERLAY')
                path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
                return point(target, stamp)

            d.point_current = point_current
            return d

        module.load_utilities = utilities
    elif name == 'proxy-result-identity-release.py':
        module.claim_markers = retired.claim_retired_markers
    elif name == 'shared-bank-card-release.py':
        equivalence = load('online-unpaid-validation-release.py').configuration_equivalence
        module.configuration_matches = lambda h, d, state, digest: equivalence(h, d, state, digest)['matched']
    return module


def capture(c):
    h = helpers('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    core = load('online-checkout-release.py')
    core.load = helpers
    core.baseline(d, c, h)
    core.read_hashes(d, c['services']['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
    return {'status': 'ONLINE_SESSION_DIAGNOSTIC_PARENT_VERIFIED', 'baseline': c['baseline'], 'businessActions': 0}


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes()) and
         all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    if plan['mode'] == 'parent':
        return capture(c)
    core = load('online-checkout-release.py')
    core.SCOPE, core.CONTRACT_FILE, core.UPDATED, core.PRESERVED = SCOPE, CONTRACT_FILE, UPDATED, PRESERVED
    core.load, core.verify_proof = helpers, verify_proof

    def artifact(selected):
        url = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + selected['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(selected['artifactUrl'] == url, 'ARTIFACT_LOCATION')
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read(24 * 1024**2 + 1)
        need(0 < len(raw) <= 24 * 1024**2 and sha(raw) == selected['artifactSha256'], 'ARTIFACT_CHANGED')
        return raw

    core.download_artifact = artifact
    return core.release(plan, c)


def failure_report(error, plan):
    import traceback
    code = str(error)
    if not re.fullmatch('[A-Z][A-Z0-9_]{1,120}', code):
        code = 'ONLINE_SESSION_DIAGNOSTIC_REMOTE_FAILED'
    return {'status': 'FAILED', 'mode': plan['mode'], 'code': code, 'businessActions': 0,
            'frames': [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                       for f in traceback.extract_tb(error.__traceback__)[-6:]]}
