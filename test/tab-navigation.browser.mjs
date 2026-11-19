import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

function geometry(bar) {
  const port = bar.closest('[data-tab-scrollport]') || bar;
  const bounds = port.getBoundingClientRect(), style = getComputedStyle(port);
  const left = bounds.left + port.clientLeft, right = left + port.clientWidth;
  return {
    left, right, offset: port.scrollLeft, pageY: scrollY, scrollbar: style.scrollbarWidth,
    gutter: port.offsetHeight - port.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
    items: [...bar.children].filter(node => node.matches('a[href],button') && node.checkVisibility()).map(node => {
      const rect = node.getBoundingClientRect();
      return { selected: node.matches('.active,[aria-selected="true"],[aria-pressed="true"],[aria-current="page"]'),
        focused: document.activeElement === node, width: rect.width, top: rect.top, bottom: rect.bottom,
        left: Math.max(left, rect.left), right: Math.min(right, rect.right) };
    })
  };
}

function assertSelected(view, index) {
  const item = view.items[index];
  assert(item.selected, '已切换至点选的页签');
  assert(item.right - item.left >= item.width - 1, '当前页签完整可见');
}

test('横向页签支持触摸留位、激活定位和键盘切换', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(() => browser.close());
  const localFixtures = JSON.parse(await readFile(root + 'docs/audits/2026-11-06-design-review/visual-fixtures.json', 'utf8'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const traffic = await interceptDesign(context, { actor: { id: 'tab-qa', role: 'super', name: '测试管理员' }, localFixtures });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const open = async route => {
    await page.goto(origin + '/#/' + route);
    await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
    await settle(page);
  };
  for (const [route, label] of [['accounts/claude', '库存视图'], ['subscriptions/bank-cards', '银行卡列表'],
    ['online-recharge/chatgpt', 'ChatGPT 充值功能']]) {
    await open(route);
    const bar = page.locator('#main [aria-label="' + label + '"]');
    await bar.waitFor();
    await bar.evaluate(node => {
      const box = node.getBoundingClientRect();
      if (box.bottom > innerHeight || box.top < 64) window.scrollBy(0, box.top - innerHeight / 2);
    });
    const before = await bar.evaluate(geometry);
    assert.equal(before.scrollbar, 'none');
    assert.equal(before.gutter, 0, '显示系统滚动条时也不占页签高度');
    let index = before.items.findIndex(item => !item.selected && item.right - item.left >= 4 && item.right - item.left < item.width - 1);
    // The viewport can also end in the gap between two tabs with classic scrollbars.
    if (index < 0) index = before.items.findLastIndex(item => !item.selected && item.right - item.left > 12);
    assert(index > 0, route + ' 应有可点击的后续页签');
    const touch = before.items[index];
    // Tap the part actually exposed to the user. Locator.click() scrolls it fully into view first.
    await page.touchscreen.tap((touch.left + touch.right) / 2, (touch.top + touch.bottom) / 2);
    await settle(page);
    const after = await bar.evaluate(geometry);
    assertSelected(after, index);
    assert.equal(after.pageY, before.pageY, '横向切换保持页面纵向位置');
    assert(after.offset > before.offset);
    if (index + 1 < after.items.length) assert(after.items[index + 1].right - after.items[index + 1].left > 12, '可看到下一个页签');
    await page.evaluate(() => window.IDDesignAPI.render());
    await settle(page);
    const refreshed = await bar.evaluate(geometry);
    assertSelected(refreshed, index);
    assert.equal(refreshed.offset, after.offset);
    await bar.locator(':scope > button').nth(index).focus();
    await page.keyboard.press('Home');
    await settle(page);
    const first = await bar.evaluate(geometry);
    assertSelected(first, 0);
    assert(first.items[0].focused);
    if (route === 'accounts/claude') {
      const cdp = await context.newCDPSession(page);
      const x = first.right - 8, y = (first.items[0].top + first.items[0].bottom) / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 16, y }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(350);
      const manual = await bar.evaluate(geometry);
      assert(manual.offset > 40, '手指可单独滚动页签');
      await page.evaluate(() => window.IDDesignAPI.render());
      assert.equal((await bar.evaluate(geometry)).offset, manual.offset, '重绘保留手动滚动位置');
      await open('overview');
      await page.goBack();
      await bar.waitFor();
      assert.equal((await bar.evaluate(geometry)).offset, manual.offset, '返回保留原位置');
    }
  }
  await open('workspace/recharge');
  const embedded = page.frameLocator('[data-recharge-module="workspace"] iframe:not([hidden])').locator('.tab-nav');
  await embedded.locator('button').first().focus();
  await page.keyboard.press('End');
  await settle(page);
  assert.equal(await embedded.evaluate(bar => getComputedStyle(bar).scrollbarWidth), 'none');
  const frameView = await embedded.evaluate(geometry);
  assertSelected(frameView, frameView.items.length - 1);
  assert(frameView.items.at(-1).focused);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.unavailable, []);
  assert.deepEqual(traffic.external, []);
});
