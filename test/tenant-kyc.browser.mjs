import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { createOrderAuxiliaryHandler } from '../server/order-auxiliary.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'dead-kyc-qa-admin', name: '合成管理员', role: 'admin' };
const tenant = { id: 'dead-kyc-qa-verifier', name: '合成认证人', phone: '+60123456780', active: true, version: 1 };
const customer = { id: 'dead-kyc-qa-customer', name: '合成客户', active: true, version: 1 };
const output = fileURLToPath(new URL('../.runtime/dead-account-material-correction-20261112/browser/', import.meta.url));

async function request(store, method, path, data) {
  const req = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []), {
    method, url: path, headers: { origin, host: new URL(origin).host, 'content-type': 'application/json' }
  });
  let status, body;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
  if (path.startsWith('/api/local/tenant-cards')) {
    await createOrderAuxiliaryHandler({ store, publicOrigin: origin })(req, res, '/api/local/tenant-cards', actor);
  } else {
    await handleLocalBusiness(req, res, path, store, actor, { publicOrigin: origin, readOrderCards: async () => [] });
  }
  return { status, body };
}

test('死号资料抽屉经实际事务保存、重开读回和补偿撤回（全程离线合成资料）', { timeout: 120_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  await mkdir(output, { recursive: true });
  for (const [name, product, plan, viewport] of [
    ['max-desktop', 'Claude Max', 'Max 20x', { width: 1440, height: 1000 }],
    ['pro-mobile', 'Claude Pro', 'Pro', { width: 390, height: 844 }]
  ]) await t.test(name, async () => {
    const store = createLocalBusinessStore(':memory:');
    const context = await browser.newContext({ viewport, locale: 'zh-CN' });
    try {
      const original = { id: 'qa-dead-order', orderNo: 'QA-DEAD-001', product, plan,
        businessType: '成品交付', source: '管理员手工', entitlementStatus: 'active',
        customerId: customer.id, accountId: '', email: 'dead-correction@example.test', payment: '银行卡',
        proMaterialMode: 'none', paidAmount: '250', paidCurrency: 'USD', saleAmount: '2100', saleCurrency: 'CNY',
        paidConfirmed: true, receiptConfirmed: true, costConfirmed: false, costBasis: 'standard',
        start: '2026-10-23T20:31', expiry: '2026-11-12T20:31',
        kyc: '未认证', verifier: '', verifierPhone: '', phone: '', notes: '合成历史订单：账号已冻结',
        refunds: [], bankReturns: [], corrections: [], version: 1 };
      const created = await request(store, 'PUT', '/api/local/commerce', { version: 0, action: '新增独立订单',
        data: { orders: [original], customers: [customer], tenants: [tenant], operating: [], rentBatches: [], logs: [] } });
      assert.equal(created.status, 200, created.body?.error);
      store.saveBatch([{ domain: 'inventory', version: 0, action: 'inventory_create', data: {
        accounts: [{ id: 'qa-dead-stock', type: 'claude', email: original.email, health: 'dead', status: '冻结',
          inventoryState: 'used', used: true, version: 1, device: '合成设备', proxyUrl: 'socks5://proxy.example.test:1080' }],
        mailboxes: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
      } }]);
      const originalStock = store.load('inventory');
      const originalPayment = store.load('commerce').data.orders[0].financialEvidence.filter(row => row.kind === 'payment');
      const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url), 'utf8'));
      fixture.commerce = store.load('commerce');
      fixture.inventory = originalStock;
      const mock = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
      const writes = [];
      for (const path of ['commerce', 'inventory', 'batch', 'tenant-cards*']) {
        await context.route('**/api/local/' + path, async route => {
          const req = route.request(), url = new URL(req.url());
          const result = await request(store, req.method(), url.pathname + url.search, req.postDataJSON());
          if (req.method() !== 'GET') writes.push({ action: req.postDataJSON()?.action, ...result });
          await route.fulfill({ status: result.status, json: result.body });
        });
      }
      for (const path of ['order-owners', 'display-names'])
        await context.route('**/api/local/auth/' + path, route => route.fulfill({ json: { items: [actor] } }));
      const page = await context.newPage();
      page.setDefaultTimeout(7500);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-11-12T12:00:00Z'));
      await page.goto(origin + '/#/orders/claude');
      const row = page.locator('[data-table="commerce-orders-Claude"] tr[data-row-id="qa-dead-order"]');
      await row.waitFor();
      const drawer = page.locator('#drawer[open]');
      const edit = async () => {
        await row.locator('[data-action="commerce-order-edit"]').click();
        await drawer.locator('#commerce-order-form').waitFor();
      };
      const save = async () => {
        const response = page.waitForResponse(res => res.url().endsWith('/api/local/commerce') && res.request().method() === 'PUT');
        await drawer.locator('button[form="commerce-order-form"][type="submit"]').click();
        const saved = await response.catch(async error => {
          throw new Error([error.message, ...await drawer.locator('.field-error:visible').allTextContents(),
            ...await page.locator('#toast').allTextContents()].join('\n'));
        });
        assert.equal(saved.status(), 200, JSON.stringify(await saved.json()));
        await drawer.waitFor({ state: 'hidden' });
      };
      await edit();
      await drawer.locator('#commerce-claudeVerifierId-picker').click();
      await drawer.locator('#commerce-claudeVerifierId-popover [data-value="' + tenant.id + '"]').click();
      await drawer.locator('#commerce-kyc').selectOption('KYC 认证');
      await drawer.locator('#commerce-phone').fill('+60123456789');
      await drawer.locator('#commerce-correctionReason').fill('核对原始资料后补录历史认证');
      await save();
      let saved = store.load('commerce').data.orders[0];
      assert.equal(saved.kyc, 'KYC 认证');
      assert.equal(saved.claudeVerifierId, tenant.id);
      assert.equal(saved.phone, '+60123456789');
      assert.equal(saved.corrections[0].previous.kyc, '未认证');
      assert.deepEqual(saved.financialEvidence.filter(row => row.kind === 'payment'), originalPayment);
      for (const field of ['paidConfirmed', 'receiptConfirmed', 'paidAmount', 'paidCurrency', 'saleAmount', 'saleCurrency'])
        assert.equal(saved[field], original[field]);
      assert.deepEqual(store.load('inventory'), originalStock);
      await edit();
      assert.equal(await drawer.locator('#commerce-kyc').inputValue(), 'KYC 认证');
      assert.equal(await drawer.locator('#commerce-verifierPhone').inputValue(), tenant.phone);
      await drawer.locator('#commerce-kyc').scrollIntoViewIfNeeded();
      await page.screenshot({ path: output + name + '-saved.png' });
      await drawer.locator('#commerce-kyc').selectOption('未认证');
      await drawer.locator('#commerce-correctionReason').fill('修正误录的认证状态');
      await save();
      assert.equal(store.load('commerce').data.orders[0].kyc, '未认证');
      await row.locator('[data-action="commerce-order-more"]').click();
      await page.locator('.row-action-menu:popover-open [data-action="commerce-order-undo"]').click();
      await drawer.locator('#commerce-reversalReason').fill('撤回本次误操作');
      await drawer.locator('button[form="commerce-reversal-form"]').click();
      const confirmUndo = page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认操作', exact: true });
      await confirmUndo.waitFor();
      const undoResponse = page.waitForResponse(res => res.url().endsWith('/api/local/commerce') && res.request().method() === 'PUT');
      await confirmUndo.click();
      const undone = await undoResponse;
      assert.equal(undone.status(), 200, JSON.stringify(await undone.json()));
      await drawer.waitFor({ state: 'hidden' });
      saved = store.load('commerce').data.orders[0];
      assert.equal(saved.kyc, 'KYC 认证');
      assert.equal(saved.corrections.length, 2);
      assert.equal(saved.compensations.length, 1);
      assert.deepEqual(saved.financialEvidence.filter(row => row.kind === 'payment'), originalPayment);
      assert.deepEqual(store.load('inventory'), originalStock);
      assert.deepEqual(writes.map(write => write.status), [200, 200, 200]);
      assert.deepEqual(errors, []);
      assert.deepEqual(mock.external, []);
      assert.deepEqual(mock.unavailable, []);
    } finally { await context.close(); store.close(); }
  });
});
