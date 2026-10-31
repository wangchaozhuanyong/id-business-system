"""Reviewed proxy/connection diagnostic executor overlay. No API rebuild or business action."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-session-observer'
SCOPE = 'ONLINE_SESSION_OBSERVER_20261031'
CURRENT = '8ff49238b47a5c227fce70dfbb057ce3ce526ca7'
SOURCE = '0529cfdcbb754ddf3d2af1fbf5549c50974f8208'
SOURCE_TREE = '7e4f33f4f5d6aa03f88f856cffb6b22f0bfe5c6e'
SOURCE_PR = 764
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('SOURCE_MANIFEST.json', 'session-connection-diagnostics.cjs', 'test/session-connection-diagnostics.test.cjs', 'test/session-request-observation.test.cjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')
SEALED = {'beforeEngineFiles': '867d21cd418f91c7040d49ea81077ec6fb2fd368adcf69597d25f6d0f6776469', 'afterEngineFiles': '746b9b3814405d14abcc07cd4ff03c79ce84274cde1e3001b484fbeeaa7576d7', 'runtimeSources': '654bb4ee65f3a19b1dbc3911cbf3dc065228a8e1388b58a2557a7e24c1c507d4', 'validationSources': '9187f0259fbed2360c40b7915756d2b33b92cb9f8496cfa2f3f56617f50b165e', 'baseline': 'eb603127f4bbe2edc27c9ecdadd7623cf2aa3c5d4fa1b929a7e79d9a42056c43', 'parentProofSha256': '4948e0674f9b183dcf0b5d6e584c383e7348267da39a097076d3b6bee0b472e8', 'parentPreservationSha256': '832b28311975389a36c8f944d00420fdf8a6e9b4cc239bbdc343a134296000be'}
HELPER_PINS = {'api-admin-pending-projection.py': '592aebbeb7c8605587924416b0632dc4533eacfb3305793b577db3827bbf8d78', 'api-admin-pending-receipt-wire.py': '47cba3fad47077f30c83d8cfe5a8907b797eeeb2fedd78e764a47a42a0849c75', 'api-admin-readonly.py': 'dd43d93b8383867de34b2d0d0aacc282135852e76b4adc8348141e9cfc330949', 'api-admin-scope.py': '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'api-workspace-declaration-artifacts.py': 'bff9bdfecb8e53be3b9a04294acaa6f3d6982ef1cf0e6c392808197413de54fe', 'bitbrowser-history-release.py': '61df1e9875f3edde18cf6826b06ed6be7dd543ad39dde279828d4f06c1255410', 'online-checkout-actionability-release.py': '8c6cb5e392d162cc13565b7bab673e3396641b6ebbbc6c5307c3b667e6d9622c', 'online-checkout-initialization-release.py': '3dde1aa3b134f87b31fcbe647e7655f2d62ce87513227c49b43189cebd0689f2', 'online-checkout-load-release.py': '50f9608895bf0072c38a2549a8db70c941316339c3a4626b179ca8b016078374', 'online-checkout-release.py': '387b120904453ba25c47070551389db6a33668ef1f62220ce8d8ebe740bf810d', 'online-native-fetch-release.py': 'e861216b6c903763b2373b1091f50dc48a4b3ef9d9156435c9b3238e4cdcb654', 'online-pending-features-release.py': '9895b3f00f7e9d1d147c0dc7fa0ad57bec22e27e8bd1183238d86a77e1310993', 'online-profile-lock-recovery.py': 'bda837bfe6b6b8ca91f356fe780c13d75de15928d017a1fe6780d7b481065b58', 'online-query-network-release.py': '102f47d1dfd7eded71375da1d4e78215d48f8e20e9b4c11fabe1803331f98ce0', 'online-recharge-component-consumer.py': 'b7979889d857f45d7d7eac87d475e06ab8312669dfb5952120cf7f58b1318ed6', 'online-recharge-component-readonly.py': 'c978531fe72da209e6b3da94b6df41ff4c1d4df7722bcb30f374ed25a74dccfc', 'online-recharge-component-recovery.py': '4def2e982a58dd15ed89b8230db35b7497c7a8ad0e5aed5172aa65698ca8984a', 'online-recharge-component-runtime.py': 'c3d76849421b1dbbba143138e316a3ae16a6ec4498eb577a9954f630375feb17', 'online-recharge-daemon-identity.py': '2b3698ed515d5428535e16190e7ca32f92e02493d2e498f39c22753921eb1ecb', 'online-recharge-daemon-listener.py': 'b4ca705bb87dea45b3d0492c33a0e14e2c02f1707e94bc630d16a313db3b3e85', 'online-recharge-daemon-socket.py': 'cba4b37317e8f48778c0dbc59f2c3131340f7d769b2807d0e03fe7c4d37e511a', 'online-recharge-declaration-measurement.py': '6fb65068cfe5daca4a879fe9a02449575f803dadcf7d47aae29ecb1ed958b0aa', 'online-recharge-readonly.py': '4316695ff96b898ba92be03da1a0ba230b09f8c2417c820a6ccd0b5504577b2d', 'online-recharge-scope.py': '49fd788aac7807365f1078790f5a439fc1c7807150253eb66bd47ef793e81bb9', 'online-session-diagnostic-build.py': '86f8583fac560a74befa79d1e3a4af52b2caf80f5c6ad1850d49a943f5ffc71e', 'online-session-diagnostic-contract.json': 'adfdbba8749635fe33b1891d990eee67ea7101aeb8d6f5bfa3fb0bffe1233e2e', 'online-session-diagnostic-publication.py': '813f79a70dd95680c5700a52f16eeee8b5abde938983c89911d59ae944e17693', 'online-session-diagnostic-release.py': '0b95db3dd156f90981cda535591bb9f76febc5f7d4bceda1a317bfd069b486e6', 'online-unpaid-validation-release.py': '869d40d287567eeb901aae413d366444ca077431a433341312fcc90ec8cd4e56', 'proxy-result-identity-release.py': '97207252c12924dcbbfe3e86ebf397e928cd9545bbf9260337fd94ffd5109d45', 'recharge-availability-release.py': 'd98af117f3d80e705dd4f5eb3375a37cf4c0f058b65f4be77550d909ccbbe66c', 'recharge-billing-release.py': 'eabb3473e5639edaf7073cb71562bfca4d7208bc7856d1262ce904202dedafd7', 'recharge-checkout-release.py': 'd8f899062b01f80b4ea002c62a7af0042bb19962394d55ea07241783e332624a', 'recharge-record-contract.json': '645884385b0ad22e31496f31e3b3e07adf69e2c3d37bcf93ed886af7fbd2221c', 'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f', 'recharge-source-recovery-release.py': 'e6f493ab7737bf77d23114a00ff9c970a77d18786726e690b27dbe98c9f099b8', 'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c', 'shared-bank-card-contract.json': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'shared-bank-card-release.py': '003ddac5dceb7388c79529bced489a008fa4597073df6c6b441629b5dfb46852', 'unpublished-component-successor.py': '930c552ee5599ea0b7014426749019e257421878c9bf49fbffdf82a07627b771'}


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_SESSION_OBSERVER_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    need(re.fullmatch('[a-z0-9.-]+', name), 'HELPER_NAME')
    spec = importlib.util.spec_from_file_location('region_' + name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == SOURCE_PR, 'IDENTITY_CHANGED')
    need(c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
         and type(c.get('businessActions')) is int and c['businessActions'] == 0
         and c.get('migrationPerformed') is False, 'SIDE_EFFECT_SCOPE')
    need(bool(SEALED) and all(sha(canonical(c.get(k))) == v for k, v in SEALED.items()), 'FROZEN_INPUT_CHANGED')
    need(set(c['controlPins']) == set(HELPER_PINS) | {PREFIX + '-' + n for n in
         ('release.py', 'publication.py', 'release.test.py')}
         and all(c['controlPins'].get(n) == v for n, v in HELPER_PINS.items()), 'CONTROL_SCOPE_CHANGED')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) <= set(after) and {n for n in after if before.get(n) != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and c['baseline']['commit'] == CURRENT and c['baseline']['database']['pending'] == 0
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'FINITE_SCOPE')


def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == SOURCE_PR
         and q['source'].get('tree') == SOURCE_TREE
         and q.get('control', {}).get('pullRequest', 0) > SOURCE_PR and q['control'].get('tree') == tree
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
         and type(proof.get('businessActions')) is int and proof['businessActions'] == 0
         and proof.get('migrationPerformed') is False
         and files == proof.get('files') == {'engine/' + n: c['afterEngineFiles'][n] for n in FILES}, 'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], proof['commit'], proof['tree'])
    need(proof['nativeParentCapture'].get('status') == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED'
         and proof['nativeParentCapture']['baseline'] == c['baseline'], 'PARENT_CHANGED')


def profile_unlocked(d, state):
    code = "const fs=require('fs'),p=require('path');const r=process.env.ONLINE_RECHARGE_PROFILE_ROOT||p.join(process.env.ONLINE_RECHARGE_RUNTIME_DIR||'/workspace/runtime','browser-profiles');let profiles=0,locks=0;if(fs.existsSync(r))for(const e of fs.readdirSync(r,{withFileTypes:true})){if(!e.isDirectory())continue;profiles++;for(const n of ['SingletonLock','SingletonCookie','SingletonSocket'])try{fs.lstatSync(p.join(r,e.name,n));locks++;}catch(e){if(e.code!=='ENOENT')throw e;}}console.log(JSON.stringify({profiles,locks}));"
    result = json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=30))
    need(type(result.get('profiles')) is int and result['profiles'] > 0
         and type(result.get('locks')) is int and result['locks'] == 0, 'PROFILE_RECOVERY_REQUIRED')


def engine(c, plan):
    impl = load('online-native-fetch-release.py')
    for name in ('PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'ENGINE', 'FILES', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.validate_contract, impl.verify_quality, impl.verify_proof = validate_contract, verify_quality, verify_proof
    core = impl.engine(c, plan)
    original_helpers = core.LEGACY.helpers

    def helpers():
        values = original_helpers()
        driver = values[2]
        point_current = driver.point_current

        def point_region_current(target, stamp):
            path = target / 'release-manifest.json'
            manifest = json.loads(path.read_bytes())
            manifest.update(applicationCommit=manifest['commit'], controlCommit=manifest['commit'],
                            version='v2-' + manifest['commit'],
                            sourceLayout='PUBLISHED_PREDECESSOR_WITH_REVIEWED_SESSION_OBSERVER_OVERLAY')
            path.write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            return point_current(target, stamp)

        driver.point_current = point_region_current
        return values

    core.LEGACY.helpers = helpers
    baseline = core.baseline

    def checked_baseline(d, h, contract):
        result = baseline(d, h, contract)
        current = result[0]
        need(sha((current / 'online-frame-attempts-build-proof.json').read_bytes()) == c['parentProofSha256']
             and sha((current / 'online-frame-attempts-preservation.json').read_bytes()) == c['parentPreservationSha256'], 'PARENT_PROOF_CHANGED')
        profile_unlocked(d, result[2]['online-recharge'])
        return result

    core.baseline = checked_baseline
    return core


def capture(c):
    core = engine(c, {})
    h, _old, d, availability, _p, _retired = core.LEGACY.helpers()
    with (BASE / '.deploy.lock').open('r') as lock:
        availability.acquire_release_lock(lock)
        core.baseline(d, h, c)
        return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': copy.deepcopy(c['baseline']), 'businessActions': 0}


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}
             and all(not (HERE / n).is_symlink() and sha((HERE / n).read_bytes()) == v
                     for n, v in plan['controlSources'].items()), 'PARENT_PLAN_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, copy.deepcopy(c))


def failure_report(error, plan):
    return load('online-native-fetch-release.py').failure_report(error, plan)
