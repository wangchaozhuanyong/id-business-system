const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
export const sharedProxyMigration =
  'apps/api/prisma-mysql/migrations/20261015120000_shared_proxy_pool/migration.sql';
const paths = new Set([
  'scripts/acceptance-v2-production-database-access.mjs',
  'apps/admin/src/v2/features/auto-recharge/RechargePasswordLoginFields.vue',
  'apps/admin/src/v2/features/auto-recharge/RechargeProxyOptions.vue',
  'apps/admin/src/v2/features/auto-recharge/V2RechargeProxiesView.vue',
  'apps/admin/src/v2/features/auto-recharge/V2RechargeProxyDetailDrawer.vue',
  'apps/admin/src/v2/features/auto-recharge/V2RechargeProxySelect.vue',
  'apps/admin/src/v2/features/auto-recharge/chatgpt-accounts-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-proxies-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-proxy-api.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-proxy-options.ts',
  'apps/admin/src/v2/features/auto-recharge/vendure-mailbox-manifest.ts',
  'apps/admin/src/v2/features/online-recharge/manifest.ts',
  'apps/admin/src/v2/features/proxy-pool/ProxyPoolEditor.vue',
  'apps/admin/src/v2/features/proxy-pool/ProxyPoolFields.vue',
  'apps/admin/src/v2/features/proxy-pool/ProxyPoolFilters.vue',
  'apps/admin/src/v2/features/proxy-pool/ProxyPoolImport.vue',
  'apps/admin/src/v2/features/proxy-pool/V2ProxyPoolView.vue',
  'apps/admin/src/v2/features/proxy-pool/V2RechargeProxyDetailDrawer.vue',
  'apps/admin/src/v2/features/proxy-pool/api.spec.ts',
  'apps/admin/src/v2/features/proxy-pool/api.ts',
  'apps/admin/src/v2/features/proxy-pool/contracts.ts',
  'apps/admin/src/v2/features/proxy-pool/manifest.ts',
  'apps/admin/src/v2/features/proxy-pool/options.ts',
  'apps/admin/src/v2/features/proxy-pool/public-api.ts',
  'apps/admin/src/v2/features/registry.spec.ts',
  'apps/admin/src/v2/features/registry.ts',
  'apps/admin/src/v2/features/tableSchemas.ts',
  'apps/admin/src/v2/router/routes.spec.ts',
  'apps/admin/src/v2/router/routes.ts',
  'apps/api/prisma-mysql/migrations/20261015120000_shared_proxy_pool/migration.sql',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-proxy.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-proxy-validation.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-proxy.controller.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-proxy.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-settings.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-connection.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-pool.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/mysql-store.js',
  'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/assets.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
  'apps/api/src/id-business-v2/proxy-pool/persistence/online-proxy.repository.ts',
  'apps/api/src/id-business-v2/proxy-pool/persistence/proxy-pool.repository.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool-validation.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.controller.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.module.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.service.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.spec.ts',
  'apps/api/src/id-business-v2/proxy-pool/public-api.ts',
  'apps/api/src/id-business-v2/proxy-pool/validation.ts',
  'docs/ONLINE_RECHARGE.md',
  'docs/SHARED_PROXY_POOL_20261015.md',
  'docs/V2_PRODUCT_SCOPE.md',
  'docs/V2_TASKS.md',
  'scripts/acceptance-v2-auto-recharge.mjs',
  'scripts/acceptance-v2-bank-recharge-ui.mjs',
  'scripts/acceptance-v2-bitbrowser-direct.mjs',
  'scripts/acceptance-v2-filter-layout.mjs',
  'scripts/acceptance-v2-online-recharge-ui.mjs',
  'scripts/acceptance-v2-opening-card-info.mjs',
  'scripts/acceptance-v2-recharge-names-ui.mjs',
  'scripts/acceptance-v2-recharge-proxies-ui.mjs',
  'scripts/acceptance-v2-shared-proxy-mysql.mjs',
  'scripts/check-v2-input-retention.mjs',
  'scripts/check-v2-module-architecture.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-migration.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-shared-proxy-scope.mjs',
  'scripts/ci-shared-proxy-scope.test.mjs',
  'scripts/lib/v2-production-database-access.mjs',
  'scripts/production-database-access.test.mjs'
]);
export function isSharedProxyPoolPaths(changed) {
  return (
    changed.some((path) => path.includes('/proxy-pool/')) &&
    changed.every((path) => paths.has(path))
  );
}
export function isSharedProxyPoolOnly(changed, before, after) {
  if (!isSharedProxyPoolPaths(changed)) return false;
  if (!changed.includes(schemaPath)) return true;
  if (!changed.includes(sharedProxyMigration) || !before || !after) return false;
  const withoutPool = (source) =>
    source
      .replace(
        /^\/\/ Preserve online task references without rewriting historical JSON payloads\.\r?\n/gm,
        ''
      )
      .replace(/^model IdBusinessV2(?:RechargeProxy|ProxyAlias) \{[\s\S]*?^\}\s*/gm, '')
      .trimEnd();
  return (
    withoutPool(before) === withoutPool(after) &&
    !/^model IdBusinessV2ProxyAlias /m.test(before) &&
    /^model IdBusinessV2ProxyAlias /m.test(after)
  );
}
