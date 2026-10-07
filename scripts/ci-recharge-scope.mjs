import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

export const parts = ['guards', 'admin', 'api', 'connector', 'migration', 'security'];
export const auditRetentionMigration =
  'apps/api/prisma-mysql/migrations/20261002123500_routine_audit_retention_exception/migration.sql';
export const historicalReleaseControlPaths = Object.freeze([
  'deploy/aws/registration-worker-b8-80-20261006.json',
  'deploy/aws/registration-worker-956-20261006.json',
  'deploy/aws/registration-worker-85-20261006.json',
  'deploy/aws/registration-worker-86-20261006.json',
  'deploy/aws/registration-worker-87-20261006.json',
  'deploy/aws/registration-worker-88-20261006.json',
  'deploy/aws/registration-worker-89-20261006.json',
  'deploy/aws/registration-worker-90-20261007.json',
  'deploy/aws/registration-worker-91-20261007.json',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs',
  'scripts/production-release/registration-only-transport.test.py',
  'deploy/aws/recharge-pro-menu-b8-20261005.json',
  'deploy/aws/recharge-pro-menu-7f-20261005.json',
  'deploy/aws/recharge-pro-main80-20261006.json',
  'scripts/v2-release-mailbox-audit.mjs',
  'scripts/v2-release-mailbox-audit.test.mjs',
  'deploy/aws/historical-finance-20261005-mailbox-batch.json',
  'deploy/aws/historical-finance-20261005-registration-continuation.json',
  'deploy/aws/historical-finance-20261005-recharge-diagnostics.json',
  'deploy/aws/historical-finance-20261005-maintenance-continuation.json',
  'scripts/lib/v2-release-maintenance-policy.mjs',
  'scripts/v2-release-maintenance-audit.mjs',
  'scripts/v2-release-maintenance-policy.test.mjs',
  'deploy/aws/historical-finance-20261005-order-archive.json',
  'scripts/lib/v2-order-archive-release-policy.mjs',
  'scripts/v2-order-archive-release-audit.mjs',
  'scripts/v2-order-archive-release-policy.test.mjs',
  'deploy/aws/historical-finance-20261005-post-cleanup.json',
  'scripts/lib/v2-release-history-policy.mjs',
  'scripts/v2-release-history-audit.mjs',
  'scripts/v2-release-history-policy.test.mjs',
  'scripts/v2-release-post-cleanup-policy.test.mjs',
  'scripts/lib/v2-release-history-48.test-fixture.json',
  '.github/workflows/production-release.yml',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/retire-orphan-retention.py',
  'scripts/production-release/retire-orphan-retention.test.py',
  'scripts/production-release/prepared-images.test.py',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/maintain-image-cache.py',
  'scripts/production-release/maintain-image-cache.test.py'
]);
const registrationProfileObservationProfile = 'deploy/aws/registration-worker-91-20261007.json';
const registrationProfileObservationSources = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py'
]);
const registrationProfileObservationControls = new Set([
  registrationProfileObservationProfile,
  '.github/workflows/production-release.yml',
  'scripts/production-release/build-images.sh',
  'scripts/production-release/push-images.sh',
  'scripts/production-release/dispatch.sh',
  'scripts/production-release/validate-release-selection.sh',
  'scripts/production-release/remote-deploy.py',
  'scripts/production-release/remote-deploy.test.py',
  'scripts/production-release/registration-only-transport.test.py',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-release.test.mjs',
  'scripts/ci-recharge-scope.test.mjs',
  'scripts/v2-registration-finance-audit.mjs',
  'scripts/v2-registration-finance-audit.test.mjs'
]);
const isRegistrationProfileObservationControl = (path) =>
  registrationProfileObservationControls.has(path) ||
  /^(?:docs\/.*\.md|(?:README|AGENTS)\.md)$/.test(path);
