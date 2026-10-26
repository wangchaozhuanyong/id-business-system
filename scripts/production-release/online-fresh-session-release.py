"""Publish only the reviewed fresh-session executor overlay; no business actions."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent
BASE = Path('/opt/id-business-v2')
PREFIX = 'online-fresh-session'
SCOPE = 'ONLINE_FRESH_SESSION_20261026'
CURRENT = '7c5ddc35e15aeecbf54f71acce96498c38b73d45'
SOURCE = '59bc900aa9f3cbdbed639a9645d9e49bf43c0539'
SOURCE_TREE = '60969b8bc7e977b3f66ab637a4211570abfae8a5'
CONTRACT_FILE = PREFIX + '-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
FILES = frozenset(('SOURCE_MANIFEST.json', 'browser-profile.cjs', 'test/browser-profile.test.cjs', 'test/checkout-form.test.cjs'))
PRESERVED = ('api', 'admin', 'mysql', 'caddy', 'media-resolver', 'auto-recharge')


SEALED = {'baseline': 'd79fe1d5a892074ebd385d71335b2028f67097f9ac53d81cd287f31b99371ad9', 'runtimeSources': 'd0ef9ba3f0b0a2bf618df1035af187702ccc27592386e10465e30d2db957d2bd', 'validationSources': 'd6ad1e79aa95c4bd5b7a05ff6986116f189c443cfd040d063494a24769d0e95a', 'beforeEngineFiles': 'e6e6ef3af2abda0b122c006e547f69730683d48075e28fba824da94ed25ebcbd', 'afterEngineFiles': 'e10ad23c2ad741228b1c228646f483e921b84d917d26b3b49a1a2a7f0752f63e', 'parentPlan': 'fe54cc65935c7c68ff8eb3bc8758674d754addc01f4d85165b82364ef0f1a187', 'parentProofSha256': 'a488290251246ab6498ff3db77007faef7d9f44e623c75b00a99ee163deab3b5', 'parentPreservationSha256': 'b686ceb1e0b738e65503dce0b925b1dedb50fce17294e980ab6e89ed896d19c2'}

HELPER_PINS = {'api-admin-pending-projection.py': '592aebbeb7c8605587924416b0632dc4533eacfb3305793b577db3827bbf8d78', 'api-admin-pending-receipt-wire.py': '47cba3fad47077f30c83d8cfe5a8907b797eeeb2fedd78e764a47a42a0849c75', 'api-admin-readonly.py': 'dd43d93b8383867de34b2d0d0aacc282135852e76b4adc8348141e9cfc330949', 'api-admin-scope.py': '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'api-workspace-declaration-artifacts.py': 'bff9bdfecb8e53be3b9a04294acaa6f3d6982ef1cf0e6c392808197413de54fe', 'bitbrowser-history-release.py': '61df1e9875f3edde18cf6826b06ed6be7dd543ad39dde279828d4f06c1255410', 'online-checkout-actionability-release.py': '8c6cb5e392d162cc13565b7bab673e3396641b6ebbbc6c5307c3b667e6d9622c', 'online-checkout-initialization-release.py': '3dde1aa3b134f87b31fcbe647e7655f2d62ce87513227c49b43189cebd0689f2', 'online-checkout-load-release.py': '50f9608895bf0072c38a2549a8db70c941316339c3a4626b179ca8b016078374', 'online-checkout-release.py': '387b120904453ba25c47070551389db6a33668ef1f62220ce8d8ebe740bf810d', 'online-native-fetch-release.py': 'e861216b6c903763b2373b1091f50dc48a4b3ef9d9156435c9b3238e4cdcb654', 'online-pending-features-release.py': '9895b3f00f7e9d1d147c0dc7fa0ad57bec22e27e8bd1183238d86a77e1310993', 'online-profile-lock-recovery.py': 'bda837bfe6b6b8ca91f356fe780c13d75de15928d017a1fe6780d7b481065b58', 'online-query-network-release.py': '102f47d1dfd7eded71375da1d4e78215d48f8e20e9b4c11fabe1803331f98ce0', 'online-recharge-component-consumer.py': 'b7979889d857f45d7d7eac87d475e06ab8312669dfb5952120cf7f58b1318ed6', 'online-recharge-component-readonly.py': 'c978531fe72da209e6b3da94b6df41ff4c1d4df7722bcb30f374ed25a74dccfc', 'online-recharge-component-recovery.py': '4def2e982a58dd15ed89b8230db35b7497c7a8ad0e5aed5172aa65698ca8984a', 'online-recharge-component-runtime.py': 'c3d76849421b1dbbba143138e316a3ae16a6ec4498eb577a9954f630375feb17', 'online-recharge-daemon-identity.py': '2b3698ed515d5428535e16190e7ca32f92e02493d2e498f39c22753921eb1ecb', 'online-recharge-daemon-listener.py': 'b4ca705bb87dea45b3d0492c33a0e14e2c02f1707e94bc630d16a313db3b3e85', 'online-recharge-daemon-socket.py': 'cba4b37317e8f48778c0dbc59f2c3131340f7d769b2807d0e03fe7c4d37e511a', 'online-recharge-declaration-measurement.py': '6fb65068cfe5daca4a879fe9a02449575f803dadcf7d47aae29ecb1ed958b0aa', 'online-recharge-readonly.py': '4316695ff96b898ba92be03da1a0ba230b09f8c2417c820a6ccd0b5504577b2d', 'online-recharge-scope.py': '49fd788aac7807365f1078790f5a439fc1c7807150253eb66bd47ef793e81bb9', 'online-session-diagnostic-build.py': '86f8583fac560a74befa79d1e3a4af52b2caf80f5c6ad1850d49a943f5ffc71e', 'online-session-diagnostic-contract.json': 'adfdbba8749635fe33b1891d990eee67ea7101aeb8d6f5bfa3fb0bffe1233e2e', 'online-session-diagnostic-publication.py': '813f79a70dd95680c5700a52f16eeee8b5abde938983c89911d59ae944e17693', 'online-session-diagnostic-release.py': '0b95db3dd156f90981cda535591bb9f76febc5f7d4bceda1a317bfd069b486e6', 'online-unpaid-validation-release.py': '869d40d287567eeb901aae413d366444ca077431a433341312fcc90ec8cd4e56', 'proxy-result-identity-release.py': '97207252c12924dcbbfe3e86ebf397e928cd9545bbf9260337fd94ffd5109d45', 'recharge-availability-release.py': 'd98af117f3d80e705dd4f5eb3375a37cf4c0f058b65f4be77550d909ccbbe66c', 'recharge-billing-release.py': 'eabb3473e5639edaf7073cb71562bfca4d7208bc7856d1262ce904202dedafd7', 'recharge-checkout-release.py': 'd8f899062b01f80b4ea002c62a7af0042bb19962394d55ea07241783e332624a', 'recharge-record-contract.json': '645884385b0ad22e31496f31e3b3e07adf69e2c3d37bcf93ed886af7fbd2221c', 'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f', 'recharge-source-recovery-release.py': 'e6f493ab7737bf77d23114a00ff9c970a77d18786726e690b27dbe98c9f099b8', 'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c', 'shared-bank-card-contract.json': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'shared-bank-card-release.py': '003ddac5dceb7388c79529bced489a008fa4597073df6c6b441629b5dfb46852', 'unpublished-component-successor.py': '930c552ee5599ea0b7014426749019e257421878c9bf49fbffdf82a07627b771'}

def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_FRESH_SESSION_' + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_contract(c):
    need(c.get('version') == 1 and c.get('scope') == SCOPE and c.get('expectedCurrent') == CURRENT
         and c.get('sourceReviewCommit') == SOURCE and c.get('sourceReviewTree') == SOURCE_TREE
         and c.get('sourcePullRequest') == 738, 'CONTRACT_IDENTITY')
    need(c.get('awsTargetAccount') == '098208446664' and c.get('awsTargetInstance') == 'i-0838cebf64f0e2a89'
         and c.get('updatedServices') == ['online-recharge'] and c.get('preservedServices') == list(PRESERVED)
         and c.get('businessActions') == 0 and type(c['businessActions']) is int
         and c.get('migrationPerformed') is False, 'SIDE_EFFECT_SCOPE')
    need(all(sha(canonical(c.get(key))) == digest for key, digest in SEALED.items()), 'FROZEN_INPUT_CHANGED')
    need(set(c['controlPins']) == set(HELPER_PINS) | {PREFIX + '-' + n for n in
         ('release.py', 'publication.py', 'release.test.py')}
         and all(c['controlPins'].get(n) == v for n, v in HELPER_PINS.items()), 'CONTROL_SCOPE_CHANGED')
    before, after = c['beforeEngineFiles'], c['afterEngineFiles']
    need(set(before) == set(after) and {n for n in before if before[n] != after[n]} == FILES
         and c['runtimeSources'] == {ENGINE + n: after[n] for n in FILES}
         and set(c['validationSources']) == {'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'}, 'FINITE_SCOPE')
    need(c['parentPlan']['commit'] == CURRENT and c['parentPlan']['buildProofSha256'] == c['parentProofSha256']
         and c['sqlFenceHelperSha256'] == c['controlPins']['api-admin-scope.py']
         == '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'PARENT_OR_FENCE_CHANGED')

def verify_quality(q, commit, tree):
    need(q.get('commit') == commit and q.get('tree') == tree
         and q.get('source', {}).get('head') == SOURCE and q['source'].get('pullRequest') == 738
         and q['source'].get('tree') == SOURCE_TREE
         and q.get('control', {}).get('pullRequest', 0) > 738 and q['control'].get('tree') == tree
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
         and proof.get('businessActions') == 0 and proof.get('migrationPerformed') is False
         and files == proof.get('files') == {'engine/' + n: c['afterEngineFiles'][n] for n in FILES}, 'BUILD_PROOF_CHANGED')
    verify_quality(proof['qualitySourceEvidence'], proof['commit'], proof['tree'])
    need(proof['nativeParentCapture'].get('status') == 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED'
         and proof['nativeParentCapture']['baseline'] == c['baseline'], 'PARENT_CHANGED')


def profile_unlocked(d, state):
    code = "const fs=require('fs'),p=require('path');const r=process.env.ONLINE_RECHARGE_PROFILE_ROOT||p.join(process.env.ONLINE_RECHARGE_RUNTIME_DIR||'/workspace/runtime','browser-profiles');let profiles=0,locks=0;if(fs.existsSync(r))for(const e of fs.readdirSync(r,{withFileTypes:true})){if(!e.isDirectory())continue;profiles++;for(const n of ['SingletonLock','SingletonCookie','SingletonSocket'])try{fs.lstatSync(p.join(r,e.name,n));locks++;}catch(e){if(e.code!=='ENOENT')throw e;}}console.log(JSON.stringify({profiles,locks}));"
    result = json.loads(d.run('docker', 'exec', state['containerId'], 'node', '-e', code, timeout=30))
    # This engine-only publication never clears locks while the preserved API is running.
    # An unexpected lock requires the existing separately measured offline recovery.
    need(type(result.get('profiles')) is int and result['profiles'] > 0
         and type(result.get('locks')) is int and result['locks'] == 0, 'PROFILE_RECOVERY_REQUIRED')


def capture(c):
    prior = load('online-session-diagnostic-release.py')
    parent = prior.release({**c['parentPlan'], 'mode': 'readback'},
                           json.loads((HERE / prior.CONTRACT_FILE).read_bytes()))
    need(parent.get('status') == 'ONLINE_CHECKOUT_INDEPENDENT_READBACK_VERIFIED', 'PARENT_READBACK_FAILED')
    h = prior.helpers('recharge-record-release.py')
    d = h.load_utilities(HERE / 'remote-deploy.py', c['controlPins']['remote-deploy.py'])
    current = (BASE / 'current').resolve(strict=True)
    raw = (current / 'release-manifest.json').read_bytes()
    need(str(current) == c['baseline']['current'] and sha(raw) == c['baseline']['manifestSha256']
         and json.loads(raw).get('commit') == CURRENT, 'CURRENT_CHANGED')
    need(sha((current / 'online-checkout-build-proof.json').read_bytes()) == c['parentProofSha256']
         and sha((current / 'online-checkout-preservation.json').read_bytes()) == c['parentPreservationSha256'], 'PARENT_CHANGED')
    states = h.snapshot(d, current)
    history = load('bitbrowser-history-release.py')
    history.MODULES = frozenset()
    normalizer = Path(c['baseline']['backupNormalizerPath'])
    need(normalizer.is_file() and not normalizer.is_symlink()
         and normalizer.is_relative_to(BASE / 'releases')
         and sha(normalizer.read_bytes()) == c['baseline']['backupNormalizerSha256'], 'NORMALIZER_CHANGED')
    b = {'commit': CURRENT, 'current': str(current), 'manifestSha256': sha(raw), 'services': states,
         'configurationSha256': {n: sha((current / n).read_bytes()) for n in history.CONFIGURATION},
         'runtimeConfigurationSha256': {n: h.configuration(d, st) for n, st in states.items()},
         'runtime': history.runtime(d, states), 'database': history.database(d, states['api']),
         'backupNormalizerPath': str(normalizer), 'backupNormalizerSha256': sha(normalizer.read_bytes())}
    need(b == c['baseline'] and b['database']['pending'] == 0
         and shutil.disk_usage(BASE).free > 6 * 1024**3, 'BASELINE_MOVED')
    load('proxy-result-identity-release.py').engine_content(d, states['online-recharge'], c['beforeEngineFiles'])
    h.guards(d, current, states, c)
    profile_unlocked(d, states['online-recharge'])
    need((BASE / 'current').resolve() == current and h.snapshot(d, current) == states, 'PARENT_MOVED')
    return {'status': 'ONLINE_NATIVE_FETCH_PARENT_VERIFIED', 'baseline': b, 'businessActions': 0}

def engine(c, plan):
    impl = load('online-native-fetch-release.py')
    for name in ('PREFIX', 'SCOPE', 'CURRENT', 'SOURCE', 'CONTRACT_FILE', 'ENGINE', 'FILES', 'PRESERVED'):
        setattr(impl, name, globals()[name])
    impl.validate_contract, impl.verify_quality, impl.verify_proof = validate_contract, verify_quality, verify_proof
    core = impl.engine(c, plan)
    baseline = core.baseline
    def checked_baseline(d, h, contract):
        result = baseline(d, h, contract)
        profile_unlocked(d, result[2]['online-recharge'])
        return result
    core.baseline = checked_baseline
    return core


def release(plan, c):
    validate_contract(c)
    if plan['mode'] == 'parent':
        need(plan['contractSha256'] == sha((HERE / CONTRACT_FILE).read_bytes())
             and plan['controlSources'] == {**c['controlPins'], CONTRACT_FILE: sha((HERE / CONTRACT_FILE).read_bytes())}, 'PARENT_PLAN_CHANGED')
        return capture(c)
    return engine(c, plan).release(plan, copy.deepcopy(c))


def failure_report(error, plan):
    return load('online-native-fetch-release.py').failure_report(error, plan)
