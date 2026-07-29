#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const failures = [];
const requiredFiles = [
  'apps/admin/index.html',
  'apps/admin/src/main.ts',
  'apps/admin/src/App.vue',
  'apps/admin/vite.config.ts',
  'apps/api/src/main.ts',
  'apps/api/src/app.module.ts'
];
const forbiddenPaths = [
  'apps/admin/v2.html',
  'apps/admin/src/v2-main.ts',
  'apps/admin/src/V2App.vue',
  'apps/admin/src/views',
  'apps/admin/src/layouts',
  'apps/admin/src/router',
  'apps/api/src/v2-app.module.ts',
  'apps/api/src/main-v2.ts',
  'apps/api/src/notifications',
  'apps/api/src/redeem-codes',
  'apps/api/src/code-orders',
  'apps/api/src/apple-automation-tasks'
];
const baselineMigration = '20260729000000_current_system_baseline';
const migrationsPath = path.join(rootDir, 'apps/api/prisma/migrations');
const runtimeRoots = ['apps/admin/src', 'apps/api/src'];
const forbiddenRuntimeSnippets = [
  'TelegramConfig',
  'RedeemCode',
  'CodeOrder',
  'AppleOrder',
  'AppleAutomation',
  'AutomationTask',
  'IdBusinessV2RenewalOperation',
  'waiting_worker',
  'appleOfficialExecuted',
  'legacyUserId',
  'automation task',
  'redeem code',
  'code order'
];

for (const projectPath of requiredFiles) {
  if (!existsSync(path.join(rootDir, projectPath))) failures.push(`缺少当前入口 ${projectPath}`);
}
for (const projectPath of forbiddenPaths) {
  if (existsSync(path.join(rootDir, projectPath))) failures.push(`遗留路径仍存在 ${projectPath}`);
}

if (!existsSync(migrationsPath)) {
  failures.push('缺少当前系统 migration 目录');
} else {
  const migrations = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (migrations.length !== 1 || migrations[0] !== baselineMigration) {
    failures.push(`纯净仓库只允许 ${baselineMigration}，当前为 ${migrations.join(', ') || '(空)'}`);
  }
}

requireSnippets('apps/api/src/app.module.ts', [
  'V2AuthModule',
  'IdBusinessV2Module',
  'validateEnv'
]);
forbidSnippets('apps/api/src/app.module.ts', [
  'NotificationsModule',
  'RedeemCodesModule',
  'AppleAutomationTasksModule'
]);
requireSnippets('apps/admin/src/main.ts', ["import App from './App.vue'"]);
requireSnippets('apps/admin/index.html', ['src="/src/main.ts"']);
forbidSnippets('package.json', ['"build:v2"', '"dev:v2']);
forbidSnippets('apps/api/prisma/seed.ts', ['external_message', 'code.inventory', 'code.order']);
forbidSnippets('apps/api/prisma/schema.prisma', [
  'model TelegramConfig',
  'model RedeemCode',
  'model CodeService',
  'model AppleOrder',
  'model AutomationTask',
  'enum TelegramTestStatus'
]);
forbidSnippets(
  `apps/api/prisma/migrations/${baselineMigration}/migration.sql`,
  forbiddenRuntimeSnippets
);

for (const runtimeRoot of runtimeRoots) {
  for (const projectPath of listSourceFiles(runtimeRoot)) {
    forbidSnippets(projectPath, forbiddenRuntimeSnippets);
  }
}

if (failures.length) {
  console.error(`Single-system isolation check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Single-system isolation check passed.');

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

function listSourceFiles(projectPath) {
  const absolutePath = path.join(rootDir, projectPath);
  if (!existsSync(absolutePath)) return [];
  const results = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const childPath = path.posix.join(projectPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue;
      results.push(...listSourceFiles(childPath));
    } else if (/\.(?:ts|vue|mjs)$/.test(entry.name)) {
      results.push(childPath);
    }
  }
  return results;
}
