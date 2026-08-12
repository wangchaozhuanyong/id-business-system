#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { NodeTypes } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';

const rootDir = process.cwd();
const sourceRoot = path.join(rootDir, 'apps/admin/src');
const failures = [];
const visibleAttributeNames = new Set([
  'aria-label',
  'cancel-text',
  'confirm-text',
  'description',
  'empty-text',
  'help',
  'inactive-text',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title'
]);
const visiblePropertyNames = new Set([
  'activeText',
  'ariaLabel',
  'cancelButtonText',
  'cancelText',
  'confirmButtonText',
  'confirmText',
  'description',
  'emptyText',
  'eyebrow',
  'help',
  'inactiveText',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title'
]);
const approvedTerms = new Set([
  'API',
  'Apple ID',
  'Binance',
  'CIDR',
  'Cloudflare',
  'CNY',
  'CSV',
  'ECB',
  'Excel',
  'Firefox',
  'GB',
  'HTTP',
  'HTTPS',
  'ID',
  'IP',
  'IPv4',
  'IPv6',
  'JSON',
  'KB',
  'Logo',
  'MB',
  'MFA',
  'MYR',
  'macOS',
  'ms',
  'OKX',
  'P2P',
  'PDF',
  'Prisma',
  'px',
  'QQ',
  'Redis',
  'RMB',
  'Safari',
  'SQL',
  'Supabase',
  'TRC20',
  'URL',
  'USD',
  'USDT',
  'UTC',
  'WhatsApp',
  'Windows',
  'Android',
  'Chrome',
  'iOS'
]);
const approvedTokens = new Set(
  [...approvedTerms].flatMap((term) => term.split(/\s+/)).filter((term) => term !== 'Apple')
);
const ignoredTemplateTags = new Set(['code', 'kbd', 'pre']);

for (const file of walk(sourceRoot)) {
  const projectPath = path.relative(rootDir, file);
  if (projectPath.includes('/testing/') || projectPath.endsWith('.spec.ts')) continue;

  if (file.endsWith('.vue')) checkVueFile(file, projectPath);
  if (file.endsWith('.ts')) checkTypeScript(readFileSync(file, 'utf8'), projectPath, 0);
}

requireDocumentationRules();
runSelfTests();

