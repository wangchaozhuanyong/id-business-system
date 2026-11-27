import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const longPlan = 'EnterpriseAnnualSubscriptionLongUnbrokenPlan';
const longEmail = 'long-local-part-for-a-small-phone-screen@example.test';
const longestEmail = 'a'.repeat(63) + '@' + 'b'.repeat(60) + '.' + 'c'.repeat(60) + '.example.test';
const rows = Array.from({ length: 23 }, (_, index) => ({
  id: 'renewal-' + index,
  email: index === 0 ? longEmail : index === 1 ? longestEmail : `customer-${index}@example.test`,
  currentPlan: index === 1 ? longPlan : index % 2 ? 'plus' : '',
  status: index % 2 ? 'active' : 'pending_renewal',
  renewalNotes: index === 21 ? '按登记备注检索' : '',
  proxySummary: '',
  lastOpenedAt: null,
  updatedAt: '2026-11-01T08:00:00Z',
  revision: 'sample-revision-' + index
}));
const summary = {
  total: rows.length, statuses: { pending_renewal: 12, active: 11, expired: 0, unknown: 0 },
  plans: [{ name: '', count: 12 }, { name: 'plus', count: 10 }, { name: longPlan, count: 1 }]
};

async function checkGeometry(table) {
  const result = await table.evaluate(element => {
    const pane = element.closest('[role="tabpanel"]');
    const bounds = pane.getBoundingClientRect();
    const actions = [...element.querySelectorAll('tbody tr:first-child :is(button, a, summary)')]
      .filter(node => node.checkVisibility());
    const failures = [];
    let fragments = 0, buttons = 0, excess = 0;
    for (const [index, row] of Array.from(element.tBodies[0].rows).entries()) {
      for (const cell of row.cells) {
        const box = cell.getBoundingClientRect();
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent.trim() || !text.parentElement.checkVisibility()) continue;
          const range = document.createRange();
          range.setStart(text, text.textContent.length - text.textContent.trimStart().length);
          range.setEnd(text, text.textContent.trimEnd().length);
          for (const rect of range.getClientRects()) {
            if (rect.width <= 0) continue;
            fragments++;
            const outside = Math.max(box.left - rect.left, rect.right - box.right, box.top - rect.top, rect.bottom - box.bottom);
            excess = Math.max(excess, outside);
            if (outside > 1)
              failures.push(`第${index + 1}行第${cell.cellIndex + 1}列文字越界 ${outside.toFixed(1)}px`);
          }
        }
        for (const button of cell.querySelectorAll('button, a, [role="button"]')) {
          if (!button.checkVisibility()) continue;
          buttons++;
          const rect = button.getBoundingClientRect();
          if (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1)
            failures.push('行操作越出单元格 ' + button.textContent.trim());
        }
      }
    }
    for (const control of [...pane.querySelectorAll('input, select, button, a, summary')]) {
      if (!control.checkVisibility() || !control.getClientRects().length) continue;
      const box = control.getBoundingClientRect();
      if (box.left < Math.max(bounds.left, 0) - 1 || box.right > Math.min(bounds.right, innerWidth) + 1)
        failures.push('超出面板 ' + (control.textContent || control.id).trim());
      for (let parent = control.parentElement; parent && parent !== pane; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clip = parent.getBoundingClientRect();
        if (['auto', 'hidden', 'scroll', 'clip'].includes(style.overflowX) &&
            (box.left < clip.left - 1 || box.right > clip.right + 1))
          failures.push('操作被裁切 ' + (control.textContent || control.id).trim());
      }
    }
    return { failures, actions: actions.length, buttons, fragments, rows: element.tBodies[0].rows.length, excess, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert.equal(result.overflow, 0, '页面横向越界');
  assert(result.actions >= 1, '每条续费记录保留可见的行操作');
  assert.deepEqual(result.failures, []);
  assert(result.fragments >= result.rows * 4);
  return result;
}

test('手动充值 A 布局在桌面和手机使用相同的续费资料与地址页签', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const geometries = [];
  for (const [width, height] of [[1920, 1080], [1440, 980], [1180, 900], [768, 980], [390, 844], [320, 730]]) {
    for (const theme of ['light', 'dark']) await t.test(width + 'px ' + theme, async t => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', hasTouch: width < 1180 });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor: { id: 'layout-qa', name: '离线检查', role: 'admin' },
        localFixtures: {}, skipRechargeAssets: true });
      const writes = [];
      let failRead = false;
      await context.route('**/api/local/native-browser-workbench*', route => {
        const req = route.request();
        if (req.method() !== 'GET') {
          writes.push(req.method());
          return route.abort();
        }
        const params = new URL(req.url()).searchParams;
        if (params.get('action') !== 'renewals') return route.fallback();
        if (failRead) return route.fulfill({ status: 503, json: { error: '合成续费列表读取失败' } });
        const search = params.get('search') || '';
        const status = params.get('status') || '';
        const filtered = rows.filter(row => (!status || row.status === status) &&
          [row.email, row.renewalNotes].some(value => value.includes(search)));
        const pageSize = Number(params.get('pageSize') || 20);
        const page = Math.min(Number(params.get('page') || 1), Math.max(1, Math.ceil(filtered.length / pageSize)));
        return route.fulfill({ json: { version: 1, page, pageSize, total: filtered.length,
          items: filtered.slice((page - 1) * pageSize, page * pageSize), summary } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#/recharge/start');
      if (await page.locator('html').getAttribute('data-theme') !== theme) await toggleDesignTheme(page);
      const host = page.locator('#bit-addresses-host');
      const renewalTab = host.getByRole('tab', { name: '账号续费管理', exact: true });
      const addressTab = host.getByRole('tab', { name: '地址管理', exact: true });
      const pane = host.locator('#bit-renewals-content');
      const table = pane.locator('.bit-renewal-records');
      const row = email => table.getByText(email, { exact: true });
      const first = row(rows[0].email);
      await first.waitFor();
      assert.equal(await renewalTab.getAttribute('aria-selected'), 'true');
      assert.equal(await addressTab.getAttribute('aria-selected'), 'false');
      assert.equal(await table.getByRole('columnheader').allTextContents().then(names => names.join('/')),
        '账号邮箱/当前套餐/状态/操作');
      const counts = pane.locator('[data-renewal-summary]');
      const checkSummary = async () => {
        const text = await counts.innerText();
        assert.match(text, /待续费\s*12/);
        assert.match(text, /已开通\s*11/);
        assert.match(text, /PLUS\s*·\s*10/i);
        assert.match(text, /未登记\s*·\s*12/);
      };
      await checkSummary();
      const help = host.locator('[data-renewal-help] .title-help');
      const helpButton = help.locator('summary');
      assert.equal(await help.evaluate(node => node.open), false);
      const headerGeometry = () => host.evaluate(node => {
        const tab = node.querySelector('#bit-renewals-heading').getBoundingClientRect();
        const trigger = node.querySelector('[data-renewal-help] summary').getBoundingClientRect();
        const start = node.querySelector('#bit-renewals-search').getBoundingClientRect();
        return { gap: trigger.left - tab.right, centers: (trigger.top + trigger.bottom - tab.top - tab.bottom) / 2,
          triggerSize: Math.min(trigger.width, trigger.height), formOffset: start.top - tab.top };
      });
      const before = await headerGeometry();
      assert(before.gap >= -1 && before.gap <= 26 && Math.abs(before.centers) <= 1, '说明紧邻页签并在同排');
      if (width < 1180) await helpButton.tap();
      else await helpButton.click();
      assert(await help.evaluate(node => node.open));
      const note = await help.locator('.title-description').boundingBox();
      assert(note && note.x >= 0 && note.x + note.width <= width + 1, '说明未横向裁切');
      assert.equal((await headerGeometry()).formOffset, before.formOffset, '展开说明不挤动列表');
      await page.keyboard.press('Escape');
      assert.equal(await help.evaluate(node => node.open), false);
      await page.getByRole('tab', { name: '续费登记', exact: true }).click();
      const draft = page.locator('#bit-renewal-notes');
      await draft.fill('布局验收草稿');
      const addressJump = page.getByRole('button', { name: '前往地址管理', exact: true });
      if (width < 1180) {
        await addressJump.tap();
        assert(await addressTab.evaluate(node => node === document.activeElement));
        const hostBox = await host.boundingBox();
        assert(hostBox.y < height / 2 && hostBox.y >= 0, '手机快捷定位实际到达可见管理区');
      } else {
        assert(await addressJump.isHidden());
        const entryBox = await draft.boundingBox(), hostBox = await host.boundingBox();
        assert(entryBox.x + entryBox.width <= hostBox.x, '电脑左侧录入，右侧管理');
        await addressTab.click();
      }
      await pane.waitFor({ state: 'hidden' });
      await host.getByRole('tab', { name: /^未使用/ }).waitFor();
      const addressHelp = host.locator('[data-address-help] summary');
      const addressBox = await addressTab.boundingBox(), infoBox = await addressHelp.boundingBox();
      assert(infoBox && Math.abs(infoBox.x - addressBox.x - addressBox.width) <= 8, '地址说明紧邻地址页签');
      await addressHelp.click();
      assert(await addressHelp.evaluate(node => node.parentElement.open));
      await page.keyboard.press('Escape');
      assert.equal(await addressHelp.evaluate(node => node.parentElement.open), false);
      await addressTab.focus();
      await addressTab.press('ArrowRight');
      await first.waitFor();
      assert(await renewalTab.evaluate(node => node === document.activeElement));
      assert.equal(await draft.inputValue(), '布局验收草稿');
      await settle(page);
      geometries.push({ width, theme, page: 1, ...await checkGeometry(table) });
      if (output) {
        if (width < 1180) await page.getByRole('button', { name: '前往续费管理', exact: true }).tap();
        else await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: join(output, `renewals-${width}-${theme}.png`), animations: 'disabled' });
      }

      const pager = pane.locator('nav[data-pagination]');
      await pager.getByRole('button', { name: '下一页', exact: true }).click();
      await row(rows.at(-1).email).waitFor();
      assert(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled());
      geometries.push({ width, theme, page: 2, ...await checkGeometry(table) });
      const search = pane.locator('#bit-renewals-search');
      await search.fill('按登记备注检索');
      await row(rows[21].email).waitFor();
      await page.waitForFunction(() => document.querySelector('#bit-renewals-content nav[data-pagination]')?.dataset.total === '1');
      await pane.locator('#bit-renewals-status').selectOption('pending_renewal');
      await table.locator('tbody').getByText(/暂无|没有|无匹配/).waitFor();
      await pane.locator('#bit-renewals-status').selectOption('active');
      await row(rows[21].email).waitFor();
      failRead = true;
      const refresh = pane.getByRole('button', { name: '刷新', exact: true });
      await refresh.click();
      await pane.getByRole('alert').waitFor();
      assert(await row(rows[21].email).isVisible(), '刷新失败保留原列表');
      failRead = false;
      await refresh.click();
      await pane.getByRole('alert').waitFor({ state: 'hidden' });
      await checkSummary();
      assert.equal(await search.inputValue(), '按登记备注检索');
      assert.equal(await draft.inputValue(), '布局验收草稿');
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(traffic.unavailable, []);
    });
  }
  if (output) await writeFile(join(output, 'renewal-cell-geometry.json'), JSON.stringify(geometries, null, 2));
});
