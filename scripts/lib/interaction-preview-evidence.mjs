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
  'apps/admin/src/runtime/performance.ts',
  'apps/admin/src/runtime/performance.spec.ts',
  'apps/admin/src/v2/runtime/interactionDiagnostics.ts',
  'docs/UI_DESIGN.md',
  'docs/V2_LOADING_STANDARD.md',
  'apps/admin/src/v2/components/V2Table.vue',
  'apps/admin/src/v2/composables/useV2TableContentWidths.ts',
  'apps/admin/src/v2/composables/useV2TableContentWidths.spec.ts',
  'apps/admin/src/v2/composables/useV2RoutePresentation.ts',
  'apps/admin/src/v2/composables/useV2RoutePresentation.spec.ts',
  'apps/admin/src/v2/features/accounts/useAccountsPage.ts',
  'apps/admin/src/v2/features/customers/useCustomersPage.ts',
  'apps/admin/src/v2/features/accounts/V2AccountsView.vue',
  'apps/admin/src/v2/features/accounts/components/V2AccountRowActions.vue',
  'apps/admin/src/v2/features/orders/components/V2OrderRowActions.vue',
  'apps/admin/src/v2/features/orders/order-presentation.ts',
  'apps/admin/src/v2/utils/dateTime.ts',
  'apps/admin/src/v2/utils/dateTime.spec.ts',
  'apps/admin/src/v2/features/orders/useOrdersPage.ts',
  'apps/admin/src/v2/components/table-height-measurement.spec.ts',
  'apps/admin/src/v2/styles/base.css',
  'apps/admin/src/components/ui/FeatureHelp.vue',
  'apps/admin/src/v2/components/V2FilterDisclosure.vue',
  'apps/admin/src/v2/features/accounts/components/V2AccountsToolbar.vue',
  'apps/admin/src/v2/features/customers/components/V2CustomersToolbar.vue',
  'apps/admin/src/v2/features/orders/components/V2OrdersToolbar.vue',
  'apps/admin/src/v2/features/accounts/components/V2AccountsOverview.vue'
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
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Only one authorized attempt is allowed');
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
  const tableRun = await get('', 41607976951);
  assert.equal(tableRun.head_sha, '837a1cb7310dcd92b6c4c70d0f746a6864b13fc9');
  assert.equal(tableRun.conclusion, 'failure');
  const tableJobs = (await get('/jobs?filter=latest&per_page=100', 41607976951)).jobs;
  assert.equal(tableJobs.length, 1);
  const tableSeconds = Math.ceil(
    (Date.parse(tableJobs[0].completed_at) - Date.parse(tableJobs[0].started_at)) / 1000
  );
  const snapshotRun = await get('', 41609412467);
  assert.equal(snapshotRun.head_sha, '28a49701fc508da81af239a0b3961f49e385489e');
  assert.equal(snapshotRun.conclusion, 'failure');
  const snapshotJobs = (await get('/jobs?filter=latest&per_page=100', 41609412467)).jobs;
  assert.equal(snapshotJobs.length, 1);
  const snapshotSeconds = Math.ceil(
    (Date.parse(snapshotJobs[0].completed_at) - Date.parse(snapshotJobs[0].started_at)) / 1000
  );
  const menuRun = await get('', 41612300171);
  assert.equal(menuRun.head_sha, '4acbfd31d125d9567df0eee7b2b059dcb29de478');
  assert.equal(menuRun.conclusion, 'failure');
  const menuJobs = (await get('/jobs?filter=latest&per_page=100', 41612300171)).jobs;
  assert.equal(menuJobs.length, 1);
  for (const name of [
    'Admin tests after shared table changes',
    'Prepare verified API and admin runtime files',
    'UI and architecture checks after shared table changes'
  ]) {
    assert.ok(
      menuJobs[0].steps.some((step) => step.name === name && step.conclusion === 'success'),
      `Missing passed check: ${name}`
    );
  }
  const menuSeconds = Math.ceil(
    (Date.parse(menuJobs[0].completed_at) - Date.parse(menuJobs[0].started_at)) / 1000
  );
  const expandedRun = await get('', 41614170604);
  assert.equal(expandedRun.head_sha, '07c06a4399d2b771358ecad2203cbfc0891df19e');
  assert.equal(expandedRun.conclusion, 'failure');
  const expandedJobs = (await get('/jobs?filter=latest&per_page=100', 41614170604)).jobs;
  assert.equal(expandedJobs.length, 1);
  const expandedSeconds = Math.ceil(
    (Date.parse(expandedJobs[0].completed_at) - Date.parse(expandedJobs[0].started_at)) / 1000
  );
  const typedRun = await get('', 41618115000);
  assert.equal(typedRun.head_sha, '7a343c43364fe5a71c75af24fe72ebce9f299580');
  assert.equal(typedRun.conclusion, 'failure');
  const typedJobs = (await get('/jobs?filter=latest&per_page=100', 41618115000)).jobs;
  assert.equal(typedJobs.length, 1);
  assert.ok(
    typedJobs[0].steps.some(
      (step) =>
        step.name === 'Admin tests after shared table changes' && step.conclusion === 'success'
    ),
    'Latest full admin tests must have passed'
  );
  const typedSeconds = Math.ceil(
    (Date.parse(typedJobs[0].completed_at) - Date.parse(typedJobs[0].started_at)) / 1000
  );
  const latestRun = await get('', 41622075809);
  assert.equal(latestRun.head_sha, '9242102afceb6b05e78195365e227ce3b10fd398');
  assert.equal(latestRun.conclusion, 'failure');
  const latestJobs = (await get('/jobs?filter=latest&per_page=100', 41622075809)).jobs;
  assert.equal(latestJobs.length, 1);
  const latestSeconds = Math.ceil(
    (Date.parse(latestJobs[0].completed_at) - Date.parse(latestJobs[0].started_at)) / 1000
  );
  const lazyRun = await get('', 41637259555);
  assert.equal(lazyRun.head_sha, 'abd68d64ea3ca3dce52b130f7e5a2c0e8619b45e');
  assert.equal(lazyRun.conclusion, 'failure');
  const lazyJobs = (await get('/jobs?filter=latest&per_page=100', 41637259555)).jobs;
  assert.equal(lazyJobs.length, 1);
  const lazySeconds = Math.ceil(
    (Date.parse(lazyJobs[0].completed_at) - Date.parse(lazyJobs[0].started_at)) / 1000
  );
  const finalRun = await get('', 41640930871);
  assert.equal(finalRun.head_sha, '6acb0df4856b5c9aa49f36156a908f1d25ae654c');
  assert.equal(finalRun.conclusion, 'failure');
  const finalJobs = (await get('/jobs?filter=latest&per_page=100', 41640930871)).jobs;
  assert.equal(finalJobs.length, 1);
  const finalSeconds = Math.ceil(
    (Date.parse(finalJobs[0].completed_at) - Date.parse(finalJobs[0].started_at)) / 1000
  );
  const priorDurations = [
    priorSeconds,
    secondSeconds,
    profileSeconds,
    tableSeconds,
    snapshotSeconds,
    menuSeconds,
    expandedSeconds,
    typedSeconds,
    latestSeconds,
    lazySeconds,
    finalSeconds
  ];
  const spentSeconds = priorDurations.reduce((total, value) => total + value, 0);
  const continuationLimitMinutes = 8;
  assert.ok(
    priorDurations.every((value) => value > 0) &&
      spentSeconds + continuationLimitMinutes * 60 <= 70 * 60,
    'Combined validation exceeds authorized 70-minute budget'
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
    tableRun: 41607976951,
    tableSeconds,
    snapshotRun: 41609412467,
    snapshotSeconds,
    menuRun: 41612300171,
    menuSeconds,
    expandedRun: 41614170604,
    expandedSeconds,
    typedRun: 41618115000,
    typedSeconds,
    latestRun: 41622075809,
    latestSeconds,
    lazyRun: 41637259555,
    lazySeconds,
    finalRun: 41640930871,
    finalSeconds,
    authorizedMinutes: 70,
    spentSeconds,
    continuationLimitMinutes
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const evidence = await verifyPreviewEvidence(process.env, root);
  const runtimeInputChanges = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '7a343c43364fe5a71c75af24fe72ebce9f299580',
      process.env.GITHUB_SHA,
      '--',
      'apps',
      'packages',
      'package.json',
      'package-lock.json'
    ],
    { cwd: root, encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  evidence.runtimeInputChanges = runtimeInputChanges;
  evidence.fullAdminTestsRequired = true;
  evidence.reusedChecks = ['Unchanged API source checks only'];
  evidence.affectedChecksRerun = [
    'all admin tests',
    'admin typecheck and runtime build',
    'admin lint and seven UI checks',
    'changed preview controls',
    'real API browser acceptance'
  ];

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
