#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const sourceRoot = path.join(rootDir, 'apps/admin/src/v2');
const failures = [];

for (const file of walk(sourceRoot).filter((item) => item.endsWith('.vue'))) {
  const source = readFileSync(file, 'utf8');
  const projectPath = path.relative(rootDir, file);

  if (/label-position\s*=\s*["']top["']/.test(source)) {
    failures.push(`${projectPath}: 禁止顶部标签布局`);
  }

  for (const [index, match] of [...source.matchAll(/<el-form(?=\s|>)[\s\S]*?>/g)].entries()) {
    if (!/label-position\s*=\s*["']left["']/.test(match[0])) {
      failures.push(`${projectPath}: el-form ${index + 1} 缺少 label-position="left"`);
    }
    if (!/require-asterisk-position\s*=\s*["']right["']/.test(match[0])) {
      failures.push(`${projectPath}: el-form ${index + 1} 缺少 require-asterisk-position="right"`);
    }
  }

  if (/\bv-loading\b|<el-skeleton\b|\bElLoading\b/.test(source)) {
    failures.push(`${projectPath}: 业务页面禁止自建整页加载反馈`);
  }
}

requireSnippets('apps/admin/src/v2/features/order-entry/V2OrderEntryView.vue', [
  '<V2QuickCustomerDrawer',
  '@created="handleCustomerCreated"',
  'form.customerId = customer.id'
]);
requireSnippets('apps/admin/src/v2/features/order-entry/components/V2QuickCustomerDrawer.vue', [
  'confirm-text="保存并选中"',
  'label-position="left"',
  'require-asterisk-position="right"',
  'idBusinessV2CustomersApi.create',
  "emit('created'"
]);
requireSnippets('docs/UI_DESIGN.md', [
  '标签必须在控件左侧',
  '必填星号紧跟字段标题右侧',
  '使用右侧抽屉',
  '保存成功后自动回填'
]);

if (failures.length) {
  console.error(`Admin UI guardrail check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Admin UI guardrail check passed.');

function requireSnippets(projectPath, snippets) {
  const absolutePath = path.join(rootDir, projectPath);
  if (!existsSync(absolutePath)) {
    failures.push(`${projectPath}: 文件不存在`);
    return;
  }
  const source = readFileSync(absolutePath, 'utf8');
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${projectPath}: 缺少 ${snippet}`);
  }
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
