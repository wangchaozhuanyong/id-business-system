#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import ts from 'typescript';

const rootDir = process.cwd();
const featuresRoot = path.join(rootDir, 'apps/admin/src/v2/features');
const v2Root = path.join(rootDir, 'apps/admin/src/v2');
const schemasPath = 'apps/admin/src/v2/features/tableSchemas.ts';
const tableComponentPath = 'apps/admin/src/v2/components/V2Table.vue';
const tableColumnPath = 'apps/admin/src/v2/components/V2TableColumn.vue';
const controlColumnPath = 'apps/admin/src/v2/components/V2TableControlColumn.vue';
const actionColumnPath = 'apps/admin/src/v2/components/V2TableActionColumn.vue';
const layoutFixturePath = 'apps/admin/src/v2/testing/V2TableActionLayoutFixture.vue';
const sanctionedRawColumnFiles = new Set([tableColumnPath, controlColumnPath, actionColumnPath]);
const tableStylePath = 'apps/admin/src/v2/styles/v2.css';
const recordsStylePath = 'apps/admin/src/v2/styles/records.css';
const validKinds = new Set(['text', 'identifier', 'index', 'numeric', 'date', 'status']);
const validPresets = new Set([
  'index',
  'compact',
  'standard',
  'wide',
  'dateTime',
  'identifier',
  'longText'
]);
const validActionLayouts = new Set(['icon', 'single', 'double', 'triple', 'wide']);
const positionalKeyPattern = /^(?:text|identifier|index|numeric|date|status|control)-\d+$/;
const issues = [];

const schemaRegistry = loadSchemaRegistry();
const schemaByExpression = new Map();
for (const [group, schemas] of Object.entries(schemaRegistry.v2TableSchemas)) {
  for (const [name, schema] of Object.entries(schemas)) {
    schemaByExpression.set(`v2TableSchemas.${group}.${name}`, schema);
  }
}

validateSchemaRegistry(schemaRegistry, schemaByExpression);
validateFeatureManifests();

let businessTableCount = 0;
let fixtureTableCount = 0;
let actionColumnCount = 0;
const consumedSchemas = new Map();
for (const file of walk(v2Root).filter((target) => target.endsWith('.vue'))) {
  const projectPath = path.relative(rootDir, file);
  const source = read(projectPath);
  const template = parseSfc(source, { filename: projectPath }).descriptor.template;
  if (!template) continue;
  const ast = parseTemplate(template.content, { comments: false });
  const tableSchemasInFile = [];
  const mobileClaims = new Map();

  walkTemplate(ast, (node) => {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (node.tag === 'el-table') {
      issues.push(`${projectPath}: 禁止原始 <el-table>，必须显式使用 V2Table`);
      return;
    }
    if (node.tag === 'el-table-column' && !sanctionedRawColumnFiles.has(projectPath)) {
      issues.push(`${projectPath}: 禁止原始 <el-table-column>，必须使用共享 schema 列组件`);
      return;
    }
    if (hasStaticClass(node, 'v2-records-mobile-list')) {
      collectMobileClaims(node, projectPath, mobileClaims);
    }
    if (node.tag !== 'V2Table') return;
    if (projectPath === layoutFixturePath) fixtureTableCount += 1;
    else businessTableCount += 1;
    const schemaExpression = validateTableNode(node, projectPath, consumedSchemas);
    if (schemaExpression) tableSchemasInFile.push(schemaExpression);
    actionColumnCount += collectOwnedColumns(node).filter(
      (column) => column.tag === 'V2TableActionColumn'
    ).length;
  });
  validateMobileContracts(projectPath, tableSchemasInFile, mobileClaims);
  validateMobileVisibility(projectPath, source, mobileClaims);
}

for (const schemaExpression of schemaByExpression.keys()) {
  const consumers = consumedSchemas.get(schemaExpression) ?? [];
  if (consumers.length === 0)
    issues.push(`${schemasPath}: ${schemaExpression} 没有真实 V2Table 消费者`);
  if (consumers.length > 1) {
    issues.push(`${schemasPath}: ${schemaExpression} 被多张表重复消费: ${consumers.join('、')}`);
  }
}

