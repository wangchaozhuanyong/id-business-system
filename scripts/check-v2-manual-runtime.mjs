#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const requireBuild = process.argv.includes('--require-build');
const failures = [];

requireSnippets('apps/api/src/id-business-v2/renewals/id-business-v2-renewals.module.ts', [
  'IdBusinessV2ManualRenewalService',
  'IdBusinessV2RenewalWarningService'
]);
forbidSnippets('apps/api/src/id-business-v2/renewals/id-business-v2-renewals.module.ts', [
  'Worker',
  'Settlement',
  'RenewalTopup',
  'RenewalCancel'
]);
requireSnippets('apps/api/src/id-business-v2/renewals/id-business-v2-renewals.controller.ts', [
  'workbench/manual-renewal-options',
  'manual-renewals',
  'warning-settings',
  'warning-summary'
]);
forbidSnippets('apps/api/src/id-business-v2/renewals/id-business-v2-renewals.controller.ts', [
  'retry-worker',
  'worker-runtime',
  'submit-manual-input'
]);

const renewalsDir = path.join(rootDir, 'apps/api/src/id-business-v2/renewals');
for (const file of readdirSync(renewalsDir)) {
  if (/worker|settlement|renewal-topup|renewal-cancel/.test(file)) {
    failures.push(`续费目录仍包含未注册执行器 ${file}`);
  }
}

forbidSnippets('apps/admin/src/v2/features/topups/components/V2TopupWorkbenchDialogs.vue', [
  'OCR',
  'ocr-candidates',
  'el-upload'
]);
requireSnippets('apps/admin/package.json', ['"build": "vue-tsc -b && vite build"']);
requireSnippets('apps/api/package.json', ['"build": "nest build"']);

if (requireBuild) {
  checkBuild('apps/admin/dist/index.html');
  checkBuild('apps/api/dist/main.js');
}

if (failures.length) {
  console.error(`Current runtime check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Current runtime check passed.');

function requireSnippets(projectPath, snippets) {
  const source = read(projectPath);
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${projectPath}: 缺少 ${snippet}`);
  }
}

function forbidSnippets(projectPath, snippets) {
  const source = read(projectPath);
  for (const snippet of snippets) {
    if (source.includes(snippet)) failures.push(`${projectPath}: 仍包含 ${snippet}`);
  }
}

function read(projectPath) {
  const absolutePath = path.join(rootDir, projectPath);
  if (!existsSync(absolutePath)) {
    failures.push(`${projectPath}: 文件不存在`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function checkBuild(projectPath) {
  const absolutePath = path.join(rootDir, projectPath);
  if (!existsSync(absolutePath) || statSync(absolutePath).size === 0) {
    failures.push(`缺少构建产物 ${projectPath}`);
  }
}
