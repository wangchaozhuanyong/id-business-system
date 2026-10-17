"""Reuse the accepted three-role overlay and fences with a new exact predecessor contract."""
import importlib.util
from pathlib import Path
import re

SCOPE = 'ONLINE_CHECKOUT_FIELD_CONTEXT_PROGRESS'
CONTRACT_FILE = 'online-checkout-retest-contract.json'
ENGINE = 'apps/api/src/id-business-v2/online-recharge/engine/'
ALLOWED_SOURCES = frozenset(['apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue', 'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue', 'apps/admin/src/v2/features/online-recharge/api.spec.ts', 'apps/admin/src/v2/features/online-recharge/api.ts', 'apps/admin/src/v2/features/online-recharge/useOnlineTask.spec.ts', 'apps/admin/src/v2/features/online-recharge/useOnlineTask.ts', 'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json', 'apps/api/src/id-business-v2/online-recharge/engine/checkout-form.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-form.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/worker-heartbeat.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js', 'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs', 'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])
EXPECTED_PREDECESSOR = '626620f09b9fc27e32cc1d3e8a93cb1c51513387'

def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_RETEST_' + code)

def validate_contract(contract):
    need(contract['scope'] == SCOPE and contract['expectedCurrent'] == EXPECTED_PREDECESSOR
        and contract['reviewBase'] == EXPECTED_PREDECESSOR, 'PREDECESSOR_CHANGED')
    need(set(contract['apiModules']) == {'id-business-v2/online-recharge/persistence/tasks.repository.js'}, 'API_SCOPE_CHANGED')
    need(set(contract['beforeEngineFiles']) == set(contract['afterEngineFiles']), 'ENGINE_SET_CHANGED')
    need(contract['beforeEngineFiles']['worker.cjs'] != contract['afterEngineFiles']['worker.cjs'], 'ENGINE_UNCHANGED')
    need(set(contract['sources']) == ALLOWED_SOURCES, 'FINITE_SCOPE_CHANGED')
    for name, digest in contract['sources'].items():
        need(name.startswith(('apps/admin/src/v2/features/online-recharge/', 'apps/api/src/id-business-v2/online-recharge/', 'docs/'))
            and '..' not in Path(name).parts and re.fullmatch('[a-f0-9]{64}', digest), 'SOURCE_SCOPE_CHANGED')
    need(all(not n.endswith(('package.json', 'schema.prisma')) and '/migrations/' not in n for n in contract['sources']), 'SCHEMA_OR_DEPENDENCY_CHANGED')

def release(plan, contract):
    validate_contract(contract)
    path = Path(__file__).with_name('online-checkout-release.py')
    spec = importlib.util.spec_from_file_location('accepted_checkout_release', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SCOPE = SCOPE
    module.CONTRACT_FILE = CONTRACT_FILE
    return module.release(plan, contract)
