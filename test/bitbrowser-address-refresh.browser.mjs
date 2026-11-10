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
    const state = { rows: [], version: 6, invalidations: 0, failRead: false, failWrite: false, holdRead: null, reads: 0, writes: [] };
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
    await frame.locator('#bit-window-name').fill('不可清空的登录草稿');
    const total = count => panel.locator('[data-pagination][data-total="' + count + '"]').waitFor();
    const settled = () => page.waitForFunction(() => !document.querySelector('#bit-address-generate-button').disabled);
    const assertClean = async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(network.external, []);
      assert.deepEqual(network.unavailable, []);
      assert.equal(await frame.locator('#bit-window-name').inputValue(), '不可清空的登录草稿');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    return { page, panel, pager, state, total, settled, assertClean };
  }

  for (const width of [1440, 390]) await t.test(width + 'px 生成、导入、复制标记与删除均只写一次，通知打断后自动显示结果', async t => {
    const { page, panel, state, total, settled, assertClean } = await setup(t, width);
    if (width === 1440) await page.locator('#theme-toggle').click();
    state.invalidations = 1;
    await panel.locator('#bit-address-generate-button').click();
    await total(10);
    await settled();
    await panel.getByText('已生成 10 条账单地址，付款前请核对资料。', { exact: true }).waitFor();
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
    const { page, panel, state, total, settled, assertClean } = await setup(t);
    state.invalidations = 3;
    await panel.locator('#bit-address-generate-button').click();
    await panel.getByText(/已生成 10 条.*地址列表持续更新.*请点击刷新重试/).waitFor();
    await settled();
    assert.equal(state.reads, 4, '自动读取最多三次，避免持续通知造成无限请求');
    assert.equal(state.writes.length, 1);
    await total(0);
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await total(10);
    assert.equal(state.writes.length, 1);

    state.failRead = true;
    await panel.locator('#bit-address-generate-button').click();
    await panel.getByText(/已生成 10 条.*合成读取失败.*请点击刷新重试/).waitFor();
    await settled();
    assert.equal(state.rows.length, 20);
    assert.equal(state.writes.length, 2);
    await total(10);
    state.failRead = false;
    await panel.getByRole('button', { name: '刷新', exact: true }).click();
    await total(20);
    assert.equal(state.writes.length, 2);

    state.failWrite = true;
    await panel.locator('#bit-address-generate-button').click();
    await panel.getByText('合成保存失败', { exact: true }).waitFor();
    await settled();
    assert.equal(state.rows.length, 20);
    assert.equal(await panel.locator('#bit-address-feedback').textContent(), '合成保存失败');
    await assertClean();
  });

  await t.test('会话缓存被清理后不重新发起受保护读取，也不恢复迟到资料', async t => {
    const { page, panel, state, total, settled, assertClean } = await setup(t);
    let resolveStarted, release;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const done = new Promise(resolve => { release = resolve; });
    state.holdRead = { started: resolveStarted, done };
    await panel.locator('#bit-address-generate-button').click();
    await started;
    await page.evaluate(() => window.IDLocalData.queries.clear());
    release();
    await settled();
    await total(0);
    assert.equal(state.reads, 2);
    assert.equal(state.writes.length, 1);
    assert.equal(await page.evaluate(() => window.IDLocalData.queries.peek(
      'bitbrowser-addresses', { page: 1, pageSize: 10, keyword: '', status: 'unused' }
    )), undefined);
    await assertClean();
  });

  await t.test('等待刷新时切换页签或暂离保留页面，不覆盖当前查看状态与草稿', async t => {
    const { page, panel, state, total, settled, assertClean } = await setup(t);
    let resolveStarted, release;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const done = new Promise(resolve => { release = resolve; });
    state.holdRead = { started: resolveStarted, done };
    await panel.locator('#bit-address-generate-button').click();
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
    await panel.locator('#bit-address-generate-button').click();
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
    // The BitBrowser host retains its connected DOM while another route is open.
    // Its completed write receipt remains valid when returning to this same view.
    assert.equal(await panel.locator('#bit-address-feedback').textContent(), '已生成 10 条账单地址，付款前请核对资料。');
    await assertClean();
  });
});
