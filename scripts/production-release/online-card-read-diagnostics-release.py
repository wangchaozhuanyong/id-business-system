"""Finite artifact-validator/API and executor diagnostic overlay; no business actions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-card-read-diagnostics'
SCOPE = 'ONLINE_CARD_READ_DIAGNOSTICS_20261025'
CURRENT = '95513a24f5b7de6c5d5f6955a44ea9af4c1446ac'
SOURCE = 'c809563dde9d41c69028726def70bdb558a2c05d'
SOURCE_TREE = '31ff25ca3e9b1212543ca77c0867582cce23157c'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SOURCES = frozenset(['apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json', 'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/chatgpt.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])
API = ['id-business-v2/online-recharge/persistence/artifacts.repository.js']


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('card_read_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 708,
         'CONTRACT_IDENTITY')
    need(c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('migrationPerformed') is False and c.get('businessActions') == 0, 'SIDE_EFFECT_SCOPE')
    need(c.get('apiModules') == API and len(c.get('sources', {})) == 12
         and set(c['sources']) == SOURCES and all(
             n.startswith(('apps/api/src/id-business-v2/online-recharge/', 'docs/'))
             and '..' not in Path(n).parts and re.fullmatch('[a-f0-9]{64}', v)
             for n, v in c['sources'].items()), 'SOURCE_SCOPE')
    need(set(c['beforeEngineFiles']) == set(c['afterEngineFiles']) and {
        ENGINE + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v
    } == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(c['parentPlan']['commit'] == CURRENT and c['parentPlan']['workflowRunId'] == '40172248290'
         and c['parentPlan']['buildProofSha256'] == 'c1feb86e39ca2d47b6241593ca0123264a54d50c3d630c7f54e3bfdacdcd1db6'
         and c['parentArtifact']['commit'] == 'b2f56d5d09198c6e620925a15659760a4976d7dd'
         and c['parentArtifact']['buildProofSha256'] == '3cbb15b81dfc5268def1d6841defa448108491ea8d24d7d3e0c1b759d52ee909'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_BINDING')


def verify_quality(q, commit, tree):
    source_tree = SOURCE_TREE
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 708
         and q['source'].get('tree') == source_tree
         and q.get('control', {}).get('pullRequest', 0) > 708 and q['control'].get('tree') == tree
         and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for part in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[part].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[part].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[part].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def core():
    impl = load('online-checkout-resume-release.py')
    for name in ('BASE', 'PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'UPDATED', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.validate_contract = validate_contract
    impl.capture_parent = capture_parent
    native_verify = impl.verify_proof
    def verify(proof, plan, c, files):
        validate_contract(c)
        verify_quality(proof.get('qualitySourceEvidence', {}), plan['commit'], plan['tree'])
        need(proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence'), 'QUALITY_PROOF_CHANGED')
        return native_verify(proof, plan, c, files)
    impl.verify_proof = verify
    return impl


def verify_proof(proof, plan, c, files):
    return core().verify_proof(proof, plan, c, files)


def capture_parent(plan, c):
    # First independently verify the actual latest engine-only release. Its API
    # predecessor artifact remains the source of the exact unchanged API bytes.
    prior = load('online-persistent-profile-release.py')
    receipt = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(receipt['status'] == 'ONLINE_PERSISTENT_PROFILE_20261025_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    impl = core()
    h = impl.load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', plan['controlSources']['remote-deploy.py'])
    with (BASE / '.deploy.lock').open('a') as lock:
        impl.load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'CURRENT_PATH')
        raw = (current / 'release-manifest.json').read_bytes()
        need(json.loads(raw)['commit'] == CURRENT, 'CURRENT_CHANGED')
        parent_raw = (current / 'online-checkout-build-proof.json').read_bytes()
        need(sha(parent_raw) == c['parentArtifact']['buildProofSha256'], 'PARENT_PROOF_CHANGED')
        parent = json.loads(parent_raw)
        need(parent['commit'] == c['parentArtifact']['commit'] and parent['afterEngineFiles'] == c['apiParentEngineFiles'], 'API_PARENT_CHANGED')
        states = h.snapshot(d, current)
        h.guards(d, current, states, c)
        impl.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', parent['apiModules'])
        impl.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', parent['adminFiles'])
        impl.load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
        before_api = {}
        for name in c['apiModules']:
            for ext in ('.js', '.js.map', '.d.ts'):
                path = name.removesuffix('.js') + ext
                before_api[path.removeprefix('id-business-v2/online-recharge/')] = d.run(
                    'docker', 'exec', states['api']['containerId'], 'sha256sum', '/app/apps/api/dist/' + path).split()[0]
        baseline = {'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw),
            'services': states, 'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'beforeApiOnlineFiles': before_api, 'baselineAdminFilesSha256': h.fingerprint(parent['adminFiles']),
            'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
            'publishedOverlays': [{'proofFile': 'online-checkout-build-proof.json', 'proofSha256': sha(parent_raw)},
                {'proofFile': 'online-persistent-profile-build-proof.json', 'proofSha256': c['parentPlan']['buildProofSha256']}],
        }
        impl.baseline(d, {**c, **baseline}, h)
        return {'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'baseline': baseline,
                'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}


def release(plan, c):
    return core().release(plan, c)


def failure_report(error, plan):
    return core().failure_report(error, plan)
