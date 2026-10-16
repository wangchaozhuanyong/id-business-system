import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  isRegistrationFlowEvidenceOnly,
  isRegistrationFlowEvidenceControlRepair,
  registrationFlowEvidenceRepairBase,
  registrationFlowEvidenceRepairTree,
  registrationFlowEvidenceRepairPaths,
  registrationFlowEvidenceBase,
  registrationFlowEvidenceTree,
  registrationFlowEvidencePins,
  registrationFlowEvidenceRequired,
  registrationFlowEvidencePaths,
  registrationFlowEvidenceSources,
  registrationFlowEvidenceControls,
  registrationFlowEvidenceWorker,
  registrationFlowEvidenceAcceptance
} from './ci-registration-flow-evidence-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

const context = {
  base: registrationFlowEvidenceBase,
  baseTree: registrationFlowEvidenceTree,
  sourceDigest: (path) => registrationFlowEvidencePins[path]
};
test('the published predecessor repair retains the application freeze and selects only controls', () => {
  const repair = {
    ...context,
    base: registrationFlowEvidenceRepairBase,
    baseTree: registrationFlowEvidenceRepairTree
  };
  const paths = registrationFlowEvidenceRepairPaths;
  assert.equal(isRegistrationFlowEvidenceControlRepair(paths, repair), true);
  assert.equal(checkMode(paths, 'same', 'same', undefined, repair), 'ci-only');
  assert.deepEqual(selectedParts(paths, undefined, repair), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(paths, repair), false);
  assert.equal(checkMode(paths, 'old', 'new', undefined, repair), 'full');
  for (const changed of [
    [...paths, registrationFlowEvidenceSources[0]],
    paths.slice(1),
    [...paths.slice(1), paths[1]]
  ])
    assert.equal(isRegistrationFlowEvidenceControlRepair(changed, repair), false);
  for (const drift of [
    { base: 'a'.repeat(40) },
    { baseTree: 'b'.repeat(40) },
    { sourceDigest: () => '0'.repeat(64) }
  ])
    assert.equal(isRegistrationFlowEvidenceControlRepair(paths, { ...repair, ...drift }), false);
});
test('the complete frozen application selects real API Admin and Worker checks', () => {
  assert.equal(
    Object.keys(registrationFlowEvidencePins).length,
    registrationFlowEvidenceRequired.length
  );
  assert.equal(isRegistrationFlowEvidenceOnly(registrationFlowEvidencePaths, context), true);
  assert.equal(
    checkMode(registrationFlowEvidencePaths, 'same', 'same', undefined, context),
    'recharge'
  );
  assert.deepEqual(selectedParts(registrationFlowEvidencePaths, undefined, context), [
    'guards',
    'api',
    'admin'
  ]);
  assert.equal(needsOnlineRechargeCiBuild(registrationFlowEvidencePaths, context), false);
  assert.equal(
    checkMode(registrationFlowEvidencePaths, 'before', 'after', undefined, context),
    'full'
  );
  assert.equal(isRegistrationFlowEvidenceOnly(registrationFlowEvidenceControls, context), false);
});
test('every source test publisher and baseline binding is mandatory', () => {
  for (const path of registrationFlowEvidenceRequired) {
    assert.equal(
      isRegistrationFlowEvidenceOnly(
        registrationFlowEvidencePaths.filter((item) => item !== path),
        context
      ),
      false,
      path
    );
    assert.equal(
      isRegistrationFlowEvidenceOnly(registrationFlowEvidencePaths, {
        ...context,
        sourceDigest: (item) => (item === path ? '0'.repeat(64) : context.sourceDigest(item))
      }),
      false,
      path
    );
  }
  for (const drift of [
    { base: 'a'.repeat(40) },
    { baseTree: 'b'.repeat(40) },
    {
      sourceDigest: () => {
        throw Error('missing blob');
      }
    }
  ])
    assert.equal(
      isRegistrationFlowEvidenceOnly(registrationFlowEvidencePaths, { ...context, ...drift }),
      false
    );
});
test('schema upstream credentials and unrelated applications cannot enter this release', () => {
  for (const path of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py',
    'apps/admin/src/auth/session.ts',
    '.env.aws.production',
    'package-lock.json',
    '.github/workflows/quality.yml'
  ])
    assert.equal(
      isRegistrationFlowEvidenceOnly([...registrationFlowEvidencePaths, path], context),
      false,
      path
    );
  assert.equal(isRegistrationFlowEvidenceOnly([], context), false);
  assert.equal(
    isRegistrationFlowEvidenceOnly(
      [...registrationFlowEvidencePaths, registrationFlowEvidencePaths[0]],
      context
    ),
    false
  );
  assert.ok(registrationFlowEvidenceSources.some((path) => path.endsWith('/flow_evidence.py')));
});

