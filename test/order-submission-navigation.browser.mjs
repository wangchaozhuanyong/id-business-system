import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const browserEntry = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const links = [['GPT', 'order/gpt'], ['Claude', 'order/claude'], ['Gemini', 'order/gemini'],
  ['Grok', 'order/grok'], ['订单补全', 'order-completion']];
const root = '/#/workspace/';
const actor = role => ({ id: 'qa-' + role, name: '离线验收', role });
const fixtures = canAssign => ({ 'order-completion': { items: [], manualItems: [], canAssign } });

test('订单提交合并入口，保留五个旧地址、草稿、权限和手机操作', { timeout: 90_000 }, async t => {
  const { chromium } = await import(browserEntry ? pathToFileURL(browserEntry).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [390, true], [320, false]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const traffic = await interceptDesign(context, { actor: actor('super'), localFixtures: fixtures(true), skipRechargeAssets: true });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const nav = page.getByRole('navigation', { name: '订单提交业务切换' });
      const sidebar = page.locator('#sidebar');
      const heading = page.getByRole('heading', { name: '订单提交', exact: true, level: 1 });
      try {
        await page.goto(origin + root + 'order/gpt');
        await page.locator('#commerce-order-form').waitFor();
        if (dark) await toggleDesignTheme(page);
        await page.locator('#commerce-notes').fill('GPT 离线草稿');
        assert.deepEqual(await nav.getByRole('link').allTextContents(), links.map(([label]) => label));
        for (const [label, route] of links.slice(1)) {
          await nav.getByRole('link', { name: label, exact: true }).click();
          await page.waitForURL('**' + root + route);
          await heading.waitFor();
          await settle(page);
          assert.equal(await nav.locator('[aria-current="page"]').textContent(), label);
          assert.equal(await sidebar.locator('.nav-child[aria-current="page"]').textContent(), '订单提交');
          assert(await nav.evaluate(node => {
            const a = node.getBoundingClientRect(), b = node.querySelector('[aria-current="page"]').getBoundingClientRect();
            return b.left >= a.left - 1 && b.right <= a.right + 1;
          }), '当前业务页签必须完整可见');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          if (route === 'order/claude') {
            assert.equal(await page.locator('#commerce-notes').inputValue(), '');
            await page.locator('#commerce-notes').fill('Claude 离线草稿');
          }
        }
        const empty = page.getByText('暂无待补全订单', { exact: true });
        await empty.waitFor();
        assert((await page.locator('#completion-list .table-viewport').boundingBox()).height < 340,
          '补全空列表不应撑满剩余视口');
        await page.goBack();
        await nav.getByRole('link', { name: 'Grok', exact: true }).and(nav.locator('[aria-current="page"]')).waitFor();
        await nav.getByRole('link', { name: 'GPT', exact: true }).click();
        assert.equal(await page.locator('#commerce-notes').inputValue(), 'GPT 离线草稿');
        await nav.getByRole('link', { name: 'Claude', exact: true }).click();
        assert.equal(await page.locator('#commerce-notes').inputValue(), 'Claude 离线草稿');
        if (width <= 900) {
          await page.getByRole('button', { name: '最近订单', exact: true }).click();
          await page.getByRole('heading', { name: '最近订单', exact: true }).waitFor();
          await page.getByRole('button', { name: '返回填写', exact: true }).click();
          assert.equal(await page.locator('#commerce-notes').inputValue(), 'Claude 离线草稿');
        }
        assert.equal(await page.locator('h1').count(), 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
      } finally { await context.close(); }
    });
  }
  await t.test('员工保留订单补全入口且不能进入手工录单', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await interceptDesign(context, { actor: actor('employee'), localFixtures: fixtures(false), skipRechargeAssets: true });
    const page = await context.newPage();
    try {
      await page.goto(origin + root + 'order-completion');
      const nav = page.getByRole('navigation', { name: '订单提交业务切换' });
      await nav.waitFor();
      assert.deepEqual(await nav.getByRole('link').allTextContents(), ['订单补全']);
      const sidebar = page.locator('#sidebar').getByRole('link', { name: '订单提交', exact: true });
      assert.equal(await sidebar.getAttribute('href'), '#/workspace/order-completion');
      await page.goto(origin + root + 'order/gpt');
      await page.getByRole('heading', { name: '访问受限', exact: true }).waitFor();
      assert.equal(await nav.count(), 0);
      assert.equal(await page.locator('#commerce-order-form').count(), 0);
    } finally { await context.close(); }
  });
});
