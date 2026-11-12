import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const actor = { id: 'synthetic-admin', name: '合成管理员', role: 'admin' };
const fixturesPath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const entry = '/#/data-management/claude-google-subscriptions';
const revision = 'synthetic-revision';
const rows = ['active', 'expired', 'conflict'].map((code, index) => ({
  id: `synthetic-${index}`, product: 'Claude', account: `synthetic-${index}@example.test`,
  registrationEmail: `synthetic-${index}@example.test`, accountId: `asset-${index}`,
  ownerName: '合成归属人', operatorName: '合成录入人', status: index === 1 ? 'expired' : 'active', conflict: false,
  series: [{ key: 'claude', plan: 'Pro', start: '2026-11-01 10:00', expiry: index === 1 ? '2026-11-09T01:00:00Z' : '2026-12-01 10:00',
    status: index === 1 ? 'expired' : 'active', remainingDays: index === 1 ? 0 : 21 }],
  history: [], queryCode: { status: code, remainingDays: code === 'active' ? 3 : code === 'expired' ? 0 : null,
    expiresAt: code === 'active' ? '2026-11-13T02:00:00Z' : code === 'expired' ? '2026-11-10T01:00:00Z' : null }
}));
const result = command => {
  const items = rows.filter(row => (command.scope === 'expired' ? row.status === 'expired' : row.status !== 'expired') &&
    (!command.query || row.account.includes(command.query)) &&
    (!command.status || row.status === command.status));
  return { items, total: items.length, counts: { active: 2, expired: 1, pending: 0, ended: 0 },
    page: 1, pageSize: command.pageSize, revision, now: '2026-11-10T02:00:00Z' };
};

