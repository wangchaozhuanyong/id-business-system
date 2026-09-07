#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const productionImageNames = [
  'api',
  'admin',
  'migration',
  'mediaResolver',
  'recharge',
  'gate'
];

const dependencyBoundaryPatterns = [
  /^\.dockerignore$/u,
  /^\.npmrc$/u,
  /^(?:package-lock|npm-shrinkwrap)\.json$/u,
  /^package\.json$/u,
  /^(?:apps|packages)\/[^/]+\/package\.json$/u
];
const fullImageBoundaryPatterns = [
  /^\.dockerignore$/u,
  /^package-lock\.json$/u,
  /^package\.json$/u
];
const migrationPatterns = [
  /^apps\/api\/prisma-mysql\/(?:schema\.prisma|migrations\/)/u,
  /^scripts\/(?:migrate-|backfill-|provision-v2-production-database-access)/u
];
const writePathPatterns = [
  /^apps\/api\/src\/id-business-v2\/(?!.*(?:\.spec\.ts$|\.test\.ts$|\/dto\/))/u,
  /^apps\/api\/src\/(?:auth|v2-auth|audit-logs)\/(?!.*(?:\.spec\.ts$|\.test\.ts$))/u
];

export function createProductionReleasePlan(paths, options = {}) {
  const changedPaths = [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
  const baseSchemaVersion = Number(options.baseSchemaVersion ?? 1);
  const bootstrap = !Number.isInteger(baseSchemaVersion) || baseSchemaVersion < 2;
  const images = Object.fromEntries(productionImageNames.map((name) => [name, false]));
  const acceptance = new Set(['base']);

  for (const path of changedPaths) {
    if (fullImageBoundaryPatterns.some((pattern) => pattern.test(path))) {
      for (const name of productionImageNames) images[name] = true;
    }
    if (dependencyBoundaryPatterns.some((pattern) => pattern.test(path))) {
      for (const name of productionImageNames) images[name] = true;
    }

    if (/^apps\/api\/Dockerfile\.mysql$/u.test(path)) {
      images.api = true;
      images.migration = true;
      images.gate = true;
    }
    if (/^apps\/admin\/Dockerfile$/u.test(path)) images.admin = true;
    if (/^apps\/api\/src\/id-business-v2\/workspace\/media-resolver\/Dockerfile$/u.test(path)) {
      images.mediaResolver = true;
    }

    if (/^apps\/admin\//u.test(path) || /^deploy\/nginx\//u.test(path)) {
      images.admin = true;
      acceptance.add('admin');
    }
    if (/^packages\/shared\//u.test(path)) {
      images.api = true;
      images.admin = true;
      images.gate = true;
      acceptance.add('api');
      acceptance.add('admin');
    }
    if (/^apps\/api\//u.test(path)) {
      images.api = true;
      images.gate = true;
      acceptance.add('api');
    }
    if (/^apps\/api\/src\/id-business-v2\/workspace\/media-resolver\//u.test(path)) {
      images.mediaResolver = true;
      acceptance.add('media-resolver');
    }
    if (/^apps\/api\/src\/id-business-v2\/auto-recharge\/worker\//u.test(path)) {
      images.recharge = true;
      acceptance.add('auto-recharge');
    }
    if (/auto-recharge/u.test(path)) acceptance.add('auto-recharge');
    if (/^apps\/(?:admin\/src\/auth|api\/src\/(?:auth|v2-auth))\//u.test(path)) {
      acceptance.add('auth');
    }
    if (/^apps\/api\/src\/id-business-v2\/workspace\//u.test(path)) {
      acceptance.add('workspace');
    }
    if (
      /^apps\/api\/src\/id-business-v2\/(?:finance|balances|orders|renewals|exchange-rates)\//u.test(
        path
      )
    ) {
      acceptance.add('finance');
    }
    if (/^deploy\/caddy\//u.test(path)) acceptance.add('gateway');
    if (/^docker-compose\.aws-mysql\.yml$/u.test(path)) acceptance.add('runtime-config');
    if (/^scripts\/production-release-smoke\.mjs$/u.test(path)) images.gate = true;
    if (
      /^scripts\/(?:gate-v2-|v2-data-integrity-audit|provision-production-smoke-user)/u.test(path)
    ) {
      images.gate = true;
    }
  }

  const migrationRequired = changedPaths.some((path) =>
    migrationPatterns.some((pattern) => pattern.test(path))
  );
  if (migrationRequired) {
    images.migration = true;
    images.gate = true;
    acceptance.add('database');
  }

  const writePathChanged = changedPaths.some((path) =>
    writePathPatterns.some((pattern) => pattern.test(path))
  );
  const dataRisk = migrationRequired ? 'schema' : writePathChanged ? 'write-path' : 'none';
  const backupPolicy = dataRisk === 'none' ? 'recent' : 'fresh';

  if (bootstrap) {
    for (const name of productionImageNames) images[name] = true;
  }

  return {
    schemaVersion: 1,
    baseSchemaVersion,
    bootstrap,
    changedPaths,
    images,
    changedImages: productionImageNames.filter((name) => images[name]),
    dataRisk,
    backupPolicy,
    migrationRequired,
    acceptanceScopes: [...acceptance].sort()
  };
}

function normalizePath(path) {
  return String(path).trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`);
    const key = value.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const next = values[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`参数缺少值：${value}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function writeGithubOutputs(outputPath, plan) {
  appendFileSync(
    outputPath,
    [
      `changed_images=${plan.changedImages.join(',')}`,
      `backup_policy=${plan.backupPolicy}`,
      `migration_required=${plan.migrationRequired}`,
      `acceptance_scopes=${plan.acceptanceScopes.join(',')}`,
      `data_risk=${plan.dataRisk}`,
      `bootstrap=${plan.bootstrap}`,
      ''
    ].join('\n')
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const paths = readFileSync(0, 'utf8').split(/\r?\n/u);
  const plan = createProductionReleasePlan(paths, {
    baseSchemaVersion: options.baseSchemaVersion
  });
  if (process.env.GITHUB_OUTPUT) writeGithubOutputs(process.env.GITHUB_OUTPUT, plan);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
