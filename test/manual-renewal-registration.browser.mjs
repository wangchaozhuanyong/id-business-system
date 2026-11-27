import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { editRenewalRecord, listRenewalPage, manualRenewalRecords } from '../server/manual-renewal-records.mjs';

const email = 'registered@example.test';
const existingEmail = 'legacy@example.test';
const longNote = Array.from({ length: 64 }, (_, i) =>
  '第 ' + (i + 1) + ' 行。原先的续费登记，需逐项复核后保留。').join('\n') + '\n最后一行：确认资料完整。';

async function interceptRenewals(context) {
  const history = [{ id: 'legacy-account', email: existingEmail, status: 'active', currentPlan: 'pro',
    renewalNotes: longNote, updatedAt: '2026-11-01T12:30:00Z' }];
  const registry = new Map();
  const records = () => manualRenewalRecords(history, [...registry.values()]);
  let failNextWrite = false;
  const writes = [];
  function save(body) {
    const entry = editRenewalRecord(records(), [...registry.values()], body, new Date().toISOString());
    if (!entry.unchanged) registry.set(entry.id, entry);
    return records().find(row => row.id === entry.id);
  }
  await context.route('**/api/local/native-browser-workbench*', async route => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    const action = params.get('action');
    if (action === 'renewals' && request.method() === 'GET')
      return route.fulfill({ json: { version: writes.length, ...listRenewalPage(records(), params) } });
    if (action !== 'renewal-record' || request.method() !== 'POST') return route.fallback();
    const command = request.postDataJSON();
    writes.push(command);
    if (failNextWrite) {
      failNextWrite = false;
      return route.fulfill({ status: 503, json: { error: '合成保存失败' } });
    }
    try { return route.fulfill({ json: { version: writes.length, record: save(command) } }); }
    catch (error) { return route.fulfill({ status: error.status, json: { error: error.message } }); }
  });
  return { writes, records, save, failNext() { failNextWrite = true; } };
}

async function expectStats(pane, counts, plans) {
  const labels = ['全部', '待续费', '已开通', '已过期'];
  for (const [index, count] of counts.entries())
    await pane.locator('.bit-renewal-counts span').filter({ hasText: labels[index] + ' ' + count }).waitFor();
  const actual = await pane.locator('.bit-renewal-counts span').allTextContents();
  assert.deepEqual(actual.map(text => text.trim()), counts.map((count, index) => labels[index] + ' ' + count));
  const planText = (await pane.locator('.bit-renewal-plans').textContent()).toLowerCase();
  for (const [plan, count] of Object.entries(plans))
    assert.match(planText, new RegExp(plan + '\\s*·\\s*' + count + '(?!\\d)'));
}

async function checkLongNote(textarea) {
  assert.equal(await textarea.inputValue(), longNote);
  await textarea.scrollIntoViewIfNeeded();
  const geometry = await textarea.evaluate(node => {
    const b = node.getBoundingClientRect();
    const max = node.scrollHeight - node.clientHeight;
    node.scrollTop = max;
    const last = node.scrollTop;
    node.scrollTop = 0;
    const drawer = node.closest('dialog').getBoundingClientRect();
    const visible = [[b.left + 4, b.top + 4], [b.right - 4, b.top + 4],
      [b.left + 4, b.bottom - 4], [b.right - 4, b.bottom - 4], [b.x + b.width / 2, b.y + b.height / 2]]
      .every(([x, y]) => document.elementFromPoint(x, y) === node);
    return { inside: b.left >= drawer.left && b.right <= Math.min(drawer.right, innerWidth) &&
      b.top >= Math.max(drawer.top, 0) && b.bottom <= Math.min(drawer.bottom, innerHeight),
      visible, max, last, first: node.scrollTop };
  });
  assert(geometry.inside && geometry.visible, '长备注可见且未被抽屉其他元素遮挡');
  assert.equal(geometry.first, 0);
  assert(Math.abs(geometry.max - geometry.last) <= 1, '长备注可滚动查看最后一行');
}

