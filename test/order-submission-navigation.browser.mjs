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

async function measureNavigation(nav) {
  return nav.evaluate(node => {
    const box = element => element?.getBoundingClientRect().toJSON();
    const columns = node.closest('.commerce-entry-columns');
    const form = columns?.querySelector('.form-panel');
    const records = columns?.querySelector('.entry-records');
    const completion = node.parentElement.querySelector('#completion-list');
    return {
      navigation: box(node),
      form: box(form),
      records: records?.checkVisibility() ? box(records) : null,
      mobileSwitchVisible: columns?.querySelector('.order-entry-mobile-switch')?.checkVisibility(),
      completion: box(completion),
      buttons: [...node.querySelectorAll('.button')].map(button => {
        const label = document.createRange();
        label.selectNodeContents(button);
        return { box: box(button), label: label.getBoundingClientRect().toJSON() };
      })
    };
  });
}

async function assertNavigationLayout(nav, width, completion = false) {
  const { navigation, form, records, mobileSwitchVisible, completion: list, buttons } = await measureNavigation(nav);
  const panel = completion ? list : form;
  assert(panel, '业务按钮应与对应面板同宽');
  assert.equal(buttons.length, links.length);
  assert(Math.abs(buttons[0].box.left - panel.left) <= 1);
  assert(Math.abs(buttons.at(-1).box.right - panel.right) <= 1);
  assert(buttons.every(({ box, label }) =>
    Math.abs(box.width - buttons[0].box.width) <= 1 &&
    Math.abs(box.top - navigation.top) <= 1 && box.height >= (width <= 900 ? 44 : 52) &&
    label.left > box.left && label.right < box.right
  ), '五个按钮应等宽同排，文字在按钮内完整可见');
  if (completion) {
    assert(list.top >= navigation.bottom, '订单补全列表应在按钮下方铺满');
    return navigation;
  }
  assert.equal(mobileSwitchVisible, width <= 900, '录单与记录的切换控件只在手机布局显示');
  if (width >= 1440) {
    assert(records?.left > form.right, '最近订单应在表单右栏');
    assert(Math.abs(records.top - navigation.top) <= 1, '最近订单顶边应与按钮顶边对齐');
    assert(Math.abs(records.bottom - form.bottom) <= 1, '两栏底边应对齐');
  }
  return navigation;
}

test('订单提交合并入口，保留五个旧地址、草稿、权限和手机操作', { timeout: 90_000 }, async t => {
  const { chromium } = await import(browserEntry ? pathToFileURL(browserEntry).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[2062, false], [1440, true], [390, true], [320, false]]) {
    await t.test(width + 'px ' + (dark ? 'dark' : 'light'), async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const traffic = await interceptDesign(context, { actor: actor('super'), localFixtures: fixtures(true), skipRechargeAssets: true });
      const commerceRead = Promise.withResolvers();
      if (width === 2062) {
        await context.route('**/api/local/commerce', async route => {
          await commerceRead.promise;
          await route.fallback();
        }, { times: 1 });
      }
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const nav = page.getByRole('navigation', { name: '订单提交业务切换' });
      const sidebar = page.locator('#sidebar');
      const heading = page.getByRole('heading', { name: '订单提交', exact: true, level: 1 });
      try {
        await page.goto(origin + root + 'order/gpt');
        let loadingNavigation;
        if (width === 2062) {
          await page.getByText('正在读取本机业务资料', { exact: true }).waitFor();
          await settle(page);
          loadingNavigation = (await measureNavigation(nav)).navigation;
          commerceRead.resolve();
        }
        await page.locator('#commerce-order-form').waitFor();
        if (dark) await toggleDesignTheme(page);
        await settle(page);
        const readyNavigation = await assertNavigationLayout(nav, width);
        if (loadingNavigation) {
          for (const edge of ['left', 'right', 'top'])
            assert(Math.abs(loadingNavigation[edge] - readyNavigation[edge]) <= 1,
              '业务按钮在首屏加载前后应保持位置和宽度');
        }
        await page.locator('#commerce-notes').fill('GPT 离线草稿');
        assert.deepEqual(await nav.getByRole('link').allTextContents(), links.map(([label]) => label));
        for (const [label, route] of links.slice(1)) {
          await nav.getByRole('link', { name: label, exact: true }).click();
          await page.waitForURL('**' + root + route);
          await heading.waitFor();
          await settle(page);
          await assertNavigationLayout(nav, width, route === 'order-completion');
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
          const { navigation, records } = await measureNavigation(nav);
          assert(records && Math.abs(navigation.left - records.left) <= 1 && Math.abs(navigation.right - records.right) <= 1);
          await page.getByRole('button', { name: '返回填写', exact: true }).click();
          assert.equal(await page.locator('#commerce-notes').inputValue(), 'Claude 离线草稿');
        }
        assert.equal(await page.locator('h1').count(), 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(traffic.external, []);
      } finally {
        commerceRead.resolve();
        await context.close();
      }
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
