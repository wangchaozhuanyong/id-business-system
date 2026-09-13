import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function pythonImageInputs(service) {
  if (!['auto-recharge', 'media-resolver'].includes(service)) throw new Error('Unknown image');
  return [
    `apps/api/src/id-business-v2/${service === 'auto-recharge' ? 'auto-recharge/worker' : 'workspace/media-resolver'}/`,
    'scripts/audit-python-dependencies.py'
  ];
}
export function imageInputsChanged(service, changed) {
  return changed.some((path) => pythonImageInputs(service).some((input) => path.startsWith(input)));
}
async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = process.env.GITHUB_REPOSITORY;
  const service = process.env.SERVICE;
  const gh = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
  const { workflow_runs: runs } = gh(
    `repos/${repo}/actions/workflows/python-dependency-audit.yml/runs?event=pull_request&branch=${encodeURIComponent(event.pull_request.head.ref)}&status=success&per_page=10`
  );
  for (const run of runs) {
    const pr = run.pull_requests?.find(
      (p) => p.number === event.number && p.head.sha === run.head_sha
    );
    if (
      !pr ||
      run.path !== '.github/workflows/python-dependency-audit.yml' ||
      run.conclusion !== 'success'
    )
      continue;
    git('fetch', '--no-tags', 'origin', pr.base.sha, pr.head.sha);
    const tree = git('merge-tree', '--write-tree', pr.base.sha, pr.head.sha).split('\n')[0];
    const changed = git('diff', '--name-only', tree, 'HEAD').split('\n').filter(Boolean);
    if (imageInputsChanged(service, changed)) continue;
    const name = `python-image-${service}-${run.run_attempt}`;
    const { artifacts } = gh(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
    if (!artifacts.some((a) => a.name === name && !a.expired)) continue;
    execFileSync('gh', [
      'run',
      'download',
      String(run.id),
      '--repo',
      repo,
      '--name',
      name,
      '--dir',
      '.deploy/python-images'
    ]);
    const [image] = JSON.parse(readFileSync(`.deploy/python-images/${service}-image.json`, 'utf8'));
    const builtTree = image.Config.Labels['org.opencontainers.image.source-tree'];
    const builtSha = image.Config.Labels['org.opencontainers.image.revision'];
    git('fetch', '--no-tags', 'origin', builtSha);
    // A reused image may come from an earlier run. Prove its own complete inputs, not just the latest run.
    if (image.Architecture !== 'amd64' || image.Os !== 'linux' || !/^[a-f0-9]{40}$/.test(builtTree))
      throw new Error('Invalid image provenance');
    git('cat-file', '-e', `${builtTree}^{tree}`);
    if (
      imageInputsChanged(
        service,
        git('diff', '--name-only', builtTree, 'HEAD').split('\n').filter(Boolean)
      )
    )
      throw new Error('Image source mismatch');
    appendFileSync(process.env.GITHUB_OUTPUT, 'reused=true\n');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Reused verified ${service} image from run ${run.id}; all image input files match.\n`
    );
    return;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
