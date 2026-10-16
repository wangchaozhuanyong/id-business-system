#!/usr/bin/env node
/* global document, window */
// 使用真实构建产物和合成接口离线验收，不启动网站服务，不连接数据库、供应商或代理。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const distribution = path.join(root, 'apps/admin/dist');
const output = path.join(root, '.runtime/online-proxy-country-20261016');
const origin = 'https://online-proxy-country.acceptance.invalid';
const widths = [1440, 1024, 901, 900, 768, 390];
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'country-fixture',
  displayName: '代理国家验收',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const now = new Date().toISOString();
mkdirSync(output, { recursive: true });
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ['light', 'dark'])
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const unexpected = [],
        errors = [],
        writes = [];
      let failSave = false,
        failCountries = false,
        emptyCountries = false,
        releaseSave;
      let config = {
        version: 0,
        proxyCountryCode: '',
        paymentRegion: 'PH',
        maxConcurrent: 1,
        cardMaxSubscriptionCount: 2,
        cardMaxDeclineCount: 3,
        secretStatus: {}
      };
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((actor) => {
        localStorage.setItem('apple_business_access_token', 'synthetic-country-fixture');
        localStorage.setItem('apple_business_current_user', JSON.stringify(actor));
      }, user);
      await page.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          endpoint = url.pathname;
        const ok = (data) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data })
          });
        if (url.origin !== origin) {
          unexpected.push(url.origin);
          return route.abort();
        }
        if (!endpoint.startsWith('/api/')) {
          const relative =
            endpoint.startsWith('/v2/') || endpoint === '/' ? '/index.html' : endpoint;
          const asset = path.resolve(distribution, `.${relative}`);
          if (!asset.startsWith(`${distribution}${path.sep}`) || !existsSync(asset))
            return route.fulfill({ status: 404, body: '' });
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
          return route.fulfill({ status: 200, contentType, body: readFileSync(asset) });
        }
        if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) return ok(user);
        if (endpoint.endsWith('/branding/public'))
          return ok({
            appName: 'ID 业务管理',
            logoText: 'ID',
            logoUrl: '/brand/default-logo.svg',
            documentTitleSuffix: 'ID 业务管理'
          });
        if (endpoint.endsWith('/time')) return ok({ now, timezone: 'Asia/Shanghai' });
        if (endpoint.endsWith('/change-versions')) return ok({ generatedAt: now, versions: {} });
        if (endpoint.endsWith('/realtime/events'))
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: 'retry: 60000\n: fixture\n\n'
          });
        if (endpoint.endsWith('/proxy-pool/countries')) {
          if (failCountries)
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ message: '合成国家列表读取失败' })
            });
          return ok({ items: emptyCountries ? [] : ['CL', 'PH', 'US'] });
        }
        if (endpoint.endsWith('/online-recharge/admin/config')) {
          if (request.method() === 'PATCH') {
            const body = request.postDataJSON();
            writes.push(body);
            if (failSave)
              return route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({ message: '合成保存失败' })
              });
            if (releaseSave)
              await new Promise((resolve) => {
                releaseSave = resolve;
              });
            config = { ...config, ...body, version: config.version + 1 };
          }
          return ok(config);
        }
        if (endpoint.endsWith('/warning-summary') || endpoint.endsWith('/renewal-warnings'))
          return ok({
            warningDays: 3,
            upcomingCount: 0,
            expiredCount: 0,
            totalCount: 0,
            items: [],
            evaluatedAt: now,
            revalidateAt: now
          });
        if (endpoint.endsWith('/approvals/summary'))
          return ok({ pendingCount: 0, items: [], generatedAt: now });
        if (endpoint.endsWith('/quick-actions')) return ok({ items: [], updatedAt: now });
        if (endpoint.endsWith('/online-recharge/admin/overview'))
          return ok({ counts: {}, tasks: [], runtime: null, billing: [] });
        return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      });
      await page.goto(`${origin}/v2/online-recharge/config`);
      const country = page.getByRole('combobox', { name: '代理国家', exact: true });
      await country.waitFor().catch(async (error) => {
        await page.screenshot({ path: path.join(output, 'initial-failure.png'), fullPage: true });
        writeFileSync(
          path.join(output, 'initial-failure.json'),
          JSON.stringify(
            { text: await page.locator('body').innerText(), errors, unexpected },
            null,
            2
          )
        );
        throw error;
      });
      const selectedText = () => page.locator('.el-form-item').filter({ has: country }).innerText();
      const openCountries = () =>
        page
          .locator('.el-form-item')
          .filter({ has: country })
          .locator('.el-select__wrapper')
          .click();
      const choose = async (label) => {
        await openCountries();
        await page.getByRole('option', { name: label, exact: true }).click();
        await page.getByRole('option', { name: label, exact: true }).waitFor({ state: 'hidden' });
        assert.ok((await selectedText()).includes(label));
      };
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-v2-theme', value);
        document.documentElement.classList.toggle('dark', value === 'dark');
        document.documentElement.style.colorScheme = value;
      }, theme);
      assert.ok(!(await selectedText()).includes('菲律宾'), '不得从支付地区自动猜测代理国家');
      await choose('智利');
      const payment = page.getByRole('combobox', { name: '支付地区', exact: true });
      assert.ok(
        (await page.locator('.el-form-item').filter({ has: payment }).innerText()).includes(
          '菲律宾'
        ),
        '代理国家不能改写支付地区'
      );
      const geometry = await page
        .locator('.el-form-item')
        .filter({ has: country })
        .evaluate((item) => {
          const label = item.querySelector('.el-form-item__label'),
            control = item.querySelector('.el-select__wrapper');
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect(),
            box = control.getBoundingClientRect();
          return {
            labelRight: text.right,
            controlLeft: box.left,
            delta: Math.abs((text.top + text.bottom - box.top - box.bottom) / 2),
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1
          };
        });
      assert.ok(
        geometry.labelRight <= geometry.controlLeft + 1 && geometry.delta <= 5,
        '标签必须在控件左侧并对齐首行'
      );
      assert.equal(geometry.overflow, false, '页面横向溢出');
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
      if (theme === 'light' && width === 1440) {
        failSave = true;
        await page.getByRole('button', { name: '保存配置', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
        assert.ok((await selectedText()).includes('智利'), '保存失败丢失输入');
        failSave = false;
        releaseSave = true;
        const submitted = page.waitForRequest((request) => request.method() === 'PATCH');
        await page.getByRole('button', { name: '保存配置', exact: true }).click();
        await submitted;
        await choose('菲律宾');
        assert.equal(typeof releaseSave, 'function');
        releaseSave();
        releaseSave = undefined;
        await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
        assert.equal(writes.at(-1).proxyCountryCode, 'CL');
        assert.ok((await selectedText()).includes('菲律宾'), '迟到保存响应清除了后续编辑');
        await page.getByRole('link', { name: '概览中心', exact: true }).click();
        await page.getByRole('link', { name: '系统配置', exact: true }).click();
        await country.waitFor();
        assert.ok((await selectedText()).includes('菲律宾'), '切页返回丢失代理国家草稿');
        failCountries = true;
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await page.getByText('合成国家列表读取失败', { exact: true }).waitFor();
        assert.ok((await selectedText()).includes('菲律宾'), '刷新失败清空已有内容');
        failCountries = false;
        await page.getByRole('button', { name: /重试/ }).click();
        await country.waitFor();
        assert.ok((await selectedText()).includes('菲律宾'));
        await page.reload();
        await country.waitFor();
        assert.ok((await selectedText()).includes('智利'), '整页刷新必须重新读取已保存配置');
        emptyCountries = true;
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await openCountries();
        await page.getByRole('option', { name: '智利', exact: true }).waitFor();
        assert.equal(await page.getByRole('option').count(), 1, '空国家列表仍应显示已保存国家');
        await country.press('Escape');
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      results.push({ theme, width, geometry, passed: true });
      console.log(JSON.stringify({ theme, width, passed: true }));
      await context.close();
    }
  writeFileSync(
    path.join(output, 'browser-result.json'),
    JSON.stringify(
      {
        results,
        offline: true,
        realProxyRequests: 0,
        lifecycle: [
          '保存失败保留',
          '保存期间编辑',
          '切页草稿',
          '刷新失败重试',
          '整页刷新清理',
          '空代理国家列表'
        ]
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: results.length, output, realProxyRequests: 0 }));
} finally {
  await browser.close();
}
