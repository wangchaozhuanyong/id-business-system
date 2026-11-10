import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { accountLifecycleSummaries } from '../server/account-lifecycle.mjs';
import { claudeHistoryPreview, planClaudeHistoryIntake, stageClaudeHistoryIntake } from '../server/claude-history-intake.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'fixture-admin', name: '合成管理员', role: 'super' };
const at = new Date('2026-11-10T08:00:00Z');
const historyRows = [
  ['ready-history@example.test', '已开通', '', 'Max 20x', '2026-10-31 22:00', '2026-11-30 22:00', '马来西亚']
];

test('Claude 账号历史入口预检、冲突重试、保存和刷新回读', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const local = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  local.inventory.data.accounts = [];
  local.inventory.data.importRecords = [];
  local.commerce.data.orders = [];
  const requests = await interceptDesign(context, { localFixtures: local, actor, skipRechargeAssets: true });
  await context.route(origin + '/api/local/subscriptions/list', route => {
    const input = route.request().postDataJSON();
    const rows = projectSubscriptions({ inventory: local.inventory, commerce: local.commerce,
      mailboxes: { version: 0, data: { items: [] } }, subscriptions: { version: 0, data: {} } }, at.getTime())
      .filter(row => row.product === input.product).map(({ _account, _records, ...row }) => row);
    const counts = Object.fromEntries(['active', 'expired', 'pending', 'ended'].map(status =>
      [status, rows.filter(row => row.status === status).length]));
    return route.fulfill({ json: { items: rows, total: rows.length, counts, page: 1,
      pageSize: input.pageSize, revision: 'fixture-' + local.inventory.version, now: at.toISOString() } });
  });
  let confirmations = 0;
  await context.route(origin + '/api/local/claude-history-intake', route => {
    const { mode, ...input } = route.request().postDataJSON();
    const plan = planClaudeHistoryIntake(input, local.inventory, local.commerce, at.getTime());
    if (mode === 'preview') return route.fulfill({ json: claudeHistoryPreview(plan) });
    confirmations++;
    if (confirmations === 1) {
      local.inventory.version++;
      return route.fulfill({ status: 409, json: { error: '库存已变化' } });
    }
    const data = structuredClone(local.inventory.data);
    const result = stageClaudeHistoryIntake(plan, input.inventoryVersion, data, actor, at);
    local.inventory = { version: local.inventory.version + 1, data,
      accountSummaries: accountLifecycleSummaries(data, local.commerce.data) };
    return route.fulfill({ json: { ...result, inventory: local.inventory } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/subscriptions/claude');
  const open = page.getByRole('button', { name: '订阅历史入库', exact: true });
  await open.click();
  const content = page.locator('#inventory-claude-history-content');
  const header = (await content.inputValue()).trim();
  const input = header + '\n' + historyRows.map(row => row.join('\t')).join('\n');
  const preview = page.getByRole('button', { name: '预检资料', exact: true });
  const submit = page.getByRole('button', { name: '确认入库', exact: true });
  const confirm = () => page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await content.fill(input);
  await preview.click();
  await page.locator('#inventory-claude-history-review').getByText('已开通', { exact: true }).waitFor();
  await content.fill(input + '\n');
  assert.equal(await submit.isDisabled(), true);
  await content.fill(input);
  await preview.click();
  await submit.click();
  await confirm();
  await page.getByText('库存已变化，请重新预检', { exact: true }).waitFor();
  assert.equal(await content.inputValue(), input);
  assert.equal(local.inventory.data.accounts.length, 0);
  await preview.click();
  await submit.click();
  await confirm();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(local.inventory.data.accounts.length, 1);
  assert.equal(confirmations, 2);
  assert.equal(local.commerce.data.orders.length, 0);

  await page.locator('#subscription-list').getByText('ready-history@example.test', { exact: true }).first().waitFor();
  await page.locator('#subscription-list').getByText('2026-11-30 22:00', { exact: true }).waitFor();
  await page.goto(origin + '/#/accounts/claude');
  await page.getByText('ready-history@example.test', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#main').getByText('历史套餐', { exact: true }).count(), 0);
  const accountOpen = page.getByRole('button', { name: '历史账号入库', exact: true });
  await accountOpen.click();
  const accountHeader = (await content.inputValue()).trim();
  const accountInput = accountHeader + '\n' + [
    ['aging-history@example.test', '养号中', '2026-10-29'],
    ['dead-history@example.test', '死号', '']
  ].map(row => row.join('\t')).join('\n');
  await content.fill(accountInput);
  await preview.click();
  await page.locator('#inventory-claude-history-review').getByText('死号', { exact: true }).waitFor();
  assert.equal(await page.locator('#inventory-claude-history-review').getByText('到期时间', { exact: true }).count(), 0);
  await submit.click();
  await confirm();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(local.inventory.data.accounts.length, 3);
  await page.getByRole('tab', { name: /^死号/ }).click();
  await page.locator('#main').getByText('dead-history@example.test', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#main').getByText('ready-history@example.test', { exact: true }).count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await accountOpen.click();
  await content.fill(accountInput);
  await preview.click();
  await page.locator('#inventory-claude-history-review').getByText('已登记', { exact: true }).first().waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});
