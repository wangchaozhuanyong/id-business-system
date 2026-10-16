import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const registrationFlowEvidenceBase = '88bce5ab09d20cd303f1fdd5fe310cb0b42e1451';
export const registrationFlowEvidenceTree = '57a0d354276724e70945513c9db806919e245b09';
export const registrationFlowEvidenceRepairBase = '6ea8030f54ab7dd3698884ac350d2562cdff8a1e';
export const registrationFlowEvidenceRepairTree = 'f65ca1a419e3d82858c086e68ba85f26b83fd210';
export const registrationFlowEvidenceRepairPaths = Object.freeze([
  'scripts/production-release/registration-flow-evidence-build.py',
  'scripts/production-release/registration-flow-evidence-release.py',
  'scripts/production-release/registration-flow-evidence-contract.json',
  'scripts/production-release/registration-flow-evidence-release.test.py',
  'scripts/ci-registration-flow-evidence-scope.mjs',
  'scripts/ci-registration-flow-evidence-scope.test.mjs',
  'scripts/ci-recharge-scope.test.mjs'
]);
export const registrationFlowEvidenceWorker =
  'apps/api/src/id-business-v2/auto-registration/worker';
export const registrationFlowEvidenceSources = Object.freeze([
  'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts',
  'apps/admin/src/v2/features/auto-registration/contracts.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
  ...[
    'apple_mailboxes.py',
    'apple_registration_diagnostics.py',
    'flow_evidence.py',
    'release_safety.py',
    'id-workspace.js',
    'id-workspace.css'
  ].map((name) => registrationFlowEvidenceWorker + '/' + name)
]);
export const registrationFlowEvidenceTests = Object.freeze([
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.spec.ts',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.spec.ts',
  ...[
    'test_flow_evidence.py',
    'test_registration_closed_loop_unit.py',
    'test_apple_mailboxes.py'
  ].map((name) => registrationFlowEvidenceWorker + '/' + name)
]);
export const registrationFlowEvidenceControls = Object.freeze([
  '.github/workflows/registration-closure-validation.yml',
  'scripts/production-release/registration-closure-build.py',
  'scripts/production-release/registration-closure-dispatch.py',
  ...['build.py', 'release.py', 'dispatch.py', 'contract.json', 'release.test.py'].map(
    (name) => 'scripts/production-release/registration-flow-evidence-' + name
  )
]);
export const registrationFlowEvidenceAcceptance =
  'scripts/acceptance-v2-registration-flow-evidence.mjs';
