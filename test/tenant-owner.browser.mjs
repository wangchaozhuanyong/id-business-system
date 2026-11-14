import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageInitialTenantCards } from '../server/tenant-initial-cards.mjs';
import { attributeCommerce } from '../server/local-business.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('租户普通新增及录单快捷新增复用员工归属，保存重试、草稿和历史资料保持独立', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const screenshots = process.env.ID_TENANT_QA_SCREENSHOTS === '1';
  const evidence = new URL('../.runtime/tenant-owner-20261108/', import.meta.url);
  if (screenshots) await mkdir(evidence, { recursive: true });
  for (const role of ['admin', 'super', 'employee']) await t.test(role, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const actor = { id: 'operator', name: '代录管理员', role };
    const staff = { id: 'staff', name: '业务员工甲', role: 'employee' };
    const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
    const legacyPhone = '+1 202 555 0101';
    fixture.commerce.data.tenants = [
      { id: 'legacy', name: '历史租户', phone: legacyPhone, owner: staff.name, version: 1, active: true },
      { id: 'no-phone', name: '无电话历史租户', owner: staff.name, version: 1, active: true },
      { id: 'disabled', name: '已停用租户', phone: '001 202 555 0102', version: 1, active: false }
    ];
    const originalOrders = structuredClone(fixture.commerce.data.orders);
    await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
    let enabled = true, fail = role === 'admin', failSave = 2, reads = 0;
    await context.route('**/api/local/auth/order-owners', route => {
      reads++;
      return fail ? route.fulfill({ status: 503, json: { error: '模拟读取失败' } })
        : route.fulfill({ json: { items: [actor, ...(enabled ? [staff] : [])] } });
    });
    await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor, staff] } }));
    const writes = [], cards = [];
    await context.route('**/api/local/commerce', route => {
      if (route.request().method() === 'GET') return route.fallback();
      const command = route.request().postDataJSON();
      writes.push(command);
      if (failSave > 0) {
        failSave--;
        return route.fulfill({ status: 503, json: { error: '模拟保存失败，请重试' } });
      }
      if (command.version !== fixture.commerce.version)
        return route.fulfill({ status: 409, json: { error: '业务资料已在其他页面更新，请刷新后重试' } });
      try {
        // Run the actual save attribution without starting a server or opening a database.
        attributeCommerce(command.data, fixture.commerce.data, actor, enabled ? [staff] : []);
      } catch (error) {
        return route.fulfill({ status: error.status, json: { error: error.message } });
      }
      cards.push(...stageInitialTenantCards(fixture.commerce.data, command.data, cards).additions);
      fixture.commerce = { version: command.version + 1, data: command.data };
      return route.fulfill({ json: fixture.commerce });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const form = page.locator('#main #commerce-contact-form, #drawer[open] #commerce-contact-form');
    const owner = form.locator('#commerce-contact-ownerId');
    const trigger = form.locator('#commerce-contact-ownerId-picker');
    const popup = form.locator('#commerce-contact-ownerId-popover');
    const search = popup.getByRole('searchbox', { name: '搜索归属人' });
    const name = form.locator('#commerce-contact-name');
    const phone = form.locator('#commerce-contact-phone');
    const phoneError = form.locator('#commerce-contact-phone-error');
    const refresh = form.locator('[data-action="commerce-order-owner-refresh"]');
    async function choose(id) {
      await trigger.click();
      await form.locator('#commerce-contact-ownerId-picker[aria-expanded="true"]').waitFor();
      await search.fill(id === staff.id ? '员工 甲' : '代录管理员');
      await popup.locator(`[data-value="${id}"]`).click();
    }
    async function save(status) {
      const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/commerce');
      await page.locator('button[form="commerce-contact-form"][type="submit"]:visible').click();
      assert.equal((await response).status(), status);
      if (status === 503) await page.getByText('暂时无法确认服务器保存结果，请刷新核对记录后再提交', { exact: true }).waitFor();
      if (status === 409) await page.getByText(/本次未保存，请重新打开并核对当前数据/).waitFor();
    }
    await page.goto(origin + '/#/customers/new/tenant');
    if (role === 'employee') {
      await page.locator('#main').waitFor();
      assert.equal(await form.count(), 0, '沿用既有员工模块访问权限，不因归属接入扩大权限');
      assert.equal(reads, 0);
      assert.equal(writes.length, 0);
      await context.close();
      return;
    }
    await name.waitFor();
    assert.equal(await owner.inputValue(), actor.id, '普通新增默认当前录入人');
    await name.fill('合成新租户');
    if (fail) {
      await form.locator('#commerce-contact-ownerId-error').waitFor();
      fail = false;
      await refresh.click();
    }
    await owner.locator('option[value="staff"]').waitFor({ state: 'attached' });
    assert.equal(await name.inputValue(), '合成新租户', '刷新人员目录保留输入');
    await phone.fill('＋１ (２０２) ５５５-０１０１');
    await phoneError.getByText('此联系电话已被其他租户使用。').waitFor();
    assert.equal(await phone.getAttribute('aria-invalid'), 'true');
    await page.locator('button[form="commerce-contact-form"][type="submit"]:visible').click();
    assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
    assert.equal(writes.length, 0, '重复电话不进入确认或写入');
    await phone.fill('');
    await phoneError.waitFor({ state: 'hidden' });
    await choose(staff.id);
    await form.locator('[data-action="commerce-initial-card-add"]').click();
    await form.locator('#commerce-initial-card-0-number').fill('4000 0000 0000 0000');
    await form.locator('#commerce-initial-card-0-label').fill('合成银行卡');
    await form.locator('[data-action="commerce-initial-card-add"]').click();
    await form.locator('#commerce-initial-card-1-number').fill('4000000000000000');
    await page.locator('button[form="commerce-contact-form"][type="submit"]:visible').click();
    await form.locator('#commerce-initial-card-1-number-error').getByText('银行卡号重复').waitFor();
    assert.equal(writes.length, 0, '重复银行卡不会触发保存');
    await form.locator('#commerce-initial-card-1-number').fill('');
    assert.equal(await form.locator('#commerce-initial-card-0-label').inputValue(), '合成银行卡');
    await page.goto(origin + '/#/customers/tenants');
    await page.locator('[data-action="commerce-contact-add"][data-kind="tenant"]').click();
    assert.equal(await owner.inputValue(), staff.id, '切页后抽屉恢复同一租户新增草稿');
    assert.equal(await name.inputValue(), '合成新租户');
    assert.equal(await form.locator('#commerce-initial-card-0-number').inputValue(), '4000 0000 0000 0000');
    await save(503);
    assert.equal(await owner.inputValue(), staff.id);
    assert.equal(await name.inputValue(), '合成新租户', '保存失败保留完整输入');
    await page.locator('#drawer [data-action="drawer-close"]').first().click();
    await page.goto(origin + '/#/customers/new/tenant');
    await page.locator('[data-action="commerce-local-retry"]').click();
    await name.waitFor();
    assert.equal(await owner.inputValue(), staff.id, '保存结果待核对时，先重新读取再恢复草稿');
    await save(200);
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    const saved = fixture.commerce.data.tenants.find(row => row.name === '合成新租户');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].tenantId, saved.id);
    assert.equal(cards[0].number, '4000000000000000');
    assert(!Object.hasOwn(saved, 'initialCards'));
    assert.equal(saved.ownerId, staff.id);
    assert.equal(saved.owner, staff.name);
    assert.equal(saved.phone, '', '普通新增允许联系方式和一个新增空白卡行留空');
    assert.equal(saved.createdById, actor.id);
    assert.equal(saved.updatedById, actor.id);
    await page.locator(`#commerce-entry-records tr[data-row-id="${saved.id}"]`).waitFor();
    assert.equal(new URL(page.url()).hash, '#/customers/new/tenant');
    assert.equal(await name.inputValue(), '');
    assert.equal(await phone.inputValue(), '');
    assert.equal(await owner.inputValue(), actor.id);
    assert.equal(await form.locator('#commerce-initial-card-0-number').count(), 0);
    await page.getByRole('button', { name: '返回租户数据', exact: true }).click();
    const row = page.locator(`tr[data-row-id="${saved.id}"]`);
    assert.match(await row.innerText(), /业务员工甲/);
    assert.match(await row.innerText(), /代录管理员/);

    await page.locator('[data-action="commerce-contact-edit"][data-id="legacy"]').click();
    assert.equal(await trigger.count(), 0);
    assert.equal(await owner.getAttribute('readonly'), '');
    assert.equal(await owner.inputValue(), staff.name);
    await form.locator('#commerce-contact-notes').fill('只修改历史备注');
    if (role === 'admin') {
      await phone.fill('+1 202 555-0102');
      await phoneError.waitFor();
      await phone.fill('001 202 555-0101');
      await phoneError.waitFor({ state: 'hidden' });
      await phone.fill('+1 202 555 0103');
      fixture.commerce.data.tenants.push({
        id: 'other-tab', name: '另一页面新增租户', phone: '001 202 555 0103', version: 1, active: true
      });
      fixture.commerce.version++;
      await save(409);
      await phoneError.getByText('此联系电话已被其他租户使用。').waitFor();
      assert.equal(await phone.inputValue(), '+1 202 555 0103', '并发冲突保留录入内容');
      await phone.fill(legacyPhone);
      await phoneError.waitFor({ state: 'hidden' });
    }
    await save(200);
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    const historical = fixture.commerce.data.tenants.find(row => row.id === 'legacy');
    assert.equal(Object.hasOwn(historical, 'ownerId'), false, '同名员工不会使历史租户自动绑定');
    assert.equal(Object.hasOwn(historical, 'createdById'), false);
    assert.equal(historical.owner, staff.name);
    assert.deepEqual(fixture.commerce.data.orders, originalOrders);

    await page.locator('[data-action="commerce-contact-edit"][data-id="no-phone"]').click();
    assert.equal(await phone.inputValue(), '');
    await form.locator('#commerce-contact-notes').fill('无电话也可编辑');
    fixture.commerce.version++;
    assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.refreshCommerce()), true);
    await save(200);
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    const noPhone = fixture.commerce.data.tenants.find(row => row.id === 'no-phone');
    assert.equal(noPhone.notes, '无电话也可编辑');
    assert.equal(noPhone.phone, '');
    assert.equal(noPhone.version, 2);
    assert.equal(writes.at(-1).recordChange.after.id, noPhone.id);

    await page.goto(origin + '/#/workspace/order/claude');
    await page.locator('#commerce-ownerId option[value="staff"]').waitFor({ state: 'attached' });
    await page.locator('#commerce-ownerId').selectOption(staff.id, { force: true });
    await page.locator('#commerce-email').fill('preserve-order@example.test');
    await page.locator('#commerce-businessType').selectOption('首次开通');
    const supplement = page.locator('#main #commerce-order-form details').filter({ hasText: 'Claude 补充资料' });
    await supplement.locator('summary').click();
    await page.locator('[data-action="commerce-quick-tenant"][data-target="claudeVerifierId"]').click();
    await owner.locator('option[value="staff"]').waitFor({ state: 'attached' });
    assert.equal(await owner.inputValue(), actor.id, '快捷新增也默认实际录入人，不沿用订单所选员工');
    assert.equal(await page.locator('#commerce-ownerId').inputValue(), staff.id);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, index, ids) => ids.indexOf(id) !== index).length), 0, '快捷抽屉与订单控件编号不冲突');
    const help = form.locator('[data-commerce-field="contact-ownerId"] .field-title-help');
    assert.equal(await help.getAttribute('open'), null);
    const beforeHelp = await trigger.boundingBox();
    await help.locator('summary').click();
    assert.equal(await help.getAttribute('open'), '');
    assert.deepEqual(await trigger.boundingBox(), beforeHelp, '说明浮层不挤动归属控件');
    await page.keyboard.press('Escape');
    assert.equal(await help.getAttribute('open'), null);
    const dismiss = page.locator('.toast-dismiss:visible');
    if (await dismiss.count()) await dismiss.click();
    for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
      await trigger.click();
      await form.locator('#commerce-contact-ownerId-picker[aria-expanded="true"]').waitFor();
      const layout = await popup.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          noOverflow: document.documentElement.scrollWidth <= innerWidth };
      });
      assert(layout.fits && layout.noOverflow, JSON.stringify({ width, dark, ...layout }));
      const alignment = await trigger.evaluate(node => {
        const control = node.getBoundingClientRect();
        const label = node.closest('.field').querySelector('label').getBoundingClientRect();
        const refresh = node.closest('.field').querySelector('[data-action="commerce-order-owner-refresh"]').getBoundingClientRect();
        return { labelAbove: label.bottom <= control.top, overlap: label.left < control.right && label.right > control.left,
          actionsVisible: refresh.right <= innerWidth && refresh.width > 0 && control.width > 0 };
      });
      assert(alignment.labelAbove && alignment.overlap && alignment.actionsVisible, JSON.stringify({ width, dark, ...alignment }));
      if (screenshots && role === 'admin' && !dark && width !== 320)
        await page.screenshot({ path: fileURLToPath(new URL(`tenant-owner-${width}-light.png`, evidence)) });
      await search.press('Escape');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await name.fill('快捷合成租户');
    await form.locator('[data-action="commerce-initial-card-add"]').click();
    await save(200);
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    const quick = fixture.commerce.data.tenants.find(row => row.name === '快捷合成租户');
    assert.equal(cards.length, 1, '快捷新增空白卡行不会创建银行卡');
    assert.equal(quick.phone, '', '快捷新增允许联系方式留空');
    assert.equal(quick.ownerId, actor.id);
    assert.equal(await page.locator('#commerce-claudeVerifierId').inputValue(), quick.id, '快捷新增成功回填认证人');
    assert.equal(await page.locator('#commerce-tenantId').inputValue(), '', '回填认证人不改变用卡人');
    assert.equal(await page.locator('#commerce-ownerId').inputValue(), staff.id, '租户归属不覆盖订单归属');
    assert.equal(await page.locator('#commerce-email').inputValue(), 'preserve-order@example.test');
    assert.deepEqual(fixture.commerce.data.orders, originalOrders);

    await page.goto(origin + '/#/customers/new/tenant');
    await name.fill('失效归属重试');
    await phone.fill('合成电话 03');
    await choose(staff.id);
    enabled = false;
    await refresh.click();
    await form.locator('#commerce-contact-ownerId-error').waitFor();
    const count = writes.length;
    await page.locator('button[form="commerce-contact-form"][type="submit"]:visible').click();
    assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
    assert.equal(writes.length, count, '已知失效员工不能静默改为自己后提交');
    enabled = true;
    await refresh.click();
    await owner.locator('option[value="staff"]:not([disabled])').waitFor({ state: 'attached' });
    enabled = false;
    await save(409);
    assert.equal(await name.inputValue(), '失效归属重试', '提交时员工失效，服务端拒绝且保留草稿');
    enabled = true;
    await refresh.click();
    await save(200);
    assert.equal(fixture.commerce.data.tenants.find(row => row.name === '失效归属重试').ownerId, staff.id);
    assert.deepEqual(fixture.commerce.data.orders, originalOrders);
    assert.deepEqual(errors, []);
    await context.close();
  });
});
