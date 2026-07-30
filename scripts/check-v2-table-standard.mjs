#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const featuresPath = 'apps/admin/src/v2/features';
const schemaPath = 'apps/api/prisma/schema.prisma';
const tableStylePath = 'apps/admin/src/v2/styles/v2.css';
const tableColumnPath = 'apps/admin/src/v2/components/V2TableColumn.vue';
const tableColumnDefinitionPath = 'apps/admin/src/v2/components/tableColumn.ts';
const tableActionColumnPath = 'apps/admin/src/v2/components/V2TableActionColumn.vue';
const tableActionLayoutPath = 'apps/admin/src/v2/components/tableActionLayout.ts';
const validColumnKinds = new Set(['text', 'identifier', 'index', 'numeric', 'date', 'status']);
const validColumnWidthPresets = new Set([
  'index',
  'compact',
  'standard',
  'wide',
  'dateTime',
  'identifier',
  'longText'
]);
const validActionLayouts = new Set(['icon', 'single', 'double', 'triple', 'wide']);
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
const featureVueFiles = walk(path.join(rootDir, featuresPath))
  .filter((file) => file.endsWith('.vue'))
  .map((file) => path.relative(rootDir, file));

if (!routedViews.length) issues.push(`${featuresPath}: 没有发现 V2 路由业务页面`);
if (
  !featureVueFiles.some(
    (projectPath) =>
      projectPath.includes('/components/') && extractActionLayouts(read(projectPath)).length > 0
  )
) {
  issues.push(`${featuresPath}: 递归扫描未覆盖包含操作列的子组件`);
}
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
for (const { projectPath, source } of featureManifests) {
  const columnsBlock = extractFeatureColumnsBlock(source);
  for (const entry of columnsBlock.match(/\{[\s\S]*?\}/g) ?? []) {
    const key = entry.match(/\bkey:\s*'([^']+)'/)?.[1];
    const kind = entry.match(/\bkind:\s*'([^']+)'/)?.[1];
    const widthPreset = entry.match(/\bwidthPreset:\s*'([^']+)'/)?.[1];
    if (!key) continue;
    if (key === 'actions') {
      if (kind !== 'actions') {
        issues.push(`${projectPath}: 操作列清单 kind 必须为 actions`);
      }
    } else if (!kind || !validColumnKinds.has(kind)) {
      issues.push(`${projectPath}: 数据列 ${key} 缺少有效语义 kind`);
    } else if (!widthPreset || !validColumnWidthPresets.has(widthPreset)) {
      issues.push(`${projectPath}: 数据列 ${key} 缺少有效共享宽度档位`);
    } else if (/\bminWidth\s*:/.test(entry)) {
      issues.push(`${projectPath}: 数据列 ${key} 禁止维护任意 minWidth`);
    }
  }
}

let tableCount = 0;
let actionColumnCount = 0;
for (const projectPath of featureVueFiles) {
  const source = read(projectPath);
  const tables = extractTableBlocks(source);
  if (!tables.length) continue;
  const viewIssues = validateViewSource(source, projectPath.includes('/options/'));
  tableCount += tables.length;
  actionColumnCount += extractActionLayouts(source).length;
  for (const issue of viewIssues) issues.push(`${projectPath}: ${issue}`);
}

