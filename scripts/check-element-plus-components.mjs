#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const viteConfig = readFileSync(path.join(rootDir, 'apps/admin/vite.config.ts'), 'utf8');
const failures = [];

for (const snippet of ['ElementPlusResolver', 'unplugin-auto-import', 'unplugin-vue-components']) {
  if (!viteConfig.includes(snippet)) failures.push(`vite.config.ts 缺少 ${snippet}`);
}

for (const file of walk(path.join(rootDir, 'apps/admin/src')).filter((item) =>
  /\.(?:ts|vue)$/.test(item)
)) {
  const source = readFileSync(file, 'utf8');
  const projectPath = path.relative(rootDir, file);
  if (/element-plus\/dist\/index\.css/.test(source)) {
    failures.push(`${projectPath}: 禁止加载 Element Plus 全量 CSS`);
  }
  if (/app\.use\(\s*ElementPlus\s*\)/.test(source)) {
    failures.push(`${projectPath}: 禁止安装 Element Plus 全量插件`);
  }
}

if (failures.length) {
  console.error(`Element Plus check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Element Plus on-demand registration check passed.');

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
