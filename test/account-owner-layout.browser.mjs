import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { toggleDesignTheme, interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/account-owner-layout-20261110';
const actor = { id: 'owner-a', name: '超级管理员', role: 'admin' };
const people = [actor, { id: 'owner-b', name: '张晓明', role: 'employee' }];

async function setup(browser, { width = 1440, height = 900, dark = false, long = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const fixtures = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url), 'utf8'));
  fixtures['auth/order-owners'] = { items: people };
  const traffic = await interceptDesign(context, { actor, localFixtures: fixtures, skipRechargeAssets: true });
  const row = { id: 'owner-fixture', accountId: fixtures.inventory.data.accounts[0].id, product: 'GPT',
    account: long ? 'long-account-'.repeat(30) + '@example.test' : 'account@example.test',
    ownerId: actor.id, ownerName: actor.name, ownerEligible: true, revision: 'fixture-1', operatorName: actor.name,
    series: [{ plan: 'Plus', status: 'active', start: '2026-11-01', expiry: '2026-12-01', remainingDays: 30 }], history: [] };
  await context.route('**/api/local/subscriptions/account', route => route.fulfill({ json: row }));
  await context.route('**/api/local/subscriptions/list', route => route.fulfill({ json: {
    items: [row], total: 1, accountCount: 1, page: 1, pageSize: 20,
    counts: { active: 1, expired: 0, pending: 0, ended: 0 }, revision: 'fixture-1'
  } }));
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/subscriptions/gpt');
  await page.locator('#subscription-list tbody tr[data-row-id]').waitFor();
  if (dark) await toggleDesignTheme(page);
  const open = async () => {
    await page.locator('[data-action="subscriptions-more"]').click();
    await page.getByRole('menuitem', { name: '设置归属人' }).click();
    await page.locator('#subscription-owner').waitFor();
  };
  const ready = () => page.locator('#subscription-owner:not([disabled])').waitFor();
  const snapshot = () => page.locator('#drawer').evaluate(drawer => {
    const box = selector => drawer.querySelector(selector).getBoundingClientRect().toJSON();
    return { drawer: drawer.getBoundingClientRect().toJSON(), body: box('.drawer-body'),
      account: box('#subscription-owner-account'), current: box('#subscription-current-owner'), select: box('#subscription-owner'),
      labels: [...drawer.querySelectorAll('.compact-form-context dt, label[for="subscription-owner"]')].map(node => node.getBoundingClientRect().toJSON()),
      save: box('[type="submit"]'), overflow: drawer.scrollWidth > drawer.clientWidth,
      bodyOverflow: drawer.querySelector('.drawer-body').scrollWidth > drawer.querySelector('.drawer-body').clientWidth };
  });
  return { context, page, row, open, ready, snapshot, errors, traffic };
}

test('账号归属编辑紧凑布局、文字对齐、说明与草稿在宽窄屏深浅主题均可用', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(output, { recursive: true });
  const measurements = [];
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const dark of [false, true]) {
    await t.test(`${width}px ${dark ? '深色' : '浅色'}`, async () => {
      const { context, page, row, open, ready, snapshot, errors, traffic } = await setup(browser, { width, dark });
      try {
        await open(); await ready(); await settle(page);
        const geometry = await snapshot();
        measurements.push({ width, dark, ...geometry });
        assert(geometry.drawer.width <= 560 && geometry.drawer.height < 500, '单字段编辑不再撑满整屏');
        assert(geometry.drawer.x >= 16 && geometry.drawer.right <= width - 16 && geometry.drawer.top >= 16);
        assert(!geometry.overflow && !geometry.bodyOverflow);
        assert(geometry.labels.every(label => Math.abs(label.x - geometry.labels[0].x) <= 1), '上下文与表单左侧标签对齐');
        assert(Math.abs(geometry.account.x - geometry.current.x) <= 1, '只读信息值列对齐');
        assert(Math.abs(geometry.labels[0].x - geometry.select.x) <= 1 && geometry.select.top >= geometry.labels.at(-1).bottom, '上方标签与选择框左边缘对齐');
        assert(Math.abs(geometry.save.right - geometry.select.right) <= 1, '提交与选择框右边缘对齐');
        assert(geometry.save.height >= (width <= 900 ? 44 : 36));
        assert.equal(await page.locator('#subscription-owner-account').textContent(), row.account);
        assert.equal(await page.locator('#subscription-current-owner').textContent(), actor.name);
        await page.locator('#drawer .title-help summary').click();
        await page.getByText('归属人与订单录入人分别记录，历史订单保持原值。', { exact: true }).waitFor();
        assert.equal((await snapshot()).drawer.height, geometry.drawer.height, '说明浮层不能撑高表单');
        await page.keyboard.press('Escape');
        assert(await page.locator('#drawer').isVisible(), '关闭说明不应关闭编辑表单');
        if (width === 1440 || width === 390) {
          await page.locator('#drawer-title').click();
          await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
          await page.screenshot({ path: `${output}/after-${width}-${dark ? 'dark' : 'light'}.png` });
          await page.locator('#drawer').screenshot({ path: `${output}/panel-${width}-${dark ? 'dark' : 'light'}.png` });
        }
        await page.locator('#subscription-owner').selectOption('owner-b');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await open(); await ready();
        assert.equal(await page.locator('#subscription-owner').inputValue(), 'owner-b', '关闭重开保留选择');
        assert.equal(await page.locator('#subscription-current-owner').textContent(), actor.name, '未保存的选择不冒充当前归属');
        assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
      } finally { await context.close(); }
    });
  }
  await writeFile(output + '/geometry.json', JSON.stringify(measurements, null, 2));
});

