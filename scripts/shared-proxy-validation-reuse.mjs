// Reuse only native evidence for the exact unchanged publication inputs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const previous = '805413b51209a5b81d5b2a37e2c7b7a1f56f0585';
const runId = '38743515685';
const repository = 'wangchaozhuanyong/id-business-system';
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_REPOSITORY, repository);
const changed = command('git', ['diff', '--name-only', previous, 'HEAD']).split('\n');
const controls = new Set([
  'scripts/shared-proxy-publication.mjs',
  'apps/admin/src/v2/features/auto-recharge/RechargeResult.vue',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-login.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-login.ts',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-login-page.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-presentation.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/recharge-presentation.ts',
  'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.spec.ts',
  'apps/admin/src/v2/features/auto-recharge/useBitBrowserDirectOpen.ts',

  '.github/workflows/shared-proxy-pool-validation.yml',
  'scripts/shared-proxy-validation-reuse.mjs',
  'scripts/acceptance-v2-online-recharge-ui.mjs',
  'scripts/acceptance-v2-recharge-proxies-ui.mjs',
  'scripts/acceptance-v2-auto-recharge.mjs',
  'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json'
]);
assert.ok(changed.length > 0 && changed.every((path) => controls.has(path)));
assert.ok(command('git', ['merge-base', '--is-ancestor', previous, 'HEAD']) === '');
const get = (endpoint) => JSON.parse(command('gh', ['api', `repos/${repository}/${endpoint}`]));
const run = get(`actions/runs/${runId}`);
assert.equal(run.head_sha, previous);
assert.equal(run.status, 'completed');
assert.equal(run.name, 'Shared Proxy Pool Publication Validation');
const jobs = get(`actions/runs/${runId}/jobs?per_page=100`).jobs;
assert.equal(jobs.length, 1);
assert.equal(jobs[0].name, 'validate');
for (const name of [
  'Run npm run typecheck && npm run build',
  'Verify the seven V2 controls and affected source',
  'Verify both recharge systems and the shared pool',
  'Verify real migrations and repository operations on owned empty MySQL'
]) {
  const matches = jobs[0].steps.filter((step) => step.name === name);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].conclusion, 'success');
}
const directory = resolve('.runtime/shared-proxy-validation-reuse');
mkdirSync(directory, { recursive: true });
command('gh', [
  'run',
  'download',
  runId,
  '--repo',
  repository,
  '--name',
  `shared-proxy-publication-${previous}`,
  '--dir',
  directory
]);
const ui = JSON.parse(readFileSync(resolve(directory, 'shared-proxy-pool-ui/result.json')));
assert.equal(ui.ok, true);
assert.deepEqual(ui.widths, [1440, 1024, 901, 900, 768, 390]);
assert.deepEqual(ui.themes, ['light', 'dark']);
assert.ok(ui.states.includes('metadata-draft-restored-sensitive-input-cleared'));
const output = resolve('.runtime/shared-proxy-release');
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'reused-native-evidence.json'),
  JSON.stringify(
    {
      runId,
      source: previous,
      commit: command('git', ['rev-parse', 'HEAD']),
      changedControls: changed,
      jobs,
      sharedPoolUi: ui,
      url: run.html_url,
      businessSourceChanged: true,
      affectedBusinessChecks: ['engine/task-runner.cjs - targeted engine tests required']
    },
    null,
    2
  ) + '\n'
);
appendFileSync(process.env.GITHUB_OUTPUT, 'verified=true\n');
console.log(`Reused unchanged business inputs, database and shared-pool UI: ${run.html_url}`);