test('人工新增、编辑及失败重试保留登记内容和全量统计', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [role, width] of [['admin', 1440], ['admin', 390], ['finance', 1440], ['finance', 390]]) await t.test(role + ' ' + width + 'px', async t => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 980 },
      hasTouch: width === 390, locale: 'zh-CN' });
    t.after(() => context.close());
    const traffic = await interceptDesign(context, { actor: { id: 'qa', role, name: '离线操作员' },
      localFixtures: {}, skipRechargeAssets: true });
    const data = await interceptRenewals(context);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/recharge/start');
    const panel = page.locator('#bit-renewals-content');
    await page.getByRole('tab', { name: '续费登记', exact: true }).click();
    const entry = page.locator('#bit-renewal-entry');
    const drawer = page.getByRole('dialog', { name: '续费记录' });
    const row = value => panel.locator('tbody tr').filter({ hasText: value });
    const open = value => row(value).getByRole('button', { name: '查看记录' }).click();
    const submit = drawer.getByRole('button', { name: '保存登记' });
    const notes = drawer.getByLabel('续费备注');
    await row(existingEmail).waitFor();
    if (role === 'finance') {
      assert.equal(await page.locator('#sidebar a[href="#/recharge/start"]').innerText(), '手动充值');
      assert.equal(await page.locator('#bit-single-content, #bit-single-tab, [data-recharge-module="bit"]').count(), 0);
      await page.getByRole('tab', { name: '地址管理', exact: true }).click();
      await page.getByRole('button', { name: '生成地址' }).waitFor();
      await page.getByRole('tab', { name: '账号续费管理', exact: true }).click();
      await row(existingEmail).waitFor();
    }
    await expectStats(panel, [1, 0, 1, 0], { pro: 1 });

    await entry.getByLabel('账号邮箱').fill(email);
    await entry.getByLabel('当前套餐').fill('plus');
    await entry.getByLabel('续费备注').fill('第一次登记');
    const create = entry.getByRole('button', { name: '保存账号' });
    data.failNext();
    await create.click();
    await entry.getByText('合成保存失败').waitFor();
    assert.equal(await entry.getByLabel('账号邮箱').inputValue(), email);
    assert.equal(await entry.getByLabel('当前套餐').inputValue(), 'plus');
    assert.equal(await entry.getByLabel('续费备注').inputValue(), '第一次登记');
    assert.equal(data.records().length, 1);
    await expectStats(panel, [1, 0, 1, 0], { pro: 1 });
    await create.click();
    await row(email).getByText('待续费').waitFor();
    assert.equal(await entry.getByLabel('账号邮箱').inputValue(), '');
    await expectStats(panel, [2, 1, 1, 0], { plus: 1, pro: 1 });

    await open(email);
    assert.equal(await drawer.getByRole('link', { name: '打开服务器工作区' }).count(), 0);
    await drawer.getByRole('button', { name: '关闭抽屉' }).click();
    await page.evaluate(() => document.body.setAttribute('data-manual-remote-workspaces', ''));
    await open(email);
    const workspace = drawer.getByRole('link', { name: '打开服务器工作区' });
    assert.equal(await workspace.getAttribute('href'), '/manual-workspaces/' + data.records().find(record => record.email === email).id + '/');
    assert.equal(await workspace.getAttribute('target'), '_blank');
    assert((await workspace.getAttribute('rel')).split(' ').includes('noopener'));
    await drawer.getByLabel('续费状态').selectOption('expired');
    await drawer.getByLabel('当前套餐').fill('pro');
    await notes.fill('已复核到期');
    await submit.click();
    await drawer.waitFor({ state: 'hidden' });
    await row(email).getByText('已过期').waitFor();
    await expectStats(panel, [2, 0, 1, 1], { pro: 2 });
    assert(!/plus/i.test(await panel.locator('.bit-renewal-plans').textContent()));

    await open(existingEmail);
    await checkLongNote(notes);
    const previous = data.records().find(record => record.email === existingEmail);
    data.save({ id: previous.id, expectedRevision: previous.revision, status: 'pending_renewal',
      currentPlan: '', renewalNotes: longNote });
    await drawer.getByLabel('续费状态').selectOption('expired');
    await drawer.getByLabel('当前套餐').fill('prolite');
    await notes.fill('操作员尚未提交的备注');
    await submit.click();
    await drawer.getByText('记录已修改，请刷新后核对').waitFor();
    assert.equal(await notes.inputValue(), '操作员尚未提交的备注');
    assert.equal(await drawer.getByLabel('续费状态').inputValue(), 'expired');
    assert.equal(await drawer.getByLabel('当前套餐').inputValue(), 'prolite');
    assert.equal(data.records().find(record => record.email === existingEmail).renewalNotes, longNote);
    await drawer.getByRole('button', { name: '关闭抽屉' }).click();
    await panel.getByRole('button', { name: '刷新' }).click();
    await row(existingEmail).getByText('待续费').waitFor();
    await expectStats(panel, [2, 1, 0, 1], { '未登记': 1, pro: 1 });

    await panel.getByLabel('续费状态').selectOption('expired');
    await row(existingEmail).waitFor({ state: 'hidden' });
    await expectStats(panel, [2, 1, 0, 1], { '未登记': 1, pro: 1 });
    assert.equal(data.writes.length, 4, '失败或冲突不会额外重发写入');
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
    assert.deepEqual(traffic.unavailable, []);
  });
  await t.test('普通员工从菜单或直达地址均无法进入手动充值', async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    await interceptDesign(context, { actor: { id: 'employee-qa', role: 'employee', name: '普通员工' }, localFixtures: {}, skipRechargeAssets: true });
    const page = await context.newPage();
    const requests = [];
    page.on('request', request => {
      const { pathname } = new URL(request.url());
      if (/bitbrowser-addresses$|native-browser-workbench$|\/manual-workspaces\//.test(pathname)) requests.push(pathname);
    });
    await page.goto(origin + '/#/recharge/start');
    await page.getByText('当前账号无权打开此页面', { exact: true }).waitFor();
    assert.equal(await page.locator('#sidebar a[href="#/recharge/start"], #bit-renewal-entry, #bit-addresses-panel').count(), 0);
    assert.deepEqual(requests, []);
  });
});