validateSharedImplementation();
validateBusinessSortRules();
runSelfTests();

if (issues.length) {
  console.error('V2 table standard check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      businessTables: businessTableCount,
      fixtureTables: fixtureTableCount,
      registeredSchemas: schemaByExpression.size,
      actionColumns: actionColumnCount,
      layout: 'fixed',
      responsiveColumns: 'proportional-min-width',
      mobileBreakpoint: 900
    })
  );
}

function loadSchemaRegistry() {
  const source = read(schemasPath)
    .replace(/^import[^\n]+\n/m, '')
    .replace('const table = defineV2TableSchema;', 'const table = (schema) => schema;')
    .replaceAll('export const ', 'const ')
    .replaceAll(' as const', '');
  return new Function(`${source}\nreturn { v2TableSchemas, v2TablesByFeature };`)();
}

function validateSchemaRegistry(registry, schemas) {
  const ids = new Set();
  const objectsInFeatureRegistry = new Set(Object.values(registry.v2TablesByFeature).flat());
  for (const [schemaExpression, schema] of schemas) {
    if (!schema.id || ids.has(schema.id))
      issues.push(`${schemasPath}: 重复或空 schema id ${schema.id ?? ''}`);
    ids.add(schema.id);
    if (!objectsInFeatureRegistry.has(schema)) {
      issues.push(`${schemasPath}: ${schemaExpression} 未登记到 v2TablesByFeature`);
    }
    if (!['primary', 'secondary', 'embedded'].includes(schema.role)) {
      issues.push(`${schemasPath}: ${schemaExpression} role 无效`);
    }
    if (!['cards', 'scroll'].includes(schema.mobileMode)) {
      issues.push(`${schemasPath}: ${schemaExpression} mobileMode 无效`);
    }
    if (schema.role === 'primary' && !schema.rowKey) {
      issues.push(`${schemasPath}: ${schemaExpression} 主表必须声明 rowKey`);
    }
    if (!Array.isArray(schema.columns) || schema.columns.length === 0) {
      issues.push(`${schemasPath}: ${schemaExpression} 必须有非空 columns 契约`);
      continue;
    }

    const keys = new Set();
    let seenNonStart = false;
    let seenEnd = false;
    let fluidDataColumns = 0;
    schema.columns.forEach((column, index) => {
      if (!column.key || keys.has(column.key)) {
        issues.push(`${schemasPath}: ${schemaExpression} 列 key 空值或重复: ${column.key ?? ''}`);
      }
      keys.add(column.key);
      if (positionalKeyPattern.test(column.key)) {
        issues.push(`${schemasPath}: ${schemaExpression}.${column.key} 禁止位置型合成 key`);
      }
      if (column.pin === 'start') {
        if (seenNonStart)
          issues.push(`${schemasPath}: ${schemaExpression} start 固定列必须是连续前缀`);
      } else {
        seenNonStart = true;
      }
      if (column.pin === 'end') seenEnd = true;
      else if (seenEnd) issues.push(`${schemasPath}: ${schemaExpression} end 固定列必须是连续后缀`);

      if (column.kind === 'actions') {
        if (index !== schema.columns.length - 1 || column.pin !== 'end') {
          issues.push(`${schemasPath}: ${schemaExpression} 操作列必须唯一位于最后并固定 end`);
        }
        if (!validActionLayouts.has(column.layout)) {
          issues.push(`${schemasPath}: ${schemaExpression} 操作列 layout 无效`);
        }
      } else if (column.kind === 'control') {
        const expectedWidth =
          column.control === 'selection' ? 46 : column.control === 'expand' ? 52 : null;
        if (expectedWidth === null || column.width !== expectedWidth) {
          issues.push(`${schemasPath}: ${schemaExpression}.${column.key} 控制列宽度无效`);
        }
      } else {
        if (!validKinds.has(column.kind) || !validPresets.has(column.widthPreset)) {
          issues.push(
            `${schemasPath}: ${schemaExpression}.${column.key} 数据列语义或 widthPreset 无效`
          );
        }
        if (column.kind !== 'index' && !column.pin) fluidDataColumns += 1;
      }
    });
    if (fluidDataColumns === 0) {
      issues.push(`${schemasPath}: ${schemaExpression} 至少需要一个弹性数据列`);
    }
  }
}

