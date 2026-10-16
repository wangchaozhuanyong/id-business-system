"""Forward-only withdrawal of the browser layer; retain all published successors.

The frozen no-migration publisher runs in a private namespace. Its lock, backups,
fences and switch remain intact. The only extra image layer checks and removes
the exact withdrawn files from the new image, never from an existing image.
"""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import types

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = Path('/opt/id-business-v2')
NAME = 'registration-protocol-restore'
SCOPE = 'REGISTRATION_PROTOCOL_RESTORE'
OLD_NAME = 'registration-parity-diagnostics'
CURRENT = 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e'
CURRENT_TREE = '911664181fa938f4065e2cf5d175ffb522e155d1'
SOURCE_BASE = 'd0c4f6215b396437685ce13201760ff93758726b'
SOURCE_TREE = '3206c9600a465a6947c2dcaffab510bc73d98e29'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
INSTANCE = 'i-05836da38606e633c'
BROWSER_COMMIT = '561b834dd3f481d98a99786667a2844c842b24bd'
BROWSER_CONTRACT_SHA = 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4'
SAFE_READER_SHA = 'c6bda052bfab611c4798a40b8c637a48a23dc9c9da0912b7028e61d719b7146b'
TYPE_DECLARATION = 'id-business-v2/auto-registration/apple-mailboxes.types.d.ts'
TYPE_DECLARATION_SHA = 'a41c23af90aaf305de8d0d42f3c7b31de580a78aae22f047c1d797a8871e66a4'
HISTORICAL_CONTROLS = {'account-login-build.py': 'f2bc8a42fae093967230b77570f90e7a5914663bc77ccd1ae7f3e617a3a53998', 'account-login-contract.json': '856cc583bbb6f79e6a3dfa1e088bc4674892ff1c364712d808d9d5facba44fea', 'account-login-release.py': '68461ea869ba9447a9878653415c85fe961ac91bbb59389848baba302d7bc5c9', 'api-admin-scope.py': '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'chatgpt-sales-build.py': 'a55db7b0f04729d6f15d50ef3d7ae81a0746dceb2e95cd77408d0de74b9b7590', 'chatgpt-sales-contract.json': '7bcbfb2b3a5ec288c8a10e1a3d7b7a57abd95363fb37297bf50a017607be300a', 'chatgpt-sales-release.py': '16c27d9093fd2f0e2d8882f51f7584f3d68da3c6a714ee48d83b8cfee29979a5', 'mailbox-realtime-contract.json': '49d8f7a466c9e157305456da816afd00c19cf69192e269e478ba355f5c771831', 'online-settings-build.py': '081d3c2364ef6730f908a631ee35171875f7d22360833c70122fb9205e66dc1f', 'online-settings-contract.json': 'aeb7a5ee67f004beb2eb392964993538718515c3595efc8362c01329b4855887', 'online-settings-release.py': '1b6c94859764203af8aa27f6ff4caaee65470a215f3841a6b5a0bd0b676e8a27', 'proxy-result-identity-release.py': '97207252c12924dcbbfe3e86ebf397e928cd9545bbf9260337fd94ffd5109d45', 'recharge-availability-release.py': 'd98af117f3d80e705dd4f5eb3375a37cf4c0f058b65f4be77550d909ccbbe66c', 'recharge-billing-release.py': 'eabb3473e5639edaf7073cb71562bfca4d7208bc7856d1262ce904202dedafd7', 'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f', 'recharge-source-recovery-build.py': '927292b7467c9057a049ef9c1d89654100c506acb77f802f0c0d72fb081d1467', 'recharge-source-recovery-contract.json': '61e69d7a720baa61955be460b209082aaf5e01766ec4be6c882b4a5b6807d890', 'recharge-source-recovery-release.py': 'e6f493ab7737bf77d23114a00ff9c970a77d18786726e690b27dbe98c9f099b8', 'registration-browser-build.py': '5be135efb6785564cd3d6e7593ec699b50422ac351c2e3ad58469096a6d32133', 'registration-browser-contract.json': 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4', 'registration-browser-release.py': 'e4b8c503b98267d117aea5e7333ca4a08e03f95e134d1f3f050b5da60954bfcd', 'registration-closure-release.py': '0d2daaeff0a35e1e11666ace39560273fdc83ff9e5718cb244337c8b0f851274', 'registration-flow-evidence-build.py': '0c6b8a100faa02019003daa037acbae55fc5d80891ffb9ce13ef373d8b4a7925', 'registration-flow-evidence-contract.json': '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae', 'registration-flow-evidence-dispatch.py': '8801f3de8d6749121ab60c7d8a108e9cb293e383c415114decdc92f4f7078f82', 'registration-flow-evidence-release.py': 'f6243432411f637a648e19a728dc4e1744a9682553aecb252b15991c42e1a3f3', 'registration-parity-diagnostics-build.py': '7bd0eb8a3b28261402782b2dbe01fc436c41331f0ecd47764c2d5abc5dc4e459', 'registration-parity-diagnostics-contract.json': 'ec58e314bfebe558c9bf793ca1b240fcd1144d56956ecf0de1fd18fd6aa03ae7', 'registration-parity-diagnostics-dispatch.py': 'c16f8a09a7a08771faa1071910a05a077d3c4e368f6a4938d3c8cec8cca74a8c', 'registration-parity-diagnostics-release.py': 'f5d3d6e3d5ee539a965cbbfa4401beee3e209c2258886ea7239ae667a13e3eb8', 'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c', 'shared-bank-card-build.py': '7a9ca67ee3f9803612ab6bcb7b054a248d7d5d9d8087d7d676ac4cf59fe09f37', 'shared-bank-card-contract.json': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'shared-bank-card-release.py': '003ddac5dceb7388c79529bced489a008fa4597073df6c6b441629b5dfb46852', 'workspace-drag-build.py': 'e2dba4371c53a4ad53b5c6ee96a1ddea5f5a7c455b8985a16540f89f410e17a7', 'workspace-drag-contract.json': '577497d7a7ec82ab540062738e44f1ee024a1c026469880706c4f37b45585e08', 'workspace-drag-release.py': '28bcfed29eb45d66ece16b943e63b97f5f5500dacfc345cb23642bb4f9931fb0'}
RESTORE_PATHS = ['apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue', 'apps/admin/src/v2/features/auto-registration/api.ts', 'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts', 'apps/admin/src/v2/features/auto-registration/contracts.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py', 'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py', 'apps/api/src/id-business-v2/auto-registration/worker/workspace.py']
API_REMOVALS = {'id-business-v2/auto-registration/browser-registration.controller.d.ts': '005a1a9db99e05641f4e9b54dd8fbe04266abf583b87dfdbfe219454e41e88ae', 'id-business-v2/auto-registration/browser-registration.controller.js': 'f60fbfcfb1f3ba594b83e03513e140ed653d5b6f83acd7b9eb25b24f9302043e', 'id-business-v2/auto-registration/browser-registration.controller.js.map': '109172c7b5f2f62f69dff1eda75d325c5dd0ddcef593688e487f92b3260094e2', 'id-business-v2/auto-registration/browser-registration.service.d.ts': '81ed9fa4625256cc3971005834e6f452cdc28da07b4521c344c5133320fd1097', 'id-business-v2/auto-registration/browser-registration.service.js': 'bbc44b9aba6aa848a2f543058ad18ed5eb95d67d45192d53efe9f7ab141a1505', 'id-business-v2/auto-registration/browser-registration.service.js.map': '0fe71726f381318a9de6945ca3b3c2b81c07b9019bb8aeab07bed4e335677514'}
PUBLISHED_BUILDS = {'browser': {'commit': '561b834dd3f481d98a99786667a2844c842b24bd', 'tree': '79686bbb6c08ba3372813fb6a94f51e2eb7fd058', 'runId': '38906524387', 'attempt': 1, 'workflowPath': '.github/workflows/registration-browser-validation.yml', 'conclusion': 'success', 'validationJobId': 116991362286, 'artifactId': 12048742480, 'artifactName': 'registration-browser-561b834dd3f481d98a99786667a2844c842b24bd-1', 'artifactDigest': 'sha256:b430c205cb6973fa10c1d5cd41008495ee7ec959bcfb7b499009304e1b231d4c', 'bundleMember': 'registration-browser-artifact.tar.gz', 'bundleSha256': '0da67b1b94ac7e1431815d82dba5cc2a93481ccf88c9a7999e6783298eb28c9f', 'proofSha256': '2e8dca2eb348fb65c9ecbe66cd8ee6acddf3b929422e010b4f32d57c92e94909', 'contractSha256': 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4', 'contractFile': 'registration-browser-contract.json'}, 'onlineSettings': {'commit': '55d5ee5504c9d8d4218632e8cb8eb508923ad9f8', 'tree': 'd182c324ac31f3214c85930369a118162287b227', 'runId': '38909769886', 'attempt': 1, 'workflowPath': '.github/workflows/online-settings-validation.yml', 'conclusion': 'success', 'validationJobId': 117002363767, 'artifactId': 12049742213, 'artifactName': 'online-settings-55d5ee5504c9d8d4218632e8cb8eb508923ad9f8-1', 'artifactDigest': 'sha256:1cb398fc3c82bfa5bafd9b66dd1bee58c010aead2f911daf7631e4f5a0dddad0', 'bundleMember': 'online-settings-release/online-settings-artifact.tar.gz', 'bundleSha256': 'd8810226f218a4b914632ea4106a68982efc7a3dffa476aa139db7e48a34c3d0', 'proofSha256': '84b179d3110df73871178ef470bbb76513f6a9a58f8c8d9780f68fdacb5d68b1', 'contractSha256': 'aeb7a5ee67f004beb2eb392964993538718515c3595efc8362c01329b4855887', 'contractFile': 'online-settings-contract.json'}, 'sharedCard': {'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'tree': '911664181fa938f4065e2cf5d175ffb522e155d1', 'runId': '38916394747', 'attempt': 1, 'workflowPath': '.github/workflows/shared-bank-card-validation.yml', 'conclusion': 'failure', 'validationJobId': 117024848305, 'artifactId': 12052344491, 'artifactName': 'shared-bank-card-e84a44d86c289354bc7ed15dcd0ec68f7210e18e-1', 'artifactDigest': 'sha256:687fff411cb1d18196563378384804389ca3f506561aca7fc9cd464ac0cfea85', 'bundleMember': 'shared-bank-card-artifact.tar.gz', 'bundleSha256': '363863358afbe85cbe89a4af5a2cc4e8e49c12934cdddafe94e00aa3a7c69d45', 'proofSha256': '92b37c740cc5b0db697d25380938a2f4e3450b9acecc23830d2f19f103b70363', 'contractSha256': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'contractFile': 'shared-bank-card-contract.json'}}

