import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const { chromium, webkit } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
const routes = ['workspace/order/gpt', 'workspace/order/claude', 'workspace/order/gemini',
  'workspace/order/grok', 'workspace/order-completion', 'workspace/customer-query'];
const actor = { id: 'viewport-fixture', role: 'super', name: '布局验收', active: true, nicknameSet: false };
const account = { id: 'example', name: '移动布局长账号名称'.repeat(6), issuer: '示例签发方' };

// Browsers in automation do not open an OS keyboard. Change only the visual
// viewport and fire the native event, keeping the layout viewport unchanged.
async function setVisibleArea(page, height, top = 0) {
  await page.evaluate(({ height, top }) => {
    for (const [key, value] of Object.entries({ height, offsetTop: top })) {
      if (height === null) delete visualViewport[key];
      else Object.defineProperty(visualViewport, key, { configurable: true, value });
    }
    visualViewport.dispatchEvent(new Event('resize'));
  }, { height, top });
  await settle(page);
}

for (const engine of [chromium, webkit]) {
  test('mobile viewport, text reflow and order navigation · ' + engine.name(), { timeout: 100_000 }, async t => {
    if (engine === webkit && !existsSync(webkit.executablePath())) return t.skip('WebKit is not installed');
    const browser = await engine.launch(engine === chromium ? { channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL } : {});
    t.after(() => browser.close());
    for (const width of [320, 360, 390, 430]) {
      await t.test(width + 'px', async t => {
        const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
        t.after(() => context.close());
        await interceptDesign(context, { actor, localAuthUi: true, skipRechargeAssets: true, localFixtures: {
          'saved-totp': { version: 1, items: [account] },
          'auth/security': { bound: true, recoveryRemaining: 8, deviceLock: false, devices: [] }
        } });
        await context.route(origin + '/api/local/saved-totp/code', route => {
          const serverNow = Date.now();
          return route.fulfill({ json: { version: 1, serverNow, items: [{ id: account.id, code: '12345678', expiresAt: serverNow + 60_000 }] } });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        await page.goto(origin + '/#/workspace/order/gpt');
        const nav = page.locator('#main .order-submission-navigation:visible');
        for (const route of routes) {
          const item = nav.locator(`a[href="#/${route}"]`);
          await item.click();
          await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
          await settle(page);
          await item.waitFor();
          assert.equal(await nav.locator('[aria-current=page]').getAttribute('href'), '#/' + route);
          const box = await item.boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 44);
        }
        await nav.locator(`a[href="#/${routes[0]}"]`).click();
        const footer = page.locator('#mobile-entry-actions');
        await footer.waitFor();
        if (engine === chromium) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
          await page.waitForFunction(() => visualViewport.scale > 1.9);
          await settle(page);
          assert.equal(await footer.evaluate(n => getComputedStyle(n).bottom), '0px', 'zoom alone must not lift Save');
          await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
          await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 12, right: 12 } });
          await settle(page);
          const menu = await page.locator('#nav-toggle').boundingBox();
          const save = await footer.locator('button:visible').last().boundingBox();
          assert(menu.y >= 47 && menu.x >= 12 && save.y + save.height <= 800 - 34);
          const actions = await page.locator('.topbar-actions button:visible').evaluateAll(nodes =>
            nodes.map(n => n.getBoundingClientRect().toJSON()).sort((a, b) => a.left - b.left));
          assert(actions.every((box, i) => box.width >= 44 && box.height >= 44 &&
            box.right <= width - 12 + 1 && (!i || box.left >= actions[i - 1].right - 1)));
          assert(await page.locator('.topbar h1').evaluate(el => el.clientWidth >= 28), '顶栏入口保留页名的阅读空间');
        }
        await page.locator('#profile-button').click();
        const drawer = page.locator('#drawer[open]');
        const field = drawer.locator('#self-nickname');
        await field.fill('键盘测试草稿');
        for (const [height, top] of [[360, 0], [320, 18]]) {
          await setVisibleArea(page, height, top);
          const bounds = await drawer.boundingBox();
          const fieldBox = await field.boundingBox();
          const area = await drawer.locator('.drawer-body').boundingBox();
          const close = await drawer.getByRole('button', { name: '关闭抽屉' }).boundingBox();
          const bottom = await drawer.locator('.drawer-footer .button:visible').last().boundingBox();
          assert(Math.abs(bounds.y - top) <= 1 && bounds.y + bounds.height <= top + height + 1);
          assert(fieldBox.y >= area.y - 1 && fieldBox.y + fieldBox.height <= area.y + area.height + 1);
          assert(close.y >= top && bottom.y + bottom.height <= top + height - (engine === chromium ? 34 : 0) + 1);
          assert(await field.evaluate(n => document.activeElement === n));
        }
        await setVisibleArea(page, null);
        assert.equal(await field.inputValue(), '键盘测试草稿');
        assert(Math.abs((await drawer.boundingBox()).height - 800) <= 1);
        if (width === 320) {
          await page.setViewportSize({ width: 740, height: 360 });
          await setVisibleArea(page, 170);
          const action = drawer.getByRole('button', { name: '关闭', exact: true });
          await action.scrollIntoViewIfNeeded();
          const actionBox = await action.boundingBox();
          assert(actionBox.y >= 0 && actionBox.y + actionBox.height <= 171, '横屏键盘上方能看到完整操作');
          await setVisibleArea(page, null);
          await page.setViewportSize({ width, height: 800 });
          assert.equal(await field.inputValue(), '键盘测试草稿');
        }
        await drawer.getByRole('button', { name: '关闭抽屉' }).click();
        assert(await page.locator('#profile-button').evaluate(n => document.activeElement === n));
        if (engine === chromium) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
        }
        await page.locator('#mobile-tools-toggle').click();
        await page.locator('#mobile-tools-panel [data-tab="在线工具"]').click();
        await drawer.locator('[data-name="计算 2FA 验证码"]').click();
        const row = drawer.locator('.saved-totp-table tbody tr').first();
        await row.locator('.ops-code').waitFor();
        // Scale rendered text, including explicit pixel sizes, independently of box sizes.
        const readings = await row.evaluate(node => {
          const name = node.querySelector('.totp-account-name strong');
          const code = node.querySelector('.ops-code');
          const time = node.querySelector('.totp-countdown');
          const elements = [name, code, time, ...time.children, ...node.querySelectorAll('button')];
          const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
          const rect = el => el.getBoundingClientRect().toJSON();
          return [1, 1.25, 1.5, 2].map(scale => {
            elements.forEach((el, i) => { el.style.fontSize = sizes[i] * scale + 'px'; });
            return { scale, name: rect(name), code: rect(code), time: rect(time), row: rect(node),
              actions: Array.from(node.querySelectorAll('button'), rect) };
          });
        });
        for (const { scale, name, code, time, row: card, actions } of readings) {
          assert(name.width >= 32 && name.right <= code.left - 2, `${width}/${scale} account and code overlap`);
          assert(code.right <= time.left - 2 || code.bottom <= time.top, 'countdown overlaps code');
          assert(code.right <= card.right && time.right <= card.right);
          assert.equal(actions.length, 3);
          assert(actions.every(b => b.top >= Math.max(code.bottom, time.bottom) && b.left >= card.left && b.right <= card.right && b.height >= 44));
        }
        await drawer.getByRole('button', { name: '关闭抽屉' }).click();
        await drawer.locator('[data-name="计算 2FA 验证码"]').waitFor();
        await drawer.getByRole('button', { name: '关闭抽屉' }).click();
        assert(await page.locator('#mobile-tools-toggle').evaluate(n => document.activeElement === n));

        await page.goto(origin + '/#/overview');
        const period = page.locator('.overview-period-compact');
        await period.click();
        await drawer.locator('[data-overview-accounting-filter="currency"]').waitFor();
        await drawer.getByRole('button', { name: '关闭抽屉' }).click();
        const toolbar = page.locator('.overview-toolbar');
        for (const scale of [1, 2]) {
          const size = await toolbar.evaluate((node, scale) => {
            const elements = [node, ...node.querySelectorAll('div,button,select,span')].filter(n => n.getClientRects().length);
            const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
            elements.forEach((el, i) => { el.style.fontSize = sizes[i] * scale + 'px'; });
            const date = node.querySelector('.overview-period-compact');
            return { dateWidth: date.clientWidth, textWidth: date.scrollWidth, pageWidth: document.documentElement.scrollWidth,
              controls: Array.from(node.querySelectorAll('button,select')).filter(el => el.checkVisibility())
                .map(el => el.getBoundingClientRect().toJSON()) };
          }, scale);
          assert(size.textWidth <= size.dateWidth + 1 && size.pageWidth <= width + 1);
          assert(size.controls.every(box => box.left >= 0 && box.right <= width + 1 && box.height >= 44));
        }
        const amount = page.locator('[data-overview-metric="profit"] .overview-metric-value strong');
        const lines = await amount.evaluate(el => {
          el.textContent = '9,876,543.21';
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        });
        assert.equal(lines, 1, '金额能在卡片完整宽度排下时应整体换行');

        await page.goto(origin + '/#/accounts/apple-balances');
        const empty = page.locator('#main .table-viewport--empty:visible').first();
        await empty.locator('td[colspan]').waitFor();
        assert(await empty.evaluate(el => el.scrollWidth <= el.clientWidth + 1), '空列表提示应完整显示');
      });
    }
  });
}