function isRegistrationProfileObservationOnly(paths) {
  return (
    paths.includes(registrationProfileObservationProfile) &&
    paths.every(
      (path) =>
        registrationProfileObservationSources.has(path) ||
        isRegistrationProfileObservationControl(path)
    )
  );
}
export function isCiOnly(paths) {
  if (paths.includes(registrationProfileObservationProfile))
    return paths.every(isRegistrationProfileObservationControl);
  return (
    paths.length > 0 &&
    paths.every(
      (p) =>
        historicalReleaseControlPaths.includes(p) ||
        /^(?:\.github\/workflows\/(?:quality|production-release)\.yml|scripts\/ci-(?:recharge|change)-[\w.-]+|scripts\/production-release\/mailbox-diagnostic(?:\.test)?\.(?:mjs|py)|scripts\/production-release\/(?:cleanup-reviewed-cache|cleanup-verified-backups|maintain-image-cache|remote-deploy|reuse-images|storage-maintenance)(?:\.test)?\.py|scripts\/production-release\/audit-retention-mysql\.test\.py|scripts\/production-release\/(?:build-images|push-images|dispatch|check-source)\.sh|deploy\/aws\/cache-cleanup-(?:legacy-20261002|unused-legacy-20261003|storage-20261002|bitbrowser-direct-20261003|20261001|fx-subscription-20261002|unified(?:-recovery)?-20261002|recharge-(?:names|execution)-20261002)\.json|docs\/.*\.md|(?:README|AGENTS)\.md)$/.test(
          p
        )
    )
  );
}
const adminPublicDocument = /^apps\/admin\/public\/[^/]+\.(?:html|css)$/;
const registrationHydrationSourcePaths = new Set([
  'apps/api/src/id-business-v2/auto-recharge/worker/registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_browser.py',
  'apps/api/src/id-business-v2/auto-recharge/worker/test_registration_auto_code.py',
  'apps/admin/src/api/requestPolicy.ts',
  'apps/admin/src/api/requestPolicy.spec.ts',
  'apps/admin/src/v2/features/auto-registration/useRegistrationStart.ts',
  'apps/admin/src/v2/features/auto-registration/useRegistrationPage.spec.ts'
]);

function isRegistrationHydrationOnly(paths) {
  return (
    paths.includes('deploy/aws/registration-worker-90-20261007.json') &&
    paths.some((path) => registrationHydrationSourcePaths.has(path)) &&
    paths.every((path) => registrationHydrationSourcePaths.has(path) || isCiOnly([path]))
  );
}

export function isAdminOnly(paths) {
  return (
    paths.some(
      (p) =>
        p.startsWith('apps/admin/src/v2/') ||
        adminPublicDocument.test(p) ||
        p === 'scripts/acceptance-v2-order-archive-ui.mjs'
    ) &&
    paths.every(
      (p) =>
        p.startsWith('apps/admin/src/v2/') ||
        adminPublicDocument.test(p) ||
        p === 'scripts/acceptance-v2-table-layout.mjs' ||
        p === 'scripts/acceptance-v2-order-archive-ui.mjs' ||
        /^scripts\/(?:admin-layout-rules(?:\.test)?|check-admin-ui-guardrails|acceptance-v2-(?:filter|page)-layout)\.mjs$/.test(
          p
        ) ||
        p === 'apps/admin/layout-contract-fixture.html' ||
        p === 'scripts/check-v2-table-standard.mjs' ||
        isCiOnly([p])
    )
  );
}

const mailboxPaths =
  /^(?:\.env\.(?:example|aws\.production\.example)|docker-compose\.aws-mysql\.yml|apps\/admin\/src\/api\/requestPolicy(?:\.spec)?\.ts|apps\/admin\/src\/v2\/features\/(?:feature|registry(?:\.spec)?|runtimeRegistry|tableSchemas)\.ts|apps\/admin\/src\/v2\/features\/auto-recharge\/(?:V2VendureMailboxView\.vue|VendureMailboxManager\.vue|vendure-mailbox[^/]*)|apps\/api\/src\/id-business-v2\/workspace\/(?:dto\/id-business-v2-vendure-mailbox\.dto\.ts|id-business-v2-(?:mail-viewer\.service(?:\.spec)?|public-vendure-mailbox\.controller|vendure-mailbox\.(?:controller|service)(?:\.spec)?|workspace\.module)\.ts|providers\/id-business-v2-vendure-mailbox\.client(?:\.spec)?\.ts)|packages\/shared\/src\/(?:index\.ts|v2\/vendure-mailbox\.ts))$/;
export function isMailboxOnly(paths) {
  return (
    paths.some((path) => mailboxPaths.test(path)) &&
    paths.every((path) => mailboxPaths.test(path) || isCiOnly([path]))
  );
}

