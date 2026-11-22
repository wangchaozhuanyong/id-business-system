import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const fixtureReference = '11111111-1111-4111-8111-111111111111';
const fixtureTicket = 'a'.repeat(43);

test('partner workspace keeps desktop forms in one row and readable lists across themes and screen sizes',
  { timeout: 60_000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const output = (process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/recharge-partner-layout-20261116') + '/partners';
    await mkdir(output, { recursive: true });
    const measurements = [];
    for (const width of [2250, 1920, 1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      try {
        const access = await interceptDesign(context, { actor: { id: 'fixture-super', role: 'super', name: '管理员' },
          localFixtures: {}, rechargePartnerApi: true, skipRechargeAssets: true });
        const partners = [
          { id: 'rp_' + 'a'.repeat(24), name: '演示合作方 A', disabledAt: '2026-11-14T00:00:00Z' },
          { id: 'rp_' + 'b'.repeat(24), name: '演示合作方 B' }
        ];
        const source = { apiBase: 'https://api.example.test/api/recharge/v1', partners, batches: [], page: 1, pages: 1 };
        await context.route('**/api/local/recharge-partners*', route => {
          assert.equal(route.request().method(), 'GET');
          return route.fulfill({ json: source });
        });
        const page = await context.newPage();
        await page.goto(origin + '/#/online-recharge/partners');
        await page.locator('[data-partner-content]:visible').waitFor();
        if (theme === 'dark') await toggleDesignTheme(page);
        for (const state of ['initial', 'long-records', 'empty']) {
          if (state === 'long-records') {
            partners[1].name = '离线合成长名称合作方'.repeat(8);
            source.apiBase = 'https://' + 'long-api-host-'.repeat(5) + '.example.test/api/recharge/v1';
            source.batches = Array.from({ length: 20 }, (_, index) => ({ id: 'batch-' + index, batchNo: 'PO' + String(index + 1).padStart(6, '0'),
              partnerId: partners[1].id, plan: 'pro200', codes: ['synthetic-code'] }));
            source.pages = 2;
          } else if (state === 'empty') {
            source.partners = []; source.batches = []; source.pages = 1;
          }
          if (state !== 'initial') {
            const response = page.waitForResponse(response => response.url().includes('/api/local/recharge-partners'));
            await page.locator('[data-action="recharge-partner-refresh"]').click();
            await response;
          }
          await settle(page);
          const spacing = await spacingSnapshot(page);
          const geometry = await page.locator('[data-partner-page]').evaluate(host => {
            const controls = selector => [...host.querySelectorAll(selector)].map(node => {
              const box = node.getBoundingClientRect();
              return { x: box.x, y: box.y, right: box.right, width: box.width, height: box.height };
            });
            return { setup: controls('.recharge-partner-setup :is(input, button)'),
              issue: controls('[data-partner-form="issue"] :is(input, select, button)'),
              actions: controls('.table-actions .button'), viewport: innerWidth };
          });
          const label = JSON.stringify({ width, theme, state });
          assert.equal(spacing.overflow, false, label);
          assert.deepEqual(spacing.findings, [], label);
          assert.equal(await page.locator('[data-partner-batches] td[data-column="plan"]:visible').count(), source.batches.length,
            label + ' 发码套餐应直接可见');
          if (width >= 1440) assert(Math.max(...geometry.setup.map(box => box.y)) - Math.min(...geometry.setup.map(box => box.y)) <= 1, label + ' API 与合作方必须同排');
          if (width >= 1024) assert(Math.max(...geometry.issue.map(box => box.y)) - Math.min(...geometry.issue.map(box => box.y)) <= 1, label + ' 发码控件必须同排');
          assert(geometry.actions.every(box => box.width > 0 && box.x >= 0 && box.right <= geometry.viewport), label + ' 操作按钮不可裁切');
          assert(geometry.setup.concat(geometry.issue).every(box => box.height >= (width <= 900 ? 44 : 36)), label + ' 控件高度');
          assert.equal(await page.getByText('可调整搜索或筛选条件。', { exact: true }).count(), 0);
          measurements.push({ width, theme, state, geometry, spacing });
          if (state === 'initial' && [1920, 1440, 390].includes(width)) {
            await page.screenshot({ path: output + `/after-${width}-${theme}.png`, fullPage: true, animations: 'disabled' });
          }
        }
        assert.deepEqual(access.external, []);
      } finally { await context.close(); }
    }
    await writeFile(output + '/layout-results.json', JSON.stringify(measurements, null, 2));
  });

test('partner admin issues and copies only the scoped key and codes with the shared navigation and mobile layout',
  { timeout: 30_000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const actor = { id: 'fixture-super', role: 'super', name: '管理员', email: 'admin@example.test' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const access = await interceptDesign(context, { actor, localFixtures: {}, rechargePartnerApi: true, skipRechargeAssets: true });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { async writeText(value) { window.fixtureCopied = value; } } });
    });
    const source = { apiOrigin: origin, apiBase: origin + '/api/recharge/v1', partners: [], batches: [], page: 1, pages: 1 };
    const key = 'synthetic-api-key-only';
    const newKey = 'synthetic-rotated-key-only';
    const code = 'RA-' + 'A'.repeat(32);
    const partner = { id: 'rp_' + 'b'.repeat(24), name: '测试合作方', createdAt: '2026-11-14T12:00:00Z' };
    const actions = [], issued = new Map();
    let failBatchRefresh = false, loseIssueReceipt = false;
    await context.route('**/api/local/recharge-partners*', async route => {
      if (route.request().method() === 'GET') {
        if (failBatchRefresh) return route.fulfill({ status: 503, json: { error: '合成批次刷新失败' } });
        return route.fulfill({ json: source });
      }
      const input = route.request().postDataJSON();
      actions.push(input);
      if (input.action === 'create') {
        source.partners.push(partner);
        return route.fulfill({ status: 201, json: { partner, apiKey: key } });
      }
      if (input.action === 'rotate') return route.fulfill({ json: { partner, apiKey: newKey } });
      if (issued.has(input.operationId)) return route.fulfill({ json: { batch: issued.get(input.operationId) } });
      const index = issued.size + 1;
      const batch = { id: 'synthetic-batch-' + index, partnerId: partner.id, plan: input.plan,
        batchNo: 'PO' + String(index).padStart(6, '0'), codes: [code] };
      issued.set(input.operationId, batch);
      source.batches.push(batch);
      if (loseIssueReceipt) { loseIssueReceipt = false; return route.abort('connectionreset'); }
      failBatchRefresh = true;
      return route.fulfill({ status: 201, json: { batch } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/online-recharge/partners');
    await page.getByLabel('合作方名称', { exact: true }).fill(partner.name);
    await page.getByRole('button', { name: '创建合作方', exact: true }).click();
    await page.getByRole('button', { name: '复制接入资料', exact: true }).click();
    await page.waitForFunction(value => window.fixtureCopied?.includes(value), key);
    assert(!(await page.locator('body').innerText()).includes(key));
    await page.locator('[data-action="recharge-partner-close"]').click();
    assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
    await page.getByLabel('合作方', { exact: true }).selectOption(partner.id);
    await page.getByLabel('套餐', { exact: true }).selectOption({ label: 'Pro 500' });
    const issue = page.getByRole('button', { name: '发放兑换码', exact: true });
    await issue.click();
    await page.getByText('已发放批次 PO000001，共 1 个兑换码。', { exact: true }).waitFor();
    await page.getByText('合成批次刷新失败', { exact: true }).waitFor();
    assert(await issue.isDisabled());
    failBatchRefresh = false;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.locator('[data-partner-batches]').getByText('Pro 500', { exact: true }).waitFor();
    assert(await issue.isEnabled());
    assert.equal(await page.getByRole('button', { name: '准备发放下一批', exact: true }).count(), 0);
    await page.getByRole('button', { name: '复制兑换码', exact: true }).click();
    await page.waitForFunction(value => window.fixtureCopied === value, code);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '更换密钥', exact: true }).click();
    await page.getByRole('button', { name: '复制接入资料', exact: true }).click();
    await page.waitForFunction(value => window.fixtureCopied?.includes(value), newKey);
    assert(!(await page.locator('body').innerText()).includes(newKey));
    await page.locator('[data-action="recharge-partner-close"]').click();
    assert.deepEqual(actions.map(input => input.action), ['create', 'issue', 'rotate']);
    assert.equal(actions[1].plan, 'pro500');
    assert(actions.every(input => Boolean(input.operationId)));

    loseIssueReceipt = true;
    await page.getByLabel('套餐', { exact: true }).selectOption('pro100');
    await issue.click();
    await page.getByText('发码结果暂未确认，请按相同条件核对原批次。', { exact: true }).waitFor();
    assert.equal(source.batches.length, 2);
    const stored = await page.evaluate(() => Object.entries(sessionStorage)
      .filter(([key]) => key.includes(':recharge-issue:')).map(([, value]) => value));
    assert.deepEqual(stored, [actions[3].operationId]);
    await page.reload();
    await page.getByLabel('合作方', { exact: true }).selectOption(partner.id);
    await page.getByLabel('套餐', { exact: true }).selectOption('pro100');
    await page.getByText('上次发码结果待核对。按相同条件提交会使用原编号核对回执。', { exact: true }).waitFor();
    await issue.click();
    await page.getByText('已发放批次 PO000002，共 1 个兑换码。', { exact: true }).waitFor();
    assert.equal(actions[3].operationId, actions[4].operationId);
    assert.equal(source.batches.length, 2);
    await issue.click();
    await page.getByText('已发放批次 PO000003，共 1 个兑换码。', { exact: true }).waitFor();
    assert.notEqual(actions[4].operationId, actions[5].operationId);
    assert.equal(source.batches.length, 3);

    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === sessionStorage && key.includes(':recharge-issue:')) throw new DOMException('fixture', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    await page.getByLabel('套餐', { exact: true }).selectOption('pro200');
    await issue.click();
    await page.getByText('无法保留发码编号。请允许此站点使用会话存储后再提交。', { exact: true }).waitFor();
    assert.equal(actions.length, 6);

    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.getByRole('button', { name: '复制兑换码', exact: true }).first().isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    assert.deepEqual(access.external, []);
  });

test('已打开的旧数据脚本可读合作方与创建资料，发码提示整页刷新', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const traffic = await interceptDesign(context, {
    actor: { id: 'receipt-compat-super', role: 'super', name: '合成管理员' },
    localFixtures: {}, rechargePartnerApi: true, skipRechargeAssets: true
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'IDLocalData', {
      configurable: true,
      set({ pendingWriteReceipt, rememberWriteReceipt, forgetWriteReceipt, ...previous }) {
        Object.defineProperty(window, 'IDLocalData', { value: Object.freeze(previous), configurable: true });
      }
    });
  });
  const original = { id: 'rp_' + 'a'.repeat(24), name: '合成原合作方' };
  const created = { id: 'rp_' + 'b'.repeat(24), name: '合成新合作方' };
  const value = { apiBase: origin, partners: [original], batches: [], page: 1, pages: 1 };
  const actions = [];
  await context.route('**/api/local/recharge-partners*', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: value });
    const { action } = route.request().postDataJSON();
    actions.push(action);
    if (action !== 'create') return route.abort();
    value.partners.push(created);
    return route.fulfill({ status: 201, json: { partner: created } });
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/overview');
  await page.evaluate(() => window.IDDesignAPI.go('online-recharge/partners'));
  await page.locator('[data-partner-list]').getByText(original.name, { exact: true }).waitFor();
  await page.getByLabel('合作方', { exact: true }).selectOption(original.id);
  await page.getByRole('button', { name: '发放兑换码', exact: true }).click();
  await page.getByText('页面资源已更新，请整页刷新后再发码。', { exact: true }).waitFor();
  assert.deepEqual(actions, []);
  await page.getByLabel('合作方名称', { exact: true }).fill(created.name);
  await page.getByRole('button', { name: '创建合作方', exact: true }).click();
  await page.locator('[data-partner-list]').getByText(created.name, { exact: true }).waitFor();
  assert.deepEqual(actions, ['create']);
  assert.deepEqual(traffic.external, []);
});

