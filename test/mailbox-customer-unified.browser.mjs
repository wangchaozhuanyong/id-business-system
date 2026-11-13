import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { customerQuery } from '../server/customer-query.mjs';
import { inventoryMailboxPool, mailboxPoolMetadata, planMailboxRotations } from '../server/tools/mailbox-pool.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const fixture = async () => JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
const actor = { id: 'unified-qa', role: 'admin', name: '离线管理员' };
const evidence = new URL('../.runtime/mailbox-customer-unified-20261113/screens/', import.meta.url);
const day = 86_400_000;
const time = days => new Date(Date.now() + days * day).toISOString();
const response = (route, value) => route.fulfill({ json: value });
const confirm = page => page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认重置', exact: true }).click();
const action = (page, name) => page.locator(`[data-action="${name}"]`).filter({ visible: true });
const close = page => action(page, 'drawer-close').first().click();

async function installClipboard(context) {
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text) {
    if (window.rejectFixtureClipboard) throw new Error('合成拒绝');
    window.fixtureCopiedText = text;
  } } }));
}

test('客户查询显示历史 Apple ID 和当前死卡，Claude 只复制账号租户，预填草稿与普通录单隔离', { timeout: 50_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixtures = await fixture();
  const [a, b] = fixtures.commerce.data.customers;
  Object.assign(a, { name: '合成同名客户', wechat: 'lookup-a', active: true });
  Object.assign(b, { name: '合成同名客户', wechat: 'lookup-b', active: true });
  const [tenant] = fixtures.commerce.data.tenants;
  Object.assign(tenant, { name: '合成租户', phone: 'PRIVATE-TENANT-PHONE', active: true });
  const apple = { id: 'fixture-dead-apple', type: 'apple', email: 'original-apple@example.test', status: '正常', health: 'dead' };
  fixtures.inventory.data.mailboxes.push(apple);
  const old = { id: 'lookup-old', customerId: a.id, product: 'GPT', plan: 'Plus', version: 1,
    email: 'lookup-gpt@example.test', payment: '苹果内购', appleIdId: apple.id, orderNo: 'FIXTURE-OLD',
    start: time(-31), expiry: time(-1), paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
    paidAmount: '9900', saleAmount: '9900', businessType: '续费', source: '管理员手工' };
  const current = { ...old, id: 'lookup-current', orderNo: 'FIXTURE-CURRENT', payment: '银行卡', appleIdId: '',
    cardId: 'recharge:33', paymentId: '0042', start: time(-1), expiry: time(29) };
  const claude = { ...current, id: 'lookup-claude', orderNo: 'FIXTURE-CLAUDE', email: 'lookup-claude@example.test',
    product: 'Claude Pro', plan: 'Pro', tenantId: tenant.id, cardId: 'tenant:33', verifierPhone: 'PRIVATE-TENANT-PHONE',
    proCardSerial: 'PRIVATE-CARD-SERIAL' };
  fixtures.commerce.data.orders = [current, old, claude, { ...current, id: 'lookup-other', customerId: b.id, email: 'lookup-other@example.test' }];
  const cards = { health: { 'recharge:33': { state: 'dead' }, 'tenant:33': { state: 'unlocking' } } };
  for (const [width, dark] of [[1440, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await installClipboard(context);
    await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
    await context.route(origin + '/api/local/customer-query/**', route => {
      const command = route.request().postDataJSON(), action = route.request().url().split('/').at(-1);
      try { return response(route, customerQuery(fixtures, cards, action, command)); }
      catch (error) { throw new Error(`${action} ${JSON.stringify(command)}: ${error.message}`); }
    });
    const page = await context.newPage(), errors = [], writes = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/commerce')) writes.push(request); });
    await page.goto(origin + '/#/workspace/order/gpt');
    if (dark) await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.locator('#commerce-email').fill('ordinary-draft@example.test');
    await page.evaluate(() => window.IDDesignAPI.go('workspace/customer-query'));
    const orderNav = page.getByRole('navigation', { name: '订单提交业务切换' });
    assert.equal(await orderNav.getByRole('link').nth(5).textContent(), '客户查询');
    await page.getByRole('searchbox', { name: '客户姓名或微信' }).fill('合成同名客户');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await page.getByText('lookup-a', { exact: true }).waitFor();
    const first = page.locator(`[data-customer-query-candidate="${a.id}"]`);
    await first.getByRole('button', { name: '查看客户', exact: true }).click();
    const summary = page.locator('.customer-query-warnings');
    await summary.getByText('死卡', { exact: true }).waitFor();
    assert.match(await summary.innerText(), /原绑定 Apple ID.*original-apple@example\.test/s);
    assert.match(await summary.innerText(), /此订阅账号不可继续绑定其他 Apple ID/);
    assert.doesNotMatch(await page.locator('#main').innerText(), /PRIVATE-TENANT|PRIVATE-CARD|lookup-other@example\.test/);
    if (process.env.ID_UNIFIED_SCREENSHOTS === '1') {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL(`customer-${width}.png`, evidence)) });
    }
    await action(page, 'customer-query-copy').click();
    await page.waitForFunction(() => window.fixtureCopiedText === 'lookup-claude@example.test----合成租户');
    await page.getByRole('button', { name: '展开订单历史', exact: true }).click();
    const oldRow = page.locator('[data-customer-query-row="lookup-old"]');
    await oldRow.getByRole('button', { name: '采用此单提交订单' }).click();
    await page.locator('#commerce-email').waitFor();
    assert.equal(await page.locator('#commerce-email').inputValue(), current.email);
    assert.equal(await page.locator('#commerce-payment').inputValue(), '银行卡');
    assert.equal(await page.locator('#commerce-cardId').inputValue(), '');
    assert.equal(await page.locator('#commerce-paidAmount').inputValue(), '');
    await page.evaluate(() => window.IDDesignAPI.go('workspace/customer-query'));
    await page.getByRole('button', { name: '仅采用客户资料', exact: true }).click();
    await page.locator('#customer-query-product').selectOption('Gemini');
    await page.getByRole('button', { name: '进入订单提交' }).click();
    await page.locator('#commerce-order-form').waitFor();
    assert.equal(await page.locator('#commerce-customerId').inputValue(), a.id);
    assert.equal(await page.locator('#commerce-email').inputValue(), '');
    await page.evaluate(() => window.IDDesignAPI.go('workspace/order/gpt'));
    assert.equal(await page.locator('#commerce-email').inputValue(), 'ordinary-draft@example.test');
    assert.equal(writes.length, 0);
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  }
});

