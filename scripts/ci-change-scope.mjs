import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const dependencyManifestPatterns = [
  /^\.npmrc$/u,
  /^(?:package-lock|npm-shrinkwrap)\.json$/u,
  /^package\.json$/u,
  /^(?:apps|packages)\/[^/]+\/package\.json$/u,
  /^scripts\/npm-audit-high\.mjs$/u
];

export function classifyChangedPaths(paths) {
  const normalizedPaths = paths.map((path) => path.trim().replaceAll('\\', '/')).filter(Boolean);
  const dependencyAudit = normalizedPaths.some((path) =>
    dependencyManifestPatterns.some((pattern) => pattern.test(path))
  );

  return { dependencyAudit };
}

export function decideCiScope({ eventName, changedPaths = [] }) {
  if (eventName === 'workflow_dispatch') {
    return {
      dependencyAudit: true,
      reason: 'manual'
    };
  }

  const changedScope = classifyChangedPaths(changedPaths);
  return {
    ...changedScope,
    reason: 'changed_paths'
  };
}

function writeGithubOutputs(path, scope) {
  appendFileSync(
    path,
    [`dependency_audit=${scope.dependencyAudit}`, `reason=${scope.reason}`, ''].join('\n')
  );
}

async function main() {
  const changedPaths = readFileSync(0, 'utf8').split(/\r?\n/u);
  const scope = decideCiScope({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    changedPaths
  });

  if (process.env.GITHUB_OUTPUT) writeGithubOutputs(process.env.GITHUB_OUTPUT, scope);
  console.log(JSON.stringify(scope));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
