#!/usr/bin/env node
/* global window, document */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const distribution = path.join(root, 'apps/admin/dist');
const output = path.join(root, '.runtime/mailbox-realtime-20261016/browser');
const origin = 'https://mailbox-realtime.acceptance.invalid';
const base = '/api/id-business-v2/vendure-mailboxes';
const now = new Date().toISOString();
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'mailbox-fixture',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const primary = {
  id: 'primary-1',
  email: 'owner@example.invalid',
  note: '验收主邮箱',
  status: 'ACTIVE',
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  masterQueryCode: 'MSTR-SYNTHETIC',
  remainingDays: 27,
  lastSyncedAt: now,
  lastSyncError: null,
  virtualEmailCount: 1,
  createdAt: now,
  updatedAt: now,
  codeExpiresAt: null,
  codeResetIntervalDays: 30
};
const alias = {
  id: 'alias-1',
  primaryAccountId: primary.id,
  primaryAccountEmail: primary.email,
  aliasEmail: 'hidden@example.invalid',
  note: '验收隐藏邮箱',
  status: 'ACTIVE',
  buyerQueryCode: 'BUY-SYNTHETIC',
  codeExpiresAt: null,
  remainingDays: 27,
  codeResetIntervalDays: 30,
  mailCount: 21,
  createdAt: now,
  updatedAt: now
};
const makeMail = (index) => ({
  id: `mail-${index}`,
  primaryAccountId: primary.id,
  virtualEmailId: alias.id,
  messageId: `fixture-${index}`,
  subject: `验收邮件 ${index}`,
  fromAddress: 'sender@example.invalid',
  fromName: '合成发件人',
  bodyText: '合成邮件正文',
  extractedCode: null,
  receivedAt: now,
  createdAt: now,
  updatedAt: now,
  isRead: false,
  isStarred: false
});
mkdirSync(output, { recursive: true });
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端');
const browser = await chromium.launch({ headless: true });
const report = [];
const actionsOnly = process.argv.includes('--actions-only');
const captureOnly = process.argv.includes('--capture-only');
assert.ok(
  process.argv.slice(2).every((arg) => ['--actions-only', '--capture-only'].includes(arg)),
  '未知验收选项'
);
try {
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 900, 390]) {
      if (actionsOnly && (theme !== 'light' || width !== 1440)) continue;
      const context = await browser.newContext({ viewport: { width, height: 1100 } });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [],
        unexpected = [],
        writes = [],
        counts = new Map();
      let mails = Array.from({ length: 21 }, (_, index) => makeMail(index + 1));
      let failMails = false,
        healthStatus = 'available',
        notificationConfigured = true;
      let releaseSync;
      let syncStarted;
      const startedSync = new Promise((resolve) => {
        syncStarted = resolve;
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        ({ fixtureUser, fixtureTheme }) => {
          localStorage.setItem('apple_business_access_token', 'synthetic-mailbox-test-token');
          localStorage.setItem('apple_business_current_user', JSON.stringify(fixtureUser));
          localStorage.setItem('id-business-v2:theme', fixtureTheme);
          document.documentElement?.setAttribute('data-v2-theme', fixtureTheme);
          const originalFetch = window.fetch.bind(window);
          let controller;
          const encoder = new TextEncoder();
          window.mailFixture = {
            version: 0,
            blocked: false,
            emit(version) {
              this.version = version;
              controller?.enqueue(
                encoder.encode(
                  `event: change\ndata: ${JSON.stringify({ schemaVersion: 1, eventId: `fixture-${version}`, occurredAt: new Date().toISOString(), scopes: [{ scope: 'vendure-mailbox', version: String(version) }] })}\n\n`
                )
              );
            },
            disconnect() {
              this.blocked = true;
              controller?.close();
            }
          };
          window.fetch = (input, options) => {
            if (String(input).endsWith('/api/realtime/events')) {
              if (window.mailFixture.blocked)
                return Promise.resolve(new Response('', { status: 503 }));
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(next) {
                      controller = next;
                      next.enqueue(
                        encoder.encode(
                          `event: snapshot\ndata: ${JSON.stringify({ schemaVersion: 1, eventId: 'fixture-snapshot', occurredAt: new Date().toISOString(), scopes: [{ scope: 'vendure-mailbox', version: String(window.mailFixture.version) }] })}\n\n`
                        )
                      );
                      options?.signal?.addEventListener('abort', () => {
                        try {
                          next.close();
                        } catch {
                          /* already closed */
                        }
                      });
                    }
                  }),
                  { headers: { 'content-type': 'text/event-stream' } }
                )
              );
            }
            return originalFetch(input, options);
          };
        },
        { fixtureUser: user, fixtureTheme: theme }
      );
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          unexpected.push(url.origin);
          await route.abort();
          return;
        }
        const relative = url.pathname.startsWith('/v2/') ? '/index.html' : url.pathname;
        const asset = path.resolve(distribution, `.${relative}`);
        if (!asset.startsWith(`${distribution}${path.sep}`) || !existsSync(asset)) {
          unexpected.push(url.pathname);
          await route.fulfill({ status: 404, body: '' });
          return;
        }
        const contentType =
          {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
            '.ico': 'image/x-icon'
          }[path.extname(asset)] ?? 'application/octet-stream';
        await route.fulfill({ status: 200, contentType, body: readFileSync(asset) });
      });
      await page.route('**/api/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          endpoint = url.pathname;
        counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
        if (request.method() !== 'GET') writes.push(`${request.method()} ${endpoint}`);
        let data;
        if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) data = user;
        else if (endpoint.endsWith('/branding/public'))
          data = {
            appName: 'ID 业务管理',
            logoText: 'ID',
            logoUrl: '/brand/default-logo.svg',
            appSubtitle: '业务管理',
            documentTitleSuffix: 'ID 业务管理'
          };
        else if (endpoint.endsWith('/id-business-v2/time'))
          data = { now, timezone: 'Asia/Shanghai' };
        else if (endpoint.endsWith('/change-versions'))
          data = { generatedAt: now, versions: { 'vendure-mailbox': '0' } };
        else if (
          endpoint.endsWith('/table-preferences') ||
          endpoint.endsWith('/workspace-shortcuts')
        )
          data = { items: [] };
        else if (endpoint.endsWith('/quick-actions')) data = { items: [], updatedAt: now };
        else if (endpoint.endsWith('/warning-summary') || endpoint.endsWith('/renewal-warnings'))
          data = {
            warningDays: 3,
            defaultWarningDays: 3,
            upcomingCount: 0,
            expiredCount: 0,
            totalCount: 0,
            items: [],
            evaluatedAt: now,
            revalidateAt: null
          };
        else if (endpoint.endsWith('/sensitive-access/approvals/summary'))
          data = { pendingCount: 0, items: [], generatedAt: now };
        else if (endpoint === `${base}/primary-accounts/${primary.id}/test`) {
          data = { success: true, message: '合成连接测试成功' };
        } else if (endpoint === `${base}/primary-accounts/${primary.id}/sync`) {
          syncStarted();
          await new Promise((resolve) => {
            releaseSync = resolve;
          });
          await route.abort('failed');
          return;
        } else if (endpoint === `${base}/status`)
          data = { configured: true, connected: true, message: null };
        else if (endpoint === `${base}/health`)
          data = {
            status: healthStatus,
            checkedAt: now,
            listeners:
              healthStatus === 'available'
                ? [
                    {
                      primaryAccountId: primary.id,
                      state: 'listening',
                      reason: 'connected',
                      leaseExpiresAt: now
                    }
                  ]
                : [],
            delivery:
              healthStatus === 'available'
                ? {
                    configured: notificationConfigured,
                    pendingCount: 0,
                    oldestPendingAt: null,
                    lastDeliveredAt: now
                  }
                : null
          };
        else if (
          [`${base}/primary-accounts`, `${base}/aliases`, `${base}/mails`].includes(endpoint)
        ) {
          if (endpoint.endsWith('/mails') && failMails) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成邮件读取失败' })
            });
            return;
          }
          let items = endpoint.endsWith('/primary-accounts')
            ? [primary]
            : endpoint.endsWith('/aliases')
              ? [alias]
              : mails;
          const keyword = url.searchParams.get('q');
          if (keyword) items = items.filter((item) => JSON.stringify(item).includes(keyword));
          const current = Number(url.searchParams.get('page') ?? 1),
            size = Number(url.searchParams.get('pageSize') ?? 20);
          data = {
            items: items.slice((current - 1) * size, current * size),
            total: items.length,
            page: current,
            pageSize: size
          };
        }
        if (data === undefined) {
          unexpected.push(`${request.method()} ${endpoint}`);
          await route.fulfill({ status: 500, body: '{}' });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data })
        });
      });
      const getCount = (endpoint) => counts.get(`${base}/${endpoint}`) ?? 0;
      const clickAndRead = async (name, endpoint) => {
        const response = page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `${base}/${endpoint}` && r.request().method() === 'GET'
        );
        await page.getByRole('button', { name, exact: true }).click();
        await response;
        await page
          .locator('.vendure-mailbox-page .v2-records-list')
          .filter({ visible: true })
          .first()
          .waitFor();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
            )
        );
      };
      await page.goto(`${origin}/v2/account-settings/mailbox`);
      await page.getByText('1 个邮箱监听中', { exact: true }).waitFor();
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-v2-theme', theme),
        theme
      );
      if (captureOnly) {
        await page.screenshot({
          path: path.join(output, `${theme}-${width}-health.png`),
          fullPage: true
        });
        report.push({ theme, width, captured: true });
        await context.close();
        continue;
      }
      if (actionsOnly) {
        const beforeTest = getCount('primary-accounts');
        const testReadback = page.waitForResponse(
          (r) => new URL(r.url()).pathname === `${base}/primary-accounts`
        );
        await page
          .getByRole('button', { name: '测试', exact: true })
          .filter({ visible: true })
          .click();
        await testReadback;
        await page.getByText('连接正常', { exact: true }).filter({ visible: true }).waitFor();
        assert.equal(getCount('primary-accounts') - beforeTest, 1, '测试成功后没有刷新邮箱状态');
        const button = page
          .getByRole('button', { name: '立即同步', exact: true })
          .filter({ visible: true });
        const beforeSync = getCount('primary-accounts');
        await button.click();
        await startedSync;
        assert.equal(
          await button.getAttribute('aria-busy'),
          'true',
          '同步请求期间未显示进行中状态'
        );
        // A second physical click while Element Plus is loading must not send another request.
        await button.click({ force: true });
        assert.equal(writes.length, 2, '进行中的同步被重复提交');
        const readback = page.waitForResponse(
          (r) => new URL(r.url()).pathname === `${base}/primary-accounts`
        );
        releaseSync();
        await readback;
        await page.getByText(/若请求在返回前中断/).waitFor();
        assert.equal(getCount('primary-accounts') - beforeSync, 1, '同步结果中断后没有回读列表');
        assert.deepEqual(
          writes,
          [
            `POST ${base}/primary-accounts/${primary.id}/test`,
            `POST ${base}/primary-accounts/${primary.id}/sync`
          ],
          '中断同步被自动重放'
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpected, []);
        report.push({
          theme,
          width,
          passed: true,
          simulatedSyncWrites: 1,
          simulatedTestWrites: 1,
          readbacks: 2
        });
        console.log(JSON.stringify(report.at(-1)));
        await context.close();
        continue;
      }
      let before = getCount('primary-accounts');
      await clickAndRead('刷新列表', 'primary-accounts');
      assert.equal(getCount('primary-accounts') - before, 1, '同条件查询应只读取一次');
      before = getCount('primary-accounts');
      const searchRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `${base}/primary-accounts` && url.searchParams.get('q') === '验收主邮箱'
        );
      });
      await page.getByLabel('搜索邮箱或邮件', { exact: true }).fill('验收主邮箱');
      await searchRead;
      assert.equal(getCount('primary-accounts') - before, 1, '自动搜索改变条件应只读取一次');
      before = getCount('primary-accounts');
      await clickAndRead('刷新列表', 'primary-accounts');
      assert.equal(getCount('primary-accounts') - before, 1, '同一搜索条件刷新应只读取一次');
      before = getCount('primary-accounts');
      const statusRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `${base}/primary-accounts` &&
          url.searchParams.get('status') === 'DISABLED'
        );
      });
      await Promise.all([
        statusRead,
        (async () => {
          await page
            .locator('.el-select')
            .filter({ has: page.getByRole('combobox', { name: '邮箱状态', exact: true }) })
            .click();
          await page.getByRole('option', { name: '已禁用', exact: true }).click();
        })()
      ]);
      assert.equal(getCount('primary-accounts') - before, 1, '状态筛选改变后应只读取一次');
      await page.getByRole('tab', { name: '虚拟邮箱管理', exact: true }).click();
      await page
        .getByText(alias.aliasEmail, { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      await clickAndRead('刷新列表', 'aliases');
      await page.getByRole('tab', { name: '收件记录', exact: true }).click();
      await page
        .getByText('验收邮件 1', { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page
        .getByText('验收邮件 21', { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      mails.unshift(makeMail(22));
      const startedAt = Date.now();
      await page.evaluate(() => window.mailFixture.emit(1));
      await page.getByText('邮件记录有更新，当前筛选和页码已保留。', { exact: true }).waitFor();
      assert.equal(await page.locator('.el-pager .is-active').innerText(), '2');
      await page.getByRole('button', { name: '查看第一页', exact: true }).click();
      await page
        .getByText('验收邮件 22', { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      const localEventLatencyMs = Date.now() - startedAt;
      assert.ok(localEventLatencyMs < 5000, '合成事件更新超过 5 秒');
      failMails = true;
      await page.getByRole('button', { name: '刷新列表', exact: true }).click();
      await page
        .getByText(/合成邮件读取失败/)
        .first()
        .waitFor();
      assert.ok(
        await page
          .getByText('验收邮件 22', { exact: true })
          .filter({ visible: true })
          .first()
          .isVisible(),
        '刷新失败丢失最后成功邮件'
      );
      failMails = false;
      await clickAndRead('重试', 'mails');
      healthStatus = 'unsupported';
      await clickAndRead('刷新状态', 'health');
      await page
        .locator('.v2-page-overview__meta')
        .getByText('上游暂不支持健康检查，邮件列表仍可正常读取。', { exact: true })
        .waitFor();
      assert.ok(
        await page
          .getByText('验收邮件 22', { exact: true })
          .filter({ visible: true })
          .first()
          .isVisible()
      );
      healthStatus = 'available';
      notificationConfigured = false;
      await clickAndRead('刷新状态', 'health');
      await page.getByText('通知未配置', { exact: true }).waitFor();
      await page.evaluate(() => window.mailFixture.disconnect());
      await page.getByText('连接异常，正在恢复', { exact: true }).waitFor();
      mails.unshift(makeMail(23));
      await page.evaluate(() => {
        window.mailFixture.version = 2;
        window.mailFixture.blocked = false;
      });
      await page
        .getByText('验收邮件 23', { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        metrics: [...document.querySelectorAll('.v2-overview-metric')].map((element) => {
          const rect = element.getBoundingClientRect();
          const label = element.querySelector('.v2-overview-metric__label').getBoundingClientRect();
          const value = element.querySelector('.v2-overview-metric__value').getBoundingClientRect();
          return {
            width: rect.width,
            aligned: Math.abs((label.top + label.bottom) / 2 - (value.top + value.bottom) / 2) <= 1
          };
        })
      }));
      assert.equal(geometry.overflow, false, '页面横向溢出');
      assert.ok(
        geometry.metrics.every((metric) => metric.width > 0 && metric.aligned),
        '健康指标文字未对齐'
      );
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-mail.png`),
        fullPage: true
      });
      mails = [];
      await clickAndRead('刷新列表', 'mails');
      await page
        .getByText('暂无收件记录', { exact: true })
        .filter({ visible: true })
        .first()
        .waitFor();
      assert.deepEqual(writes, [], '只读验收触发了写入请求');
      assert.deepEqual(errors, [], '页面运行异常');
      assert.deepEqual(unexpected, [], '出现未定义请求');
      report.push({ theme, width, passed: true, localEventLatencyMs, geometry, writes });
      console.log(JSON.stringify({ theme, width, passed: true, localEventLatencyMs }));
      await context.close();
    }
} finally {
  writeFileSync(
    path.join(
      output,
      captureOnly ? 'report-captures.json' : actionsOnly ? 'report-actions.json' : 'report.json'
    ),
    JSON.stringify(report, null, 2)
  );
  await browser.close();
}
