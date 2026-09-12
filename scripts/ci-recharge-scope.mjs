import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

export const parts = ['guards', 'admin', 'api', 'connector', 'migration'];
export function isCiOnly(paths) {
  return (
    paths.length > 0 &&
    paths.every((p) =>
      /^(?:\.github\/workflows\/quality\.yml|scripts\/ci-recharge-[\w.-]+|docs\/AUTO_RECHARGE_SETTINGS_PLAN\.md)$/.test(
        p
      )
    )
  );
}
const migration =
  'apps/api/prisma-mysql/migrations/20260913100000_auto_recharge_browser_options/migration.sql';
const schema = 'apps/api/prisma-mysql/schema.prisma';
const allowed =
  /^(?:apps\/admin\/src\/v2\/features\/auto-recharge\/|apps\/api\/src\/id-business-v2\/auto-recharge\/|packages\/shared\/src\/v2\/auto-recharge\.ts$|docs\/|scripts\/ci-recharge-[\w.-]+$|scripts\/check-v2-(?:decimal-standard|ui-language)\.mjs$|scripts\/acceptance-v2-auto-recharge\.mjs$|\.github\/workflows\/quality\.yml$)/;

export function isRechargeOnly(paths, oldSchema, newSchema) {
  if (!paths.length || !paths.some((p) => p.includes('auto-recharge') || p === migration))
    return false;
  if (!paths.every((p) => allowed.test(p) || p === schema || p === migration)) return false;
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

export function affectsPart(part, paths) {
  if (part === 'guards') return paths.length > 0;
  const common =
    /^(?:package(?:-lock)?\.json$|\.github\/workflows\/quality\.yml$|scripts\/ci-recharge-|scripts\/ci-change-scope|tsconfig|eslint\.config|\.npmrc$)/;
  const inputs = {
    admin: /^(?:apps\/admin\/|packages\/shared\/|scripts\/acceptance-v2-auto-recharge\.mjs$)/,
    api: /^(?:apps\/api\/|packages\/shared\/)/,
    connector: /^apps\/api\/src\/id-business-v2\/auto-recharge\/worker\//,
    migration: /^apps\/api\/prisma-mysql\//
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
  const mode = isCiOnly(paths)
    ? 'ci-only'
    : isRechargeOnly(paths, git('show', `${base}:${schema}`), git('show', `HEAD:${schema}`))
      ? 'recharge'
      : 'full';
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
  const checkParts = mode === 'ci-only' ? ['guards'] : parts;
  const result = { mode, reuseMain, reusedParts: [...reused], checkParts, base, evidence };
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${mode}\nreuse_main=${reuseMain}\nreused_parts=${JSON.stringify([...reused])}\ncheck_parts=${JSON.stringify(checkParts)}\nbase=${base}\n`
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Scoped quality evidence\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
