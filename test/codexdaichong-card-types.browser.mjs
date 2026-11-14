import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('card pool renders, imports and edits shared card types', { timeout: 35_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const { external } = await interceptDesign(context);
  const prefix = '/integrations/codexdaichong';
  const first = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  let cardReads = 0;
  let planPolicy = { version: 0, strict: false };
  const firstNumber = '4000000000000007';
  const newNumber = '5000000000000007';
  const thirdNumber = '6000000000000007';
  const pool = [{ id: 1, last4: '0007', card_number: firstNumber }, { id: 2, last4: '0007' }];
  const otherType = { id: 'type-b', name: '合成备用类型', active: true };
  const disabledType = { id: 'type-disabled', name: '合成停用类型', active: false };
  const importRequests = [];
  const typeWrites = [];
  let failingWrite = false;
  let types = { version: 1, items: [{ id: 'type-a', name: '<img src=x onerror=alert(1)>测试', active: true }], assignments: { 'recharge:1': 'type-a' } };
  let failing = false;
  await context.route(origin + prefix + '/api/admin/cards', (route) => {
    cardReads++;
    return route.fulfill({ json: { cards: pool, planPolicy } });
  });
  await context.route(origin + prefix + '/api/admin/cards/import', (route) => {
    assert.equal(route.request().method(), 'POST');
    const request = route.request().postDataJSON();
    assert.deepEqual(request.allowedPlans, ['pro500']);
    assert.equal(request.planVersion, planPolicy.version);
    const numbers = request.cards.map(card => card.card_number);
    importRequests.push(numbers.length);
    planPolicy = { ...planPolicy, version: planPolicy.version + 1 };
    if (numbers.length === 4) {
      assert.deepEqual(request.cards, [
        { card_number: newNumber, card_expiry: '01/30', card_cvc: '007', card_holder: 'Sample  Card Holder' },
        { card_number: firstNumber, card_expiry: '01/30', card_cvc: '000', card_holder: 'Original Holder' },
        { card_number: newNumber, card_expiry: '0130', card_cvc: '000', card_holder: '' },
        { card_number: 'invalid', card_expiry: '01/30', card_cvc: '000', card_holder: '' }
      ]);
      pool.push({ id: 3, last4: '0007', card_number: newNumber, allowed_plans: ['pro500'] });
      return route.fulfill({ json: { success: true, imported: 1, assignedPlans: 1, planPolicy, skipped: 2, failed: 1,
        failures: [{ index: 3, errors: ['synthetic-sensitive-failure'] }] } });
    }
    assert.deepEqual(numbers, [thirdNumber]);
    pool.push({ id: 4, last4: '0007', card_number: thirdNumber, allowed_plans: ['pro500'] });
    return route.fulfill({ json: { success: true, imported: 1, assignedPlans: 1, planPolicy, skipped: 0, failed: 0, failures: [] } });
  });
  await context.route(origin + '/api/local/card-types', async (route) => {
    if (route.request().method() === 'POST') {
      const command = route.request().postDataJSON();
      typeWrites.push(command);
      if (failingWrite) return route.fulfill({ status: 503, json: { error: 'synthetic' } });
      assert.equal(command.version, types.version);
      if (command.action === 'assign-imported') {
        assert.deepEqual(command, { action: 'assign-imported', cardIds: ['recharge:1', 'recharge:3'],
          typeId: otherType.id, version: types.version });
        types = { ...types, version: types.version + 1, assignments: { ...types.assignments, 'recharge:3': otherType.id } };
        return route.fulfill({ json: { ...types, importTypes: { assigned: 1, alreadyAssigned: 0, conflict: 1, missing: 0 } } });
      }
      assert.deepEqual(command, { action: 'assign', cardId: 'recharge:2', typeId: otherType.id, version: types.version });
      types = { ...types, version: types.version + 1, assignments: { ...types.assignments, 'recharge:2': otherType.id } };
      return route.fulfill({ json: types });
    }
    assert.equal(route.request().method(), 'GET');
    assert.equal(new URL(route.request().url()).search, '');
    if (++reads === 1) {
      first.resolve();
      await release.promise;
    }
    return failing ? route.fulfill({ status: 503, json: { error: 'synthetic' } }) : route.fulfill({ json: types });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin + prefix + '/admin?view=cards');
  await first.promise;
  const cards = page.locator('#cards.active .card-pool-table');
  const typed = cards.locator('[data-recharge-card-type="recharge:1"] select');
  const untyped = cards.locator('[data-recharge-card-type="recharge:2"] select');
  const selected = (select, label) =>
    select.locator('option:checked').filter({ hasText: label }).waitFor({ state: 'attached' });
  await cards.getByRole('columnheader', { name: '银行卡类型', exact: true }).waitFor();
  await selected(typed, '加载中…');
  release.resolve();
  await selected(typed, types.items[0].name);
  await selected(untyped, '未设置');
  assert.equal(await typed.locator('img').count(), 0);
  assert.equal(await cards.locator('thead th').count(), 12);
  assert.equal(await cards.locator('tbody tr').first().locator('td').count(), 12);

  failing = true;
  await page.evaluate(() => loadCardPoolList());
  await page.getByText('银行卡类型刷新失败，已保留上次结果。', { exact: true }).waitFor();
  await selected(typed, types.items[0].name);
  const previousCardReads = cardReads;
  failing = false;
  types = { version: 2, items: [{ id: 'type-a', name: '已同步的新名称', active: true }], assignments: { 'recharge:1': 'type-a' } };
  await page.getByRole('button', { name: '重试读取类型' }).click();
  await selected(typed, '已同步的新名称');
  assert.equal(cardReads, previousCardReads);
  await page.getByRole('button', { name: '重试读取类型' }).waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.idTheme = 'dark'; });
  await settle(page);
  await selected(typed, '已同步的新名称');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  const parentUrl = origin + '/card-types-notification-fixture';
  await context.route(parentUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<iframe title="银行卡池" src="' + prefix + '/admin?view=cards"></iframe>'
  }));
  const host = await context.newPage();
  host.on('pageerror', (error) => pageErrors.push(error.message));
  await host.goto(parentUrl);
  const frame = host.frameLocator('iframe');
  const embeddedType = frame.locator('[data-recharge-card-type="recharge:1"] select');
  await selected(embeddedType, '已同步的新名称');
  const post = (message) => host.evaluate((detail) => {
    document.querySelector('iframe').contentWindow.postMessage({
      source: 'id-recharge-shell', ...detail
    }, location.origin);
  }, message);
  await post({ type: 'visibility', visible: true });
  const before = { reads, cardReads };
  types = { version: 3, items: [{ id: 'type-a', name: '通知同步的类型', active: true }, otherType, disabledType], assignments: { 'recharge:1': 'type-a' } };
  await frame.locator('body').evaluate(() => {
    const data = { source: 'id-recharge-shell', type: 'data-change', scopes: ['card-types'] };
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data }));
    window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin: 'https://other.invalid', data }));
  });
  await post({ type: 'data-change', scopes: ['settings'] });
  await post({ type: 'visibility', visible: false });
  await post({ type: 'data-change', scopes: ['card-types'] });
  await settle(host);
  assert.equal(reads, before.reads, 'wrong sender, origin, scope and hidden notifications do not fetch');
  await post({ type: 'visibility', visible: true });
  await post({ type: 'data-change', scopes: ['card-types'] });
  await selected(embeddedType, '通知同步的类型');
  assert.equal(reads, before.reads + 1);
  assert.equal(cardReads, before.cardReads, 'notification refreshes types without reading the upstream card list');
  assert.equal(host.url(), parentUrl);
  await page.evaluate(() => loadCardPoolList());
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  const importBox = page.locator('#card_pool_import_box');
  const type = importBox.getByRole('combobox', { name: '银行卡类型', exact: true });
  const submit = importBox.getByRole('button', { name: '解析并导入', exact: true });
  const input = importBox.getByRole('textbox', { name: '待导入银行卡资料', exact: true });
  const receipt = importBox.getByRole('status');
  await importBox.locator('summary[aria-label="查看批量导入银行卡说明"]').click();
  await importBox.getByText('卡号 有效期 CVC 持卡人', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await input.getAttribute('placeholder'), '卡号 10/30 CVC\n卡号 10/30 CVC 持卡人');
  await type.locator('option[value="type-b"]').waitFor({ state: 'attached' });
  assert.equal(await type.locator('option[value="type-disabled"]').count(), 0);
  assert.equal(await submit.isDisabled(), true);
  assert.equal(importRequests.length, 0);
  const placement = await type.evaluate(node => {
    const control = node.getBoundingClientRect();
    const label = node.labels[0].getBoundingClientRect();
    const input = document.getElementById('card_pool_import_text').getBoundingClientRect();
    return (innerWidth <= 600 ? label.bottom <= control.top : label.right <= control.left) && control.bottom < input.top;
  });
  assert.equal(placement, true);
  await type.selectOption(otherType.id);
  await importBox.getByRole('checkbox', { name: 'Pro 500' }).check();
  const incomplete = newNumber + ' 01/30';
  await input.fill(incomplete);
  await submit.click();
  await receipt.filter({ hasText: '第 1 行格式错误（请填写卡号、有效期和 CVC，用空格或竖线分隔）' }).waitFor();
  assert.equal(await input.inputValue(), incomplete);
  assert.equal(importRequests.length, 0);
  await input.fill([
    '  ' + newNumber + '   01/30   007 Sample  Card Holder  ',
    firstNumber + '|01/30|000|Original Holder',
    newNumber + '\t0130\t000',
    'invalid 01/30 000',
    ' '
  ].join('\n'));
  await submit.click();
  await receipt.filter({ hasText: '导入 1 张，跳过重复 2 张，失败 1 张；已设置允许套餐 1 张；已确认银行卡类型 1 张，已有其他类型 1 张' }).waitFor();
  assert.equal(await input.inputValue(), '');
  await selected(cards.locator('[data-recharge-card-type="recharge:3"] select'), otherType.name);
  assert.equal(await typed.inputValue(), 'type-a');
  await cards.locator('[data-card-plan-edit="3"]').getByText('Pro 500').waitFor();

  failingWrite = true;
  await input.fill(thirdNumber + '|01/30|000');
  await submit.click();
  await receipt.filter({ hasText: /导入 1 张.*银行卡类型待核对/ }).waitFor();
  assert.deepEqual(importRequests, [4, 1]);
  assert.deepEqual(typeWrites[1].cardIds, ['recharge:4']);
  assert.equal(await input.inputValue(), '');
  await selected(cards.locator('[data-recharge-card-type="recharge:4"] select'), '未设置');
  failingWrite = false;
  await untyped.selectOption(otherType.id);
  await selected(untyped, otherType.name);
  await page.getByText('银行卡类型已保存', { exact: true }).waitFor();
  assert.doesNotMatch(JSON.stringify(typeWrites), /0000000000007|synthetic-sensitive-failure/);
  assert.deepEqual(external, []);
  assert.deepEqual(pageErrors, []);
});

