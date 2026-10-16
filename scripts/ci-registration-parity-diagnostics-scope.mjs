import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const registrationParityDiagnosticsBase = 'c0238525bb4b2a1c3fe6688eaed5f74f504ee529';
export const registrationParityDiagnosticsTree = '1f71d02270d8f1a78303fa35320223b02ab3dfb0';
export const registrationParityDiagnosticsCurrent = 'c0238525bb4b2a1c3fe6688eaed5f74f504ee529';
export const registrationParityDiagnosticsRepairBase = registrationParityDiagnosticsBase;
export const registrationParityDiagnosticsRepairTree = registrationParityDiagnosticsTree;
export const registrationParityDiagnosticsRepairPaths = Object.freeze([
  'scripts/production-release/registration-parity-diagnostics-build.py',
  'scripts/production-release/registration-parity-diagnostics-release.py',
  'scripts/production-release/registration-parity-diagnostics-dispatch.py',
  'scripts/production-release/registration-parity-diagnostics-release.test.py',
  'scripts/production-release/registration-parity-diagnostics-contract.json',
  'scripts/ci-registration-parity-diagnostics-scope.mjs',
  'scripts/ci-registration-parity-diagnostics-scope.test.mjs',
  'docs/AUTO_REGISTRATION_PARITY_20261016.md',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'scripts/ci-recharge-scope.test.mjs'
]);
export const registrationParityDiagnosticsWorker =
  'apps/api/src/id-business-v2/auto-registration/worker';
export const registrationParityDiagnosticsApplications = Object.freeze([
  ...['apple-mailbox-presentation.spec.ts', 'apple-mailbox-presentation.ts', 'contracts.ts'].map(
    (name) => 'apps/admin/src/v2/features/auto-registration/' + name
  ),
  ...['apple-mailboxes.types.ts', 'apple-mailboxes.service.spec.ts'].map(
    (name) => 'apps/api/src/id-business-v2/auto-registration/' + name
  ),
  ...[
    'apple_mailboxes.py',
    'flow_evidence.py',
    'release_safety.py',
    'id-workspace.js',
    'test_flow_evidence.py',
    'test_registration_parity_unit.py',
    'test_apple_mailboxes.py',
    'test_release_safety.py'
  ].map((name) => registrationParityDiagnosticsWorker + '/' + name)
]);
export const registrationParityDiagnosticsAcceptance =
  'scripts/acceptance-v2-registration-parity-diagnostics.mjs';
export const registrationParityDiagnosticsContract =
  'scripts/production-release/registration-parity-diagnostics-contract.json';
export const registrationParityDiagnosticsControls = Object.freeze([
  ...['build.py', 'release.py', 'dispatch.py', 'contract.json', 'release.test.py'].map(
    (name) => 'scripts/production-release/registration-parity-diagnostics-' + name
  ),
  'scripts/ci-registration-parity-diagnostics-scope.mjs',
  'scripts/ci-registration-parity-diagnostics-scope.test.mjs',
  '.github/workflows/registration-parity-diagnostics-validation.yml',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/AUTO_REGISTRATION_PARITY_20261016.md',
  'docs/V2_TASKS.md'
]);
export const registrationParityDiagnosticsPaths = Object.freeze([
  ...registrationParityDiagnosticsApplications,
  registrationParityDiagnosticsAcceptance,
  ...registrationParityDiagnosticsControls
]);
export const registrationParityDiagnosticsParts = Object.freeze([
  'guards',
  'api',
  'admin',
  'release-controls'
]);

const sameKeys = (left, right) =>
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((name) => right.includes(name));
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** This is a new reviewed exception. Historical flow-evidence pins remain immutable. */
export function isRegistrationParityDiagnosticsOnly(
  paths,
  {
    base = registrationParityDiagnosticsBase,
    baseTree = registrationParityDiagnosticsTree,
    sourceDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
    contract
  } = {}
) {
  try {
    const value =
      contract ?? JSON.parse(readFileSync(registrationParityDiagnosticsContract, 'utf8'));
    if (
      !Array.isArray(paths) ||
      base !== registrationParityDiagnosticsBase ||
      baseTree !== registrationParityDiagnosticsTree ||
      !sameKeys(paths, registrationParityDiagnosticsPaths) ||
      !object(value) ||
      value.frozen !== true ||
      value.scope !== 'REGISTRATION_PARITY_DIAGNOSTICS' ||
      value.sourceBaseline !== registrationParityDiagnosticsBase ||
      value.sourceBaselineTree !== registrationParityDiagnosticsTree ||
      value.expectedCurrent !== registrationParityDiagnosticsCurrent ||
      value.migration !== null ||
      !sameKeys(value.expectedGitChanges ?? [], paths) ||
      !sameKeys(value.sourceDeltaPaths ?? [], registrationParityDiagnosticsRepairPaths) ||
      !sameKeys(value.allowedApplicationPaths ?? [], registrationParityDiagnosticsApplications) ||
      !sameKeys(value.controlPaths ?? [], registrationParityDiagnosticsControls) ||
      !object(value.sources) ||
      !sameKeys(Object.keys(value.sources), registrationParityDiagnosticsApplications) ||
      !object(value.validationSources) ||
      !sameKeys(Object.keys(value.validationSources), [registrationParityDiagnosticsAcceptance]) ||
      !object(value.reviewedFileHashes)
    )
      return false;
    const pinnedPaths = paths.filter((name) => name !== registrationParityDiagnosticsContract);
    if (!sameKeys(Object.keys(value.reviewedFileHashes), pinnedPaths)) return false;
    return (
      Object.entries({ ...value.sources, ...value.validationSources }).every(
        ([name, digest]) => digest === value.reviewedFileHashes[name]
      ) &&
      pinnedPaths.every(
        (name) =>
          /^[a-f0-9]{64}$/.test(value.reviewedFileHashes[name]) &&
          sourceDigest(name) === value.reviewedFileHashes[name]
      )
    );
  } catch {
    return false;
  }
}

/** Successor repair may change only these controls; the entire application stays frozen. */
export function isRegistrationParityDiagnosticsControlRepair(
  paths,
  { base, baseTree, sourceDigest, contract } = {}
) {
  return (
    Array.isArray(paths) &&
    base === registrationParityDiagnosticsRepairBase &&
    baseTree === registrationParityDiagnosticsRepairTree &&
    sameKeys(paths, registrationParityDiagnosticsRepairPaths) &&
    isRegistrationParityDiagnosticsOnly(registrationParityDiagnosticsPaths, {
      sourceDigest,
      contract
    })
  );
}
