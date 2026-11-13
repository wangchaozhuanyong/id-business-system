import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('版本通知更新相关列表，保留筛选、分页和草稿；心跳与相同版本不重读', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.commerce.data.customers.forEach((row, index) => { row.name = `stream 客户 ${index}`; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { localFixtures: fixture, changeEvents: true,
    actor: { id: 'synthetic-admin', name: '合成管理员', role: 'admin' } });
  await context.addInitScript(versions => {
    const original = window.fetch.bind(window);
    window.changeVersions = versions;
    window.streamConnections = 0;
    window.bootIdentity = crypto.randomUUID();
    const frame = (type, versions) => `event: ${type}\r\ndata: ${JSON.stringify({ schema: 1, versions })}\r\n\r\n`;
    window.emitRevision = (versions, type = 'change') => {
      Object.assign(window.changeVersions, versions);
      if (window.changeController) {
        const bytes = new TextEncoder().encode(frame(type, versions));
        // Split CRLF across chunks to exercise real streaming boundaries.
        window.changeController.enqueue(bytes.slice(0, bytes.length - 1));
        window.changeController.enqueue(bytes.slice(-1));
      }
    };
    window.emitHeartbeat = () => window.changeController.enqueue(new TextEncoder().encode(': heartbeat\r\n\r\n'));
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
      window.streamConnections++;
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.changeController = controller;
        controller.enqueue(new TextEncoder().encode(frame('snapshot', window.changeVersions)));
        options.signal.addEventListener('abort', () => {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    };
  }, { inventory: String(fixture.inventory.version), commerce: String(fixture.commerce.version) });
  const reads = { inventory: 0, commerce: 0, appleBalance: 0, 'renewal-sidebar': 0 }, writes = [], errors = [];
  await context.route('**/api/local/**', route => {
    const request = route.request(), resource = new URL(request.url()).pathname.split('/').at(-1);
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(resource);
      return route.fulfill({ status: 503, json: { error: '禁止业务写入' } });
    }
    if (resource in reads) {
      reads[resource]++;
      return route.fulfill({ json: resource === 'renewal-sidebar' ? { count: 2, nextAt: null } : fixture[resource] });
    }
    return route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const emit = versions => page.evaluate(versions => window.emitRevision(versions), versions);
  const idle = () => page.waitForFunction(() => {
    const state = window.IDChangeSync?.status();
    return state?.connected && state.snapshots > 0 && !state.refreshing && !state.pending;
  });
  await page.goto(origin + '/#/settings/information');
  await idle();
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.renewalReminderCount() === 2);
  assert.deepEqual(reads, { inventory: 0, commerce: 0, appleBalance: 0, 'renewal-sidebar': 1 });
  fixture.inventory.version++;
  fixture.commerce.version++;
  await emit({ inventory: String(fixture.inventory.version), commerce: String(fixture.commerce.version) });
  await idle();
  assert.equal(reads.inventory + reads.commerce + reads.appleBalance, 0);
  assert.equal(reads['renewal-sidebar'], 2, '提醒使用单次摘要读取');
  await go('accounts/gpt');
  await page.locator('#main [data-action="inventory-more"]').first().waitFor();
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.listOrders().length > 0);
  await idle();
  assert.equal(reads.inventory, 1, '回到共享业务页只补读一次库存');
  assert.equal(reads.commerce, 1, '回到共享业务页只补读一次订单');
  const boot = await page.evaluate(() => window.bootIdentity);
  const baseline = { ...reads };
  const seed = fixture.inventory.data.accounts.find(row => row.type === 'gpt');
  fixture.inventory.data.accounts.unshift({ ...seed, id: 'stream-added-account', email: 'stream-added@example.test' });
  fixture.inventory.version++;
  await emit({ inventory: String(fixture.inventory.version) });
  await page.locator('tr[data-row-id="stream-added-account"]').waitFor();
  await idle();
  assert.equal(reads.inventory, baseline.inventory + 1);
  assert.equal(reads.commerce, baseline.commerce, '库存变化不重读订单');
  const stableReads = { ...reads };
  await page.evaluate(version => {
    window.emitHeartbeat(); window.emitHeartbeat();
    window.emitRevision({ inventory: version }); window.emitRevision({ inventory: version });
  }, String(fixture.inventory.version));
  await settle();
  assert.deepEqual(reads, stableReads);

  // Account lifecycle summaries are derived from orders even if the stock
  // document itself is unchanged.
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(version => window.IDLocalData.pendingChangeVersions(['commerce']).commerce === undefined, String(fixture.commerce.version));
  await idle();
  assert.equal(reads.inventory, stableReads.inventory + 1, '订单变化同步当前库存页的使用摘要');
  assert.equal(reads.commerce, stableReads.commerce + 1);

  await go('customers/list');
  await page.locator('#commerce-search').fill('stream');
  await page.locator('#main .pagination button[data-page="2"]:not([aria-label])').click();
  const customer = fixture.commerce.data.customers[0];
  fixture.commerce.data.customers.push({ ...customer, id: 'stream-new-customer', name: 'stream 新客户' });
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.getCustomers().some(row => row.id === 'stream-new-customer'));
  await idle();
  assert.equal(await page.locator('#commerce-search').inputValue(), 'stream');
  assert.equal(await page.evaluate(() => window.IDDesignAPI.state.page), 2);

  await go('workspace/order/gpt');
  await page.locator('#commerce-email').fill('unsaved-stream-draft@example.test');
  const beforeDraft = reads.commerce;
  fixture.commerce.data.customers.push({ ...customer, id: 'stream-during-edit', name: 'stream 编辑期间新客户' });
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.getCustomers().some(row => row.id === 'stream-during-edit'));
  await idle();
  assert.equal(reads.commerce, beforeDraft + 1, '编辑期间继续更新旁边记录，不重建输入表单');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'unsaved-stream-draft@example.test');
  await go('orders/gpt');
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.getCustomers().some(row => row.id === 'stream-during-edit'));
  await idle();
  await go('workspace/order/gpt');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'unsaved-stream-draft@example.test');
  await go('customers/list');

  await page.evaluate(id => window.IDDesignModules.find(module => module.id === 'commerce')
    .onClick('commerce-contact-edit', { dataset: { id, kind: 'customer' } }), customer.id);
  const editor = page.locator('#drawer[open] #commerce-contact-form');
  await editor.locator('#commerce-contact-name').fill('本人尚未保存的姓名');
  const originalVersion = await editor.locator('[name="commerce-version"]').inputValue();
  customer.version = Number(customer.version || 1) + 1;
  customer.name = '其他员工已保存的姓名';
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(({ id, version }) => window.IDDesignAPI.modules.commerce.getCustomers()
    .some(row => row.id === id && row.version === version), { id: customer.id, version: customer.version });
  await idle();
  assert.equal(await editor.locator('#commerce-contact-name').inputValue(), '本人尚未保存的姓名');
  assert.equal(await editor.locator('[name="commerce-version"]').inputValue(), originalVersion,
    '推送不能把旧表单的原版本自动升级');
  await editor.evaluate(form => form.requestSubmit());
  await page.getByText('资料已发生变化，请核对原版本再保存', { exact: true }).waitFor();
  assert.deepEqual(writes, [], '旧表单提交在冲突时保留输入，不发送覆盖写入');
  await editor.getByText('查看填写差异', { exact: true }).click();
  assert(await editor.getByText('其他员工已保存的姓名', { exact: true }).isVisible());
  assert(await editor.getByText('本人尚未保存的姓名', { exact: true }).isVisible());
  for (const width of [390, 1440]) for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle();
    const layout = await editor.locator('[data-contact-conflict]').evaluate(notice => {
      const box = notice.getBoundingClientRect();
      return { overflow: notice.scrollWidth > notice.clientWidth + 1,
        clipped: [...notice.querySelectorAll('button,summary')].some(node => {
          const rect = node.getBoundingClientRect();
          return rect.left < box.left - 1 || rect.right > box.right + 1;
        }) };
    });
    assert.deepEqual(layout, { overflow: false, clipped: false }, `冲突提示 ${width}/${theme}`);
    assert.equal(await editor.locator('#commerce-contact-name').inputValue(), '本人尚未保存的姓名');
  }
  await editor.getByRole('button', { name: '读取最新资料重新编辑', exact: true }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await editor.locator('#commerce-contact-name').inputValue(), '本人尚未保存的姓名');
  assert.equal(await editor.locator('[name="commerce-version"]').inputValue(), originalVersion);
  await editor.getByRole('button', { name: '读取最新资料重新编辑', exact: true }).click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.waitForFunction(name => document.querySelector('#commerce-contact-name')?.value === name, customer.name);
  assert.equal(await editor.locator('[name="commerce-version"]').inputValue(), String(customer.version));
  assert.deepEqual(writes, [], '读取最新资料不会自动提交或覆盖业务');
  await page.evaluate(() => document.querySelector('#drawer').close());

  const beforeReconnect = { ...reads };
  fixture.inventory.data.accounts.unshift({ ...seed, id: 'stream-reconnected-account', email: 'reconnected@example.test' });
  fixture.inventory.version++;
  await page.evaluate(version => {
    window.changeController.close(); window.changeController = null;
    window.changeVersions.inventory = version;
  }, String(fixture.inventory.version));
  await page.waitForFunction(() => window.streamConnections === 2);
  await page.waitForFunction(() => window.IDDesignAPI.modules.inventory.getAsset('stream-reconnected-account'));
  await idle();
  assert.equal(reads.inventory, beforeReconnect.inventory + 1);
  assert.equal(reads.commerce, beforeReconnect.commerce);
  assert.equal(await page.evaluate(() => window.bootIdentity), boot, '不刷新整个网页');
  for (const width of [390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await go('accounts/gpt');
    assert(await page.locator('tr[data-row-id="stream-reconnected-account"]').isVisible());
    const id = `stream-mobile-${width}-${dark}`;
    fixture.inventory.data.accounts.unshift({ ...seed, id, email: `${id}@example.test` });
    fixture.inventory.version++;
    await emit({ inventory: String(fixture.inventory.version) });
    await page.locator(`tr[data-row-id="${id}"]`).waitFor();
    await idle();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  const clockStart = await page.evaluate(() => Date.now());
  await page.clock.install({ time: new Date(clockStart) });
  await page.clock.pauseAt(new Date(clockStart + 1000));
  await page.evaluate(() => window.emitHeartbeat());
  const healthyReads = { ...reads };
  for (let index = 0; index < 4; index++) {
    await page.clock.runFor(20_000);
    await page.evaluate(() => window.emitHeartbeat());
  }
  assert.deepEqual(reads, healthyReads, '健康连接的心跳不触发业务读取');
  fixture.inventory.data.accounts.unshift({ ...seed, id: 'silent-recovery', email: 'silent-recovery@example.test' });
  fixture.inventory.version++;
  await page.evaluate(version => { window.changeVersions.inventory = version; }, String(fixture.inventory.version));
  await page.clock.runFor(61_000);
  assert.equal(await page.evaluate(() => window.streamConnections), 3, '静默断流应重连以补齐遗漏版本');
  await page.locator('tr[data-row-id="silent-recovery"]').waitFor();
  await idle();
  assert.equal(reads.inventory, healthyReads.inventory + 1);
  assert.equal(reads.commerce, healthyReads.commerce);
  await page.evaluate(() => window.changeController.close());
  await page.waitForFunction(() => !window.IDChangeSync.status().connected);
  await page.clock.runFor(2000);
  assert.equal(await page.evaluate(() => window.streamConnections), 4);
  await page.evaluate(() => window.changeController.close());
  await page.waitForFunction(() => !window.IDChangeSync.status().connected);
  await page.clock.runFor(2000);
  assert.equal(await page.evaluate(() => window.streamConnections), 4, '短连接反复失败必须递增退避');
  await page.clock.runFor(2000);
  assert.equal(await page.evaluate(() => window.streamConnections), 5);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.IDChangeSync.stop());
});