test('旧 Claude 入口保留个人后缀与两种复制，并阻止冲突和迟到复制', { timeout: 45_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  fixtures['auth/session'] = { configured: true, actor };
  const intercepted = await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  let settings = { version: 1, copy1: '原短后缀', copy2: '原完整后缀' }, holdCopy;
  const writes = [], copies = [], lists = [];
  await context.addInitScript(() => {
    window.syntheticCopies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => window.syntheticCopies.push(value) } });
  });
  await context.route('**/api/local/subscriptions/list', route => {
    const command = route.request().postDataJSON(); lists.push(command);
    return route.fulfill({ json: result(command) });
  });
  await context.route('**/api/local/claude-google-subscriptions/copy-settings', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: settings });
    const command = route.request().postDataJSON(); writes.push(command);
    assert.equal(command.version, settings.version);
    settings = { version: settings.version + 1, copy1: command.copy1, copy2: command.copy2 };
    return route.fulfill({ json: settings });
  });
  await context.route('**/api/local/subscriptions/copy', async route => {
    const command = route.request().postDataJSON(); copies.push(command);
    assert.equal(command.revision, revision);
    if (command.id === rows[2].id) return route.fulfill({ status: 409, json: { error: '账号或邮箱关联存在冲突，请先核对' } });
    const row = rows.find(item => item.id === command.id);
    const lines = [`邮箱账号：${row.registrationEmail}`];
    if (command.mode === 'full') lines.push('邮箱密码：SYNTHETIC-PASSWORD', '邮箱 2FA：SYNTHETIC-2FA');
    if (row.queryCode.status === 'active') lines.push('买家查询码：SYNTHETIC-QUERY');
    lines.push(command.mode === 'short' ? settings.copy1 : settings.copy2);
    const response = { text: lines.join('\n'), omitted: row.queryCode.status === 'active' ? [] : ['买家查询码'] };
    if (holdCopy) {
      holdCopy.started.resolve(); await holdCopy.release.promise;
      await route.fulfill({ json: response }).catch(() => {}); holdCopy.finished.resolve(); return;
    }
    return route.fulfill({ json: response });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.goto(origin + entry);
  await page.waitForURL('**/#/subscriptions/claude');
  const first = page.locator(`tr[data-row-id="${rows[0].id}"]`);
  await first.waitFor();
  await page.getByRole('heading', { name: 'Claude 订阅管理', exact: true }).waitFor();
  assert.equal(await page.locator('#subscription-list').getByText('查询码状态／剩余', { exact: true }).count(), 1);
  assert.match(await first.innerText(), /有效 · 3 天/);
  assert.doesNotMatch(await first.innerText(), /SYNTHETIC-PASSWORD|SYNTHETIC-2FA|SYNTHETIC-QUERY/);

  await page.getByRole('button', { name: '账号资料后缀' }).click();
  const form = page.locator('#subscription-settings-form');
  await form.locator('[type="submit"]:enabled').waitFor();
  assert.equal(await form.locator('#subscription-copy1').inputValue(), '原短后缀');
  assert.equal(await form.locator('#subscription-copy2').inputValue(), '原完整后缀');
  await form.locator('#subscription-copy1').fill('新短后缀');
  await form.locator('#subscription-copy2').fill('新完整后缀\n第二行');
  await form.locator('[type="submit"]').click();
  await form.waitFor({ state: 'hidden' });
  assert.deepEqual(writes, [{ version: 1, copy1: '新短后缀', copy2: '新完整后缀\n第二行' }]);

  await first.locator('[data-action="subscriptions-more"]').click();
  await page.getByRole('menuitem', { name: '复制邮箱和查询码' }).click();
  await page.waitForFunction(() => window.syntheticCopies.length === 1);
  const short = await page.evaluate(() => window.syntheticCopies[0]);
  assert.match(short, /SYNTHETIC-QUERY/); assert.match(short, /新短后缀/);
  assert.doesNotMatch(short, /SYNTHETIC-PASSWORD|SYNTHETIC-2FA/);
  assert.equal(copies.at(-1).mode, 'short');
  const copyAccount = async row => {
    await row.locator('[data-action="subscriptions-more"]').click();
    await page.getByRole('menuitem', { name: '复制账号资料', exact: true }).click();
  };
  await copyAccount(first);
  await page.waitForFunction(() => window.syntheticCopies.length === 2);
  const full = await page.evaluate(() => window.syntheticCopies[1]);
  assert.match(full, /SYNTHETIC-PASSWORD/); assert.match(full, /SYNTHETIC-2FA/);
  assert.match(full, /新完整后缀\n第二行/); assert.equal(copies.at(-1).mode, 'full');

  const expired = page.locator(`tr[data-row-id="${rows[1].id}"]`);
  await page.getByRole('tab', { name: '已到期', exact: true }).click();
  await expired.locator('[data-column="days"]').getByText('已到期 1 天 1 小时', { exact: true }).waitFor();
  await expired.locator('[data-column="code"]').getByText('已到期 1 小时', { exact: true }).waitFor();
  await copyAccount(expired);
  await page.waitForFunction(() => window.syntheticCopies.length === 3);
  assert.doesNotMatch(await page.evaluate(() => window.syntheticCopies[2]), /SYNTHETIC-QUERY/);
  await page.getByText(/未登记：买家查询码/).waitFor();
  await page.getByRole('tab', { name: '客户订阅', exact: true }).click();
  await copyAccount(page.locator(`tr[data-row-id="${rows[2].id}"]`));
  await page.getByText('账号或邮箱关联存在冲突，请先核对', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.syntheticCopies.length), 3);

  const before = lists.length;
  await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'subscription-management')
    .onDataChanges(['tools/mailbox-pool']));
  assert.equal(lists.length, before + 1);
  holdCopy = { started: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() };
  try {
    await copyAccount(first); await holdCopy.started.promise;
    await page.goto(origin + '/#/data-management/bank-cards');
    holdCopy.release.resolve(); await holdCopy.finished.promise; await settle(page);
    assert.equal(await page.evaluate(() => window.syntheticCopies.length), 3, '切页后的迟到响应不能写入剪贴板');
  } finally { holdCopy.release.resolve(); }
  assert.deepEqual(errors, []); assert.deepEqual(intercepted.external, []);
});

test('普通员工直达旧 Claude 地址时不读取订阅资料', { timeout: 30_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const employee = { id: 'synthetic-employee', name: '合成员工', role: 'employee' };
  const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
  fixtures['auth/session'] = { configured: true, actor: employee };
  await interceptDesign(context, { localFixtures: fixtures, actor: employee, skipRechargeAssets: true });
  let reads = 0;
  await context.route('**/api/local/subscriptions/**', route => {
    reads++; return route.fulfill({ status: 403, json: { error: '无权限' } });
  });
  const page = await context.newPage();
  await page.goto(origin + entry);
  await page.getByText('当前账号无权打开此页面', { exact: true }).waitFor();
  await settle(page);
  assert.equal(await page.locator('.nav-child[href="#/subscriptions/claude"]').count(), 0);
  assert.equal(await page.locator('[data-action="subscriptions-copy"]').count(), 0);
  assert.equal(reads, 0);
});
