#!/usr/bin/env node
/* global document, getComputedStyle, innerWidth */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.resolve(root, process.argv[2] ?? '.runtime/page-layout-acceptance');
assert.ok(out.startsWith(root + path.sep), '验收输出必须归入当前项目');
mkdirSync(out, { recursive: true });
const base = 'http://127.0.0.1:5399';
const groups = [
  'layout-contract',
  'accounts',
  'customers',
  'orders',
  'topups',
  'topup-records',
  'activations',
  'renewals',
  'employees',
  'roles',
  'security',
  'profile',
  'branding',
  'options',
  'finance-ledger',
  'finance-expenses',
  'analytics',
  'dashboard',
  'audit-logs',
  'business-monitoring',
  'data-governance',
  'system-monitoring'
];
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5399',
    '--strictPort'
  ],
  { cwd: path.join(root, 'apps/admin'), stdio: 'ignore' }
);
const checks = [],
  errors = [];
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, '布局验收服务器提前退出');
    if (
      await new Promise((resolve) => {
        const req = get(base, (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        });
        req.on('error', () => resolve(false));
      })
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue();
    assert.equal(route.request().method(), 'GET', '验收禁止业务写入');
    return route.fulfill({ json: { success: true, data: { items: [], total: 0 } } });
  });
  for (const dark of [false, true]) {
    for (const group of groups) {
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const entry =
          group === 'layout-contract' ? 'layout-contract-fixture' : `${group}-design-fixture`;
        await page.goto(`${base}/${entry}.html`);
        await page
          .locator('.v2-page-overview')
          .first()
          .waitFor()
          .catch((error) => {
            throw new Error(`${group} ${width}px: ${error.message}; runtime: ${errors.join('; ')}`);
          });
        await page.evaluate(async (dark) => {
          document.documentElement.dataset.v2Theme = dark ? 'dark' : 'light';
          document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
          document.documentElement.classList.toggle('dark', dark);
          await document.fonts.ready;
        }, dark);
        await page.waitForTimeout(120);
        const g = await page.evaluate(() => {
          const rect = (node) => {
            const b = node.getBoundingClientRect();
            return {
              x: b.x,
              y: b.y,
              right: b.right,
              bottom: b.bottom,
              width: b.width,
              height: b.height,
              center: b.y + b.height / 2
            };
          };
          const text = (node) => {
            if (!node) return null;
            const r = document.createRange();
            r.selectNodeContents(node);
            return rect({ getBoundingClientRect: () => r.getBoundingClientRect() });
          };
          const visible = (node) =>
            !node.closest('details:not([open]) .v2-filter-disclosure__panel') &&
            node.getBoundingClientRect().height > 0 &&
            getComputedStyle(node).visibility !== 'hidden';
          const metrics = [...document.querySelectorAll('.v2-overview-metric')].map((node) => ({
            label: text(node.querySelector('.v2-overview-metric__label')),
            value: text(node.querySelector('.v2-overview-metric__value')),
            lineHeight: getComputedStyle(node.querySelector('strong')).lineHeight,
            frame: rect(node)
          }));
          const toolbars = [...document.querySelectorAll('.v2-list-toolbar')].map((node) => ({
            frame: rect(node),
            controls: [
              ...node.querySelectorAll('.el-input__wrapper,.el-select__wrapper,summary,.app-button')
            ]
              .filter(visible)
              .map(rect)
          }));
          const stacks = [
            ...document.querySelectorAll(
              '.v2-page-layout,.v2-page-stack,.v2-records-page,.v2-async-region__content'
            )
          ]
            .map((node) => ({
              gap: getComputedStyle(node).rowGap,
              sections: [...node.children].filter(visible).map(rect)
            }))
            .filter((stack) => stack.sections.length > 1);
          const headers = [...document.querySelectorAll('.v2-records-list > header')]
            .filter(visible)
            .map((node) => ({
              frame: rect(node),
              title: text(node.querySelector('.v2-section-heading__text')),
              values: [...node.querySelectorAll('.v2-section-heading__actions > span')]
                .filter(visible)
                .map(text)
            }));
          return {
            metrics,
            toolbars,
            stacks,
            headers,
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth
          };
        });
        const label = `${group}-${dark ? 'dark' : 'light'}-${width}`;
        assert.ok(g.scrollWidth <= width + 1, `${label}: 页面横向溢出`);
        for (const metric of g.metrics)
          assert.ok(
            Math.abs(metric.label.center - metric.value.center) <= 1,
            `${label}: 指标文字错位`
          );
        for (const toolbar of g.toolbars)
          for (const control of toolbar.controls)
            assert.ok(
              control.x >= toolbar.frame.x - 1 && control.right <= toolbar.frame.right + 1,
              `${label}: 筛选控件超出外框`
            );
        for (const header of g.headers)
          if (header.title && width >= 1024)
            for (const value of header.values)
              assert.ok(
                Math.abs(header.title.center - value.center) <= 1,
                `${label}: 列表标题与总数文字错位`
              );
        for (const stack of g.stacks) assert.equal(stack.gap, '14px', `${label}: 模块间距不统一`);
        if (group === 'layout-contract' && width === 1440)
          for (const toolbar of g.toolbars)
            assert.ok(
              Math.max(...toolbar.controls.map((x) => x.center)) -
                Math.min(...toolbar.controls.map((x) => x.center)) <=
                1,
              `${label}: 宽屏筛选未合为一行`
            );
        checks.push({ label, ...g });
        if (
          ['layout-contract', 'customers', 'orders', 'branding'].includes(group) &&
          [1440, 390].includes(width) &&
          !dark
        )
          await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
        if (group === 'layout-contract') {
          await page.locator('.v2-filter-disclosure > summary').click();
          const panel = await page.locator('.v2-filter-disclosure__panel').boundingBox();
          assert.ok(
            panel.x >= 0 && panel.x + panel.width <= width + 1,
            `${label}: 展开筛选超出页面`
          );
          const tip = page.locator('.v2-overview-metric__value[title="等待人工核对与资料补充"]');
          assert.equal(await tip.count(), 1, '长值的完整提示必须保留');
        }
      }
    }
  }
  assert.deepEqual(errors, [], '页面运行时异常');
  writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(checks, null, 2));
  console.log(
    JSON.stringify({
      checks: checks.length,
      groups: groups.length,
      themes: 2,
      widths: [1440, 1024, 768, 390],
      pageErrors: errors,
      businessWrites: 0
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
