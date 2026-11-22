import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const fixture = JSON.parse(await readFile(
  new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));

async function setup(t, options) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const traffic = await interceptDesign(context, { ...options, localAuthUi: true, skipRechargeAssets: true });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, traffic, errors };
}

const storedOperations = page => page.evaluate(() => Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith('id-business:write-receipt:')).map(([, value]) => value));

test('邮箱提取提交后丢回执，刷新只读取原批次并允许再次独立提取', async t => {
  const stock = structuredClone(fixture.inventory.data);
  stock.mailboxes = ['one', 'two'].map(id => ({ id: 'receipt-' + id, type: 'google',
    email: id + '@example.test', status: '正常', health: 'normal', inventoryState: 'available',
    used: false, usageLinks: [], version: 1 }));
  stock.batches = [];
  let current = { version: 1, data: stock }, acknowledge = false;
  const actor = { id: 'receipt-inventory', name: '合成操作员', role: 'admin' };
  const { context, page, traffic, errors } = await setup(t, { actor, localFixtures: { ...fixture, inventory: current } });
  const operations = new Map(), writes = [], readbacks = [];
  await context.route(origin + '/api/local/inventory', route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: current });
    const operationId = request.headers()['x-id-operation'];
    const body = request.postDataJSON();
    writes.push(operationId);
    if (!operations.has(operationId)) {
      assert.equal(body.action, 'inventory_extract');
      assert.equal(body.version, current.version);
      current = { version: current.version + 1, data: body.data };
      operations.set(operationId, current.data.batches[0].id);
    }
    return acknowledge ? route.fulfill({ json: current }) :
      route.fulfill({ status: 503, json: { error: '合成写入已提交但回执丢失' } });
  });
  await context.route(origin + '/api/local/inventory/extraction-receipt', route => {
    const id = route.request().headers()['x-id-operation'];
    assert.equal(route.request().method(), 'GET');
    assert.equal(route.request().postData(), null);
    readbacks.push(id);
    return route.fulfill({ json: { status: 'saved', batchId: operations.get(id) } });
  });
  const workspace = origin + '/#/workspace/mail-extract';
  const form = page.locator('#inventory-extract-form');
  const submit = form.getByRole('button', { name: '确认提取', exact: true });
  async function extract() {
    await form.locator('#inventory-extract-type').selectOption('google');
    await form.locator('#inventory-purpose').selectOption('注册 GPT');
    await form.locator('#inventory-quantity').fill('1');
    await form.locator('#inventory-extract-notes').fill('只留在本次表单的备注');
    await submit.click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  }
  await page.goto(workspace);
  await extract();
  await form.getByText('上次提取结果待核对。', { exact: false }).waitFor();
  assert.equal(operations.size, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[1], writes[0]);
  assert.deepEqual(await storedOperations(page), [writes[0]]);
  await page.reload();
  await submit.click();
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  assert.equal(writes.length, 2);
  await form.getByRole('button', { name: '核对上次提取' }).click();
  await page.waitForURL('**/#/workspace/extractions/' + operations.get(writes[0]));
  assert.deepEqual(readbacks, [writes[0]]);
  assert.deepEqual(await storedOperations(page), []);
  assert.equal(operations.size, 1);
  acknowledge = true;
  await page.goto(workspace);
  await extract();
  await page.waitForURL('**/#/workspace/extractions/*');
  assert.equal(operations.size, 2);
  assert.equal(current.data.batches.length, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('查询码重置丢回执并切页，整页刷新后核对原操作且不重复轮换', async t => {
  const actor = { id: 'receipt-mailer', name: '合成管理员', role: 'admin' };
  const { context, page, traffic, errors } = await setup(t, { actor, localFixtures: {} });
  const item = { id: 'receipt-row', email: 'rotate@example.test', label: '合成资料',
    provider: 'google', active: true, authorizationPending: false, expiresAt: '2099-01-01T00:00:00Z' };
  let current = { version: 1, inventoryVersion: 0, defaultValidDays: 7, items: [item] };
  const path = origin + '/api/local/tools/mailbox-pool';
  const writes = [], readbacks = [], receipts = new Map(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  await context.route(path, async route => {
    const request = route.request(), method = request.method();
    if (method === 'GET') return route.fulfill({ json: current });
    if (method === 'POST') return route.fulfill({ json: { version: current.version, items: [] } });
    const id = request.headers()['x-id-operation'], body = request.postDataJSON();
    assert.equal(body.action, 'rotate-delivery');
    writes.push(id);
    if (!receipts.has(id)) {
      assert.equal(body.version, current.version);
      current = { ...current, version: current.version + 1 };
      receipts.set(id, [{ id: item.id, email: item.email, status: 'success' }]);
    }
    await release.promise;
    return route.fulfill({ status: 503, json: { error: '合成重置已提交但回执丢失' } });
  });
  await context.route(path + '/delivery-receipt', route => {
    const id = route.request().headers()['x-id-operation'];
    assert.equal(route.request().method(), 'GET');
    assert.equal(route.request().postData(), null);
    readbacks.push(id);
    return route.fulfill({ json: { ...current, status: 'saved', results: receipts.get(id) } });
  });
  const pool = origin + '/#/plugins/mailboxes';
  const row = page.locator('#ops-mailbox-pool .mailbox-account').filter({ hasText: item.email });
  const reset = async () => {
    await row.locator('.mailbox-account__more').click();
    await page.getByRole('menuitem', { name: '重置查询码', exact: true }).click();
  };
  await page.goto(pool);
  const sent = page.waitForRequest(request => request.method() === 'PUT' && request.url() === path);
  await reset();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认重置', exact: true }).click();
  await sent;
  const received = page.waitForResponse(response => response.request().method() === 'PUT' &&
    response.url() === path && writes.length === 2);
  await page.goto(origin + '/#/customers/list');
  release.resolve();
  await (await received).finished();
  assert.equal(writes[1], writes[0]);
  assert.deepEqual(await storedOperations(page), [writes[0]]);
  await page.goto(pool);
  await page.reload();
  const pending = page.getByRole('button', { name: '核对上次重置', exact: true });
  await pending.waitFor();
  actor.id = 'different-mailer';
  await page.reload();
  await row.waitFor();
  assert.equal(await pending.count(), 0);
  actor.id = 'receipt-mailer';
  await page.reload();
  await pending.waitFor();
  await reset();
  await page.locator('#drawer[open]').getByText('已重置', { exact: true }).waitFor();
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  assert.deepEqual(readbacks, [writes[0]]);
  assert.deepEqual(writes, [writes[0], writes[0]]);
  assert.equal(receipts.size, 1);
  assert.deepEqual(await storedOperations(page), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('隐藏邮箱整页刷新只在用户核对后按原编号查询供应商结果', async t => {
  const actor = { id: 'receipt-relay-admin', name: '合成查询码管理员', role: 'admin' };
  const { context, page, traffic, errors } = await setup(t, { actor, localFixtures: fixture });
  const operation = 'synthetic-relay-browser';
  const base = origin + '/api/local/apple-relay/code-delivery-';
  const requests = [];
  const alias = { id: 'fixture-relay', email: 'alias@example.test', status: 'pending' };
  let ready = false;
  await context.route(base + 'receipt', route => {
    requests.push(['receipt', route.request().method(), route.request().headers()['x-id-operation']]);
    return route.fulfill({ json: { status: 'pending', results: [alias] } });
  });
  await context.route(base + 'reconcile', route => {
    requests.push(['reconcile', route.request().method(), route.request().headers()['x-id-operation']]);
    assert.deepEqual(route.request().postDataJSON(), {});
    return route.fulfill({ json: ready ? { status: 'saved', results: [{ ...alias, status: 'success' }] }
      : { status: 'pending', results: [alias] } });
  });
  await context.route(base + 'reset', route => {
    requests.push(['unexpected-reset', route.request().method()]);
    return route.fulfill({ json: { results: [] } });
  });
  await page.goto(origin + '/#/mailboxes/relay');
  assert.equal(await page.evaluate(id => window.IDLocalData.rememberWriteReceipt('mailbox-reset:relay', id), operation), true);
  await page.reload();
  await page.setViewportSize({ width: 1920, height: 960 });
  await page.getByRole('tab', { name: '隐藏邮箱管理', exact: true }).click();
  const lookup = page.getByRole('button', { name: '核对上次重置', exact: true });
  await lookup.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await lookup.waitFor({ state: 'hidden' });
  await page.locator('[data-action="relay-alias-tools"]').click();
  assert.deepEqual(requests, []);
  await page.getByRole('menuitem', { name: '核对上次重置', exact: true }).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.getByText('尚未读到完整回执，原重置可能仍在处理。').waitFor();
  assert.deepEqual(await storedOperations(page), [operation]);
  ready = true;
  await drawer.getByRole('button', { name: '核对本次结果', exact: true }).click();
  await drawer.getByText('已重置', { exact: true }).waitFor();
  assert.deepEqual(requests, [
    ['receipt', 'GET', operation], ['reconcile', 'POST', operation],
    ['receipt', 'GET', operation], ['reconcile', 'POST', operation]
  ]);
  assert.deepEqual(await storedOperations(page), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});
