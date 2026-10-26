export const mailboxProviderSources = [
  'apps/admin/src/v2/components/workspace/V2ManagedMailboxPanel.vue',
  'apps/admin/src/v2/components/workspace/V2ManagedMailboxBatchDrawer.vue',
  'apps/admin/src/v2/components/workspace/managedMailboxProvider.ts',
  'apps/admin/src/v2/components/workspace/managedMailboxProviderFlow.spec.ts'
];
export const mailboxProviderControls = [
  '.github/workflows/mailbox-provider-publication.yml',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-mailbox-provider-scope.mjs',
  'scripts/ci-mailbox-provider-scope.test.mjs',
  'scripts/production-release/mailbox-provider-release.py',
  'scripts/production-release/mailbox-provider-publication.py',
  'scripts/production-release/mailbox-provider-build.py',
  'scripts/production-release/mailbox-provider-release.test.py',
  'scripts/production-release/mailbox-provider-contract.json',
  'docs/MAILBOX_PROVIDER_RELEASE_20261026.md'
];
export function isMailboxProviderOnly(paths) {
  const allowed = [...mailboxProviderSources, ...mailboxProviderControls];
  return (
    paths.length === allowed.length &&
    new Set(paths).size === paths.length &&
    allowed.every((name) => paths.includes(name))
  );
}