test('银行卡池操作列修改旧卡类型并在原页回读', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const actor = { id: 'card-edit-fixture', name: '离线验收超级管理员', role: 'super' };
  for (const width of [1440, 390]) await t.test(String(width), async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    try {
      const traffic = await interceptDesign(context, { localFixtures: {}, actor });
      const cards = Array.from({ length: 22 }, (_, index) => ({ id: index + 1, last4: '0011', is_active: 1 }));
      const types = { version: 1, assignments: {}, items: [
        { id: 'sample-type', name: '离线样例卡', active: true }
      ] };
      const writes = [], errors = [];
      let cardReads = 0;
      await context.route(origin + '/integrations/codexdaichong/api/admin/cards', route => {
        cardReads++;
        return route.fulfill({ json: { success: true, cards } });
      });
      await context.route(origin + '/api/local/card-types', route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: types });
        const command = route.request().postDataJSON();
        writes.push(command);
        if (writes.length === 1) types.version++;
        if (command.version !== types.version)
          return route.fulfill({ status: 409, json: { error: '银行卡类型已更新，请读取最新后重试' } });
        types.assignments[command.cardId] = command.typeId;
        types.version++;
        return route.fulfill({ json: types });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/online-recharge/chatgpt');
      if (width === 390) await toggleDesignTheme(page);
      await page.locator('button[data-view="cards"]').click();
      const frame = page.frameLocator('#main iframe[data-view="cards"]:not([hidden])');
      const pager = frame.locator('nav[data-pagination="recharge-card_pool"]');
      await pager.getByRole('button', { name: '下一页' }).click();
      const type = frame.locator('[data-recharge-card-type="recharge:21"]');
      await type.getByText('未设置', { exact: true }).waitFor();
      const edit = frame.locator('button[data-edit-recharge-card-type="recharge:21"]');
      assert.equal(await edit.innerText(), '修改');
      const fit = await edit.evaluate(node => {
        const cell = node.closest('td').getBoundingClientRect();
        const viewport = node.closest('.table-container').getBoundingClientRect();
        const buttons = [...node.parentElement.querySelectorAll('button')];
        return buttons.length === 2 && buttons.every(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= Math.max(cell.left, viewport.left) - 1 &&
            rect.right <= Math.min(cell.right, viewport.right) + 1;
        });
      });
      assert(fit, '修改与删除应完整显示在操作列');
      const readsBeforeEdit = cardReads;
      await edit.click();
      const drawer = page.locator('#drawer[open]');
      const select = drawer.getByLabel('银行卡类型', { exact: true });
      await drawer.getByRole('heading', { name: '设置银行卡类型', exact: true }).waitFor();
      await select.selectOption('sample-type');
      await drawer.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(writes.length, 0);
      await edit.click();
      await select.waitFor();
      assert.equal(await select.inputValue(), 'sample-type');
      const save = drawer.getByRole('button', { name: '保存类型', exact: true });
      await save.click();
      await drawer.getByRole('alert').getByText('银行卡类型已更新，请读取最新后重试', { exact: true }).waitFor();
      assert.equal(await select.inputValue(), 'sample-type');
      await drawer.getByRole('button', { name: '读取最新', exact: true }).click();
      await drawer.locator('input[name="commerce-assignment-version"][value="2"]').waitFor({ state: 'attached' });
      assert.equal(await select.inputValue(), 'sample-type');
      await save.click();
      await type.getByText('离线样例卡', { exact: true }).waitFor();
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(await pager.getAttribute('data-page'), '2');
      assert.equal(cardReads, readsBeforeEdit, '保存类型只重新读取类型资料');
      assert.deepEqual(writes, [1, 2].map(version =>
        ({ action: 'assign', version, cardId: 'recharge:21', typeId: 'sample-type' })));
      await settle(page);
      assert(await edit.evaluate(button => button.ownerDocument.activeElement === button));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(traffic.unavailable, []);
    } finally { await context.close(); }
  });
});
