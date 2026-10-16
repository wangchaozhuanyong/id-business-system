import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// One forward-only browser withdrawal, bound to its exact reviewed ancestor.
export const registrationProtocolRestoreBase = '123ea34df9bf74a1d65e74bd70f336eaa9344165';
export const registrationProtocolRestoreTree = 'ea208f5e571ab6da0dd6c82a8bf46b4d99e42b98';
export const registrationProtocolRestorePaths = Object.freeze([
  '.github/workflows/quality.yml',
  '.github/workflows/registration-protocol-restore-validation.yml',
  'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
  'apps/admin/src/v2/features/auto-registration/api.ts',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts',
  'apps/admin/src/v2/features/auto-registration/browser-connector.spec.ts',
  'apps/admin/src/v2/features/auto-registration/browser-connector.ts',
  'apps/admin/src/v2/features/auto-registration/browser-registration-presentation.spec.ts',
  'apps/admin/src/v2/features/auto-registration/contracts.ts',
  'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.spec.ts',
  'apps/admin/src/v2/features/auto-registration/useAppleMailboxes.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.controller.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.module.ts',
  'apps/api/src/id-business-v2/auto-registration/auto-registration.service.ts',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.controller.ts',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.service.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.service.ts',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_browser_registration.py',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py',
  'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_connector.py',
  'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_flow.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_apple_browser_registration_unit.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_connector.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_contract_unit.py',
  'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py',
  'apps/api/src/id-business-v2/auto-registration/worker/workspace.py',
  'docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md',
  'docs/V2_TASKS.md',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-registration-protocol-restore-scope.mjs',
  'scripts/ci-registration-protocol-restore-scope.test.mjs',
  'scripts/production-release/registration-protocol-restore-build.py',
  'scripts/production-release/registration-protocol-restore-contract.json',
  'scripts/production-release/registration-protocol-restore-dispatch.py',
  'scripts/production-release/registration-protocol-restore-release.py',
  'scripts/production-release/registration-protocol-restore-release.test.py',
  'scripts/start-auto-registration-connector.sh'
]);
export const registrationProtocolRestoreRemovedSources = Object.freeze({
  'apps/admin/src/v2/features/auto-registration/browser-connector.spec.ts':
    '62a5e3d3d5385f6731ab9100818f604548e793dd225b146da2763c678a111eda',
  'apps/admin/src/v2/features/auto-registration/browser-connector.ts':
    'b47b61493e3fa1e5df2ff42b69a958187fbcab1d415ebb4c8e72907f5aefe13a',
  'apps/admin/src/v2/features/auto-registration/browser-registration-presentation.spec.ts':
    '66f50973d2d4be20b6c3c3d158805dbaeae0a1de057690c0652fc642dd1e9957',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.controller.ts':
    'd91743cde3dfb79ceb3395e70a2dbf2f601248c3471c4fd9353cc763a8629381',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.service.spec.ts':
    '5f4370d9b4d47097fae752fcc1e4ad1988d82da7e9eded5c094384e7359fcb21',
  'apps/api/src/id-business-v2/auto-registration/browser-registration.service.ts':
    'd1c886ed9ae00ea17207ab2f864d635152e9164c1ef0e9ad0125c5eaba7092cf',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_browser_registration.py':
    '015a7220545a0888a732c7ec1ef4a02d6a410b852cd8b4bf0db0da66604eb853',
  'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_connector.py':
    '2f92676a00dfeb67d7fd6a8cbea1fb5d6703099ef8c466a7090486bd5143bf04',
  'apps/api/src/id-business-v2/auto-registration/worker/browser_registration_flow.py':
    '8cd35491feb76f4c670ac1d26ed5c3c9b6a11ad88fb4664eea72d7930c9ae814',
  'apps/api/src/id-business-v2/auto-registration/worker/test_apple_browser_registration_unit.py':
    '13e9268aefbe81f1bfc520f827eaf3bd2d1361033f52e490f3702d44f5fffcc2',
  'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_connector.py':
    'b85a7ee0ec6492da86f88f718dfa9e7cacc6977aa6467beff6ff3fdb18d0222f',
  'apps/api/src/id-business-v2/auto-registration/worker/test_browser_registration_contract_unit.py':
    'db76c432ce2997d0a4aba12ddab27e28c4a4ab1620a6103de8c7e8ff9424b598',
  'docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md':
    '55f680d1192c5265bd82f1291497853d27c11c486d2766ebf60dbef403fc29dc',
  'scripts/start-auto-registration-connector.sh':
    'bc37cb8a767c2fbc37ae29919c58968aaa38c771021157553f63c54681ac2104'
});
const retainedPaths = registrationProtocolRestorePaths.filter(
  (name) => !(name in registrationProtocolRestoreRemovedSources)
);
const formatted = retainedPaths.filter((name) => /\.(?:[cm]?js|json|yml|md|ts|vue)$/.test(name));
const linted = formatted.filter((name) => /\.(?:[cm]?js|ts|vue)$/.test(name));
export const registrationProtocolRestoreCommands = Object.freeze({
  guards: [
    ['python3', '-B', 'scripts/production-release/registration-protocol-restore-release.test.py'],
    [
      'node',
      '--test',
      'scripts/ci-registration-protocol-restore-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ],
    ['npm', 'exec', '--', 'prettier', '--check', ...formatted],
    ['npm', 'exec', '--', 'eslint', ...linted],
    ...[
      'admin-ui',
      'v2-ui-language',
      'v2-color-contrast',
      'v2-table-standard',
      'v2-loading-standard',
      'v2-module-architecture',
      'v2-isolation'
    ].map((name) => ['npm', 'run', 'check:' + name])
  ],
  api: [
    [
      'python3',
      '-B',
      'scripts/production-release/registration-protocol-restore-build.py',
      'check-api'
    ]
  ],
  admin: [
    [
      'python3',
      '-B',
      'scripts/production-release/registration-protocol-restore-build.py',
      'check-admin'
    ]
  ]
});

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const localDigest = (name) => {
  try {
    const path = new URL('../' + name, import.meta.url);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected source type');
    return hash(readFileSync(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const ancestorDigest = (name) =>
  hash(
    execFileSync('git', ['show', registrationProtocolRestoreBase + ':' + name], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  );

const equalSet = (a, b) =>
  Array.isArray(a) &&
  a.length === new Set(a).size &&
  a.length === b.length &&
  a.every((name) => b.includes(name));
const sameMap = (a, b) =>
  a &&
  typeof a === 'object' &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([name, value]) => a[name] === value);

export function isRegistrationProtocolRestoreOnly(paths, options = {}) {
  const { base, baseTree, sourceDigest = localDigest, baseSourceDigest = ancestorDigest } = options;
  let c;
  try {
    c =
      options.contract ??
      JSON.parse(
        readFileSync(
          new URL(
            './production-release/registration-protocol-restore-contract.json',
            import.meta.url
          ),
          'utf8'
        )
      );
  } catch {
    return false;
  }
  if (
    base !== registrationProtocolRestoreBase ||
    baseTree !== registrationProtocolRestoreTree ||
    !equalSet(paths, registrationProtocolRestorePaths) ||
    typeof sourceDigest !== 'function' ||
    typeof baseSourceDigest !== 'function' ||
    c?.version !== 1 ||
    c.frozen !== true ||
    c.scope !== 'REGISTRATION_PROTOCOL_RESTORE' ||
    c.migration !== null ||
    c.expectedCurrent !== '1c339754507f29459d17d75bb84afbee8fba5291' ||
    c.schemaSha256 !== '51a4d25b1302458145f560acc32f25b89a7bd65fea64dc72b254dc56da430100' ||
    c.runtimeEvidence?.status !== 'VERIFIED' ||
    c.runtimeEvidence.commit !== c.expectedCurrent ||
    c.sourceBaseline !== base ||
    c.sourceBaselineTree !== baseTree ||
    !equalSet(c.expectedGitChanges, registrationProtocolRestorePaths) ||
    !sameMap(c.withdrawal?.sourceRemovals, registrationProtocolRestoreRemovedSources)
  )
    return false;
  const reviewed = c.reviewedFileHashes;
  const removed = Object.keys(registrationProtocolRestoreRemovedSources);
  const retained = registrationProtocolRestorePaths.filter(
    (name) =>
      !removed.includes(name) &&
      name !== 'scripts/production-release/registration-protocol-restore-contract.json'
  );
  if (!reviewed || !equalSet(Object.keys(reviewed), retained)) return false;
  try {
    return (
      retained.every(
        (name) => /^[a-f0-9]{64}$/.test(reviewed[name]) && sourceDigest(name) === reviewed[name]
      ) &&
      removed.every(
        (name) =>
          sourceDigest(name) === null &&
          baseSourceDigest(name) === registrationProtocolRestoreRemovedSources[name]
      )
    );
  } catch {
    return false;
  }
}
