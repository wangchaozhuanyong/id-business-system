#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const failures = [];
const features = [
  'accounts',
  'activations',
  'customers',
  'exchange-rates',
  'options',
  'order-entry',
  'orders',
  'renewals',
  'topup-records',
  'topups'
];

for (const feature of features) {
  if (!existsSync(path.join(rootDir, 'apps/admin/src/v2/features', feature))) {
    failures.push(`缺少前端模块 ${feature}`);
  }
}

requireSnippets('docs/V2_PRODUCT_SCOPE.md', [
  '续费操作',
  '订单录入',
  '加卡',
  'ID 录入',
  '订单管理',
  '客户记录',
  '加卡记录',
  '开通记录',
  '汇率记录',
  '选项设置',
  '仪表盘暂不开发'
]);
requireSnippets('apps/admin/src/v2/features/topups/components/V2TopupWorkbenchDialogs.vue', [
  '手工输入礼品卡号'
]);
requireSnippets('apps/api/src/id-business-v2/renewals/id-business-v2-renewals.module.ts', [
  'IdBusinessV2ManualRenewalService',
  'IdBusinessV2RenewalWarningService'
]);
requireSnippets('package.json', ['"build": "npm run build --workspaces --if-present"']);

if (failures.length) {
  console.error(`Product implementation check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Product implementation check passed (${features.length} modules).`);

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
