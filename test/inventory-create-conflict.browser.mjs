import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

async function setup(t) {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixtures = JSON.parse(await readFile(
    new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)
  ));
  const requests = await interceptDesign(context, {
    localFixtures: fixtures, actor: { id: 'admin', name: '合成管理员', role: 'admin' }
  });
  let stored = structuredClone(fixtures.inventory);
  const attempts = [];
  await context.route(origin + '/api/local/inventory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: stored });
    const command = route.request().postDataJSON();
    attempts.push(command);
    if (command.version !== stored.version) return route.fulfill({ status: 409, json: {
      error: '库存资料已在其他页面更新，请刷新后重试'
    } });
    stored = { version: stored.version + 1, data: structuredClone(command.data) };
    return route.fulfill({ json: stored });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/google');
  await page.getByRole('button', { name: '新增邮箱', exact: true }).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.locator('#inventory-email').fill('concurrency@example.test');
  await drawer.locator('#inventory-password').fill('TEST-ONLY');
  return {
    page, drawer, attempts, requests, errors,
    get stored() { return structuredClone(stored); },
    external(change) { const data = structuredClone(stored.data); change(data); stored = { version: stored.version + 1, data }; },
    async confirm() {
      await page.locator('button[form="inventory-asset-form"][type="submit"]').click();
      await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    }
  };
}

test('stale Google create succeeds without overwriting another page in an offline UI', { timeout: 30000 }, async t => {
  const f = await setup(t);
  f.external(data => data.accounts.push({ id: 'external-synthetic', type: 'gpt', email: 'other@example.test' }));
  const saved = f.page.waitForResponse(response => response.url() === origin + '/api/local/inventory' &&
    response.request().method() === 'PUT' && response.status() === 200);
  await f.confirm();
  await saved;
  await f.drawer.waitFor({ state: 'hidden' });
  assert.equal(f.attempts.length, 2);
  assert.equal(f.stored.data.accounts.filter(row => row.id === 'external-synthetic').length, 1);
  assert.equal(f.stored.data.mailboxes.filter(row => row.email === 'concurrency@example.test').length, 1);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
  assert.deepEqual(f.requests.unavailable, []);
});

test('a concurrent duplicate leaves the draft open and does not overwrite the existing mailbox', { timeout: 30000 }, async t => {
  const f = await setup(t);
  f.external(data => data.mailboxes.unshift({ id: 'external-synthetic', type: 'google',
    email: 'CONCURRENCY@example.test', password: 'OTHER-TEST-ONLY', country: '马来西亚', version: 1 }));
  await f.confirm();
  await f.page.getByText('相同的谷歌邮箱已存在，输入已保留，请先核对已有资料', { exact: true }).waitFor();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.stored.data.mailboxes[0].id, 'external-synthetic');
  assert.equal(await f.drawer.locator('#inventory-email').inputValue(), 'concurrency@example.test');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.external, []);
  assert.deepEqual(f.requests.unavailable, []);
});
