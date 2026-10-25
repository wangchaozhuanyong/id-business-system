"""Finite reviewed country evidence overlay, using the complete three-role publisher."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-country-evidence'
SCOPE = 'ONLINE_COUNTRY_EVIDENCE_20261025'
CURRENT = '311dd36310bcbff1676bcd4bf626be503b96531e'
SOURCE = '6adfae02203d5ce70820d82ee1d4fe8836cc7bdf'
SOURCE_TREE = 'f875c48f743091bde8df8d9aa41be3ba396a60a5'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SOURCE_DIGEST = 'ea7fb10afa24752758128ad675c9e89ac07e91a2a71f471bfd2178183dff1bd0'
API_DIGEST = 'cdd336de0f6e5df1982da0d272e17e4a8d5b898951de8f4dd6db34937545e615'
ENGINE_PARENT_DIGEST = '91217b8551abe11ff33d8c42843b81deb37c74bc6cc43c3592010ab7335a5b06'


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('country_evidence_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 715, 'CONTRACT_IDENTITY')
    need(c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('awsTargetAccount') == '098208446664'
         and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('migrationPerformed') is False and c.get('businessActions') == 0, 'SIDE_EFFECT_SCOPE')
    need(len(c['sources']) == 15 and sha(canonical(c['sources'])) == SOURCE_DIGEST
         and sha(canonical(c['expectedApiFiles'])) == API_DIGEST, 'SOURCE_RUNTIME_HASHES_CHANGED')
    need(c['apiModules'] == ['id-business-v2/online-recharge/persistence/artifacts.repository.js'], 'API_SCOPE')
    need(sha(canonical(c['beforeEngineFiles'])) == ENGINE_PARENT_DIGEST
         and c['apiParentEngineFiles'] == c['beforeEngineFiles']
         and set(c['beforeEngineFiles']) == set(c['afterEngineFiles']) and {
        ENGINE + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v
    } == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(c['parentArtifact']['commit'] == CURRENT
         and c['parentArtifact']['artifactSha256'] == '40956e00a660487723c233241d62f29cfd8f7ee718d5a20a7088d9f42f09a40d'
         and c['parentArtifact']['buildProofSha256'] == 'd299949e69c6811abf96e239966b620f827fcbffdec8b79dc3d3fe099aca4a38'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_BINDING')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 715
         and q['source'].get('tree') == SOURCE_TREE
         and q.get('control', {}).get('pullRequest', 0) > 715 and q['control'].get('tree') == tree
         and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for part in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{40}', q[part].get('head', ''))
             and re.fullmatch('[a-f0-9]{64}', q[part].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[part].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def core():
    # Reuse the existing retired-service/configuration equivalence helpers, but
    # use the complete publisher: publish_pair omits the Admin start operation.
    helpers = load('online-checkout-resume-release.py')
    helpers.SERVICES = (*UPDATED, *PRESERVED)
    impl = load('online-checkout-release.py')
    for name in ('BASE', 'SCOPE', 'CONTRACT_FILE', 'UPDATED', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.load = helpers.load
    impl.verify_proof = verify_payload

    def artifact(plan):
        expected = 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/' + PREFIX + '-' + plan['commit'] + '/' + PREFIX + '-artifact.tar.gz'
        need(plan['artifactUrl'] == expected, 'ARTIFACT_LOCATION')
        with urllib.request.urlopen(expected, timeout=60) as response:
            raw = response.read(24 * 1024**2 + 1)
        need(0 < len(raw) <= 24 * 1024**2 and sha(raw) == plan['artifactSha256'], 'ARTIFACT_CHANGED')
        return raw
    impl.download_artifact = artifact
    return impl


def verify_payload(proof, plan, c, files):
    validate_contract(c)
    verify_quality(proof.get('qualitySourceEvidence', {}), plan['commit'], plan['tree'])
    need(proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence')
         and proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources'] and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('nativeParentCapture') == plan.get('nativeParentCapture')
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    modules = proof.get('apiModules', {})
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    need(set(modules) == selected and all(re.fullmatch('[a-f0-9]{64}', v) for v in modules.values()), 'API_SCOPE_CHANGED')
    h = load('recharge-record-release.py')
    need(h.fingerprint(proof['baselineAdminFiles']) == c['baselineAdminFilesSha256']
         and 'index.html' in proof['adminFiles']
         and all(not Path(n).is_absolute() and '..' not in Path(n).parts
                 and re.fullmatch('[a-f0-9]{64}', v) for n, v in proof['adminFiles'].items()), 'ADMIN_INVENTORY_CHANGED')
    expected = {**{'source/' + n: v for n, v in c['sources'].items()},
                **{'api/modules/' + n: v for n, v in modules.items()},
                **{'admin/html/' + n: v for n, v in proof['adminFiles'].items()},
                **{'engine/' + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v}}
    need(files == expected == proof['files'], 'PAYLOAD_SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    return verify_payload(proof, plan, c, files)


def capture_parent(plan, c):
    impl = core()
    h = impl.load('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    with (BASE / '.deploy.lock').open('a') as lock:
        impl.load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'CURRENT_PATH')
        raw = (current / 'release-manifest.json').read_bytes()
        need(json.loads(raw)['commit'] == CURRENT and json.loads(raw)['status'] == 'DEPLOYED', 'CURRENT_CHANGED')
        parent_raw = (current / 'online-checkout-build-proof.json').read_bytes()
        need(sha(parent_raw) == c['parentArtifact']['buildProofSha256'], 'PARENT_PROOF_CHANGED')
        parent = json.loads(parent_raw)
        states = h.snapshot(d, current)
        receipt = json.loads((current / 'online-checkout-preservation.json').read_bytes())
        need(states == receipt['after'], 'PARENT_SERVICES_CHANGED')
        impl.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', parent['adminFiles'])
        impl.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['expectedApiFiles'])
        impl.load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
        baseline = {'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw),
            'services': states, 'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'beforeApiOnlineFiles': {n.removeprefix('id-business-v2/online-recharge/'): v for n, v in c['expectedApiFiles'].items()},
            'baselineAdminFilesSha256': h.fingerprint(parent['adminFiles']),
            'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
            'publishedOverlays': [{'proofFile': 'online-checkout-build-proof.json', 'proofSha256': sha(parent_raw)}]}
        impl.baseline(d, {**c, **baseline}, h)
        return {'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'baseline': baseline,
                'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}


def release(plan, c):
    validate_contract(c)
    need(sha((HERE / CONTRACT_FILE).read_bytes()) == plan['contractSha256']
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    if plan['mode'] == 'parent':
        return capture_parent(plan, c)
    capture = plan['nativeParentCapture']
    need(capture['status'] == 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED'
         and capture['commit'] == plan['commit'] and capture['baseline']['expectedCurrent'] == CURRENT
         and capture['businessActions'] == 0, 'NATIVE_PARENT_REQUIRED')
    return core().release(plan, {**c, **capture['baseline']})


def failure_report(error, plan):
    return load('online-checkout-resume-release.py').failure_report(error, plan)
