import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const productionTagPattern = /^refs\/tags\/v2-production-[0-9]{8}T[0-9]{6}Z$/u;

const dependencyManifestPatterns = [
  /^\.npmrc$/u,
  /^(?:package-lock|npm-shrinkwrap)\.json$/u,
  /^package\.json$/u,
  /^(?:apps|packages)\/[^/]+\/package\.json$/u,
  /^scripts\/npm-audit-high\.mjs$/u
];

const productionImagePatterns = [
  /^\.dockerignore$/u,
  /^\.env\.aws\.production\.example$/u,
  /^\.github\/workflows\/quality\.yml$/u,
  /^apps\/admin\/Dockerfile$/u,
  /^apps\/api\/Dockerfile\.mysql$/u,
  /^apps\/api\/src\/id-business-v2\/workspace\/media-resolver\/Dockerfile$/u,
  /^deploy\/caddy\//u,
  /^docker-compose\.aws-mysql\.yml$/u,
  /^scripts\/acceptance-v2-container-hardening\.mjs$/u,
  /^scripts\/ci-change-scope\.mjs$/u,
  /^scripts\/container-hardening\.test\.mjs$/u
];

export function classifyChangedPaths(paths) {
  const normalizedPaths = paths.map((path) => path.trim().replaceAll('\\', '/')).filter(Boolean);
  const dependencyAudit = normalizedPaths.some((path) =>
    dependencyManifestPatterns.some((pattern) => pattern.test(path))
  );
  const productionImages =
    dependencyAudit ||
    normalizedPaths.some((path) => productionImagePatterns.some((pattern) => pattern.test(path)));

  return { dependencyAudit, productionImages };
}

export function decideCiScope({
  eventName,
  ref,
  manualBuildProductionImages = false,
  changedPaths = []
}) {
  if (eventName === 'push' && productionTagPattern.test(ref)) {
    return {
      dependencyAudit: true,
      productionImages: true,
      reason: 'production_tag'
    };
  }

  if (eventName === 'workflow_dispatch') {
    return {
      dependencyAudit: true,
      productionImages: manualBuildProductionImages,
      reason: manualBuildProductionImages ? 'manual_with_images' : 'manual_quality_only'
    };
  }

  const changedScope = classifyChangedPaths(changedPaths);
  if (eventName === 'push' && ref === 'refs/heads/main') {
    return {
      dependencyAudit: changedScope.dependencyAudit,
      productionImages: false,
      reason: 'main_quality_only'
    };
  }

  return {
    ...changedScope,
    reason: 'changed_paths'
  };
}

function readBoolean(value) {
  return String(value).toLowerCase() === 'true';
}

function writeGithubOutputs(path, scope) {
  appendFileSync(
    path,
    [
      `dependency_audit=${scope.dependencyAudit}`,
      `production_images=${scope.productionImages}`,
      `reason=${scope.reason}`,
      ''
    ].join('\n')
  );
}

async function main() {
  const changedPaths = readFileSync(0, 'utf8').split(/\r?\n/u);
  const scope = decideCiScope({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    manualBuildProductionImages: readBoolean(process.env.MANUAL_BUILD_PRODUCTION_IMAGES),
    changedPaths
  });

  if (process.env.GITHUB_OUTPUT) writeGithubOutputs(process.env.GITHUB_OUTPUT, scope);
  console.log(JSON.stringify(scope));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
