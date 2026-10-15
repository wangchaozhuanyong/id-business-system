import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const registrationFactsMigration =
  'apps/api/prisma-mysql/migrations/20261016120000_registration_facts/migration.sql';
export const registrationPublishedBindingPath = 'scripts/ci-registration-closure-published.json';
const publishedBindingSha256 = 'd77484e812ff8f6d4b8a0b113ab19a18196c5d051f4021a96eac69be60a57ba7';
const protectedPublishedPaths = new Set([
  'apps/admin/src/v2/features/auto-recharge/BitOrderPricingSettings.vue',
  'apps/admin/src/v2/features/auto-recharge/V2BankRechargeOrderDrawers.vue',
  'apps/admin/src/v2/features/auto-recharge/V2BankRechargeOrdersView.vue',
  'apps/admin/src/v2/features/auto-recharge/V2RechargeOrdersChannelView.vue',
  'apps/admin/src/v2/features/auto-recharge/bank-orders-manifest.ts',
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-api.ts',
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-order-form.ts',
  'apps/admin/src/v2/features/auto-recharge/bit-order-pricing.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/bit-order-pricing.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrderResources.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBankRechargeOrdersPage.ts',
  'apps/admin/src/v2/features/auto-recharge/useBitOrderPricing.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBitOrderPricing.ts',
  'apps/admin/src/v2/features/customers/useCustomersPage.ts',
  'apps/admin/src/v2/features/data-analytics/useDataAnalyticsPage.ts',
  'apps/admin/src/v2/features/data-governance/data-governance-presentation.ts',
  'apps/admin/src/v2/features/finance-ledger/financeLedgerPresentation.ts',
  'apps/admin/src/v2/features/online-recharge/OnlineOrderBackfill.vue',
  'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
  'apps/admin/src/v2/features/online-recharge/api.spec.ts',
  'apps/admin/src/v2/features/online-recharge/api.ts',
  'apps/admin/src/v2/features/online-recharge/orderPermissions.ts',
  'apps/admin/src/v2/features/online-recharge/permissions.spec.ts',
  'apps/admin/src/v2/features/online-recharge/public-api.ts',
  'apps/admin/src/v2/features/tableSchemas.ts',
  'apps/api/prisma-mysql/migrations/20261015110000_online_recharge_pro_500/migration.sql',
  'apps/api/prisma-mysql/migrations/20261016090000_online_recharge_orders/migration.sql',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-list.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-channel.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-correction.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-finance.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-lifecycle.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-manual-order.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-online-order.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-order-audit.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-order.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-pricing.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-subscription-review.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-verified-order.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge.controller.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge-online-order.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/recharge-settings.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/public-api.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/contracts.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/confirmation.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/plans.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/order-sync-recheck.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/online-recharge.module.ts',
  'apps/api/src/id-business-v2/online-recharge/order-sync-facts.ts',
  'apps/api/src/id-business-v2/online-recharge/order-sync.service.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/order-sync.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/settings.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/webhooks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/proxy-input.ts',
  'apps/api/src/id-business-v2/online-recharge/public.controller.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.ts',
  'scripts/check-v2-table-standard.mjs',
  'scripts/lib/v2-table-schema-alias.mjs',
  'scripts/v2-table-schema-alias.test.mjs'
]);
const protectedValidationPaths = new Set([
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/data-governance/bank-recharge-governance-mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/order-sync.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-plan-catalog.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge-query.repository.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/validation.spec.ts'
]);
const schema = 'apps/api/prisma-mysql/schema.prisma';
const registeredFacts = `  registrationIpEncrypted String?                      @map("registration_ip_encrypted") @db.Text
  registeredAt        DateTime?                        @map("registered_at") @db.DateTime(6)
`;
export const registrationClosureControlPaths = Object.freeze([
  'scripts/ci-registration-closure-native-reuse.mjs',
  'scripts/ci-registration-closure-native-reuse.test.mjs',
  'scripts/check-v2-decimal-standard.mjs',
  'scripts/check-v2-decimal-standard.test.mjs',
  '.github/workflows/registration-closure-validation.yml',
  'scripts/production-release/registration-closure-build.py',
  'scripts/production-release/registration-closure-dispatch.py',
  'scripts/production-release/registration-closure-release.py',
  'scripts/production-release/registration-closure-release.test.py',
  'scripts/production-release/registration-closure-contract.json',
  'scripts/production-release/registration-closure-database.mjs',
  'scripts/ci-registration-closure-scope.mjs',
  ...[
    'scripts/check-v2-table-standard.mjs',
    'scripts/lib/v2-table-schema-alias.mjs',
    'scripts/v2-table-schema-alias.test.mjs'
  ],
  registrationPublishedBindingPath,
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);
const taskPaths = new Set([
  'scripts/ci-registration-closure-native-reuse.mjs',
  'scripts/ci-registration-closure-native-reuse.test.mjs',
  'scripts/check-v2-decimal-standard.mjs',
  'scripts/check-v2-decimal-standard.test.mjs',
  'scripts/check-v2-online-recharge-controls.test.mjs',
  '.github/workflows/registration-closure-validation.yml',
  'apps/admin/src/v2/features/auto-recharge/V2ChatgptAccountsView.vue',
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-api.ts',
  'apps/admin/src/v2/features/auto-recharge/useChatgptAccountAge.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useChatgptAccountAge.ts',
  'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
  'apps/admin/src/v2/features/auto-registration/V2AutoRegistrationView.vue',
  'apps/admin/src/v2/features/auto-registration/api.ts',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.spec.ts',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts',
  'apps/admin/src/v2/features/auto-registration/bridge.spec.ts',
  'apps/admin/src/v2/features/auto-registration/bridge.ts',
  'apps/admin/src/v2/features/auto-registration/contracts.ts',
  'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts',
  'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts',
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
  'apps/admin/src/v2/features/proxy-pool/options.spec.ts',
  'apps/admin/src/v2/features/proxy-pool/options.ts',
  'apps/admin/src/v2/features/proxy-pool/public-api.ts',
  'apps/admin/src/v2/features/proxy-pool/useProxyTests.spec.ts',
  'apps/admin/src/v2/features/proxy-pool/useProxyTests.ts',
  'apps/admin/src/v2/features/tableSchemas.ts',
  'apps/api/prisma-mysql/migrations/20261016120000_registration_facts/migration.sql',
  'apps/api/prisma-mysql/schema.prisma',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-list.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-pagination.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-subscription.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-card-summary.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-facts.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/persistence/bank-recharge.repository.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-proxy.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-main-sync.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-manual-sync.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-manual-sync.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-pool.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-reconciliation.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes-task-bridge.service.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts',
  'apps/api/src/id-business-v2/auto-registration/worker/acceptance_runtime.py',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py',
  'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_apple_mailboxes.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_release_safety.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_workspace.py',
  'apps/api/src/id-business-v2/auto-registration/worker/workspace.py',
  'apps/api/src/id-business-v2/auto-registration/workspace-path.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/workspace-path.ts',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-connection.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/proxy-test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/dispatch.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-pool.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-test.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/test/proxy-worker.test.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
  'apps/api/src/id-business-v2/online-recharge/mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/admin.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/online-recharge.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/tasks.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker-rpc.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts',
  'apps/api/src/id-business-v2/online-recharge/proxy-tests.spec.ts',
  'apps/api/src/id-business-v2/proxy-pool/persistence/online-proxy.repository.ts',
  'apps/api/src/id-business-v2/proxy-pool/persistence/proxy-pool.repository.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool-validation.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.controller.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.module.ts',
  'apps/api/src/id-business-v2/online-recharge/proxy-tests.mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.service.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.spec.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-test.spec.ts',
  'apps/api/src/id-business-v2/proxy-pool/proxy-test.ts',
  'apps/api/src/id-business-v2/proxy-pool/public-api.ts',
  'apps/api/src/id-business-v2/proxy-pool/validation.ts',
  'docs/AUTO_REGISTRATION_CLOSED_LOOP_20261016.md',
  'docs/REGISTRATION_CLOSURE_RELEASE_20261016.md',
  'docs/SHARED_PROXY_POOL_20261015.md',
  'docs/V2_TASKS.md',
  'scripts/acceptance-v2-recharge-proxies-ui.mjs',
  'scripts/acceptance-v2-registration-inventory-ui.mjs',
  'scripts/acceptance-v2-registration-mirror-mysql.mjs',
  'scripts/acceptance-v2-registration-native-ui.mjs',
  'scripts/acceptance-v2-shared-proxy-mysql.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-registration-closure-scope.mjs',
  'scripts/fixtures/registration-closed-loop-worker.py',
  'scripts/production-release/registration-closure-build.py',
  'scripts/production-release/registration-closure-contract.json',
  'scripts/production-release/registration-closure-database.mjs',
  'scripts/production-release/registration-closure-dispatch.py',
  'scripts/production-release/registration-closure-release.py',
  'scripts/production-release/registration-closure-release.test.py'
]);

const allowed = new Set([
  ...taskPaths,
  ...protectedPublishedPaths,
  ...protectedValidationPaths,
  registrationPublishedBindingPath
]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Publication recovery is an exact source receipt, never a payment-directory waiver.
export function hasRegistrationPublishedRecovery(paths) {
  return paths.includes(registrationPublishedBindingPath);
}
export function registrationPublishedRecoveryProof(paths, options = {}) {
  if (!hasRegistrationPublishedRecovery(paths)) return true;
  try {
    const raw =
      options.bindingBytes ??
      readFileSync(new URL('../' + registrationPublishedBindingPath, import.meta.url));
    if (sha256(raw) !== publishedBindingSha256) return false;
    const binding = JSON.parse(raw);
    if (
      Object.keys(binding.sources).length !== protectedPublishedPaths.size ||
      Object.keys(binding.validationSources).length !== protectedValidationPaths.size ||
      Object.keys(binding.sources).some((path) => !protectedPublishedPaths.has(path)) ||
      Object.keys(binding.combinedSources).some((path) => !protectedPublishedPaths.has(path)) ||
      Object.keys(binding.validationSources).some((path) => !protectedValidationPaths.has(path))
    )
      return false;
    const successorSources = {};
    for (const layer of binding.publishedSuccessorLayers ?? []) {
      if (
        layer.version !== 1 ||
        Object.keys(layer.sources).some(
          (path) =>
            !protectedPublishedPaths.has(path) ||
            layer.sources[path].sourceCommit !== layer.publicationCommit
        )
      )
        return false;
      Object.assign(successorSources, layer.sources);
    }
    const readSource =
      options.readSource ?? ((path) => readFileSync(new URL('../' + path, import.meta.url)));
    return [...protectedPublishedPaths, ...protectedValidationPaths].every((path) => {
      const published = binding.sources[path];
      if (published && published.sourceCommit !== binding.publicationCommit) return false;
      const expected =
        binding.combinedSources[path] ??
        successorSources[path]?.publishedSha256 ??
        published?.publishedSha256 ??
        binding.validationSources[path];
      return /^[a-f0-9]{64}$/.test(expected) && sha256(readSource(path)) === expected;
    });
  } catch {
    return false;
  }
}

// Exact task paths keep unrelated payment, identity and infrastructure edits on
// their original checks. A partial follow-up does not need the other module.
export function isRegistrationClosurePaths(paths) {
  return (
    paths.length > 0 &&
    paths.every((path) => allowed.has(path)) &&
    (hasRegistrationPublishedRecovery(paths) || paths.every((path) => taskPaths.has(path)))
  );
}
export function isRegistrationClosureControlsOnly(paths) {
  return (
    isRegistrationClosurePaths(paths) &&
    registrationPublishedRecoveryProof(paths) &&
    paths.some((path) => registrationClosureControlPaths.includes(path)) &&
    paths.every(
      (path) => registrationClosureControlPaths.includes(path) || path.startsWith('docs/')
    )
  );
}
export function hasRegistrationClosureApplication(paths) {
  return paths.some(
    (path) => path.startsWith('apps/') || path.startsWith('scripts/acceptance-v2-')
  );
}
function publishedSchemaProof(paths, before, after) {
  if (!hasRegistrationPublishedRecovery(paths) || !registrationPublishedRecoveryProof(paths))
    return false;
  try {
    const binding = JSON.parse(
      readFileSync(new URL('../' + registrationPublishedBindingPath, import.meta.url))
    );
    return (
      sha256(before) === binding.sourceBaselineSchemaSha256 &&
      sha256(after) === binding.schemaSha256 &&
      Object.keys(binding.migrations).every((path) => paths.includes(path))
    );
  } catch {
    return false;
  }
}
export function registrationFactsSchemaProof(paths, before, after, sql) {
  const changedSchema = paths.includes(schema);
  const changedMigration = paths.includes(registrationFactsMigration);
  if (!changedSchema && !changedMigration) return true;
  if (
    !changedSchema ||
    !changedMigration ||
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    /registrationIpEncrypted|registeredAt/.test(
      before.match(/model IdBusinessV2ChatgptAccount \{[^}]*\}/)?.[0] ?? ''
    ) ||
    after.split(registeredFacts).length !== 2 ||
    !(after.match(/model IdBusinessV2ChatgptAccount \{[^}]*\}/)?.[0] ?? '').includes(
      registeredFacts
    ) ||
    (after.replace(registeredFacts, '') !== before &&
      !publishedSchemaProof(paths, before, after.replace(registeredFacts, '')))
  )
    return false;
  try {
    const content =
      sql ?? readFileSync(new URL('../' + registrationFactsMigration, import.meta.url));
    return (
      createHash('sha256').update(content).digest('hex') ===
      '5daa1d7786ed4b3aafc23cc9354ed893d1314a950b94313aa1042ab024a018db'
    );
  } catch {
    return false;
  }
}
export function isRegistrationClosureOnly(paths, before, after, sql) {
  return (
    isRegistrationClosurePaths(paths) &&
    hasRegistrationClosureApplication(paths) &&
    registrationPublishedRecoveryProof(paths) &&
    registrationFactsSchemaProof(paths, before, after, sql)
  );
}