export function checkMode(paths, oldSchema, newSchema) {
  if (paths.includes(registrationProfileObservationProfile)) {
    if (!isRegistrationProfileObservationOnly(paths)) return 'full';
    return paths.some((path) => registrationProfileObservationSources.has(path))
      ? 'recharge'
      : 'ci-only';
  }
  if (
    paths.includes(auditRetentionMigration) &&
    paths.every((path) => path === auditRetentionMigration || isCiOnly([path]))
  )
    return 'audit-retention';
  if (isCiOnly(paths)) return 'ci-only';
  if (isMailboxOnly(paths)) return 'mailbox';
  if (isTargetedOnly(paths, oldSchema, newSchema)) return 'recharge';
  if (isAdminOnly(paths)) return 'admin';
  return 'full';
}

export function adminUiGuardChecks(mode, paths) {
  if (mode !== 'admin' && mode !== 'mailbox' && mode !== 'recharge') return [];
  const hasV2Changes = paths.some((p) => p.startsWith('apps/admin/src/v2/'));
  if (mode === 'recharge' && !hasV2Changes) return [];
  return [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    ...(mode === 'admin' || hasV2Changes ? ['check:v2-module-architecture'] : []),
    'check:v2-isolation',
    'check:v2-decimal-standard'
  ];
}

export function adminCheckCommands(mode, paths) {
  const commands = [['run', 'build', '--workspace', '@apple-business/shared']];
  if (isRegistrationHydrationOnly(paths)) {
    commands.push([
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/auto-registration/useRegistrationPage.spec.ts'
    ]);
    commands.push(['run', 'build', '--workspace', '@apple-business/admin']);
    return commands;
  }
  if (mode === 'mailbox') {
    commands.push([
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/registry.spec.ts',
      'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
    ]);
    commands.push(['run', 'build', '--workspace', '@apple-business/admin']);
    return commands;
  }
  commands.push([
    'run',
    'test',
    '--workspace',
    '@apple-business/admin',
    ...(mode === 'admin'
      ? []
      : [
          '--',
          'src/v2/features/auto-recharge',
          ...(paths.some((p) => p.includes('/audit-logs/'))
            ? ['src/v2/features/audit-logs/audit-log-presentation.spec.ts']
            : [])
        ])
  ]);
  commands.push(['run', 'build', '--workspace', '@apple-business/admin']);
  if (
    paths.some((path) =>
      /^(?:apps\/admin\/src\/v2\/features\/orders\/|apps\/admin\/src\/v2\/(?:api|types)\/orders\.ts$|apps\/admin\/src\/v2\/styles\/(?:base|layout|records)\.css$|scripts\/acceptance-v2-order-archive-ui\.mjs$)/.test(
        path
      )
    )
  )
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-order-archive-ui.mjs']);
  if (
    paths.some((path) =>
      /^(?:apps\/admin\/src\/v2\/styles\/records\.css|apps\/admin\/src\/v2\/features\/auto-recharge\/vendure-mailbox\.css|scripts\/acceptance-v2-table-layout\.mjs)$/.test(
        path
      )
    )
  )
    commands.push(['run', 'acceptance:v2-table-layout']);
  if (
    mode !== 'admin' ||
    paths.some((p) => p.startsWith('apps/admin/src/v2/features/auto-recharge/'))
  )
    commands.push(['run', 'acceptance:v2-auto-recharge']);
  if (
    paths.some((p) =>
      /(?:layout\.css|V2(?:PageOverview|OverviewMetric|ListToolbar|PageContext)\.vue|admin-layout-rules|acceptance-v2-(?:filter|page)-layout)/.test(
        p
      )
    )
  ) {
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-filter-layout.mjs']);
    commands.push(['exec', '--', 'node', 'scripts/acceptance-v2-page-layout.mjs']);
  }
  return commands;
}
const migration =
  'apps/api/prisma-mysql/migrations/20260913100000_auto_recharge_browser_options/migration.sql';
const schema = 'apps/api/prisma-mysql/schema.prisma';
const allowed =
  /^(?:apps\/admin\/src\/v2\/features\/auto-recharge\/|apps\/api\/src\/id-business-v2\/auto-recharge\/|packages\/shared\/src\/v2\/auto-recharge\.ts$|docs\/|scripts\/ci-recharge-[\w.-]+$|scripts\/check-v2-(?:decimal-standard|ui-language)\.mjs$|scripts\/acceptance-v2-auto-recharge\.mjs$|\.github\/workflows\/quality\.yml$)/;

