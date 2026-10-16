export const sharedBankCardPaths = Object.freeze([
  '.github/workflows/shared-bank-card-validation.yml',
  'apps/admin/src/v2/composables/useV2StableListFrame.ts',
  'apps/admin/src/v2/features/auto-recharge/V2BankRechargeOrderDrawers.vue',
  'apps/admin/src/v2/features/auto-recharge/V2SavedPaymentCardField.vue',
  'apps/admin/src/v2/features/auto-recharge/bank-cards-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/bank-orders-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-api.ts',
  'apps/admin/src/v2/features/auto-recharge/chatgpt-accounts-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrderResources.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersCurrency.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.ts',
  'apps/admin/src/v2/features/auto-recharge/useRechargePaymentStart.ts',
  'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-manifest.ts',
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.spec.ts',
  'apps/admin/src/v2/features/online-recharge/OnlineActionDrawer.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineCardSelect.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResourceView.vue',
  'apps/admin/src/v2/features/online-recharge/cards-manifest.ts',
  'apps/admin/src/v2/features/online-recharge/contracts.ts',
  'apps/admin/src/v2/features/online-recharge/labels.ts',
  'apps/admin/src/v2/features/online-recharge/sections.ts',
  'apps/admin/src/v2/features/online-recharge/shared-card-plans.ts',
  'apps/admin/src/v2/features/online-recharge/tableSchemas.ts',
  'apps/admin/src/v2/features/proxy-pool/manifest.ts',
  'apps/admin/src/v2/features/registry.spec.ts',
  'apps/admin/src/v2/features/registry.ts',
  'apps/admin/src/v2/router/routes.spec.ts',
  'apps/admin/src/v2/router/routes.ts',
  'apps/admin/src/v2/styles/records.css',
  'apps/api/prisma-mysql/migrations/20261016150000_shared_bank_card_pool/migration.sql',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-card.service.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-card.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-order.service.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-order.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-verified-order.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-billing.mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-callback-receipts.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-card-billing.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-card-removal.service.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-card-removal.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-local.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-name.service.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-name.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-resolution.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-retired-callback.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.module.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
  'apps/api/src/id-business-v2/bank-card-pool/card-plan-policy.ts',
  'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts',
  'apps/api/src/id-business-v2/bank-card-pool/public-api.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card-pool.module.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.controller.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-bank-card.spec.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-card-management.spec.ts',
  'apps/api/src/id-business-v2/bank-card-pool/shared-card-recovery.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/contracts.ts',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/assets.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/SHARED_BANK_CARD_POOL_20261016.md',
  'docs/V2_PRODUCT_SCOPE.md',
  'docs/V2_TASKS.md',
  'scripts/acceptance-v2-shared-bank-cards.mjs',
  'scripts/check-v2-module-architecture.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-migration.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-shared-bank-card-scope.mjs',
  'scripts/ci-shared-bank-card-scope.test.mjs',
  'scripts/production-release/shared-bank-card-build.py',
  'scripts/production-release/shared-bank-card-contract.json',
  'scripts/production-release/shared-bank-card-dispatch.py',
  'scripts/production-release/shared-bank-card-release.py',
  'scripts/production-release/shared-bank-card-release.test.py'
]);
const required = [
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/bank-card-pool/persistence/shared-bank-card.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts'
];
export function isSharedBankCardOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    required.every((p) => paths.includes(p)) &&
    paths.every((p) => sharedBankCardPaths.includes(p))
  );
}
export function sharedBankCardSchemaMatches(before, after) {
  const line =
    '  allowedPlans    Json                      @default("[\\"go\\",\\"plus\\",\\"pro_5x\\",\\"pro_20x\\",\\"pro_500\\"]") @map("allowed_plans")\n';
  return before !== after && after.split(line).length === 2 && after.replace(line, '') === before;
}
export const sharedBankCardParts = Object.freeze(['guards', 'api', 'admin', 'migration']);
export function sharedBankCardCommands(part, paths) {
  if (!isSharedBankCardOnly(paths)) throw new Error('Unsupported shared bank card scope');
  const npm = (...args) => ['npm', ...args];
  if (part === 'guards')
    return [
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...paths.filter((p) => /\.(mjs|ts|vue|json|md|yml)$/.test(p))
      ),
      npm('exec', '--', 'eslint', ...paths.filter((p) => /\.(mjs|ts|vue)$/.test(p))),
      [
        'node',
        '--test',
        'scripts/ci-shared-bank-card-scope.test.mjs',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs',
        'scripts/check-v2-module-architecture.test.mjs'
      ],
      ['python3', '-B', 'scripts/production-release/shared-bank-card-release.test.py'],
      ...[
        'admin-ui',
        'v2-ui-language',
        'v2-color-contrast',
        'v2-table-standard',
        'v2-loading-standard',
        'v2-module-architecture',
        'v2-isolation',
        'v2-prisma-runtime-boundary',
        'v2-concurrency-standard',
        'v2-decimal-standard'
      ].map((n) => npm('run', 'check:' + n))
    ];
  if (part === 'migration') return [['python3', '-B', 'scripts/ci-recharge-migration.py']];
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (part === 'api')
    return [
      npm('run', 'prisma:mysql:generate'),
      npm('run', 'prisma:mysql:validate'),
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/api'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/api',
        '--',
        'src/id-business-v2/bank-card-pool',
        'src/id-business-v2/auto-recharge',
        'src/id-business-v2/online-recharge'
      ),
      npm('run', 'build', '--workspace', '@apple-business/api')
    ];
  if (part === 'admin')
    return [
      shared,
      npm('run', 'typecheck', '--workspace', '@apple-business/admin'),
      npm(
        'run',
        'test',
        '--workspace',
        '@apple-business/admin',
        '--',
        'src/v2/features/auto-recharge',
        'src/v2/features/online-recharge',
        'src/v2/router/routes.spec.ts',
        'src/v2/features/registry.spec.ts'
      ),
      npm('run', 'build', '--workspace', '@apple-business/admin'),
      npm('exec', '--', 'playwright', 'install', '--with-deps', 'chromium'),
      ['node', 'scripts/acceptance-v2-shared-bank-cards.mjs']
    ];
  throw new Error('Unsupported shared bank card part');
}