test('ID authorization page shows the account locally, posts consent once, and clears the form on an uncertain result',
  { timeout: 30_000 }, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const html = await readFile(new URL('../frontend/recharge-partner-authorize.html', import.meta.url));
    for (const [width, plan, label] of [[1440, 'plus', 'Plus'], [390, 'pro500', 'Pro 500']]) {
      const context = await browser.newContext({ viewport: { width, height: 850 } });
      const source = await interceptDesign(context, { skipRechargeAssets: true });
      await context.route('**/recharge/authorize', route => route.fulfill({ body: html, contentType: 'text/html' }));
      let writes = 0, status = 'awaiting_authorization';
      await context.route('**/recharge/authorize/request', route => {
        const input = route.request().postDataJSON();
        assert.equal(input.id, fixtureReference);
        assert.equal(input.ticket, fixtureTicket);
        if (input.session) {
          writes++;
          status = 'queued';
          return route.fulfill({ status: 503, json: {} });
        }
        return route.fulfill({ json: { id: fixtureReference, partner: '测试合作方', plan, status } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/recharge/authorize#' + fixtureReference + '.' + fixtureTicket);
      await page.locator('#authorization-plan').getByText(label, { exact: true }).waitFor();
      const help = page.getByLabel('充值授权说明');
      const note = page.getByRole('note');
      const statusLabel = page.locator('#authorization-status');
      const before = await statusLabel.boundingBox();
      assert(!(await note.isVisible()));
      if (width <= 900) {
        const target = await help.boundingBox();
        assert(target.width >= 44 && target.height >= 44);
      }
      await help.click();
      await note.waitFor();
      assert.deepEqual(await statusLabel.boundingBox(), before);
      await page.keyboard.press('Escape');
      assert(!(await note.isVisible()));
      assert(await help.evaluate(node => node === document.activeElement));
      const form = page.locator('#authorization-form');
      const textarea = page.getByLabel('目标 ChatGPT 账号授权资料');
      await textarea.fill(JSON.stringify({ user: { id: 'synthetic', email: 'local@example.test' },
        accessToken: 'only-for-offline-browser-test' }));
      assert.equal(await page.locator('#authorization-account').textContent(), '目标账号 l***@example.test');
      await page.getByRole('button', { name: '授权并提交充值' }).click();
      assert.equal(writes, 0);
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '授权并提交充值' }).click();
      await page.getByText('无法确认提交结果，请查询原请求。').waitFor();
      assert(!(await form.isVisible()));
      assert.equal(await textarea.inputValue(), '');
      await page.getByRole('button', { name: '查询进度' }).click();
      await page.getByText('已受理，等待执行。').waitFor();
      assert.equal(writes, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(source.external, []);
      await context.close();
    }
  });
