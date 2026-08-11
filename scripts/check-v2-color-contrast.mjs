#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const baseCssPath = path.join(rootDir, 'apps/admin/src/v2/styles/base.css');
const themePath = path.join(rootDir, 'apps/admin/src/v2/theme.ts');
const uiRulesPath = path.join(rootDir, 'docs/UI_DESIGN.md');
const baseCss = readFileSync(baseCssPath, 'utf8');
const themeSource = readFileSync(themePath, 'utf8');
const uiRules = readFileSync(uiRulesPath, 'utf8');
const failures = [];

const lightTokens = readCustomProperties(extractBlock(baseCss, ':root'));
const darkTokens = new Map(lightTokens);
for (const [name, value] of readCustomProperties(
  extractBlock(baseCss, "html[data-v2-theme='dark']")
)) {
  darkTokens.set(name, value);
}

const contrastPairs = [
  ['正文', '--v3-surface', '--v3-text', 4.5],
  ['默认按钮悬停', '--v3-surface-hover', '--v3-text', 4.5],
  ['默认按钮按下', '--v3-surface-3', '--v3-text', 4.5],
  ['主按钮', '--v3-primary-solid', '--v3-on-primary-solid', 4.5],
  ['主按钮悬停', '--v3-primary-solid-hover', '--v3-on-primary-solid', 4.5],
  ['柔和主按钮', '--v3-primary-soft', '--v3-on-primary-soft', 4.5],
  ['柔和主按钮悬停', '--v3-primary-soft', '--v3-primary-2', 4.5],
  ['成功实底', '--v3-success-solid', '--v3-on-success-solid', 4.5],
  ['成功柔和底', '--v3-success-soft', '--v3-success', 4.5],
  ['警告实底', '--v3-warning-solid', '--v3-on-warning-solid', 4.5],
  ['警告柔和底', '--v3-warning-soft', '--v3-warning', 4.5],
  ['危险实底', '--v3-danger-solid', '--v3-on-danger-solid', 4.5],
  ['危险柔和底', '--v3-danger-soft', '--v3-danger', 4.5],
  ['禁用按钮', '--v3-disabled-surface', '--v3-disabled-text', 4.5],
  ['侧栏正文', '--v3-sidebar', '--v3-sidebar-text', 4.5],
  ['侧栏次要文字', '--v3-sidebar', '--v3-sidebar-muted', 4.5],
  ['侧栏强调文字', '--v3-sidebar', '--v3-sidebar-text-strong', 4.5],
  ['焦点边界', '--v3-surface', '--v3-focus-color', 3]
];

for (const [theme, tokens] of [
  ['light', lightTokens],
  ['dark', darkTokens]
]) {
  for (const [label, backgroundToken, foregroundToken, minimum] of contrastPairs) {
    const background = resolveColorToken(tokens, backgroundToken, theme);
    const foreground = resolveColorToken(tokens, foregroundToken, theme);
    if (!background || !foreground) continue;
    const ratio = contrastRatio(background, foreground);
    if (ratio + Number.EPSILON < minimum) {
      failures.push(
        `${theme} ${label}: ${foregroundToken} ${foreground} / ${backgroundToken} ${background} = ${ratio.toFixed(2)}:1，低于 ${minimum}:1`
      );
    }
  }
}

const baseButtonRule = extractBlock(baseCss, '.app-button.el-button');
requireProperties('.app-button.el-button', baseButtonRule, [
  '--el-button-text-color',
  '--el-button-bg-color',
  '--el-button-border-color',
  '--el-button-hover-text-color',
  '--el-button-hover-bg-color',
  '--el-button-hover-border-color',
  '--el-button-active-text-color',
  '--el-button-active-bg-color',
  '--el-button-active-border-color',
  '--el-button-disabled-text-color',
  '--el-button-disabled-bg-color',
  '--el-button-disabled-border-color',
  '--el-button-outline-color',
  '--el-mask-color-extra-light'
]);

for (const variant of ['primary', 'soft', 'danger', 'success', 'ghost']) {
  const selector = `.app-button--${variant}.el-button`;
  const rule = extractBlock(baseCss, selector);
  requireProperties(selector, rule, [
    '--el-button-text-color',
    '--el-button-bg-color',
    '--el-button-border-color',
    '--el-button-hover-text-color',
    '--el-button-hover-bg-color',
    '--el-button-hover-border-color',
    '--el-button-active-text-color',
    '--el-button-active-bg-color',
    '--el-button-active-border-color'
  ]);

  if (/^\s*(?:color|background(?:-color)?|border-color)\s*:/m.test(rule)) {
    failures.push(
      `${selector}: 禁止直接覆盖 color/background/border-color，必须使用 Element Plus 状态变量`
    );
  }
}

