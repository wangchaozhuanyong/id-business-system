import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, root, settle, separatorSnapshot } from './helpers/offline-design.mjs';

const actor = { id: 'card-settings-admin', name: '测试管理员', role: 'admin' };
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/card-type-settings-20261110';
const fixtures = () => ({ version: 4, assignments: { 'recharge:1': 'type-0' }, items: [
  ...['vccwc999', 'wise潘', 'wise佳', '小红卡峰'].map((name, index) => ({ id: 'type-' + index, name, active: true })),
  { id: 'historical', name: '旧版订阅卡', active: false }
] });

test('代付国家银行卡类型：响应式、历史状态、草稿、错误和并发保存', { timeout: 180_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  await mkdir(output, { recursive: true });
  const evidence = [];
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 960 }, locale: 'zh-CN' });
      try {
        let data = fixtures(), failRead = false, holdRead, releaseRead, failWrite = false, holdWrite, releaseWrite;
        const writes = [], errors = [];
        const mock = await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
        await context.route('**/api/local/card-types', async route => {
          if (route.request().method() === 'GET') {
            if (holdRead) { holdRead(); await new Promise(resolve => { releaseRead = resolve; }); }
            return route.fulfill(failRead ? { status: 503, json: { error: '测试读取失败' } } : { json: data });
          }
          const command = route.request().postDataJSON();
          writes.push(command);
          if (holdWrite) { holdWrite(); await new Promise(resolve => { releaseWrite = resolve; }); }
          if (failWrite) return route.fulfill({ status: 503, json: { error: '保存失败，请重试，输入已保留' } });
          if (command.version !== data.version) return route.fulfill({ status: 409, json: { error: '银行卡类型已更新，请读取最新后重试' } });
          const name = command.name?.trim();
          if (name && data.items.some(row => row.active && row.id !== command.id && row.name.toLowerCase() === name.toLowerCase()))
            return route.fulfill({ status: 409, json: { error: '银行卡类型名称已存在' } });
          if (command.action === 'add') data.items.push({ id: 'added-' + data.version, name, active: true });
          if (command.action === 'rename') data.items.find(row => row.id === command.id).name = name;
          if (command.action === 'remove') {
            if (Object.values(data.assignments).includes(command.id)) data.items.find(row => row.id === command.id).active = false;
            else data.items = data.items.filter(row => row.id !== command.id);
          }
          data.version++;
          return route.fulfill({ json: data });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/settings/payment-countries');
        if (theme === 'dark') await page.locator('#theme-toggle').click();
        await page.getByRole('tab', { name: '银行卡类型', exact: true }).click();
        const region = page.locator('[data-card-type-settings]');
        const table = region.locator('table');
        const search = page.getByLabel('搜索银行卡类型');
        const status = page.getByLabel('银行卡类型状态');
        const refresh = () => page.locator('[data-action="commerce-card-type-settings-refresh"]').first().click();
        const drawer = page.locator('#drawer[open]');
        const add = () => page.getByRole('button', { name: '新增类型', exact: true }).click();
        const save = () => drawer.locator('button[form="commerce-card-type-form"]').click();
        const close = () => drawer.getByRole('button', { name: '取消', exact: true }).click();
        const input = () => drawer.locator('#commerce-card-type-name');
        await table.getByText('wise潘', { exact: true }).waitFor();
        const capture = async state => {
          await settle(page);
          const spacing = await separatorSnapshot(page);
          assert.deepEqual(spacing.findings, [], state + ' 控件与分隔线');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, state + ' 页面无溢出');
          evidence.push({ width, theme, state, spacing });
        };
        await capture('list');
        if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/card-types-${width}-${theme}.png`, fullPage: true });
        assert.equal(await table.getByRole('button', { name: '修改', exact: true }).count(), 4);
        assert.equal(await page.locator('#page-title').getByText('代付国家', { exact: true }).count(), 1);
        await status.selectOption('inactive');
        assert.equal(await table.locator('tbody tr').count(), 1);
        assert.equal(await table.getByRole('button', { name: '修改', exact: true }).count(), 0);
        await status.selectOption('all');
        await search.fill('WISE');
        assert.equal(await table.locator('tbody tr').count(), 2);
        await page.getByRole('tab', { name: '套餐售价', exact: true }).click();
        await page.getByRole('tab', { name: '银行卡类型', exact: true }).click();
        assert.equal(await search.inputValue(), 'WISE');
        await search.fill('不存在');
        await page.getByText('暂无符合条件的类型', { exact: true }).waitFor();
        await capture('filtered-empty');
        await search.fill('');
        await add();
        await input().fill('待保存类型');
        await close();
        await add();
        assert.equal(await input().inputValue(), '待保存类型');
        const alignment = await drawer.evaluate(el => {
          const control = el.querySelector('#commerce-card-type-name').getBoundingClientRect();
          const label = el.querySelector('label[for="commerce-card-type-name"]').getBoundingClientRect();
          return { left: label.right <= control.left + 1, aligned: Math.abs(label.top - control.top) < 10 };
        });
        assert.deepEqual(alignment, { left: true, aligned: true });
        if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/card-type-add-${width}-${theme}.png`, fullPage: true });
        await close();
        await capture('drawer-draft');

        data.items.push(...Array.from({ length: 24 }, (_, i) => ({ id: 'page-' + i, name: '测试分页类型 ' + (i + 1), active: true })));
        data.version++;
        await refresh();
        await region.locator('[data-total="29"]').waitFor();
        await region.getByRole('button', { name: '下一页', exact: true }).click();
        await region.locator('[data-page="2"][data-pagination]').waitFor();
        await capture('last-page');
        await page.evaluate(() => window.IDDesignAPI.go('overview'));
        await page.evaluate(() => window.IDDesignAPI.go('settings/payment-countries'));
        await region.locator('[data-page="2"][data-pagination]').waitFor();
        failRead = true;
        const started = new Promise(resolve => { holdRead = resolve; });
        await refresh();
        await started;
        assert.equal(await table.locator('tbody tr').count(), 9, '慢刷新保留列表');
        holdRead = null;
        releaseRead();
        await region.getByText('刷新失败，已保留上次读取的类型。', { exact: true }).waitFor();
        assert.equal(await table.locator('tbody tr').count(), 9);
        await capture('refresh-error');
        failRead = false;
        data.items = fixtures().items;
        data.version++;
        await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'commerce').onDataChanges(['card-types']));
        await region.locator('[data-total="5"]').waitFor();

        if (width === 1440 && theme === 'light') {
          const opening = new Promise(resolve => { holdRead = resolve; });
          const response = page.waitForResponse(response => response.url().endsWith('/api/local/card-types'));
          await add();
          await opening;
          await page.getByRole('tab', { name: '套餐售价', exact: true }).click();
          holdRead = null;
          releaseRead();
          await response;
          await settle(page);
          assert.equal(await drawer.count(), 0, '离开页签后迟到读取不能弹出编辑抽屉');
          await page.getByRole('tab', { name: '银行卡类型', exact: true }).click();
          await add();
          assert.equal(await drawer.locator('#commerce-card-type-version').inputValue(), '4', '重开草稿保留原始版本');
          await drawer.getByRole('button', { name: '读取最新', exact: true }).click();
          await page.waitForFunction(version => document.querySelector('#commerce-card-type-version')?.value === String(version), data.version);
          await input().fill('');
          await save();
          await drawer.getByText('请输入 1 至 40 字的银行卡类型名称，名称不能含斜杠', { exact: true }).waitFor();
          assert.equal(writes.length, 0);
          await input().fill('WISE潘');
          await save();
          await drawer.getByText('银行卡类型名称已存在', { exact: true }).waitFor();
          assert.equal(await input().inputValue(), 'WISE潘');
          await input().fill('测试新增');
          data.version++;
          await save();
          await drawer.getByText('银行卡类型已更新，请读取最新后重试', { exact: true }).waitFor();
          await drawer.getByRole('button', { name: '读取最新', exact: true }).click();
          await page.waitForFunction(version => document.querySelector('#commerce-card-type-version')?.value === String(version), data.version);
          assert.equal(await input().inputValue(), '测试新增');
          failWrite = true;
          await save();
          await drawer.getByText('保存失败，请重试，输入已保留', { exact: true }).waitFor();
          failWrite = false;
          const saving = new Promise(resolve => { holdWrite = resolve; });
          await save();
          await saving;
          assert.equal(await drawer.locator('button[form="commerce-card-type-form"]').isDisabled(), true);
          await input().fill('后续编辑保留');
          holdWrite = null;
          releaseWrite();
          await page.waitForFunction(() => document.querySelector('#commerce-card-type-form')?.getAttribute('aria-busy') !== 'true');
          assert.equal(await input().inputValue(), '后续编辑保留', '迟到响应保留后续编辑');
          await close();
          await table.getByText('测试新增', { exact: true }).waitFor();
          const added = data.items.find(row => row.name === '测试新增');
          await page.locator(`[data-action="commerce-card-type-edit"][data-id="${added.id}"]`).click();
          await input().fill('改名后的类型');
          await save();
          await drawer.waitFor({ state: 'hidden' });
          await table.getByText('改名后的类型', { exact: true }).waitFor();
          for (const id of [added.id, 'type-0']) {
            await page.locator(`[data-action="commerce-card-type-remove"][data-id="${id}"]`).click();
            await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
            await page.waitForFunction(({ id, kept }) => {
              const row = document.querySelector(`table [data-row-id="${id}"]`);
              return kept ? row?.textContent.includes('已停用') : !row;
            }, { id, kept: id === 'type-0' });
          }
          evidence.push({ state: 'write-validation-conflict-retry-late-response-rename-remove', writes: writes.length });
          data.items = [];
          data.version++;
          await refresh();
          await page.getByText('暂无银行卡类型', { exact: true }).waitFor();
          await capture('empty');
          failRead = true;
          await page.reload();
          await page.getByRole('tab', { name: '银行卡类型', exact: true }).click();
          await page.getByText('银行卡类型读取失败，请重试。', { exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: '新增类型', exact: true }).isDisabled(), true);
          failRead = false;
          await refresh();
          await page.getByText('暂无银行卡类型', { exact: true }).waitFor();
          await capture('initial-error-retry');
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(mock.external, []);
        assert.deepEqual(mock.unavailable, []);
      } finally { await context.close(); }
    });
  }
  const employeeContext = await browser.newContext();
  try {
    const traffic = await interceptDesign(employeeContext, { localFixtures: {}, actor: { ...actor, role: 'employee' }, skipRechargeAssets: true });
    const page = await employeeContext.newPage();
    await page.goto(origin + '/#/settings/payment-countries');
    await page.getByText('当前账号无权打开此页面', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-card-type-settings]').count(), 0);
    assert.deepEqual(traffic.external, []);
    evidence.push({ state: 'employee-permission' });
  } finally { await employeeContext.close(); }
  await writeFile(output + '/results.json', JSON.stringify(evidence, null, 2));
});
