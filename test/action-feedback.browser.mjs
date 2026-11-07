import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

test('操作反馈可见于抽屉和确认框之上，复制与异步结果按真实完成状态显示', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL, headless: true });
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || path.join(root, '.runtime/action-feedback');
  await mkdir(output, { recursive: true });
  const before = process.env.ID_FEEDBACK_QA_BEFORE;
  const results = [];
  const paint = page => page.locator('#toast').evaluate(toast => {
    const r = toast.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { visible: r.width > 0 && r.height > 0, onTop: top === toast || toast.contains(top),
      accessible: !toast.closest('[inert]') && (!document.querySelector('dialog:modal') || Boolean(toast.closest('dialog:modal'))),
      host: toast.parentElement.id || 'body', left: r.left, right: r.right, top: r.top, height: r.height,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  if (before) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
    await interceptDesign(context, { beforeDirectory: before });
    await context.route(origin + '/', route => readFile(path.join(before, 'index.html')).then(body => route.fulfill({ body, contentType: 'text/html' })));
    const page = await context.newPage();
    await page.goto(origin + '/');
    await page.evaluate(() => window.IDDesignAPI.openDrawer('复制反馈检查', '', window.IDDesignAPI.button('复制', 'copy-value', '', '', 'data-value="SYNTHETIC-COPY"')));
    await page.locator('#drawer [data-action="copy-value"]').click();
    await page.locator('#toast:not([hidden])').waitFor();
    const baseline = await paint(page);
    assert.equal(baseline.onTop, false, '复现：旧提示被模态抽屉覆盖');
    await page.screenshot({ path: path.join(output, 'before-drawer-copy.png') });
    results.push({ baseline });
    await context.close();
  }
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async value => { if (window.denyClipboard) throw new Error('denied'); window.copiedValue = value; } }
    }));
    const fixture = { toolbox: { version: 1, data: { shortcuts: [], phrases: [
      { id: 'feedback-phrase', title: '反馈验收话术', text: 'SYNTHETIC-PHRASE', deleted: false }
    ] } } };
    const intercepted = await interceptDesign(context, { localFixtures: fixture });
    const writes = [], errors = [];
    let auditMode = 'normal', reads = 0, release, started;
    let ready;
    await context.route(origin + '/api/local/**', async route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); }
      if (new URL(route.request().url()).pathname !== '/api/local/audit') return route.fallback();
      reads++;
      if (auditMode === 'held') { started(); await new Promise(resolve => { release = resolve; }); }
      return auditMode === 'failed' ? route.fulfill({ status: 503, json: { error: '合成读取失败' } }) : route.fulfill({ json: [] });
    });
    t.after(() => release?.());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/settings/audit');
    await page.locator('[data-action="ops-audit-refresh"]').waitFor();
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    await page.locator('.topbar-tools [data-tab="话术文案"]').click();
    await page.locator('[data-action="ops-phrase-copy"]').click();
    await page.locator('#toast[data-kind="success"]:not([hidden])').waitFor();
    assert.equal(await page.evaluate(() => window.copiedValue), 'SYNTHETIC-PHRASE');
    assert.match(await page.locator('#toast').innerText(), /话术已复制/);
    const drawer = await paint(page);
    assert(drawer.onTop && drawer.accessible && !drawer.overflow);
    assert(drawer.left >= 0 && drawer.right <= width && drawer.top >= 0);
    assert.equal(drawer.host, 'drawer');
    await page.screenshot({ path: path.join(output, `copy-${width}-${theme}.png`) });
    await page.locator('[data-action="ops-phrase-copy"]').click();
    assert.equal(await page.locator('#toast').count(), 1, '连续点击复用提示，不堆叠遮挡');
    await page.evaluate(() => window.IDDesignAPI.confirmAction('反馈层级验收', '仅检查提示，不写入业务数据。', () => {}));
    await page.waitForFunction(() => document.querySelector('#toast').parentElement.id === 'confirm-dialog');
    await page.evaluate(() => window.IDDesignAPI.notify('合成错误，请重试', { kind: 'error' }));
    assert.equal(await page.locator('#toast').getAttribute('role'), 'alert');
    const confirmation = await paint(page);
    assert(confirmation.onTop && confirmation.accessible);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    assert(await page.locator('#toast').isHidden());
    await page.locator('[data-action="confirm-cancel"]').click();
    await page.locator('[data-action="ops-phrase-copy"]').click();
    await page.evaluate(() => window.IDDesignAPI.closeDrawer());
    await page.waitForFunction(() => document.querySelector('#toast').parentElement === document.body);
    assert((await paint(page)).onTop, '关闭抽屉后的成功提示仍可见');
    await page.evaluate(() => window.IDDesignAPI.openDrawer('当前表单', '', '<input aria-label="保留输入" value="草稿未修改">'));
    assert((await paint(page)).onTop, '重建抽屉不会删除正在显示的提示');
    assert.equal(await page.getByLabel('保留输入').inputValue(), '草稿未修改');
    await page.evaluate(async () => { window.denyClipboard = true; await window.IDDesignAPI.copyText('SYNTHETIC-FALLBACK'); });
    assert.match(await page.locator('#toast').innerText(), /复制失败/);
    assert.equal(await page.locator('#toast').getAttribute('data-kind'), 'error');
    assert.equal(await page.getByLabel('待复制内容').inputValue(), 'SYNTHETIC-FALLBACK');
    assert(!(await page.locator('#toast').innerText()).includes('SYNTHETIC'), '提示不包含复制的业务原文');
    await page.evaluate(() => { window.denyClipboard = false; window.IDDesignAPI.closeDrawer(); });
    await page.evaluate(() => window.IDDesignAPI.copyText(''));
    assert.equal(await page.locator('#toast').getAttribute('data-kind'), 'warning');
    await page.evaluate(() => window.IDDesignAPI.completeAction(() => {}, '资料变更已保存'));
    assert.match(await page.locator('#toast').innerText(), /资料变更已保存/);
    await page.evaluate(() => window.IDDesignAPI.completeAction(() => window.IDDesignAPI.notify('已有具体结果'), '不应重复提示'));
    assert.equal(await page.locator('[data-feedback-message]').textContent(), '已有具体结果');
    auditMode = 'held'; ready = new Promise(resolve => { started = resolve; });
    const beforeReads = reads;
    await page.locator('[data-action="ops-audit-refresh"]').click();
    await ready;
    await page.locator('#toast[data-kind="loading"]:not([hidden])').waitFor();
    await page.locator('[data-action="ops-audit-refresh"]').click();
    assert.equal(reads, beforeReads + 1, '慢读取期间重复点击不重复请求');
    auditMode = 'normal'; release();
    await page.locator('#toast[data-kind="success"]:not([hidden])').waitFor();
    assert.match(await page.locator('#toast').innerText(), /操作记录已刷新/);
    auditMode = 'failed';
    await page.locator('[data-action="ops-audit-refresh"]').click();
    await page.locator('#toast[data-kind="error"]:not([hidden])').waitFor();
    assert.match(await page.locator('#toast').innerText(), /读取失败/);
    await page.screenshot({ path: path.join(output, `error-${width}-${theme}.png`) });
    auditMode = 'held'; ready = new Promise(resolve => { started = resolve; });
    await page.locator('[data-action="ops-audit-refresh"]').click();
    await ready;
    await page.locator('#toast[data-kind="loading"]:not([hidden])').waitFor();
    await page.evaluate(() => { location.hash = '#/customers/list'; });
    await page.locator('#main[data-layout-route="customers/list"]').waitFor();
    auditMode = 'normal'; release();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await settle(page);
    assert.equal(await page.locator('#toast').isVisible(), false, '切页后的迟到读取不弹成功提示');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(intercepted.unavailable, []);
    assert.deepEqual(intercepted.external, []);
    results.push({ width, theme, drawer, confirmation, noBusinessWrites: true });
    await context.close();
  }
  await writeFile(path.join(output, 'feedback-geometry.json'), JSON.stringify(results, null, 2));
});