export const registrationFlowEvidenceCiPaths = Object.freeze([
  'scripts/ci-registration-flow-evidence-scope.mjs',
  'scripts/ci-registration-flow-evidence-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);
export const registrationFlowEvidenceRequired = Object.freeze([
  ...registrationFlowEvidenceSources,
  ...registrationFlowEvidenceTests,
  ...registrationFlowEvidenceControls,
  registrationFlowEvidenceAcceptance
]);
export const registrationFlowEvidencePaths = Object.freeze([
  ...registrationFlowEvidenceRequired,
  ...registrationFlowEvidenceCiPaths,
  'docs/V2_TASKS.md',
  'docs/AUTO_REGISTRATION_FLOW_EVIDENCE_20261016.md'
]);
// Frozen after review. Changed inputs cannot silently enter a historical exception.
export const registrationFlowEvidencePins = Object.freeze({
  'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue':
    '02e301028cf6cf5cdc6d3ff2a469f315326e8274b06800a87c44d434ef7e6fd7',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.ts':
    '2b3ff8c58c90d18cde3d3298f2f5d7af14e3882cf0a6a34f3dd1054d46e581e4',
  'apps/admin/src/v2/features/auto-registration/contracts.ts':
    '66f36710063c4b08ac277aa4d4a2bea1d904d83b5632140b15582e5ebbcc78ee',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts':
    'e695405361bc47d5fdf78f4bf5cc4e70b2ef3785a610c4769990f3d3bd398cb9',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_mailboxes.py':
    '5cbe8f734aa3d06b4fa28ce228685e61f1333160f5eb8926ed687df52cf22605',
  'apps/api/src/id-business-v2/auto-registration/worker/apple_registration_diagnostics.py':
    'c325e7624eddadbf3a6c9d205de25e59d6086ec3b89d0b37e1da421fce72415c',
  'apps/api/src/id-business-v2/auto-registration/worker/flow_evidence.py':
    '90dec426984bbbca36e53d5a4f7aa4993d51164f69f8c0ac80e887ad2d47ec1c',
  'apps/api/src/id-business-v2/auto-registration/worker/release_safety.py':
    'acd390001c40c1635eb4d7e15b21b58fda51ca78c664ac6970c9b3cf00df7012',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js':
    'adeb28a21f337bb2f48d2569dbc1a293597ac2996cb5cf387604cf9879fa60f4',
  'apps/api/src/id-business-v2/auto-registration/worker/id-workspace.css':
    '8676e884447fa7cd43ecedc1b8986d0cb45747c53d3142f0b4bad7b68b7397ad',
  'apps/admin/src/v2/features/auto-registration/apple-mailbox-presentation.spec.ts':
    'edd247d2e4f3271388a3d14ece0ebbb250009938843d521b106c35a9ac60fdd1',
  'apps/api/src/id-business-v2/auto-registration/apple-mailboxes.service.spec.ts':
    'a766578ebbad1994d9a0f83ff121ac54a82628721fc7b468a83dca0624ae38f1',
  'apps/api/src/id-business-v2/auto-registration/worker/test_flow_evidence.py':
    '420ba7633825dd92dc42a9458bd86ad55972868beb8fefc6b9cc073b02f55a06',
  'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py':
    '662623a0c1159e46795e06dccd41ed1b08054c16417c2412449b84fa943442c9',
  'apps/api/src/id-business-v2/auto-registration/worker/test_apple_mailboxes.py':
    '85d6a556d54bcaed78adbad6fc7c606fbd5630ec0463eb44e397187587a52703',
  '.github/workflows/registration-closure-validation.yml':
    '8d2827fb60995538fb7ccda51e5a0577ad49ed46e1339f0a3c4775d9e79e245c',
  'scripts/production-release/registration-closure-build.py':
    '4b7e414e024ad8e6da78662aef19a514ba918d5213eac78c739feeb71e216a9c',
  'scripts/production-release/registration-closure-dispatch.py':
    '4ee050b81065c59f440351ad78ad19a7f0875650f485e29418cb3a76b51ad1d6',
  'scripts/production-release/registration-flow-evidence-build.py':
    '0c6b8a100faa02019003daa037acbae55fc5d80891ffb9ce13ef373d8b4a7925',
  'scripts/production-release/registration-flow-evidence-release.py':
    'f6243432411f637a648e19a728dc4e1744a9682553aecb252b15991c42e1a3f3',
  'scripts/production-release/registration-flow-evidence-dispatch.py':
    '8801f3de8d6749121ab60c7d8a108e9cb293e383c415114decdc92f4f7078f82',
  'scripts/production-release/registration-flow-evidence-contract.json':
    '9d5f34916800fb885cb8aabd98bb550900775f47f17d666c8ad40a26f65215ae',
  'scripts/production-release/registration-flow-evidence-release.test.py':
    '1b4cbee218cf1d41dd37e96cddc902bf8a75ae0e3879eb70375f13294e1861da',
  'scripts/acceptance-v2-registration-flow-evidence.mjs':
    '7bf536b5c9e65557682695adc331ff96af85a8da13fef3108b3fa9c79eb15417'
});

export function isRegistrationFlowEvidenceOnly(
  paths,
  {
    base = registrationFlowEvidenceBase,
    baseTree = registrationFlowEvidenceTree,
    sourceDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  } = {}
) {
  if (
    base !== registrationFlowEvidenceBase ||
    baseTree !== registrationFlowEvidenceTree ||
    !paths.length ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !registrationFlowEvidencePaths.includes(path)) ||
    registrationFlowEvidenceRequired.some((path) => !paths.includes(path)) ||
    Object.keys(registrationFlowEvidencePins).length !== registrationFlowEvidenceRequired.length
  )
    return false;
  try {
    return registrationFlowEvidenceRequired.every(
      (path) =>
        /^[a-f0-9]{64}$/.test(registrationFlowEvidencePins[path]) &&
        sourceDigest(path) === registrationFlowEvidencePins[path]
    );
  } catch {
    return false;
  }
}

// Native validation passed, but preflight found a published runtime successor.
// Bind only this publication baseline repair; every application and
// publication input must still match the reviewed freeze.
export function isRegistrationFlowEvidenceControlRepair(
  paths,
  { base, baseTree, sourceDigest } = {}
) {
  return (
    base === registrationFlowEvidenceRepairBase &&
    baseTree === registrationFlowEvidenceRepairTree &&
    paths.length === registrationFlowEvidenceRepairPaths.length &&
    new Set(paths).size === paths.length &&
    paths.every((path) => registrationFlowEvidenceRepairPaths.includes(path)) &&
    isRegistrationFlowEvidenceOnly(registrationFlowEvidenceRequired, { sourceDigest })
  );
}
