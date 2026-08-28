import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const removedProviderPattern = /s[u]pabase/i;
const removedEdgePattern = /c[l]oudflare/i;
const retiredDeploymentPaths = [
  'supabase',
  'deploy/cloudflare-free',
  'wrangler.cloudflare-free.jsonc',
  'scripts/build-supabase-v2-api.mjs',
  'scripts/deploy-cloudflare-free.mjs'
];
const environmentFiles = [
  '.env.example',
  '.env.aws.production.example',
  '.env',
  '.deploy/aws-production.local.env'
];
const removedEnvironmentKeyPattern = /^(?:S[U]PABASE|CLOUDFLARE)/iu;
const removedEnvironmentEndpointPattern = /(?:s[u]pabase\.(?:co|in)|workers\.dev|pages\.dev)/iu;

const compose = read('docker-compose.aws-mysql.yml');
const rootPackage = JSON.parse(read('package.json'));
const apiPackage = JSON.parse(read('apps/api/package.json'));
const adminPackage = JSON.parse(read('apps/admin/package.json'));
const runtimeSources = ['apps/admin/src', 'apps/api/src'].flatMap((directory) =>
  listSourceFiles(directory)
);

if (!compose.includes('image: mysql:8.4')) failures.push('AWS Compose 未锁定 MySQL 8.4');
if (!compose.includes('AUTH_PROVIDER: local')) failures.push('AWS Compose 未锁定本地认证');
if (!compose.includes('DATABASE_URL: ${DATABASE_URL:?set MySQL DATABASE_URL}')) {
  failures.push('AWS Compose 未强制使用 MySQL DATABASE_URL');
}
if (
  !compose.includes('DATABASE_URL: ${MIGRATION_DATABASE_URL:?set MySQL MIGRATION_DATABASE_URL}')
) {
  failures.push('AWS Compose migration 未使用独立 MIGRATION_DATABASE_URL');
}

for (const retiredPath of retiredDeploymentPaths) {
  if (existsSync(path.join(root, retiredPath))) {
    failures.push(`已退役的云部署路径被重新引入: ${retiredPath}`);
  }
}

for (const file of environmentFiles) {
  if (!existsSync(path.join(root, file))) continue;
  inspectEnvironmentFile(file);
}

for (const [name, manifest] of [
  ['root', rootPackage],
  ['api', apiPackage],
  ['admin', adminPackage]
]) {
  const serialized = JSON.stringify({
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    scripts: manifest.scripts
  });
  if (removedProviderPattern.test(serialized) || removedEdgePattern.test(serialized)) {
    failures.push(`${name} package 仍包含已移除云运行时的依赖或脚本`);
  }
}

for (const file of runtimeSources) {
  const source = read(file);
  if (removedProviderPattern.test(source) || removedEdgePattern.test(source)) {
    failures.push(`${file} 仍引用已移除的云运行时`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exit(1);
}

console.log('[PASS] 生产编排使用 AWS MySQL 和本地认证');
console.log('[PASS] 前后端运行时已移除旧云服务依赖');
console.log('[PASS] 示例与本机环境文件未启用已退役云运行时');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function listSourceFiles(relativeDirectory) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(relativePath);
      else if (/\.(?:ts|vue)$/u.test(entry.name) && !entry.name.endsWith('.spec.ts')) {
        files.push(relativePath);
      }
    }
  };
  walk(relativeDirectory);
  return files;
}

function inspectEnvironmentFile(relativePath) {
  for (const [index, line] of read(relativePath).split(/\r?\n/u).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/iu);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2').trim();
    if (!value) continue;
    if (removedEnvironmentKeyPattern.test(key) || removedEnvironmentEndpointPattern.test(value)) {
      failures.push(`${relativePath}:${index + 1} 仍启用已退役云运行时变量 ${key}`);
    }
  }
}