const tableStyleSource = read(tableStylePath);
const elementPlusSource = read('apps/admin/src/v2/components/V2ElTable.vue');
const tableColumnSource = read(tableColumnPath);
const tableColumnDefinitionSource = read(tableColumnDefinitionPath);
const tableActionColumnSource = read(tableActionColumnPath);
const tableActionLayoutSource = read(tableActionLayoutPath);
if (!elementPlusSource.includes('fit: true') || elementPlusSource.includes('fit: false')) {
  issues.push('apps/admin/src/v2/components/V2ElTable.vue: 表格必须默认 fit: true 自动填满容器');
}
if (
  !elementPlusSource.includes('scrollbarAlwaysOn: true') ||
  !elementPlusSource.includes('v2-adaptive-table')
) {
  issues.push('apps/admin/src/v2/components/V2ElTable.vue: 表格必须启用自适应容器和常显滚动条');
}
for (const [pattern, message] of [
  [/\.v2-shell \.el-table \.cell[\s\S]*?white-space:\s*nowrap/, '表格单元格未强制单行'],
  [/\.v2-shell \.el-table \.cell[\s\S]*?text-overflow:\s*ellipsis/, '表格长内容未使用省略号'],
  [
    /\.v2-shell \.el-table td\.el-table__cell[\s\S]*?vertical-align:\s*middle/,
    '表格单元格未垂直居中'
  ],
  [
    /\.v2-shell \.v2-adaptive-table[\s\S]*?container-name:\s*v2-data-table/,
    '表格未建立容器级自适应上下文'
  ],
  [
    /\.v2-shell \.el-table \.cell[\s\S]*?padding-inline:\s*var\(--v2-table-cell-inline-padding/,
    '表格单元格未使用统一自适应横向间距'
  ],
  [
    /@container v2-data-table \(max-width:\s*1199px\)[\s\S]*?--v2-table-cell-inline-padding:\s*10px/,
    '中等表格容器未使用 10px 横向间距'
  ],
  [
    /@container v2-data-table \(max-width:\s*839px\)[\s\S]*?--v2-table-cell-inline-padding:\s*8px/,
    '紧凑表格容器未使用 8px 横向间距'
  ]
]) {
  if (!pattern.test(tableStyleSource)) issues.push(`${tableStylePath}: ${message}`);
}
for (const issue of validateActionStyleSource(tableStyleSource)) {
  issues.push(`${tableStylePath}: ${issue}`);
}
for (const [pattern, message] of [
  [
    /\.v2-table-column--numeric[\s\S]*?font-variant-numeric:\s*tabular-nums/,
    '数字列未启用等宽数字'
  ],
  [/\.v2-table-column--date[\s\S]*?font-variant-numeric:\s*tabular-nums/, '日期列未启用等宽数字'],
  [
    /\.v2-table-column--identifier[\s\S]*?font-variant-numeric:\s*tabular-nums/,
    '标识列未启用等宽数字'
  ]
]) {
  if (!pattern.test(tableStyleSource)) issues.push(`${tableStylePath}: ${message}`);
}
for (const issue of validateTableColumnSource(tableColumnSource)) {
  issues.push(`${tableColumnPath}: ${issue}`);
}
for (const issue of validateActionColumnSource(tableActionColumnSource)) {
  issues.push(`${tableActionColumnPath}: ${issue}`);
}
for (const [preset, width] of Object.entries({
  index: 72,
  compact: 112,
  standard: 128,
  wide: 160,
  dateTime: 165,
  identifier: 192,
  longText: 224
})) {
  if (!new RegExp(`\\b${preset}:\\s*${width}\\b`).test(tableColumnDefinitionSource)) {
    issues.push(`${tableColumnDefinitionPath}: ${preset} 列宽必须为 ${width}`);
  }
}
for (const [kind, mode] of Object.entries({
  text: 'flex',
  identifier: 'fixed',
  index: 'fixed',
  numeric: 'fixed',
  date: 'fixed',
  status: 'fixed'
})) {
  if (!new RegExp(`\\b${kind}:\\s*'${mode}'`).test(tableColumnDefinitionSource)) {
    issues.push(`${tableColumnDefinitionPath}: ${kind} 列宽模式必须为 ${mode}`);
  }
}
for (const [layout, width] of Object.entries({
  icon: 76,
  single: 126,
  double: 180,
  triple: 260,
  wide: 272
})) {
  if (!new RegExp(`\\b${layout}:\\s*${width}\\b`).test(tableActionLayoutSource)) {
    issues.push(`${tableActionLayoutPath}: ${layout} 操作列宽度必须为 ${width}`);
  }
}

for (const { projectPath, source } of featureManifests) {
  const actionDefinition = source.match(
    /key:\s*'actions'[\s\S]{0,240}?minWidth:\s*V2_TABLE_ACTION_COLUMN_WIDTH\.(\w+)[\s\S]{0,120}?fixed:\s*'right'/
  );
  const featureDirectory = path.posix.dirname(projectPath);
  const featureLayouts = featureVueFiles
    .filter((file) => file.startsWith(`${featureDirectory}/`))
    .flatMap((file) => extractActionLayouts(read(file)));

  if (!featureLayouts.length) {
    if (/key:\s*'actions'/.test(source)) {
      issues.push(`${projectPath}: manifest 声明了操作列，但页面未使用 V2TableActionColumn`);
    }
    continue;
  }
  if (!actionDefinition?.[1]) {
    issues.push(`${projectPath}: 操作列必须复用 V2_TABLE_ACTION_COLUMN_WIDTH 并固定在右侧`);
    continue;
  }
  if (!source.includes('import { V2_TABLE_ACTION_COLUMN_WIDTH }')) {
    issues.push(`${projectPath}: 缺少统一操作列宽度常量导入`);
  }
  if (featureLayouts.some((layout) => layout !== actionDefinition[1])) {
    issues.push(
      `${projectPath}: manifest 操作列档位 ${actionDefinition[1]} 与页面档位 ${[
        ...new Set(featureLayouts)
      ].join('、')} 不一致`
    );
  }
}

const uiRulesSource = read('docs/UI_DESIGN.md');
for (const snippet of [
  'V2TableColumn',
  '数字、金额、汇率和百分比',
  '空值统一显示 `—`',
  '固定语义宽度',
  '表格单元格横向间距',
  '`width-preset`',
  'V2TableActionColumn',
  '禁止同时叠加 `gap` 与 Element Plus 相邻按钮默认边距',
  '操作按钮不得被裁切'
]) {
  if (!uiRulesSource.includes(snippet)) {
    issues.push(`docs/UI_DESIGN.md: 缺少操作列规则 ${snippet}`);
  }
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
for (const [pattern, message] of [
  [
    /<V2TableColumn[\s\S]{0,180}?prop="sortOrder"[\s\S]{0,120}?label="排序"/,
    '选项设置必须保留排序列'
  ],
  [/v-model:sort-order="form\.sortOrder"/, '选项设置必须保留排序输入']
]) {
  if (!pattern.test(optionsViewSource)) {
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
      actionColumns: actionColumnCount,
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
    if (/<el-table-column\b/.test(table)) {
      viewIssues.push('业务数据列必须使用 V2TableColumn 声明语义类型');
    }
    if (/<V2TableColumn\b[^>]*\blabel=["'][^"']*(?:\/|／)[^"']*["']/.test(table)) {
      viewIssues.push('表头禁止使用斜杠合并独立业务字段');
    }
    if (/<(?:br|small)\b/.test(table)) {
      viewIssues.push('桌面表格单元格禁止用 br 或 small 堆叠为两行');
    }
    if (/\b(?:v2-table-stack|v2-renewal-account|v2-topup-records-account)\b/.test(table)) {
      viewIssues.push('桌面表格禁止使用堆叠单元格样式');
    }
    if (!isOptionsView && /<V2TableColumn\b[^>]*\blabel=["']排序["']/.test(table)) {
      viewIssues.push('业务数据表禁止显示人工排序列');
    }
    if (/<V2TableColumn\b[^>]*\blabel=["']操作["']/.test(table)) {
      viewIssues.push('操作列禁止使用 V2TableColumn，必须使用 V2TableActionColumn');
    }
    for (const openingTag of table.match(/<V2TableColumn(?=\s|>)[\s\S]*?>/g) ?? []) {
      const kind = openingTag.match(/\bkind=["']([^"']+)["']/)?.[1];
      const widthPreset = openingTag.match(/\bwidth-preset=["']([^"']+)["']/)?.[1];
      const widthMode = openingTag.match(/\bwidth-mode=["']([^"']+)["']/)?.[1];
      const isExpandControl =
        /\btype=["']expand["']/.test(openingTag) && /(?<!min-)\bwidth=["']52["']/.test(openingTag);
      if (!kind || !validColumnKinds.has(kind)) {
        viewIssues.push('V2TableColumn 必须声明有效的语义 kind');
      }
      if (!isExpandControl && (!widthPreset || !validColumnWidthPresets.has(widthPreset))) {
        viewIssues.push('V2TableColumn 必须使用共享 width-preset');
      }
      if (/\bmin-width=["'][^"']+["']/.test(openingTag)) {
        viewIssues.push('V2TableColumn 禁止使用页面级 min-width');
      }
      if (/(?<!min-)\bwidth=["'][^"']+["']/.test(openingTag) && !isExpandControl) {
        viewIssues.push('V2TableColumn 仅展开控制列允许固定 52px width');
      }
      if (widthMode && !['fixed', 'flex'].includes(widthMode)) {
        viewIssues.push('V2TableColumn width-mode 只能为 fixed 或 flex');
      }
    }
    for (const openingTag of table.match(/<V2TableActionColumn(?=\s|>)[\s\S]*?>/g) ?? []) {
      const layout = openingTag.match(/\blayout=["']([^"']+)["']/)?.[1];
      if (!layout || !validActionLayouts.has(layout)) {
        viewIssues.push('V2TableActionColumn 必须使用 icon、single、double、triple 或 wide 档位');
      }
    }
  }

  if (
    source.includes('<V2TableColumn') &&
    !/import\s+V2TableColumn\s+from\s+['"]@\/v2\/components\/V2TableColumn\.vue['"]/.test(source)
  ) {
    viewIssues.push('使用语义列时必须显式导入 V2TableColumn');
  }
  if (
    source.includes('<V2TableActionColumn') &&
    !/import\s+V2TableActionColumn\s+from\s+['"]@\/v2\/components\/V2TableActionColumn\.vue['"]/.test(
      source
    )
  ) {
    viewIssues.push('使用操作列时必须显式导入 V2TableActionColumn');
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

function extractActionLayouts(source) {
  return [...source.matchAll(/<V2TableActionColumn\b[^>]*\blayout=["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
}

function extractFeatureColumnsBlock(source) {
  return source.match(/columns:\s*\[([\s\S]*?)\n\s*\],\n\s*loadView:/)?.[1] ?? '';
}

function extractPrismaModel(source, modelName) {
  return source.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
}

function runSelfTests() {
  const valid = `
    <el-table show-overflow-tooltip>
      <V2TableColumn kind="identifier" width-preset="identifier" label="账号" />
      <V2TableActionColumn layout="triple"><AppButton>编辑</AppButton></V2TableActionColumn>
    </el-table>
    <script setup>
    import V2TableColumn from '@/v2/components/V2TableColumn.vue';
    import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
    </script>
  `;
  assert.deepEqual(validateViewSource(valid, false), []);
  for (const invalid of [
    '<el-table><el-table-column label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" label="账号 / 国家" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" label="账号"><small>国家</small></V2TableColumn></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" label="排序" /></el-table>',
    '<el-table show-overflow-tooltip><div class="v2-table-stack"></div></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" label="操作" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="custom" label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" min-width="140" label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableColumn kind="text" width-preset="custom" label="账号" /></el-table>',
    '<el-table show-overflow-tooltip><V2TableActionColumn /></el-table>',
    '<el-table show-overflow-tooltip><V2TableActionColumn layout="custom" /></el-table>'
  ]) {
    assert.ok(validateViewSource(invalid, false).length > 0);
  }
  assert.deepEqual(
    validateViewSource(
      `<el-table show-overflow-tooltip><V2TableColumn kind="numeric" width-preset="compact" label="排序" /></el-table>
       <script setup>
       import V2TableColumn from '@/v2/components/V2TableColumn.vue';
       </script>`,
      true
    ),
    []
  );

  const validActionColumn = `
    <el-table-column
      label="操作"
      :width="V2_TABLE_ACTION_COLUMN_WIDTH[layout]"
      fixed="right"
      align="right"
      header-align="right"
    >
      <div class="v2-table-actions" :data-action-layout="layout"></div>
    </el-table-column>
  `;
  assert.deepEqual(validateActionColumnSource(validActionColumn), []);
  assert.ok(validateActionColumnSource(validActionColumn.replace('fixed="right"', '')).length > 0);

  const validActionStyles = `
    .v2-table-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: nowrap;
    }
    .v2-table-actions .el-button + .el-button { margin-left: 0; }
  `;
  assert.deepEqual(validateActionStyleSource(validActionStyles), []);
  assert.ok(
    validateActionStyleSource(
      validActionStyles.replace('.v2-table-actions .el-button + .el-button { margin-left: 0; }', '')
    ).some((issue) => issue.includes('默认边距'))
  );
}

function validateActionStyleSource(source) {
  const styleIssues = [];
  if (!/\.v2-table-actions[\s\S]*?flex-wrap:\s*nowrap/.test(source)) {
    styleIssues.push('操作按钮组未强制桌面端单行');
  }
  if (!/\.v2-table-actions[\s\S]*?justify-content:\s*flex-end/.test(source)) {
    styleIssues.push('操作按钮组未靠右对齐');
  }
  if (!/\.v2-table-actions \.el-button \+ \.el-button[\s\S]*?margin-left:\s*0/.test(source)) {
    styleIssues.push('操作按钮组未清除 Element Plus 相邻按钮默认边距');
  }
  return styleIssues;
}

function validateTableColumnSource(source) {
  return [
    'ElTableColumn',
    'V2_TABLE_COLUMN_ALIGNMENT[props.kind]',
    'getV2TableColumnWidthProps(props.kind, widthPreset, props.widthMode)',
    'align:',
    'headerAlign:',
    'getV2TableColumnClass(props.kind)'
  ]
    .filter((snippet) => !source.includes(snippet))
    .map((snippet) => `缺少 ${snippet}`);
}

function validateActionColumnSource(source) {
  return [
    'label="操作"',
    ':width="V2_TABLE_ACTION_COLUMN_WIDTH[layout]"',
    'fixed="right"',
    'align="right"',
    'header-align="right"',
    'class="v2-table-actions"',
    ':data-action-layout="layout"'
  ]
    .filter((snippet) => !source.includes(snippet))
    .map((snippet) => `缺少 ${snippet}`);
}

function read(projectPath) {
  return readFileSync(path.join(rootDir, projectPath), 'utf8');
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
