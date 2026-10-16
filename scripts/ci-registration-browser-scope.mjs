import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const registrationBrowserBase = 'eb4b0384c695ee6f6d650b3168c1ced0f0964b63';
export const registrationBrowserTree = '1c8c6f63335e17ad8e6e45a38a299e3d3e2cee43';
export const registrationBrowserCurrent = '6fc99d23c2918280a94c3f5b8be48f638190e02f';
export const registrationBrowserWorker = 'apps/api/src/id-business-v2/auto-registration/worker';
export const registrationBrowserApplications = Object.freeze([
  ...[
    'V2AppleMailboxes.vue',
    'api.ts',
    'apple-mailbox-presentation.ts',
    'browser-connector.spec.ts',
    'browser-connector.ts',
    'browser-registration-presentation.spec.ts',
    'contracts.ts',
    'useAppleMailboxes.spec.ts',
    'useAppleMailboxes.ts'
  ].map((name) => 'apps/admin/src/v2/features/auto-registration/' + name),
  ...[
    'apple-mailboxes.controller.ts',
    'apple-mailboxes.service.ts',
    'apple-mailboxes.types.ts',
    'auto-registration.module.ts',
    'auto-registration.service.ts',
    'browser-registration.controller.ts',
    'browser-registration.service.spec.ts',
    'browser-registration.service.ts'
  ].map((name) => 'apps/api/src/id-business-v2/auto-registration/' + name),
  ...[
    'apple_browser_registration.py',
    'apple_mailboxes.py',
    'browser_registration_connector.py',
    'browser_registration_flow.py',
    'release_safety.py',
    'test_apple_browser_registration_unit.py',
    'test_browser_registration_connector.py',
    'test_browser_registration_contract_unit.py',
    'workspace.py'
  ].map((name) => registrationBrowserWorker + '/' + name),
  'docs/AUTO_REGISTRATION_BROWSER_CONNECTOR.md',
  'scripts/start-auto-registration-connector.sh'
]);
export const registrationBrowserContract =
  'scripts/production-release/registration-browser-contract.json';
export const registrationBrowserControls = Object.freeze([
  ...['build.py', 'release.py', 'dispatch.py', 'contract.json', 'release.test.py'].map(
    (name) => 'scripts/production-release/registration-browser-' + name
  ),
  '.github/workflows/registration-browser-validation.yml',
  'scripts/ci-registration-browser-scope.mjs',
  'scripts/ci-registration-browser-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/V2_TASKS.md'
]);
export const registrationBrowserAcceptance = 'scripts/acceptance-v2-registration-browser.mjs';
export const registrationBrowserPaths = Object.freeze([
  ...registrationBrowserApplications,
  ...registrationBrowserControls,
  registrationBrowserAcceptance
]);
export const registrationBrowserReviewedPaths = Object.freeze([...registrationBrowserPaths]);
export const registrationBrowserParts = Object.freeze([
  'guards',
  'api',
  'admin',
  'release-controls'
]);
export const registrationBrowserPythonTests = Object.freeze([
  'test_flow_evidence.py',
  'test_registration_parity_unit.py',
  'test_registration_closed_loop_unit.py',
  'test_workspace.py',
  'test_apple_mailboxes.py',
  'test_release_safety.py',
  'test_upload_compat.py',
  'test_apple_browser_registration_unit.py',
  'test_browser_registration_connector.py',
  'test_browser_registration_contract_unit.py'
]);
const sameKeys = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((name) => right.includes(name));
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function isRegistrationBrowserOnly(
  paths,
  {
    base = registrationBrowserBase,
    baseTree = registrationBrowserTree,
    sourceDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
    contract
  } = {}
) {
  try {
    const value = contract ?? JSON.parse(readFileSync(registrationBrowserContract, 'utf8'));
    if (
      base !== registrationBrowserBase ||
      baseTree !== registrationBrowserTree ||
      !sameKeys(paths, registrationBrowserPaths) ||
      !object(value) ||
      value.version !== 1 ||
      value.frozen !== true ||
      value.scope !== 'REGISTRATION_BROWSER' ||
      value.sourceBaseline !== registrationBrowserBase ||
      value.sourceBaselineTree !== registrationBrowserTree ||
      value.expectedCurrent !== registrationBrowserCurrent ||
      value.migration !== null ||
      !sameKeys(value.expectedGitChanges, registrationBrowserReviewedPaths) ||
      !sameKeys(value.sourceDeltaPaths, registrationBrowserPaths) ||
      !sameKeys(value.allowedApplicationPaths, registrationBrowserApplications) ||
      !sameKeys(value.controlPaths, registrationBrowserControls) ||
      !object(value.sources) ||
      !sameKeys(Object.keys(value.sources), registrationBrowserApplications) ||
      !object(value.validationSources) ||
      !sameKeys(Object.keys(value.validationSources), [registrationBrowserAcceptance]) ||
      !object(value.reviewedFileHashes)
    )
      return false;
    const pinned = registrationBrowserReviewedPaths.filter(
      (name) => name !== registrationBrowserContract
    );
    return (
      sameKeys(Object.keys(value.reviewedFileHashes), pinned) &&
      Object.entries({ ...value.sources, ...value.validationSources }).every(
        ([name, digest]) => digest === value.reviewedFileHashes[name]
      ) &&
      pinned.every(
        (name) =>
          /^[a-f0-9]{64}$/.test(value.reviewedFileHashes[name]) &&
          sourceDigest(name) === value.reviewedFileHashes[name]
      )
    );
  } catch {
    return false;
  }
}

