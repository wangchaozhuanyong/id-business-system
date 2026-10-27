"""Finite three-service checkout-read diagnostic overlay; no recharge or database actions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-checkout-read'
SCOPE = 'ONLINE_CHECKOUT_READ_20261027'
CURRENT = '22b8104469b5dd0fa364c38a05f0985a572528a0'
SOURCE = '8a861c05f475d3fa3ccef9d045ed2ddec42f8416'
SOURCE_TREE = '7ddb761f216b8fb64e308ec569b3c0287b0c93ca'
SOURCE_PR = 748
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
SERVICES = (*UPDATED, *PRESERVED)
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
API_MODULES = ['id-business-v2/online-recharge/persistence/artifacts.repository.js', 'id-business-v2/online-recharge/persistence/diagnostic-contract.js']
SEALED = {'sources': '9afdef2e07bf0169238220b92b5970ca37310633c4901de42187953c84ec20fb', 'beforeEngineFiles': 'd5d697db2cbe59c9bf5165552289f123d9135c8a402774254cd59aa64c700699', 'afterEngineFiles': '8053e1947617f27a8158f5427494b9c36102c464ffd5ca27cd42d747c1f8e47c', 'beforeApiModules': '5a9510113e48ab48da66609fac6846e1e8311bdbb593840927d1fef60e17e02b', 'expectedApiOnlineFiles': '289abd7a890e42062a7c328c59c18d04d56fada2372d2cae41d97dfb3283b36c', 'baselineAdminFiles': 'cb069d3fdde1a6a7848d0a24c4908adc991a34c1cba76bc408a93af32fe37050', 'parentArtifact': 'f82103a38d265a0860b176e12d4f1435e6c0550d32f882cf80712ed4f0040843', 'reproductionArtifact': 'e34910fa0f25b030d2eaabbd6a6b05a56d1720a7a3fa20af9b0acf8cb04b9564', 'backupNormalizerPath': '7d678c7771c072ec77e01a7001abc3434ac14cea56c9f5484a00402e3ca1acf6', 'engineHealth': '0fe609fb203d77fd628e5d16c629b37429b488e69386eecc2402c87bc14b5430'}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_READ_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location('checkout_read_' + name.replace('-', '_'), HERE / name)
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
    need(all(sha(canonical(c.get(key))) == digest for key, digest in SEALED.items()), 'FROZEN_INPUT_CHANGED')
    need(len(c['sources']) == 16 and c['apiModules'] == API_MODULES
         and set(c['beforeApiModules']) == {n.removesuffix('.js') + e for n in API_MODULES if n not in c['newApiModules'] for e in ('.js', '.js.map', '.d.ts')}, 'SOURCE_SCOPE')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) == set(after)
         and {ENGINE + n: v for n, v in after.items() if before.get(n) != v}
         == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(c['parentArtifact']['commit'] == CURRENT
         and c['newApiModules'] == [API_MODULES[1]]
         and c['reproductionArtifact']['commit'] == 'c2e6f43a48ad471a5cab0a7f40da796a4d19c1c0'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_OR_FENCE_CHANGED')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('tree') == SOURCE_TREE
         and q['source'].get('pullRequest') == SOURCE_PR
         and q.get('control', {}).get('pullRequest', 0) > SOURCE_PR
         and q['control'].get('tree') == tree and q.get('main', {}).get('head') == commit, 'QUALITY_REQUIRED')
    for name in ('source', 'control'):
        need(re.fullmatch('[a-f0-9]{64}', q[name].get('sourceReceiptSha256', ''))
             and re.fullmatch('[1-9][0-9]*', q[name].get('runId', '')), 'QUALITY_RECEIPT_REQUIRED')


def validate_capture(capture, c):
    baseline = capture.get('baseline', {})
    need(capture.get('status') == 'ONLINE_CHECKOUT_READ_PARENT_VERIFIED'
         and capture.get('businessActions') == 0 and capture.get('parentProofSha256') == c['parentArtifact']['buildProofSha256']
         and set(baseline) == {'current', 'expectedCurrent', 'manifestSha256', 'services', 'runtimeConfigurationSha256',
                              'configurationSha256', 'beforeApiOnlineFiles', 'backupNormalizerPath', 'nginxSha256', 'publishedOverlays'}
         and baseline.get('expectedCurrent') == CURRENT
         and baseline['beforeApiOnlineFiles'] == c['expectedApiOnlineFiles']
         and baseline['backupNormalizerPath'] == c['backupNormalizerPath']
         and baseline['publishedOverlays'] == [{'proofFile': 'online-checkout-build-proof.json',
                                               'proofSha256': c['reproductionArtifact']['buildProofSha256']},
                                               {'proofFile': 'online-country-frame-build-proof.json',
                                                'proofSha256': c['parentArtifact']['buildProofSha256']}], 'PARENT_CHANGED')


def verify_proof(proof, plan, c, files):
    validate_contract(c)
    verify_quality(proof['qualitySourceEvidence'], plan['commit'], plan['tree'])
    capture = proof.get('nativeParentCapture', {})
    need(capture == plan.get('nativeParentCapture'), 'PARENT_CHANGED')
    validate_capture(capture, c)
    core = load('online-checkout-release.py')
    core.SCOPE = SCOPE
    core.verify_proof(proof, plan, {**c, **capture['baseline']}, files)


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
                             sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_CHECKOUT_READ_OVERLAY')
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
    validate_contract(c)
    h = helpers('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    core = load('online-checkout-release.py')
    core.load = helpers
    with (BASE / '.deploy.lock').open('a') as lock:
        load('recharge-availability-release.py').acquire_release_lock(lock)
        current = (BASE / 'current').resolve(strict=True)
        need(current.parent == BASE / 'releases', 'CURRENT_PATH')
        raw = (current / 'release-manifest.json').read_bytes()
        manifest = json.loads(raw)
        need(manifest.get('commit') == CURRENT and manifest.get('status') == 'DEPLOYED', 'CURRENT_CHANGED')
        proof_raw = (current / 'online-country-frame-build-proof.json').read_bytes()
        full_raw = (current / 'online-checkout-build-proof.json').read_bytes()
        need(sha(full_raw) == c['reproductionArtifact']['buildProofSha256'], 'FULL_PARENT_PROOF_CHANGED')
        published = json.loads(full_raw)
        need(sha(proof_raw) == c['parentArtifact']['buildProofSha256'], 'PARENT_PROOF_CHANGED')
        parent = json.loads(proof_raw)
        need(parent['afterEngineFiles'] == c['beforeEngineFiles'] and published['adminFiles'] == c['baselineAdminFiles'], 'PARENT_RUNTIME_CHANGED')
        states = h.snapshot(d, current)
        receipt = json.loads((current / 'online-country-frame-preservation.json').read_bytes())
        need(states == receipt['after'], 'PARENT_SERVICES_CHANGED')
        baseline = {
            'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw), 'services': states,
            'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'beforeApiOnlineFiles': c['expectedApiOnlineFiles'], 'backupNormalizerPath': c['backupNormalizerPath'],
            'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
            'publishedOverlays': [{'proofFile': 'online-checkout-build-proof.json', 'proofSha256': sha(full_raw)},
                                  {'proofFile': 'online-country-frame-build-proof.json', 'proofSha256': sha(proof_raw)}]}
        core.baseline(d, {**c, **baseline}, h)
        core.read_hashes(d, states['admin']['containerId'], '/usr/share/nginx/html/', c['baselineAdminFiles'])
        core.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['beforeApiModules'])
        return {'status': 'ONLINE_CHECKOUT_READ_PARENT_VERIFIED', 'baseline': baseline,
                'parentProofSha256': sha(proof_raw), 'businessActions': 0}


def release(plan, c):
    validate_contract(c)
    need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
         and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}
         and all(sha((HERE / n).read_bytes()) == v for n, v in plan['controlSources'].items()), 'CONTROL_CHANGED')
    if plan['mode'] == 'parent':
        return capture(c)
    validate_capture(plan['nativeParentCapture'], c)
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
    return core.release(plan, {**c, **plan['nativeParentCapture']['baseline']})


def failure_report(error, plan):
    import traceback
    code = str(error)
    if not re.fullmatch('[A-Z][A-Z0-9_]{1,120}', code):
        code = 'ONLINE_CHECKOUT_READ_REMOTE_FAILED'
    return {'status': 'FAILED', 'mode': plan['mode'], 'code': code, 'businessActions': 0,
            'frames': [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                       for f in traceback.extract_tb(error.__traceback__)[-6:]]}
