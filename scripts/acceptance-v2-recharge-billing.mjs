/* global document, window */
// Built frontend + intercepted synthetic responses only; no API server, database or payment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { resolveViteCli } from './lib/vite-cli.mjs';
const output = resolve(
  process.argv
    .find((arg) => arg.startsWith('--evidence-dir='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '.runtime/bit-recharge-billing-generation-20261016/browser'
);
const port = 5396,
  origin = `http://127.0.0.1:${port}`;
mkdirSync(output, { recursive: true });
const server = spawn(
  process.execPath,
  [resolveViteCli(), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: resolve('apps/admin'), stdio: 'ignore' }
);
const user = {
  id: 'billing-fixture',
  username: 'fixture',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const now = new Date().toISOString();
const report = { scope: 'OFFLINE_BUILT_SYNTHETIC_ONLY', realPayment: 'NOT_RUN', cases: [] };
let browser, lastPage;
const until = async (condition) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('验收条件超时');
};
try {
  await until(async () => (await fetch(origin).catch(() => null))?.ok);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 1024, 901, 900, 768, 390])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1100 } });
      await context.addInitScript(
        ({ user, theme }) => {
          localStorage.setItem('apple_business_access_token', 'synthetic-only');
          localStorage.setItem('apple_business_current_user', JSON.stringify(user));
          localStorage.setItem('id-business-v2-theme', theme);
        },
        { user, theme }
      );
      const page = await context.newPage();
      lastPage = page;
      page.setDefaultTimeout(10000);
      const errors = [],
        forbidden = [],
        generatedCounts = [],
        matchedNumbers = [];
      let addresses = [],
        serial = 0,
        rejectGeneration = false;
      const reply = (route, data) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data })
        });
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (url.origin === origin && !path.startsWith('/api/')) return route.continue();
        if (url.origin === origin) {
          if (path === '/api/auth/me') return reply(route, user);
          if (path === '/api/auth/session')
            return reply(route, { accessToken: 'synthetic-only', user });
          if (path === '/api/realtime/events') return route.abort();
          if (path.endsWith('/branding/public')) return reply(route, {});
          if (path.endsWith('/time')) return reply(route, { now, timeZone: 'Asia/Kuala_Lumpur' });
          if (path.endsWith('/workspace-shortcuts') || path.endsWith('/table-preferences'))
            return reply(route, { items: [] });
          if (
            path.endsWith('/renewals/warning-summary') ||
            path.endsWith('/bank-recharge/renewal-warnings')
          )
            return reply(route, { items: [], total: 0 });
          if (path.endsWith('/sensitive-access/approvals/summary'))
            return reply(route, { pendingCount: 0 });
          if (path.endsWith('/change-events')) return route.abort();
          if (path.endsWith('/change-versions'))
            return reply(route, { generatedAt: now, versions: {} });
          if (path.endsWith('/auto-recharge/jobs'))
            return reply(route, { items: [], configured: true });
          if (
            path.endsWith('/bank-recharge/accounts') ||
            path.endsWith('/bank-recharge/cards') ||
            path.endsWith('/workspace-totp-accounts')
          )
            return reply(route, { items: [], total: 0 });
          if (path.endsWith('/bank-recharge/currencies'))
            return reply(route, {
              items: [{ code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true }]
            });
          if (path.endsWith('/auto-recharge/names/match')) {
            const { number } = request.postDataJSON();
            matchedNumbers.push(number);
            return reply(route, {
              name: number === '4111111111111111' ? 'Historic Person' : 'James Smith',
              confirmed: number === '4111111111111111',
              cardId: null,
              billingAddressId: number === '4111111111111111' ? 'missing-historic-address' : null
            });
          }
          if (path.endsWith('/proxy-pool/countries')) return reply(route, { items: ['PH'] });
          if (path.endsWith('/proxy-pool'))
            return reply(route, {
              items: [
                {
                  id: '88888888-8888-4888-8888-888888888888',
                  countryCode: 'PH',
                  kind: 'mobile',
                  status: 'active',
                  linkMask: '合成代理',
                  remark1: '',
                  remark2: '',
                  connectionMode: 'extraction',
                  protocol: 'http',
                  createdAt: now,
                  updatedAt: now
                }
              ],
              total: 1
            });
          if (path.endsWith('/auto-recharge/bitbrowser-settings'))
            return reply(route, {
              connectorUrl: 'http://127.0.0.1:55322',
              localApiUrl: 'http://127.0.0.1:54345',
              localApiTokenConfigured: true,
              connectorTokenConfigured: true,
              groupName: '合成分组',
              tagName: '合成标签',
              proxyType: 'http',
              dynamicProxyUrlConfigured: true,
              updatedAt: now
            });
          if (path.endsWith('/auto-recharge/server-proxy-settings'))
            return reply(route, { proxyId: null, proxy: null, legacyConfigured: false });
          if (path.endsWith('/auto-recharge/addresses/generate')) {
            const { count } = request.postDataJSON();
            generatedCounts.push(count);
            if (rejectGeneration) {
              rejectGeneration = false;
              return route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ success: false, message: '合成生成失败，请重试' })
              });
            }
            const items = Array.from({ length: count }, () => ({
              id: `22222222-2222-4222-8222-${String(++serial).padStart(12, '0')}`,
              line1: `${100 + serial} Main St`,
              line2: null,
              country: 'US',
              city: 'Nashua',
              state: 'New Hampshire',
              postalCode: '03060',
              status: 'unused',
              usedAt: null,
              createdAt: now,
              updatedAt: now
            }));
            addresses.unshift(...items);
            return reply(route, { count, items });
          }
          if (path.endsWith('/auto-recharge/addresses')) {
            const keyword = url.searchParams.get('keyword') ?? '',
              status = url.searchParams.get('status') ?? 'all';
            const filtered = addresses.filter(
              (item) => item.line1.includes(keyword) && (status === 'all' || item.status === status)
            );
            const page = Number(url.searchParams.get('page') ?? 1),
              pageSize = Number(url.searchParams.get('pageSize') ?? 20);
            return reply(route, {
              items: filtered.slice((page - 1) * pageSize, page * pageSize),
              total: filtered.length,
              page,
              pageSize,
              totals: { unused: addresses.length, used: 0, disabled: 0 }
            });
          }
        }
        forbidden.push(request.method() + ' ' + url.origin + path);
        return route.abort();
      });
      const navigate = async (path) => {
        if (width < 901) await page.setViewportSize({ width: 1440, height: 1100 });
        await page.locator(`a[href="${path}"]`).first().click();
        if (width < 901) {
          await page.setViewportSize({ width, height: 1100 });
          await page.keyboard.press('Escape');
        }
      };
      const measure = async (kind) => {
        await page.screenshot({
          path: resolve(output, `${kind}-${theme}-${width}.png`),
          fullPage: true,
          animations: 'disabled'
        });
        const result = await page.evaluate(() => {
          const controls = [
            ...document.querySelectorAll(
              '.recharge-address-toolbar .el-form-item, .recharge-address-select'
            )
          ].map((item) => {
            const label = item.querySelector('.el-form-item__label'),
              content = item.querySelector('.el-form-item__content');
            const text = label?.firstChild;
            const range = document.createRange();
            if (text) range.selectNodeContents(text);
            const l = label?.getBoundingClientRect(),
              c = content?.getBoundingClientRect(),
              t = text ? range.getBoundingClientRect() : null;
            return {
              label: label?.textContent?.trim(),
              labelRight: l?.right,
              controlLeft: c?.left,
              labelTop: l?.top,
              controlTop: c?.top,
              textTop: t?.top,
              textBottom: t?.bottom
            };
          });
          return {
            scrollWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            controls
          };
        });
        assert.ok(result.scrollWidth <= width + 1, `${kind} ${width}: 横向溢出`);
        for (const item of result.controls)
          if (item.labelRight)
            assert.ok(item.labelRight <= item.controlLeft + 1, `${item.label}: 标签须在左侧`);
        return result;
      };
      await page.goto(origin + '/v2/auto-recharge/addresses');
      await page.getByText('可一键生成地址或导入 TXT 地址文件', { exact: true }).waitFor();
      const emptyLayout = await measure('addresses-empty');
      const count = page.getByRole('spinbutton', { name: '生成地址数量' });
      await count.fill('21');
      await count.blur();
      await page.getByRole('button', { name: '一键生成地址', exact: true }).click();
      await page.getByText('已生成 21 条账单地址，付款前请核对资料。', { exact: true }).waitFor();
      await until(
        async () => (await page.locator('.el-table__body-wrapper tbody tr').count()) === 20
      );
      const firstLayout = await measure('addresses-first');
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await until(
        async () => (await page.locator('.el-table__body-wrapper tbody tr').count()) === 1
      );
      await measure('addresses-last');
      await count.fill('7');
      await count.blur();
      rejectGeneration = true;
      await page.getByRole('button', { name: '一键生成地址', exact: true }).click();
      await page.getByText('合成生成失败，请重试', { exact: true }).waitFor();
      assert.equal(await count.inputValue(), '7');
      addresses = [];
      await navigate('/v2/auto-recharge');
      await page.locator('.recharge-entry-panel').waitFor();
      assert.equal(generatedCounts.length, 2, '空白表单不自动写入地址');
      await page.locator('input[name="recharge-entry-number"]').fill('5555555555554444');
      await until(
        async () =>
          (await page.locator('input[name="recharge-entry-name"]').inputValue()) === 'James Smith'
      );
      await until(async () =>
        (await page.locator('.recharge-fixed-address').innerText()).includes('03060')
      );
      assert.deepEqual(generatedCounts, [21, 7, 1]);
      assert.ok(
        (await page.locator('.recharge-fixed-address').innerText()).includes('New Hampshire')
      );
      assert.ok((await page.locator('.recharge-entry-panel').innerText()).includes('菲律宾'));
      const firstAddress = addresses[0].line1;
      await page.getByRole('button', { name: '一键生成并使用', exact: true }).click();
      await until(
        async () =>
          !(await page.locator('.recharge-fixed-address').innerText()).includes(firstAddress)
      );
      assert.equal(generatedCounts.length, 4);
      const billingLayout = await measure('billing-filled');
      await navigate('/v2/auto-recharge/addresses');
      assert.equal(await count.inputValue(), '7', '切页返回保留生成数量');
      await navigate('/v2/auto-recharge');
      assert.equal(
        await page.locator('input[name="recharge-entry-name"]').inputValue(),
        'James Smith'
      );
      await page
        .getByRole('radio', { name: '仅登录账号', exact: true })
        .locator('xpath=ancestor::label')
        .click();
      const calls = generatedCounts.length,
        matches = matchedNumbers.length;
      await page
        .getByRole('radio', { name: '比特浏览器充值', exact: true })
        .locator('xpath=ancestor::label')
        .click();
      await page.locator('input[name="recharge-entry-number"]').fill('4111111111111111');
      await until(
        async () =>
          (await page.locator('input[name="recharge-entry-name"]').inputValue()) ===
          'Historic Person'
      );
      await until(
        async () =>
          await page.getByRole('button', { name: '一键生成并使用', exact: true }).isDisabled()
      );
      assert.equal(generatedCounts.length, calls, '旧卡缺失绑定地址时禁止自动替换');
      await page
        .getByText('这张卡的绑定地址不可用，请到地址管理核对原地址；系统不会自动替换。', {
          exact: true
        })
        .waitFor();
      assert.equal(await page.locator('.recharge-fixed-address').count(), 0);
      assert.ok(matchedNumbers.length >= matches);
      assert.deepEqual(errors, []);
      assert.deepEqual(forbidden, []);
      report.cases.push({
        width,
        theme,
        generatedCounts,
        emptyLayout,
        firstLayout,
        billingLayout,
        result: 'PASS'
      });
      await context.close();
    }
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'PASS', cases: report.cases.length, evidence: output }));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
    writeFileSync(resolve(output, 'failure.txt'), await lastPage.locator('body').innerText());
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
