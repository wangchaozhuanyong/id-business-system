import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  generateBitBrowserAddresses, importBitBrowserAddresses, updateBitBrowserAddress,
  deleteUsedBitBrowserAddresses, listBitBrowserAddresses
} from '../server/bitbrowser-addresses.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('地址保存后的版本通知不丢失刷新，不重复写入或覆盖新的查看状态', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  async function setup(t, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    t.after(() => context.close());
    const network = await interceptDesign(context, {
      actor: { id: 'address-refresh-qa', name: '离线诊断员', role: 'super' },
      localFixtures: {}, changeEvents: true
    });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      let controller;
      const emit = (type, version) => controller.enqueue(new TextEncoder().encode(
        'event: ' + type + '\ndata: ' + JSON.stringify({ schema: 1, versions: { 'bitbrowser-addresses': version } }) + '\n\n'
      ));
      window.emitAddressVersion = version => emit('change', version);
      window.addressCopies = 0;
      Object.defineProperty(navigator, 'clipboard', { value: {
        async writeText() { window.addressCopies++; }
      } });
      window.fetch = (input, options) => {
        if (new URL(String(input), location.href).pathname !== '/api/local/change-events')
          return original(input, options);
        return Promise.resolve(new Response(new ReadableStream({ start(stream) {
          controller = stream;
          emit('snapshot', '6');
          options.signal.addEventListener('abort', () => {
            try { stream.error(new DOMException('aborted', 'AbortError')); } catch {}
          }, { once: true });
        } }), { headers: { 'content-type': 'text/event-stream' } }));
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const state = { rows: [], version: 6, invalidations: 0, failRead: false, failWrite: false, holdRead: null, holdWrite: null, reads: 0, writes: [] };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/local/bitbrowser-addresses*', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        state.reads++;
        const snapshot = {
          ...listBitBrowserAddresses(state.rows, new URL(req.url()).searchParams),
          version: state.version
        };
        if (state.holdRead) {
          const hold = state.holdRead;
          state.holdRead = null;
          hold.started();
          await hold.done;
        }
        if (state.invalidations) {
          state.invalidations--;
          state.version++;
          const version = String(state.version);
          await page.evaluate(version => window.emitAddressVersion(version), version);
          await page.waitForFunction(version =>
            window.IDLocalData.pendingChangeVersions(['bitbrowser-addresses'])['bitbrowser-addresses'] === version, version);
        }
        return state.failRead
          ? route.fulfill({ status: 503, json: { error: '合成读取失败' } })
          : route.fulfill({ json: snapshot });
      }
      assert.equal(req.method(), 'PUT');
      const body = req.postDataJSON();
      state.writes.push(body);
      if (state.holdWrite) {
        const hold = state.holdWrite;
        state.holdWrite = null;
        hold.started();
        await hold.done;
      }
      if (state.failWrite) return route.fulfill({ status: 503, json: { error: '合成保存失败' } });
      const now = '2026-11-10T08:19:00Z';
      const change = Object.hasOwn(body, 'count') ? generateBitBrowserAddresses(state.rows, body.count, now)
        : Object.hasOwn(body, 'streets') ? importBitBrowserAddresses(state.rows, body.streets, now)
          : body.deleteUsed ? deleteUsedBitBrowserAddresses(state.rows, body, state.version)
            : updateBitBrowserAddress(state.rows, body, now);
      state.rows = change.rows;
      state.version++;
      return route.fulfill({ json: change.result });
    });
    await page.goto(origin + '/#/recharge/start');
    const panel = page.locator('#bit-addresses-panel');
    const pager = panel.locator('[data-pagination="bitbrowser-addresses"]');
    await pager.locator('[data-pagination-size]').waitFor();
    await page.waitForFunction(() => window.IDChangeSync?.status().snapshots > 0);
    const frame = page.frameLocator('.recharge-integration__frame--bit-local');
    const email = 'address-refresh@example.test';
    await frame.locator('#bit-authorization-json').fill(JSON.stringify({
      sessionToken: 'synthetic-session', user: { id: 'user-fixture', email }, account: { id: 'account-fixture' }
    }));
    const total = count => panel.locator('[data-pagination][data-total="' + count + '"]').waitFor();
    const settled = () => page.waitForFunction(() => !document.querySelector('#bit-address-generate-open').disabled);
    const openGenerator = async () => {
      await panel.locator('#bit-address-generate-open').click();
      const drawer = page.getByRole('dialog', { name: '生成地址', exact: true });
      await drawer.waitFor();
      return drawer;
    };
    const generate = async () => {
      const drawer = await openGenerator();
      await drawer.locator('#bit-address-generate-button').click();
      return drawer;
    };
    const assertClean = async (expectedEmail = email) => {
      assert.deepEqual(errors, []);
      assert.deepEqual(network.external, []);
      assert.deepEqual(network.unavailable, []);
      assert.equal(await frame.locator('#bit-window-name').inputValue(), expectedEmail);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    return { page, panel, pager, state, total, settled, openGenerator, generate, assertClean };
  }

  for (const width of [1440, 390]) await t.test(width + 'px 生成、导入、复制标记与删除均只写一次，通知打断后自动显示结果', async t => {
    const { page, panel, state, total, settled, openGenerator, assertClean } = await setup(t, width);
    if (width === 1440) await page.locator('#theme-toggle').click();
    assert.equal(await panel.locator('#bit-address-generate-count').count(), 0);
    const drawer = await openGenerator();
    const count = drawer.getByLabel('生成数量');
    const submit = drawer.locator('#bit-address-generate-button');
    assert.equal(await count.inputValue(), '10');
    await count.fill('101');
    await submit.click();
    await drawer.getByText('每次可生成 1 至 100 条地址', { exact: true }).waitFor();
    assert.equal(state.writes.length, 0);
    await count.fill('8');
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await openGenerator();
    assert.equal(await count.inputValue(), '8', '关闭重开保留生成数量');
    await count.fill('10');

    state.invalidations = 1;
    let writeStarted, releaseWrite;
    const started = new Promise(resolve => { writeStarted = resolve; });
    const done = new Promise(resolve => { releaseWrite = resolve; });
    state.holdWrite = { started: writeStarted, done };
    try {
      await submit.click();
      await started;
      assert.equal(await submit.innerText(), '生成中…');
      assert.equal(await submit.isDisabled(), true);
      assert.equal(await drawer.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert(await drawer.isVisible(), '保存期间 Escape 不关闭抽屉');
      if (width === 1440) {
        await page.mouse.click(10, 100);
        assert(await drawer.isVisible(), '保存期间点击背景不关闭抽屉');
      }
    } finally {
      releaseWrite();
    }
    await drawer.waitFor({ state: 'hidden' });
    await total(10);
    await settled();
    await page.locator('#toast').getByText('已成功生成 10 条地址', { exact: true }).waitFor();
    assert.equal(state.writes.length, 1);
    assert.equal(state.rows.length, 10);
    assert.equal(state.reads, 3, '初次读取加两次保存后读取，不重复生成');

    state.invalidations = 1;
    await panel.locator('#bit-address-file').setInputFiles({
      name: 'offline-address.txt', mimeType: 'text/plain', buffer: Buffer.from('123 Synthetic Import St')
    });
    await panel.locator('#bit-address-import-button').click();
    await total(11);
    await settled();
    await panel.getByText('成功导入 1 条，重复 0 条，未通过 0 条。', { exact: true }).waitFor();
    assert.equal(state.writes.length, 2);

    state.invalidations = 1;
    await panel.locator('[data-action="bit-address-copy"]').first().click();
    await total(10);
    await settled();
    await panel.getByText('地址已复制并移入已使用。', { exact: true }).waitFor();
    assert.equal(state.writes.length, 3);
    assert.equal(await page.evaluate(() => window.addressCopies), 1);
    assert.equal(state.rows.filter(row => row.status === 'used').length, 1);

    await panel.locator('#bit-address-tab-used').click();
    await total(1);
    state.invalidations = 1;
    await panel.getByRole('button', { name: '一键删除已使用', exact: true }).click();
    await page.getByRole('dialog', { name: '删除已使用地址' }).getByRole('button', { name: '确认删除' }).click();
    await total(0);
    await settled();
    await panel.getByText('已删除 1 条已使用地址。', { exact: true }).waitFor();
    assert.equal(state.writes.length, 4);
    assert.equal(state.rows.length, 10);
    await assertClean();
  });

  await t.test('持续变更或读失败明确显示已保存，保留旧列表并允许手动读取，不重发写操作', async t => {
    const { panel, state, total, settled, generate, assertClean } = await setup(t);
    state.invalidations = 3;
    await generate();
    await panel.getByText(/已成功生成 10 条地址.*地址列表持续更新.*请点击刷新重试/).waitFor();
    await settled();
    assert.equal(state.reads, 4, '自动读取最多三次，避免持续通知造成无限请求');
    assert.equal(state.writes.length, 1);
    await total(0);
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await total(10);
    assert.equal(state.writes.length, 1);

    state.failRead = true;
    await generate();
    await panel.getByText(/已成功生成 10 条地址.*合成读取失败.*请点击刷新重试/).waitFor();
    await settled();
    assert.equal(state.rows.length, 20);
    assert.equal(state.writes.length, 2);
    await total(10);
    state.failRead = false;
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await total(20);
    assert.equal(state.writes.length, 2);

    state.failWrite = true;
    const drawer = await generate();
    await drawer.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
    await settled();
    assert.equal(await drawer.getByLabel('生成数量').inputValue(), '10');
    assert.equal(await drawer.locator('#bit-address-generate-button').isEnabled(), true);
    assert.equal(state.rows.length, 20);
    assert.equal(await panel.locator('#bit-address-feedback').textContent(), '合成保存失败');
    state.failWrite = false;
    await drawer.locator('#bit-address-generate-button').click();
    await drawer.waitFor({ state: 'hidden' });
    await total(30);
    assert.equal(state.writes.length, 4, '重试只提交一次');
    await assertClean();
  });

  await t.test('会话缓存被清理后不重新发起受保护读取，也不恢复迟到资料', async t => {
    const { page, state, total, settled, generate, assertClean } = await setup(t);
    let resolveStarted, release;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const done = new Promise(resolve => { release = resolve; });
    state.holdRead = { started: resolveStarted, done };
    await generate();
    await started;
    await page.evaluate(() => window.IDLocalData.queries.clear());
    release();
    await settled();
    await total(0);
    assert.equal(state.reads, 2);
    assert.equal(state.writes.length, 1);
    assert.equal(await page.evaluate(() => window.IDLocalData.queries.peek(
      'bitbrowser-addresses', { page: 1, pageSize: 20, keyword: '', status: 'unused' }
    )), undefined);
    await assertClean();
  });

  await t.test('等待刷新时切换页签或暂离保留页面，不覆盖当前查看状态与草稿', async t => {
    const { page, panel, state, total, settled, generate, assertClean } = await setup(t);
    const connectionName = page.frameLocator('.recharge-integration__frame--bit-local').locator('#bit-connection-name');
    await connectionName.fill('地址联动测试连接');
    let resolveStarted, release;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const done = new Promise(resolve => { release = resolve; });
    state.holdRead = { started: resolveStarted, done };
    await generate();
    await started;
    await panel.locator('#bit-address-tab-used').click();
    await total(0);
    release();
    await settled();
    await settle(page);
    assert.equal(await panel.locator('#bit-address-tab-used').getAttribute('aria-selected'), 'true');
    assert.equal(await panel.locator('tbody tr[data-row-id]').count(), 0);
    assert.equal(state.writes.length, 1);
    assert.equal(state.reads, 3, '已被新页签替代的读取不再重试');
    await panel.locator('#bit-address-tab-unused').click();
    await total(10);

    const startedAgain = new Promise(resolve => { resolveStarted = resolve; });
    const doneAgain = new Promise(resolve => { release = resolve; });
    state.holdRead = { started: resolveStarted, done: doneAgain };
    state.invalidations = 1;
    await generate();
    await startedAgain;
    await page.evaluate(() => { location.hash = '#/customers/new'; });
    await page.locator('#commerce-contact-form').waitFor();
    release();
    await page.waitForFunction(() => !window.IDLocalData.writesPending());
    await settle(page);
    await page.evaluate(() => { location.hash = '#/recharge/start'; });
    await total(20);
    await settled();
    assert.equal(state.writes.length, 2);
    assert.equal(await panel.locator('#bit-address-feedback').textContent(), '', '成功提示不会留在地址列表里');
    assert.equal(await connectionName.inputValue(), '地址联动测试连接');
    await assertClean('');
  });
});
