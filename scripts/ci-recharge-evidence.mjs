import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function matchesSourceEvidence(proof, { repo, run, pr, tree }) {
  return (
    proof.repository === repo &&
    proof.runId === run.id &&
    proof.runAttempt === run.run_attempt &&
    proof.pullRequest === pr.number &&
    proof.headSha === pr.head.sha &&
    proof.testedTree === tree &&
    /^[a-f0-9]{40}$/.test(proof.baseSha)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request')
    throw new Error('Only successful PR checks produce evidence');
  const proof = {
    repository: process.env.GITHUB_REPOSITORY,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    pullRequest: event.pull_request.number,
    headSha: event.pull_request.head.sha,
    baseSha: event.pull_request.base.sha,
    testedTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  };
  mkdirSync('.deploy/ci-evidence', { recursive: true });
  writeFileSync('.deploy/ci-evidence/evidence.json', JSON.stringify(proof, null, 2) + '\n');
}
