"""Finite artifact-validator/API and executor diagnostic overlay; no business actions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-proxy-failure-evidence'
SCOPE = 'ONLINE_PROXY_FAILURE_EVIDENCE_20261025'
CURRENT = '3d7ff9d0721c158289b25c3f6fadb96ad859fc31'
SOURCE = 'd8bd4086607666d3f2a0b5425e75f0ac1d84dccd'
SOURCE_TREE = 'bad8374fcb1b56dc25834fd4f1c426dcbb60f7ee'
CONTRACT_FILE = PREFIX + '-contract.json'
UPDATED = ('api', 'admin', 'online-recharge')
PRESERVED = ('mysql', 'caddy', 'media-resolver', 'auto-recharge')
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
SOURCES = frozenset(['apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.spec.ts', 'apps/admin/src/v2/features/online-recharge/unpaid-validation-labels.ts', 'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json', 'apps/api/src/id-business-v2/online-recharge/engine/test/browser-profile.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/recharge-flow-acceptance.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/unpaid-validation.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/unpaid-validation.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.repository.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/artifacts.unpaid.spec.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])
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
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourcePullRequest') == 710, 'CONTRACT_IDENTITY')
    need(c.get('updatedServices') == list(UPDATED) and c.get('preservedServices') == list(PRESERVED)
         and c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('migrationPerformed') is False and c.get('businessActions') == 0, 'SIDE_EFFECT_SCOPE')
    need(c.get('apiModules') == API and set(c.get('sources', {})) == SOURCES and len(SOURCES) == 12
         and all(re.fullmatch('[a-f0-9]{64}', v) and '..' not in Path(n).parts for n, v in c['sources'].items()), 'SOURCE_SCOPE')
    need(sha(canonical(c['sources'])) == 'e26d11afb7dd17284acfa07066eac91f334132bf33270d1299367118488febe7' and sha(canonical(c['expectedApiFiles'])) == '00f4ed83b408868813d15be61dbce02b8ab1b6ed1ec220e1f0d4014af8775f97', 'SOURCE_RUNTIME_HASHES_CHANGED')
    need(set(c['beforeEngineFiles']) == set(c['afterEngineFiles']) and {
        ENGINE + n: v for n, v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v
    } == {n: v for n, v in c['sources'].items() if n.startswith(ENGINE)}, 'ENGINE_DELTA')
    need(c['parentPlan']['commit'] == CURRENT and c['parentPlan']['workflowRunId'] == '40176051849'
         and c['parentArtifact']['commit'] == CURRENT
         and c['parentArtifact']['buildProofSha256'] == 'f5fa702ee0a1b750caf165fd7c836cc2483403034ee5e2234c5be4788045555f'
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_BINDING')


def verify_quality(q, commit, tree):
    source_tree = SOURCE_TREE
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 710
         and q['source'].get('tree') == source_tree
         and q.get('control', {}).get('pullRequest', 0) > 710 and q['control'].get('tree') == tree
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
    impl.verify_proof = verify_payload
    return impl


def verify_payload(proof, plan, c, files):
    validate_contract(c)
    verify_quality(proof.get('qualitySourceEvidence', {}), plan['commit'], plan['tree'])
    need(proof.get('qualitySourceEvidence') == plan.get('qualitySourceEvidence'), 'QUALITY_PROOF_CHANGED')
    need(proof.get('version') == 1 and proof.get('scope') == SCOPE
         and all(proof.get(k) == plan[k] for k in ('commit', 'tree', 'workflowRunId', 'workflowRunAttempt', 'contractSha256', 'controlSources'))
         and proof.get('sources') == c['sources'] and proof.get('afterEngineFiles') == c['afterEngineFiles']
         and proof.get('nativeParentCapture') == plan.get('nativeParentCapture')
         and proof.get('baselineApiReproduced') is True and proof.get('baselineAdminSourceReproduced') is True
         and proof.get('migrationPerformed') is False and proof.get('businessActions') == 0, 'PROOF_CHANGED')
    selected = {n.removesuffix('.js') + ext for n in c['apiModules'] for ext in ('.js', '.js.map', '.d.ts')}
    modules = proof.get('apiModules', {})
    need(selected <= set(modules) and all(n.startswith('id-business-v2/online-recharge/') and n.endswith('.d.ts') and '..' not in Path(n).parts for n in set(modules) - selected), 'API_MODULE_SCOPE_CHANGED')
    h = load('recharge-record-release.py')
    need(h.fingerprint(proof.get('baselineAdminFiles', {})) == c['baselineAdminFilesSha256']
         and bool(proof.get('adminFiles')) and all('..' not in Path(n).parts and not Path(n).is_absolute() and re.fullmatch('[a-f0-9]{64}', v) for n,v in proof['adminFiles'].items()), 'ADMIN_INVENTORY_CHANGED')
    expected = {**{'source/' + n: v for n,v in c['sources'].items()},
                **{'api/modules/' + n: v for n,v in modules.items()},
                **{'admin/html/' + n: v for n,v in proof['adminFiles'].items()},
                **{'engine/' + n: v for n,v in c['afterEngineFiles'].items() if c['beforeEngineFiles'].get(n) != v}}
    need(files == expected == proof['files'], 'PAYLOAD_SCOPE_CHANGED')


def verify_proof(proof, plan, c, files):
    return core().verify_proof(proof, plan, c, files)


def capture_parent(plan, c):
    # First independently verify the actual latest engine-only release. Its API
    # predecessor artifact remains the source of the exact unchanged API bytes.
    prior = load('online-card-read-diagnostics-release.py')
    receipt = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(receipt['status'] == 'ONLINE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
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
        impl.read_hashes(d, states['api']['containerId'], '/app/apps/api/dist/', c['expectedApiFiles'])
        before_api = {n.removeprefix('id-business-v2/online-recharge/'): v for n,v in c['expectedApiFiles'].items()}
        baseline = {'current': str(current), 'expectedCurrent': CURRENT, 'manifestSha256': sha(raw),
            'services': states, 'runtimeConfigurationSha256': {n: h.configuration(d, s) for n, s in states.items()},
            'configurationSha256': {n: sha((current / n).read_bytes()) for n in ('.env.aws.production', 'compose.release.json', 'docker-compose.aws-mysql.yml')},
            'beforeApiOnlineFiles': before_api, 'baselineAdminFilesSha256': h.fingerprint(parent['adminFiles']),
            'nginxSha256': d.run('docker', 'exec', states['admin']['containerId'], 'sha256sum', '/etc/nginx/conf.d/default.conf').split()[0],
            'publishedOverlays': [{'proofFile': 'online-checkout-build-proof.json', 'proofSha256': sha(parent_raw)},
                ],
        }
        impl.baseline(d, {**c, **baseline}, h)
        return {'status': 'ONLINE_CHECKOUT_RESUME_PARENT_VERIFIED', 'baseline': baseline,
                'commit': plan['commit'], 'businessActions': 0, 'migrationPerformed': False}


def release(plan, c):
    return core().release(plan, c)


def failure_report(error, plan):
    return core().failure_report(error, plan)