if (failures.length) {
  console.error(`V2 中文界面语言检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('V2 中文界面语言检查通过。');

function checkVueFile(file, projectPath) {
  const source = readFileSync(file, 'utf8');
  const { descriptor, errors } = parseSfc(source, { filename: projectPath });
  if (errors.length) {
    failures.push(`${projectPath}: 无法解析 Vue 单文件组件`);
    return;
  }

  if (descriptor.template?.ast) visitTemplateNode(descriptor.template.ast, projectPath, false);
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) checkTypeScript(block.content, projectPath, Math.max(0, block.loc.start.line - 1));
  }
}

function visitTemplateNode(node, projectPath, ignored) {
  const currentIgnored =
    ignored || (node.type === NodeTypes.ELEMENT && ignoredTemplateTags.has(node.tag));

  if (!currentIgnored && node.type === NodeTypes.TEXT) {
    checkVisibleText(node.content, projectPath, node.loc.start.line, '模板文字');
  }

  if (!currentIgnored && node.type === NodeTypes.INTERPOLATION) {
    checkInternalKeyExpression(
      node.content.loc.source,
      projectPath,
      node.loc.start.line,
      '模板插值'
    );
  }

  if (!currentIgnored && node.type === NodeTypes.ELEMENT) {
    for (const prop of node.props) {
      if (prop.type === NodeTypes.ATTRIBUTE && visibleAttributeNames.has(prop.name)) {
        checkVisibleText(
          prop.value?.content ?? '',
          projectPath,
          prop.loc.start.line,
          `${prop.name} 属性`
        );
        continue;
      }
      if (prop.type !== NodeTypes.DIRECTIVE || !prop.exp) continue;

      const argument = prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.arg.content : '';
      const isVisibleBinding = prop.name === 'bind' && visibleAttributeNames.has(argument);
      if (prop.name === 'text' || prop.name === 'html' || isVisibleBinding) {
        checkInternalKeyExpression(
          prop.exp.loc.source,
          projectPath,
          prop.loc.start.line,
          '可见属性绑定'
        );
        const staticText = readStaticExpression(prop.exp.loc.source);
        if (staticText !== null) {
          checkVisibleText(staticText, projectPath, prop.loc.start.line, '可见属性绑定');
        }
      }
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) visitTemplateNode(child, projectPath, currentIgnored);
  }
}

function checkTypeScript(source, projectPath, lineOffset) {
  const sourceFile = ts.createSourceFile(
    projectPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = readPropertyName(node.name);
      if (propertyName && visiblePropertyNames.has(propertyName)) {
        const value = readStaticStringNode(node.initializer);
        if (value !== null)
          reportTypeScriptText(value, node.initializer, sourceFile, projectPath, lineOffset);
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      if (/^(?:ElMessage|ElNotification)\.(?:success|error|warning|info)$/.test(callee)) {
        checkCallArguments(node, [0], sourceFile, projectPath, lineOffset);
      }
      if (/^ElMessageBox\.(?:confirm|alert|prompt)$/.test(callee)) {
        checkCallArguments(node, [0, 1], sourceFile, projectPath, lineOffset);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function checkCallArguments(node, indexes, sourceFile, projectPath, lineOffset) {
  for (const index of indexes) {
    const argument = node.arguments[index];
    if (!argument) continue;
    const value = readStaticStringNode(argument);
    if (value !== null) reportTypeScriptText(value, argument, sourceFile, projectPath, lineOffset);
  }
}

function reportTypeScriptText(value, node, sourceFile, projectPath, lineOffset) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  checkVisibleText(value, projectPath, line + lineOffset + 1, '脚本文案');
}

function checkVisibleText(rawValue, projectPath, line, sourceKind) {
  const value = rawValue.replace(/\s+/g, ' ').trim();
  if (!value || !/[A-Za-z]/.test(value)) return;

  const internalIdentifier = findInternalIdentifier(value);
  if (internalIdentifier) {
    failures.push(
      `${projectPath}:${line}: ${sourceKind}包含内部字段名“${internalIdentifier}”，请先映射为中文标签`
    );
    return;
  }

  if (!/[\u3400-\u9fff]/u.test(value) && !isApprovedTechnicalText(value)) {
    failures.push(`${projectPath}:${line}: ${sourceKind}必须使用中文：“${truncate(value)}”`);
  }
}

function checkInternalKeyExpression(expression, projectPath, line, sourceKind) {
  if (/(?:\?\.)?\.\s*key\b|\[\s*['"]key['"]\s*\]/.test(expression)) {
    failures.push(
      `${projectPath}:${line}: ${sourceKind}不得直接展示内部 key，请使用已映射的中文 label`
    );
  }
}

function findInternalIdentifier(value) {
  for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    const token = match[0];
    if (approvedTokens.has(token)) continue;
    if (/^[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) return token;
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(token)) return token;
  }
  return '';
}

function isApprovedTechnicalText(value) {
  if (approvedTerms.has(value)) return true;
  if (/^(?:https?:\/\/|\/)[^\s]+$/.test(value)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return true;
  if (/^(?:YYYY|YY|MM|DD|HH|mm|ss)(?:[\s:/.-]+(?:YYYY|YY|MM|DD|HH|mm|ss))*$/.test(value)) {
    return true;
  }
  if (/^(?:⌘|Ctrl|Alt|Shift|Enter|Esc|Tab|Space)(?:\s*\+?\s*[A-Z0-9]+)*$/.test(value)) {
    return true;
  }

  const withoutApprovedPhrase = value.replaceAll('Apple ID', '');
  const words = withoutApprovedPhrase.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  return words.length > 0 && words.every((word) => approvedTokens.has(word));
}

function readStaticExpression(source) {
  const sourceFile = ts.createSourceFile(
    'binding.ts',
    `const value = ${source}`,
    ts.ScriptTarget.Latest,
    true
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return null;
  return readStaticStringNode(statement.declarationList.declarations[0]?.initializer);
}

function readStaticStringNode(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function readPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return '';
}

function requireDocumentationRules() {
  const required = {
    'AGENTS.md': ['中文界面不得直接展示内部字段 key', 'npm run check:v2-ui-language'],
    'docs/UI_DESIGN.md': ['中文界面语言', '业务术语白名单', '内部字段名']
  };
  for (const [projectPath, snippets] of Object.entries(required)) {
    const source = readFileSync(path.join(rootDir, projectPath), 'utf8');
    for (const snippet of snippets) {
      if (!source.includes(snippet)) failures.push(`${projectPath}: 缺少中文界面约束“${snippet}”`);
    }
  }
}

function runSelfTests() {
  const cases = [
    ['OPERATIONS CONTROL', false],
    ['orderNo', false],
    ['创建时间 createdAt', false],
    ['Apple ID', true],
    ['CNY / MYR', true],
    ['WhatsApp', true],
    ['经营控制台', true]
  ];
  for (const [value, expected] of cases) {
    const result =
      !findInternalIdentifier(value) &&
      (!/[A-Za-z]/.test(value) || /[\u3400-\u9fff]/u.test(value) || isApprovedTechnicalText(value));
    if (result !== expected) failures.push(`语言检查器自检失败：“${value}”`);
  }
}

function truncate(value) {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
}
