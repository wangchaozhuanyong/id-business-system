import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const PREVIEW_BRANCH = 'refs/heads/codex/interaction-preview-20261103';
export const PREVIEW_BASE = '1cd5045d811b8ce3d5f87dd9fc1182a0f787d1ea';
export const PRIOR_PREVIEW_COMMIT = '1d0bed0d367f4ef8f9848833c4665729e16a5ddc';
export const PRIOR_PREVIEW_RUN = 41602026750;
const allowed = new Set([
  '.github/workflows/interaction-preview-20261103.yml',
  'scripts/acceptance-v2-interaction-ci.mjs',
  'scripts/lib/interaction-preview-runtime.mjs',
  'scripts/lib/interaction-preview-evidence.mjs',
  'scripts/interaction-preview-runtime.test.mjs',
  'apps/admin/src/v2/components/V2Table.vue',
  'apps/admin/src/v2/composables/useV2TableContentWidths.ts',
  'apps/admin/src/v2/composables/useV2TableContentWidths.spec.ts',
  'apps/admin/src/v2/composables/useV2RoutePresentation.ts',
  'apps/admin/src/v2/composables/useV2RoutePresentation.spec.ts'
]);
export async function verifyPreviewEvidence(
  env,
  project,
  {
    request = fetch,
    changedPaths = () =>
      execFileSync('git', ['diff', '--name-only', PRIOR_PREVIEW_COMMIT, env.GITHUB_SHA], {
        cwd: project,
        encoding: 'utf8'
      })
        .trim()
        .split('\n')
  } = {}
) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'wangchaozhuanyong/id-business-system');
  assert.equal(env.GITHUB_REF, PREVIEW_BRANCH);
  assert.equal(realpathSync(env.GITHUB_WORKSPACE), realpathSync(project));
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  const changes = changedPaths();
  assert.ok(
    changes.length && changes.every((file) => allowed.has(file)),
    'Changes outside the verified shared table and preview controls require separate checks'
  );
  const get = async (suffix, runId = PRIOR_PREVIEW_RUN) => {
    const response = await request(
      `https://api.github.com/repos/wangchaozhuanyong/id-business-system/actions/runs/${runId}${suffix}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {})
        },
        signal: AbortSignal.timeout(15000)
      }
    );
    assert.equal(response.status, 200, 'Prior CI evidence unavailable');
    return response.json();
  };
  const run = await get('');
  assert.equal(run.head_sha, PRIOR_PREVIEW_COMMIT);
  assert.equal(run.conclusion, 'failure');
  const { jobs } = await get('/jobs?filter=latest&per_page=100');
  assert.equal(jobs.length, 1);
  const required = [
    'Admin tests and isolated runtime controls',
    'Build API and production admin',
    'UI and architecture controls'
  ];
  for (const name of required)
    assert.ok(
      jobs[0].steps.some((step) => step.name === name && step.conclusion === 'success'),
      `Missing successful evidence: ${name}`
    );
  const priorSeconds = Math.ceil(
    (Date.parse(jobs[0].completed_at) - Date.parse(jobs[0].started_at)) / 1000
  );
  const secondRun = await get('', 41604661799);
  assert.equal(secondRun.head_sha, '0cb89de9a6a3bedb3dfbf12655609ec853be7e2e');
  assert.equal(secondRun.conclusion, 'failure');
  const secondJobs = (await get('/jobs?filter=latest&per_page=100', 41604661799)).jobs;
  assert.equal(secondJobs.length, 1);
  const secondSeconds = Math.ceil(
    (Date.parse(secondJobs[0].completed_at) - Date.parse(secondJobs[0].started_at)) / 1000
  );
  const profileRun = await get('', 41606386434);
  assert.equal(profileRun.head_sha, '3be4ae9416c6f30eb56ce8a6a117f7c0359d0984');
  assert.equal(profileRun.conclusion, 'success');
  const profileJobs = (await get('/jobs?filter=latest&per_page=100', 41606386434)).jobs;
  assert.equal(profileJobs.length, 1);
  const profileSeconds = Math.ceil(
    (Date.parse(profileJobs[0].completed_at) - Date.parse(profileJobs[0].started_at)) / 1000
  );
  assert.ok(
    profileSeconds > 0 &&
      priorSeconds > 0 &&
      secondSeconds > 0 &&
      priorSeconds + secondSeconds + profileSeconds + 30 * 60 <= 45 * 60,
    'Combined validation exceeds authorized 45-minute budget'
  );
  return {
    priorRun: PRIOR_PREVIEW_RUN,
    priorCommit: PRIOR_PREVIEW_COMMIT,
    sourceCommit: env.GITHUB_SHA,
    changedPaths: changes,
    reusedChecks: changes.some((file) => file.startsWith('apps/'))
      ? ['Unchanged API source checks only']
      : required,
    affectedChecksRerun: changes.some((file) => file.startsWith('apps/'))
      ? [
          'all admin tests',
          'admin build and typecheck',
          'admin lint',
          'seven UI and architecture checks',
          'bundle budgets'
        ]
      : [],
    priorSeconds,
    secondRun: 41604661799,
    secondSeconds,
    profileRun: 41606386434,
    profileSeconds,
    continuationLimitMinutes: 30
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const evidence = await verifyPreviewEvidence(process.env, root);
  const output = path.join(root, '.runtime/interaction-preview-20261103/remote');
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'reused-checks.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify({
      ok: true,
      reusedRun: evidence.priorRun,
      applicationInputsUnchanged: evidence.affectedChecksRerun.length === 0
    })
  );
}
