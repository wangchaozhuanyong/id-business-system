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
SHARED_CARD_COMMIT = 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e'
SHARED_CARD_TREE = '911664181fa938f4065e2cf5d175ffb522e155d1'
MAILBOX_COMMIT = '1c339754507f29459d17d75bb84afbee8fba5291'
MAILBOX_TREE = '06fc09408adb26dd753456a9e8ff490f3e3cd308'
CURRENT = '123ea34df9bf74a1d65e74bd70f336eaa9344165'
CURRENT_TREE = 'ea208f5e571ab6da0dd6c82a8bf46b4d99e42b98'
SOURCE_BASE = '123ea34df9bf74a1d65e74bd70f336eaa9344165'
SOURCE_TREE = 'ea208f5e571ab6da0dd6c82a8bf46b4d99e42b98'
WORKER = 'apps/api/src/id-business-v2/auto-registration/worker/'
INSTANCE = 'i-05836da38606e633c'
BROWSER_COMMIT = '561b834dd3f481d98a99786667a2844c842b24bd'
BROWSER_CONTRACT_SHA = 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4'
SAFE_READER_SHA = 'c6bda052bfab611c4798a40b8c637a48a23dc9c9da0912b7028e61d719b7146b'
TYPE_DECLARATION = 'id-business-v2/auto-registration/apple-mailboxes.types.d.ts'
TYPE_DECLARATION_SHA = 'a41c23af90aaf305de8d0d42f3c7b31de580a78aae22f047c1d797a8871e66a4'
MAILBOX_VERSION_SOURCES = {'apps/api/src/common/prisma/bump-v2-scope-versions.ts':
    'c775e89856c89e3a94138698b489c1be79b5fb26f94677ee58a8008024849b7e'}
MAILBOX_VERSION_MODULES = {
    'common/prisma/bump-v2-scope-versions.js': 'fa550e3611be675d6858529414ca534eab7d294e5f99f492f1f1eee98f9fec12',
    'common/prisma/bump-v2-scope-versions.js.map': 'ba619085f3e3979f886aac5bb9b991cbe0ae80fb4dd9ee212d39275cca6f0dc4',
    'common/prisma/bump-v2-scope-versions.d.ts': 'baf8b6b40b698ee3cd9accea37b12b053c967b6ef990a1cfda392f6cec818d45'}