test('数据恢复后空闲页自动重载，正在填写的旧页保留输入并停止提交', { timeout: 30_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const original = fixture.inventory.data.accounts.find(row => row.type === 'gpt');
  const previous = structuredClone(fixture.inventory);
  previous.version = 12;
  previous.data.accounts = [{ ...original, id: 'before-source', email: 'before-source@example.test' }];
  fixture.inventory = previous;
  let source = 'before-source', posts = 0;
  const traffic = await interceptDesign(context, { localFixtures: fixture, changeEvents: true, skipRechargeAssets: true });
  const index = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  await context.route(origin + '/', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
    body: index.replace('<head>', `<head><meta name="id-local-data-events" content="enabled"><meta name="id-data-source" content="${source}">`)
      .replace('    <script src="./prototype.js', '    <script src="/local-data.js" defer></script><script src="/toolbox-local.js" defer></script>\n    <script src="./prototype.js') }));
  await context.route('**/api/local/inventory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.inventory });
    posts++;
    return route.fulfill({ status: 409, json: { code: 'DATA_SOURCE_CHANGED' } });
  });
  await context.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return fetchOriginal(input, options);
      const source = document.querySelector('meta[name="id-data-source"]').content;
      window.bootIdentity = crypto.randomUUID();
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.pushSnapshot = (source, version) => controller.enqueue(new TextEncoder().encode(
          'event: snapshot\ndata: ' + JSON.stringify({ schema: 1, source, versions: { inventory: String(version) } }) + '\n\n'));
        window.pushSnapshot(source, source === 'before-source' ? 12 : 3);
        options.signal.addEventListener('abort', () => {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    };
  });
  const idle = await context.newPage(), editing = await context.newPage();
  const errors = [];
  for (const page of [idle, editing]) {
    page.setDefaultTimeout(6000);
    page.on('pageerror', issue => errors.push(issue.message));
  }
  await idle.goto(origin + '/#/accounts/gpt');
  await editing.goto(origin + '/#/workspace/order/gpt');
  await idle.locator('tr[data-row-id="before-source"]').waitFor();
  const idleBoot = await idle.evaluate(() => window.bootIdentity);
  const draft = editing.locator('#commerce-email');
  await draft.fill('retained-draft@example.test');
  source = 'restored-source';
  fixture.inventory = { ...previous, version: 3, data: {
    ...previous.data, accounts: [{ ...original, id: 'restored-account', email: 'restored@example.test' }]
  } };
  await editing.evaluate(() => window.pushSnapshot('restored-source', 3));
  await editing.getByText(/业务数据来源已变化，当前填写已保留/).waitFor();
  assert.equal(await draft.inputValue(), 'retained-draft@example.test');
  assert.equal(await editing.evaluate(async () => window.IDLocalData.save('inventory', 12, {}).then(
    () => '', error => error.code)), 'DATA_SOURCE_CHANGED');
  assert.equal(posts, 0);
  await idle.evaluate(() => window.pushSnapshot('restored-source', 3));
  await idle.locator('tr[data-row-id="restored-account"]').waitFor();
  assert.notEqual(await idle.evaluate(() => window.bootIdentity), idleBoot);
  assert.equal(await idle.locator('tr[data-row-id="before-source"]').count(), 0);
  await editing.getByRole('button', { name: '数据已恢复 · 重新加载' }).click();
  await editing.waitForFunction(() => document.querySelector('meta[name="id-data-source"]').content === 'restored-source' &&
    window.IDChangeSync?.status().connected);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});