export function isRechargeOnly(paths, oldSchema, newSchema) {
  if (paths.includes(registrationProfileObservationProfile))
    return (
      isRegistrationProfileObservationOnly(paths) &&
      paths.some((path) => registrationProfileObservationSources.has(path))
    );
  if (!paths.length || !paths.some((p) => p.includes('auto-recharge') || p === migration))
    return false;
  if (
    !paths.every(
      (p) =>
        allowed.test(p) ||
        historicalReleaseControlPaths.includes(p) ||
        p === schema ||
        p === migration
    )
  )
    return false;
  if (!paths.includes(schema)) return true;
  const model = /model IdBusinessV2RechargeBrowserSetting \{[^}]*\}\s*/;
  return (
    typeof oldSchema === 'string' &&
    typeof newSchema === 'string' &&
    model.test(oldSchema) &&
    model.test(newSchema) &&
    oldSchema.replace(model, '') === newSchema.replace(model, '')
  );
}

// These security modules have explicit targeted checks below; other code remains full scope.
const securityPaths =
  /^(?:apps\/api\/src\/auth\/(?:auth\.service|password-hasher)(?:\.spec)?\.ts$|apps\/admin\/src\/v2\/features\/audit-logs\/audit-log-presentation(?:\.spec)?\.ts$|apps\/api\/src\/id-business-v2\/workspace\/media-resolver\/|scripts\/(?:audit-python-dependencies(?:\.test)?\.py|container-hardening\.test\.mjs|start-auto-recharge-connector\.sh)$|\.github\/workflows\/python-dependency-audit\.yml$)/;
export function isTargetedOnly(paths, oldSchema, newSchema) {
  if (paths.includes(registrationProfileObservationProfile))
    return isRechargeOnly(paths, oldSchema, newSchema);
  return (
    isRegistrationHydrationOnly(paths) ||
    isRechargeOnly(paths, oldSchema, newSchema) ||
    (paths.some((p) => securityPaths.test(p)) &&
      paths.every(
        (p) => allowed.test(p) || historicalReleaseControlPaths.includes(p) || securityPaths.test(p)
      ))
  );
}
export function selectedParts(paths) {
  if (isRegistrationProfileObservationOnly(paths))
    return paths.some((path) => registrationProfileObservationSources.has(path))
      ? ['guards', 'connector']
      : ['guards'];
  return parts.filter((part) =>
    part === 'migration'
      ? paths.some((p) => p.startsWith('apps/api/prisma-mysql/'))
      : part === 'security'
        ? paths.some((p) => securityPaths.test(p))
        : affectsPart(part, paths)
  );
}

export function affectsPart(part, paths) {
  if (part === 'guards') return paths.length > 0;
  const common =
    /^(?:package(?:-lock)?\.json$|\.github\/workflows\/quality\.yml$|scripts\/ci-recharge-check\.mjs$|scripts\/ci-change-scope|tsconfig|eslint\.config|\.npmrc$)/;
  const inputs = {
    admin:
      /^(?:apps\/admin\/|packages\/shared\/|scripts\/acceptance-v2-(?:auto-recharge|table-layout)\.mjs$)/,
    api: /^(?:apps\/api\/(?!src\/id-business-v2\/(?:auto-recharge\/worker|workspace\/media-resolver)\/)|packages\/shared\/)/,
    connector: /^apps\/api\/src\/id-business-v2\/auto-recharge\/worker\//,
    migration: /^apps\/api\/prisma-mysql\//,
    security: securityPaths
  };
  if (!inputs[part]) throw new Error('Unknown check part');
  return paths.some((p) => common.test(p) || inputs[part].test(p));
}

export function matchingRun(run, number, headSha) {
  return (
    run.event === 'pull_request' &&
    run.path === '.github/workflows/quality.yml' &&
    run.status === 'completed' &&
    run.head_sha === headSha &&
    run.pull_requests?.some((pr) => pr.number === number && pr.head.sha === headSha)
  );
}