test('隐藏邮箱两行、复制失败重试和邮箱池跨页批量操作', { timeout: 50_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixtures = await fixture();
  const google = fixtures.inventory.data.mailboxes.find(row => row.type === 'google');
  const relay = fixtures.inventory.data.mailboxes.find(row => row.type === 'relay');
  const parent = fixtures.inventory.data.appleRelay.parents[0];
  Object.assign(google, { health: 'normal', status: '正常', inventoryState: 'available', used: false, email: 'copy-google@example.test' });
  Object.assign(relay, { health: 'normal', status: '正常', email: 'copy-alias@example.test', relayStatus: 'ACTIVE' });
  const pending = { id: 'offline-ms', email: 'pending-ms@example.test', type: 'microsoft', status: '正常' };
  fixtures.inventory.data.mailboxes = [google, relay, pending];
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await interceptDesign(context, { localFixtures: fixtures, actor, skipRechargeAssets: true });
  await installClipboard(context);
  let pool = { version: 2, data: { defaultValidDays: 19, items: [{ id: 'pool-google', provider: 'google', email: google.email,
    active: true, expiresAt: time(4), appPassword: 'fixture-only', queryCode: 'MBX-' + 'b'.repeat(32) }] } };
  const snapshot = () => inventoryMailboxPool(mailboxPoolMetadata(pool), fixtures.inventory);
  const ordinary = [], relayWrites = [];
  await context.route(origin + '/api/local/tools/mailbox-pool', route => {
    const request = route.request();
    if (request.method() === 'GET') return response(route, snapshot());
    const body = request.postDataJSON();
    if (request.method() === 'POST') return response(route, { version: body.version,
      items: (body.ids || []).map(id => ({ id, code: pool.data.items.find(row => row.id === id)?.queryCode })) });
    ordinary.push(body);
    const plan = planMailboxRotations(pool, fixtures.inventory, body);
    pool = { version: pool.version + 1, data: { ...pool.data, items: plan.items } };
    return response(route, { ...snapshot(), results: plan.results, issuedCode: plan.issued?.queryCode });
  });
  let suffixes = { version: 1, relayQuery: '隐藏后缀\n第二行', googleCredentials: '账密后缀', managedQuery: '查询说明' };
  let delayCredentialCopy = false;
  const credentialRead = Promise.withResolvers(), releaseCredential = Promise.withResolvers();
  await context.route(origin + '/api/local/tools/mailbox-delivery', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      if (delayCredentialCopy) {
        credentialRead.resolve();
        await releaseCredential.promise;
      }
      return response(route, { text: `${google.email}----演示密码----\n${suffixes.googleCredentials}`, missing: ['2FA 密钥'] });
    }
    if (request.method() === 'PUT') suffixes = { ...request.postDataJSON(), version: suffixes.version + 1 };
    return response(route, suffixes);
  });
  let relayCode = 'BUY-FAKE-0001', relayExpiry = time(5);
  await context.route(origin + '/api/local/apple-relay/**', route => {
    const path = route.request().url().split('/').at(-1);
    if (path === 'status') return response(route, { configured: true, parentIds: [parent.id], aliasIds: [relay.id] });
    if (path === 'code-read') {
      const input = route.request().postDataJSON();
      const row = { id: relay.id, email: relay.email, queryCode: relayCode, codeExpiresAt: relayExpiry };
      return response(route, input.ids ? { items: [row] } : row);
    }
    if (path === 'code-delivery-reset') {
      relayWrites.push(route.request().postDataJSON());
      relayCode = 'BUY-FAKE-0002'; relayExpiry = time(30);
      return response(route, { issued: { email: relay.email, queryCode: relayCode, codeExpiresAt: relayExpiry },
        results: [{ id: relay.id, email: relay.email, status: 'success', expiresAt: relayExpiry }] });
    }
    return route.fallback();
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/relay');
  await action(page, 'relay-delivery-copy').waitFor();
  const alignment = () => page.locator('.relay-alias-toolbar').evaluate(toolbar => [...toolbar.querySelectorAll('.relay-alias-row')].map(row => {
    const items = [...row.querySelectorAll('button, input, select, .footnote')].filter(node => node.checkVisibility());
    const positions = items.map(node => node.getBoundingClientRect()).map(({ top, height }) => top + height / 2);
    return { spread: Math.max(...positions) - Math.min(...positions), center: positions[0] };
  }));
  const rows = await alignment();
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.spread <= 2) && rows[1].center - rows[0].center > 30, JSON.stringify(rows));
  if (process.env.ID_UNIFIED_SCREENSHOTS === '1') {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL('relay-1440.png', evidence)) });
  }
  await action(page, 'mailbox-delivery-settings').click();
  await page.locator('#mailbox-delivery-relayQuery').fill('新隐藏后缀\n第二行');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await page.evaluate(() => { window.rejectFixtureClipboard = true; });
  await action(page, 'relay-delivery-copy').click();
  await page.getByRole('heading', { name: '查询码已更新，复制失败', exact: true }).waitFor();
  assert.equal(relayWrites.length, 1);
  assert.deepEqual(relayWrites[0].ids, [relay.id]);
  await page.evaluate(() => { window.rejectFixtureClipboard = false; });
  await page.getByRole('button', { name: '重试复制', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureCopiedText), `${relay.email}----BUY-FAKE-0002\n新隐藏后缀\n第二行`);
  assert.equal(relayWrites.length, 1);
  await page.setViewportSize({ width: 390, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.IDDesignAPI.go('mailboxes/google'));
  await action(page, 'inventory-google-credentials').click();
  await page.waitForFunction(() => window.fixtureCopiedText?.endsWith('\n账密后缀'));
  assert.equal(ordinary.length, 0, '复制账密没有重置查询码');
  await action(page, 'inventory-google-query-copy').click();
  await page.waitForFunction(() => window.fixtureCopiedText?.endsWith('\n查询说明'));
  assert.equal(ordinary[0].scope, 'google');
  await page.evaluate(() => window.IDDesignAPI.go('plugins/mailboxes'));
  const poolPanel = page.locator('#ops-mailbox-pool');
  const microsoft = poolPanel.locator('tr').filter({ hasText: pending.email });
  await microsoft.getByRole('button', { name: '绑定邮箱', exact: true }).click();
  await page.locator('#drawer[open] .mailbox-provider-links a').waitFor();
  assert.equal(await page.locator('#drawer[open] .mailbox-provider-links a').getAttribute('href'), 'https://outlook.live.com/mail/');
  await close(page);
  await poolPanel.getByRole('searchbox', { name: '搜索邮箱池' }).fill('copy-google');
  await microsoft.waitFor({ state: 'detached' });
  await action(page, 'ops-mailbox-pool-reset-batch').click();
  await page.getByRole('menuitem', { name: '重置全部（2）', exact: true }).click();
  await confirm(page);
  await page.locator('#drawer[open]').getByText(/已重置 1 条.*已跳过 1 条/).waitFor();
  assert.equal(ordinary.at(-1).mode, 'all');
  assert.equal(ordinary.at(-1).ids, undefined);
  await close(page);
  await poolPanel.getByRole('checkbox', { name: `选择 ${google.email}`, exact: true }).check();
  await action(page, 'ops-mailbox-pool-reset-batch').click();
  await page.getByRole('menuitem', { name: '重置已选（1）', exact: true }).click();
  await confirm(page);
  await page.locator('#drawer[open]').getByText(/已重置 1 条.*已跳过 0 条/).waitFor();
  assert.equal(ordinary.at(-1).mode, 'selected');
  assert.deepEqual(ordinary.at(-1).ids, ['pool-google']);
  await close(page);
  await page.evaluate(() => window.IDDesignAPI.go('mailboxes/google'));
  delayCredentialCopy = true;
  const before = await page.evaluate(() => window.fixtureCopiedText);
  await action(page, 'inventory-google-credentials').click();
  const late = page.waitForResponse(res => res.url().endsWith('/api/local/tools/mailbox-delivery') && res.request().method() === 'POST');
  try {
    await credentialRead.promise;
    await page.evaluate(() => window.IDDesignAPI.clearPageRegions());
  } finally { releaseCredential.resolve(); }
  await (await late).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.fixtureCopiedText), before, '会话清理后迟到的账密不得写入剪贴板');
  assert.equal(await page.locator('#mailbox-delivery-copy-text').count(), 0);
  assert.deepEqual(errors, []);
});
