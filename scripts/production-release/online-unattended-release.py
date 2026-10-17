"""Finite unattended repair publisher; retains the accepted three-role fences."""
import importlib.util
from pathlib import Path
import re

SCOPE = 'ONLINE_UNATTENDED_RECHARGE_RECONCILIATION'
CONTRACT_FILE = 'online-unattended-contract.json'
EXPECTED_PREDECESSOR = '0222adf9d5225669b73e8e8f9ec711564eb6163a'
REVIEW_BASE = '1ea95b6a7fff294941c992afe957e4586c066819'
ALLOWED_SOURCES = frozenset(['apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue', 'apps/admin/src/v2/features/online-recharge/OnlineTaskProgress.vue', 'apps/admin/src/v2/features/online-recharge/auditPresentation.spec.ts', 'apps/admin/src/v2/features/online-recharge/contracts.ts', 'apps/admin/src/v2/features/online-recharge/labels.ts', 'apps/api/src/id-business-v2/online-recharge/checkout-recovery.spec.ts', 'apps/api/src/id-business-v2/online-recharge/checkout-recovery.ts', 'apps/api/src/id-business-v2/online-recharge/contracts.ts', 'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json', 'apps/api/src/id-business-v2/online-recharge/engine/checkout-recovery.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/rpc.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/security.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recheck.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/checkout-recovery.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/debug-checkout.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/payment-core.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/payment-observation.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/renewal-state.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/solver-process.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/unattended-task-control.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/upgrade-checkout.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/test/verification-state.test.cjs', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/captcha-platform.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/hcaptcha-solver.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/hcaptcha/solver.py', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/human-verification.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/session-auth.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/stripe-payment.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/subscription-check.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/upgrade-checkout.js', 'apps/api/src/id-business-v2/online-recharge/engine/upstream/verification-runtime.js', 'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts', 'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts', 'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts', 'apps/api/src/id-business-v2/online-recharge/plan-region.spec.ts', 'apps/api/src/id-business-v2/online-recharge/proxy-country.spec.ts', 'apps/api/src/id-business-v2/online-recharge/reconciliation.service.ts', 'apps/api/src/id-business-v2/online-recharge/reconciliation.spec.ts', 'apps/api/src/id-business-v2/online-recharge/reconciliation.ts', 'docs/ONLINE_RECHARGE.md', 'docs/V2_TASKS.md'])
API_MODULES = frozenset(['id-business-v2/online-recharge/checkout-recovery.js', 'id-business-v2/online-recharge/online-recharge.module.js', 'id-business-v2/online-recharge/persistence/tasks.repository.js', 'id-business-v2/online-recharge/persistence/worker-rpc.repository.js', 'id-business-v2/online-recharge/persistence/worker.repository.js', 'id-business-v2/online-recharge/reconciliation.js', 'id-business-v2/online-recharge/reconciliation.service.js'])


def need(value, code):
    if not value:
        raise RuntimeError('ONLINE_CHECKOUT_UNATTENDED_' + code)


def validate_contract(contract):
    need(contract['scope'] == SCOPE and contract['expectedCurrent'] == EXPECTED_PREDECESSOR
         and contract['reviewBase'] == REVIEW_BASE, 'PREDECESSOR_CHANGED')
    need(set(contract['sources']) == ALLOWED_SOURCES and set(contract['apiModules']) == API_MODULES,
         'FINITE_SCOPE_CHANGED')
    need(set(contract['beforeEngineFiles']) <= set(contract['afterEngineFiles']), 'ENGINE_DELETION')
    engine_prefix = contract['engineRoot'] + '/'
    added = set(contract['afterEngineFiles']) - set(contract['beforeEngineFiles'])
    need(added == {n.removeprefix(engine_prefix) for n in ALLOWED_SOURCES
                   if n.startswith(engine_prefix) and n.removeprefix(engine_prefix) not in contract['beforeEngineFiles']},
         'ENGINE_ADDITIONS_CHANGED')
    for name, digest in contract['sources'].items():
        need(name.startswith(('apps/admin/src/v2/features/online-recharge/',
                              'apps/api/src/id-business-v2/online-recharge/', 'docs/'))
             and '..' not in Path(name).parts and re.fullmatch('[a-f0-9]{64}', digest), 'SOURCE_CHANGED')
        need(not name.endswith(('package.json', 'schema.prisma')) and '/migrations/' not in name,
             'SCHEMA_OR_DEPENDENCY_CHANGED')
    need(not contract.get('validationReuse'), 'OLD_CHECKS_CANNOT_AUTHORIZE_NEW_SOURCE')


def release(plan, contract):
    validate_contract(contract)
    path = Path(__file__).with_name('online-checkout-release.py')
    spec = importlib.util.spec_from_file_location('accepted_checkout_release', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SCOPE = SCOPE
    module.CONTRACT_FILE = CONTRACT_FILE
    return module.release(plan, contract)
