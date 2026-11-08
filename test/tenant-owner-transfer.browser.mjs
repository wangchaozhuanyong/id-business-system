import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { planTenantOwnerTransfer, tenantOwnerTransferView } from '../server/tenant-owner-transfer.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('租户归属转交抽屉、失效人员与版本冲突、未知结果恢复及宽窄屏', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const actor = { id: 'admin', name: '交接管理员', role: 'admin' };
  const staff = { id: 'staff', name: '接手员工', role: 'employee' };
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.commerce = { version: 3, data: { customers: [], tenants: [
    { id: 'tenant', name: '合成租户甲', phone: '合成电话', owner: '历史负责人', version: 2, active: true,
      createdById: 'creator', createdBy: '原录入人' },
    { id: 'second', name: '合成租户乙', phone: '合成电话乙', ownerId: actor.id, owner: actor.name, version: 1, active: true }
  ], orders: [{ id: 'order', orderNo: 'OD-SYNTHETIC', product: 'Claude Pro', plan: 'Pro', businessType: '续费',
    tenantId: 'tenant', ownerId: 'sales', owner: '销售员工', email: 'synthetic@example.test',
    start: '2026-11-01T10:00', expiry: '2026-12-01T10:00', payment: '银行卡', paidAmount: '20', saleAmount: '30',
    paidCurrency: 'MYR', saleCurrency: 'CNY', version: 1 }], operating: [], rentBatches: [], logs: [] } };
  const originalOrders = structuredClone(fixture.commerce.data.orders);
  const traffic = await interceptDesign(context, { localFixtures: fixture, actor });
  let enabled = true, lostResponse = false, commits = 0, pending;
  const commands = [];
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor, ...(enabled ? [staff] : [])] } }));
  await context.route('**/api/local/tenant-owner-transfer*', async route => {
    try {
      if (route.request().method() === 'GET') return route.fulfill({ json: tenantOwnerTransferView(fixture.commerce, new URL(route.request().url()).searchParams.get('tenantId')) });
      const body = route.request().postDataJSON(); commands.push(body);
      const result = planTenantOwnerTransfer(fixture.commerce, body, actor, () => [actor, ...(enabled ? [staff] : [])]);
      if (!result.replayed) { commits++; fixture.commerce = { version: result.version, data: result.data }; }
      if (pending) await pending;
      if (lostResponse) { lostResponse = false; return route.fulfill({ status: 503, json: { error: '模拟回包丢失' } }); }
      return route.fulfill({ json: result });
    } catch (error) { return route.fulfill({ status: error.status || 500, json: { error: error.message } }); }
  });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(6000);
  const drawer = page.locator('#drawer[open]'), form = drawer.locator('#commerce-tenant-owner-form');
  const reason = form.locator('#commerce-transfer-reason');
  async function open(id = 'tenant') {
    const row = page.locator('table[data-table="commerce-tenants"] tbody tr').filter({ hasText: id === 'tenant' ? '合成租户甲' : '合成租户乙' });
    await row.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.locator('[data-action="commerce-tenant-owner-transfer"]:visible').click();
    await form.waitFor();
  }
  async function choose(id = staff.id) {
    await form.locator('#commerce-contact-ownerId-picker').click();
    await form.locator(`.commerce-picker-popover:popover-open [data-value="${id}"]`).click();
  }
  async function close() { await drawer.locator('[data-action="drawer-close"]').first().click(); }
  async function submit() {
    await page.locator('button[form="commerce-tenant-owner-form"][type="submit"]').click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  }
  await page.goto(origin + '/#/customers/tenants'); await open();
  await form.locator('#commerce-contact-ownerId option[value="staff"]').waitFor({ state: 'attached' });
  await choose(); await reason.fill('合成员工交接原因'); await close(); await open();
  assert.equal(await reason.inputValue(), '合成员工交接原因');
  assert.equal(await form.locator('#commerce-contact-ownerId').inputValue(), staff.id);
  enabled = false; await submit();
  await form.locator('#commerce-transfer-status').getByText(/已停用或不存在/).waitFor();
  assert.equal(commits, 0); assert.equal(await reason.inputValue(), '合成员工交接原因');
  enabled = true;
  fixture.commerce.version++; fixture.commerce.data.tenants[0].version++;
  await submit(); await form.locator('#commerce-transfer-status').getByText(/租户资料已变化/).waitFor();
  assert.equal(commits, 0);
  await drawer.getByRole('button', { name: '读取最新', exact: true }).click(); await form.waitFor();
  await page.waitForFunction(version => document.querySelector('input[name="commerce-transfer-version"]')?.value === String(version), fixture.commerce.version);
  assert.equal(await reason.inputValue(), '合成员工交接原因');
  assert.equal(await form.locator('input[name="commerce-transfer-version"]').inputValue(), String(fixture.commerce.version));
  lostResponse = true; await submit();
  await page.getByRole('button', { name: '核对上次转交', exact: true }).waitFor();
  assert.equal(commits, 1); assert.equal(await reason.getAttribute('readonly'), '');
  await close(); await open();
  await submit(); await drawer.waitFor({ state: 'hidden' });
  assert.equal(commits, 1); assert.equal(commands.at(-1).operationId, commands.at(-2).operationId);
  assert.equal(fixture.commerce.data.tenants[0].ownerId, staff.id);
  assert.deepEqual(fixture.commerce.data.orders, originalOrders);
  assert.equal(fixture.commerce.data.tenants[0].createdById, 'creator');
  await open(); await choose(actor.id); await reason.fill('下一次交接，测试迟到回包');
  let release; pending = new Promise(resolve => { release = resolve; });
  await submit(); await page.waitForFunction(() => document.querySelector('#commerce-tenant-owner-form')?.getAttribute('aria-busy') === 'true');
  await close(); await open('second'); await reason.fill('乙租户未提交草稿');
  release(); pending = null;
  await page.getByText('租户归属已转交，历史订单归属保持', { exact: true }).waitFor();
  assert.equal(await form.locator('input[name="commerce-transfer-id"]').inputValue(), 'second');
  assert.equal(await reason.inputValue(), '乙租户未提交草稿');
  assert.equal(await page.locator('table[data-table="commerce-tenants"] tr[data-row-id="tenant"] [data-column="owner"]').innerText(), actor.name);
  assert.deepEqual(fixture.commerce.data.orders, originalOrders);
  await close(); await open();
  assert.equal(await drawer.locator('table[data-table="commerce-tenant-owner-history"] tbody tr').count(), 2);
  const evidence = new URL('../.runtime/tenant-owner-transfer-20261108/', import.meta.url); await mkdir(evidence, { recursive: true });
  for (const width of [1440, 900, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const outside = await drawer.locator('form button,form input,form textarea,.drawer-footer button').evaluateAll(nodes => nodes.filter(el => el.checkVisibility()).filter(el => {
      const box = el.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1;
    }).length);
    assert.equal(outside, 0, `${width} ${theme} 抽屉控件不能被裁切`);
    const history = drawer.locator('.table-viewport:has(table[data-table="commerce-tenant-owner-history"])');
    assert(await history.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}));
    await history.evaluate(el=>{el.scrollLeft=el.scrollWidth});
    const reasonBox=await history.locator('tbody tr').first().locator('[data-column="reason"] button').boundingBox();
    assert(reasonBox.x>=0&&reasonBox.x+reasonBox.width<=width+1,'历史原因可通过表内横向滚动完整访问');
    await history.evaluate(el=>{el.scrollLeft=0});
    const toast=page.locator('.toast-dismiss:visible');if(await toast.count())await toast.click();
    if ([1440, 390].includes(width)) await page.screenshot({ path: fileURLToPath(new URL(`transfer-${width}-${theme}.png`, evidence)) });
  }
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []); assert.deepEqual(traffic.unavailable, []);
});
