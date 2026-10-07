import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const gates = [
  'check:v2-module-architecture',
  'check:v2-prisma-runtime-boundary',
  'check:v2-concurrency-standard'
];

function recordGuardCommands(mode, paths) {
  // Run the real dispatcher with process execution replaced before its named import resolves.
  // No Git command, nested test, database command or business operation is executed.
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const paths = JSON.parse(process.env.GUARD_TEST_PATHS);
    const calls = [];
    childProcess.execFileSync = (file, args) => {
      if (file === 'git') return paths.join('\\n');
      calls.push([file, ...args]);
      return '';
    };
    syncBuiltinESMExports();
    process.argv = ['node', 'scripts/ci-recharge-check.mjs', 'guards', 'a'.repeat(40)];
    await import('./scripts/ci-recharge-check.mjs');
    process.stdout.write(JSON.stringify(calls));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CHECK_MODE: mode, GUARD_TEST_PATHS: JSON.stringify(paths) }
    })
  );
}

test('real scoped dispatcher executes backend guards once without frontend edits, including deletion', () => {
  for (const [mode, paths] of [
    ['recharge', ['apps/api/src/id-business-v2/auto-recharge/recharge.service.ts']],
    [
      'mailbox',
      ['apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts']
    ],
    ['recharge', ['apps/api/src/id-business-v2/auto-recharge/deleted.service.ts']],
    [
      'recharge',
      [
        'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts',
        'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts'
      ]
    ]
  ]) {
    const calls = recordGuardCommands(mode, paths);
    for (const gate of gates) {
      assert.equal(calls.filter((call) => call.join(' ') === `npm run ${gate}`).length, 1, gate);
    }
    assert.ok(calls.every((call) => !call.some((arg) => /(?:prisma:|acceptance:)/.test(arg))));
  }
});

test('CI-only control edits do not execute backend or business guards', () => {
  const calls = recordGuardCommands('ci-only', ['scripts/ci-recharge-scope.mjs']);
  for (const gate of gates) assert.ok(calls.every((call) => !call.includes(gate)));
});

test('full quality workflow includes each backend architecture gate', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/quality.yml', import.meta.url),
    'utf8'
  );
  const full = workflow.split('  full-quality:')[1].split('\n  recharge:')[0];
  for (const gate of gates) assert.ok(full.includes(`run: npm run ${gate}`), gate);
});