function validateFeatureManifests() {
  const manifestFiles = readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(featuresRoot, entry.name, 'manifest.ts'))
    .filter(existsSync);

  for (const file of manifestFiles) {
    const projectPath = path.relative(rootDir, file);
    const source = read(projectPath);
    const ast = ts.createSourceFile(
      projectPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    let featureObject = null;
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'defineV2Feature' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        featureObject = node.arguments[0];
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (!featureObject) {
      issues.push(`${projectPath}: 未找到 defineV2Feature`);
      continue;
    }
    const properties = new Map(
      featureObject.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => [property.name.getText(ast).replaceAll(/["']/g, ''), property])
    );
    const key = properties.get('key')?.initializer.getText(ast).replaceAll("'", '');
    if (properties.has('columns')) issues.push(`${projectPath}: manifest 禁止复制 columns`);
    const tablesExpression = properties.get('tables')?.initializer.getText(ast);
    if (!key || tablesExpression !== `v2TablesByFeature['${key}']`) {
      issues.push(`${projectPath}: tables 必须引用 v2TablesByFeature 的同 feature schema`);
    }
  }
}

function validateTableNode(tableNode, projectPath, consumedSchemas) {
  const schemaExpression = boundExpression(tableNode, 'schema');
  if (!schemaExpression) {
    issues.push(`${projectPath}: V2Table 必须显式绑定 schema`);
    return null;
  }
  const schema = schemaByExpression.get(schemaExpression);
  const columns = collectOwnedColumns(tableNode);

  for (const columnNode of columns) {
    for (const forbidden of [
      'kind',
      'label',
      'width-preset',
      'width-mode',
      'width',
      'min-width',
      'fixed',
      'layout',
      'control'
    ]) {
      if (hasProp(columnNode, forbidden)) {
        issues.push(`${projectPath}: ${columnNode.tag} 禁止页面级 ${forbidden}，必须来自 schema`);
      }
    }
  }

  if (!schema) {
    if (projectPath !== layoutFixturePath && !schemaExpression.startsWith('fixtureSchemas.')) {
      issues.push(`${projectPath}: 未登记的 schema ${schemaExpression}`);
    }
    return schemaExpression;
  }
  const consumers = consumedSchemas.get(schemaExpression) ?? [];
  consumers.push(projectPath);
  consumedSchemas.set(schemaExpression, consumers);

  if (columns.length !== schema.columns.length) {
    issues.push(
      `${projectPath}: ${schemaExpression} 模板列 ${columns.length} 与 schema 列 ${schema.columns.length} 不一致`
    );
  }
  columns.forEach((columnNode, index) => {
    const expectedDefinition = `${schemaExpression}.columns[${index}]`;
    if (boundExpression(columnNode, 'definition') !== expectedDefinition) {
      issues.push(
        `${projectPath}: ${schemaExpression} 第 ${index + 1} 列必须引用 ${expectedDefinition}`
      );
    }
    const definition = schema.columns[index];
    const expectedTag =
      definition?.kind === 'actions'
        ? 'V2TableActionColumn'
        : definition?.kind === 'control'
          ? 'V2TableControlColumn'
          : 'V2TableColumn';
    if (definition && columnNode.tag !== expectedTag) {
      issues.push(`${projectPath}: ${schemaExpression}.${definition.key} 必须使用 ${expectedTag}`);
    }
  });

  const plainRowKey = staticAttribute(tableNode, 'row-key');
  const bindingRowKey = boundExpression(tableNode, 'row-key');
  if (schema.rowKey?.kind === 'path' && (plainRowKey || bindingRowKey)) {
    issues.push(
      `${projectPath}: ${schemaExpression} path rowKey 由 V2Table 注入，页面禁止重复 row-key`
    );
  } else if (schema.rowKey?.kind === 'binding' && bindingRowKey !== schema.rowKey.value) {
    issues.push(`${projectPath}: ${schemaExpression} :row-key 必须为 ${schema.rowKey.value}`);
  } else if (schema.rowKey === null && (plainRowKey || bindingRowKey)) {
    issues.push(`${projectPath}: ${schemaExpression} schema 必须声明已使用的 rowKey`);
  }
  return schemaExpression;
}

function collectOwnedColumns(tableNode) {
  const result = [];
  function visit(node) {
    if (node.type !== NodeTypes.ELEMENT) return;
    if (node !== tableNode && node.tag === 'V2Table') return;
    if (['V2TableColumn', 'V2TableActionColumn', 'V2TableControlColumn'].includes(node.tag)) {
      result.push(node);
      return;
    }
    node.children?.forEach(visit);
  }
  tableNode.children.forEach(visit);
  return result;
}

function validateSharedImplementation() {
  const componentSource = read(tableComponentPath);
  const columnSource = read(tableColumnPath);
  const controlSource = read(controlColumnPath);
  const actionSource = read(actionColumnPath);
  const styleSource = read(tableStylePath);
  const recordsStyleSource = read(recordsStylePath);
  const viteSource = read('apps/admin/vite.config.ts');
  const fixtureSource = read(layoutFixturePath);

  for (const [pattern, message] of [
    [/fit:\s*true/, 'V2Table 必须 fit=true'],
    [/flexible:\s*true/, 'V2Table 必须 flexible=true'],
    [/tableLayout:\s*'fixed'/, 'V2Table 必须使用 fixed 布局'],
    [/scrollbarAlwaysOn:\s*true/, 'V2Table 必须常显滚动条'],
    [/showOverflowTooltip:\s*true/, 'V2Table 必须统一溢出提示'],
    [/V2TableColumnSettings/, 'V2Table 必须统一提供列显示设置入口'],
    [/V2_TABLE_VISIBILITY_CONTEXT/, 'V2Table 必须提供共享列可见性上下文'],
    [
      /props\.schema\.rowKey\?\.kind === 'path'[\s\S]*?delete tableAttrs\['row-key'\][\s\S]*?tableAttrs\.rowKey = props\.schema\.rowKey\.value/,
      'path rowKey 必须由 schema 强制注入'
    ],
    [/scrollToStart\(\);[\s\S]*?resetViewScroll/, 'schema/viewKey 变化必须同步归零并 nextTick 校正']
  ]) {
    if (!pattern.test(componentSource)) issues.push(`${tableComponentPath}: ${message}`);
  }
  if (!/columnKey:\s*props\.definition\.key/.test(columnSource)) {
    issues.push(`${tableColumnPath}: 数据列必须传递 schema columnKey`);
  }
  if (!/visibility\.isColumnVisible\(props\.definition\.key\)/.test(columnSource)) {
    issues.push(`${tableColumnPath}: 数据列必须遵守共享列可见性设置`);
  }
  if (!/definition:[\s\S]{0,100}?required:\s*true/.test(columnSource)) {
    issues.push(`${tableColumnPath}: definition 必须为 required`);
  }
  if (/\n\s+(?:kind|widthPreset|widthMode):\s*\{/.test(columnSource)) {
    issues.push(`${tableColumnPath}: 禁止保留 kind/widthPreset/widthMode legacy props`);
  }
  for (const [source, projectPath] of [
    [controlSource, controlColumnPath],
    [actionSource, actionColumnPath]
  ]) {
    if (!/:column-key="definition\.key"/.test(source)) {
      issues.push(`${projectPath}: 必须传递 schema columnKey`);
    }
  }
  if (
    /definition\?:/.test(controlSource) ||
    !/definition:\s*V2TableControlColumnDefinition/.test(controlSource)
  ) {
    issues.push(`${controlColumnPath}: definition 必须为唯一必填契约`);
  }
  if (/definition\?:|\blayout\?:/.test(actionSource)) {
    issues.push(`${actionColumnPath}: 禁止 optional definition 或 layout legacy prop`);
  }
  for (const [pattern, message] of [
    [/\.v2-unified-table[\s\S]*?container-type:\s*inline-size/, '缺少容器查询上下文'],
    [/clamp\(8px,\s*1cqi,\s*12px\)/, '单元格间距未连续自适应'],
    [/scroll-behavior:\s*auto/, '表格横向滚动必须禁用 smooth']
  ]) {
    if (!pattern.test(styleSource)) issues.push(`${tableStylePath}: ${message}`);
  }
  if (!/data-mobile-mode='cards'/.test(recordsStyleSource)) {
    issues.push(`${recordsStylePath}: 900px 移动切换必须由 schema mobileMode 控制`);
  }
  if (/transition:\s*grid-template-columns/.test(styleSource)) {
    issues.push(`${tableStylePath}: 禁止侧栏宽度过渡连续触发表格重排`);
  }
  if (/v2TableResolver|V2ElTable|exclude:\s*\/\^ElTable\$\//.test(viteSource)) {
    issues.push('apps/admin/vite.config.ts: 禁止隐式 ElTable 替换 resolver');
  }
  if (existsSync(path.join(rootDir, 'apps/admin/src/v2/components/V2ElTable.vue'))) {
    issues.push('apps/admin/src/v2/components/V2ElTable.vue: 旧适配器必须删除');
  }
  for (const [pattern, message] of [
    [/Object\.values\(v2TableSchemas\)\.flatMap/, '必须从最终 schema registry 动态生成验收夹具'],
    [/v-for="schema in registeredSchemas"/, '必须遍历所有最终 schema'],
    [/:data-schema-fixture="schema\.id"/, '每个 schema 验收夹具必须暴露稳定 id'],
    [/:schema="lifecycleSchema"/, '滚动生命周期夹具必须支持 schema 切换']
  ]) {
    if (!pattern.test(fixtureSource)) issues.push(`${layoutFixturePath}: ${message}`);
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
    if (
      !new RegExp(`\\b${preset}:\\s*${width}\\b`).test(
        read('apps/admin/src/v2/components/tableColumn.ts')
      )
    ) {
      issues.push(`apps/admin/src/v2/components/tableColumn.ts: ${preset} 必须为 ${width}`);
    }
  }
  for (const [layout, width] of Object.entries({
    icon: 76,
    single: 126,
    double: 180,
    triple: 260,
    wide: 272
  })) {
    if (
      !new RegExp(`\\b${layout}:\\s*${width}\\b`).test(
        read('apps/admin/src/v2/components/tableActionLayout.ts')
      )
    ) {
      issues.push(`apps/admin/src/v2/components/tableActionLayout.ts: ${layout} 必须为 ${width}`);
    }
  }
}

function validateBusinessSortRules() {
  const prismaPath = 'apps/api/prisma-mysql/schema.prisma';
  const prismaSource = read(prismaPath);
  for (const modelName of [
    'IdBusinessV2Customer',
    'IdBusinessV2Account',
    'IdBusinessV2Order',
    'IdBusinessV2Activation'
  ]) {
    const block =
      prismaSource.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    if (!block) issues.push(`${prismaPath}: 缺少模型 ${modelName}`);
    else if (/\bsortOrder\b/.test(block)) issues.push(`${prismaPath}: ${modelName} 禁止 sortOrder`);
  }
  const optionBlock = prismaSource.match(/model IdBusinessV2Option \{[\s\S]*?\n\}/)?.[0] ?? '';
  if (!/\bsortOrder\s+Int\b/.test(optionBlock))
    issues.push(`${prismaPath}: 选项设置必须保留 sortOrder`);

  const optionSchema = schemaRegistry.v2TableSchemas.options.main;
  if (
    !optionSchema.columns.some((column) => column.key === 'sortOrder' && column.label === '排序')
  ) {
    issues.push(`${schemasPath}: 选项设置必须保留排序列`);
  }
}

function runSelfTests() {
  const ast = parseTemplate(
    '<V2Table :schema="v2TableSchemas.demo.main"><V2TableColumn :definition="v2TableSchemas.demo.main.columns[0]" /></V2Table>'
  );
  const table = ast.children[0];
  assert.equal(boundExpression(table, 'schema'), 'v2TableSchemas.demo.main');
  assert.equal(staticAttribute(table, 'row-key'), null);
  assert.equal(collectOwnedColumns(table).length, 1);
}

function collectMobileClaims(node, projectPath, claims) {
  const expression = boundExpression(node, 'data-mobile-for');
  if (!expression) {
    issues.push(`${projectPath}: 移动卡片列表必须绑定 data-mobile-for="schema.id"`);
    return;
  }
  const references = [
    ...expression.matchAll(/\bv2TableSchemas\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.id\b/g)
  ].map((match) => match[0].slice(0, -3));
  if (references.length === 0) {
    issues.push(`${projectPath}: data-mobile-for 必须直接引用 table schema id`);
  }
  for (const reference of references) {
    claims.set(reference, (claims.get(reference) ?? 0) + 1);
  }
}

function validateMobileContracts(projectPath, tableExpressions, claims) {
  const tables = new Set(tableExpressions);
  for (const schemaExpression of tableExpressions) {
    const schema = schemaByExpression.get(schemaExpression);
    if (!schema || schema.mobileMode !== 'cards') continue;
    if (claims.get(schemaExpression) !== 1) {
      issues.push(
        `${projectPath}: ${schemaExpression} cards 模式必须与唯一 data-mobile-for 一一对应`
      );
    }
  }
  for (const [schemaExpression, count] of claims) {
    const schema = schemaByExpression.get(schemaExpression);
    if (!tables.has(schemaExpression)) {
      issues.push(`${projectPath}: data-mobile-for 引用了同文件不存在的 ${schemaExpression}`);
    } else if (schema?.mobileMode !== 'cards') {
      issues.push(`${projectPath}: ${schemaExpression} 不是 cards 模式，禁止绑定移动卡片列表`);
    }
    if (count !== 1) {
      issues.push(`${projectPath}: ${schemaExpression} data-mobile-for 重复 ${count} 次`);
    }
  }
}

function validateMobileVisibility(projectPath, source, claims) {
  if (claims.size === 0) return;
  if (!source.includes('v-v2-column-visibility') && !/<V2[A-Za-z0-9]*MobileList\b/.test(source)) {
    issues.push(`${projectPath}: 移动卡片字段必须接入共享列可见性设置`);
  }
}

function walkTemplate(node, visitor) {
  visitor(node);
  node.children?.forEach((child) => walkTemplate(child, visitor));
  if (node.branches) {
    for (const branch of node.branches)
      branch.children?.forEach((child) => walkTemplate(child, visitor));
  }
}

function hasProp(node, name) {
  return node.props.some((property) => {
    if (property.type === NodeTypes.ATTRIBUTE) return property.name === name;
    return (
      property.name === 'bind' &&
      property.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      property.arg.content === name
    );
  });
}

function staticAttribute(node, name) {
  const property = node.props.find(
    (candidate) => candidate.type === NodeTypes.ATTRIBUTE && candidate.name === name
  );
  return property?.value?.content ?? null;
}

function hasStaticClass(node, className) {
  const value = staticAttribute(node, 'class');
  return value?.split(/\s+/).includes(className) ?? false;
}

function boundExpression(node, name) {
  const property = node.props.find(
    (candidate) =>
      candidate.type === NodeTypes.DIRECTIVE &&
      candidate.name === 'bind' &&
      candidate.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      candidate.arg.content === name
  );
  return property?.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? property.exp.content.trim() : null;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

function read(projectPath) {
  return readFileSync(path.join(rootDir, projectPath), 'utf8');
}
