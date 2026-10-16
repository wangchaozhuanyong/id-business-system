/* global document, window */
// Read the built Admin app through intercepted browser requests. No server, database or external traffic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, process.env.SHARED_CARD_ADMIN_DIST || 'apps/admin/dist');
const output = resolve(
  root,
  process.env.SHARED_CARD_UI_OUTPUT || '.runtime/shared-bank-pool-release/ui'
);
mkdirSync(output, { recursive: true });
const origin = 'https://shared-bank-cards.example.test';
const cardId = '22222222-2222-4222-8222-222222222222';
const actor = {
  id: 'shared-card-fixture-admin',
  username: '合成管理员',
  displayName: '合成管理员',
  mustResetPassword: false,
  roles: ['admin'],
  permissions: ['*']
};
const card = {
  id: cardId,
  last4: '1111',
  expiryMonth: 12,
  expiryYear: 2099,
  holderName: '合成账单姓名',
  status: 'active',
  allowedPlans: ['plus'],
  successCount: 0,
  declineCount: 1,
  addressId: null,
  addressSummary: '未绑定，按地区分配',
  inUse: false,
  hasCvc: false,
  updatedAt: '2026-10-16T08:00:00Z'
};
const report = {
  scope: 'OFFLINE_BUILT_APP_SYNTHETIC_ONLY',
  websiteServerStarted: false,
  databaseConnected: false,
  realPayment: false,
  cases: []
};
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript(
        ({ actor, theme }) => {
          localStorage.setItem('apple_business_access_token', 'synthetic-access');
          localStorage.setItem('apple_business_current_user', JSON.stringify(actor));
          localStorage.setItem('id-business-v2-theme', theme);
        },
        { actor, theme }
      );
      const requests = [],
        errors = [],
        blocked = [];
      let empty = false,
        saveFail = true;
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        if (url.origin !== origin) {
          blocked.push(url.origin);
          return route.abort();
        }
        const ok = (data) =>
          route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data })
          });
        if (!path.startsWith('/api/')) {
          const file = resolve(dist, '.' + path);
          const target = existsSync(file) && extname(file) ? file : resolve(dist, 'index.html');
          const types = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2'
          };
          return route.fulfill({
            body: readFileSync(target),
            contentType: types[extname(target)] ?? 'application/octet-stream'
          });
        }
        if (path === '/api/auth/me') return ok(actor);
        if (path.endsWith('/change-events')) return route.abort();
        if (path.endsWith('/change-versions')) return ok({ versions: {} });
        if (path.includes('/online-recharge/admin/cards')) {
          if (request.method() === 'GET') {
            const plan = url.searchParams.get('plan');
            return ok({
              items: empty || (plan && plan !== 'plus') ? [] : [card],
              total: empty ? 0 : 41,
              page: Number(url.searchParams.get('page') ?? 1),
              pageSize: 20
            });
          }
          const body = request.postDataJSON();
          requests.push({ path, body });
          if (saveFail)
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成保存失败，输入保留' })
            });
          return ok({ success: true });
        }
        if (path.endsWith('/proxy-pool/countries')) return ok({ items: [] });
        if (path.endsWith('/auto-recharge/jobs')) return ok({ configured: false, items: [] });
        if (path.endsWith('/auto-recharge/bitbrowser-settings')) return ok({});
        if (path.endsWith('/bank-recharge/currencies'))
          return ok({ items: [{ code: 'PHP', name: '菲律宾比索', active: true, minorUnits: 2 }] });
        if (path.endsWith('/bank-card-pool/options'))
          return ok({
            items:
              url.searchParams.get('plan') === 'plus'
                ? [{ ...card, label: '合成共享卡', active: true, hasNumber: true }]
                : []
          });
        if (path.endsWith('/payment-details'))
          return ok({
            ...card,
            number: '4111111111111111',
            expiry: '12/99',
            billingName: null,
            billingAddressId: null
          });
        if (path.endsWith('/auto-recharge/names/match'))
          return ok({
            name: '合成账单姓名',
            confirmed: false,
            cardId: null,
            billingAddressId: null
          });
        if (/\/online-recharge\/admin\/(jobs|billing)$/.test(path))
          return ok({
            items: empty
              ? []
              : [
                  {
                    id: cardId,
                    status: 'succeeded',
                    plan: 'plus',
                    provider: 'local',
                    progress: 100,
                    message: '合成记录',
                    createdAt: card.updatedAt
                  }
                ],
            total: empty ? 0 : 41,
            page: 1,
            pageSize: 20
          });
        return ok({ items: [], total: 0, preferences: [] });
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin + '/v2/online-recharge/cards');
      await page.waitForURL(origin + '/v2/account-settings/bank-cards');
      await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
      assert.ok(await page.getByText('连续明确拒付次数', { exact: true }).count());
      assert.ok(await page.getByText('Plus 套餐', { exact: true }).count());
      const measure = () =>
        page.evaluate(() => {
          const frame = document.querySelector('.v2-records-list').getBoundingClientRect();
          return {
            top: frame.top,
            bottom: frame.bottom,
            height: frame.height,
            parts: [...document.querySelector('.v2-records-list').children].map((item) => ({
              class: item.className,
              height: item.getBoundingClientRect().height
            })),
            documentWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth
          };
        });
      const first = await measure();
      assert.ok(first.documentWidth <= width + 1, '页面不能横向溢出');
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-cards.png`),
        animations: 'disabled',
        fullPage: true
      });
      await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
      await page.getByText('编辑适用套餐', { exact: true }).last().click();
      const drawer = page.getByRole('dialog', { name: '编辑适用套餐' });
      await drawer.waitFor();
      await drawer
        .getByRole('button', { name: '编辑适用套餐', exact: true })
        .scrollIntoViewIfNeeded();
      await drawer.getByText('Plus 套餐', { exact: true }).waitFor();
      const labels = await drawer.locator('.el-form-item').evaluateAll((items) =>
        items.map((item) => {
          const label = item.querySelector('.el-form-item__label').getBoundingClientRect();
          const control = item.querySelector('.el-form-item__content').getBoundingClientRect();
          return {
            labelRight: label.right,
            controlLeft: control.left,
            labelTop: label.top,
            controlTop: control.top
          };
        })
      );
      assert.ok(
        labels.every(
          (item) =>
            item.labelRight <= item.controlLeft + 2 &&
            Math.abs(item.labelTop - item.controlTop) <= 2
        ),
        '标签须在首行控件左侧'
      );
      await drawer.getByRole('button', { name: '编辑适用套餐', exact: true }).click();
      await drawer.getByText('合成保存失败，输入保留', { exact: true }).waitFor();
      assert.deepEqual(requests.at(-1).body.allowedPlans, ['plus']);
      await drawer.getByRole('button', { name: '关闭', exact: true }).last().click();
      await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
      await page.getByText('编辑适用套餐', { exact: true }).last().click();
      await drawer.getByText('Plus 套餐', { exact: true }).waitFor();
      saveFail = false;
      await drawer.getByRole('button', { name: '编辑适用套餐', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '添加银行卡', exact: true }).click();
      const create = page.getByRole('dialog', { name: '添加银行卡' });
      await create.waitFor();
      await create
        .getByRole('button', { name: '添加银行卡', exact: true })
        .scrollIntoViewIfNeeded();
      const bounds = await create.boundingBox();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= width + 1, '银行卡抽屉须处于当前视口');
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-create.png`),
        animations: 'disabled',
        fullPage: true
      });
      await create.getByRole('button', { name: '关闭', exact: true }).last().click();
      // Verify the last page and empty list keep their frame size.
      const next = page.locator('.btn-next').first();
      await next.click();
      await next.click();
      await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
      const last = await measure();
      empty = true;
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await page.getByText('暂无记录', { exact: true }).first().waitFor();
      const emptyFrame = await measure();
      assert.ok(
        Math.abs(first.height - last.height) <= 2 &&
          Math.abs(first.height - emptyFrame.height) <= 2,
        '分页与空状态框架不能收缩 ' + JSON.stringify({ first, last, emptyFrame })
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      report.cases.push({
        theme,
        width,
        first,
        last,
        empty: emptyFrame,
        labels,
        saveRetry: true,
        reopenDraft: true,
        result: 'PASS'
      });
      for (const section of ['jobs', 'billing']) {
        empty = false;
        await page.goto(origin + `/v2/online-recharge/${section}`);
        await page.locator('.v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
        const populated = await measure();
        empty = true;
        await page.getByRole('button', { name: '刷新', exact: true }).first().click();
        await page.getByText('暂无记录', { exact: true }).first().waitFor();
        const cleared = await measure();
        assert.ok(
          Math.abs(populated.height - cleared.height) <= 2,
          `${section} 空列表保持共享框架尺寸`
        );
        report.cases.push({ theme, width, section, populated, cleared, result: 'PASS' });
      }
      await page.goto(origin + '/v2/auto-recharge');
      await page.getByRole('radio', { name: '比特浏览器充值', exact: true }).check();
      const allocate = page.getByRole('button', { name: '智能分配', exact: true });
      const matched = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/auto-recharge/names/match')
      );
      await allocate.click();
      await matched;
      await page.evaluate(() => new Promise((done) => window.requestAnimationFrame(done)));
      await page.waitForFunction(
        () =>
          document.querySelector('input[name="recharge-entry-number"]')?.value ===
          '4111111111111111'
      );
      assert.ok(
        (await page.locator('.recharge-saved-card').innerText()).includes('合成共享卡'),
        '姓名回填后保留共享池选卡'
      );
      await page.screenshot({
        path: resolve(output, `${theme}-${width}-bit-card.png`),
        animations: 'disabled',
        fullPage: true
      });
      const bitWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(bitWidth <= width + 1, '比特共享卡表单不能横向溢出');
      assert.deepEqual(errors, []);
      assert.deepEqual(blocked, []);
      report.cases.push({
        theme,
        width,
        section: 'bit-card',
        intelligentAllocation: true,
        result: 'PASS'
      });
      await context.close();
    }
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, cases: report.cases.length, output }));
} finally {
  await browser.close();
}
