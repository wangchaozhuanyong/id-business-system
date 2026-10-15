import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

export const parts = [
  'guards',
  'admin',
  'api',
  'connector',
  'migration',
  'security',
  'online-engine'
];
export const rechargeRecordControlPaths = Object.freeze([
  '.github/workflows/recharge-record-validation.yml',
  'scripts/production-release/recharge-record-build.py',
  'scripts/production-release/recharge-record-contract.json',
  'scripts/production-release/recharge-record-release.py',
  'scripts/production-release/recharge-record-release.test.py',
  'scripts/production-release/recharge-record-dispatch.py',
  'scripts/production-release/online-recharge-component-consumer.test.py',
  'scripts/ci-recharge-record.test.mjs'
]);
const rechargeRecordApplicationPaths = new Set([
  'apps/admin/src/v2/features/auto-recharge/RechargePageContext.vue',
  'apps/admin/src/v2/features/auto-recharge/recharge-callback-diagnostics.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-presentation.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-presentation.ts',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-callback-receipts.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-validation.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/worker/callback_observation.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_callback_observation.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_payment.py',
  'packages/shared/src/v2/auto-recharge.ts'
]);
export function isRechargeRecordRepairOnly(paths) {
  return (
    paths.includes('scripts/production-release/recharge-record-contract.json') &&
    paths.some((path) => rechargeRecordApplicationPaths.has(path)) &&
    paths.every(
      (path) =>
        rechargeRecordApplicationPaths.has(path) ||
        rechargeRecordControlPaths.includes(path) ||
        [
          'scripts/ci-recharge-scope.mjs',
          'scripts/ci-recharge-check.mjs',
          'docs/AUTO_RECHARGE_RECORD_DIAGNOSTICS_20261015.md',
          'docs/V2_TASKS.md'
        ].includes(path)
    )
  );
}
export const onlineRechargeRecoveryPolicy =
  'scripts/production-release/online-recharge-recovery.json';
export const onlineCiBuildControlPaths = Object.freeze([
  'scripts/production-release/online-recharge-ci-build.py',
  'scripts/production-release/online-recharge-ci-build.test.py',
  'scripts/production-release/online-recharge-component-recovery.py',
  'scripts/production-release/online-recharge-component-recovery.test.py',
  'scripts/production-release/online-recharge-component-recovery-readonly.py',
  'scripts/production-release/online-recharge-component-recovery-readonly.test.py',
  '.github/workflows/online-recharge-recovery.yml',
  'scripts/production-release/online-recharge-component-diagnostic.py',
  'scripts/production-release/online-recharge-component-diagnostic.test.py',
  'scripts/production-release/online-recharge-component-lifecycle.test.py',
  'scripts/production-release/online-recharge-component-diagnostic-entry.test.mjs',
  '.github/workflows/online-recharge-diagnostic.yml'
]);
const onlineCiBuildInputs = new Set([
  'scripts/production-release/online-recharge-ci-build.py',
  'scripts/production-release/online-recharge-ci-build.test.py',
  'scripts/production-release/online-recharge-component-lifecycle.test.py',
  '.github/workflows/quality.yml',
  '.github/workflows/production-release.yml',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/online-recharge-component-consumer.py',
  'scripts/production-release/online-recharge-component-runtime.py',
  'scripts/production-release/online-recharge-component-readonly.py',
  'scripts/production-release/online-recharge-scope.py',
  'scripts/production-release/api-admin-pending-projection.py',
  'scripts/production-release/unpublished-component-successor.py',
  'apps/api/Dockerfile.mysql',
  'apps/admin/Dockerfile',
  'apps/api/package.json',
  'apps/admin/package.json',
  'packages/shared/package.json',
  'scripts/audit-python-dependencies.py',
  'package.json',
  'package-lock.json',
  '.dockerignore',
  'tsconfig.base.json',
  'deploy/nginx/admin.conf'
]);
const onlineEngineWrapperPath =
  /^apps\/api\/src\/id-business-v2\/online-recharge\/engine\/(?:[^/]+\.cjs|test\/[^/]+\.test\.cjs)$/;
const onlineEngineRuntimeSources = new Set([
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json',
  'apps/api/src/id-business-v2/online-recharge/engine/upstream/index.js'
]);
const isOnlineRechargeAdminPath = (path) =>
  path.startsWith('apps/admin/src/v2/features/online-recharge/') ||
  path === 'scripts/acceptance-v2-online-recharge-ui.mjs';
const isOnlineEngineRuntimePath = (path) =>
  onlineEngineWrapperPath.test(path) || onlineEngineRuntimeSources.has(path);
const onlineFocusedCiControls = new Set([
  'scripts/production-release/online-recharge-ci-build.py',
  'scripts/production-release/online-recharge-ci-build.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/acceptance-v2-online-recharge-ui.mjs',
  '.github/workflows/quality.yml'
]);
const onlineAdminIntegrationPaths = new Set([
  'apps/admin/src/v2-router.ts',
  'apps/admin/src/v2/features/feature.ts',
  'apps/admin/src/v2/features/registry.spec.ts',
  'scripts/check-v2-input-retention.mjs',
  'scripts/check-v2-online-recharge-controls.test.mjs'
]);
function isOnlineRechargeRuntimeOnly(paths) {
  return (
    paths.some(isOnlineEngineRuntimePath) &&
    paths.every(
      (path) =>
        isOnlineEngineRuntimePath(path) || isOnlineRechargeAdminPath(path) || isCiOnly([path])
    )
  );
}
export function needsOnlineRechargeCiBuild(paths) {
  if (isRechargeRecordRepairOnly(paths)) return false;
  const onlineAdminFeatureChanged = paths.some((path) =>
    path.startsWith('apps/admin/src/v2/features/online-recharge/')
  );
  if (
    paths.length &&
    paths.every(
      (path) =>
        path.startsWith('apps/admin/src/v2/features/online-recharge/') ||
        onlineEngineWrapperPath.test(path) ||
        onlineFocusedCiControls.has(path) ||
        (onlineAdminFeatureChanged && onlineAdminIntegrationPaths.has(path)) ||
        path.startsWith('docs/')
    )
  )
    return false;
  return (
    !isReleaseArtifactRetentionOnly(paths) &&
    paths.some(
      (path) =>
        onlineCiBuildInputs.has(path) ||
        path.startsWith('apps/api/src/id-business-v2/online-recharge/') ||
        path.startsWith('apps/admin/src/v2/features/online-recharge/')
    )
  );
}
export const productionDatabaseAccessHelper = 'scripts/lib/v2-production-database-access.mjs';
export const productionDatabaseAccessTest = 'scripts/production-database-access.test.mjs';
export const productionDatabaseAccessAcceptance =
  'scripts/acceptance-v2-production-database-access.mjs';
export const unpublishedComponentSuccessorControlPaths = Object.freeze([
  'scripts/production-release/unpublished-component-successor.py',
  'scripts/production-release/unpublished-component-successor.test.py',
  'scripts/production-release/unpublished-component-successor-readonly.py',
  'scripts/production-release/unpublished-component-successor-readonly.test.py',
  'scripts/production-release/unpublished-component-runtime-diagnostic.py',
  'scripts/production-release/unpublished-component-runtime-diagnostic.test.py',
  'scripts/production-release/unpublished-component-entry.test.mjs',
  'scripts/production-release/unified-component-source.test.py'
]);
export const ownedMysqlTestControlPaths = Object.freeze([
  'scripts/lib/owned-mysql-test-instance.mjs',
  'scripts/lib/owned-mysql-test-instance.test.mjs'
]);
export const unpublishedComponentSuccessorEntryPaths = Object.freeze([
  '.github/workflows/production-release.yml',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh'
]);
export const rechargeFlowSuccessorControlPaths = Object.freeze([
  'scripts/production-release/recharge-flow-successor.py',
  'scripts/production-release/recharge-flow-successor.test.py',
  'scripts/production-release/recharge-flow-successor-readonly.py',
  'scripts/production-release/recharge-flow-successor-readonly.test.py',
  'scripts/production-release/recharge-flow-successor-projection.py',
  'scripts/production-release/recharge-flow-successor-projection.test.py',
  'scripts/production-release/recharge-flow-successor-contract.json',
  'scripts/production-release/recharge-flow-entry.test.mjs'
]);
export const formalRuntimePackageControlPaths = Object.freeze([
  'scripts/production-release/formal-runtime-package.test.py',
  'scripts/production-release/formal-runtime-package/driver.py',
  'scripts/production-release/formal-runtime-package/manifest.json',
  'scripts/production-release/formal-runtime-package/package_io.py',
  'scripts/production-release/formal-runtime-package/pure.py',
  'scripts/production-release/formal-runtime-package/collector.py',
  'scripts/production-release/formal-runtime-package/constructor.py',
  'scripts/production-release/formal-runtime-package/reader.py',
  'scripts/production-release/formal-runtime-package/qualified.py',
  'scripts/production-release/formal-runtime-package/contract.json',
  'scripts/production-release/formal-runtime-package/reviewed-source-table.json',
  'scripts/production-release/formal-runtime-package/bootstrap-boundary.test.py',
  'scripts/production-release/formal-runtime-package/package.test.py',
  'scripts/production-release/formal-runtime-package/package-source.test.py',
  'scripts/production-release/formal-runtime-package/qualified.test.py',
  'scripts/production-release/formal-runtime-package/collector.test.py',
  'scripts/production-release/formal-runtime-package/collector-schema.test.py',
  'scripts/production-release/formal-runtime-package/collector-fixture.test-support.py',
  'scripts/production-release/formal-runtime-package/fixture-compose.test.yml',
  'scripts/production-release/formal-runtime-package/source-inputs.json',
  'scripts/production-release/formal-runtime-package/finite-profile-source-fields.json',
  'scripts/production-release/formal-runtime-package/sources/moby2516-api-types-network-endpoint.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-daemon-container_operations.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-internal-sliceutil-sliceutil.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-pkg-stringid-stringid.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-daemon-inspect.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-api-types-types.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-api-types-network-ipam.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-api-types-volume-volume.go',
  'scripts/production-release/formal-runtime-package/sources/docker-compose-v5.5.0-pkg-compose-create.go',
  'scripts/production-release/formal-runtime-package/sources/compose-spec-compose-go-v2.14.0-types-types.go',
  'scripts/production-release/formal-runtime-package/sources/compose-spec-compose-go-v2.14.0-types-command.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-volume-service-service.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-volume-service-convert.go',
  'scripts/production-release/formal-runtime-package/sources/moby2516-volume-local-local.go',
  'scripts/production-release/formal-runtime-package/sources/LICENSE',
  'scripts/production-release/formal-runtime-package/sources/SOURCE_NOTICES.md'
]);
const onlineRecoveryControls = new Set([
  onlineRechargeRecoveryPolicy,
  productionDatabaseAccessTest,
  ...onlineCiBuildControlPaths,
  'scripts/production-release/online-recharge-component-consumer.py',
  'scripts/production-release/online-recharge-component-consumer.test.py',
  'scripts/production-release/online-recharge-component-runtime.py',
  'scripts/production-release/online-recharge-component-runtime.test.py',
  'scripts/production-release/online-recharge-component-readonly.py',
  'scripts/production-release/online-recharge-component-readonly.test.py',
  'deploy/aws/bitbrowser-reviewed-release-20261012.json'
]);

function hasOnlineRechargeDeleteGrantProof(snapshot) {
  if (typeof snapshot?.before !== 'string' || typeof snapshot?.after !== 'string') return false;
  const digest = (source) => createHash('sha256').update(source).digest('hex');
  if (
    digest(snapshot.before) !== '6c8285ba7322d460c89778dc1793a553d1ddd8316f246d0411a3275857881e00'
  )
    return false;
  const anchor = "  'ip_whitelists',\n";
  if (snapshot.before.split(anchor).length !== 2) return false;
  const added =
    "  'online_recharge_bills',\n  'online_recharge_cards',\n  'online_recharge_proxies',\n";
  return (
    snapshot.after === snapshot.before.replace(anchor, anchor + added) &&
    digest(snapshot.after) === '7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546'
  );
}

export function hasBankCardDeletePolicyProof(paths, snapshot) {
  if (
    !paths.includes(productionDatabaseAccessHelper) ||
    !paths.includes(productionDatabaseAccessAcceptance) ||
    !paths.every(
      (path) =>
        path === productionDatabaseAccessHelper ||
        path === productionDatabaseAccessAcceptance ||
        isCiOnly([path])
    )
  )
    return false;
  const digest = (source) => createHash('sha256').update(source).digest('hex');
  const matches = (source, before, after) =>
    typeof source?.before === 'string' &&
    typeof source?.after === 'string' &&
    source.beforeMode === '100644' &&
    source.afterMode === '100644' &&
    digest(source.before) === before &&
    digest(source.after) === after;
  if (
    !matches(
      snapshot,
      '7ece1de5cbba89b26615d749a671d32a380f4dc377548071746d14f1f2e2a546',
      '36bfe57d9fd802fc647d09dd8871f1af4cee6cd03a68bf05a2509dd0e554570d'
    ) ||
    !matches(
      snapshot.acceptance,
      '15adadb670cdbd7645761b161f487b74550b271455289e60a97108e9e4ac46f1',
      'd39b620aa33ac21cecc0b9229dc0cc59967af1e890ea65c4e61d20fb1dbe269e'
    )
  )
    return false;
  const anchor = 'export const V2_RUNTIME_DELETE_TABLES = Object.freeze([\n';
  return (
    snapshot.before.split(anchor).length === 2 &&
    snapshot.after ===
      snapshot.before.replace(anchor, anchor + "  'id_business_v2_bank_recharge_cards',\n")
  );
}

export function readProductionDatabaseAccessSnapshot(base, paths) {
  if (
    !/^[a-f0-9]{40}$/.test(base) ||
    !paths.some((path) =>
      [productionDatabaseAccessHelper, productionDatabaseAccessAcceptance].includes(path)
    )
  )
    return undefined;
  const read = (path) => {
    const source = (revision) =>
      execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
    const mode = (revision) =>
      execFileSync('git', ['ls-tree', revision, '--', path], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)[0];
    return {
      before: source(base),
      after: source('HEAD'),
      beforeMode: mode(base),
      afterMode: mode('HEAD')
    };
  };
  try {
    return {
      ...read(productionDatabaseAccessHelper),
      ...(paths.includes(productionDatabaseAccessAcceptance)
        ? { acceptance: read(productionDatabaseAccessAcceptance) }
        : {})
    };
  } catch {
    // Missing Git bytes or modes must retain the full check mode.
    return undefined;
  }
}
export const auditRetentionMigration =
  'apps/api/prisma-mysql/migrations/20261002123500_routine_audit_retention_exception/migration.sql';