const root = fileURLToPath(new URL('..', import.meta.url));
const python = resolve(root, '.runtime/auto-registration/venv/bin/python');
const uiChecks = [
  'check:admin-ui',
  'check:v2-ui-language',
  'check:v2-color-contrast',
  'check:v2-table-standard',
  'check:v2-loading-standard',
  'check:v2-module-architecture',
  'check:v2-isolation'
];
const pythonSuites = [
  'test_flow_evidence.py',
  'test_registration_closed_loop_unit.py',
  'test_workspace.py',
  'test_apple_mailboxes.py',
  'test_release_safety.py',
  'test_upload_compat.py'
];

function recordDispatcher(part, options = {}) {
  // Exercise the real predicate and dispatcher with a synthetic pin map. This
  // verifies command selection independently of the pending release freeze.
  // All subprocess execution is replaced before the dispatcher's imports load.
  const runner = `
    import childProcess from 'node:child_process';
    import { createHash } from 'node:crypto';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const calls = [];
    const decisions = [];
    globalThis.flowEvidenceDecisions = decisions;
    const bytes = Buffer.from('flow-evidence-dispatcher-source-fixture\\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const fixturePins = Object.fromEntries(input.required.map(path => [path, digest]));
    const marker = /export const registrationFlowEvidencePins = Object\\.freeze\\(\\{[\\s\\S]*?\\}\\);/g;
    if ([...input.helper.matchAll(marker)].length !== 1)
      throw new Error('PIN_FIXTURE_ANCHOR_CHANGED');
    const helper = input.helper.replace(marker,
      'export const registrationFlowEvidencePins = Object.freeze(' + JSON.stringify(fixturePins) + ');'
    ).replace('export function isRegistrationFlowEvidenceOnly(', 'function actualPredicate(') +
      '\\nexport function isRegistrationFlowEvidenceOnly(...args) {' +
      'const result = actualPredicate(...args); globalThis.flowEvidenceDecisions.push(result); return result; }';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === './ci-registration-flow-evidence-scope.mjs' &&
          context.parentURL?.endsWith('/scripts/ci-recharge-check.mjs'))
        return { url: 'data:text/javascript,' + encodeURIComponent(helper), shortCircuit: true };
      return nextResolve(specifier, context);
    }});
    const originalRead = fs.readFileSync;
    const originalExists = fs.existsSync;
    fs.readFileSync = (path, ...args) => input.required.includes(String(path))
      ? (String(path) === input.driftSource ? Buffer.from('changed source') : bytes)
      : originalRead(path, ...args);
    fs.existsSync = path => input.paths.includes(String(path)) || originalExists(path);
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') {
        if (args[0] === 'diff') return input.paths.join('\\n');
        if (args[0] === 'rev-parse' && args[1] === input.base + '^{tree}') return input.tree;
        throw new Error('UNEXPECTED_GIT_READ');
      }
      const call = [file, ...args];
      calls.push(call);
      if (input.fallback) throw new Error('RECORDED_FALLBACK');
      if (call.join(' ') === input.failCommand) throw new Error('RECORDED_COMMAND_FAILURE');
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', input.part, input.base];
    process.exit = code => { calls.push(['process-exit', code]); throw new Error('RECORDED_EXIT'); };
    let outcome = 'fell_through';
    try { await import('./scripts/ci-recharge-check.mjs'); }
    catch (error) {
      const expected = ['RECORDED_EXIT', 'RECORDED_FALLBACK', 'RECORDED_COMMAND_FAILURE'];
      if (!expected.includes(error.message)) throw error;
      outcome = error.message;
    }
    process.stdout.write(JSON.stringify({ calls, decisions, outcome }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', runner], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify({
        part,
        base: registrationFlowEvidenceBase,
        tree: registrationFlowEvidenceTree,
        required: registrationFlowEvidenceRequired,
        paths: registrationFlowEvidencePaths,
        helper: readFileSync(
          new URL('./ci-registration-flow-evidence-scope.mjs', import.meta.url),
          'utf8'
        ),
        ...options
      }),
      env: {
        ...process.env,
        CHECK_MODE: options.mode || 'recharge',
        GITHUB_ACTIONS: '',
        GITHUB_REPOSITORY: '',
        GITHUB_EVENT_NAME: ''
      }
    })
  );
}

function successfulCalls(part) {
  const result = recordDispatcher(part);
  assert.equal(result.outcome, 'RECORDED_EXIT');
  assert.deepEqual(result.decisions, [true]);
  assert.deepEqual(result.calls.at(-1), ['process-exit', 0]);
  return result.calls.slice(0, -1);
}

test('dispatcher guards run publisher controls format lint and all seven UI rules', () => {
  const calls = successfulCalls('guards');
  assert.deepEqual(calls.slice(0, 2), [
    ['python3', '-B', 'scripts/production-release/registration-flow-evidence-release.test.py'],
    [
      'node',
      '--test',
      'scripts/ci-registration-flow-evidence-scope.test.mjs',
      'scripts/ci-recharge-scope.test.mjs',
      'scripts/ci-recharge-check.test.mjs'
    ]
  ]);
  const formatted = registrationFlowEvidencePaths.filter((path) =>
    /\.(?:[cm]?js|json|yml|md|ts|vue|css)$/.test(path)
  );
  const linted = registrationFlowEvidencePaths.filter((path) => /\.(?:[cm]?js|ts|vue)$/.test(path));
  assert.deepEqual(calls.slice(2), [
    ['npm', 'exec', '--', 'prettier', '--check', ...formatted],
    ['npm', 'exec', '--', 'eslint', ...linted],
    ...uiChecks.map((name) => ['npm', 'run', name])
  ]);
});

test('the published predecessor repair runs real control checks without repeating application checks', () => {
  const input = {
    mode: 'ci-only',
    base: registrationFlowEvidenceRepairBase,
    tree: registrationFlowEvidenceRepairTree,
    paths: registrationFlowEvidenceRepairPaths
  };
  const result = recordDispatcher('guards', input);
  assert.equal(result.outcome, 'RECORDED_EXIT');
  assert.deepEqual(result.calls[0], [
    'python3',
    '-B',
    'scripts/production-release/registration-flow-evidence-release.test.py'
  ]);
  assert.ok(result.calls[1].includes('scripts/ci-registration-flow-evidence-scope.test.mjs'));
  assert.ok(result.calls.some((call) => call.includes('prettier')));
  assert.ok(result.calls.some((call) => call.includes('eslint')));
  assert.equal(
    result.calls.some(
      (call) => call.includes('--workspace') || uiChecks.some((name) => call.includes(name))
    ),
    false
  );
  assert.deepEqual(result.calls.at(-1), ['process-exit', 0]);
  for (const drift of [
    { base: 'a'.repeat(40) },
    { tree: 'b'.repeat(40) },
    { driftSource: registrationFlowEvidenceSources[0] },
    { paths: [...input.paths, registrationFlowEvidenceSources[0]] }
  ]) {
    const rejected = recordDispatcher('guards', { ...input, ...drift, fallback: true });
    assert.equal(rejected.outcome, 'RECORDED_FALLBACK');
    assert.equal(
      rejected.decisions.every((value) => value === false),
      true
    );
  }
});

const workspaceCalls = (target) => [
  ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  ['npm', 'run', 'prisma:mysql:generate'],
  ['npm', 'run', 'build', '--workspace', '@apple-business/shared'],
  ['npm', 'run', 'typecheck', '--workspace', '@apple-business/' + target],
  [
    'npm',
    'run',
    'test',
    '--workspace',
    '@apple-business/' + target,
    '--',
    target === 'api' ? 'src/id-business-v2/auto-registration' : 'src/v2/features/auto-registration'
  ],
  ['npm', 'run', 'build', '--workspace', '@apple-business/' + target],
  ['npm', 'run', 'auto-registration:setup']
];

test('dispatcher API runs actual workspace checks and all six isolated Python suites', () => {
  assert.deepEqual(successfulCalls('api'), [
    ...workspaceCalls('api'),
    ...pythonSuites.map((name) => [
      python,
      '-B',
      '-m',
      'unittest',
      'discover',
      '-s',
      registrationFlowEvidenceWorker,
      '-p',
      name
    ]),
    ['node', '--test', registrationFlowEvidenceWorker + '/test_payment_browser.mjs'],
    [python, '-B', registrationFlowEvidenceWorker + '/acceptance_runtime.py']
  ]);
});

test('dispatcher Admin runs workspace checks and the isolated offline browser acceptance', () => {
  assert.deepEqual(successfulCalls('admin'), [
    ...workspaceCalls('admin'),
    ['npm', 'exec', '--', 'playwright', 'install', '--with-deps', 'chromium'],
    ['node', registrationFlowEvidenceAcceptance, '--python=' + python]
  ]);
});

test('dispatcher drift cannot enter the application shortcut', () => {
  const drifts = [
    { base: 'a'.repeat(40) },
    { tree: 'b'.repeat(40) },
    { driftSource: registrationFlowEvidenceSources[0] },
    { paths: [...registrationFlowEvidencePaths, 'apps/admin/src/auth/session.ts'] },
    {
      paths: registrationFlowEvidencePaths.filter(
        (path) => path !== registrationFlowEvidenceRequired[0]
      )
    }
  ];
  for (const part of ['guards', 'api', 'admin']) {
    for (const drift of drifts) {
      const result = recordDispatcher(part, { ...drift, fallback: true });
      assert.equal(result.outcome, 'RECORDED_FALLBACK', JSON.stringify({ part, drift }));
      assert.ok(result.decisions.every((accepted) => accepted === false));
      assert.equal(result.calls.length, 1);
      assert.notDeepEqual(result.calls[0], workspaceCalls(part)[0]);
      assert.notDeepEqual(result.calls[0], [
        'python3',
        '-B',
        'scripts/production-release/registration-flow-evidence-release.test.py'
      ]);
    }
  }
});

test('dispatcher failures stop before later tests and acceptance commands', () => {
  for (const part of ['guards', 'api', 'admin']) {
    const first = successfulCalls(part)[0];
    const result = recordDispatcher(part, { failCommand: first.join(' ') });
    assert.equal(result.outcome, 'RECORDED_COMMAND_FAILURE');
    assert.deepEqual(result.calls, [first]);
  }
  const failingSuite = [
    python,
    '-B',
    '-m',
    'unittest',
    'discover',
    '-s',
    registrationFlowEvidenceWorker,
    '-p',
    pythonSuites[0]
  ];
  const result = recordDispatcher('api', { failCommand: failingSuite.join(' ') });
  assert.equal(result.outcome, 'RECORDED_COMMAND_FAILURE');
  assert.deepEqual(result.calls, [...workspaceCalls('api'), failingSuite]);
});
