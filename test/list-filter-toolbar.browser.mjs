import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');

test('列表筛选文字、日期和操作区在手机与桌面可读，订阅次要操作沿用原入口', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const fixtures = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixtures.renewals = { version: 1, candidates: [], items: [], canSubmitToFinance: true, reminderHours: 72 };
  const traffic = await interceptDesign(context, { localFixtures: fixtures, skipRechargeAssets: true,
    actor: { id: 'toolbar-layout', name: '测试管理员', role: 'super' } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(4000);
  const additionalFilters = {
    'orders/statistics': '.commerce-stat-filter-controls',
    'plugins/mailboxes': '#ops-mailbox-pool-search-form',
    'mailboxes/relay': '.relay-alias-toolbar'
  };
  await page.goto(origin + '/#/workspace/renewals');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await toggleDesignTheme(page);
    for (const width of [320, 390, 460, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['workspace/renewals', 'subscriptions/bank-cards', 'orders/grok', 'orders/gemini',
        'staff/finance/reconciliation', 'subscriptions/gpt', 'subscriptions/claude', 'subscriptions/gemini', 'subscriptions/grok',
        'mailboxes/google', 'mailboxes/microsoft', ...Object.keys(additionalFilters)]) {
        await page.evaluate(path => location.hash = '#/' + path, route);
        const toolbarSelector = route === 'workspace/renewals' ? '.renewal-status-toolbar' : additionalFilters[route] || '.list-filter-toolbar';
        const toolbar = page.locator('#main[data-layout-route="' + route + '"] ' + toolbarSelector).first();
        await toolbar.locator('select').first().waitFor({ state: 'attached' });
        await settle(page);
        const metrics = await toolbar.evaluate(node => {
          const visible = element => element.checkVisibility() && element.getBoundingClientRect().height > 0;
          const textWidth = (text, style) => {
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
            return canvas.measureText(text).width;
          };
          const controls = [...node.querySelectorAll('input, select, button, a.button')].filter(visible);
          const cutoff = [];
          const collisions = [];
          for (const [i, control] of controls.entries()) {
            const box = control.getBoundingClientRect(), style = getComputedStyle(control);
            const text = control.matches('select') ? control.selectedOptions[0]?.text : control.placeholder;
            const room = control.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            if (text && textWidth(text, style) > room + 1) cutoff.push([control.id, text, Math.round(room), Math.round(textWidth(text, style))]);
            if (control.type === 'date' && box.width < 120) cutoff.push([control.id, 'date', box.width]);
            for (const other of controls.slice(i + 1)) {
              const next = other.getBoundingClientRect();
              if (Math.min(box.right, next.right) - Math.max(box.left, next.left) > 1 &&
                Math.min(box.bottom, next.bottom) - Math.max(box.top, next.top) > 1) collisions.push([control.id, other.id]);
            }
          }
          const fields = [...node.querySelectorAll('.list-filter-fields :is(select,input)')].filter(visible);
          const actions = [...node.querySelectorAll('.toolbar-right :is(button,a.button)')].filter(visible);
          const firstAction = Math.min(...actions.map(element => element.getBoundingClientRect().top));
          const lastField = Math.max(...fields.map(element => element.getBoundingClientRect().bottom));
          return { cutoff, collisions, gap: firstAction - lastField, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        const id = [route, width, theme].join(' ');
        assert.deepEqual(metrics.cutoff, [], id + ' 控件正文裁切');
        assert.deepEqual(metrics.collisions, [], id + ' 控件重叠');
        assert.equal(metrics.overflow, false, id + ' 页面溢出');
        if (width <= 900 && route !== 'workspace/renewals' && !additionalFilters[route]) {
          assert(metrics.gap >= 7, id + ' 筛选与操作需要分行');
        }
        if (route === 'workspace/renewals') {
          const layout = await toolbar.evaluate(node => {
            const periods = [...node.querySelectorAll('[data-renewal-period]')];
            const search = node.querySelector('#renewal-handoff-search');
            const product = node.querySelector('#renewal-handoff-product');
            const reminder = node.querySelector('[data-reminder-window]');
            const actions = [...node.querySelectorAll('[data-page-actions] button')].filter(button => button.checkVisibility());
            const boxes = [...periods, search, product, reminder, ...actions].map(control => control.getBoundingClientRect());
            return {
              periods: periods.map(button => button.dataset.renewalPeriod),
              overlapY: Math.min(...boxes.map(box => box.bottom)) - Math.max(...boxes.map(box => box.top)),
              leftToRight: boxes.every((box, index) => index === 0 || box.left >= boxes[index - 1].right - 1),
              scrollable: node.scrollWidth > node.clientWidth,
              rightmostVisible: boxes.at(-1).right <= node.getBoundingClientRect().right + 1
            };
          });
          assert.deepEqual(layout.periods, ['upcoming', 'expired', 'refused', 'renewed'], id);
          if (width > 900) assert(layout.overlapY > 0 && layout.leftToRight, id + ' 四个状态按钮在左，搜索、产品、提醒和操作同排在右');
          if (width === 1440) assert(!layout.scrollable && layout.rightmostVisible, id + ' 桌面工具栏整行可见');
          if (width <= 768) {
            assert(!layout.scrollable && layout.rightmostVisible, id + ' 手机操作无需横向滚动');
            assert(await toolbar.locator('#renewal-handoff-search').evaluate(node =>
              node.getBoundingClientRect().top >= node.closest('.renewal-toolbar').querySelector('.renewal-period-controls').getBoundingClientRect().bottom));

          }
        }
        const longChoice = route === 'plugins/mailboxes' ? '#ops-mailbox-filter-status'
          : route === 'mailboxes/relay' ? '#relay-filter-parent' : '';
        if (longChoice && width === 768 && theme === 'light') {
          const select = toolbar.locator(longChoice);
          const before = await select.inputValue();
          const longest = await select.locator('option').evaluateAll(options =>
            options.reduce((a, b) => a.text.length >= b.text.length ? a : b).value);
          await select.selectOption(longest);
          await settle(page);
          const fits = await select.evaluate(node => {
            const style = getComputedStyle(node);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
            return canvas.measureText(node.selectedOptions[0].text).width <=
              node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1;
          });
          assert(fits, id + ' 已选择的长选项应完整可读');
          await select.selectOption(before);
        }
        if (route === 'subscriptions/claude') {
          const more = toolbar.getByRole('button', { name: '更多操作', exact: true });
          if (width <= 900) {
            const actions = ['订阅历史入库', '账号资料后缀', '续费提醒话术', '列设置'];
            const direct = await toolbar.getByRole('button').allTextContents();
            const menu = page.getByRole('menu', { name: '更多操作' });
            if (await more.isVisible()) await more.click();
            const hidden = await menu.getByRole('menuitem').allTextContents();
            assert.deepEqual(actions.filter(name => direct.includes(name) || hidden.includes(name)), actions);
            assert(!hidden.some(name => direct.includes(name)));
            await page.keyboard.press('Escape');
            if (width === 390 && theme === 'light') {
              if (hidden.includes('列设置')) await more.click();
              await (hidden.includes('列设置') ? menu.getByRole('menuitem', { name: '列设置' }) : toolbar.getByRole('button', { name: '列设置' })).click();
              await page.getByRole('dialog').waitFor();
              await page.keyboard.press('Escape');
            }
          } else {
            assert.equal(await more.count(), 0);
            assert.equal(await toolbar.getByRole('button', { name: '续费提醒话术' }).count(), 1);
          }
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});