test('账号归属编辑覆盖读取失败重试、空员工、保存失败与长资料短视口', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await t.test('员工读取期间禁用，失败后关闭重试恢复', async () => {
    const { context, page, open, ready } = await setup(browser);
    try {
      const held = Promise.withResolvers();
      await context.route('**/api/local/auth/order-owners', async route => { await held.promise; await route.fulfill({ status: 503, json: { error: '读取失败' } }); }, { times: 1 });
      await open();
      assert(await page.locator('#subscription-owner').isDisabled());
      assert(await page.locator('#subscription-owner-form [type="submit"]').isDisabled());
      held.resolve();
      await page.locator('#subscription-owner-error').filter({ hasText: '员工列表读取失败' }).waitFor();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await open(); await ready();
    } finally { await context.close(); }
  });
  await t.test('无员工时明确提示且不可提交', async () => {
    const { context, page, open } = await setup(browser);
    try {
      await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [] } }));
      await open();
      await page.locator('#subscription-owner').filter({ hasText: '暂无可选员工' }).waitFor();
      assert(await page.locator('#subscription-owner').isDisabled());
      assert(await page.locator('#subscription-owner-form [type="submit"]').isDisabled());
    } finally { await context.close(); }
  });
  await t.test('保存失败保留选择，重试沿用原账号和版本且不重复发送', async () => {
    const { context, page, open, ready, row } = await setup(browser);
    try {
      const commands = [], release = Promise.withResolvers();
      await context.route('**/api/local/subscriptions/owner', async route => {
        commands.push(route.request().postDataJSON());
        if (commands.length === 1) return route.fulfill({ status: 503, json: { error: '合成保存失败' } });
        await release.promise;
        return route.fulfill({ json: { saved: true } });
      });
      await open(); await ready();
      await page.locator('#subscription-owner').selectOption('owner-b');
      const save = page.locator('#subscription-owner-form [type="submit"]');
      await save.click();
      await page.locator('#subscription-owner-error:not([hidden])').waitFor();
      assert.equal(await page.locator('#subscription-owner').inputValue(), 'owner-b');
      await save.click();
      await page.locator('#subscription-owner-form [type="submit"][aria-busy="true"]').waitFor();
      assert(await save.isDisabled());
      release.resolve();
      await page.locator('#drawer').waitFor({ state: 'hidden' });
      assert.equal(commands.length, 2);
      assert.deepEqual(commands[0], commands[1]);
      assert.equal(commands[1].id, row.id); assert.equal(commands[1].revision, row.revision);
    } finally { await context.close(); }
  });
  await t.test('长账号在短视口内换行，正文可滚动到保存按钮', async () => {
    const { context, page, open, ready, snapshot } = await setup(browser, { width: 390, height: 360, long: true });
    try {
      await open(); await ready();
      const geometry = await snapshot();
      assert(geometry.drawer.bottom <= 344 && !geometry.overflow && !geometry.bodyOverflow);
      assert(await page.locator('#drawer .drawer-body').evaluate(node => node.scrollHeight > node.clientHeight));
      await page.locator('#subscription-owner-form [type="submit"]').scrollIntoViewIfNeeded();
      const final = await snapshot();
      assert(final.save.bottom <= final.drawer.bottom && final.save.top >= final.body.top, '按钮可以完整滚入正文可见区域');
    } finally { await context.close(); }
  });
});
