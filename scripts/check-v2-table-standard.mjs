#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const featuresPath = 'apps/admin/src/v2/features';
const schemaPath = 'apps/api/prisma/schema.prisma';
const tableStylePath = 'apps/admin/src/v2/styles/v2.css';
const issues = [];

runSelfTests();

const featureManifests = readdirSync(path.join(rootDir, featuresPath), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${featuresPath}/${entry.name}/manifest.ts`)
  .filter((projectPath) => existsSync(path.join(rootDir, projectPath)))
  .map((projectPath) => ({ projectPath, source: read(projectPath) }));
const modulesSource = featureManifests.map(({ source }) => source).join('\n');
const routedViewEntries = featureManifests
  .map(({ projectPath, source }) => {
    const view = source.match(
      /loadView:\s*\(\)\s*=>\s*import\('\.\/(V2[A-Za-z0-9]+View\.vue)'\)/
    )?.[1];
    return view ? { view, projectPath: `${path.posix.dirname(projectPath)}/${view}` } : null;
  })
  .filter(Boolean);
const routedViews = [...new Set(routedViewEntries.map(({ view }) => view))];

if (!routedViews.length) issues.push(`${featuresPath}: 没有发现 V2 路由业务页面`);
if (/label:\s*['"][^'"]*(?:\/|／)[^'"]*['"]/.test(modulesSource)) {
  issues.push(`${featuresPath}: 列定义禁止使用斜杠合并独立业务字段`);
}
const configuredSortColumns = [...modulesSource.matchAll(/key:\s*'sortOrder',\s*label:\s*'排序'/g)];
if (configuredSortColumns.length !== 1) {
  issues.push(`${featuresPath}: 仅选项设置允许且必须保留一个排序列定义`);
}
const optionsModuleStart = modulesSource.indexOf("  key: 'options',");
if (
  optionsModuleStart < 0 ||
  modulesSource.indexOf("key: 'sortOrder', label: '排序'", optionsModuleStart) < 0
) {
  issues.push(`${featuresPath}: 选项设置列定义必须保留排序`);
}

let tableCount = 0;
for (const { view, projectPath } of routedViewEntries) {
  const source = read(projectPath);
  const viewIssues = validateViewSource(source, view === 'V2OptionsView.vue');
  tableCount += extractTableBlocks(source).length;
  for (const issue of viewIssues) issues.push(`${projectPath}: ${issue}`);
}

const tableStyleSource = read(tableStylePath);
const elementPlusSource = read('apps/admin/src/v2/components/V2ElTable.vue');
if (!elementPlusSource.includes('fit: true') || elementPlusSource.includes('fit: false')) {
  issues.push('apps/admin/src/v2/components/V2ElTable.vue: 表格必须默认 fit: true 自动填满容器');
}
for (const [pattern, message] of [
  [/\.v2-shell \.el-table \.cell[\s\S]*?white-space:\s*nowrap/, '表格单元格未强制单行'],
  [/\.v2-shell \.el-table \.cell[\s\S]*?text-overflow:\s*ellipsis/, '表格长内容未使用省略号'],
  [
    /\.v2-shell \.el-table td\.el-table__cell[\s\S]*?vertical-align:\s*middle/,
    '表格单元格未垂直居中'
  ]
]) {
  if (!pattern.test(tableStyleSource)) issues.push(`${tableStylePath}: ${message}`);
}

const schemaSource = read(schemaPath);
for (const modelName of [
  'IdBusinessV2Customer',
  'IdBusinessV2Account',
  'IdBusinessV2Order',
  'IdBusinessV2Activation'
]) {
  const block = extractPrismaModel(schemaSource, modelName);
  if (!block) {
    issues.push(`${schemaPath}: 缺少模型 ${modelName}`);
  } else if (/\bsortOrder\b/.test(block)) {
    issues.push(`${schemaPath}: ${modelName} 禁止保留业务数字排序字段 sortOrder`);
  }
}

const optionModel = extractPrismaModel(schemaSource, 'IdBusinessV2Option');
if (!optionModel || !/\bsortOrder\s+Int\b/.test(optionModel)) {
  issues.push(`${schemaPath}: 选项设置必须保留数字排序字段 sortOrder`);
}

for (const projectPath of [
  'apps/api/src/id-business-v2/accounts/dto/create-id-business-v2-account.dto.ts',
  'apps/api/src/id-business-v2/accounts/dto/update-id-business-v2-account.dto.ts',
  'apps/api/src/id-business-v2/customers/dto/create-id-business-v2-customer.dto.ts',
  'apps/api/src/id-business-v2/customers/dto/update-id-business-v2-customer.dto.ts',
  'apps/api/src/id-business-v2/orders/dto/create-id-business-v2-order.dto.ts',
  'apps/api/src/id-business-v2/orders/dto/update-id-business-v2-order.dto.ts',
  'apps/api/src/id-business-v2/renewals/dto/create-id-business-v2-manual-renewal.dto.ts'
]) {
  if (/\bsortOrder\b/.test(read(projectPath))) {
    issues.push(`${projectPath}: 业务录入 DTO 禁止出现 sortOrder`);
  }
}

for (const projectPath of [
  'apps/admin/src/v2/types/records.ts',
  'apps/admin/src/v2/types/activations.ts',
  'apps/admin/src/v2/types/renewals.ts',
  'apps/admin/src/v2/types/orders.ts',
  'apps/admin/src/v2/types/balances.ts'
]) {
  const source = read(projectPath);
  if (/\bsortOrder\s*:\s*number\b/.test(source)) {
    issues.push(`${projectPath}: 业务响应类型禁止出现数字 sortOrder`);
  }
  if (/sortBy[\s\S]{0,160}['"]sortOrder['"]/.test(source)) {
    issues.push(`${projectPath}: 业务 sortBy 白名单禁止包含 sortOrder`);
  }
}

const optionsViewPath = 'apps/admin/src/v2/features/options/V2OptionsView.vue';
const optionsFormPath = 'apps/admin/src/v2/features/options/components/V2OptionFormDrawer.vue';
const optionsViewSource = `${read(optionsViewPath)}\n${read(optionsFormPath)}`;
for (const [snippet, message] of [
  ['prop="sortOrder" label="排序"', '选项设置必须保留排序列'],
  ['v-model:sort-order="form.sortOrder"', '选项设置必须保留排序输入']
]) {
  if (!optionsViewSource.includes(snippet)) {
    issues.push(`${optionsViewPath}: ${message}`);
  }
}

if (issues.length) {
  console.error('V2 table standard check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      routedViews: routedViews.length,
      desktopTables: tableCount,
      businessSortFields: 0,
      optionSortPreserved: true,
      exceptions: 0
    })
  );
}

function validateViewSource(source, isOptionsView) {
  const viewIssues = [];
  const tables = extractTableBlocks(source);

  for (const table of tables) {
    const openingTag = table.match(/<el-table(?=\s|>)[\s\S]*?>/)?.[0] ?? '';
    if (!/\bshow-overflow-tooltip\b/.test(openingTag)) {
      viewIssues.push('桌面表格必须启用统一溢出提示');
    }
    if (/<el-table-column\b[^>]*\blabel=["'][^"']*(?:\/|／)[^"']*["']/.test(table)) {
      viewIssues.push('表头禁止使用斜杠合并独立业务字段');
    }
    if (/<(?:br|small)\b/.test(table)) {
      viewIssues.push('桌面表格单元格禁止用 br 或 small 堆叠为两行');
    }
    if (/\b(?:v2-table-stack|v2-renewal-account|v2-topup-records-account)\b/.test(table)) {
      viewIssues.push('桌面表格禁止使用堆叠单元格样式');
    }
    if (!isOptionsView && /<el-table-column\b[^>]*\blabel=["']排序["']/.test(table)) {
      viewIssues.push('业务数据表禁止显示人工排序列');
    }
  }

  if (!isOptionsView) {
    if (/\b(?:row|item|form)\.sortOrder\b/.test(source)) {
      viewIssues.push('业务页面禁止读取或录入数字 sortOrder');
    }
    if (/(?:sortBy\s*:|query\.sortBy\s*=)[\s]*["']sortOrder["']/.test(source)) {
      viewIssues.push('业务 sortBy 白名单禁止包含 sortOrder');
    }
  }

  return viewIssues;
}

function extractTableBlocks(source) {
  return [...source.matchAll(/<el-table(?=\s|>)[\s\S]*?<\/el-table>/g)].map((match) => match[0]);
}

function extractPrismaModel(source, modelName) {
  return source.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

function runSelfTests() {
  const valid = '<el-table show-overflow-tooltip><el-table-column label="账号" /></el-table>';
  assert.deepEqual(validateViewSource(valid, false), []);
  for (const invalid of [
    '<el-table><el-table-column label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><el-table-column label="账号 / 国家" /></el-table>',
    '<el-table show-overflow-tooltip><el-table-column label="账号"><small>国家</small></el-table-column></el-table>',
    '<el-table show-overflow-tooltip><el-table-column label="排序" /></el-table>',
    '<el-table show-overflow-tooltip><div class="v2-table-stack"></div></el-table>'
  ]) {
    assert.ok(validateViewSource(invalid, false).length > 0);
  }
  assert.deepEqual(
    validateViewSource(
      '<el-table show-overflow-tooltip><el-table-column label="排序" /></el-table>',
      true
    ),
    []
  );
}

function read(projectPath) {
  return readFileSync(path.join(rootDir, projectPath), 'utf8');
}
