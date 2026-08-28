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

for (const retiredPath of retiredDeploymentPaths) {
  if (existsSync(path.join(root, retiredPath))) {
    failures.push(`已退役的云部署路径被重新引入: ${retiredPath}`);
  }
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
