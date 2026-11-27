import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createManualRemoteAccess } from '../server/manual-remote-access.mjs';

const client = `export default class RFB extends EventTarget {
  constructor() {
    super();
    window.fixtureDisconnect = () => this.disconnect();
    setTimeout(() => this.dispatchEvent(new Event('connect')), 0);
  }
  disconnect() { this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } })); }
}`;

test('workspace close toolbar confirms the consequence, retains errors and blocks duplicate clicks', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const remote = createManualRemoteAccess({ socketPath: '/unused-ui-fixture.sock', getActor: () => ({ id: 'tester', role: 'admin' }),
    store: { resolveManualWorkspace: () => ({ key: 'manual-v1-' + '1'.repeat(64) }) } });
  const server = createServer(remote.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { remote.close(); server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/manual-workspaces/record-1/';
  const browser = await chromium.launch(process.env.ID_MANUAL_QA_CHROME ? { executablePath: process.env.ID_MANUAL_QA_CHROME } : {});
  t.after(() => browser.close());
  for (const width of [1440, 390, 320]) await t.test(width + 'px', async t => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 500 });
    t.after(() => context.close());
    let stopCalls = 0, stopResult = 503, pending, started;
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === base) return route.continue();
      if (url === base + 'client/core/rfb.js') return route.fulfill({ contentType: 'text/javascript', body: client });
      if (url === base + 'open' || url === base + 'connected') return route.fulfill({ status: 204 });
      if (url === base + 'stop') {
        assert.equal(route.request().method(), 'POST');
        stopCalls++;
        started?.();
        await pending;
        return route.fulfill({ status: stopResult });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    let confirm = false, dialogs = 0;
    const dialogMessages = [];
    page.on('dialog', async dialog => {
      dialogs++;
      dialogMessages.push(dialog.message());
      if (confirm) await dialog.accept(); else await dialog.dismiss();
    });
    await page.goto(base);
    const toggle = page.locator('#connect'), stop = page.locator('#stop');
    assert.equal(await stop.isHidden(), true);
    await toggle.click();
    await stop.waitFor({ state: 'visible' });
    const box = await stop.boundingBox();
    assert(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
    if (width < 500) {
      const positions = await page.locator('header').evaluate(header => {
        const rects = [...header.children].map(el => el.getBoundingClientRect());
        return rects.map(r => ({ x: r.x, right: r.right, y: r.y, center: (r.y + r.bottom) / 2, height: r.height }));
      });
      const [heading, status, connect, scale, keyboard, close] = positions;
      assert(Math.abs(heading.center - connect.center) <= 1 && Math.abs(status.center - connect.center) <= 1);
      assert(scale.y === keyboard.y && keyboard.y === close.y && connect.y + connect.height <= close.y);
      assert(scale.right <= keyboard.x && keyboard.right <= close.x);
      assert(positions.every(r => r.x >= 0 && r.right <= width));
      assert([connect, scale, keyboard, close].every(r => r.height >= 44 && r.right - r.x >= 44));
    }
    await stop.click();
    assert.equal(dialogs, 1);
    assert.match(dialogMessages[0], /其他设备.*断开.*下次连接.*恢复/);
    assert.equal(stopCalls, 0);
    confirm = true;
    await stop.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('未能确认'));
    assert.equal(await stop.isEnabled(), true);
    if (width < 500) {
      const fits = await page.locator('#status').evaluate(el =>
        el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight && el.getBoundingClientRect().right <= innerWidth);
      assert(fits, '错误信息可换行，不被控件裁切');
    }
    assert.equal(await toggle.textContent(), '断开连接');
    await toggle.click();
    await stop.waitFor({ state: 'hidden' });
    assert.equal(stopCalls, 1, 'disconnect is independent of saving and closing');
    await toggle.click();
    await stop.waitFor({ state: 'visible' });
    let release;
    pending = new Promise(done => { release = done; });
    const began = new Promise(done => { started = done; });
    stopResult = 204;
    await stop.click();
    await began;
    assert.equal(await stop.isDisabled(), true);
    await stop.dispatchEvent('click');
    assert.equal(dialogs, 3);
    assert.equal(stopCalls, 2);
    await page.evaluate(() => window.fixtureDisconnect());
    await stop.waitFor({ state: 'hidden' });
    assert.match(await page.locator('#status').textContent(), /正在保存/);
    release();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('工作区已关闭'));
    assert.equal(await toggle.textContent(), '连接工作区');
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await stop.isHidden(), true);
  });
});
