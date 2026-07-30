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

  for (const match of source.matchAll(/:(?:confirm-disabled|disabled)\s*=\s*["']([^"']+)["']/g)) {
    if (hasFieldValidityCondition(match[1])) {
      failures.push(`${projectPath}: 可修正的字段有效性不得用于禁用提交操作`);
    }
  }

  for (const match of source.matchAll(/<(?:V2FormDrawer|V2ConfirmDialog)\b[\s\S]*?>/g)) {
    const disabledExpression = match[0].match(/:confirm-disabled\s*=\s*["']([^"']+)["']/)?.[1];
    if (disabledExpression && /\bform(?:\.|\[)/.test(disabledExpression)) {
      failures.push(`${projectPath}: confirm-disabled 不得直接依赖表单字段`);
    }
  }

  for (const match of source.matchAll(/<AppButton\b[\s\S]*?>/g)) {
    if (!/@click\s*=\s*["'][^"']*(?:submit|save|create|reveal|confirm|report)/i.test(match[0])) {
      continue;
    }
    const disabledExpression = match[0].match(/:disabled\s*=\s*["']([^"']+)["']/)?.[1];
    if (
      disabledExpression &&
      (hasFieldValidityCondition(disabledExpression) || /\bform(?:\.|\[)/.test(disabledExpression))
    ) {
      failures.push(`${projectPath}: 提交按钮不得因可修正的表单字段而禁用`);
    }
  }
}

requireSnippets('apps/admin/src/v2/features/order-entry/V2OrderEntryView.vue', [
  '<V2QuickCustomerDrawer',
  '@created="handleCustomerCreated"'
]);
requireSnippets('apps/admin/src/v2/features/order-entry/useOrderEntryPage.ts', [
  'handleCustomerCreated',
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
  '保存成功后自动回填',
  '可修正错误不得用于禁用提交按钮',
  'validateV2Form',
  'confirmDisabledReason'
]);

for (const projectPath of [
  'apps/admin/src/v2/features/order-entry/useOrderEntryPage.ts',
  'apps/admin/src/v2/features/order-entry/components/V2QuickCustomerDrawer.vue',
  'apps/admin/src/v2/features/topups/components/V2TopupWorkbenchDialogs.vue',
  'apps/admin/src/v2/features/orders/components/V2OrderEditDrawer.vue',
  'apps/admin/src/v2/features/orders/components/V2OrderRefundDialog.vue',
  'apps/admin/src/v2/features/renewals/components/V2RenewalOrderDrawer.vue',
  'apps/admin/src/v2/features/renewals/components/V2RenewalWarningSettingsDialog.vue',
  'apps/admin/src/v2/features/customers/useCustomersPage.ts',
  'apps/admin/src/v2/features/accounts/components/V2AccountDialogs.vue',
  'apps/admin/src/v2/features/options/components/V2OptionFormDrawer.vue',
  'apps/admin/src/v2/features/topup-records/V2TopupRecordsView.vue',
  'apps/admin/src/v2/features/exchange-rates/components/V2ExchangeRateDrawers.vue'
]) {
  requireSnippets(projectPath, ['validateV2Form']);
}

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

function hasFieldValidityCondition(expression) {
  return /(?:\.trim\s*\(|\.length\b|\bisValid\w*\b|\bcanSubmit\w*\b|\bcanConfirm\w*\b|\bformReady\b)/.test(
    expression
  );
}
