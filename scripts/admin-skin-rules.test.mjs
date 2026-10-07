import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSharedSkinStyles } from './admin-skin-rules.mjs';

const page = 'apps/admin/src/v2/styles/records.css';
const base = 'apps/admin/src/v2/styles/base.css';

test('拒绝应用壳或页面定义基础弹层，包含组合选择器', () => {
  for (const selector of [
    '.el-drawer__footer',
    '.el-dialog',
    'html[data-v2-theme] .el-message-box__title',
    '.some-rule, .el-overlay .el-dialog__title',
    '.v2-form-drawer__footer',
    '.v2-horizontal-form .el-select'
  ]) {
    assert.match(inspectSharedSkinStyles(`${selector} { padding: 16px; }`, page)[0], /base.css/);
    assert.deepEqual(inspectSharedSkinStyles(`${selector} { padding: 16px; }`, base), []);
  }
});

test('保留业务布局、宽度和独立工作区的有界选择器', () => {
  assert.deepEqual(
    inspectSharedSkinStyles('.v2-records-list .el-tabs { min-width: 0; }', page),
    []
  );
});

test('业务按钮不能自定义皮肤，允许布局与更大的点击目标', () => {
  for (const property of [
    'color',
    'background',
    'font-size',
    'font-weight',
    'line-height',
    'border-color',
    'box-shadow',
    'transition'
  ]) {
    assert.match(
      inspectSharedSkinStyles(`.page .app-button { ${property}: inherit; }`, page)[0],
      /共享状态皮肤/
    );
  }
  assert.deepEqual(
    inspectSharedSkinStyles(
      '.page .app-button { width: 100%; min-height: 44px; margin-left: 0; }',
      page
    ),
    []
  );
  assert.deepEqual(inspectSharedSkinStyles('.app-button { font-size: 13px; }', base), []);
});

test('重复声明与后追加覆盖都报出原始行号', () => {
  for (const second of ['36px', '44px']) {
    const issues = inspectSharedSkinStyles(
      `.control { height: 36px; }\n.control { height: ${second}; }`,
      base
    );
    assert.equal(issues.length, 1);
    assert.match(issues[0], /首次在第 1 行/);
  }
});

test('同一个规则块内重复声明也不能作为补丁', () => {
  assert.equal(inspectSharedSkinStyles('.control { height: 36px; height: 44px; }', base).length, 1);
});

test('不同媒体、容器或层条件可定义各自尺寸', () => {
  assert.deepEqual(
    inspectSharedSkinStyles(
      '.control { height: 36px; } @media (max-width: 900px) { .control { height: 44px; } } @container (max-width: 600px) { .control { height: 48px; } }',
      base
    ),
    []
  );
});

test('同一媒体条件下重复追加仍被拒绝', () => {
  assert.equal(
    inspectSharedSkinStyles(
      '@media (max-width: 900px) { .control { height: 44px; } } @media (max-width: 900px) { .control { height: 48px; } }',
      base
    ).length,
    1
  );
});

test('深浅主题及不同动画保留独立规则', () => {
  assert.deepEqual(
    inspectSharedSkinStyles(
      "html[data-v2-theme='light'] { --v3-surface: white; } html[data-v2-theme='dark'] { --v3-surface: black; } @keyframes first { from { opacity: 0; } } @keyframes second { from { opacity: 1; } }",
      base
    ),
    []
  );
});
