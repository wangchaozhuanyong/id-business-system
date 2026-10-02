#!/usr/bin/env node
/* global document, getComputedStyle, NodeFilter */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const baseUrl = new URL(
  process.env.V2_BUSINESS_SKIN_ADMIN_URL ||
    `http://127.0.0.1:${process.env.V2_BUSINESS_SKIN_PORT || '5393'}`
);
assert.ok(['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname));
const output = path.resolve(
  root,
  process.argv[2] ?? '.runtime/skin-consistency-20261001/continuation/after'
);
assert.ok(!path.relative(root, output).startsWith('..'), '验收产物必须位于当前项目');
mkdirSync(output, { recursive: true });
const checks = [],
  issues = [],
  errors = [];
let server, browser;
const fixtures = [
  'accounts',
  'customers',
  'orders',
  'topup-records',
  'topups',
  'activations',
  'renewals',
  'exchange-rates',
  'finance-ledger',
  'finance-expenses',
  'employees',
  'roles',
  'security',
  'profile',
  'branding',
  'options',
  'order-entry',
  'workspace',
  'vendure-mailbox',
  'dashboard',
  'analytics',
  'audit-logs',
  'business-monitoring',
  'data-governance',
  'system-monitoring',
  'public-mailbox'
].map((name) => ({
  name,
  pathname: `/${name}-design-fixture.html`,
  selector: name === 'public-mailbox' ? '.v2-public-mailbox' : '.v2-shell'
}));
fixtures.push(
  { name: 'login', pathname: '/login', selector: '.login-page' },
  {
    name: 'change-password',
    pathname: '/change-password-fixture.html',
    selector: '.password-page'
  },
  {
    name: 'accounts-loss',
    pathname: '/accounts-design-fixture.html',
    query: 'lossDialog=open',
    selector: '.el-dialog'
  },
  {
    name: 'orders-refund',
    pathname: '/orders-design-fixture.html',
    query: 'refundDialog=open',
    selector: '.el-dialog'
  },
  {
    name: 'renewals-drawer',
    pathname: '/renewals-design-fixture.html',
    query: 'drawer=open',
    selector: '.el-drawer'
  },
  {
    name: 'vendure-aliases',
    pathname: '/vendure-mailbox-design-fixture.html',
    tab: '虚拟邮箱管理',
    selector: '.v2-shell'
  },
  {
    name: 'vendure-mails',
    pathname: '/vendure-mailbox-design-fixture.html',
    tab: '收件记录',
    selector: '.v2-shell'
  },
  {
    name: 'vendure-primary-form',
    pathname: '/vendure-mailbox-design-fixture.html',
    action: '新增主邮箱',
    selector: '.v2-shell'
  },
  {
    name: 'login-totp',
    pathname: '/login',
    action: '在线计算 2FA 验证码',
    selector: '.login-page'
  },
  {
    name: 'vendure-relay-empty',
    pathname: '/vendure-mailbox-design-fixture.html',
    tab: '邮箱中继查询',
    selector: '.v2-shell'
  },
  {
    name: 'vendure-relay-results',
    pathname: '/vendure-mailbox-design-fixture.html',
    tab: '邮箱中继查询',
    relay: true,
    selector: '.v2-shell'
  },
  {
    name: 'vendure-relay-copied',
    pathname: '/vendure-mailbox-design-fixture.html',
    tab: '邮箱中继查询',
    relay: true,
    copied: true,
    selector: '.v2-shell'
  }
);
const selectedFixtures = process.env.V2_BUSINESS_SKIN_FIXTURES
  ? fixtures.filter((f) => process.env.V2_BUSINESS_SKIN_FIXTURES.split(',').includes(f.name))
  : fixtures;
assert.ok(selectedFixtures.length > 0, '未找到指定的皮肤验收场景');
try {
  if (!process.env.V2_BUSINESS_SKIN_ADMIN_URL)
    server = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        baseUrl.hostname,
        '--port',
        baseUrl.port,
        '--strictPort'
      ],
      {
        cwd: path.join(root, 'apps/admin'),
        env: {
          ...process.env,
          VITE_API_BASE_URL: '/api',
          VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
        },
        stdio: 'ignore'
      }
    );
  const deadline = Date.now() + 30_000;
  while (!(await fetch(new URL('/login', baseUrl)).catch(() => null))?.ok) {
    assert.ok(Date.now() < deadline && server?.exitCode == null);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.addInitScript((t) => localStorage.setItem('id-business-v2-theme', t), theme);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async () => undefined, readText: async () => 'BUY-DEMO' }
        })
      );
      page.on('pageerror', (error) => errors.push({ theme, width, message: error.message }));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== baseUrl.origin) {
          await route.abort();
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          if (url.pathname.startsWith('/api/auth/')) {
            await route.fulfill({ status: 401, json: { message: '本地未登录验收会话' } });
          } else if (route.request().method() !== 'GET') {
            await route.abort();
          } else {
            const data = url.pathname.endsWith('/branding/public')
              ? {
                  appName: 'ID 业务管理系统',
                  appSubtitle: '本地皮肤验收',
                  logoText: 'ID',
                  logoUrl: '/brand/default-logo.svg'
                }
              : url.pathname.endsWith('/time')
                ? { now: '2026-10-01T12:00:00.000Z', timezone: 'Asia/Shanghai' }
                : { status: 'ready', database: 'ok' };
            await route.fulfill({ json: { success: true, data, message: '本地模拟资料' } });
          }
          return;
        }
        await route.continue();
      });
      for (const fixture of selectedFixtures) {
        await page.goto(
          new URL(`${fixture.pathname}?theme=${theme}&${fixture.query || ''}`, baseUrl).href,
          { waitUntil: 'networkidle' }
        );
        await page
          .locator(fixture.selector)
          .waitFor()
          .catch((error) => {
            throw new Error(`${fixture.name}/${theme}/${width}: ${error.message}`);
          });
        if (fixture.name === 'login' || fixture.name === 'login-totp')
          await page.getByText('系统运行正常', { exact: true }).waitFor();
        await page.addStyleTag({
          content:
            '*, *::before, *::after { transition: none !important; animation: none !important; }'
        });
        if (fixture.tab) await page.getByRole('tab', { name: fixture.tab, exact: true }).click();
        if (fixture.action) {
          await page.getByRole('button', { name: fixture.action, exact: true }).click();
          await page.locator('.el-drawer:visible').waitFor();
        }
        if (fixture.relay) {
          await page.locator('.vendure-relay-input input').fill('BUY-DEMO');
          await page.getByRole('button', { name: '查询验证码', exact: true }).click();
          await page.locator('.vendure-relay-results').waitFor();
          if (fixture.copied) {
            await page.locator('.vendure-relay-big-copy-btn').click();
            await page.getByRole('button', { name: '已复制验证码', exact: true }).waitFor();
          }
        }
        // Fixtures without a theme selector still load the same product CSS and actual components.
        await page.evaluate((t) => {
          document.documentElement.dataset.v2Theme = t;
          document.documentElement.classList.toggle('dark', t === 'dark');
          document.documentElement.style.colorScheme = t;
        }, theme);
        const measurements = await page.evaluate(() => {
          const visible = (el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          const textBox = (el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walker.nextNode())) {
              if (!n.textContent.trim() || n.textContent.trim() === '*') continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              const b = range.getBoundingClientRect();
              if (b.height > 0) return { top: b.top, bottom: b.bottom, height: b.height };
            }
            return null;
          };
          return [
            ...document.querySelectorAll(
              '.el-input__wrapper,.el-select__wrapper,.el-form-item__label,.vendure-copy-btn,.vendure-relay-paste-btn,.vendure-relay-big-copy-btn'
            )
          ]
            .filter(visible)
            .map((el) => {
              const s = getComputedStyle(el),
                b = el.getBoundingClientRect();
              const label = el.classList.contains('el-form-item__label') ? textBox(el) : null;
              const control =
                label &&
                el
                  .closest('.el-form-item')
                  ?.querySelector('.el-input__wrapper,.el-select__wrapper,.el-textarea__inner');
              const value = control?.querySelector('.el-select__placeholder');
              const valueText = value && textBox(value);
              const cb = control?.getBoundingClientRect();
              const expected = s.getPropertyValue('--el-component-size').trim();
              const labelDeviation =
                label && cb
                  ? Math.abs(
                      label.top +
                        label.height / 2 -
                        (valueText
                          ? valueText.top + valueText.height / 2
                          : cb.top + Number.parseFloat(expected) / 2)
                    )
                  : null;
              return {
                class: el.className,
                tag: el.tagName,
                text: el.textContent.trim().slice(0, 24),
                height: b.height,
                font: s.fontSize,
                lineHeight: s.lineHeight,
                radius: s.borderRadius,
                color: s.color,
                background: s.backgroundColor,
                sharedButton: el.classList.contains('app-button'),
                minHeight: s.minHeight,
                expected,
                labelText: label,
                valueText,
                labelDeviation
              };
            });
        });
        for (const m of measurements) {
          if (/el-(input|select)__wrapper/.test(m.class) && m.radius !== '8px')
            issues.push({ fixture, theme, width, reason: 'control-radius', ...m });
          if (
            /el-(input|select)__wrapper/.test(m.class) &&
            Math.abs(m.height - Number.parseFloat(m.expected)) > 1
          )
            issues.push({ fixture, theme, width, reason: 'control-size', ...m });
          if (/el-form-item__label/.test(m.class) && m.font !== '13px')
            issues.push({ fixture, theme, width, reason: 'label-font', ...m });
          if (m.labelDeviation != null && m.labelDeviation > 2)
            issues.push({ fixture, theme, width, reason: 'label-text-alignment', ...m });
          if (/vendure-(copy|relay-paste|relay-big-copy)/.test(m.class) && !m.sharedButton)
            issues.push({ fixture, theme, width, reason: 'action-bypasses-shared-button', ...m });
        }
        checks.push({
          fixture: fixture.name,
          theme,
          width,
          controls: measurements.length,
          measurements
        });
        if (
          ['vendure-mailbox', 'login', 'order-entry', 'login-totp'].includes(fixture.name) &&
          [1440, 390].includes(width)
        )
          await page.screenshot({
            path: path.join(output, `${fixture.name}-${theme}-${width}.png`),
            fullPage: true
          });
      }
      await page.close();
    }
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      { ok: !issues.length && !errors.length, checks, issues, errors, businessWrites: 0 },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      scenarios: checks.length,
      measuredControls: checks.reduce((n, c) => n + c.controls, 0),
      issues: issues.length,
      runtimeErrors: errors.length,
      businessWrites: 0,
      output
    })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(issues, []);
} finally {
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        ok: checks.length === selectedFixtures.length * 6 && !issues.length && !errors.length,
        checks,
        issues,
        errors,
        businessWrites: 0
      },
      null,
      2
    )
  );
  await browser?.close();
  server?.kill('SIGTERM');
}