export function registrationBrowserCommands(part, paths) {
  if (!registrationBrowserParts.includes(part))
    throw new Error('Unsupported registration browser check part');
  if (part === 'guards' || part === 'release-controls') {
    const formatted = paths.filter((name) => /\.(?:[cm]?js|json|yml|md|ts|vue|css)$/.test(name));
    const linted = paths.filter((name) => /\.(?:[cm]?js|ts|vue)$/.test(name));
    return [
      ...(part === 'release-controls'
        ? [['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']]
        : []),
      ['python3', '-B', 'scripts/production-release/registration-browser-release.test.py'],
      ['node', '--test', 'scripts/ci-registration-browser-scope.test.mjs'],
      [
        'node',
        '--test',
        '--test-name-pattern=registration browser',
        'scripts/ci-recharge-scope.test.mjs',
        'scripts/ci-recharge-check.test.mjs'
      ],
      ...(formatted.length ? [['npm', 'exec', '--', 'prettier', '--check', ...formatted]] : []),
      ...(linted.length ? [['npm', 'exec', '--', 'eslint', ...linted]] : []),
      ...[
        'admin-ui',
        'v2-ui-language',
        'v2-color-contrast',
        'v2-table-standard',
        'v2-loading-standard',
        'v2-module-architecture',
        'v2-isolation'
      ].map((name) => ['npm', 'run', 'check:' + name])
    ];
  }
  const workspace = part === 'api' ? '@apple-business/api' : '@apple-business/admin';
  const python = resolve('.runtime/auto-registration/venv/bin/python');
  return [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'run', 'prisma:mysql:generate'],
    ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
    ['npm', 'run', 'typecheck', '--workspace', workspace],
    [
      'npm',
      'run',
      'test',
      '--workspace',
      workspace,
      '--',
      part === 'api' ? 'src/id-business-v2/auto-registration' : 'src/v2/features/auto-registration'
    ],
    ['npm', 'run', 'build', '--workspace', workspace],
    ['npm', 'run', 'auto-registration:setup'],
    ...(part === 'api'
      ? [
          ...registrationBrowserPythonTests.map((name) => [
            python,
            '-B',
            '-m',
            'unittest',
            'discover',
            '-s',
            registrationBrowserWorker,
            '-p',
            name
          ]),
          ['node', '--test', registrationBrowserWorker + '/test_payment_browser.mjs']
        ]
      : [
          ['npm', 'exec', '--', 'playwright', 'install', '--with-deps', 'chromium'],
          ['node', registrationBrowserAcceptance, '--python=' + python]
        ])
  ];
}