PREDECESSOR_RECEIPTS = {'finalize': {'commandId': 'bca1e62a-39fb-4fc7-8805-bf2157dd7b84', 'sha256': '7a31c48f4e2a10e6ea28c509c90b1f11a8bf21fa8f008df4b14931afafae76b1', 'canonicalSha256': 'cbad7769303d5cf13761df26bae9e5a2bb98392cf82bae7fb7fe72b145b7d419', 'result': {'businessActions': 0, 'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'containersRecreated': False, 'migrationRepeated': False, 'status': 'SHARED_BANK_CARD_FORWARD_FINALIZED'}}, 'readback': {'commandId': 'b76dc765-3203-4991-b10c-b0219cba3dcc', 'sha256': '7094e0d467fb40c148dba6b218a7b1326d96df0e905dc7afd986a40485f40d2c', 'canonicalSha256': '9af5b264230d65076cceeb8a683f8a295f5ae6957dda3465cede2b244be2164d', 'result': {'businessActions': 0, 'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'migrationPerformed': True, 'preservedServices': ['mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'], 'status': 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED'}}}

SOURCE_PATHS = ['.github/workflows/quality.yml', '.github/workflows/registration-protocol-restore-validation.yml', 'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue', 'apps/admin/src/v2/features/auto-registration/api.ts', 'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts', 'apps/admin/src/v2/features/auto-registration/browser-connector.spec.ts', 'apps/admin/src/v2/features/auto-registration/browser-connector.ts', 'apps/admin/src/v2/features/auto-registration/browser-registration-presentation.spec.ts', 'apps/admin/src/v2/features/auto-registration/contracts.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.controller.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.service.spec.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/worker/apple_browser_registration.py', 'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py', 'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_connector.py', 'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_flow.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_apple_browser_registration_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_connector.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_contract_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/workspace.py', 'docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md', 'docs/V2_TASKS.md', 'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs', 'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-registration-protocol-restore-scope.mjs', 'scripts/ci-registration-protocol-restore-scope.test.mjs', 'scripts/production-release/registration-protocol-restore-build.py', 'scripts/production-release/registration-protocol-restore-contract.json', 'scripts/production-release/registration-protocol-restore-dispatch.py', 'scripts/production-release/registration-protocol-restore-release.py', 'scripts/production-release/registration-protocol-restore-release.test.py', 'scripts/start-auto-registration-connector.sh']

def need(value, code):
    if not value:
        raise RuntimeError(SCOPE + '_' + code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def helper(name):
    need(re.fullmatch('[a-z0-9.-]+', name), 'HELPER_PATH_INVALID')
    path = HERE / name
    spec = importlib.util.spec_from_file_location(NAME.replace('-', '_') + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def history(contract):
    need(contract['historicalControls'] == HISTORICAL_CONTROLS, 'HISTORICAL_CONTROL_SCOPE_CHANGED')
    for name, expected in HISTORICAL_CONTROLS.items():
        need(re.fullmatch('[a-z0-9.-]+', name) and digest((HERE / name).read_bytes()) == expected,
             'HISTORICAL_CONTROL_CHANGED')
    raw = (HERE / 'registration-browser-contract.json').read_bytes()
    need(digest(raw) == BROWSER_CONTRACT_SHA, 'BROWSER_CONTRACT_CHANGED')
    return json.loads(raw)


def verify_contract(c):
    need(c.get('version') == 1 and c.get('frozen') is True and c.get('scope') == SCOPE
         and c.get('expectedCurrent') == CURRENT and c.get('sourceBaseline') == SOURCE_BASE
         and c.get('sourceBaselineTree') == SOURCE_TREE and c.get('migration') is None,
         'CONTRACT_NOT_FROZEN')
    browser = history(c)
    shared = json.loads((HERE / 'shared-bank-card-contract.json').read_bytes())
    retained = c['retainedSharedCard']
    need(retained == {'commit': CURRENT, 'tree': CURRENT_TREE, 'sources': shared['sources'],
         'afterEngineFiles': shared['afterEngineFiles'],
         'proofSha256': PUBLISHED_BUILDS['sharedCard']['proofSha256'],
         'contractSha256': PUBLISHED_BUILDS['sharedCard']['contractSha256']}, 'SHARED_CARD_INHERITANCE_CHANGED')
    withdrawal = c['withdrawal']
    need(withdrawal['restorePaths'] == RESTORE_PATHS and c['publishedBuilds'] == PUBLISHED_BUILDS, 'FROZEN_SCOPE_CHANGED')
    need(set(c['controlFiles']) == set(HISTORICAL_CONTROLS) | {NAME + '-release.py', NAME + '-contract.json'}, 'EXECUTOR_SCOPE_CHANGED')
    need(withdrawal.get('browserCommit') == BROWSER_COMMIT
         and withdrawal.get('retainedCheckpointReaderSha256') == SAFE_READER_SHA
         and withdrawal.get('allowHistoricalBrowserExecution') is False
         and withdrawal.get('allowHistoricalBrowserResume') is False, 'WITHDRAWAL_BOUNDARY_CHANGED')
    introduced = withdrawal['sourceRemovals']
    expected_introduced = {n: v for n, v in browser['sources'].items()
                          if n not in withdrawal['restorePaths']}
    need(len(introduced) == 14 and introduced == expected_introduced, 'SOURCE_REMOVALS_CHANGED')
    need(set(withdrawal['restorePaths']) | set(introduced) == set(browser['sources'])
         and len(withdrawal['restorePaths']) == 14
         and WORKER + 'release_safety.py' in withdrawal['restorePaths'], 'RESTORE_SCOPE_CHANGED')
    sources = c['sources']
    need(c['removedSourcePaths'] == sorted(introduced) and c['allowedApplicationPaths'] == sorted(sources), 'APPLICATION_PATHS_CHANGED')
    prefix = 'id-business-v2/auto-registration/'
    expected_modules = {prefix + name + '.js': c['baselineApiFiles'][prefix + name + '.js'] for name in (
        'apple-mailboxes.controller', 'apple-mailboxes.service', 'apple-mailboxes.types',
        'auto-registration.module', 'auto-registration.service')}
    need(c['apiModules'] == expected_modules, 'API_MODULE_SCOPE_CHANGED')
    need(set(sources) == set(withdrawal['restorePaths']) - {WORKER + 'release_safety.py'}
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in sources.values()), 'APPLICATION_SCOPE_CHANGED')
    need(c['workerFiles'] == {n.removeprefix(WORKER): v for n, v in sources.items()
                             if n.startswith(WORKER)}, 'WORKER_SCOPE_CHANGED')
    need(c['apiDeclarationRestore'] == {TYPE_DECLARATION: TYPE_DECLARATION_SHA}, 'TYPE_DECLARATION_SCOPE_CHANGED')
    need(c['baselineWorkerFiles']['release_safety.py'] == SAFE_READER_SHA, 'CHECKPOINT_READER_CHANGED')
    api_removed, worker_removed = withdrawal['apiRemovals'], withdrawal['workerRemovals']
    expected_api = {n: v for n, v in withdrawal['browserApiModules'].items()
                    if n.startswith('id-business-v2/auto-registration/browser-registration.')
                    or n.startswith('id-business-v2/auto-registration/browser-registration-')}
    need(api_removed == expected_api == API_REMOVALS and len(api_removed) == 6
         and worker_removed == {n.removeprefix(WORKER): v for n, v in introduced.items()
                                if n.startswith(WORKER) and not Path(n).name.startswith('test_')}
         and len(worker_removed) == 3, 'RUNTIME_REMOVALS_CHANGED')
    need(all(c['baselineApiFiles'].get(n) == v for n, v in api_removed.items() if n.endswith('.js'))
         and all(c['baselineWorkerFiles'].get(n) == v for n, v in worker_removed.items()),
         'WITHDRAWN_RUNTIME_BASELINE_CHANGED')
    need(set(c['services']) == {'api', 'admin', 'online-recharge', 'auto-recharge', 'auto-registration',
                               'mysql', 'caddy', 'media-resolver'}
         and c.get('runtimeEvidence', {}).get('status') == 'VERIFIED'
         and c['runtimeEvidence']['commit'] == CURRENT
         and re.fullmatch('[a-f0-9]{64}', c.get('manifestSha256') or '')
         and c['current'].startswith('/opt/id-business-v2/releases/'), 'RUNTIME_BASELINE_MISSING')
    need(c['schemaSha256'] == c['retainedSharedCard']['sources']['apps/api/prisma-mysql/schema.prisma']
         and c['baselineEngineFiles'] == c['retainedSharedCard']['afterEngineFiles']
         and c['prismaPathMetadata']['publishedContext'] ==
         '/home/runner/work/id-business-system/id-business-system/.deploy/shared-bank-card/candidate'
         and c['prismaPathMetadata']['ciName'] == 'GitHub Actions', 'SUCCESSOR_STATE_CHANGED')
    need(c['protectedMigrations'].get(shared['migration']['name']) == shared['migration']['sha256'],
         'SHARED_CARD_MIGRATION_NOT_PROTECTED')
    expected = set(sources) | set(introduced) | set(c['validationSources']) | set(c['controlPaths'])
    need(set(c['expectedGitChanges']) == set(SOURCE_PATHS)
         and c['validationSources'].keys() == {WORKER + 'test_registration_closed_loop_unit.py'}
         and len(c['expectedGitChanges']) == len(set(c['expectedGitChanges']))
         and set(c['expectedGitChanges']) == expected
         and set(c['reviewedFileHashes']) == expected - set(introduced)
             - {'scripts/production-release/' + NAME + '-contract.json'}, 'SOURCE_CLOSURE_CHANGED')
    need(c['hostSourceInheritance']['files'] == {WORKER + 'release_safety.py': SAFE_READER_SHA},
         'HOST_INHERITANCE_CHANGED')
    need(c['predecessorReceipts'] == PREDECESSOR_RECEIPTS
         and set(c['predecessorReceipts']) == {'finalize', 'readback'}
         and c['predecessorReceipts']['finalize']['result'].get('status') == 'SHARED_BANK_CARD_FORWARD_FINALIZED'
         and c['predecessorReceipts']['finalize']['result'].get('commit') == CURRENT
         and c['predecessorReceipts']['readback']['result'].get('status') == 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED'
         and c['predecessorReceipts']['readback']['result'].get('commit') == CURRENT,
         'PREDECESSOR_PUBLICATION_NOT_VERIFIED')


def renamed(code):
    return code.replace(co_consts=tuple(renamed(v) if isinstance(v, types.CodeType) else
        v.replace(OLD_NAME, NAME).replace('REGISTRATION_PARITY_DIAGNOSTICS', SCOPE)
        if isinstance(v, str) else v for v in code.co_consts))


def private_namespace(name, overrides=None):
    c = json.loads((HERE / (NAME + '-contract.json')).read_bytes())
    need(name in c['historicalControls'] and digest((HERE / name).read_bytes()) == c['historicalControls'][name],
         'HISTORICAL_CONTROL_CHANGED')
    original = helper(name)
    namespace = dict(vars(original))
    for key, value in vars(original).items():
        if isinstance(value, types.FunctionType) and value.__globals__ is vars(original):
            adapted = types.FunctionType(renamed(value.__code__), namespace, value.__name__,
                                        value.__defaults__, value.__closure__)
            adapted.__kwdefaults__ = copy.deepcopy(value.__kwdefaults__)
            namespace[key] = adapted
    namespace.update(SCOPE=SCOPE, CURRENT=CURRENT, SOURCE_BASE=SOURCE_BASE, SOURCE_TREE=SOURCE_TREE)
    namespace.update(overrides or {})
    return namespace


def deletion_command(c):
    api = {'/app/apps/api/dist/' + n: v for n, v in c['withdrawal']['apiRemovals'].items()}
    worker = {'/app/' + WORKER + n: v for n, v in c['withdrawal']['workerRemovals'].items()}
    files = {**api, **worker}
    need(len(files) == 9 and all(re.fullmatch('/[A-Za-z0-9_./-]+', n)
         and '..' not in Path(n).parts and re.fullmatch('[a-f0-9]{64}', v) for n, v in files.items()),
         'IMAGE_DELETE_SCOPE_INVALID')
    checks = ''.join(v + '  ' + n + chr(92) + 'n' for n, v in sorted(files.items()))
    # Only validated ASCII paths and digests enter this image-build instruction.
    return "RUN printf '%b' '" + checks + "' | sha256sum -c - && rm -- " + ' '.join(sorted(files)) + '\n'


def remove_host_sources(target, c):
    for name, expected in c['withdrawal']['sourceRemovals'].items():
        path = target / name
        need(not path.is_symlink() and path.resolve().is_relative_to(target.resolve())
             and path.is_file() and digest(path.read_bytes()) == expected, 'HOST_DELETE_SOURCE_CHANGED')
    for name in c['withdrawal']['sourceRemovals']:
        (target / name).unlink()


def sqlite_inspection_source():
    return helper('registration-browser-release.py').sqlite_inspection_source()


def validate_sqlite_receipt(value, c, expected_logical=None):
    policy = c['sqliteReviewPolicy']
    need(len(policy['protectedTaskFacts']) >= 5
         and policy['summary']['taskCounts']['pending'] == 0
         and policy['summary']['taskCounts']['running'] == 0, 'SQLITE_POLICY_INVALID')
    expected = {'version': 1, 'status': 'PASS', **policy['summary'],
        'activeAppleLeaseCount': len(policy['leaseFacts']), 'executingTaskCount': 0,
        'retainedReviewLeaseCount': len(policy['leaseFacts']), 'corruptEncryptedValueCount': 0,
        'leaseFacts': policy['leaseFacts'], 'protectedTaskFacts': policy['protectedTaskFacts'],
        'dependencies': c['runtimePythonDependencies'], 'businessActions': 0}
    need(value == expected and (expected_logical is None or value['logicalSha256'] == expected_logical),
         'SQLITE_PRESERVATION_CHANGED')
    return value


def sqlite_receipt(d, directory, c, expected_logical=None):
    original = helper('registration-browser-release.py')
    fn = original.sqlite_receipt
    ns = {**fn.__globals__, 'validate_sqlite_receipt': validate_sqlite_receipt,
          'sqlite_inspection_source': sqlite_inspection_source}
    return types.FunctionType(fn.__code__, ns)(d, directory, c, expected_logical)


def verify_proof(proof, plan, c, payload, h):
    need(proof.get('withdrawal') == c['withdrawal'] and proof.get('retainedSharedCard') == c['retainedSharedCard'],
         'WITHDRAWAL_PROOF_CHANGED')
    need(proof.get('apiModules', {}).get(TYPE_DECLARATION) == TYPE_DECLARATION_SHA
         and not {TYPE_DECLARATION.removesuffix('.d.ts') + suffix for suffix in ('.js', '.js.map')}
             & set(proof['apiModules']), 'TYPE_DECLARATION_SCOPE_CHANGED')
    return private_namespace(OLD_NAME + '-release.py')['verify_proof'](proof, plan, c, payload, h)


def smoke(d, target, states, c, proof, receipt, h, a, finite):
    # The frozen smoke checks the complete runtime. Project only the exact
    # withdrawn files out of its expected after-inventory; before stays intact.
    projected = copy.deepcopy(c)
    for name in c['withdrawal']['apiRemovals']:
        projected['baselineApiFiles'].pop(name, None)
    for name in c['withdrawal']['workerRemovals']:
        projected['baselineWorkerFiles'].pop(name)
    private_namespace(OLD_NAME + '-release.py', {'sqlite_receipt': sqlite_receipt})['smoke'](
        d, target, states, projected, proof, receipt, h, a, finite)
    for root, removed in [('/app/apps/api/dist/', c['withdrawal']['apiRemovals']),
                          ('/app/' + WORKER, c['withdrawal']['workerRemovals'])]:
        for name in removed:
            need(d.run('docker', 'exec', states['api']['containerId'], 'test', '!', '-e', root + name) == '',
                 'WITHDRAWN_FILE_PRESENT')


def release_namespace(c):
    ns = private_namespace(OLD_NAME + '-release.py', {'verify_contract': verify_contract,
        'verify_proof': verify_proof, 'sqlite_inspection_source': sqlite_inspection_source,
        'sqlite_receipt': sqlite_receipt, 'validate_sqlite_receipt': validate_sqlite_receipt, 'smoke': smoke,
        'remove_host_sources': remove_host_sources})
    tree = ast.parse((HERE / (OLD_NAME + '-release.py')).read_bytes())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'release')
    patched_layers = patched_sources = 0
    for n in ast.walk(function):
        if isinstance(n, ast.For) and isinstance(n.target, ast.Tuple) and [getattr(x, 'id', '') for x in n.target.elts] == ['role', 'copies', 'count']:
            api = n.iter.elts[0]
            need(isinstance(api, ast.Tuple) and api.elts[0].value == 'api' and api.elts[2].value == 2,
                 'PUBLISHER_IMAGE_BOUNDARY_CHANGED')
            api.elts[1] = ast.BinOp(ast.Constant(deletion_command(c)), ast.Add(), api.elts[1])
            api.elts[2].value = 3
            patched_layers += 1
    for n in ast.walk(function):
        if isinstance(n, (ast.FunctionDef, ast.With, ast.Try, ast.If, ast.For)):
            for attr in ['body', 'orelse', 'finalbody']:
                body = getattr(n, attr, [])
                for index, statement in enumerate(list(body)):
                    if isinstance(statement, ast.For) and isinstance(statement.target, ast.Name) and statement.target.id == 'name' \
                            and isinstance(statement.iter, ast.Subscript) and isinstance(statement.iter.value, ast.Name) \
                            and statement.iter.value.id == 'contract' and isinstance(statement.iter.slice, ast.Constant) \
                            and statement.iter.slice.value == 'sources':
                        body.insert(index, ast.Expr(ast.Call(ast.Name('remove_host_sources', ast.Load()),
                            [ast.Name('target', ast.Load()), ast.Name('contract', ast.Load())], [])))
                        patched_sources += 1
    need(patched_layers == 1 and patched_sources == 1, 'PUBLISHER_PATCH_BOUNDARY_CHANGED')
    code = compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])),
                   str(HERE / (OLD_NAME + '-release.py')), 'exec')
    exec(renamed(code), ns)
    return ns


def release(plan, contract, d, h):
    verify_contract(contract)
    namespace = release_namespace(contract)
    return namespace['release'](plan, contract, d, helper('registration-browser-release.py').configuration_helper(h))