HISTORICAL_CONTROLS = {'account-login-build.py': 'f2bc8a42fae093967230b77570f90e7a5914663bc77ccd1ae7f3e617a3a53998', 'account-login-contract.json': '856cc583bbb6f79e6a3dfa1e088bc4674892ff1c364712d808d9d5facba44fea', 'account-login-release.py': '68461ea869ba9447a9878653415c85fe961ac91bbb59389848baba302d7bc5c9', 'api-admin-scope.py': '50446ab528a288ca1c2129c84f1bf4a90f59fa313a92bcff0058a258c8b8e925', 'chatgpt-sales-build.py': 'a55db7b0f04729d6f15d50ef3d7ae81a0746dceb2e95cd77408d0de74b9b7590', 'chatgpt-sales-contract.json': '7bcbfb2b3a5ec288c8a10e1a3d7b7a57abd95363fb37297bf50a017607be300a', 'chatgpt-sales-release.py': '16c27d9093fd2f0e2d8882f51f7584f3d68da3c6a714ee48d83b8cfee29979a5', 'mailbox-realtime-contract.json': '49d8f7a466c9e157305456da816afd00c19cf69192e269e478ba355f5c771831', 'online-settings-build.py': '081d3c2364ef6730f908a631ee35171875f7d22360833c70122fb9205e66dc1f', 'online-settings-contract.json': 'aeb7a5ee67f004beb2eb392964993538718515c3595efc8362c01329b4855887', 'online-settings-release.py': '1b6c94859764203af8aa27f6ff4caaee65470a215f3841a6b5a0bd0b676e8a27', 'proxy-result-identity-release.py': '97207252c12924dcbbfe3e86ebf397e928cd9545bbf9260337fd94ffd5109d45', 'recharge-availability-release.py': 'd98af117f3d80e705dd4f5eb3375a37cf4c0f058b65f4be77550d909ccbbe66c', 'recharge-billing-release.py': 'eabb3473e5639edaf7073cb71562bfca4d7208bc7856d1262ce904202dedafd7', 'recharge-record-release.py': '4ca6d0053f5dc4368d85722ef0df272ace0947c1c91993a0a3da598507b5163f', 'recharge-source-recovery-build.py': '927292b7467c9057a049ef9c1d89654100c506acb77f802f0c0d72fb081d1467', 'recharge-source-recovery-contract.json': '61e69d7a720baa61955be460b209082aaf5e01766ec4be6c882b4a5b6807d890', 'recharge-source-recovery-release.py': 'e6f493ab7737bf77d23114a00ff9c970a77d18786726e690b27dbe98c9f099b8', 'registration-browser-build.py': '5be135efb6785564cd3d6e7593ec699b50422ac351c2e3ad58469096a6d32133', 'registration-browser-contract.json': 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4', 'registration-browser-release.py': 'e4b8c503b98267d117aea5e7333ca4a08e03f95e134d1f3f050b5da60954bfcd', 'registration-closure-release.py': '0d2daaeff0a35e1e11666ace39560273fdc83ff9e5718cb244337c8b0f851274', 'registration-flow-evidence-build.py': '0c6b8a100faa02019003daa037acbae55fc5d80891ffb9ce13ef373d8b4a7925', 'registration-flow-evidence-contract.json': '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae', 'registration-flow-evidence-dispatch.py': '8801f3de8d6749121ab60c7d8a108e9cb293e383c415114decdc92f4f7078f82', 'registration-flow-evidence-release.py': 'f6243432411f637a648e19a728dc4e1744a9682553aecb252b15991c42e1a3f3', 'registration-parity-diagnostics-build.py': '7bd0eb8a3b28261402782b2dbe01fc436c41331f0ecd47764c2d5abc5dc4e459', 'registration-parity-diagnostics-contract.json': 'ec58e314bfebe558c9bf793ca1b240fcd1144d56956ecf0de1fd18fd6aa03ae7', 'registration-parity-diagnostics-dispatch.py': 'c16f8a09a7a08771faa1071910a05a077d3c4e368f6a4938d3c8cec8cca74a8c', 'registration-parity-diagnostics-release.py': 'f5d3d6e3d5ee539a965cbbfa4401beee3e209c2258886ea7239ae667a13e3eb8', 'remote-deploy.py': '889aedb75bbcb53863a55dc2a4c40a84e06dea1d64d493f6a4fca6dc233f855c', 'shared-bank-card-build.py': '7a9ca67ee3f9803612ab6bcb7b054a248d7d5d9d8087d7d676ac4cf59fe09f37', 'shared-bank-card-contract.json': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'shared-bank-card-release.py': '003ddac5dceb7388c79529bced489a008fa4597073df6c6b441629b5dfb46852', 'workspace-drag-build.py': 'e2dba4371c53a4ad53b5c6ee96a1ddea5f5a7c455b8985a16540f89f410e17a7', 'workspace-drag-contract.json': '577497d7a7ec82ab540062738e44f1ee024a1c026469880706c4f37b45585e08', 'workspace-drag-release.py': '28bcfed29eb45d66ece16b943e63b97f5f5500dacfc345cb23642bb4f9931fb0'}
RESTORE_PATHS = ['apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue', 'apps/admin/src/v2/features/auto-registration/api.ts', 'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts', 'apps/admin/src/v2/features/auto-registration/contracts.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py', 'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py', 'apps/api/src/id-business-v2/auto-registration/worker/workspace.py']
API_REMOVALS = {'id-business-v2/auto-registration/browser-registration.controller.d.ts': '005a1a9db99e05641f4e9b54dd8fbe04266abf583b87dfdbfe219454e41e88ae', 'id-business-v2/auto-registration/browser-registration.controller.js': 'f60fbfcfb1f3ba594b83e03513e140ed653d5b6f83acd7b9eb25b24f9302043e', 'id-business-v2/auto-registration/browser-registration.controller.js.map': '109172c7b5f2f62f69dff1eda75d325c5dd0ddcef593688e487f92b3260094e2', 'id-business-v2/auto-registration/browser-registration.service.d.ts': '81ed9fa4625256cc3971005834e6f452cdc28da07b4521c344c5133320fd1097', 'id-business-v2/auto-registration/browser-registration.service.js': 'bbc44b9aba6aa848a2f543058ad18ed5eb95d67d45192d53efe9f7ab141a1505', 'id-business-v2/auto-registration/browser-registration.service.js.map': '0fe71726f381318a9de6945ca3b3c2b81c07b9019bb8aeab07bed4e335677514'}
PUBLISHED_BUILDS = {'browser': {'commit': '561b834dd3f481d98a99786667a2844c842b24bd', 'tree': '79686bbb6c08ba3372813fb6a94f51e2eb7fd058', 'runId': '38906524387', 'attempt': 1, 'workflowPath': '.github/workflows/registration-browser-validation.yml', 'conclusion': 'success', 'validationJobId': 116991362286, 'artifactId': 12048742480, 'artifactName': 'registration-browser-561b834dd3f481d98a99786667a2844c842b24bd-1', 'artifactDigest': 'sha256:b430c205cb6973fa10c1d5cd41008495ee7ec959bcfb7b499009304e1b231d4c', 'bundleMember': 'registration-browser-artifact.tar.gz', 'bundleSha256': '0da67b1b94ac7e1431815d82dba5cc2a93481ccf88c9a7999e6783298eb28c9f', 'proofSha256': '2e8dca2eb348fb65c9ecbe66cd8ee6acddf3b929422e010b4f32d57c92e94909', 'contractSha256': 'ccb48583bb539e13b500f317e37395425bec571f0e369324fc4a5cbabca456e4', 'contractFile': 'registration-browser-contract.json'}, 'onlineSettings': {'commit': '55d5ee5504c9d8d4218632e8cb8eb508923ad9f8', 'tree': 'd182c324ac31f3214c85930369a118162287b227', 'runId': '38909769886', 'attempt': 1, 'workflowPath': '.github/workflows/online-settings-validation.yml', 'conclusion': 'success', 'validationJobId': 117002363767, 'artifactId': 12049742213, 'artifactName': 'online-settings-55d5ee5504c9d8d4218632e8cb8eb508923ad9f8-1', 'artifactDigest': 'sha256:1cb398fc3c82bfa5bafd9b66dd1bee58c010aead2f911daf7631e4f5a0dddad0', 'bundleMember': 'online-settings-release/online-settings-artifact.tar.gz', 'bundleSha256': 'd8810226f218a4b914632ea4106a68982efc7a3dffa476aa139db7e48a34c3d0', 'proofSha256': '84b179d3110df73871178ef470bbb76513f6a9a58f8c8d9780f68fdacb5d68b1', 'contractSha256': 'aeb7a5ee67f004beb2eb392964993538718515c3595efc8362c01329b4855887', 'contractFile': 'online-settings-contract.json'}, 'sharedCard': {'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'tree': '911664181fa938f4065e2cf5d175ffb522e155d1', 'runId': '38916394747', 'attempt': 1, 'workflowPath': '.github/workflows/shared-bank-card-validation.yml', 'conclusion': 'failure', 'validationJobId': 117024848305, 'artifactId': 12052344491, 'artifactName': 'shared-bank-card-e84a44d86c289354bc7ed15dcd0ec68f7210e18e-1', 'artifactDigest': 'sha256:687fff411cb1d18196563378384804389ca3f506561aca7fc9cd464ac0cfea85', 'bundleMember': 'shared-bank-card-artifact.tar.gz', 'bundleSha256': '363863358afbe85cbe89a4af5a2cc4e8e49c12934cdddafe94e00aa3a7c69d45', 'proofSha256': '92b37c740cc5b0db697d25380938a2f4e3450b9acecc23830d2f19f103b70363', 'contractSha256': '22b6133b8b8b704475131604f36c56701377d159c0e5eb80ebce3b4f5bd21c67', 'contractFile': 'shared-bank-card-contract.json'}}

PREDECESSOR_RECEIPTS = {'finalize': {'commandId': 'bca1e62a-39fb-4fc7-8805-bf2157dd7b84', 'sha256': '7a31c48f4e2a10e6ea28c509c90b1f11a8bf21fa8f008df4b14931afafae76b1', 'canonicalSha256': 'cbad7769303d5cf13761df26bae9e5a2bb98392cf82bae7fb7fe72b145b7d419', 'result': {'businessActions': 0, 'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'containersRecreated': False, 'migrationRepeated': False, 'status': 'SHARED_BANK_CARD_FORWARD_FINALIZED'}}, 'readback': {'commandId': 'b76dc765-3203-4991-b10c-b0219cba3dcc', 'sha256': '7094e0d467fb40c148dba6b218a7b1326d96df0e905dc7afd986a40485f40d2c', 'canonicalSha256': '9af5b264230d65076cceeb8a683f8a295f5ae6957dda3465cede2b244be2164d', 'result': {'businessActions': 0, 'commit': 'e84a44d86c289354bc7ed15dcd0ec68f7210e18e', 'migrationPerformed': True, 'preservedServices': ['mysql', 'caddy', 'media-resolver', 'auto-recharge', 'auto-registration'], 'status': 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED'}}}

SOURCE_PATHS = ['.github/workflows/quality.yml', '.github/workflows/registration-protocol-restore-validation.yml', 'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue', 'apps/admin/src/v2/features/auto-registration/api.ts', 'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts', 'apps/admin/src/v2/features/auto-registration/browser-connector.spec.ts', 'apps/admin/src/v2/features/auto-registration/browser-connector.ts', 'apps/admin/src/v2/features/auto-registration/browser-registration-presentation.spec.ts', 'apps/admin/src/v2/features/auto-registration/contracts.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts', 'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts', 'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts', 'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.controller.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.service.spec.ts', 'apps/api/src/id-business-v2/auto-registration/browser-registration.service.ts', 'apps/api/src/id-business-v2/auto-registration/worker/apple_browser_registration.py', 'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py', 'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_connector.py', 'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_flow.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_apple_browser_registration_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_connector.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_contract_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py', 'apps/api/src/id-business-v2/auto-registration/worker/workspace.py', 'docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md', 'docs/V2_TASKS.md', 'scripts/ci-recharge-check.mjs', 'scripts/ci-recharge-check.test.mjs', 'scripts/ci-recharge-scope.mjs', 'scripts/ci-recharge-scope.test.mjs', 'scripts/ci-registration-protocol-restore-scope.mjs', 'scripts/ci-registration-protocol-restore-scope.test.mjs', 'scripts/production-release/registration-protocol-restore-build.py', 'scripts/production-release/registration-protocol-restore-contract.json', 'scripts/production-release/registration-protocol-restore-dispatch.py', 'scripts/production-release/registration-protocol-restore-release.py', 'scripts/production-release/registration-protocol-restore-release.test.py', 'scripts/start-auto-registration-connector.sh']

PUBLISHED_BUILDS['mailboxVersion'] = {
    'commit': MAILBOX_COMMIT, 'tree': MAILBOX_TREE, 'runId': '38925995056', 'attempt': 1,
    'workflowPath': '.github/workflows/mailbox-version-validation.yml', 'conclusion': 'failure',
    'validationJobId': 117057560334, 'artifactId': 12056691966,
    'artifactName': 'mailbox-version-1c339754507f29459d17d75bb84afbee8fba5291-1',
    'artifactDigest': 'sha256:cfe8d7c40a771687bf452728bc16552fa09e0b2a7e0e9c27c84e3c161377aa7b',
    'bundleMember': 'mailbox-version-artifact.tar.gz',
    'bundleSha256': 'cfb91463004179d6cba6935355c9b8f924727a53d2ddcc1616247dfc314cb950',
    'proofSha256': '64940bbf316c8dcedfac1e8ccb6fa8f65243dbe23a4f28f40bf88b5aa34b7924',
    'contractSha256': '4cec2f12a1e783072fb87380083c9bd5bff799087e0cfc535ee8033f4ccf1c90',
    'contractFile': 'mailbox-version-contract.json'}

MAILBOX_VERSION_NATIVE_RECEIPTS = {
    'release': {
        'commandId': 'e8683c00-b4c3-41fb-8725-cbba140b164b',
        'sha256': '4e1be1df2bb32efd507a0403f219e2d506e9b8989a5ca7047fec11584776dc4c',
        'canonicalSha256': '42e81df043a26ee45fd8ca2e2de28c6129a6a7e00e3b01bc0666f7ca6dfefc34',
        'result': {'businessActions': 0, 'commit': MAILBOX_COMMIT, 'migrationPerformed': False,
                   'status': 'MAILBOX_SCOPE_VERSION_RECOVERY_DEPLOYED', 'updatedServices': ['api']}},
    'readback': {
        'commandId': 'c1ff7353-ebc4-4cc0-9367-8f54a2688bbe',
        'sha256': '91870ad9cfb39c54961668c63c59252c95efc3fd6a77ada779fecf210ae83a36',
        'canonicalSha256': 'e7dc973478d67e91583bdbf6aba34b482d3a1b7aed747d6f39431e191b9271b6',
        'result': {'businessActions': 0, 'commit': MAILBOX_COMMIT, 'migrationPerformed': False,
                   'status': 'MAILBOX_SCOPE_VERSION_RECOVERY_INDEPENDENT_READBACK_VERIFIED',
                   'updatedServices': ['api']}}}


GPT_INTEGRATION = {'applicationCommit': 'b0d80c7f8cea818361d06873e3e432ee2c3b3229', 'buildCommit': '800dc9c761bb1b24423727e891174d59d05bddec', 'buildTree': '9c40204f408244797b825e79cf6e0e8ebf28d913', 'publicationCommit': '46bea6e11c9527e9b8930598de4cf2b13eb76635', 'publicationTree': '66f9412285c67bc691dcbb8e369df713d40cfdab', 'workflowRunId': '38922620650', 'nativeContractSha256': '2ee7dd00ef1664b194734f8ce93084976d335413b2e8ff92d5957da564f16e89', 'rebaseContractSha256': '894e6aac58360770fe6de9338e79a2f1c37c4291d807888338689ac177a4e993', 'artifactUrl': 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/gpt-recharge-b0d80c7f8cea818361d06873e3e432ee2c3b3229/gpt-recharge-artifact.tar.gz', 'artifactSha256': '49a6432be83f495e0a2fea6e6feeced39ebc332e850a8b3a7abd2fce60b7e121', 'proofSha256': 'd5254c46631fb203013161db53641c6417f15569a1d7a404e01b31586aadce49', 'sources': {'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts': 'edbd04030f20d675932d9c360e653e3fc3ca8a0a870b1e97dc3a0b30772df59f', 'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts': 'c40188f03a3f8bcf4819ef2c25c867dc979f44ae9d970a541648e87ca3ee8f36', 'apps/api/src/id-business-v2/online-recharge/task-acceptance.ts': 'd97e345a1935a20f7974aad0d28bb2d9af56c42f7fa373305b2e2636daff8fe3', 'apps/api/src/id-business-v2/online-recharge/tasks.service.ts': 'e4d8adfc2c0be3efc6cba4d3519c4ea2027a4170fcf28624624c5a1e11633a35', 'apps/api/src/id-business-v2/online-recharge/vendure-integration.controller.ts': '9d5ac1295565d819666d68e6e99ff56b97a234a535ec0a6028bb7fda2220d37a', 'apps/api/src/id-business-v2/online-recharge/vendure-integration.service.ts': '9f3a2085c4f8ae9b033346bb16831bdf78dc194f538f6d0390a5fe63b9bce3e9', 'apps/api/src/id-business-v2/online-recharge/worker-body-parser.ts': '2471cba84936dc8c36f25feef210d641a0f5c8c4a22ccde6e684396069e57619'}, 'modules': {'id-business-v2/online-recharge/online-recharge.module.js': 'f3bcb65e398ba150e6c3e5f000fc12f0a2354d090e88016ce178670340468c14', 'id-business-v2/online-recharge/online-recharge.module.js.map': '9fdabea6cfbb1e88791303d4004e0eace6bbaa4c1ca64802c550960fa13a6afa', 'id-business-v2/online-recharge/persistence/tasks.repository.d.ts': '9d07b6f3ec326a7265eb93abddd9fdcb4b04f219e9c1f6fbf5349b23e56eb71b', 'id-business-v2/online-recharge/persistence/tasks.repository.js': '3520866af3ed80061868d1a28ada84792a41c53c1d62d95f1654bfe8fc57b922', 'id-business-v2/online-recharge/persistence/tasks.repository.js.map': 'c5fe3d1a6c4d714b1d102d60d6f12f7329c5deb56e1dca944035bc561b521d7f', 'id-business-v2/online-recharge/task-acceptance.d.ts': '841b7fd373eeb435c3825c89b5299707a147a023461c0cae3da6e657147575e7', 'id-business-v2/online-recharge/task-acceptance.js': 'e648d7c52209194b5a22f10b1500e93d0a1a43cbb33f702948b1c9c82ab4a370', 'id-business-v2/online-recharge/task-acceptance.js.map': '300b9c271519452a93039712b8511ea279fcdb082cad3cd035e1edb1ce5baebd', 'id-business-v2/online-recharge/tasks.service.d.ts': '7c424b0501f98268ac61c1bbefd957407fec944eb80a9c55586db2fd01015c4f', 'id-business-v2/online-recharge/tasks.service.js': 'b94d3d649d2790ba56ad4974c7808485b8e9639b3a3dedb18837497ce813b2da', 'id-business-v2/online-recharge/tasks.service.js.map': '844a01613458948aab9e8a0767eb779f4de7df503d2ba8f420b5c8bafea9557c', 'id-business-v2/online-recharge/vendure-integration.controller.d.ts': '59124bb23c2082c99bf7b34ae49983ee2d03ce368ec3596c4a9ab7098a6f5eb5', 'id-business-v2/online-recharge/vendure-integration.controller.js': 'd19a6bbbac16ccfee05e9bd3175d7d608ce19c5de019dd9494bf59781245b00e', 'id-business-v2/online-recharge/vendure-integration.controller.js.map': 'c9f248101c0be96fb64c72a0204067e7375b07eb0639c3054cc2ecbaed87b647', 'id-business-v2/online-recharge/vendure-integration.service.d.ts': '56b8490823f614ce9ebe42982a30438de3939cfc0891691fcd20c4c78f99ec19', 'id-business-v2/online-recharge/vendure-integration.service.js': 'bdf6a1fa06494bfcf6b89b0fb667a8e91aae322ea5759b8da3cda9a583915488', 'id-business-v2/online-recharge/vendure-integration.service.js.map': 'b94e0f93483d1776a97f0940f2a3e1125f4baecc137a17a84379f51aab082c8b', 'id-business-v2/online-recharge/worker-body-parser.js': 'f05bc2c611bde545ac7de6dd4e18e73eec184651e1ad786a73f2d606c815e368', 'id-business-v2/online-recharge/worker-body-parser.js.map': '91a55dff5f6f24f1672d8d7ef4d407b4ed938d06b1cda05377106fe309f37c34'}, 'hostSources': {'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts': 'edbd04030f20d675932d9c360e653e3fc3ca8a0a870b1e97dc3a0b30772df59f', 'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts': 'c40188f03a3f8bcf4819ef2c25c867dc979f44ae9d970a541648e87ca3ee8f36', 'apps/api/src/id-business-v2/online-recharge/task-acceptance.ts': 'd97e345a1935a20f7974aad0d28bb2d9af56c42f7fa373305b2e2636daff8fe3', 'apps/api/src/id-business-v2/online-recharge/tasks.service.ts': 'e4d8adfc2c0be3efc6cba4d3519c4ea2027a4170fcf28624624c5a1e11633a35', 'apps/api/src/id-business-v2/online-recharge/vendure-integration.controller.ts': '9d5ac1295565d819666d68e6e99ff56b97a234a535ec0a6028bb7fda2220d37a', 'apps/api/src/id-business-v2/online-recharge/vendure-integration.service.ts': '9f3a2085c4f8ae9b033346bb16831bdf78dc194f538f6d0390a5fe63b9bce3e9', 'apps/api/src/id-business-v2/online-recharge/worker-body-parser.ts': '2471cba84936dc8c36f25feef210d641a0f5c8c4a22ccde6e684396069e57619'}}

TABLE_CONTAINER = {'commit': '123ea34df9bf74a1d65e74bd70f336eaa9344165', 'tree': 'ea208f5e571ab6da0dd6c82a8bf46b4d99e42b98', 'sources': {'apps/admin/src/v2/components/tableContentWidth.ts': '0141dc8063e5bf9c90158e685c98bafe18762f2647c1286c5b4b84318a0be5ab'}, 'artifactUrl': 'https://github.com/wangchaozhuanyong/id-business-system/releases/download/table-container-123ea34df9bf74a1d65e74bd70f336eaa9344165/compiled-admin.tar.gz', 'artifactSha256': '577d31a3576da604892ce803af072157c5be4a877ba6605334fe6e12eb340422', 'proofSha256': 'ca7d1e80f765d488ff2d4c4765d938956684e49bf851a71d4008610eacd12f59', 'adminFileCount': 261, 'adminFilesSha256': '26c7d428b4996b3aa8faec6725c7c4367e649a559635dbb04a758426e8e687a2'}

RECENT_SUCCESSOR_RECEIPTS = {'gptRelease': {'commandId': '7a612248-f0bb-44f6-8f9a-81178ce02501', 'canonicalSha256': '416acf83db87fa315e71d9959df33cb0d6e07a602c1a99a67f86f768fe0d324e', 'result': {'baselineCommit': '1c339754507f29459d17d75bb84afbee8fba5291', 'businessActions': 0, 'commit': '46bea6e11c9527e9b8930598de4cf2b13eb76635', 'nativeApplicationCommit': 'b0d80c7f8cea818361d06873e3e432ee2c3b3229', 'status': 'GPT_RECHARGE_DEPLOYED', 'updatedServices': ['api']}}, 'gptReadback': {'commandId': '8918c75d-954b-489d-ab28-922641d4dbee', 'canonicalSha256': 'cd691e785985b3e3c1b826d068bc9df842a7c319ea0db4a040e43daad7be4175', 'result': {'baselineCommit': '1c339754507f29459d17d75bb84afbee8fba5291', 'businessActions': 0, 'commit': '46bea6e11c9527e9b8930598de4cf2b13eb76635', 'nativeApplicationCommit': 'b0d80c7f8cea818361d06873e3e432ee2c3b3229', 'status': 'GPT_RECHARGE_INDEPENDENT_READBACK_VERIFIED'}}, 'tableRelease': {'commandId': '6b220d3a-77d9-4a52-b88e-8ee4b0e61ecd', 'canonicalSha256': 'c2494bc3136188a23d47ddc49f78069d3e4f12dd7c8fa00ea54d388bb7bd54ee', 'result': {'adminImageId': 'sha256:fb9120071b7a5319573527ae3db968ea20efddf678b1caa80f5261009fe329cf', 'commit': '123ea34df9bf74a1d65e74bd70f336eaa9344165', 'currentRelease': '/opt/id-business-v2/releases/20261016T163510Z-123ea34df9bf-table-container', 'migrationPerformed': False, 'paymentActions': 0, 'preservedServices': ['api', 'auto-recharge', 'auto-registration', 'caddy', 'media-resolver', 'mysql', 'online-recharge'], 'preservedServicesMatch': True, 'rollbackPerformed': False, 'status': 'TABLE_CONTAINER_DEPLOYED', 'updatedServices': ['admin']}}, 'tableReadback': {'commandId': 'b4eb9403-f53e-42de-bd6f-cbdf80bddc81', 'canonicalSha256': '9fc7a3877af52393d69700c3686856acf2ac561858a75bb75dca7de18a5b9d81', 'result': {'adminImageId': 'sha256:fb9120071b7a5319573527ae3db968ea20efddf678b1caa80f5261009fe329cf', 'apiReady': True, 'businessActions': 0, 'commit': '123ea34df9bf74a1d65e74bd70f336eaa9344165', 'mergedStaticFiles': 1848, 'migrationPerformed': False, 'newStaticFiles': 261, 'preservedServices': ['api', 'auto-recharge', 'auto-registration', 'caddy', 'media-resolver', 'mysql', 'online-recharge'], 'preservedServicesMatch': True, 'publicIndexMatched': True, 'status': 'TABLE_CONTAINER_INDEPENDENT_READBACK_VERIFIED', 'updatedServices': ['admin']}}}

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
    need(retained == {'commit': SHARED_CARD_COMMIT, 'tree': SHARED_CARD_TREE, 'sources': shared['sources'],
         'afterEngineFiles': shared['afterEngineFiles'],
         'proofSha256': PUBLISHED_BUILDS['sharedCard']['proofSha256'],
         'contractSha256': PUBLISHED_BUILDS['sharedCard']['contractSha256']}, 'SHARED_CARD_INHERITANCE_CHANGED')
    need(c.get('retainedMailboxVersion') == {'commit': MAILBOX_COMMIT, 'tree': MAILBOX_TREE,
         'sources': MAILBOX_VERSION_SOURCES,
         'proofSha256': PUBLISHED_BUILDS['mailboxVersion']['proofSha256'],
         'contractSha256': PUBLISHED_BUILDS['mailboxVersion']['contractSha256']},
         'MAILBOX_VERSION_INHERITANCE_CHANGED')
    need(c.get('retainedGptIntegration') == GPT_INTEGRATION
         and c.get('retainedTableContainer') == TABLE_CONTAINER, 'RECENT_SUCCESSOR_INHERITANCE_CHANGED')
    need(c.get('runtimeEvidence', {}).get('hostSourceFiles') ==
         {**GPT_INTEGRATION['hostSources'], **TABLE_CONTAINER['sources']},
         'RECENT_SUCCESSOR_HOST_EVIDENCE_CHANGED')
    need(len(c['baselineAdminFiles']) == TABLE_CONTAINER['adminFileCount']
         and digest(canonical(c['baselineAdminFiles'])) == TABLE_CONTAINER['adminFilesSha256'],
         'TABLE_ADMIN_BASELINE_CHANGED')
    need(all(c['baselineApiFiles'].get(name) == value for name, value in GPT_INTEGRATION['modules'].items()
             if name.endswith('.js')), 'GPT_API_BASELINE_CHANGED')
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
         and c['predecessorReceipts']['finalize']['result'].get('commit') == SHARED_CARD_COMMIT
         and c['predecessorReceipts']['readback']['result'].get('status') == 'SHARED_BANK_CARD_INDEPENDENT_READBACK_VERIFIED'
         and c['predecessorReceipts']['readback']['result'].get('commit') == SHARED_CARD_COMMIT,
         'PREDECESSOR_PUBLICATION_NOT_VERIFIED')
    need(c.get('mailboxVersionReceipts') == MAILBOX_VERSION_NATIVE_RECEIPTS,
         'MAILBOX_VERSION_PUBLICATION_NOT_VERIFIED')
    need(c.get('recentSuccessorReceipts') == RECENT_SUCCESSOR_RECEIPTS,
         'RECENT_SUCCESSOR_PUBLICATION_NOT_VERIFIED')


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
    need(proof.get('withdrawal') == c['withdrawal'] and proof.get('retainedSharedCard') == c['retainedSharedCard']
         and proof.get('retainedMailboxVersion') == c['retainedMailboxVersion']
         and proof.get('retainedGptIntegration') == c['retainedGptIntegration']
         and proof.get('retainedTableContainer') == c['retainedTableContainer'],
         'WITHDRAWAL_PROOF_CHANGED')
    need(proof.get('apiModules', {}).get(TYPE_DECLARATION) == TYPE_DECLARATION_SHA
         and not {TYPE_DECLARATION.removesuffix('.d.ts') + suffix for suffix in ('.js', '.js.map')}
             & set(proof['apiModules']), 'TYPE_DECLARATION_SCOPE_CHANGED')
    return private_namespace(OLD_NAME + '-release.py')['verify_proof'](proof, plan, c, payload, h)


def retained_mailbox(d, target, a):
    for name, expected in MAILBOX_VERSION_SOURCES.items():
        path = target / name
        need(not path.is_symlink() and path.is_file() and digest(path.read_bytes()) == expected,
             'RETAINED_MAILBOX_HOST_SOURCE_CHANGED')
    a.verify_modules(d, target, MAILBOX_VERSION_MODULES)


def retained_recent_successors(d, target, a):
    for name, expected in {**GPT_INTEGRATION['hostSources'], **TABLE_CONTAINER['sources']}.items():
        path = target / name
        need(not path.is_symlink() and path.is_file() and digest(path.read_bytes()) == expected,
             'RECENT_SUCCESSOR_HOST_SOURCE_CHANGED')
    for name, expected in {'gpt-recharge-build-proof.json': GPT_INTEGRATION['proofSha256'],
                           'table-container-build-proof.json': TABLE_CONTAINER['proofSha256']}.items():
        path = target / name
        need(not path.is_symlink() and path.is_file() and digest(path.read_bytes()) == expected,
             'RECENT_SUCCESSOR_HOST_PROOF_CHANGED')
    a.verify_modules(d, target, GPT_INTEGRATION['modules'])


def baseline(d, h, a, finite, c, expected=None):
    value = private_namespace(OLD_NAME + '-release.py', {'sqlite_receipt': sqlite_receipt})['baseline'](
        d, h, a, finite, c, expected)
    retained_mailbox(d, value[0], a)
    retained_recent_successors(d, value[0], a)
    return value


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
    retained_mailbox(d, target, a)
    retained_recent_successors(d, target, a)
    for root, removed in [('/app/apps/api/dist/', c['withdrawal']['apiRemovals']),
                          ('/app/' + WORKER, c['withdrawal']['workerRemovals'])]:
        for name in removed:
            need(d.run('docker', 'exec', states['api']['containerId'], 'test', '!', '-e', root + name) == '',
                 'WITHDRAWN_FILE_PRESENT')


def release_namespace(c):
    ns = private_namespace(OLD_NAME + '-release.py', {'verify_contract': verify_contract,
        'verify_proof': verify_proof, 'sqlite_inspection_source': sqlite_inspection_source,
        'sqlite_receipt': sqlite_receipt, 'validate_sqlite_receipt': validate_sqlite_receipt, 'smoke': smoke,
        'remove_host_sources': remove_host_sources, 'baseline': baseline})
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
