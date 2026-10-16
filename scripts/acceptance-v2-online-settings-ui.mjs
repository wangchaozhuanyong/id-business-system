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
const output = path.join(root, '.runtime/online-settings-ui-20261016');
const origin = 'https://online-plan-regions.acceptance.invalid';
const widths = process.env.HELP_WIDTHS
  ? process.env.HELP_WIDTHS.split(',').map(Number)
  : [1440, 1024, 901, 900, 768, 390];
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'country-fixture',
  displayName: '代理国家验收',
  roles: process.env.HELP_READONLY ? ['employee'] : ['admin'],
  permissions: process.env.HELP_READONLY ? ['id_business_v2.online_recharge.read'] : [],
  mustResetPassword: false
};
const now = new Date().toISOString();
mkdirSync(output, { recursive: true });
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of (process.env.HELP_THEMES || 'light,dark').split(','))
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        hasTouch: width <= 900
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      const unexpected = [],
        errors = [],
        writes = [];
      let failSave = false,
        failCountries = false,
        emptyCountries = false,
        releaseSave;
      let config = {
        version: 0,
        proxyCountryCode: 'PH',
        planRegionRoutingEnabled: false,
        planProxyCountryPlus: 'PH',
        planPaymentRegionPlus: 'PH',
        planProxyCountryPro5x: 'CL',
        planPaymentRegionPro5x: 'CL',
        planProxyCountryPro20x: 'PH',
        planPaymentRegionPro20x: 'PH',
        planProxyCountryPro500: 'CL',
        planPaymentRegionPro500: 'CL',
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
        if (
          endpoint.endsWith('/online-recharge/admin/config/test') ||
          endpoint.endsWith('/online-recharge/admin/jobs/detail')
        )
          return ok({
            id: '11111111-1111-4111-8111-111111111112',
            operation: 'debug',
            status: 'succeeded',
            plan: 'pro_5x',
            provider: 'local',
            progress: 100,
            message: '合成付款前调试完成',
            planRegion: {
              policy: 'plan',
              targetPlan: 'pro_5x',
              proxyCountryCode: 'CL',
              paymentRegion: 'CL',
              expectedCurrency: 'CLP',
              configVersion: 17
            }
          });
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
      const panel = page
        .locator('.online-panel')
        .filter({ has: page.getByRole('heading', { name: '套餐地区规则', exact: true }) });
      await panel.waitFor();
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-v2-theme', value);
        document.documentElement.classList.toggle('dark', value === 'dark');
        document.documentElement.style.colorScheme = value;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      const row = (name) =>
        page
          .locator('.el-form-item')
          .filter({ has: page.getByRole('combobox', { name, exact: true }) });
      const selection = (name) => row(name).innerText();
      const choose = async (name, label) => {
        await row(name).locator('.el-select__wrapper').click();
        await page.getByRole('option', { name: label, exact: true }).click();
        await page.getByRole('option', { name: label, exact: true }).waitFor({ state: 'hidden' });
      };
      for (const [plan, country, currency] of [
        ['Plus', '菲律宾', 'PHP'],
        ['Pro 100', '智利', 'CLP'],
        ['Pro 200', '菲律宾', 'PHP'],
        ['Pro 500', '智利', 'CLP']
      ]) {
        assert.ok((await selection(`${plan} 代理国家`)).includes(country));
        const text = await selection(`${plan} 支付地区`);
        assert.ok(text.includes(country) && text.includes(currency));
      }
      const toggle = panel.getByRole('switch');
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      const helper = panel.locator('.v2-section-heading__help');
      assert.equal(await helper.count(), 1);
      await helper.click();
      const popup = page.locator('.feature-help-popper:visible');
      await popup.waitFor();
      const box = await popup.boundingBox();
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1);
      assert.ok((await popup.innerText()).includes('Pro 500'));
      await helper.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      await helper.click();
      await popup.waitFor();
      await helper.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      assert.equal(writes.length, 0);
      const geometry = await panel.locator('.el-form-item').evaluateAll((items) =>
        items.map((item) => {
          const label = item.querySelector('.el-form-item__label');
          const control = item.querySelector('.el-select__wrapper, .el-switch');
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getClientRects()[0],
            input = control.getBoundingClientRect();
          return {
            label: label.textContent,
            left: text.right <= input.left + 1,
            delta: Math.abs((text.top + text.bottom - input.top - input.bottom) / 2)
          };
        })
      );
      assert.ok(
        geometry.every((item) => item.left && item.delta <= 5),
        JSON.stringify(geometry)
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
        false
      );
      if (process.env.HELP_TASK_DETAIL && !process.env.HELP_READONLY) {
        await page.getByRole('button', { name: '检测求解器', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '操作结果', exact: true });
        await dialog.waitFor();
        const text = await dialog.innerText();
        assert.ok(
          text.includes('预期结算币种') &&
            text.includes('地区规则版本') &&
            text.includes('CLP') &&
            text.includes('智利')
        );
        assert.ok(!text.includes('proxyCountryCode') && !text.includes('expectedCurrency'));
        assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      }
      if (process.env.HELP_READONLY) {
        assert.equal(await page.getByRole('button', { name: '保存配置', exact: true }).count(), 0);
        assert.ok(await toggle.isDisabled());
        assert.ok(
          await panel
            .locator('input')
            .evaluateAll((inputs) => inputs.every((input) => input.disabled))
        );
      } else {
        await panel.locator('.el-switch').click();
        await choose('Pro 100 支付地区', '新加坡');
        assert.ok((await selection('Pro 100 支付地区')).includes('SGD'));
        assert.ok((await selection('Pro 100 代理国家')).includes('智利'));
        assert.ok((await selection('支付地区')).includes('菲律宾'));
        if (theme === 'light' && width === 1440) {
          failSave = true;
          await page.getByRole('button', { name: '保存配置', exact: true }).click();
          await page.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
          assert.ok((await selection('Pro 100 支付地区')).includes('新加坡'));
          assert.equal(writes.at(-1).planRegionRoutingEnabled, true);
          assert.equal(writes.at(-1).planPaymentRegionPro5x, 'SG');
          await page.getByRole('link', { name: '概览中心', exact: true }).click();
          await page.getByRole('link', { name: '系统配置', exact: true }).click();
          await panel.waitFor();
          assert.ok((await selection('Pro 100 支付地区')).includes('新加坡'));
          failSave = false;
          await page.getByRole('button', { name: '保存配置', exact: true }).click();
          await page.getByRole('status').filter({ hasText: '配置已保存' }).waitFor();
          assert.equal(config.planPaymentRegionPro5x, 'SG');
          await page.reload();
          await panel.waitFor();
          assert.ok((await selection('Pro 100 支付地区')).includes('新加坡'));
        }
      }
      if ((theme === 'light' && width === 1440) || (theme === 'dark' && width === 390)) {
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(
            output,
            `${theme}-${width}${process.env.HELP_READONLY ? '-readonly' : ''}.png`
          )
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      results.push({ theme, width, geometry, readOnly: !!process.env.HELP_READONLY, passed: true });
      console.log(JSON.stringify({ theme, width, passed: true }));
      await context.close();
    }
  writeFileSync(
    path.join(
      output,
      process.env.HELP_READONLY
        ? 'browser-readonly.json'
        : process.env.HELP_TASK_DETAIL
          ? 'browser-task-detail.json'
          : 'browser-result.json'
    ),
    JSON.stringify({ results, offline: true, externalRequests: 0 }, null, 2)
  );
} finally {
  await browser.close();
}