if (!baseCss.includes("@import 'element-plus/theme-chalk/dark/css-vars.css';")) {
  failures.push('base.css: 必须引入 Element Plus 官方深色变量');
}

const elementThemeRule = extractBlock(baseCss, 'html[data-v2-theme]');
requireProperties('html[data-v2-theme]', elementThemeRule, [
  '--el-bg-color',
  '--el-bg-color-page',
  '--el-bg-color-overlay',
  '--el-text-color-primary',
  '--el-text-color-regular',
  '--el-text-color-secondary',
  '--el-text-color-placeholder',
  '--el-text-color-disabled',
  '--el-border-color',
  '--el-border-color-light',
  '--el-border-color-lighter',
  '--el-border-color-extra-light',
  '--el-fill-color',
  '--el-fill-color-light',
  '--el-fill-color-lighter',
  '--el-fill-color-extra-light',
  '--el-fill-color-blank',
  '--el-disabled-bg-color',
  '--el-disabled-text-color',
  '--el-disabled-border-color',
  '--el-box-shadow',
  '--el-box-shadow-light',
  '--el-mask-color'
]);

for (const snippet of [
  "root.classList.toggle('dark', theme === 'dark')",
  'root.dataset.v2Theme = theme',
  'root.style.colorScheme = theme'
]) {
  if (!themeSource.includes(snippet)) {
    failures.push(`theme.ts: 缺少统一主题同步逻辑“${snippet}”`);
  }
}

for (const snippet of [
  '彩色背景必须使用配套的 `on-*` 前景令牌',
  '按钮文字对比度不得低于 4.5:1',
  '图标、边框和焦点指示不得低于 3:1',
  'normal、hover、active、focus、disabled 和 loading',
  '`html.dark` 协议',
  '业务页面禁止为深色模式单独覆盖 Element Plus 组件背景'
]) {
  if (!uiRules.includes(snippet)) failures.push(`docs/UI_DESIGN.md: 缺少规则“${snippet}”`);
}

if (failures.length) {
  console.error(`V2 color contrast check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `V2 color contrast check passed (${contrastPairs.length} pairs x 2 themes, 6 button variants, Element Plus theme bridge).`
);

function extractBlock(source, selector) {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex === -1) {
    failures.push(`${path.relative(rootDir, baseCssPath)}: 缺少 ${selector}`);
    return '';
  }

  const openingBrace = source.indexOf('{', selectorIndex + selector.length);
  if (openingBrace === -1) {
    failures.push(`${path.relative(rootDir, baseCssPath)}: ${selector} 缺少规则体`);
    return '';
  }

  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  failures.push(`${path.relative(rootDir, baseCssPath)}: ${selector} 规则体未闭合`);
  return '';
}

function readCustomProperties(block) {
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((match) => [
      match[1],
      match[2].trim()
    ])
  );
}

function resolveColorToken(tokens, token, theme, seen = new Set()) {
  if (seen.has(token)) {
    failures.push(`${theme} ${token}: CSS 变量存在循环引用`);
    return null;
  }
  seen.add(token);

  const value = tokens.get(token);
  if (!value) {
    failures.push(`${theme} ${token}: 主题变量不存在`);
    return null;
  }

  const variableReference = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (variableReference) {
    return resolveColorToken(tokens, variableReference[1], theme, seen);
  }

  const normalized = normalizeHexColor(value);
  if (!normalized) {
    failures.push(`${theme} ${token}: 只允许可审计的十六进制颜色，当前为 ${value}`);
    return null;
  }
  return normalized;
}

function normalizeHexColor(value) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (!/^#[0-9a-f]{3}$/i.test(value)) return null;
  return `#${[...value.slice(1)].map((character) => character.repeat(2)).join('')}`.toLowerCase();
}

function contrastRatio(background, foreground) {
  const backgroundLuminance = relativeLuminance(background);
  const foregroundLuminance = relativeLuminance(foreground);
  return (
    (Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
    (Math.min(backgroundLuminance, foregroundLuminance) + 0.05)
  );
}

function relativeLuminance(color) {
  const channels = [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function requireProperties(selector, rule, properties) {
  for (const property of properties) {
    if (!new RegExp(`${escapeRegExp(property)}\\s*:`).test(rule)) {
      failures.push(`${selector}: 缺少 ${property}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