export function canReuseMain(testedSourceTree, currentSourceTree, jobs) {
  return (
    testedSourceTree === currentSourceTree &&
    jobs.some((job) => job.name === 'quality' && job.conclusion === 'success')
  );
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
function ensureCommit(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source commit');
  try {
    git('cat-file', '-e', sha);
  } catch {
    git('fetch', '--no-tags', 'origin', sha);
  }
}
function testedTree(run, number) {
  const pr = run.pull_requests.find((item) => item.number === number);
  ensureCommit(pr.base.sha);
  ensureCommit(pr.head.sha);
  return git('merge-tree', '--write-tree', pr.base.sha, pr.head.sha).split('\n')[0];
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = process.env.BASE_SHA;
  ensureCommit(base);
  const paths = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const mode = checkMode(paths, git('show', `${base}:${schema}`), git('show', `HEAD:${schema}`));
  const currentTree = git('rev-parse', 'HEAD^{tree}');
  let reuseMain = false;
  const reused = new Set();
  const evidence = [];
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    const prs = gh(`repos/${repo}/commits/${process.env.GITHUB_SHA}/pulls`);
    for (const pr of prs.filter(
      (p) =>
        p.merged_at &&
        p.merge_commit_sha === process.env.GITHUB_SHA &&
        p.base.ref === 'main' &&
        p.head.repo?.full_name === repo
    )) {
      const { workflow_runs: runs } = gh(
        `repos/${repo}/actions/workflows/quality.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=20`
      );
      for (const run of runs.filter(
        (r) =>
          r.event === 'pull_request' &&
          r.path === '.github/workflows/quality.yml' &&
          r.status === 'completed' &&
          r.head_sha === pr.head.sha &&
          r.conclusion === 'success'
      )) {
        const { artifacts } = gh(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
        const artifact = artifacts.find(
          (a) => a.name === `quality-source-evidence-${run.run_attempt}` && !a.expired
        );
        if (!artifact) continue;
        const directory = `.deploy/ci-source-evidence/${run.id}-${run.run_attempt}`;
        execFileSync(
          'gh',
          [
            'run',
            'download',
            String(run.id),
            '--repo',
            repo,
            '--name',
            artifact.name,
            '--dir',
            directory
          ],
          { stdio: 'pipe' }
        );
        const proof = JSON.parse(readFileSync(`${directory}/evidence.json`, 'utf8'));
        if (!matchesSourceEvidence(proof, { repo, run, pr, tree: currentTree })) continue;
        const { jobs } = gh(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
        if (!canReuseMain(proof.testedTree, currentTree, jobs)) continue;
        reuseMain = true;
        evidence.push({ run: run.id, tree: currentTree, pr: pr.number });
        break;
      }
      if (reuseMain) break;
    }
    if (!reuseMain)
      throw new Error(
        'No successful PR evidence matches the merged source tree; stop instead of repeating checks'
      );
  } else if (process.env.GITHUB_EVENT_NAME === 'pull_request' && mode === 'recharge') {
    const pr = event.pull_request;
    const { workflow_runs: runs } = gh(
      `repos/${repo}/actions/workflows/quality.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&status=completed&per_page=10`
    );
    for (const run of runs) {
      if (!matchingRun(run, pr.number, run.head_sha)) continue;
      const tree = testedTree(run, pr.number);
      const changed = git('diff', '--name-only', tree, currentTree).split('\n').filter(Boolean);
      const { jobs } = gh(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      for (const part of parts) {
        if (reused.has(part) || affectsPart(part, changed)) continue;
        if (jobs.some((job) => job.name === `recharge (${part})` && job.conclusion === 'success')) {
          reused.add(part);
          evidence.push({ part, run: run.id, tree });
        }
      }
      if (reused.size === parts.length) break;
    }
  }
  const checkParts =
    mode === 'ci-only' || mode === 'audit-retention'
      ? ['guards']
      : mode === 'admin'
        ? ['guards', 'admin']
        : mode === 'mailbox'
          ? ['guards', 'admin', 'api']
          : selectedParts(paths);
  const result = { mode, reuseMain, reusedParts: [...reused], checkParts, base, evidence };
  const adminAcceptance =
    checkParts.includes('admin') &&
    adminCheckCommands(mode, paths).some((args) =>
      args.some(
        (arg) =>
          /^acceptance:v2-(?:auto-recharge|table-layout)$/.test(arg) ||
          arg === 'scripts/acceptance-v2-order-archive-ui.mjs'
      )
    );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${mode}\nreuse_main=${reuseMain}\nreused_parts=${JSON.stringify([...reused])}\ncheck_parts=${JSON.stringify(checkParts)}\nbase=${base}\nadmin_acceptance=${adminAcceptance}\n`
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Scoped quality evidence\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