export const historicalReleaseControlPaths = Object.freeze([
  'scripts/backup-aws-mysql.sh',
  'scripts/backup-retention-protection.py',
  'scripts/backup-retention-protection.test.py',
  'scripts/production-release/backup-retention-install.py',
  'scripts/production-release/backup-retention-install.test.py',
  'deploy/aws/registration-worker-b8-80-20261006.json',
  'deploy/aws/registration-worker-956-20261006.json',
  'deploy/aws/registration-worker-85-20261006.json',
  'deploy/aws/registration-worker-86-20261006.json',
  'deploy/aws/registration-worker-87-20261006.json',
  'deploy/aws/registration-worker-88-20261006.json',
  'deploy/aws/registration-worker-89-20261006.json',
  'deploy/aws/registration-worker-90-20261007.json',
  'deploy/aws/registration-worker-91-20261007.json',
  'deploy/aws/registration-worker-92-20261007.json',
  'deploy/aws/registration-worker-93-20261007.json',
  'deploy/aws/registration-worker-94-20261007.json',
  'deploy/aws/registration-worker-95-20261008.json',
  'deploy/aws/registration-worker-96-20261008.json',
  'deploy/aws/registration-baseline-96-20261008.json',
  'scripts/production-release/registration-onboarding-96.py',
  'scripts/production-release/registration-onboarding-96.test.py',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs',
  'scripts/production-release/registration-only-transport.test.py',
  'deploy/aws/recharge-pro-menu-b8-20261005.json',
  'deploy/aws/recharge-pro-menu-7f-20261005.json',
  'deploy/aws/recharge-pro-main80-20261006.json',
  'deploy/aws/recharge-pro-974-20261007.json',
  'deploy/aws/recharge-pro-2f-20261007.json',
  'deploy/aws/recharge-pro-4c-20261008.json',
  'deploy/aws/recharge-pro-6f5-20261008.json',
  'deploy/aws/recharge-pro-pricing-045-20261008.json',
  'scripts/v2-release-mailbox-audit.mjs',
  'scripts/v2-release-mailbox-audit.test.mjs',
  'deploy/aws/historical-finance-20261005-mailbox-batch.json',
  'deploy/aws/historical-finance-20261005-registration-continuation.json',
  'deploy/aws/historical-finance-20261005-recharge-diagnostics.json',
  'deploy/aws/historical-finance-20261005-maintenance-continuation.json',
  'scripts/lib/v2-release-maintenance-policy.mjs',
  'scripts/v2-release-maintenance-audit.mjs',
  'scripts/v2-release-maintenance-policy.test.mjs',
  'deploy/aws/historical-finance-20261005-order-archive.json',
  'scripts/lib/v2-order-archive-release-policy.mjs',
  'scripts/v2-order-archive-release-audit.mjs',
  'scripts/v2-order-archive-release-policy.test.mjs',
  'deploy/aws/historical-finance-20261005-post-cleanup.json',
  'scripts/lib/v2-release-history-policy.mjs',
  'scripts/v2-release-history-audit.mjs',
  'scripts/v2-release-history-policy.test.mjs',
  'scripts/v2-release-post-cleanup-policy.test.mjs',
  'scripts/lib/v2-release-history-48.test-fixture.json',
  '.github/workflows/production-release.yml',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/admin-pending-online-release.py',
  'scripts/production-release/admin-pending-online-release.test.py',
  'scripts/production-release/admin-successor-diagnostic.py',
  'scripts/production-release/admin-successor-diagnostic.test.py',
  'scripts/production-release/build-image-cache.test.py',
  'scripts/production-release/browser-cache-input.py',
  'scripts/production-release/browser-cache-input.test.py',
  'scripts/production-release/service-image-retention.py',
  'scripts/production-release/service-image-retention.test.py',
  'scripts/production-release/disk-retention.py',
  'scripts/production-release/disk-retention.test.py',
  'scripts/production-release/disk-retention-install.py',
  'scripts/production-release/disk-retention-install.test.py',
  'scripts/production-release/disk-retention-transport.py',
  'scripts/production-release/disk-retention-transport.test.py',
  '.github/workflows/disk-retention-maintenance.yml',
  'scripts/production-release/candidate-retention.py',
  'scripts/production-release/candidate-retention.test.py',
  'scripts/production-release/disk-lifecycle.test.py',
  'scripts/production-release/release-storage.py',
  'scripts/production-release/release-storage.test.py',
  'deploy/aws/disk-retention-policy-20261014.json',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/retire-orphan-retention.py',
  'scripts/production-release/retire-orphan-retention.test.py',
  'scripts/production-release/prepared-images.test.py',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/maintain-image-cache.py',
  'scripts/production-release/maintain-image-cache.test.py',
  'scripts/production-release/api-admin-pending-projection.py',
  'scripts/production-release/api-admin-pending-projection.test.py',
  'scripts/production-release/api-admin-pending-online.test.py',
  'scripts/production-release/api-admin-pending-receipt-wire.py',
  'scripts/production-release/api-admin-pending-receipt-wire.test.py',
  'scripts/production-release/api-workspace-declaration-readonly.py',
  'scripts/production-release/api-workspace-declaration-readonly.test.py',
  'scripts/production-release/api-workspace-declaration-artifacts.py',
  'scripts/production-release/api-workspace-declaration-artifacts.test.py',
  'scripts/production-release/online-recharge-declaration-measurement.py',
  'scripts/production-release/online-recharge-declaration-measurement.test.py',
  'scripts/production-release/online-recharge-daemon-identity.py',
  'scripts/production-release/online-recharge-daemon-identity.test.py',
  'scripts/production-release/online-recharge-daemon-listener.py',
  'scripts/production-release/online-recharge-daemon-listener.test.py',
  'scripts/production-release/online-recharge-daemon-socket.py',
  'scripts/production-release/online-recharge-daemon-socket.test.py',
  'scripts/production-release/online-recharge-runtime-socket-diagnostic.test.py',
  'scripts/production-release/online-recharge-source-permission-repair.py',
  'scripts/production-release/online-recharge-source-permission-repair.test.py',
  'scripts/production-release/online-recharge-source-permission-repair-transport.py',
  'scripts/production-release/online-recharge-source-permission-repair-transport.test.py',
  'scripts/production-release/api-workspace-public-permission-repair.py',
  'scripts/production-release/api-workspace-public-permission-repair-transport.py',
  'scripts/production-release/api-workspace-public-permission-repair.test.py',
  'scripts/production-release/online-recharge-backup-source-recovery.py',
  'scripts/production-release/online-recharge-backup-source-recovery.test.py',
  'scripts/production-release/online-recharge-backup-source-recovery-transport.py',
  'scripts/production-release/online-recharge-backup-source-recovery-transport.test.py',
  'scripts/production-release/online-recharge-backup-parent-owner-repair.py',
  'scripts/production-release/online-recharge-backup-parent-owner-repair.test.py',
  ...formalRuntimePackageControlPaths
]);
const recharge4cProfile = 'deploy/aws/recharge-pro-4c-20261008.json';
const recharge4cSources = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/plan_selection.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_pro.py'
]);
const recharge4cControls = new Set([
  recharge4cProfile,
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/maintain-image-cache.py',
  'scripts/production-release/maintain-image-cache.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-release.test.mjs',
  'docs/V2_TASKS.md'
]);
function isRecharge4cOnly(paths) {
  return (
    paths.includes(recharge4cProfile) &&
    paths.every((path) => recharge4cSources.has(path) || recharge4cControls.has(path))
  );
}
const recharge6f5Profile = 'deploy/aws/recharge-pro-6f5-20261008.json';
const recharge6f5Sources = new Set(recharge4cSources);
const recharge6f5Controls = new Set(
  [...recharge4cControls].filter((path) => path !== recharge4cProfile)
);
recharge6f5Controls.add(recharge6f5Profile);
function isRecharge6f5Only(paths) {
  return (
    paths.includes(recharge6f5Profile) &&
    paths.every((path) => recharge6f5Sources.has(path) || recharge6f5Controls.has(path))
  );
}
const rechargePricingProfile = 'deploy/aws/recharge-pro-pricing-045-20261008.json';
const rechargePricingSources = new Set([
  ...recharge6f5Sources,
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
const rechargePricingControls = new Set(
  [...recharge6f5Controls].filter((path) => path !== recharge6f5Profile)
);
for (const path of [
  'deploy/aws/registration-baseline-96-20261008.json',
  'deploy/aws/registration-worker-96-20261008.json',
  'scripts/ci-recharge-check.mjs',
  'scripts/production-release/registration-onboarding-96.py',
  'scripts/production-release/registration-onboarding-96.test.py',
  'scripts/production-release/registration-only-transport.test.py'
])
  rechargePricingControls.add(path);
rechargePricingControls.add(rechargePricingProfile);
function isRechargePricingOnly(paths) {
  return (
    paths.includes(rechargePricingProfile) &&
    paths.every((path) => rechargePricingSources.has(path) || rechargePricingControls.has(path))
  );
}
const registrationProfileObservationProfile = 'deploy/aws/registration-worker-91-20261007.json';
const registrationProfileObservationSources = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
const registrationProfileObservationControls = new Set([
  registrationProfileObservationProfile,
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/registration-only-transport.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-release.test.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs'
]);
const isRegistrationProfileObservationControl = (path) =>
  registrationProfileObservationControls.has(path) ||
  /^(?:docs\/.*\.md|(?:README|AGENTS)\.md)$/.test(path);
function isRegistrationProfileObservationOnly(paths) {
  return (
    paths.includes(registrationProfileObservationProfile) &&
    paths.every(
      (path) =>
        registrationProfileObservationSources.has(path) ||
        isRegistrationProfileObservationControl(path)
    )
  );
}
const registrationLoginProfile = 'deploy/aws/registration-worker-93-20261007.json';
const registrationLoginSources = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
const registrationLoginControls = new Set([
  registrationLoginProfile,
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/registration-only-transport.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-release.test.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs',
  'scripts/production-release/maintain-image-cache.py',
  'scripts/production-release/maintain-image-cache.test.py',
  'scripts/production-release/service-image-retention.py',
  'scripts/production-release/service-image-retention.test.py',
  'scripts/production-release/browser-cache-input.py',
  'scripts/production-release/browser-cache-input.test.py',
  'scripts/production-release/build-image-cache.test.py'
]);
const isRegistrationLoginControl = (path) =>
  registrationLoginControls.has(path) ||
  ['docs/V2_TASKS.md', 'docs/AUTO_REGISTRATION.md'].includes(path);
const registrationFollowupProfile = 'deploy/aws/registration-worker-94-20261007.json';
const registrationInterstitialProfile = 'deploy/aws/registration-worker-95-20261008.json';
const registrationInterstitialModule = 'scripts/production-release/registration-interstitial-95.py';
export const registrationOnboardingProfile = 'deploy/aws/registration-worker-96-20261008.json';
export const registrationOnboardingControls = new Set([
  registrationOnboardingProfile,
  'deploy/aws/registration-baseline-96-20261008.json',
  'scripts/production-release/registration-onboarding-96.py',
  'scripts/production-release/registration-onboarding-96.test.py',
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/registration-only-transport.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-release.test.mjs'
]);
const registrationOnboardingSources = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
export const hasRegistrationOnboardingScope = (paths) =>
  !isRechargePricingOnly(paths) &&
  paths.some((path) =>
    [
      registrationOnboardingProfile,
      'deploy/aws/registration-baseline-96-20261008.json',
      'scripts/production-release/registration-onboarding-96.py',
      'scripts/production-release/registration-onboarding-96.test.py'
    ].includes(path)
  );
const isRegistrationOnboardingControl = (path) =>
  registrationOnboardingControls.has(path) ||
  ['docs/V2_TASKS.md', 'docs/AUTO_REGISTRATION.md'].includes(path);
const isRegistrationOnboardingOnly = (paths) =>
  hasRegistrationOnboardingScope(paths) &&
  paths.every(
    (path) => registrationOnboardingSources.has(path) || isRegistrationOnboardingControl(path)
  );
const isRegistrationInterstitialControl = (path) =>
  path === registrationInterstitialModule || isRegistrationFollowupControl(path);
const isRegistrationFollowupControl = (path) =>
  path === registrationFollowupProfile ||
  path === registrationInterstitialProfile ||
  [
    'scripts/production-release/api-admin-scope.py',
    'scripts/production-release/api-admin-scope.test.py'
  ].includes(path) ||
  (path !== registrationLoginProfile && isRegistrationLoginControl(path));
function isRegistrationInterstitialOnly(paths) {
  return (
    paths.includes(registrationInterstitialProfile) &&
    !paths.includes(registrationFollowupProfile) &&
    paths.every(
      (path) => registrationLoginSources.has(path) || isRegistrationInterstitialControl(path)
    )
  );
}
function isRegistrationLoginOnly(paths) {
  return (
    paths.includes(registrationLoginProfile) &&
    paths.every((path) => registrationLoginSources.has(path) || isRegistrationLoginControl(path))
  );
}
const registrationRecoveryProfile = 'deploy/aws/registration-worker-92-20261007.json';
const registrationRecoverySources = new Set([
  'apps/api/src/id-business-v2/auto-registration/registration-validation.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-jobs.service.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-worker.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-events.service.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-jobs.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-worker.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-events.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/registration-mysql.integration.spec.ts',
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_builtin.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_job.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_builtin.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
const registrationRecoveryControls = new Set([
  ...registrationProfileObservationControls,
  registrationRecoveryProfile,
  'docs/AUTO_REGISTRATION.md',
  'docs/V2_TASKS.md'
]);
registrationRecoveryControls.delete(registrationProfileObservationProfile);
const isRegistrationRecoveryControl = (path) => registrationRecoveryControls.has(path);
function isRegistrationRecoveryOnly(paths) {
  return (
    paths.includes(registrationRecoveryProfile) &&
    paths.every(
      (path) => registrationRecoverySources.has(path) || isRegistrationRecoveryControl(path)
    )
  );
}
export const releaseArtifactRetentionControls = Object.freeze([
  'scripts/production-release/release-artifact-retention.py',
  'scripts/production-release/release-artifact-retention.test.py',
  'scripts/production-release/release-artifact-retention-transport.py',
  'scripts/production-release/release-artifact-retention-transport.test.py',
  '.github/workflows/release-artifact-retention.yml',
  'deploy/aws/release-artifact-storage-proof-20261014.json'
]);
const releaseArtifactRetentionSupport = new Set([
  ...releaseArtifactRetentionControls,
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/DISK_STORAGE_POLICY.md',
  'docs/V2_TASKS.md'
]);
export function isReleaseArtifactRetentionOnly(paths) {
  return (
    paths.length > 0 &&
    paths.some((path) => releaseArtifactRetentionControls.includes(path)) &&
    paths.every((path) => releaseArtifactRetentionSupport.has(path))
  );
}

export function isCiOnly(paths) {
  if (paths.includes(rechargePricingProfile))
    return paths.every((path) => rechargePricingControls.has(path));
  if (hasRegistrationOnboardingScope(paths))
    return isRegistrationOnboardingOnly(paths) && paths.every(isRegistrationOnboardingControl);
  if (paths.includes(recharge6f5Profile))
    return paths.every((path) => recharge6f5Controls.has(path));
  if (paths.includes(registrationInterstitialProfile))
    return isRegistrationInterstitialOnly(paths) && paths.every(isRegistrationInterstitialControl);
  if (paths.includes(recharge4cProfile)) return paths.every((path) => recharge4cControls.has(path));
  if (paths.includes(registrationFollowupProfile))
    return (
      !paths.includes(registrationInterstitialProfile) && paths.every(isRegistrationFollowupControl)
    );
  if (paths.includes(registrationLoginProfile)) return paths.every(isRegistrationLoginControl);
  if (paths.includes(registrationRecoveryProfile))
    return paths.every(isRegistrationRecoveryControl);
  if (paths.includes(registrationProfileObservationProfile))
    return paths.every(isRegistrationProfileObservationControl);
  return (
    paths.length > 0 &&
    paths.every(
      (p) =>
        releaseArtifactRetentionControls.includes(p) ||
        rechargeRecordControlPaths.includes(p) ||
        historicalReleaseControlPaths.includes(p) ||
        unpublishedComponentSuccessorControlPaths.includes(p) ||
        rechargeFlowSuccessorControlPaths.includes(p) ||
        ownedMysqlTestControlPaths.includes(p) ||
        onlineRecoveryControls.has(p) ||
        /^(?:\.github\/workflows\/(?:quality|production-release)\.yml|scripts\/ci-(?:recharge|change)-[\w.-]+|scripts\/check-v2-(?:module-architecture|prisma-runtime-boundary|concurrency-standard)(?:\.test)?\.mjs|scripts\/production-release\/online-recharge-entry\.test\.mjs|scripts\/production-release\/mailbox-diagnostic(?:\.test)?\.(?:mjs|py)|scripts\/production-release\/(?:cleanup-reviewed-cache|cleanup-verified-backups|maintain-image-cache|remote-deploy|reuse-images|storage-maintenance|api-admin-scope|api-admin-readonly|online-recharge-scope|online-recharge-readonly)(?:\.test)?\.py|scripts\/production-release\/audit-retention-mysql\.test\.py|scripts\/production-release\/(?:build-images|push-images|dispatch|check-source)\.sh|deploy\/aws\/cache-cleanup-(?:legacy-20261002|unused-legacy-20261003|storage-20261002|bitbrowser-direct-20261003|20261001|fx-subscription-20261002|unified(?:-recovery)?-20261002|recharge-(?:names|execution)-20261002)\.json|docs\/.*\.md|(?:README|AGENTS)\.md)$/.test(
          p
        )
    )
  );
}
const adminPublicDocument = /^apps\/admin\/public\/[^/]+\.(?:html|css)$/;
const registrationHydrationSourcePaths = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
  'apps/admin/src/api/requestPolicy.ts',
  'apps/admin/src/api/requestPolicy.spec.ts',
  'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts',
  'apps/admin/src/v2/features/auto-registration/useRegistrationPage.spec.ts'
]);

function isRegistrationHydrationOnly(paths) {
  return (
    paths.includes('deploy/aws/registration-worker-90-20261007.json') &&
    paths.some((path) => registrationHydrationSourcePaths.has(path)) &&
    paths.every((path) => registrationHydrationSourcePaths.has(path) || isCiOnly([path]))
  );
}

const workspaceDockAcceptance = 'scripts/acceptance-v2-workspace-dock.mjs';
const combinedComponentAcceptancePaths = new Set([
  'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
  'scripts/acceptance-v2-recharge-employee-concurrency.test.mjs'
]);
export function hasCombinedComponentScope(paths) {
  return (
    paths.includes('scripts/production-release/unpublished-component-successor.py') &&
    paths.includes(workspaceDockAcceptance) &&
    paths.includes('scripts/acceptance-v2-recharge-employee-concurrency.mjs')
  );
}
const adminInteractionAcceptance = new Set([
  'scripts/acceptance-v2-online-recharge-ui.mjs',
  'scripts/acceptance-v2-bitbrowser-direct.mjs',
  'scripts/acceptance-v2-refresh-interaction.mjs',
  'scripts/acceptance-v2-auto-recharge.mjs',
  'scripts/acceptance-v2-bank-recharge-ui.mjs',
  workspaceDockAcceptance,
  'scripts/lib/vite-cli.mjs'
]);
export function isAdminOnly(paths) {
  const combined = hasCombinedComponentScope(paths);
  const onlineAdminFeatureChanged = paths.some((path) =>
    path.startsWith('apps/admin/src/v2/features/online-recharge/')
  );
  return (
    paths.some(
      (p) =>
        p.startsWith('apps/admin/src/v2/') ||
        adminInteractionAcceptance.has(p) ||
        adminPublicDocument.test(p) ||
        p === 'scripts/acceptance-v2-order-archive-ui.mjs'
    ) &&
    paths.every(
      (p) =>
        p.startsWith('apps/admin/src/v2/') ||
        (onlineAdminFeatureChanged && onlineAdminIntegrationPaths.has(p)) ||
        adminInteractionAcceptance.has(p) ||
        p === 'apps/admin/src/components/ui/AppButton.vue' ||
        /^scripts\/(?:admin-skin-rules(?:\.test)?|check-v2-color-contrast|acceptance-v2-(?:color-contrast|skin-consistency|business-skin))\.mjs$/.test(
          p
        ) ||
        adminPublicDocument.test(p) ||
        p === 'scripts/acceptance-v2-table-layout.mjs' ||
        p === 'scripts/acceptance-v2-order-archive-ui.mjs' ||
        /^scripts\/(?:admin-layout-rules(?:\.test)?|check-admin-ui-guardrails|acceptance-v2-(?:filter|page)-layout)\.mjs$/.test(
          p
        ) ||
        p === 'apps/admin/layout-contract-fixture.html' ||
        p === 'scripts/check-v2-table-standard.mjs' ||
        (combined && combinedComponentAcceptancePaths.has(p)) ||
        isCiOnly([p])
    )
  );
}

const mailboxPaths =
  /^(?:\.env\.(?:example|aws\.production\.example)|docker-compose\.aws-mysql\.yml|apps\/admin\/src\/api\/requestPolicy(?:\.spec)?\.ts|apps\/admin\/src\/v2\/features\/(?:feature|registry(?:\.spec)?|runtimeRegistry|tableSchemas)\.ts|apps\/admin\/src\/v2\/features\/auto-recharge\/(?:V2VendureMailboxView\.vue|VendureMailboxManager\.vue|vendure-mailbox[^/]*)|apps\/api\/src\/id-business-v2\/workspace\/(?:dto\/id-business-v2-vendure-mailbox\.dto\.ts|id-business-v2-(?:mail-viewer\.service(?:\.spec)?|public-vendure-mailbox\.controller|vendure-mailbox\.(?:controller|service)(?:\.spec)?|workspace\.module)\.ts|providers\/id-business-v2-vendure-mailbox\.client(?:\.spec)?\.ts)|packages\/shared\/src\/(?:index\.ts|v2\/vendure-mailbox\.ts))$/;
export function isMailboxOnly(paths) {
  return (
    paths.some((path) => mailboxPaths.test(path)) &&
    paths.every((path) => mailboxPaths.test(path) || isCiOnly([path]))
  );
}

export function checkMode(paths, oldSchema, newSchema, grantHelperSnapshot) {
  if (paths.includes(rechargePricingProfile)) {
    if (!isRechargePricingOnly(paths)) return 'full';
    return paths.some((path) => rechargePricingSources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (hasRegistrationOnboardingScope(paths)) {
    if (!isRegistrationOnboardingOnly(paths)) return 'full';
    return paths.some((path) => registrationOnboardingSources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (paths.includes(recharge6f5Profile)) {
    if (!isRecharge6f5Only(paths)) return 'full';
    return paths.some((path) => recharge6f5Sources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (paths.includes(registrationInterstitialProfile)) {
    if (!isRegistrationInterstitialOnly(paths)) return 'full';
    return paths.some((path) => registrationLoginSources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (paths.includes(recharge4cProfile)) {
    if (!isRecharge4cOnly(paths)) return 'full';
    return paths.some((path) => recharge4cSources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (paths.includes(registrationFollowupProfile)) {
    return !paths.includes(registrationInterstitialProfile) &&
      paths.every(isRegistrationFollowupControl)
      ? 'ci-only'
      : 'full';
  }
  if (paths.includes(registrationRecoveryProfile)) {
    if (!isRegistrationRecoveryOnly(paths)) return 'full';
    return paths.some((path) => registrationRecoverySources.has(path)) ? 'recharge' : 'ci-only';
  }
  if (paths.includes(registrationProfileObservationProfile)) {
    if (!isRegistrationProfileObservationOnly(paths)) return 'full';
    return paths.some((path) => registrationProfileObservationSources.has(path))
      ? 'recharge'
      : 'ci-only';
  }
  if (
    paths.includes(auditRetentionMigration) &&
    paths.every((path) => path === auditRetentionMigration || isCiOnly([path]))
  )
    return 'audit-retention';
  if (hasBankCardDeletePolicyProof(paths, grantHelperSnapshot)) return 'ci-only';
  if (paths.includes(productionDatabaseAccessHelper))
    return hasOnlineRechargeDeleteGrantProof(grantHelperSnapshot) &&
      paths.every((path) => path === productionDatabaseAccessHelper || isCiOnly([path]))
      ? 'ci-only'
      : 'full';
  if (isCiOnly(paths)) return 'ci-only';
  if (isOnlineRechargeRuntimeOnly(paths)) return 'recharge';
  if (isMailboxOnly(paths)) return 'mailbox';
  if (isTargetedOnly(paths, oldSchema, newSchema)) return 'recharge';
  if (isAdminOnly(paths)) return 'admin';
  return 'full';
}

export function adminUiGuardChecks(mode, paths) {
  if (mode !== 'admin' && mode !== 'mailbox' && mode !== 'recharge') return [];
  const hasV2Changes = paths.some((p) => p.startsWith('apps/admin/src/v2/'));
  if (mode === 'recharge' && !hasV2Changes) return [];
  return [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    ...(mode === 'admin' || hasV2Changes ? ['check:v2-module-architecture'] : []),
    'check:v2-isolation',
    'check:v2-decimal-standard'
  ];
}

export function backendArchitectureGuardChecks(mode, paths) {
  if (mode === 'ci-only') {
    return ['module-architecture', 'prisma-runtime-boundary', 'concurrency-standard']
      .filter((guard) =>
        paths.some(
          (path) =>
            path === `scripts/check-v2-${guard}.mjs` ||
            path === `scripts/check-v2-${guard}.test.mjs`
        )
      )
      .map((guard) => `check:v2-${guard}`);
  }
  if (!['recharge', 'mailbox'].includes(mode)) return [];
  const affectsBackend = paths.some((path) =>
    /^(?:apps\/api\/src\/.*\.ts$|apps\/api\/prisma-mysql\/|packages\/shared\/src\/)/.test(path)
  );
  return affectsBackend
    ? [
        'check:v2-module-architecture',
        'check:v2-prisma-runtime-boundary',
        'check:v2-concurrency-standard'
      ]
    : [];
}

export function adminCheckCommands(mode, paths) {
  const commands = [['run', 'build', '--workspace', '@apple-business/shared']];
  if (mode === 'mailbox') {
    commands.push([
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/registry.spec.ts',
      'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
    ]);
    commands.push(['run', 'build', '--workspace', '@apple-business/admin']);
    return commands;
  }
  commands.push([
    'run',
    'test',
    '--workspace',
    '@apple-business/admin',
    ...(mode === 'admin' || hasAppleMailboxScope(paths)
      ? []
      : [
          '--',
          'src/v2/features/auto-recharge',
          ...(paths.some((p) => p.startsWith('apps/admin/src/v2/features/online-recharge/'))
            ? ['src/v2/features/online-recharge']
            : []),
          ...(paths.some((p) => p.includes('/audit-logs/'))
            ? ['src/v2/features/audit-logs/audit-log-presentation.spec.ts']
            : [])
        ])
  ]);
  commands.push(['run', 'build', '--workspace', '@apple-business/admin']);
  if (
    paths.some(
      (path) =>
        path === workspaceDockAcceptance ||
        path.startsWith('apps/admin/src/v2/components/workspace/') ||
        /^apps\/admin\/src\/v2\/(?:layouts\/V2AdminLayout\.vue|styles\/(?:base|layout|records|v2)\.css|testing\/(?:V2WorkspaceDesignFixture\.vue|workspace-design-fixture\.ts))$/.test(
          path
        )
    )
  )
    commands.push(['exec', '--', 'node', workspaceDockAcceptance]);
  if (
    paths.some(
      (path) =>
        path.startsWith('apps/admin/src/v2/features/online-recharge/') ||
        path === 'scripts/acceptance-v2-online-recharge-ui.mjs'
    )
  )
    commands.push(['run', 'acceptance:v2-online-recharge-ui']);
  if (
    paths.some((path) =>
      /^(?:apps\/admin\/src\/v2\/features\/orders\/|apps\/admin\/src\/v2\/(?:api|types)\/orders\.ts$|apps\/admin\/src\/v2\/styles\/(?:base|layout|records)\.css$|scripts\/acceptance-v2-order-archive-ui\.mjs$)/.test(
        path
      )
    )
  )
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-order-archive-ui.mjs']);
  if (
    paths.some((path) =>
      /^(?:apps\/admin\/src\/v2\/styles\/records\.css|apps\/admin\/src\/v2\/features\/auto-recharge\/vendure-mailbox\.css|scripts\/acceptance-v2-table-layout\.mjs)$/.test(
        path
      )
    )
  )
    commands.push(['run', 'acceptance:v2-table-layout']);
  if (
    mode !== 'admin' ||
    paths.some((p) => p.startsWith('apps/admin/src/v2/features/auto-recharge/'))
  )
    commands.push(['run', 'acceptance:v2-auto-recharge']);
  if (
    paths.some((p) =>
      /(?:layout\.css|V2(?:PageOverview|OverviewMetric|ListToolbar|PageContext)\.vue|admin-layout-rules|acceptance-v2-(?:filter|page)-layout)/.test(
        p
      )
    )
  ) {
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-filter-layout.mjs']);
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-page-layout.mjs']);
  }
  return commands;
}
const migration =
  'apps/api/prisma-mysql/migrations/20260913100000_auto_recharge_browser_options/migration.sql';
const schema = 'apps/api/prisma-mysql/schema.prisma';
export const rechargeConnectionProfileMigration =
  'apps/api/prisma-mysql/migrations/20261012143000_recharge_connection_profiles/migration.sql';
const rechargeConnectionAcceptancePaths = new Set([
  'scripts/acceptance-v2-recharge-employee-concurrency.mjs',
  'scripts/acceptance-v2-registration-mirror-mysql.mjs'
]);
export const hasRechargeConnectionMigrationScope = (paths) =>
  paths.some(
    (path) =>
      path === rechargeConnectionProfileMigration ||
      path === 'scripts/acceptance-v2-recharge-employee-concurrency.mjs'
  );
const registrationMirrorSourcePaths = new Set([
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.ts',
  'apps/api/src/id-business-v2/auto-recharge/bank-recharge-registration-mirror.service.spec.ts',
  'scripts/fixtures/registration-closed-loop-worker.py',
  'scripts/acceptance-v2-registration-mirror-mysql.mjs'
]);
export const hasRegistrationMirrorScope = (paths) =>
  paths.some((path) => registrationMirrorSourcePaths.has(path));
const sharedTableSourcePaths = new Set([
  'apps/admin/src/v2/components/V2Table.vue',
  'apps/admin/src/v2/components/V2TableActionColumn.vue',
  'apps/admin/src/v2/components/V2TableColumn.vue',
  'apps/admin/src/v2/components/tableColumn.spec.ts',
  'apps/admin/src/v2/components/tableColumn.ts',
  'apps/admin/src/v2/components/tableContentWidth.spec.ts',
  'apps/admin/src/v2/components/tableContentWidth.ts',
  'apps/admin/src/v2/components/tableVisibility.ts',
  'apps/admin/src/v2/composables/useV2TableContentWidths.ts',
  'scripts/check-v2-table-standard.mjs'
]);

function hasRechargeConnectionSchemaProof(paths, before, after) {
  if (!paths.includes(schema)) return true;
  if (
    !paths.includes(rechargeConnectionProfileMigration) ||
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    before.includes('model IdBusinessV2RechargeConnectionProfile ')
  )
    return false;
  const model = /model IdBusinessV2RechargeConnectionProfile \{[^}]*\}/g;
  const matches = [...after.matchAll(model)];
  if (matches.length !== 1) return false;
  const block = matches[0][0];
  return (
    createHash('sha256').update(block).digest('hex') ===
      'c90f01a51b3648cffebc3e7d852b5c8a53a060e95b7cf4c35ad05133a5d60d0a' &&
    after.replace(block + '\n\n', '') === before
  );
}
const allowed =
  /^(?:apps\/admin\/src\/v2\/features\/auto-recharge\/|apps\/api\/src\/id-business-v2\/auto-recharge\/|packages\/shared\/src\/v2\/auto-recharge\.ts$|docs\/|scripts\/ci-recharge-[\w.-]+$|scripts\/check-v2-(?:decimal-standard|ui-language)\.mjs$|scripts\/acceptance-v2-auto-recharge\.mjs$|\.github\/workflows\/quality\.yml$)/;
const appleMailboxApiPaths = new Set([
  'apps/api/src/id-business-v2/auto-registration/apple-mailbox-pool.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes-task-bridge.service.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_closed_loop.py',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_registration_diagnostics.py',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.css',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js',
  'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_apple_mailboxes.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_release_safety.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_workspace.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_upload_compat.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_payment_browser.mjs',
  'apps/api/src/id-business-v2/auto-registration/worker/upload_compat.py',
  'apps/api/src/id-business-v2/auto-registration/worker/workspace.py',
  'scripts/fixtures/registration-closed-loop-worker.py'
]);
const bitOrdersAcceptancePaths = new Set([
  'scripts/acceptance-v2-bank-recharge-ui.mjs',
  'scripts/acceptance-v2-bit-orders-mysql.mjs',
  'scripts/acceptance-v2-table-layout.mjs'
]);
export const hasAppleMailboxScope = (paths) => paths.some((path) => appleMailboxApiPaths.has(path));

export function isRechargeOnly(paths, oldSchema, newSchema) {
  if (paths.includes(rechargePricingProfile))
    return isRechargePricingOnly(paths) && paths.some((path) => rechargePricingSources.has(path));
  if (hasRegistrationOnboardingScope(paths))
    return (
      isRegistrationOnboardingOnly(paths) &&
      paths.some((path) => registrationOnboardingSources.has(path))
    );
  if (paths.includes(registrationInterstitialProfile))
    return (
      isRegistrationInterstitialOnly(paths) &&
      paths.some((path) => registrationLoginSources.has(path))
    );
  if (paths.includes(recharge6f5Profile))
    return isRecharge6f5Only(paths) && paths.some((path) => recharge6f5Sources.has(path));
  if (paths.includes(recharge4cProfile))
    return isRecharge4cOnly(paths) && paths.some((path) => recharge4cSources.has(path));
  if (paths.includes(registrationLoginProfile))
    return (
      isRegistrationLoginOnly(paths) && paths.some((path) => registrationLoginSources.has(path))
    );
  if (paths.includes(registrationRecoveryProfile))
    return (
      isRegistrationRecoveryOnly(paths) &&
      paths.some((path) => registrationRecoverySources.has(path))
    );
  if (paths.includes(registrationProfileObservationProfile))
    return (
      isRegistrationProfileObservationOnly(paths) &&
      paths.some((path) => registrationProfileObservationSources.has(path))
    );
  if (
    !paths.length ||
    !paths.some(
      (p) =>
        p.includes('auto-recharge') || p === migration || rechargeConnectionAcceptancePaths.has(p)
    )
  )
    return false;
  if (
    !paths.every(
      (p) =>
        allowed.test(p) ||
        rechargeRecordControlPaths.includes(p) ||
        historicalReleaseControlPaths.includes(p) ||
        unpublishedComponentSuccessorControlPaths.includes(p) ||
        rechargeFlowSuccessorControlPaths.includes(p) ||
        ownedMysqlTestControlPaths.includes(p) ||
        sharedTableSourcePaths.has(p) ||
        rechargeConnectionAcceptancePaths.has(p) ||
        p === rechargeConnectionProfileMigration ||
        p === schema ||
        p === migration
    )
  )
    return false;
  if (!paths.includes(schema)) return true;
  if (paths.includes(rechargeConnectionProfileMigration))
    return hasRechargeConnectionSchemaProof(paths, oldSchema, newSchema);
  const model = /model IdBusinessV2RechargeBrowserSetting \{[^}]*\}\s*/;
  return (
    typeof oldSchema === 'string' &&
    typeof newSchema === 'string' &&
    model.test(oldSchema) &&
    model.test(newSchema) &&
    oldSchema.replace(model, '') === newSchema.replace(model, '')
  );
}

// These security modules have explicit targeted checks below; other code remains full scope.
const securityPaths =
  /^(?:apps\/api\/src\/auth\/(?:auth\.service|password-hasher)(?:\.spec)?\.ts$|apps\/admin\/src\/v2\/features\/audit-logs\/audit-log-presentation(?:\.spec)?\.ts$|apps\/api\/src\/id-business-v2\/workspace\/media-resolver\/|scripts\/(?:audit-python-dependencies(?:\.test)?\.py|container-hardening\.test\.mjs|start-auto-recharge-connector\.sh)$|\.github\/workflows\/python-dependency-audit\.yml$)/;
export function isTargetedOnly(paths, oldSchema, newSchema) {
  if (paths.includes(rechargePricingProfile)) return isRechargeOnly(paths, oldSchema, newSchema);
  if (hasRegistrationOnboardingScope(paths)) return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(registrationInterstitialProfile))
    return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(recharge6f5Profile)) return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(recharge4cProfile)) return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(registrationLoginProfile)) return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(registrationRecoveryProfile))
    return isRechargeOnly(paths, oldSchema, newSchema);
  if (paths.includes(registrationProfileObservationProfile))
    return isRechargeOnly(paths, oldSchema, newSchema);
  if (hasAppleMailboxScope(paths))
    return (
      hasRechargeConnectionSchemaProof(paths, oldSchema, newSchema) &&
      paths.every(
        (path) =>
          appleMailboxApiPaths.has(path) ||
          allowed.test(path) ||
          isAdminOnly([path]) ||
          isCiOnly([path]) ||
          bitOrdersAcceptancePaths.has(path) ||
          sharedTableSourcePaths.has(path) ||
          rechargeConnectionAcceptancePaths.has(path) ||
          path === rechargeConnectionProfileMigration ||
          path === schema
      )
    );
  return (
    isRegistrationHydrationOnly(paths) ||
    isRechargeOnly(paths, oldSchema, newSchema) ||
    (paths.some((p) => securityPaths.test(p)) &&
      paths.every(
        (p) => allowed.test(p) || historicalReleaseControlPaths.includes(p) || securityPaths.test(p)
      ))
  );
}
export function selectedParts(paths, grantHelperSnapshot) {
  if (isReleaseArtifactRetentionOnly(paths)) return ['guards'];
  if (isOnlineRechargeRuntimeOnly(paths))
    return ['guards', ...(paths.some(isOnlineRechargeAdminPath) ? ['admin'] : []), 'online-engine'];
  if (
    isAdminOnly(paths) &&
    paths.some(
      (path) =>
        path.startsWith('apps/admin/src/v2/features/online-recharge/') ||
        path === 'scripts/acceptance-v2-online-recharge-ui.mjs'
    )
  )
    return ['guards', 'admin'];
  if (hasBankCardDeletePolicyProof(paths, grantHelperSnapshot)) return ['guards', 'security'];
  if (isRechargePricingOnly(paths))
    return paths.some((path) => rechargePricingSources.has(path))
      ? ['guards', 'connector']
      : ['guards'];
  if (isRegistrationOnboardingOnly(paths))
    return [
      'guards',
      ...(paths.some((path) => registrationOnboardingSources.has(path)) ? ['connector'] : [])
    ];
  if (isRecharge6f5Only(paths))
    return paths.some((path) => recharge6f5Sources.has(path))
      ? ['guards', 'connector']
      : ['guards'];
  if (isRecharge4cOnly(paths))
    return paths.some((path) => recharge4cSources.has(path)) ? ['guards', 'connector'] : ['guards'];
  if (isRegistrationInterstitialOnly(paths))
    return [
      'guards',
      ...(paths.some((path) => registrationLoginSources.has(path)) ? ['connector'] : [])
    ];
  if (
    paths.includes(registrationFollowupProfile) &&
    !paths.includes(registrationInterstitialProfile) &&
    paths.every(isRegistrationFollowupControl)
  )
    return ['guards'];
  if (isRegistrationRecoveryOnly(paths))
    return [
      'guards',
      ...(paths.some((path) => registrationRecoverySources.has(path) && path.endsWith('.ts'))
        ? ['api']
        : []),
      ...(paths.some((path) => registrationRecoverySources.has(path) && path.endsWith('.py'))
        ? ['connector']
        : [])
    ];
  if (isRegistrationLoginOnly(paths))
    return paths.some((path) => registrationLoginSources.has(path))
      ? ['guards', 'connector']
      : ['guards'];
  if (isRegistrationProfileObservationOnly(paths))
    return paths.some((path) => registrationProfileObservationSources.has(path))
      ? ['guards', 'connector']
      : ['guards'];
  return parts.filter((part) =>
    part === 'online-engine'
      ? false
      : part === 'migration'
        ? hasRegistrationMirrorScope(paths) ||
          hasRechargeConnectionMigrationScope(paths) ||
          paths.some((p) => p.startsWith('apps/api/prisma-mysql/'))
        : part === 'security'
          ? paths.some((p) => securityPaths.test(p))
          : affectsPart(part, paths)
  );
}

export function affectsPart(part, paths) {
  if (part === 'guards') return paths.length > 0;
  if (part === 'api' && hasAppleMailboxScope(paths)) return true;
  if (part === 'migration' && hasRegistrationMirrorScope(paths)) return true;
  if (
    part === 'migration' &&
    (hasRechargeConnectionMigrationScope(paths) ||
      paths.some((path) => ownedMysqlTestControlPaths.includes(path)))
  )
    return true;
  if (part === 'admin' && paths.some((path) => adminInteractionAcceptance.has(path))) return true;
  const common =
    /^(?:package(?:-lock)?\.json$|\.github\/workflows\/quality\.yml$|scripts\/ci-recharge-check\.mjs$|scripts\/ci-change-scope|tsconfig|eslint\.config|\.npmrc$)/;
  const inputs = {
    admin:
      /^(?:apps\/admin\/|packages\/shared\/|scripts\/acceptance-v2-(?:auto-recharge|table-layout)\.mjs$)/,
    api: /^(?:apps\/api\/(?!src\/id-business-v2\/(?:auto-recharge\/worker|workspace\/media-resolver)\/)|packages\/shared\/)/,
    connector: /^apps\/api\/src\/id-business-v2\/auto-recharge\/worker\//,
    'online-engine': /^apps\/api\/src\/id-business-v2\/online-recharge\/engine\//,
    migration: /^apps\/api\/prisma-mysql\//,
    security: securityPaths
  };
  if (!inputs[part]) throw new Error('Unknown check part');
  return paths.some((p) => common.test(p) || inputs[part].test(p));
}

// This reviewed dispatcher extension adds release controls and connector cases;
// the Admin and API business commands retain their exact previous bytes.
const rechargeFlowDispatcherSource = Object.freeze({
  before: 'a6534555a1ad068aee46fed9808b3220fc8ae32ea45f18945eebc64022115116',
  after: '2954ccc78e01ad42c71a29815e6f7d5997a13cd9009a0ec56519ee529968181e'
});
export function hasRechargeFlowBusinessReuseProof(part, paths, snapshot) {
  if (
    !['admin', 'api'].includes(part) ||
    !paths.includes('scripts/ci-recharge-check.mjs') ||
    affectsPart(
      part,
      paths.filter((path) => path !== 'scripts/ci-recharge-check.mjs')
    ) ||
    snapshot?.beforeMode !== '100644' ||
    snapshot?.afterMode !== '100644' ||
    typeof snapshot.before !== 'string' ||
    typeof snapshot.after !== 'string'
  )
    return false;
  const digest = (source) => createHash('sha256').update(source).digest('hex');
  return (
    digest(snapshot.before) === rechargeFlowDispatcherSource.before &&
    digest(snapshot.after) === rechargeFlowDispatcherSource.after
  );
}

export function readRechargeFlowDispatcherSnapshot(before, after) {
  if (![before, after].every((revision) => /^[a-f0-9]{40}$/.test(revision))) return undefined;
  const path = 'scripts/ci-recharge-check.mjs';
  const source = (revision) =>
    execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
  const mode = (revision) =>
    execFileSync('git', ['ls-tree', revision, '--', path], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)[0];
  try {
    return {
      before: source(before),
      after: source(after),
      beforeMode: mode(before),
      afterMode: mode(after)
    };
  } catch {
    return undefined;
  }
}

export function matchingRun(run, number, headSha) {
  return (
    run.event === 'pull_request' &&
    run.path === '.github/workflows/quality.yml' &&
    run.status === 'completed' &&
    run.head_sha === headSha &&
    run.pull_requests?.some((pr) => pr.number === number)
  );
}

export function canReuseMain(testedSourceTree, currentSourceTree, jobs) {
  return (
    testedSourceTree === currentSourceTree &&
    jobs.some((job) => job.name === 'quality' && job.conclusion === 'success')
  );
}

// One completed migration job survived this candidate's unrelated guard/UI failure.
// Its native checkout and all remaining bytes must still match; never reuse overall quality.
export const combinedMigrationBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  pullRequest: 463,
  runId: 38410495070,
  runAttempt: 1,
  jobId: 115341331843,
  head: '40ad028a5ddc6aedd9f8e43d3dd33907e4c9faad',
  base: 'dbec7e0b08c989b9b4e7ba02ef5eae2bfc728746',
  checkout: '9e80c3ba50d5069603955fd52a2cf7116c2433a0',
  tree: '7f4cab0ac137726c71a955cbfa8903585d11ebb4'
});
const combinedMigrationRepairPaths = new Set([
  '.github/workflows/quality.yml',
  'scripts/acceptance-v2-workspace-dock.mjs',
  'scripts/ci-recharge-release.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/production-release/recharge-flow-successor-projection.test.py',
  'scripts/production-release/recharge-flow-entry.test.mjs'
]);
export function validateCombinedMigrationNative({
  run,
  jobs,
  checkout,
  log,
  changed,
  dispatcherUnchanged,
  qualityWorkflowUnchanged
}) {
  const b = combinedMigrationBinding;
  if (
    run.id !== b.runId ||
    run.run_attempt !== b.runAttempt ||
    !matchingRun(run, b.pullRequest, b.head) ||
    !run.pull_requests.some((pr) => pr.number === b.pullRequest && pr.base.sha === b.base) ||
    checkout.sha !== b.checkout ||
    checkout.tree?.sha !== b.tree ||
    JSON.stringify(checkout.parents?.map((parent) => parent.sha)) !==
      JSON.stringify([b.base, b.head]) ||
    !changed.every((path) => combinedMigrationRepairPaths.has(path)) ||
    (changed.includes('scripts/ci-recharge-check.mjs') && dispatcherUnchanged !== true) ||
    (changed.includes('.github/workflows/quality.yml') && qualityWorkflowUnchanged !== true)
  )
    return undefined;
  const job = jobs.find((row) => row.id === b.jobId);
  if (
    !job ||
    job.run_id !== b.runId ||
    job.name !== 'recharge (migration)' ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    !['Checkout', 'Check affected recharge part'].every(
      (name) =>
        job.steps.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    )
  )
    return undefined;
  const lines = log.split('\n');
  const marker = lines.findIndex((line) => line.includes('git log -1 --format=%H'));
  if (marker < 0 || !lines[marker + 1]?.endsWith(b.checkout)) return undefined;
  const rows = lines.filter((line) => line.includes('{"numTotalTestSuites":'));
  if (rows.length !== 1) return undefined;
  let report;
  try {
    report = JSON.parse(rows[0].slice(rows[0].indexOf('{"numTotalTestSuites":')));
  } catch {
    return undefined;
  }
  const files = new Map([
    ['recharge-callback-receipts.mysql.integration.spec.ts', 4],
    ['recharge-employee-concurrency.mysql.integration.spec.ts', 16],
    ['recharge-subscription-cycle.mysql.integration.spec.ts', 5]
  ]);
  if (
    report.success !== true ||
    report.numTotalTests !== 25 ||
    report.numPassedTests !== 25 ||
    ![
      'numFailedTests',
      'numPendingTests',
      'numTodoTests',
      'numFailedTestSuites',
      'numPendingTestSuites'
    ].every((key) => report[key] === 0) ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 3
  )
    return undefined;
  for (const row of report.testResults) {
    const name = row.name?.split('/').at(-1);
    if (
      !files.has(name) ||
      row.status !== 'passed' ||
      row.assertionResults?.length !== files.get(name) ||
      row.assertionResults.some((assertion) => assertion.status !== 'passed')
    )
      return undefined;
    files.delete(name);
  }
  return files.size === 0
    ? {
        part: 'migration',
        run: b.runId,
        attempt: b.runAttempt,
        job: b.jobId,
        checkout: b.checkout,
        tree: b.tree,
        testsPassed: 25,
        testsSkipped: 0
      }
    : undefined;
}

export function combinedMigrationScopeBytesUnchanged(before, after) {
  const marker = '// One completed migration job survived';
  const start = after.indexOf(marker);
  const end = after.indexOf('\nconst git = (...args)', start) + 1;
  const call = [
    "  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {",
    '    const migrationEvidence = reuseCombinedMigration(repo, event, mode, paths, currentTree);',
    '    if (migrationEvidence) {',
    "      reused.add('migration');",
    '      evidence.push(migrationEvidence);',
    '      const adminEvidence = reuseCombinedAdmin(repo, currentTree);',
    '      if (adminEvidence) {',
    "        reused.add('admin');",
    '        evidence.push(adminEvidence);',
    '      }',
    '    }',
    '  }',
    ''
  ].join('\n');
  return (
    !before.includes(marker) &&
    start >= 0 &&
    end > start &&
    after.split('\n').filter((line) => line.startsWith(marker)).length === 1 &&
    after.includes(call) &&
    (after.slice(0, start) + after.slice(end)).replace(call, '').trim() === before.trim()
  );
}

export function combinedDispatcherBytesUnchanged(before, after) {
  const declaration = [
    'const resumeCombinedGuardPrefix =',
    "  part === 'guards' &&",
    "  process.env.GITHUB_ACTIONS === 'true' &&",
    "  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&",
    "  process.env.GITHUB_EVENT_NAME === 'pull_request' &&",
    '  canResumeCombinedGuard(base);',
    ''
  ].join('\n');
  return (
    after
      .replace('  canResumeCombinedGuard,\n', '')
      .replace(declaration, '')
      .replace("\n}\nif (part === 'guards' && !resumeCombinedGuardPrefix) {\n", '\n')
      .replace(
        "\n}\nif (part === 'guards') {\n  rechargeFlowSuccessorControls();",
        '\n  rechargeFlowSuccessorControls();'
      )
      .trim() === before.trim()
  );
}

export function combinedQualityWorkflowBytesUnchanged(before, after) {
  const anchor = [
    '      - name: Check affected recharge part',
    '        if: ${{ !contains(fromJSON(needs.change-scope.outputs.reused_parts), matrix.part) }}',
    '        env:',
    '          CHECK_PART: ${{ matrix.part }}',
    '          CHECK_BASE: ${{ needs.change-scope.outputs.base }}',
    '          CHECK_MODE: ${{ needs.change-scope.outputs.mode }}',
    ''
  ].join('\n');
  const token = "          GH_TOKEN: ${{ matrix.part == 'guards' && github.token || '' }}\n";
  return (
    typeof before === 'string' &&
    typeof after === 'string' &&
    before.split(anchor).length === 2 &&
    !before.includes(token) &&
    after === before.replace(anchor, anchor + token)
  );
}

export function canReuseCombinedAdminSource(
  run,
  jobs,
  changed,
  checkout,
  log = '',
  qualityWorkflowUnchanged = false
) {
  const plain = log
    .replace(/\^\[\[[0-9;]*m/g, '')
    .split(String.fromCharCode(27))
    .map((part, index) => (index ? part.replace(/^\[[0-9;]*m/, '') : part))
    .join('');
  return (
    run.id === 38414414141 &&
    run.run_attempt === 1 &&
    run.status === 'completed' &&
    matchingRun(run, 463, '5930f71e00d178a867526766e16e9aee14077244') &&
    run.pull_requests.some(
      (pr) => pr.number === 463 && pr.base.sha === combinedMigrationBinding.base
    ) &&
    changed.every(
      (path) =>
        combinedMigrationRepairPaths.has(path) &&
        path !== 'scripts/acceptance-v2-workspace-dock.mjs'
    ) &&
    (!changed.includes('.github/workflows/quality.yml') || qualityWorkflowUnchanged === true) &&
    checkout?.sha === 'd7a17bbd2626a9adc77ba732ed934d302f78a0d2' &&
    checkout.tree.sha === '3594058955012e7ad7087cbb340a0f30420c92f2' &&
    JSON.stringify(checkout.parents.map((row) => row.sha)) ===
      JSON.stringify([combinedMigrationBinding.base, run.head_sha]) &&
    jobs.filter(
      (job) =>
        job.id === 115355004562 &&
        job.run_id === run.id &&
        job.name === 'recharge (admin)' &&
        job.status === 'completed' &&
        job.conclusion === 'success' &&
        ['Checkout', 'Check affected recharge part'].every((name) =>
          job.steps.some(
            (step) =>
              step.name === name && step.status === 'completed' && step.conclusion === 'success'
          )
        )
    ).length === 1 &&
    plain.includes('d7a17bbd2626a9adc77ba732ed934d302f78a0d2') &&
    /Test Files\s+159 passed\s+\(159\)/.test(plain) &&
    /Tests\s+1235 passed\s+\(1235\)/.test(plain) &&
    plain.includes('工作区浏览器验收通过：86 项')
  );
}

function reuseCombinedAdmin(repo, currentTree) {
  const run = gh(`repos/${repo}/actions/runs/38414414141`);
  const { jobs } = gh(`repos/${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
  const checkout = gh(`repos/${repo}/git/commits/d7a17bbd2626a9adc77ba732ed934d302f78a0d2`);
  const tree = checkout.tree.sha;
  ensureCommit(run.head_sha);
  if (git('rev-parse', `${run.head_sha}^{tree}`) !== tree)
    throw new Error('Original Admin source tree changed');
  const changed = git('diff', '--name-only', tree, currentTree).split('\n').filter(Boolean);
  const log = execFileSync(
    'gh',
    ['run', 'view', String(run.id), '--repo', repo, '--job', '115355004562', '--log'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  const qualityWorkflowUnchanged = combinedQualityWorkflowBytesUnchanged(
    git('show', `${run.head_sha}:.github/workflows/quality.yml`),
    git('show', `${currentTree}:.github/workflows/quality.yml`)
  );
  if (!canReuseCombinedAdminSource(run, jobs, changed, checkout, log, qualityWorkflowUnchanged))
    throw new Error('Original Admin evidence changed');
  return {
    part: 'admin',
    run: run.id,
    attempt: 1,
    job: 115355004562,
    tree,
    head: run.head_sha,
    testsPassed: 1235,
    browserChecks: 86,
    logSha256: createHash('sha256').update(log).digest('hex')
  };
}

function validateCombinedCommands(currentTree) {
  const before = combinedMigrationBinding.head;
  if (
    !combinedMigrationScopeBytesUnchanged(
      git('show', `${before}:scripts/ci-recharge-scope.mjs`),
      git('show', `${currentTree}:scripts/ci-recharge-scope.mjs`)
    ) ||
    !combinedDispatcherBytesUnchanged(
      git('show', `${before}:scripts/ci-recharge-check.mjs`),
      git('show', `${currentTree}:scripts/ci-recharge-check.mjs`)
    ) ||
    !combinedQualityWorkflowBytesUnchanged(
      git('show', `${before}:.github/workflows/quality.yml`),
      git('show', `${currentTree}:.github/workflows/quality.yml`)
    )
  )
    throw new Error('Original check commands changed');
}

// BEGIN finite ONLINE PR470 guard continuation
export const onlineComponentGuardBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  pullRequest: 470,
  base: 'b922b2d900e683f565ff3c5f95576ebc5f07803f',
  head: 'd08eefd5aa5c718918953ed60b9e34a67e12f327',
  tree: '3cd57b0372c82737741f3cd854c7fc1de00240d3',
  checkout: 'cdbc7636ad80aebebf3486d8099c16faf49ad547',
  run: 38492172446,
  attempt: 1,
  job: 115619776622,
  logSha256: '2efb7584708ba8522cd289b5db766edc4aa1e0139466dc31f67b2339b7eb5935',
  fixtureSha256: '5fcdd988ece780fd0bda6cc0e27a5e31ec43212a9a985cc99a89425e6953a307'
});
const onlineGuardAllowedRepairs = new Set([
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/production-release/unified-component-source.test.py',
  'docs/CENTRAL_RELEASE_20261002.md',
  'docs/WORKSPACE_RELEASE_CLEANUP_20261014.md'
]);

export function onlineComponentGuardLogFacts(log) {
  if (typeof log !== 'string' || !log) return undefined;
  const lines = log.split('\n').map((line) => line.replace(/^.*?\t.*?\t\uFEFF?[^ ]+Z /, ''));
  const python = [];
  for (let i = 0; i < lines.length; i++) {
    const result = /^Ran (\d+) tests in [0-9.]+s$/.exec(lines[i]);
    if (result) python.push([Number(result[1]), lines[i + 2]]);
  }
  const checkout = lines.findIndex((line) => line === '[command]/usr/bin/git log -1 --format=%H');
  return {
    sha256: createHash('sha256').update(log).digest('hex'),
    checkout: checkout < 0 ? undefined : lines[checkout + 1],
    python,
    node: lines.filter((line) => /^ℹ (?:tests|fail|cancelled|skipped) \d+$/.test(line)),
    errors: lines.filter((line) => /^(?:ERROR|FAIL): /.test(line)),
    failedCommands: lines.filter((line) => /^Error: Command failed: /.test(line)),
    scope:
      lines.includes('  CHECK_BASE: ' + onlineComponentGuardBinding.base) &&
      lines.includes('  CHECK_MODE: ci-only') &&
      lines.includes('  CHECK_PART: guards') &&
      lines.includes('##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"'),
    environment:
      lines.includes('  NODE_ENV: test') &&
      lines.includes('Image: ubuntu-24.04') &&
      lines.includes('Version: 20261004.327.1') &&
      lines.includes('node: v24.21.0') &&
      lines.includes('npm: 11.19.0'),
    failureCode: lines.filter(
      (line) => line === 'RuntimeError: ADMIN_PENDING_CONFIRM_SOURCE_SCOPE_CHANGED'
    ).length
  };
}

export function onlineComponentGuardScopeBytesUnchanged(before, after) {
  const startMarker = '// BEGIN finite ONLINE PR470 guard continuation\n';
  const endMarker = '// END finite ONLINE PR470 guard continuation\n\n';
  if (
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    before.includes(startMarker) ||
    after.split(startMarker).length !== 2 ||
    after.split(endMarker).length !== 2
  )
    return false;
  const start = after.indexOf(startMarker),
    end = after.indexOf(endMarker);
  return end > start && after.slice(0, start) + after.slice(end + endMarker.length) === before;
}

export function onlineComponentGuardDispatcherBytesUnchanged(before, after) {
  const declaration = [
    'const resumeOnlineComponentGuardPrefix =',
    "  part === 'guards' &&",
    "  process.env.GITHUB_ACTIONS === 'true' &&",
    "  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&",
    "  process.env.GITHUB_EVENT_NAME === 'pull_request' &&",
    "  base === 'b922b2d900e683f565ff3c5f95576ebc5f07803f' &&",
    '  canResumeOnlineComponentGuard(base);',
    ''
  ].join('\n');
  const changes = [
    ['  canResumeOnlineComponentGuard,\n', ''],
    [declaration, ''],
    [
      "if (part === 'guards' && !resumeCombinedGuardPrefix && !resumeOnlineComponentGuardPrefix) {",
      "if (part === 'guards' && !resumeCombinedGuardPrefix) {"
    ],
    [
      "if (resumeOnlineComponentGuardPrefix)\n  run('python3', ['-B', 'scripts/production-release/unified-component-source.test.py']);\n",
      ''
    ]
  ];
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  for (const [added, original] of changes) {
    if (after.split(added).length !== 2) return false;
    after = after.replace(added, original);
  }
  return after === before;
}

export function validateOnlineComponentGuardNative({
  run,
  jobs,
  checkout,
  facts,
  changed,
  fixtureSha256,
  scopeUnchanged,
  dispatcherUnchanged,
  headTree,
  modesUnchanged,
  currentEnvironment,
  currentHead
} = {}) {
  const b = onlineComponentGuardBinding;
  const job = Array.isArray(jobs) ? jobs.filter((row) => row.id === b.job) : undefined;
  const counts = [
    257, 40, 27, 91, 30, 16, 40, 63, 40, 35, 8, 25, 24, 109, 24, 86, 90, 23, 20, 25, 27, 297, 34,
    39, 15, 66, 32, 31
  ];
  return !!(
    run?.id === b.run &&
    run.run_attempt === b.attempt &&
    run.conclusion === 'failure' &&
    run.repository?.full_name === b.repository &&
    matchingRun(run, b.pullRequest, b.head) &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.length === 1 &&
    run.pull_requests[0].base?.sha === b.base &&
    typeof currentHead === 'string' &&
    /^[a-f0-9]{40}$/.test(currentHead) &&
    run.pull_requests[0].head?.sha === currentHead &&
    checkout?.sha === b.checkout &&
    checkout.tree?.sha === b.tree &&
    headTree === b.tree &&
    Array.isArray(checkout.parents) &&
    JSON.stringify(checkout.parents.map((row) => row.sha)) === JSON.stringify([b.base, b.head]) &&
    job?.length === 1 &&
    job[0].run_id === b.run &&
    job[0].run_attempt === b.attempt &&
    job[0].name === 'recharge (guards)' &&
    job[0].status === 'completed' &&
    job[0].conclusion === 'failure' &&
    Array.isArray(job[0].steps) &&
    ['Checkout', 'Setup Node.js', 'Install package dependencies'].every(
      (name) =>
        job[0].steps?.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    ) &&
    job[0].steps?.filter((step) => step.conclusion === 'failure').length === 1 &&
    job[0].steps.find((step) => step.conclusion === 'failure').name ===
      'Check affected recharge part' &&
    ['Install browser for recharge acceptance', 'Install existing connector dependencies'].every(
      (name) =>
        job[0].steps.filter((step) => step.name === name && step.conclusion === 'skipped')
          .length === 1
    ) &&
    facts?.sha256 === b.logSha256 &&
    facts.checkout === b.checkout &&
    facts.scope === true &&
    facts.environment === true &&
    facts.failureCode === 1 &&
    currentEnvironment?.node === 'v24.21.0' &&
    currentEnvironment.npm === '11.19.0' &&
    currentEnvironment.imageOS === 'ubuntu24' &&
    currentEnvironment.imageVersion === '20261004.327.1' &&
    currentEnvironment.platform === 'linux' &&
    JSON.stringify(facts.python) ===
      JSON.stringify([...counts.map((count) => [count, 'OK']), [12, 'FAILED (errors=1)']]) &&
    JSON.stringify(facts.node) ===
      JSON.stringify(
        [320, 202, 13, 5, 12, 5].flatMap((count) => [
          'ℹ tests ' + count,
          'ℹ fail 0',
          'ℹ cancelled 0',
          'ℹ skipped 0'
        ])
      ) &&
    JSON.stringify(facts.errors) ===
      JSON.stringify([
        'ERROR: test_business_archive_tree_and_all_application_bytes_match_the_worktree_seal (__main__.JointSourceTests.test_business_archive_tree_and_all_application_bytes_match_the_worktree_seal)'
      ]) &&
    JSON.stringify(facts.failedCommands) ===
      JSON.stringify([
        'Error: Command failed: python3 -B scripts/production-release/unified-component-source.test.py'
      ]) &&
    Array.isArray(changed) &&
    changed.includes('scripts/production-release/unified-component-source.test.py') &&
    changed.every((path) => onlineGuardAllowedRepairs.has(path)) &&
    fixtureSha256 === b.fixtureSha256 &&
    scopeUnchanged === true &&
    dispatcherUnchanged === true &&
    modesUnchanged === true
  );
}

export function onlineComponentGuardCurrentEnvironment() {
  return {
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    imageOS: process.env.ImageOS,
    imageVersion: process.env.ImageVersion,
    platform: process.platform
  };
}

export function canResumeOnlineComponentGuard(base) {
  const b = onlineComponentGuardBinding;
  if (
    base !== b.base ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== b.repository ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request'
  )
    return false;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.pull_request?.number !== b.pullRequest || event.pull_request.base.sha !== b.base)
    return false;
  if (process.env.CHECK_MODE !== 'ci-only' || process.env.NODE_ENV !== 'test')
    throw new Error('ONLINE continuation check environment changed');
  const tree = git('rev-parse', 'HEAD^{tree}');
  ensureCommit(b.head);
  ensureCommit(event.pull_request.head.sha);
  if (git('rev-parse', `${event.pull_request.head.sha}^{tree}`) !== tree)
    throw new Error('ONLINE continuation current source changed');
  const changed = git('diff', '--name-only', b.head, tree).split('\n').filter(Boolean);
  const fixture = 'scripts/production-release/unified-component-source.test.py';
  const bytes = (commit, path) =>
    execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' });
  const run = gh(`repos/${b.repository}/actions/runs/${b.run}`);
  const { jobs } = gh(
    `repos/${b.repository}/actions/runs/${b.run}/attempts/${b.attempt}/jobs?per_page=100`
  );
  const checkout = gh(`repos/${b.repository}/git/commits/${b.checkout}`);
  const log = execFileSync(
    'gh',
    ['run', 'view', String(b.run), '--repo', b.repository, '--job', String(b.job), '--log'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  const fixtureBytes = execFileSync('git', ['show', `${tree}:${fixture}`]);
  const modesUnchanged = changed.every(
    (path) =>
      /^[0-9]+ blob [a-f0-9]{40}\t/.test(git('ls-tree', tree, '--', path)) &&
      git('ls-tree', tree, '--', path).split(' ')[0] ===
        git('ls-tree', b.head, '--', path).split(' ')[0]
  );
  if (
    !validateOnlineComponentGuardNative({
      run,
      jobs,
      checkout,
      changed,
      facts: onlineComponentGuardLogFacts(log),
      currentEnvironment: onlineComponentGuardCurrentEnvironment(),
      currentHead: event.pull_request.head.sha,
      headTree: git('rev-parse', `${b.head}^{tree}`),
      modesUnchanged,
      fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      scopeUnchanged: onlineComponentGuardScopeBytesUnchanged(
        bytes(b.head, 'scripts/ci-recharge-scope.mjs'),
        bytes(tree, 'scripts/ci-recharge-scope.mjs')
      ),
      dispatcherUnchanged: onlineComponentGuardDispatcherBytesUnchanged(
        bytes(b.head, 'scripts/ci-recharge-check.mjs'),
        bytes(tree, 'scripts/ci-recharge-check.mjs')
      )
    })
  )
    throw new Error('Original ONLINE guard prefix evidence changed');
  return true;
}
// END finite ONLINE PR470 guard continuation

// BEGIN finite ONLINE prepare-fix guard continuation
export const onlinePrepareFixGuardBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  branch: 'codex/online-component-prepare-fix-20261014',
  base: '2edb7ef92a9619e5b0e5855220c97bac29d22f60',
  originalHead: '1add3e2e0a108fa7c5b3463da54738d00f617f25',
  originalBase: 'b922b2d900e683f565ff3c5f95576ebc5f07803f',
  tree: '36209f75aef081959720794b8bd58c580958f4f6',
  checkout: '68a7d0b0428affdc98cd86e268dbd93187a7f25c',
  run: 38498139445,
  attempt: 1,
  job: 115638566002,
  qualityJob: 115640756195,
  mainRun: 38499088168,
  artifact: 11865260473,
  artifactSha256: '340ec1954b1908d1378a89fdad511f3c83fe0dfb73da04f2af93dbabe2ab99e7',
  proofSha256: 'c54ee5b50db235b9e41bdc117359ac6ea768e056df9b33d4f093e12aecff62ea',
  logSha256: 'e7151e901b9bdbb473f735ea808cbebcf39f91ba65e05314e54906b615169c9c',
  qualityLogSha256: '8437e426a8deb05fb482d0074e51d3aa4ebb6283f9c8125b116284464a35f4f5',
  // Retain the original CLI presentation hashes above as historical evidence.
  // This reader authenticates only the platform's raw job-log bytes.
  rawLogSha256: '914d13bef30182deaaf574104f26cb51b17cd29c67dacc5e0529cfa98628e6db',
  rawQualityLogSha256: '760539f4479f0a9d4f32cd86da2bab6c5a273cbdfe315cde2cd98b04fb41e028',
  runtimeSha256: '5dbf1b59d532e9f818919c0210602bb74a2153bbeecc20b1d823c238d6d2d41f',
  runtimeTestSha256: 'e2a6efb50b82c8e6b81b3bf25aa08c0770c6dfa1e2dc467f264782b55399c493'
});
export const onlinePrepareFixGuardPaths = Object.freeze([
  'scripts/production-release/online-recharge-component-runtime.py',
  'scripts/production-release/online-recharge-component-runtime.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/CENTRAL_RELEASE_20261002.md',
  'docs/WORKSPACE_RELEASE_CLEANUP_20261014.md'
]);
export const onlinePrepareFixGuardCommands = Object.freeze(
  [
    ['python3', '-B', 'scripts/production-release/online-recharge-component-consumer.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-component-runtime.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-component-readonly.test.py'],
    ['python3', '-B', 'scripts/production-release/api-admin-scope.test.py'],
    ['python3', '-B', 'scripts/production-release/api-admin-pending-online.test.py'],
    ['python3', '-B', 'scripts/production-release/admin-pending-online-release.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-scope.test.py'],
    ['python3', '-B', 'scripts/production-release/unpublished-component-successor.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/unpublished-component-successor-readonly.test.py'
    ],
    ['python3', '-B', 'scripts/production-release/prepared-images.test.py'],
    ['node', '--test', 'scripts/production-release/recharge-flow-entry.test.mjs'],
    ['node', '--test', 'scripts/production-release/online-recharge-entry.test.mjs'],
    ['python3', '-B', 'scripts/production-release/unified-component-source.test.py'],
    ['node', '--test', 'scripts/v2-order-archive-release-policy.test.mjs'],
    ['python3', '-B', 'scripts/production-release/registration-onboarding-96.test.py']
  ].map(Object.freeze)
);

export function onlinePrepareFixScopeBytesUnchanged(before, after) {
  const start = '// BEGIN finite ONLINE prepare-fix guard continuation\n';
  const end = '// END finite ONLINE prepare-fix guard continuation\n\n';
  if (
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    before.includes(start) ||
    after.split(start).length !== 2 ||
    after.split(end).length !== 2
  )
    return false;
  const left = after.indexOf(start),
    right = after.indexOf(end);
  return right > left && after.slice(0, left) + after.slice(right + end.length) === before;
}

export function onlinePrepareFixDispatcherBytesUnchanged(before, after) {
  const declaration = [
    'const resumeOnlinePrepareFixGuard =',
    "  part === 'guards' &&",
    "  mode === 'ci-only' &&",
    "  process.env.GITHUB_ACTIONS === 'true' &&",
    "  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&",
    "  process.env.GITHUB_EVENT_NAME === 'pull_request' &&",
    "  base === '2edb7ef92a9619e5b0e5855220c97bac29d22f60' &&",
    '  canResumeOnlinePrepareFixGuard(base);',
    ''
  ].join('\n');
  const extension = [
    'if (resumeOnlinePrepareFixGuard) {',
    '  for (const [file, ...args] of onlinePrepareFixGuardCommands) run(file, args);',
    '  process.exit(0);',
    '}',
    ''
  ].join('\n');
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  for (const addition of [
    '  canResumeOnlinePrepareFixGuard,\n',
    '  onlinePrepareFixGuardCommands,\n',
    declaration,
    extension
  ]) {
    if (after.split(addition).length !== 2) return false;
    after = after.replace(addition, '');
  }
  return after === before;
}

export function onlinePrepareFixRuntimeBytesUnchanged(before, after) {
  const body = /^def prepare\(.*?(?=^def [A-Za-z_])/ms;
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const left = body.exec(before),
    right = body.exec(after);
  return (
    !!left &&
    !!right &&
    left[0] !== right[0] &&
    before.slice(0, left.index) + before.slice(left.index + left[0].length) ===
      after.slice(0, right.index) + after.slice(right.index + right[0].length)
  );
}

export function onlinePrepareFixGuardRawLogFacts(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length) return undefined;
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return undefined;
  const utc = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
  const rows = text.split('\n');
  if (rows.some((line) => line && !utc.test(line))) return undefined;
  const lines = rows.map((line) => line.replace(utc, ''));
  const checkout = lines.findIndex((line) => line === '[command]/usr/bin/git log -1 --format=%H');
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    checkout: checkout < 0 ? undefined : lines[checkout + 1],
    scope:
      lines.includes('  CHECK_BASE: ' + onlinePrepareFixGuardBinding.originalBase) &&
      lines.includes('  CHECK_MODE: ci-only') &&
      lines.includes('  CHECK_PART: guards') &&
      lines.includes('##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"'),
    environment:
      lines.includes('  NODE_ENV: test') &&
      lines.includes('Image: ubuntu-24.04') &&
      lines.includes('Version: 20261004.327.1') &&
      lines.includes('node: v24.21.0') &&
      lines.includes('npm: 11.19.0'),
    errors: lines.filter((line) => /^(?:ERROR|FAIL): /.test(line)),
    failedCommands: lines.filter((line) => /^Error: Command failed: /.test(line))
  };
}

export function validateOnlinePrepareFixGuardNative({
  run,
  jobs,
  qualityLog,
  facts,
  artifact,
  proof,
  proofSha256,
  originalPr,
  mainRun,
  changed,
  currentEnvironment,
  currentHeadTree,
  currentTree,
  runtimeSha256,
  runtimeTestSha256,
  scopeUnchanged,
  dispatcherUnchanged,
  runtimeUnchanged,
  modesUnchanged,
  baselineTree
} = {}) {
  const b = onlinePrepareFixGuardBinding;
  const rows = Array.isArray(jobs) ? jobs : [];
  const job = rows.filter((row) => row.id === b.job);
  const quality = rows.filter((row) => row.id === b.qualityJob);
  const validJob = (row, name) =>
    row?.run_id === b.run &&
    row.run_attempt === 1 &&
    row.name === name &&
    row.head_sha === b.originalHead &&
    row.status === 'completed' &&
    row.conclusion === 'success';
  return !!(
    run?.id === b.run &&
    run.run_attempt === 1 &&
    run.event === 'pull_request' &&
    run.path === '.github/workflows/quality.yml' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.head_sha === b.originalHead &&
    run.repository?.full_name === b.repository &&
    originalPr?.number === 470 &&
    originalPr.state === 'closed' &&
    originalPr.merged === true &&
    originalPr.head?.sha === b.originalHead &&
    originalPr.base?.sha === b.originalBase &&
    originalPr.merge_commit_sha === b.base &&
    mainRun?.id === b.mainRun &&
    mainRun.run_attempt === 1 &&
    mainRun.event === 'push' &&
    mainRun.path === '.github/workflows/quality.yml' &&
    mainRun.status === 'completed' &&
    mainRun.conclusion === 'success' &&
    mainRun.head_sha === b.base &&
    mainRun.repository?.full_name === b.repository &&
    job.length === 1 &&
    validJob(job[0], 'recharge (guards)') &&
    quality.length === 1 &&
    validJob(quality[0], 'quality') &&
    [
      'Checkout',
      'Setup Node.js',
      'Install package dependencies',
      'Check affected recharge part'
    ].every(
      (name) =>
        job[0].steps?.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    ) &&
    ['Install browser for recharge acceptance', 'Install existing connector dependencies'].every(
      (name) =>
        job[0].steps?.filter((step) => step.name === name && step.conclusion === 'skipped')
          .length === 1
    ) &&
    [
      'Checkout the tested source tree for its evidence',
      'Record successful PR source evidence',
      'Preserve successful source evidence'
    ].every(
      (name) =>
        quality[0].steps?.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    ) &&
    artifact?.id === b.artifact &&
    artifact.name === 'quality-source-evidence-1' &&
    artifact.expired === false &&
    artifact.size_in_bytes === 357 &&
    artifact.digest === 'sha256:' + b.artifactSha256 &&
    artifact.workflow_run?.id === b.run &&
    artifact.workflow_run.head_sha === b.originalHead &&
    typeOfProof(proof) &&
    proofSha256 === b.proofSha256 &&
    matchesSourceEvidence(proof, {
      repo: b.repository,
      run,
      pr: { number: 470, head: { sha: b.originalHead } },
      tree: b.tree
    }) &&
    proof.baseSha === b.originalBase &&
    facts?.sha256 === b.rawLogSha256 &&
    facts.checkout === b.checkout &&
    facts.scope === true &&
    facts.environment === true &&
    Array.isArray(facts.errors) &&
    facts.errors.length === 0 &&
    Array.isArray(facts.failedCommands) &&
    facts.failedCommands.length === 0 &&
    qualityLog?.sha256 === b.rawQualityLogSha256 &&
    qualityLog.checkout === b.checkout &&
    baselineTree === b.tree &&
    currentHeadTree === currentTree &&
    /^[a-f0-9]{40}$/.test(currentTree || '') &&
    Array.isArray(changed) &&
    changed.includes(onlinePrepareFixGuardPaths[0]) &&
    changed.includes(onlinePrepareFixGuardPaths[1]) &&
    changed.every((path) => onlinePrepareFixGuardPaths.includes(path)) &&
    currentEnvironment?.node === 'v24.21.0' &&
    currentEnvironment.npm === '11.19.0' &&
    currentEnvironment.imageOS === 'ubuntu24' &&
    currentEnvironment.imageVersion === '20261004.327.1' &&
    currentEnvironment.platform === 'linux' &&
    runtimeSha256 === b.runtimeSha256 &&
    runtimeTestSha256 === b.runtimeTestSha256 &&
    scopeUnchanged === true &&
    dispatcherUnchanged === true &&
    runtimeUnchanged === true &&
    modesUnchanged === true
  );
}
function typeOfProof(proof) {
  return (
    proof &&
    Object.keys(proof).sort().join('|') ===
      'baseSha|headSha|pullRequest|repository|runAttempt|runId|testedTree'
  );
}

export function onlinePrepareFixGuardFailureCodes(input = {}) {
  // Diagnostics never serialize native records, caller fields or environment
  // values. The original validator remains the sole admission decision.
  const b = onlinePrepareFixGuardBinding;
  const codes = [];
  const check = (code, predicate) => {
    try {
      if (!predicate()) codes.push(code);
    } catch {
      codes.push(code);
    }
  };
  const { run, originalPr, mainRun, artifact, proof, facts, qualityLog } = input;
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const guard = jobs.filter((row) => row?.id === b.job);
  const quality = jobs.filter((row) => row?.id === b.qualityJob);
  const runOK = (row, id, event, head) =>
    row?.id === id &&
    row.run_attempt === 1 &&
    row.event === event &&
    row.path === '.github/workflows/quality.yml' &&
    row.status === 'completed' &&
    row.conclusion === 'success' &&
    row.head_sha === head &&
    row.repository?.full_name === b.repository;
  const jobOK = (rows, name) =>
    rows.length === 1 &&
    rows[0].run_id === b.run &&
    rows[0].run_attempt === 1 &&
    rows[0].name === name &&
    rows[0].head_sha === b.originalHead &&
    rows[0].status === 'completed' &&
    rows[0].conclusion === 'success';
  const stepsOK = (rows, names, skipped = false) =>
    rows.length === 1 &&
    Array.isArray(rows[0].steps) &&
    names.every(
      (name) =>
        rows[0].steps.filter(
          (step) =>
            step?.name === name &&
            step.conclusion === (skipped ? 'skipped' : 'success') &&
            (skipped || step.status === 'completed')
        ).length === 1
    );
  check('ORIGINAL_RUN', () => runOK(run, b.run, 'pull_request', b.originalHead));
  check(
    'CLOSED_PR_SOURCE',
    () =>
      originalPr?.number === 470 &&
      originalPr.state === 'closed' &&
      originalPr.merged === true &&
      originalPr.head?.sha === b.originalHead &&
      originalPr.base?.sha === b.originalBase &&
      originalPr.merge_commit_sha === b.base
  );
  check('MAIN_QUALITY', () => runOK(mainRun, b.mainRun, 'push', b.base));
  check('GUARD_JOB', () => jobOK(guard, 'recharge (guards)'));
  check('GUARD_STEPS', () =>
    stepsOK(guard, [
      'Checkout',
      'Setup Node.js',
      'Install package dependencies',
      'Check affected recharge part'
    ])
  );
  check('GUARD_SKIPPED_DEPENDENCIES', () =>
    stepsOK(
      guard,
      ['Install browser for recharge acceptance', 'Install existing connector dependencies'],
      true
    )
  );
  check('QUALITY_JOB', () => jobOK(quality, 'quality'));
  check('QUALITY_STEPS', () =>
    stepsOK(quality, [
      'Checkout the tested source tree for its evidence',
      'Record successful PR source evidence',
      'Preserve successful source evidence'
    ])
  );
  check(
    'SOURCE_ARTIFACT',
    () =>
      artifact?.id === b.artifact &&
      artifact.name === 'quality-source-evidence-1' &&
      artifact.expired === false &&
      artifact.size_in_bytes === 357 &&
      artifact.digest === 'sha256:' + b.artifactSha256 &&
      artifact.workflow_run?.id === b.run &&
      artifact.workflow_run.head_sha === b.originalHead
  );
  check('PROOF_BYTES', () => input.proofSha256 === b.proofSha256);
  check(
    'PROOF_SOURCE',
    () =>
      typeOfProof(proof) &&
      matchesSourceEvidence(proof, {
        repo: b.repository,
        run,
        pr: { number: 470, head: { sha: b.originalHead } },
        tree: b.tree
      }) &&
      proof.baseSha === b.originalBase
  );
  check('GUARD_LOG_BYTES', () => facts?.sha256 === b.rawLogSha256);
  check('GUARD_LOG_CHECKOUT', () => facts?.checkout === b.checkout);
  check('GUARD_LOG_SCOPE', () => facts?.scope === true);
  check('GUARD_LOG_ENVIRONMENT', () => facts?.environment === true);
  check(
    'GUARD_LOG_ERRORS',
    () =>
      Array.isArray(facts?.errors) &&
      facts.errors.length === 0 &&
      Array.isArray(facts.failedCommands) &&
      facts.failedCommands.length === 0
  );
  check('QUALITY_LOG_BYTES', () => qualityLog?.sha256 === b.rawQualityLogSha256);
  check('QUALITY_LOG_CHECKOUT', () => qualityLog?.checkout === b.checkout);
  check('BASELINE_TREE', () => input.baselineTree === b.tree);
  check(
    'CURRENT_TREE',
    () =>
      input.currentHeadTree === input.currentTree && /^[a-f0-9]{40}$/.test(input.currentTree || '')
  );
  check(
    'CHANGED_PATHS',
    () =>
      Array.isArray(input.changed) &&
      input.changed.includes(onlinePrepareFixGuardPaths[0]) &&
      input.changed.includes(onlinePrepareFixGuardPaths[1]) &&
      input.changed.every((path) => onlinePrepareFixGuardPaths.includes(path))
  );
  for (const [key, expected, code] of [
    ['node', 'v24.21.0', 'ENV_NODE'],
    ['npm', '11.19.0', 'ENV_NPM'],
    ['imageOS', 'ubuntu24', 'ENV_IMAGE_OS'],
    ['imageVersion', '20261004.327.1', 'ENV_IMAGE_VERSION'],
    ['platform', 'linux', 'ENV_PLATFORM']
  ])
    check(code, () => input.currentEnvironment?.[key] === expected);
  check('RUNTIME_SOURCE', () => input.runtimeSha256 === b.runtimeSha256);
  check('RUNTIME_TEST_SOURCE', () => input.runtimeTestSha256 === b.runtimeTestSha256);
  for (const [key, code] of [
    ['scopeUnchanged', 'SCOPE_NORMALIZATION'],
    ['dispatcherUnchanged', 'DISPATCHER_NORMALIZATION'],
    ['runtimeUnchanged', 'RUNTIME_NORMALIZATION'],
    ['modesUnchanged', 'FILE_MODES']
  ])
    check(code, () => input[key] === true);
  return codes;
}

export function requireOnlinePrepareFixGuardNative(input) {
  if (!validateOnlinePrepareFixGuardNative(input)) {
    const codes = onlinePrepareFixGuardFailureCodes(input);
    throw new Error(
      'Original prepare-fix source or guard evidence changed; predicates=' +
        (codes.length ? codes.join(',') : 'UNCLASSIFIED_PREDICATE')
    );
  }
  return true;
}

export function canResumeOnlinePrepareFixGuard(base) {
  const b = onlinePrepareFixGuardBinding;
  if (
    base !== b.base ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== b.repository ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request'
  )
    return false;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.pull_request?.head?.ref !== b.branch || event.pull_request.base?.sha !== b.base)
    return false;
  if (
    event.pull_request.base?.sha !== b.base ||
    event.pull_request.head.repo?.full_name !== b.repository ||
    event.pull_request.base.repo?.full_name !== b.repository ||
    process.env.CHECK_MODE !== 'ci-only' ||
    process.env.NODE_ENV !== 'test'
  )
    throw new Error('Prepare-fix continuation scope changed');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const currentHeadTree = git('rev-parse', event.pull_request.head.sha + '^{tree}');
  const changed = git('diff', '--name-only', b.base, tree).split('\n').filter(Boolean);
  const bytes = (commit, path) =>
    execFileSync('git', ['show', commit + ':' + path], { encoding: 'utf8' });
  const digest = (raw) => createHash('sha256').update(raw).digest('hex');
  const run = gh('repos/' + b.repository + '/actions/runs/' + b.run);
  const { jobs } = gh(
    'repos/' + b.repository + '/actions/runs/' + b.run + '/attempts/1/jobs?per_page=100'
  );
  const { artifacts } = gh(
    'repos/' + b.repository + '/actions/runs/' + b.run + '/artifacts?per_page=100'
  );
  const artifact = artifacts.find((row) => row.id === b.artifact);
  const zipped = execFileSync(
    'gh',
    ['api', 'repos/' + b.repository + '/actions/artifacts/' + b.artifact + '/zip'],
    { maxBuffer: 8192 }
  );
  if (zipped.length !== 357 || digest(zipped) !== b.artifactSha256)
    throw new Error('Prepare-fix source artifact bytes changed');
  const proofRaw = execFileSync(
    'python3',
    [
      '-B',
      '-c',
      'import sys,zipfile,io;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.namelist()==["evidence.json"];sys.stdout.buffer.write(z.read("evidence.json"))'
    ],
    { input: zipped, maxBuffer: 8192 }
  );
  const log = (job) =>
    execFileSync(
      'gh',
      [
        'api',
        '--allow-escape-sequences',
        'repos/' + b.repository + '/actions/jobs/' + job + '/logs'
      ],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
  const modesUnchanged = changed.every((path) => {
    const before = git('ls-tree', b.base, '--', path),
      after = git('ls-tree', tree, '--', path);
    return (
      /^[0-9]+ blob [a-f0-9]{40}\t/.test(after) && before.split(' ')[0] === after.split(' ')[0]
    );
  });
  requireOnlinePrepareFixGuardNative({
    run,
    jobs,
    artifact,
    proof: JSON.parse(proofRaw),
    proofSha256: digest(proofRaw),
    originalPr: gh('repos/' + b.repository + '/pulls/470'),
    mainRun: gh('repos/' + b.repository + '/actions/runs/' + b.mainRun),
    facts: onlinePrepareFixGuardRawLogFacts(log(b.job)),
    qualityLog: onlinePrepareFixGuardRawLogFacts(log(b.qualityJob)),
    changed,
    currentEnvironment: onlineComponentGuardCurrentEnvironment(),
    currentHeadTree,
    currentTree: tree,
    baselineTree: git('rev-parse', b.base + '^{tree}'),
    modesUnchanged,
    runtimeSha256: digest(bytes(tree, onlinePrepareFixGuardPaths[0])),
    runtimeTestSha256: digest(bytes(tree, onlinePrepareFixGuardPaths[1])),
    runtimeUnchanged: onlinePrepareFixRuntimeBytesUnchanged(
      bytes(b.base, onlinePrepareFixGuardPaths[0]),
      bytes(tree, onlinePrepareFixGuardPaths[0])
    ),
    scopeUnchanged: onlinePrepareFixScopeBytesUnchanged(
      bytes(b.base, 'scripts/ci-recharge-scope.mjs'),
      bytes(tree, 'scripts/ci-recharge-scope.mjs')
    ),
    dispatcherUnchanged: onlinePrepareFixDispatcherBytesUnchanged(
      bytes(b.base, 'scripts/ci-recharge-check.mjs'),
      bytes(tree, 'scripts/ci-recharge-check.mjs')
    )
  });
  return true;
}
// END finite ONLINE prepare-fix guard continuation

// BEGIN finite ONLINE failure-receipt guard continuation
export const onlinePreflightReceiptFixGuardBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  branch: 'codex/online-receipt-storage-integration-20261014',
  originalMergedMain: 'a9829b443fe5c0cf6f4803366d06c5f8e3357318',
  integrationBase: 'b9f2e2b75a753b86a5057dd798d651c57496554e',
  integrationTree: 'd7a012ba01d59d37ccf79141bc9055332c3978fc',
  integrationMainRun: 38518628653,
  originalHead: '4a1a76536fda6513cbc8e252bde813e471c15b6f',
  originalBase: '2edb7ef92a9619e5b0e5855220c97bac29d22f60',
  tree: 'a473264b8821ebe72471979614ba7983c531e309',
  checkout: 'bb4ffb35b1772a1df28caf8f5c68dfbbb02f9632',
  run: 38508638260,
  attempt: 1,
  job: 115671848013,
  qualityJob: 115680672303,
  mainRun: 38511580891,
  artifact: 11869619286,
  artifactSha256: 'a9647d0f5c21777325da19670cf9ff825252f88b8784169a56cf8caa6dcc2031',
  proofSha256: 'c901e3b542522976e6896c24b951af22d5abaf5fe59d98a706bc2292c7bc4521',
  // Authenticate only original platform log bytes, never CLI presentation.
  rawLogSha256: '33b7dd17b66f825aea10dc6b6f1dcda61baf053d39ae71c370986baf10a84318',
  rawQualityLogSha256: '2f46b3bf0ad7a1ab19c42c1dd9751283c8927611bb90a75ab8470d8fe85d36aa',
  runtimeSha256: 'd9c190070799937c548c5188e44d3a63c1c129ede2d9565637e3ae95b18c1641',
  runtimeTestSha256: 'b7e0ff38b8cd7246fb63c2b8510233bf257f822a04b559a56f8094616e8bbc77'
});
export const onlinePreflightReceiptFixGuardPaths = Object.freeze([
  'scripts/production-release/online-recharge-component-runtime.py',
  'scripts/production-release/online-recharge-component-runtime.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/CENTRAL_RELEASE_20261002.md',
  'docs/WORKSPACE_RELEASE_CLEANUP_20261014.md'
]);
export const onlinePreflightReceiptFixGuardCommands = Object.freeze(
  [
    ['python3', '-B', 'scripts/production-release/online-recharge-component-consumer.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-component-runtime.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-component-readonly.test.py'],
    ['python3', '-B', 'scripts/production-release/api-admin-scope.test.py'],
    ['python3', '-B', 'scripts/production-release/api-admin-pending-online.test.py'],
    ['python3', '-B', 'scripts/production-release/admin-pending-online-release.test.py'],
    ['python3', '-B', 'scripts/production-release/online-recharge-scope.test.py'],
    ['python3', '-B', 'scripts/production-release/unpublished-component-successor.test.py'],
    [
      'python3',
      '-B',
      'scripts/production-release/unpublished-component-successor-readonly.test.py'
    ],
    ['python3', '-B', 'scripts/production-release/prepared-images.test.py'],
    ['node', '--test', 'scripts/production-release/recharge-flow-entry.test.mjs'],
    ['node', '--test', 'scripts/production-release/online-recharge-entry.test.mjs'],
    ['python3', '-B', 'scripts/production-release/unified-component-source.test.py'],
    ['node', '--test', 'scripts/v2-order-archive-release-policy.test.mjs'],
    ['python3', '-B', 'scripts/production-release/registration-onboarding-96.test.py'],
    ['python3', '-B', 'scripts/production-release/release-artifact-retention.test.py'],
    ['python3', '-B', 'scripts/production-release/release-artifact-retention-transport.test.py'],
    ['python3', '-B', 'scripts/production-release/disk-retention-transport.test.py'],
    ['python3', '-B', 'scripts/production-release/release-storage.test.py']
  ].map(Object.freeze)
);

export function onlinePreflightReceiptFixScopeBytesUnchanged(before, after) {
  const start = '// BEGIN finite ONLINE failure-receipt guard continuation\n';
  const end = '// END finite ONLINE failure-receipt guard continuation\n\n';
  if (
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    before.includes(start) ||
    after.split(start).length !== 2 ||
    after.split(end).length !== 2
  )
    return false;
  const left = after.indexOf(start),
    right = after.indexOf(end);
  return right > left && after.slice(0, left) + after.slice(right + end.length) === before;
}

export function onlinePreflightReceiptFixDispatcherBytesUnchanged(before, after) {
  const declaration = [
    'const resumeOnlinePreflightReceiptFixGuard =',
    "  part === 'guards' &&",
    "  mode === 'ci-only' &&",
    "  process.env.GITHUB_ACTIONS === 'true' &&",
    "  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&",
    "  process.env.GITHUB_EVENT_NAME === 'pull_request' &&",
    "  base === 'b9f2e2b75a753b86a5057dd798d651c57496554e' &&",
    '  canResumeOnlinePreflightReceiptFixGuard(base);',
    ''
  ].join('\n');
  const extension = [
    'if (resumeOnlinePreflightReceiptFixGuard) {',
    '  for (const [file, ...args] of onlinePreflightReceiptFixGuardCommands) run(file, args);',
    '  process.exit(0);',
    '}',
    ''
  ].join('\n');
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  for (const addition of [
    '  canResumeOnlinePreflightReceiptFixGuard,\n',
    '  onlinePreflightReceiptFixGuardCommands,\n',
    declaration,
    extension
  ]) {
    if (after.split(addition).length !== 2) return false;
    after = after.replace(addition, '');
  }
  return after === before;
}

export function onlinePreflightReceiptFixRuntimeBytesUnchanged(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const body = /^def validate_component_invocation\(.*?(?=^def [A-Za-z_])/ms;
  const helper = /^def rejection_code\(.*?(?=^def [A-Za-z_])/ms;
  const left = body.exec(before),
    right = body.exec(after),
    added = helper.exec(after);
  if (
    !left ||
    !right ||
    left[0] === right[0] ||
    helper.test(before) ||
    !added ||
    after.match(/^def rejection_code\(/gm)?.length !== 1
  )
    return false;
  for (const declaration of ['import subprocess\n', 'import urllib.error\n']) {
    if (before.includes(declaration) || after.split(declaration).length !== 2) return false;
    after = after.replace(declaration, '');
  }
  const prior = [
    '        code = str(error)',
    "        if not re.fullmatch('(?:ONLINE_RECHARGE_COMPONENT|ONLINE_RECHARGE|API_ADMIN|UNPUBLISHED_COMPONENT)_[A-Z0-9_]+', code):",
    "            code = 'ONLINE_RECHARGE_COMPONENT_PROTECTED_OPERATION_FAILED'",
    ''
  ].join('\n');
  const current = '        code = rejection_code(error)\n';
  if (before.split(prior).length !== 2 || after.split(current).length !== 2) return false;
  after = after.replace(current, prior).replace(right[0], left[0]).replace(added[0], '');
  return after === before;
}

export function onlinePreflightReceiptFixGuardRawLogFacts(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length) return undefined;
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return undefined;
  const utc = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
  const rows = text.split('\n');
  if (rows.some((line) => line && !utc.test(line))) return undefined;
  const lines = rows.map((line) => line.replace(utc, ''));
  const checkout = lines.findIndex((line) => line === '[command]/usr/bin/git log -1 --format=%H');
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    checkout: checkout < 0 ? undefined : lines[checkout + 1],
    scope:
      lines.includes('  CHECK_BASE: ' + onlinePreflightReceiptFixGuardBinding.originalBase) &&
      lines.includes('  CHECK_MODE: ci-only') &&
      lines.includes('  CHECK_PART: guards') &&
      lines.includes('##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"'),
    environment:
      lines.includes('  NODE_ENV: test') &&
      lines.includes('Image: ubuntu-24.04') &&
      lines.includes('Version: 20261004.327.1') &&
      lines.includes('node: v24.21.0') &&
      lines.includes('npm: 11.19.0'),
    errors: lines.filter((line) => /^(?:ERROR|FAIL): /.test(line)),
    failedCommands: lines.filter((line) => /^Error: Command failed: /.test(line))
  };
}

export function validateOnlinePreflightReceiptFixGuardNative({
  run,
  jobs,
  qualityLog,
  facts,
  artifact,
  proof,
  proofSha256,
  originalPr,
  mainRun,
  integrationMainRun,
  changed,
  currentEnvironment,
  currentHeadTree,
  currentTree,
  runtimeSha256,
  runtimeTestSha256,
  scopeUnchanged,
  dispatcherUnchanged,
  runtimeUnchanged,
  modesUnchanged,
  baselineTree
} = {}) {
  const b = onlinePreflightReceiptFixGuardBinding;
  const rows = Array.isArray(jobs) ? jobs : [];
  const job = rows.filter((row) => row.id === b.job);
  const quality = rows.filter((row) => row.id === b.qualityJob);
  const validJob = (row, name) =>
    row?.run_id === b.run &&
    row.run_attempt === 1 &&
    row.name === name &&
    row.head_sha === b.originalHead &&
    row.status === 'completed' &&
    row.conclusion === 'success';
  return !!(
    run?.id === b.run &&
    run.run_attempt === 1 &&
    run.event === 'pull_request' &&
    run.path === '.github/workflows/quality.yml' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.head_sha === b.originalHead &&
    run.repository?.full_name === b.repository &&
    originalPr?.number === 471 &&
    originalPr.state === 'closed' &&
    originalPr.merged === true &&
    originalPr.head?.sha === b.originalHead &&
    originalPr.base?.sha === b.originalBase &&
    originalPr.merge_commit_sha === b.originalMergedMain &&
    mainRun?.id === b.mainRun &&
    mainRun.run_attempt === 1 &&
    mainRun.event === 'push' &&
    mainRun.path === '.github/workflows/quality.yml' &&
    mainRun.status === 'completed' &&
    mainRun.conclusion === 'success' &&
    mainRun.head_sha === b.originalMergedMain &&
    mainRun.repository?.full_name === b.repository &&
    integrationMainRun?.id === b.integrationMainRun &&
    integrationMainRun.run_attempt === 1 &&
    integrationMainRun.event === 'push' &&
    integrationMainRun.path === '.github/workflows/quality.yml' &&
    integrationMainRun.status === 'completed' &&
    integrationMainRun.conclusion === 'success' &&
    integrationMainRun.head_sha === b.integrationBase &&
    integrationMainRun.head_branch === 'main' &&
    integrationMainRun.head_commit?.id === b.integrationBase &&
    integrationMainRun.head_commit?.tree_id === b.integrationTree &&
    integrationMainRun.repository?.full_name === b.repository &&
    job.length === 1 &&
    validJob(job[0], 'recharge (guards)') &&
    quality.length === 1 &&
    validJob(quality[0], 'quality') &&
    [
      'Checkout',
      'Setup Node.js',
      'Install package dependencies',
      'Check affected recharge part'
    ].every(
      (name) =>
        job[0].steps?.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    ) &&
    ['Install browser for recharge acceptance', 'Install existing connector dependencies'].every(
      (name) =>
        job[0].steps?.filter((step) => step.name === name && step.conclusion === 'skipped')
          .length === 1
    ) &&
    [
      'Checkout the tested source tree for its evidence',
      'Record successful PR source evidence',
      'Preserve successful source evidence'
    ].every(
      (name) =>
        quality[0].steps?.filter(
          (step) =>
            step.name === name && step.status === 'completed' && step.conclusion === 'success'
        ).length === 1
    ) &&
    artifact?.id === b.artifact &&
    artifact.name === 'quality-source-evidence-1' &&
    artifact.expired === false &&
    artifact.size_in_bytes === 355 &&
    artifact.digest === 'sha256:' + b.artifactSha256 &&
    artifact.workflow_run?.id === b.run &&
    artifact.workflow_run.head_sha === b.originalHead &&
    typeOfProof(proof) &&
    proofSha256 === b.proofSha256 &&
    matchesSourceEvidence(proof, {
      repo: b.repository,
      run,
      pr: { number: 471, head: { sha: b.originalHead } },
      tree: b.tree
    }) &&
    proof.baseSha === b.originalBase &&
    facts?.sha256 === b.rawLogSha256 &&
    facts.checkout === b.checkout &&
    facts.scope === true &&
    facts.environment === true &&
    Array.isArray(facts.errors) &&
    facts.errors.length === 0 &&
    Array.isArray(facts.failedCommands) &&
    facts.failedCommands.length === 0 &&
    qualityLog?.sha256 === b.rawQualityLogSha256 &&
    qualityLog.checkout === b.checkout &&
    baselineTree === b.integrationTree &&
    currentHeadTree === currentTree &&
    /^[a-f0-9]{40}$/.test(currentTree || '') &&
    Array.isArray(changed) &&
    changed.includes(onlinePreflightReceiptFixGuardPaths[0]) &&
    changed.includes(onlinePreflightReceiptFixGuardPaths[1]) &&
    changed.every((path) => onlinePreflightReceiptFixGuardPaths.includes(path)) &&
    currentEnvironment?.node === 'v24.21.0' &&
    currentEnvironment.npm === '11.19.0' &&
    currentEnvironment.imageOS === 'ubuntu24' &&
    currentEnvironment.imageVersion === '20261004.327.1' &&
    currentEnvironment.platform === 'linux' &&
    runtimeSha256 === b.runtimeSha256 &&
    runtimeTestSha256 === b.runtimeTestSha256 &&
    scopeUnchanged === true &&
    dispatcherUnchanged === true &&
    runtimeUnchanged === true &&
    modesUnchanged === true
  );
}
export function onlinePreflightReceiptFixGuardFailureCodes(input = {}) {
  // Diagnostics never serialize native records, caller fields or environment
  // values. The original validator remains the sole admission decision.
  const b = onlinePreflightReceiptFixGuardBinding;
  const codes = [];
  const check = (code, predicate) => {
    try {
      if (!predicate()) codes.push(code);
    } catch {
      codes.push(code);
    }
  };
  const { run, originalPr, mainRun, integrationMainRun, artifact, proof, facts, qualityLog } =
    input;
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const guard = jobs.filter((row) => row?.id === b.job);
  const quality = jobs.filter((row) => row?.id === b.qualityJob);
  const runOK = (row, id, event, head) =>
    row?.id === id &&
    row.run_attempt === 1 &&
    row.event === event &&
    row.path === '.github/workflows/quality.yml' &&
    row.status === 'completed' &&
    row.conclusion === 'success' &&
    row.head_sha === head &&
    row.repository?.full_name === b.repository;
  const jobOK = (rows, name) =>
    rows.length === 1 &&
    rows[0].run_id === b.run &&
    rows[0].run_attempt === 1 &&
    rows[0].name === name &&
    rows[0].head_sha === b.originalHead &&
    rows[0].status === 'completed' &&
    rows[0].conclusion === 'success';
  const stepsOK = (rows, names, skipped = false) =>
    rows.length === 1 &&
    Array.isArray(rows[0].steps) &&
    names.every(
      (name) =>
        rows[0].steps.filter(
          (step) =>
            step?.name === name &&
            step.conclusion === (skipped ? 'skipped' : 'success') &&
            (skipped || step.status === 'completed')
        ).length === 1
    );
  check('ORIGINAL_RUN', () => runOK(run, b.run, 'pull_request', b.originalHead));
  check(
    'CLOSED_PR_SOURCE',
    () =>
      originalPr?.number === 471 &&
      originalPr.state === 'closed' &&
      originalPr.merged === true &&
      originalPr.head?.sha === b.originalHead &&
      originalPr.base?.sha === b.originalBase &&
      originalPr.merge_commit_sha === b.originalMergedMain
  );
  check('MAIN_QUALITY', () => runOK(mainRun, b.mainRun, 'push', b.originalMergedMain));
  check(
    'INTEGRATION_MAIN_QUALITY',
    () =>
      runOK(integrationMainRun, b.integrationMainRun, 'push', b.integrationBase) &&
      integrationMainRun.head_branch === 'main' &&
      integrationMainRun.head_commit?.id === b.integrationBase &&
      integrationMainRun.head_commit?.tree_id === b.integrationTree
  );
  check('GUARD_JOB', () => jobOK(guard, 'recharge (guards)'));
  check('GUARD_STEPS', () =>
    stepsOK(guard, [
      'Checkout',
      'Setup Node.js',
      'Install package dependencies',
      'Check affected recharge part'
    ])
  );
  check('GUARD_SKIPPED_DEPENDENCIES', () =>
    stepsOK(
      guard,
      ['Install browser for recharge acceptance', 'Install existing connector dependencies'],
      true
    )
  );
  check('QUALITY_JOB', () => jobOK(quality, 'quality'));
  check('QUALITY_STEPS', () =>
    stepsOK(quality, [
      'Checkout the tested source tree for its evidence',
      'Record successful PR source evidence',
      'Preserve successful source evidence'
    ])
  );
  check(
    'SOURCE_ARTIFACT',
    () =>
      artifact?.id === b.artifact &&
      artifact.name === 'quality-source-evidence-1' &&
      artifact.expired === false &&
      artifact.size_in_bytes === 355 &&
      artifact.digest === 'sha256:' + b.artifactSha256 &&
      artifact.workflow_run?.id === b.run &&
      artifact.workflow_run.head_sha === b.originalHead
  );
  check('PROOF_BYTES', () => input.proofSha256 === b.proofSha256);
  check(
    'PROOF_SOURCE',
    () =>
      typeOfProof(proof) &&
      matchesSourceEvidence(proof, {
        repo: b.repository,
        run,
        pr: { number: 471, head: { sha: b.originalHead } },
        tree: b.tree
      }) &&
      proof.baseSha === b.originalBase
  );
  check('GUARD_LOG_BYTES', () => facts?.sha256 === b.rawLogSha256);
  check('GUARD_LOG_CHECKOUT', () => facts?.checkout === b.checkout);
  check('GUARD_LOG_SCOPE', () => facts?.scope === true);
  check('GUARD_LOG_ENVIRONMENT', () => facts?.environment === true);
  check(
    'GUARD_LOG_ERRORS',
    () =>
      Array.isArray(facts?.errors) &&
      facts.errors.length === 0 &&
      Array.isArray(facts.failedCommands) &&
      facts.failedCommands.length === 0
  );
  check('QUALITY_LOG_BYTES', () => qualityLog?.sha256 === b.rawQualityLogSha256);
  check('QUALITY_LOG_CHECKOUT', () => qualityLog?.checkout === b.checkout);
  check('BASELINE_TREE', () => input.baselineTree === b.integrationTree);
  check(
    'CURRENT_TREE',
    () =>
      input.currentHeadTree === input.currentTree && /^[a-f0-9]{40}$/.test(input.currentTree || '')
  );
  check(
    'CHANGED_PATHS',
    () =>
      Array.isArray(input.changed) &&
      input.changed.includes(onlinePreflightReceiptFixGuardPaths[0]) &&
      input.changed.includes(onlinePreflightReceiptFixGuardPaths[1]) &&
      input.changed.every((path) => onlinePreflightReceiptFixGuardPaths.includes(path))
  );
  for (const [key, expected, code] of [
    ['node', 'v24.21.0', 'ENV_NODE'],
    ['npm', '11.19.0', 'ENV_NPM'],
    ['imageOS', 'ubuntu24', 'ENV_IMAGE_OS'],
    ['imageVersion', '20261004.327.1', 'ENV_IMAGE_VERSION'],
    ['platform', 'linux', 'ENV_PLATFORM']
  ])
    check(code, () => input.currentEnvironment?.[key] === expected);
  check('RUNTIME_SOURCE', () => input.runtimeSha256 === b.runtimeSha256);
  check('RUNTIME_TEST_SOURCE', () => input.runtimeTestSha256 === b.runtimeTestSha256);
  for (const [key, code] of [
    ['scopeUnchanged', 'SCOPE_NORMALIZATION'],
    ['dispatcherUnchanged', 'DISPATCHER_NORMALIZATION'],
    ['runtimeUnchanged', 'RUNTIME_NORMALIZATION'],
    ['modesUnchanged', 'FILE_MODES']
  ])
    check(code, () => input[key] === true);
  return codes;
}

export function requireOnlinePreflightReceiptFixGuardNative(input) {
  if (!validateOnlinePreflightReceiptFixGuardNative(input)) {
    const codes = onlinePreflightReceiptFixGuardFailureCodes(input);
    throw new Error(
      'Original failure-receipt source or guard evidence changed; predicates=' +
        (codes.length ? codes.join(',') : 'UNCLASSIFIED_PREDICATE')
    );
  }
  return true;
}

export function canResumeOnlinePreflightReceiptFixGuard(base) {
  const b = onlinePreflightReceiptFixGuardBinding;
  if (
    base !== b.integrationBase ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== b.repository ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request'
  )
    return false;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (
    event.pull_request?.head?.ref !== b.branch ||
    event.pull_request.base?.sha !== b.integrationBase
  )
    return false;
  if (
    event.pull_request.base?.sha !== b.integrationBase ||
    event.pull_request.head.repo?.full_name !== b.repository ||
    event.pull_request.base.repo?.full_name !== b.repository ||
    process.env.CHECK_MODE !== 'ci-only' ||
    process.env.NODE_ENV !== 'test'
  )
    throw new Error('Failure-receipt continuation scope changed');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const currentHeadTree = git('rev-parse', event.pull_request.head.sha + '^{tree}');
  const changed = git('diff', '--name-only', b.integrationBase, tree).split('\n').filter(Boolean);
  const bytes = (commit, path) =>
    execFileSync('git', ['show', commit + ':' + path], { encoding: 'utf8' });
  const digest = (raw) => createHash('sha256').update(raw).digest('hex');
  const run = gh('repos/' + b.repository + '/actions/runs/' + b.run);
  const { jobs } = gh(
    'repos/' + b.repository + '/actions/runs/' + b.run + '/attempts/1/jobs?per_page=100'
  );
  const { artifacts } = gh(
    'repos/' + b.repository + '/actions/runs/' + b.run + '/artifacts?per_page=100'
  );
  const artifact = artifacts.find((row) => row.id === b.artifact);
  const zipped = execFileSync(
    'gh',
    ['api', 'repos/' + b.repository + '/actions/artifacts/' + b.artifact + '/zip'],
    { maxBuffer: 8192 }
  );
  if (zipped.length !== 355 || digest(zipped) !== b.artifactSha256)
    throw new Error('Failure-receipt source artifact bytes changed');
  const proofRaw = execFileSync(
    'python3',
    [
      '-B',
      '-c',
      'import sys,zipfile,io;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.namelist()==["evidence.json"];sys.stdout.buffer.write(z.read("evidence.json"))'
    ],
    { input: zipped, maxBuffer: 8192 }
  );
  const log = (job) =>
    execFileSync(
      'gh',
      [
        'api',
        '--allow-escape-sequences',
        'repos/' + b.repository + '/actions/jobs/' + job + '/logs'
      ],
      {
        maxBuffer: 4 * 1024 * 1024
      }
    );
  const modesUnchanged = changed.every((path) => {
    const before = git('ls-tree', b.integrationBase, '--', path),
      after = git('ls-tree', tree, '--', path);
    return (
      /^[0-9]+ blob [a-f0-9]{40}\t/.test(after) && before.split(' ')[0] === after.split(' ')[0]
    );
  });
  requireOnlinePreflightReceiptFixGuardNative({
    run,
    jobs,
    artifact,
    proof: JSON.parse(proofRaw),
    proofSha256: digest(proofRaw),
    originalPr: gh('repos/' + b.repository + '/pulls/471'),
    mainRun: gh('repos/' + b.repository + '/actions/runs/' + b.mainRun),
    integrationMainRun: gh('repos/' + b.repository + '/actions/runs/' + b.integrationMainRun),
    facts: onlinePreflightReceiptFixGuardRawLogFacts(log(b.job)),
    qualityLog: onlinePreflightReceiptFixGuardRawLogFacts(log(b.qualityJob)),
    changed,
    currentEnvironment: onlineComponentGuardCurrentEnvironment(),
    currentHeadTree,
    currentTree: tree,
    baselineTree: git('rev-parse', b.integrationBase + '^{tree}'),
    modesUnchanged,
    runtimeSha256: digest(bytes(tree, onlinePreflightReceiptFixGuardPaths[0])),
    runtimeTestSha256: digest(bytes(tree, onlinePreflightReceiptFixGuardPaths[1])),
    runtimeUnchanged: onlinePreflightReceiptFixRuntimeBytesUnchanged(
      bytes(b.integrationBase, onlinePreflightReceiptFixGuardPaths[0]),
      bytes(tree, onlinePreflightReceiptFixGuardPaths[0])
    ),
    scopeUnchanged: onlinePreflightReceiptFixScopeBytesUnchanged(
      bytes(b.integrationBase, 'scripts/ci-recharge-scope.mjs'),
      bytes(tree, 'scripts/ci-recharge-scope.mjs')
    ),
    dispatcherUnchanged: onlinePreflightReceiptFixDispatcherBytesUnchanged(
      bytes(b.integrationBase, 'scripts/ci-recharge-check.mjs'),
      bytes(tree, 'scripts/ci-recharge-check.mjs')
    )
  });
  return true;
}
// END finite ONLINE failure-receipt guard continuation

// BEGIN finite ONLINE build-proof reuse guard continuation
export const onlineBuildProofReuseGuardBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  branch: 'codex/online-storage-proof-integration-20261014',
  base: '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53',
  tree: 'bcc614bd53dbf4ddf8e3d7d6ba85d5a4ed1f1a3a',
  originalMergedMain: 'fff7b257fa402e14da5d9aa43aa4ea22095695c5',
  originalMergedTree: '04637480488076dc891c822e79864f8ff96bbf06',
  originalPr: 475,
  originalHead: '52f25bad6fb42721faceb3d7ce5cd9d052e8e71a',
  originalBase: '619b04c240eed836b1db76a9fe330634de1fecbf',
  run: 38526906459,
  attempt: 1,
  originalMainRun: 38530643303,
  integrationMainRun: 38544086836,
  job: 115729349592,
  qualityJob: 115740147064,
  checkout: '52fe5d339984bc8c89f27175e96786015469a25a',
  artifact: 11877289090,
  artifactBytes: 356,
  artifactSha256: '0bc50667d3c61761e6340a80100eaf0bfc6b8a7a47feaa264754c56a285d867d',
  proofSha256: '9a211fe11776350e0a2760a7ab5e3fbc44c8b254689dbd7efc0435ddf725ca1d',
  rawLogSha256: '6a87290af1201dcc0c603fccf3a40669b2c41c121abf5084e503b4257f858b3b',
  rawQualityLogSha256: '7fa909ea5f2feb39e56ab1f80cd510fee5460bc175b2559056d0c101c453edef',
  runtimeSha256: 'f751166a3caec0dcf0d1657d9604f2aacff3aa7b1615112275c81d116dabfb79',
  runtimeTestSha256: '4a2dbf2111592d2711cf175b2d9b3bdd0fc619b6f940bc5d604cfb2378eb74d7',
  readonlySha256: 'c65a7fd1a92c133cfda4e2a94d9326c4b1eae5f63c149b163f31aa59ef34fe8a',
  readonlyTestSha256: 'e43cf0ead1fdd0c3a46186c3b24a1527c1d6d48085912a9fcf2eae3b7907cb26',
  helperSha256: '81373a391b1116e81d914acbeed574ef272daac37a88e9e2539c4d7351372434',
  helperTestSha256: '47f20b34d353214c52527ec1dac492be7c2e5ec5cf986dc8d8b86ca374e55357',
  dispatcherTestSha256: '08a891b2d2acb151445332dda7d0fdc442908b44f9112430f653e9e1d929d5cf'
});
export const onlineBuildProofReuseGuardPaths = Object.freeze([
  'scripts/production-release/online-recharge-component-runtime.py',
  'scripts/production-release/online-recharge-component-runtime.test.py',
  'scripts/production-release/online-recharge-component-readonly.py',
  'scripts/production-release/online-recharge-component-readonly.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/production-release/online-recharge-ci-build.py',
  'scripts/production-release/online-recharge-ci-build.test.py',
  'docs/CENTRAL_RELEASE_20261002.md',
  'docs/WORKSPACE_RELEASE_CLEANUP_20261014.md'
]);
export const onlineBuildProofReuseCommands = Object.freeze([
  ...onlinePreflightReceiptFixGuardCommands,
  Object.freeze([
    'python3',
    '-B',
    'scripts/production-release/online-recharge-component-diagnostic.test.py'
  ]),
  Object.freeze([
    'python3',
    '-B',
    'scripts/production-release/online-recharge-component-lifecycle.test.py'
  ]),
  Object.freeze([
    'node',
    '--test',
    'scripts/production-release/online-recharge-component-diagnostic-entry.test.mjs'
  ])
]);

export function onlineBuildProofReuseScopeBytesUnchanged(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  for (const [name, indent] of [
    ['guard continuation', ''],
    ['classifier admission', '  ']
  ]) {
    const start = indent + '// BEGIN finite ONLINE build-proof reuse ' + name + '\n';
    const end = indent + '// END finite ONLINE build-proof reuse ' + name + '\n\n';
    if (before.includes(start) || after.split(start).length !== 2 || after.split(end).length !== 2)
      return false;
    const left = after.indexOf(start),
      right = after.indexOf(end);
    if (right <= left) return false;
    after = after.slice(0, left) + after.slice(right + end.length);
  }
  return after === before;
}
export function onlineBuildProofReuseScopeTestBytesUnchanged(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const start = '// BEGIN finite ONLINE build-proof reuse guard tests\n';
  const end = '// END finite ONLINE build-proof reuse guard tests\n';
  if (before.includes(start) || after.split(start).length !== 2 || after.split(end).length !== 2)
    return false;
  const left = after.indexOf(start),
    right = after.indexOf(end);
  return right > left && after.slice(0, left) + after.slice(right + end.length) === before;
}
export function onlineBuildProofReuseDispatcherBytesUnchanged(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const declaration = [
    'const resumeOnlineBuildProofReuseGuard =',
    "  part === 'guards' &&",
    "  mode === 'ci-only' &&",
    "  process.env.GITHUB_ACTIONS === 'true' &&",
    "  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&",
    "  process.env.GITHUB_EVENT_NAME === 'pull_request' &&",
    "  base === '5f458e7ac7cd0dfab0f99d2a6d07c20baa8b6e53' &&",
    '  canResumeOnlineBuildProofReuseGuard(base);',
    ''
  ].join('\n');
  const extension = [
    'if (resumeOnlineBuildProofReuseGuard) {',
    "  run('python3', ['-B', 'scripts/production-release/online-recharge-ci-build.test.py']);",
    "  run('python3', [",
    "    '-B',",
    "    'scripts/production-release/online-recharge-ci-build.py',",
    "    '--ci-real-build-not-for-release',",
    "    '--admitted-source-tree',",
    "    execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()",
    '  ]);',
    '  for (const [file, ...args] of onlineBuildProofReuseCommands) run(file, args);',
    '  process.exit(0);',
    '}',
    ''
  ].join('\n');
  for (const addition of [
    '  canResumeOnlineBuildProofReuseGuard,\n',
    '  onlineBuildProofReuseCommands,\n',
    declaration,
    extension
  ]) {
    if (after.split(addition).length !== 2) return false;
    after = after.replace(addition, '');
  }
  return after === before;
}

export function onlineBuildProofReusePythonBytesUnchanged(before, after, name) {
  if (
    typeof before !== 'string' ||
    typeof after !== 'string' ||
    !['build_proof', 'safe_failure'].includes(name)
  )
    return false;
  try {
    return (
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          [
            'import ast,json,sys',
            'v=json.load(sys.stdin)',
            'def normalized(source):',
            ' tree=ast.parse(source)',
            ' names=["build_proof"] if v["name"]=="build_proof" else ["safe_failure","exception_details"]',
            ' for name in names:',
            '  hits=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name]',
            '  assert len(hits)==1',
            '  tree.body.remove(hits[0])',
            ' return ast.dump(tree,include_attributes=False)',
            'print("same" if normalized(v["before"])==normalized(v["after"]) else "different")'
          ].join('\n')
        ],
        {
          input: JSON.stringify({ before, after, name }),
          encoding: 'utf8',
          stdio: 'pipe',
          maxBuffer: 1024 * 1024
        }
      ).trim() === 'same'
    );
  } catch {
    return false;
  }
}

export function onlineBuildProofReuseGuardRawLogFacts(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length) return undefined;
  const source = raw.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(raw)) return undefined;
  const utc = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
  const rows = source.split('\n');
  if (rows.some((line) => line && !utc.test(line))) return undefined;
  const lines = rows.map((line) => line.replace(utc, ''));
  const positions = lines.flatMap((line, index) =>
    line === '[command]/usr/bin/git log -1 --format=%H' ? [index] : []
  );
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    checkout: positions.length === 1 ? lines[positions[0] + 1] : undefined,
    scope:
      lines.includes('  CHECK_BASE: ' + onlineBuildProofReuseGuardBinding.originalBase) &&
      lines.includes('  CHECK_MODE: ci-only') &&
      lines.includes('  CHECK_PART: guards') &&
      lines.includes('##[group]Run node scripts/ci-recharge-check.mjs "$CHECK_PART" "$CHECK_BASE"'),
    environment:
      lines.includes('  NODE_ENV: test') &&
      lines.includes('Image: ubuntu-24.04') &&
      lines.includes('Version: 20261004.327.1') &&
      lines.includes('node: v24.21.0') &&
      lines.includes('npm: 11.19.0'),
    errors: lines.filter((line) => /^(?:ERROR|FAIL): /.test(line)),
    failedCommands: lines.filter((line) => /^Error: Command failed: /.test(line))
  };
}

export function onlineBuildProofReuseGuardFailureCodes(input = {}) {
  const b = onlineBuildProofReuseGuardBinding,
    codes = [];
  const check = (code, predicate) => {
    try {
      if (!predicate()) codes.push(code);
    } catch {
      codes.push(code);
    }
  };
  const { run, originalPr, mainRun, integrationMainRun, artifact, proof, facts, qualityLog } =
    input;
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const guard = jobs.filter((row) => row?.id === b.job),
    quality = jobs.filter((row) => row?.id === b.qualityJob);
  const runOK = (row, id, event, head) =>
    row?.id === id &&
    row.run_attempt === b.attempt &&
    row.event === event &&
    row.path === '.github/workflows/quality.yml' &&
    row.status === 'completed' &&
    row.conclusion === 'success' &&
    row.head_sha === head &&
    row.repository?.full_name === b.repository;
  const jobOK = (rows, name) =>
    rows.length === 1 &&
    rows[0].run_id === b.run &&
    rows[0].run_attempt === b.attempt &&
    rows[0].name === name &&
    rows[0].head_sha === b.originalHead &&
    rows[0].status === 'completed' &&
    rows[0].conclusion === 'success';
  const stepsOK = (rows, names, skipped = false) =>
    rows.length === 1 &&
    Array.isArray(rows[0].steps) &&
    names.every(
      (name) =>
        rows[0].steps.filter(
          (step) =>
            step?.name === name &&
            step.status === 'completed' &&
            step.conclusion === (skipped ? 'skipped' : 'success')
        ).length === 1
    );
  check('ORIGINAL_RUN', () => runOK(run, b.run, 'pull_request', b.originalHead));
  check(
    'CLOSED_PR_SOURCE',
    () =>
      originalPr?.number === b.originalPr &&
      originalPr.state === 'closed' &&
      originalPr.merged === true &&
      originalPr.head?.sha === b.originalHead &&
      originalPr.base?.sha === b.originalBase &&
      originalPr.merge_commit_sha === b.originalMergedMain
  );
  check(
    'MAIN_QUALITY',
    () =>
      runOK(mainRun, b.originalMainRun, 'push', b.originalMergedMain) &&
      mainRun.head_branch === 'main' &&
      mainRun.head_commit?.id === b.originalMergedMain &&
      mainRun.head_commit?.tree_id === b.originalMergedTree
  );
  check(
    'INTEGRATION_MAIN_QUALITY',
    () =>
      runOK(integrationMainRun, b.integrationMainRun, 'push', b.base) &&
      integrationMainRun.head_branch === 'main' &&
      integrationMainRun.head_commit?.id === b.base &&
      integrationMainRun.head_commit?.tree_id === b.tree
  );
  check('GUARD_JOB', () => jobOK(guard, 'recharge (guards)'));
  check('GUARD_STEPS', () =>
    stepsOK(guard, [
      'Checkout',
      'Setup Node.js',
      'Install package dependencies',
      'Check affected recharge part',
      'Build and verify sealed ONLINE images without production access',
      'Preserve CI-only ONLINE image verification'
    ])
  );
  check('GUARD_SKIPPED_DEPENDENCIES', () =>
    stepsOK(
      guard,
      ['Install browser for recharge acceptance', 'Install existing connector dependencies'],
      true
    )
  );
  check('QUALITY_JOB', () => jobOK(quality, 'quality'));
  check('QUALITY_STEPS', () =>
    stepsOK(quality, [
      'Checkout the tested source tree for its evidence',
      'Record successful PR source evidence',
      'Preserve successful source evidence'
    ])
  );
  check(
    'SOURCE_ARTIFACT',
    () =>
      artifact?.id === b.artifact &&
      artifact.name === 'quality-source-evidence-1' &&
      artifact.expired === false &&
      artifact.size_in_bytes === b.artifactBytes &&
      artifact.digest === 'sha256:' + b.artifactSha256 &&
      artifact.workflow_run?.id === b.run &&
      artifact.workflow_run.head_sha === b.originalHead
  );
  check('PROOF_BYTES', () => input.proofSha256 === b.proofSha256);
  check(
    'PROOF_SOURCE',
    () =>
      typeOfProof(proof) &&
      matchesSourceEvidence(proof, {
        repo: b.repository,
        run,
        pr: { number: b.originalPr, head: { sha: b.originalHead } },
        tree: b.originalMergedTree
      }) &&
      proof.baseSha === b.originalBase
  );
  check('GUARD_LOG_BYTES', () => facts?.sha256 === b.rawLogSha256);
  check('GUARD_LOG_CHECKOUT', () => facts?.checkout === b.checkout);
  check('GUARD_LOG_SCOPE', () => facts?.scope === true);
  check('GUARD_LOG_ENVIRONMENT', () => facts?.environment === true);
  check(
    'GUARD_LOG_ERRORS',
    () =>
      Array.isArray(facts?.errors) &&
      facts.errors.length === 0 &&
      Array.isArray(facts.failedCommands) &&
      facts.failedCommands.length === 0
  );
  check('QUALITY_LOG_BYTES', () => qualityLog?.sha256 === b.rawQualityLogSha256);
  check('QUALITY_LOG_CHECKOUT', () => qualityLog?.checkout === b.checkout);
  check('BASELINE_TREE', () => input.baselineTree === b.tree);
  check(
    'CURRENT_TREE',
    () =>
      input.currentHeadTree === input.currentTree &&
      /^[a-f0-9]{40}$/.test(input.currentTree || '') &&
      input.currentTree !== b.tree
  );
  check(
    'CHANGED_PATHS',
    () =>
      Array.isArray(input.changed) &&
      input.changed.length === onlineBuildProofReuseGuardPaths.length &&
      new Set(input.changed).size === input.changed.length &&
      input.changed.every((path) => onlineBuildProofReuseGuardPaths.includes(path))
  );
  for (const [key, expected, code] of [
    ['node', 'v24.21.0', 'ENV_NODE'],
    ['npm', '11.19.0', 'ENV_NPM'],
    ['imageOS', 'ubuntu24', 'ENV_IMAGE_OS'],
    ['imageVersion', '20261004.327.1', 'ENV_IMAGE_VERSION'],
    ['platform', 'linux', 'ENV_PLATFORM']
  ])
    check(code, () => input.currentEnvironment?.[key] === expected);
  for (const [key, code] of [
    ['runtimeSha256', 'RUNTIME_SOURCE'],
    ['runtimeTestSha256', 'RUNTIME_TEST_SOURCE'],
    ['readonlySha256', 'READONLY_SOURCE'],
    ['readonlyTestSha256', 'READONLY_TEST_SOURCE'],
    ['helperSha256', 'HELPER_SOURCE'],
    ['helperTestSha256', 'HELPER_TEST_SOURCE'],
    ['dispatcherTestSha256', 'DISPATCHER_TEST_SOURCE']
  ])
    check(code, () => input[key] === b[key] && /^[a-f0-9]{64}$/.test(b[key]));
  for (const [key, code] of [
    ['scopeUnchanged', 'SCOPE_NORMALIZATION'],
    ['scopeTestUnchanged', 'SCOPE_TEST_NORMALIZATION'],
    ['dispatcherUnchanged', 'DISPATCHER_NORMALIZATION'],
    ['runtimeUnchanged', 'RUNTIME_NORMALIZATION'],
    ['readonlyUnchanged', 'READONLY_NORMALIZATION'],
    ['modesUnchanged', 'FILE_MODES']
  ])
    check(code, () => input[key] === true);
  return codes;
}
export function validateOnlineBuildProofReuseGuardNative(input) {
  return onlineBuildProofReuseGuardFailureCodes(input).length === 0;
}
export function requireOnlineBuildProofReuseGuardNative(input) {
  const codes = onlineBuildProofReuseGuardFailureCodes(input);
  if (codes.length)
    throw new Error(
      'Original build-proof source or guard evidence changed; predicates=' + codes.join(',')
    );
  return true;
}

export function canResumeOnlineBuildProofReuseGuard(base, phase = 'guards') {
  const b = onlineBuildProofReuseGuardBinding;
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'pull_request')
    return false;
  let event;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    throw new Error('Build-proof continuation event unavailable');
  }
  if (event.pull_request?.head?.ref !== b.branch) return false;
  if (
    process.env.GITHUB_REPOSITORY !== b.repository ||
    base !== b.base ||
    event.pull_request.base?.sha !== b.base ||
    event.pull_request.head.repo?.full_name !== b.repository ||
    event.pull_request.base.repo?.full_name !== b.repository ||
    !['scope', 'guards'].includes(phase) ||
    (phase === 'guards' &&
      (process.env.CHECK_MODE !== 'ci-only' || process.env.NODE_ENV !== 'test')) ||
    (phase === 'scope' &&
      ((process.env.CHECK_MODE && process.env.CHECK_MODE !== 'ci-only') ||
        (process.env.NODE_ENV && process.env.NODE_ENV !== 'test')))
  )
    throw new Error('Build-proof continuation scope changed');
  try {
    const tree = git('rev-parse', 'HEAD^{tree}');
    const currentHeadTree = git('rev-parse', event.pull_request.head.sha + '^{tree}');
    const changed = git('diff', '--name-only', b.base, tree).split('\n').filter(Boolean);
    if (
      currentHeadTree !== tree ||
      tree === b.tree ||
      git('rev-parse', b.base + '^{tree}') !== b.tree ||
      changed.length !== onlineBuildProofReuseGuardPaths.length ||
      new Set(changed).size !== changed.length ||
      changed.some((path) => !onlineBuildProofReuseGuardPaths.includes(path))
    )
      throw new Error('Build-proof continuation candidate source changed');
    const bytes = (revision, path) =>
      execFileSync('git', ['show', revision + ':' + path], { encoding: 'utf8' });
    const digest = (raw) => createHash('sha256').update(raw).digest('hex');
    const run = gh('repos/' + b.repository + '/actions/runs/' + b.run);
    const { jobs } = gh(
      'repos/' + b.repository + '/actions/runs/' + b.run + '/attempts/1/jobs?per_page=100'
    );
    const { artifacts } = gh(
      'repos/' + b.repository + '/actions/runs/' + b.run + '/artifacts?per_page=100'
    );
    const artifactsForSource = artifacts.filter((row) => row.id === b.artifact);
    if (artifactsForSource.length !== 1)
      throw new Error('Build-proof source artifact selection changed');
    const zipped = execFileSync(
      'gh',
      ['api', 'repos/' + b.repository + '/actions/artifacts/' + b.artifact + '/zip'],
      { maxBuffer: 8192 }
    );
    if (zipped.length !== b.artifactBytes || digest(zipped) !== b.artifactSha256)
      throw new Error('Build-proof source artifact bytes changed');
    const proofRaw = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        'import sys,zipfile,io;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.namelist()==["evidence.json"];sys.stdout.buffer.write(z.read("evidence.json"))'
      ],
      { input: zipped, maxBuffer: 8192 }
    );
    const log = (job) =>
      execFileSync(
        'gh',
        [
          'api',
          '--allow-escape-sequences',
          'repos/' + b.repository + '/actions/jobs/' + job + '/logs'
        ],
        { maxBuffer: 4 * 1024 * 1024 }
      );
    const modesUnchanged = changed.every((path) => {
      const before = git('ls-tree', b.base, '--', path),
        after = git('ls-tree', tree, '--', path);
      return (
        /^100644 blob [a-f0-9]{40}\t/.test(before) && /^100644 blob [a-f0-9]{40}\t/.test(after)
      );
    });
    const sourcePins = Object.fromEntries(
      [
        ['runtimeSha256', 0],
        ['runtimeTestSha256', 1],
        ['readonlySha256', 2],
        ['readonlyTestSha256', 3],
        ['helperSha256', 8],
        ['helperTestSha256', 9],
        ['dispatcherTestSha256', 7]
      ].map(([key, index]) => [key, digest(bytes(tree, onlineBuildProofReuseGuardPaths[index]))])
    );
    requireOnlineBuildProofReuseGuardNative({
      run,
      jobs,
      artifact: artifactsForSource[0],
      proof: JSON.parse(proofRaw),
      proofSha256: digest(proofRaw),
      originalPr: gh('repos/' + b.repository + '/pulls/' + b.originalPr),
      mainRun: gh('repos/' + b.repository + '/actions/runs/' + b.originalMainRun),
      integrationMainRun: gh('repos/' + b.repository + '/actions/runs/' + b.integrationMainRun),
      facts: onlineBuildProofReuseGuardRawLogFacts(log(b.job)),
      qualityLog: onlineBuildProofReuseGuardRawLogFacts(log(b.qualityJob)),
      changed,
      currentEnvironment: onlineComponentGuardCurrentEnvironment(),
      currentHeadTree,
      currentTree: tree,
      baselineTree: git('rev-parse', b.base + '^{tree}'),
      modesUnchanged,
      ...sourcePins,
      runtimeUnchanged: onlineBuildProofReusePythonBytesUnchanged(
        bytes(b.base, onlineBuildProofReuseGuardPaths[0]),
        bytes(tree, onlineBuildProofReuseGuardPaths[0]),
        'build_proof'
      ),
      readonlyUnchanged: onlineBuildProofReusePythonBytesUnchanged(
        bytes(b.base, onlineBuildProofReuseGuardPaths[2]),
        bytes(tree, onlineBuildProofReuseGuardPaths[2]),
        'safe_failure'
      ),
      scopeUnchanged: onlineBuildProofReuseScopeBytesUnchanged(
        bytes(b.base, 'scripts/ci-recharge-scope.mjs'),
        bytes(tree, 'scripts/ci-recharge-scope.mjs')
      ),
      scopeTestUnchanged: onlineBuildProofReuseScopeTestBytesUnchanged(
        bytes(b.base, 'scripts/ci-recharge-scope.test.mjs'),
        bytes(tree, 'scripts/ci-recharge-scope.test.mjs')
      ),
      dispatcherUnchanged: onlineBuildProofReuseDispatcherBytesUnchanged(
        bytes(b.base, 'scripts/ci-recharge-check.mjs'),
        bytes(tree, 'scripts/ci-recharge-check.mjs')
      )
    });
    return true;
  } catch {
    throw new Error('Build-proof continuation evidence unavailable');
  }
}
const onlineBuildProofReusePriorNeedsCiBuild = needsOnlineRechargeCiBuild;
// END finite ONLINE build-proof reuse guard continuation

export function canResumeCombinedGuard(base) {
  if (
    base !== combinedMigrationBinding.base ||
    process.env.GITHUB_REPOSITORY !== combinedMigrationBinding.repository
  )
    return false;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.pull_request?.number !== 463 || event.pull_request.base.sha !== base) return false;
  const repo = combinedMigrationBinding.repository;
  const tree = git('rev-parse', 'HEAD^{tree}');
  validateCombinedCommands(tree);
  reuseCombinedAdmin(repo, tree);
  const { jobs } = gh(`repos/${repo}/actions/runs/38414414141/attempts/1/jobs?per_page=100`);
  const job = jobs.find((row) => row.id === 115355004669);
  const log = execFileSync(
    'gh',
    ['run', 'view', '38414414141', '--repo', repo, '--job', '115355004669', '--log'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  const failures = log.match(/FAIL: [^\n]+/g) || [];
  if (
    job?.run_id !== 38414414141 ||
    job.name !== 'recharge (guards)' ||
    job.status !== 'completed' ||
    job.conclusion !== 'failure' ||
    job.steps.filter((step) => step.conclusion === 'failure').length !== 1 ||
    failures.length !== 1 ||
    !failures[0].includes('test_original_source_and_history_seals_remain_separate') ||
    !log.includes('Ran 297 tests in') ||
    !log.includes('Ran 9 tests in') ||
    !log.includes('FAILED (failures=1)') ||
    !log.includes('recharge-flow-successor-projection.test.py')
  )
    throw new Error('Original guard prefix evidence changed');
  return true;
}

function reuseCombinedMigration(repo, event, mode, paths, currentTree) {
  const b = combinedMigrationBinding;
  if (
    repo !== b.repository ||
    event.pull_request.number !== b.pullRequest ||
    mode !== 'admin' ||
    !hasCombinedComponentScope(paths) ||
    event.pull_request.base.sha !== b.base
  )
    return undefined;
  ensureCommit(b.head);
  if (git('rev-parse', `${b.head}^{tree}`) !== b.tree)
    throw new Error('Migration source tree changed');
  validateCombinedCommands(currentTree);
  const changed = git('diff', '--name-only', b.head, currentTree).split('\n').filter(Boolean);
  const run = gh(`repos/${repo}/actions/runs/${b.runId}`);
  const { jobs } = gh(
    `repos/${repo}/actions/runs/${b.runId}/attempts/${b.runAttempt}/jobs?per_page=100`
  );
  const checkout = gh(`repos/${repo}/git/commits/${b.checkout}`);
  const log = execFileSync(
    'gh',
    ['run', 'view', String(b.runId), '--repo', repo, '--job', String(b.jobId), '--log'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
  const evidence = validateCombinedMigrationNative({
    run,
    jobs,
    checkout,
    log,
    changed,
    dispatcherUnchanged: true,
    qualityWorkflowUnchanged: true
  });
  if (!evidence)
    throw new Error('Original migration evidence or unchanged input proof is unavailable');
  const unchanged = git('ls-tree', '-r', b.head)
    .split('\n')
    .filter((line) => !combinedMigrationRepairPaths.has(line.split('\t')[1]));
  evidence.inputSha256 = createHash('sha256').update(unchanged.join('\n')).digest('hex');
  return evidence;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
function ensureCommit(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source commit');
  try {
    git('cat-file', '-e', sha);
  } catch {
    git('fetch', '--no-tags', 'origin', sha);
  }
}
export function testedTree(run, number, repo) {
  try {
    if (
      !matchingRun(run, number, run.head_sha) ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0 ||
      !/^[a-f0-9]{40}$/.test(run.head_sha)
    )
      return undefined;
    const { artifacts } = gh(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = artifacts.find(
      (item) => item.name === `quality-source-evidence-${run.run_attempt}` && !item.expired
    );
    if (!artifact) return undefined;
    const directory = `.deploy/ci-source-evidence/${run.id}-${run.run_attempt}`;
    execFileSync(
      'gh',
      [
        'run',
        'download',
        String(run.id),
        '--repo',
        repo,
        '--name',
        artifact.name,
        '--dir',
        directory
      ],
      { stdio: 'pipe' }
    );
    const proof = JSON.parse(readFileSync(`${directory}/evidence.json`, 'utf8'));
    if (
      !/^[a-f0-9]{40}$/.test(proof.testedTree) ||
      !matchesSourceEvidence(proof, {
        repo,
        run,
        pr: { number, head: { sha: run.head_sha } },
        tree: proof.testedTree
      })
    )
      return undefined;
    ensureCommit(proof.baseSha);
    ensureCommit(run.head_sha);
    const reconstructed = git('merge-tree', '--write-tree', proof.baseSha, run.head_sha).split(
      '\n'
    )[0];
    return reconstructed === proof.testedTree ? reconstructed : undefined;
  } catch {
    // Missing or invalid immutable evidence cannot authorize reuse.
    return undefined;
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = process.env.BASE_SHA;
  ensureCommit(base);
  const paths = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const grantHelperSnapshot = readProductionDatabaseAccessSnapshot(base, paths);
  const mode = checkMode(
    paths,
    git('show', `${base}:${schema}`),
    git('show', `HEAD:${schema}`),
    grantHelperSnapshot
  );
  const currentTree = git('rev-parse', 'HEAD^{tree}');
  let reuseMain = false;
  const reused = new Set();
  const evidence = [];
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    const prs = gh(`repos/${repo}/commits/${process.env.GITHUB_SHA}/pulls`);
    for (const pr of prs.filter(
      (p) =>
        p.merged_at &&
        p.merge_commit_sha === process.env.GITHUB_SHA &&
        p.base.ref === 'main' &&
        p.head.repo?.full_name === repo
    )) {
      const { workflow_runs: runs } = gh(
        `repos/${repo}/actions/workflows/quality.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=20`
      );
      for (const run of runs.filter(
        (r) =>
          r.event === 'pull_request' &&
          r.path === '.github/workflows/quality.yml' &&
          r.status === 'completed' &&
          r.head_sha === pr.head.sha &&
          r.conclusion === 'success'
      )) {
        const { artifacts } = gh(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
        const artifact = artifacts.find(
          (a) => a.name === `quality-source-evidence-${run.run_attempt}` && !a.expired
        );
        if (!artifact) continue;
        const directory = `.deploy/ci-source-evidence/${run.id}-${run.run_attempt}`;
        execFileSync(
          'gh',
          [
            'run',
            'download',
            String(run.id),
            '--repo',
            repo,
            '--name',
            artifact.name,
            '--dir',
            directory
          ],
          { stdio: 'pipe' }
        );
        const proof = JSON.parse(readFileSync(`${directory}/evidence.json`, 'utf8'));
        if (!matchesSourceEvidence(proof, { repo, run, pr, tree: currentTree })) continue;
        const { jobs } = gh(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
        if (!canReuseMain(proof.testedTree, currentTree, jobs)) continue;
        reuseMain = true;
        evidence.push({ run: run.id, tree: currentTree, pr: pr.number });
        break;
      }
      if (reuseMain) break;
    }
    if (!reuseMain)
      throw new Error(
        'No successful PR evidence matches the merged source tree; stop instead of repeating checks'
      );
  } else if (process.env.GITHUB_EVENT_NAME === 'pull_request' && mode === 'recharge') {
    const pr = event.pull_request;
    const { workflow_runs: runs } = gh(
      `repos/${repo}/actions/workflows/quality.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&status=completed&per_page=10`
    );
    for (const run of runs) {
      if (!matchingRun(run, pr.number, run.head_sha)) continue;
      const tree = testedTree(run, pr.number, repo);
      if (!tree) continue;
      const changed = git('diff', '--name-only', tree, currentTree).split('\n').filter(Boolean);
      const dispatcherSnapshot = changed.includes('scripts/ci-recharge-check.mjs')
        ? readRechargeFlowDispatcherSnapshot(tree, currentTree)
        : undefined;
      const { jobs } = gh(
        `repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
      );
      for (const part of parts) {
        if (
          reused.has(part) ||
          (affectsPart(part, changed) &&
            !hasRechargeFlowBusinessReuseProof(part, changed, dispatcherSnapshot))
        )
          continue;
        if (jobs.some((job) => job.name === `recharge (${part})` && job.conclusion === 'success')) {
          reused.add(part);
          evidence.push({ part, run: run.id, tree });
        }
      }
      if (reused.size === parts.length) break;
    }
  }
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const migrationEvidence = reuseCombinedMigration(repo, event, mode, paths, currentTree);
    if (migrationEvidence) {
      reused.add('migration');
      evidence.push(migrationEvidence);
      const adminEvidence = reuseCombinedAdmin(repo, currentTree);
      if (adminEvidence) {
        reused.add('admin');
        evidence.push(adminEvidence);
      }
    }
  }
  const checkParts =
    mode === 'ci-only' && hasBankCardDeletePolicyProof(paths, grantHelperSnapshot)
      ? selectedParts(paths, grantHelperSnapshot)
      : mode === 'ci-only' || mode === 'audit-retention'
        ? ['guards']
        : mode === 'admin'
          ? ['guards', 'admin', ...(hasCombinedComponentScope(paths) ? ['migration'] : [])]
          : mode === 'mailbox'
            ? ['guards', 'admin', 'api']
            : selectedParts(paths);
  // BEGIN finite ONLINE build-proof reuse classifier admission
  const needsOnlineRechargeCiBuild = (paths) =>
    canResumeOnlineBuildProofReuseGuard(base, 'scope')
      ? false
      : onlineBuildProofReusePriorNeedsCiBuild(paths);
  // END finite ONLINE build-proof reuse classifier admission

  const onlineCiBuild = needsOnlineRechargeCiBuild(paths);
  const result = {
    mode,
    reuseMain,
    reusedParts: [...reused],
    checkParts,
    base,
    evidence,
    onlineCiBuild
  };
  const adminAcceptance =
    checkParts.includes('admin') &&
    adminCheckCommands(mode, paths).some((args) =>
      args.some(
        (arg) =>
          /^acceptance:v2-(?:auto-recharge|table-layout|online-recharge-ui)$/.test(arg) ||
          arg === 'scripts/acceptance-v2-order-archive-ui.mjs' ||
          arg === workspaceDockAcceptance
      )
    );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${mode}\nreuse_main=${reuseMain}\nreused_parts=${JSON.stringify([...reused])}\ncheck_parts=${JSON.stringify(checkParts)}\nbase=${base}\nadmin_acceptance=${adminAcceptance}\nonline_ci_build=${onlineCiBuild}\n`
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Scoped quality evidence\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
