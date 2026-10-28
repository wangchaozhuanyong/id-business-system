"""Finite two-service diagnostic overlay on the published mailbox successor."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-frame-attempts'
SCOPE = 'ONLINE_FRAME_ATTEMPTS_20261028'
CURRENT = 'f9a9a4184ba6689abc778ff68e391b1b2dd75834'
SOURCE = '8af73b9c59219270064d4197a2b634bac840991a'
SOURCE_TREE = '73996cad8c29574a36ab21013234515016c57db0'
SOURCE_PR = 752
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'online-recharge')
PRESERVED = ('admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge', 'online-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
API_MODULES = ['id-business-v2/online-recharge/persistence/artifacts.repository.js',
               'id-business-v2/online-recharge/persistence/diagnostic-contract.js']
SEALED = {'sources': '3cdf22a8934f66743a55542ab36ffae4ec11d964ee185230fd1bfcf7f16be8af', 'beforeEngineFiles': '8053e1947617f27a8158f5427494b9c36102c464ffd5ca27cd42d747c1f8e47c', 'afterEngineFiles': '6fb97ea6020e0f44227f2dc64b86d8457f1f980b3ba094ab79b8abca3ec1194d', 'beforeApiModules': '65772bc015a9a099070cfe49ba79605c5e66334f08bf417ea31c89b3791da46b', 'expectedApiOnlineFiles': 'e8f8ccb2c101dbe772640c3818d53fed6c9ea37ea62df658ccd47a238e6ff624', 'baselineAdminFiles': '02c5f8f021fa863cecc389912932096d928a3489dfc2c13ca50dcdfec7e701b8', 'parentArtifact': 'fd643aa84c0a17f296b5fb19cf2d4fdd544aed05b6a9963f206cecdab3e4c38d', 'publishedOverlays': 'ff7010c53510841de02cae9346e62ff1244a8d0a9c3110d29681918293fdd9d0', 'backupNormalizerPath': '7d678c7771c072ec77e01a7001abc3434ac14cea56c9f5484a00402e3ca1acf6', 'engineHealth': '0fe609fb203d77fd628e5d16c629b37429b488e69386eecc2402c87bc14b5430', 'configurationFiles': 'b109415552aeb6ba2bd631f62afb4d2635a01b0f9f4e8f6082097ca483231cdc'}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_FRAME_ATTEMPTS_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('frame_attempts_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == SOURCE_PR and c.get('sourceBase') == CURRENT, 'IDENTITY_CHANGED')
    need(c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('migrationPerformed') is False and type(c.get('businessActions')) is int
         and c['businessActions'] == 0, 'SIDE_EFFECT_SCOPE')
    need(bool(SEALED) and all(sha(canonical(c.get(k))) == v for k, v in SEALED.items()), 'FROZEN_INPUT_CHANGED')
    need(len(c['sources']) == 10 and c['apiModules'] == API_MODULES, 'SOURCE_SCOPE')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) == set(after) and {ENGINE + n: v for n, v in after.items() if before.get(n) != v}
         == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(set(c['beforeApiModules']) == {n.removesuffix('.js') + e for n in API_MODULES for e in ('.js', '.js.map', '.d.ts')}
         and c['parentArtifact']['commit'] == CURRENT and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py'], 'PARENT_CHANGED')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('tree') == SOURCE_TREE
         and q['source'].get('pullRequest') == SOURCE_PR and q.get('control', {}).get('pullRequest', 0) > SOURCE_PR
         and q['control'].get('tree') == tree and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for name in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{64}', q[name].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[name].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def validate_capture(capture, c):
    baseline = capture.get('baseline', {})
    need(capture.get('status') == 'ONLINE_FRAME_ATTEMPTS_PARENT_VERIFIED' and capture.get('businessActions') == 0
         and capture.get('parentProofSha256') == c['parentArtifact']['buildProofSha256']
         and baseline.get('expectedCurrent') == CURRENT
         and set(baseline) == {'current', 'expectedCurrent', 'manifestSha256', 'services', 'runtimeConfigurationSha256',
                               'configurationSha256', 'beforeApiOnlineFiles', 'backupNormalizerPath', 'nginxSha256', 'publishedOverlays'}
         and set(baseline['services']) == set(SERVICES)
         and baseline['beforeApiOnlineFiles'] == c['expectedApiOnlineFiles']
         and baseline['backupNormalizerPath'] == c['backupNormalizerPath']
         and baseline['publishedOverlays'] == c['publishedOverlays'], 'PARENT_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    verify_quality(proof['qualitySourceEvidence'], plan['commit'], plan['tree'])
    validate_capture(proof['nativeParentCapture'], c)
    selected = {n.removesuffix('.js') + e for n in API_MODULES for e in ('.js', '.js.map')}
    declarations = {n: v for n, v in c['beforeApiModules'].items() if n.endswith('.d.ts')}
    expected = {**{'source/' + n: v for n, v in c['sources'].items()},
                **{'api/modules/' + n: v for n, v in proof['apiModules'].items()},
                **{'engine/' + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v}}
    need(all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'contractSha256', 'workflowRunId', 'workflowRunAttempt'))
         and proof.get('version') == 1 and proof.get('scope') == SCOPE and proof.get('sources') == c['sources']
         and proof['nativeParentCapture'] == plan['nativeParentCapture']
         and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('baselineApiReproduced') is True and set(proof['apiModules']) == selected
         and proof.get('preservedApiDeclarations') == declarations
         and proof.get('baselineAdminFiles') == proof.get('adminFiles') == c['baselineAdminFiles']
         and proof.get('migrationPerformed') is False and type(proof.get('businessActions')) is int
         and proof['businessActions'] == 0 and files == expected == proof['files'], 'PAYLOAD_SCOPE_CHANGED')


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
                value.update(applicationCommit=value['commit'], controlCommit=value['commit'], version='v2-' + value['commit'],
                             sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_FRAME_ATTEMPTS_OVERLAY')
                path.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
                return point(target, stamp)

            d.point_current = point_current
            return d

        module.load_utilities = utilities
    elif name == 'proxy-result-identity-release.py':
        module.claim_markers = retired.claim_retired_markers
    return module


def capture(c):
    validate_contract(c)
    h = helpers('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    core = load(PREFIX + '-core.py')
    core.load = helpers
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'CURRENT_PATH')
        raw = (current / 'release-manifest.json').read_bytes()
        need(json.loads(raw).get('commit') == CURRENT and json.loads(raw).get('status') == 'DEPLOYED', 'CURRENT_CHANGED')
        for row in c['publishedOverlays']:
            need(sha((current / row['proofFile']).read_bytes()) == row['proofSha256'], 'PARENT_PROOF_CHANGED')
        states = h.snapshot(d, current)
        receipt = json.loads((current / 'mailbox-validity-preservation.json').read_bytes())
        need(states == receipt['after'], 'PARENT_SERVICES_CHANGED')
        baseline = {'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw), 'services': states,
                    'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
                    'configurationSha256': {n: sha((current / n).read_bytes()) for n in c['configurationFiles']},
                    'beforeApiOnlineFiles': c['expectedApiOnlineFiles'], 'backupNormalizerPath': c['backupNormalizerPath'],
                    'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
                    'publishedOverlays': c['publishedOverlays']}
        core.baseline(d, {**c, **baseline}, h)
        core.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
        core.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['beforeApiModules'])
        return {'status': 'ONLINE_FRAME_ATTEMPTS_PARENT_VERIFIED', 'baseline': baseline,
                'parentProofSha256': c['parentArtifact']['buildProofSha256'], 'businessActions': 0}


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    if plan['mode'] == 'parent':
        return capture(c)
    validate_capture(plan['nativeParentCapture'], c)
    core = load(PREFIX + '-core.py')
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
    return core.release(plan, {**c, **plan['nativeParentCapture']['baseline']})


def failure_report(error, plan):
    code = str(error)
    if not re.fullmatch('[A-Z][A-Z0-9_]{1,120}', code):
        code = 'ONLINE_FRAME_ATTEMPTS_REMOTE_FAILED'
    return {'status': 'FAILED', 'code': code, 'mode': plan['mode'], 'businessActions': 0}
