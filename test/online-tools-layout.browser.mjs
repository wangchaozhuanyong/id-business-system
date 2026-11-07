import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';

test('五项在线工具恢复老版入口、页面顺序、操作及草稿', { timeout: 90_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'online-tool-layout-'));
  const authPath = join(directory, 'auth.json');
  const user = { name: '工具布局测试', email: 'tool-layout@example.test', password: randomBytes(24).toString('hex') };
  await initializeLocalAdmin(authPath, user);
  const host = await startPreview(0, { databasePath: ':memory:', authPath });
  let browser;
  t.after(async () => {
    await browser?.close();
    host.server.closeAllConnections();
    await new Promise((resolve) => host.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = new URL(host.url).origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  let analyticsCalls = 0;
  await page.route('**/api/local/tools/website-analytics?*', (route) => {
    analyticsCalls++;
    return route.fulfill({ json: { summary: null, daily: [], timeZone: 'Asia/Shanghai' } });
  });
  let firstTotp = true;
  await page.route('**/api/local/saved-totp/code', (route) => {
    const now = Date.now();
    const initial = firstTotp && route.request().postDataJSON().id === 'fixture-0';
    if (initial) firstTotp = false;
    return route.fulfill({ json: { code: initial ? '135791' : '246802', serverNow: now, expiresAt: now + (initial ? 1800 : 30_000) } });
  });
  await page.route('**/api/local/tools/website-visits/search', (route) => route.fulfill({ json: {
    items: [{ id: 'test', ipMasked: '203.0.*.*', path: '/fixture', occurredAt: '2026-11-06T08:00:00Z' }],
    page: 1, pageSize: 20, total: 1, summary: { pageViews: 1, visitors: 1 },
    daily: [{ date: '2026-11-06', metrics: { pageViews: 1, visitors: 1 } }]
  } }));
  await page.route('**/api/local/saved-totp', (route) => route.fulfill({ json: { version: 0,
    items: Array.from({ length: 24 }, (_, i) => ({ id: `fixture-${i}`, name: `验收账号 ${i + 1}` })) } }));
  await page.route('**/api/local/tools/mailbox-pool', (route) => route.fulfill({ json: { version: 0, defaultValidDays: 7,
    items: Array.from({ length: 24 }, (_, i) => ({ id: `mail-${i}`, email: `layout-${i}@example.test`, provider: 'google', active: true, expiresAt: '2026-12-01' })) } }));
  await page.goto(host.url + '#/overview');
  await page.locator('#local-auth-email').fill(user.email);
  await page.locator('#local-auth-password').fill(user.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '工具箱', exact: true }).waitFor();
  const shortcuts = [
    { id: 'shortcut-mail', name: '工作邮箱', url: 'https://mail.example.test' },
    { id: 'shortcut-docs', name: '工作文档', url: 'https://docs.example.test' }
  ];
  const phrases = [
    { id: 'phrase-b', title: 'B 话术', text: '首条验收文案', deleted: false },
    { id: 'phrase-a', title: 'A 话术', text: '第二条验收文案', deleted: false }
  ];
  const seeded = await page.request.put(origin + '/api/local/toolbox', {
    headers: { Origin: origin }, data: { version: 0, data: { shortcuts, phrases } }
  });
  assert.equal(seeded.status(), 200);
  const newer = await page.request.put(origin + '/api/local/toolbox', {
    headers: { Origin: origin }, data: { version: 1, data: { shortcuts,
      phrases: [phrases[0], { ...phrases[1], text: '修改后的验收文案' }] } }
  });
  assert.equal(newer.status(), 200);
  const drawer = page.locator('#drawer');
  const close = drawer.getByRole('button', { name: '关闭抽屉', exact: true });
  await page.getByRole('button', { name: '工具箱', exact: true }).click();
  await drawer.getByRole('tab', { name: '在线工具', exact: true }).click();
  const tiles = drawer.locator('.online-tool-open');
  assert.equal(await tiles.count(), 5);
  const positions = await tiles.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }));
  assert(positions.every((rect, i) => rect.left === positions[0].left && (!i || rect.top > positions[i - 1].top)));
  const openTool = async (name) => {
    if (await drawer.getAttribute('data-layout') === 'online-tool') await close.click();
    await drawer.locator('[data-action="tool-open"]').filter({ hasText: name }).click();
  };

  await openTool('网站监控');
  await drawer.getByText('该时间段没有访问统计', { exact: true }).waitFor();
  assert.equal(analyticsCalls, 1);
  const sections = await drawer.locator('#ops-website-analytics, #ops-website-visits, #ops-website-check').evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.deepEqual(sections, ['ops-website-analytics', 'ops-website-visits', 'ops-website-check']);
  await drawer.getByRole('button', { name: '每日统计', exact: true }).waitFor();
  assert(await drawer.getByText('独立 IP 数', { exact: true }).last().isVisible());
  await drawer.getByRole('button', { name: 'IP 明细', exact: true }).click();
  await drawer.getByText('/fixture', { exact: true }).waitFor();
  await page.locator('#ops-monitor-url').fill('https://example.test/retained');
  await page.locator('#ops-visits-sort').selectOption('oldest');

  await openTool('抖音解析');
  await page.locator('#ops-media-text').fill('https://www.douyin.com/video/123456789');
  await openTool('网站监控');
  assert.equal(await page.locator('#ops-monitor-url').inputValue(), 'https://example.test/retained');
  assert.equal(await page.locator('#ops-visits-sort').inputValue(), 'oldest');
  await openTool('抖音解析');
  await page.mouse.click(10, 300);
  await tiles.first().waitFor();
  await openTool('抖音解析');
  assert.match(await page.locator('#ops-media-text').inputValue(), /123456789/);

  await openTool('计算 2FA 验证码');
  const firstRow = drawer.locator('.guide-item').filter({ has: page.getByText('验收账号 1', { exact: true }) });
  await firstRow.getByText('135791', { exact: true }).waitFor();
  await firstRow.getByText('246802', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '下一页', exact: true }).click();
  await drawer.getByText('验收账号 9', { exact: true }).waitFor();

  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const screenshot = async (name) => { if (output) await page.screenshot({ path: join(output, name + '.png') }); };
  async function checkFrame() {
    const measurements = await drawer.evaluate((dialog) => {
      const close = dialog.querySelector('[data-action="drawer-close"]').getBoundingClientRect();
      const body = dialog.querySelector('.drawer-body');
      return { left: close.left, right: close.right, bottom: close.bottom, height: close.height,
        bodyTop: body.getBoundingClientRect().top, overflow: body.scrollWidth - body.clientWidth, width: innerWidth };
    });
    assert(measurements.left >= 0 && measurements.right <= measurements.width + 1);
    assert(measurements.bottom <= measurements.bodyTop && measurements.height >= 35);
    assert(measurements.overflow <= 1, '工具正文出现横向溢出');
    assert.equal(await drawer.locator('.drawer-footer').count(), 0);
  }
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      if (width === 1440 && theme === 'light') {
        if (await drawer.getAttribute('data-layout') === 'online-tool') await close.click();
        await screenshot('tools-launcher-desktop');
      }
      for (const [i, name] of ['计算 2FA 验证码', '网站监控', '抖音解析', '邮箱查询与邮箱池', 'Google 表格同步'].entries()) {
        await openTool(name);
        await checkFrame();
        if (width === 1440 && theme === 'light') await screenshot(`tool-${i + 1}-desktop`);
        if (width === 390 && theme === 'dark') await screenshot(`tool-${i + 1}-mobile-dark`);
      }
      await openTool('邮箱查询与邮箱池');
      await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
      const table = drawer.locator('.online-tool-mail-table');
      await table.getByText('layout-0@example.test', { exact: true }).waitFor();
      if (width === 1440 && theme === 'light') await screenshot('mailbox-pool-desktop');
      await page.locator('#ops-mailbox-filter-provider').selectOption('apple');
      await drawer.getByText('没有匹配的邮箱', { exact: true }).waitFor();
      await page.locator('#ops-mailbox-filter-provider').selectOption('');
      await drawer.getByRole('button', { name: '下一页', exact: true }).click();
      await table.getByText('layout-23@example.test', { exact: true }).waitFor();
      await drawer.getByRole('button', { name: '上一页', exact: true }).click();
      const before = await close.boundingBox();
      await drawer.locator('.drawer-body').evaluate((body) => body.scrollTop = body.scrollHeight);
      await checkFrame();
      assert.deepEqual(await close.boundingBox(), before);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTool('网站监控');
  const bodyBefore = await drawer.locator('.drawer-body').boundingBox();
  await drawer.getByLabel('查看网站监控说明', { exact: true }).click();
  await drawer.locator('.title-description:popover-open').waitFor();
  assert.deepEqual(await drawer.locator('.drawer-body').boundingBox(), bodyBefore);
  await page.keyboard.press('Escape');
  assert.equal(await drawer.locator('.title-help[open]').count(), 0);
  await close.click();
  assert.equal(await tiles.count(), 5);
  assert.equal(await drawer.getAttribute('data-layout'), 'workspace-tools');
  const nav = drawer.locator('.drawer-header').getByRole('tablist', { name: '工具分类' });
  assert.deepEqual(await nav.getByRole('tab').allTextContents(), ['话术文案', '在线工具', '个人工具']);
  assert.equal(await drawer.locator('.drawer-title-row').count(), 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      const personal = nav.getByRole('tab', { name: '个人工具', exact: true });
      await personal.click();
      await drawer.getByRole('link', { name: '打开工作邮箱', exact: true }).waitFor();
      assert.equal(await drawer.getByRole('link', { name: '打开工作邮箱', exact: true }).getAttribute('target'), '_blank');
      await checkFrameWithFooter();
      if (width === 1440 && theme === 'light') await screenshot('personal-tools-desktop');
      const phrase = nav.getByRole('tab', { name: '话术文案', exact: true });
      await phrase.click();
      await drawer.getByText('A 话术', { exact: true }).waitFor();
      await checkFrame();
      if (width === 1440 && theme === 'light') await screenshot('phrase-tools-desktop');
      if (width === 390 && theme === 'dark') await screenshot('phrase-tools-mobile-dark');
    }
  }
  async function checkFrameWithFooter() {
    const dimensions = await drawer.evaluate((node) => {
      const header = node.querySelector('.drawer-header');
      const body = node.querySelector('.drawer-body');
      return { header: header.scrollWidth - header.clientWidth, body: body.scrollWidth - body.clientWidth };
    });
    assert(dimensions.header <= 1 && dimensions.body <= 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav.getByRole('tab', { name: '话术文案', exact: true }).press('Home');
  assert.equal(await nav.getByRole('tab', { name: '个人工具', selected: true }).count(), 1);
  await drawer.getByRole('button', { name: '管理工具', exact: true }).click();
  await drawer.getByRole('button', { name: '新增网址', exact: true }).click();
  await page.locator('#shortcut-name').fill('快捷网址草稿');
  await close.click();
  assert.equal(await nav.getByRole('tab', { name: '个人工具', selected: true }).count(), 1);
  await drawer.getByRole('button', { name: '管理工具', exact: true }).click();
  await drawer.getByRole('button', { name: '新增网址', exact: true }).click();
  assert.equal(await page.locator('#shortcut-name').inputValue(), '快捷网址草稿');
  await close.click();

  await nav.getByRole('tab', { name: '话术文案', exact: true }).click();
  const titles = drawer.locator('.toolbox-phrase-title');
  await drawer.getByRole('button', { name: '调整顺序：A 话术', exact: true }).press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('.toolbox-phrase-title')?.textContent === 'A 话术');
  assert.deepEqual(await titles.allTextContents(), ['A 话术', 'B 话术']);
  await drawer.locator('#ops-phrase-sort').selectOption('updated');
  assert.deepEqual(await titles.allTextContents(), ['A 话术', 'B 话术']);
  await drawer.getByLabel('更多：A 话术', { exact: true }).click();
  await drawer.getByRole('button', { name: '查看全文', exact: true }).click();
  await drawer.getByText('修改后的验收文案', { exact: true }).waitFor();
  await close.click();
  assert.equal(await nav.getByRole('tab', { name: '话术文案', selected: true }).count(), 1);
  assert.equal(await drawer.locator('#ops-phrase-sort').inputValue(), 'updated');
  assert.deepEqual(errors, []);
});
