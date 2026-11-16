import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle, separatorSnapshot } from './helpers/offline-design.mjs';

const output = root + '/.runtime/relay-unified-status';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await interceptDesign(context, { skipRechargeAssets: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/relay');
  const toolbar = page.locator('.relay-alias-toolbar');
  await toolbar.waitFor();
  for (const width of [2208, 1920, 1591, 1440, 1200, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await settle(page);
      const bounds = await toolbar.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return [...node.querySelectorAll('button,input,select')].filter(el => el.checkVisibility()).map(el => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent, y: r.y + r.height / 2, left: r.left, right: r.right, min: rect.left, max: rect.right, height: r.height };
        });
      });
      assert(Math.max(...bounds.map(r => r.y)) - Math.min(...bounds.map(r => r.y)) <= 2, `${width}: single row`);
      assert(bounds.every(r => r.left >= r.min && r.right <= r.max), `${width}: clipping`);
      for (let i = 1; i < bounds.length; i++) assert(bounds[i].left >= bounds[i-1].right - 1, `${width}: overlap`);
      if (width <= 390) assert(bounds.every(r => r.height >= 44), 'touch size');
      assert.deepEqual((await separatorSnapshot(page, '#main')).findings, []);
      await toolbar.locator('[data-action="relay-alias-tools"]').click();
      const menu = page.getByRole('menu');
      if (!await toolbar.locator('.relay-secondary-actions').isVisible()) await menu.getByRole('menuitem', { name: '列设置', exact: true }).waitFor();
      if (!await toolbar.locator('#relay-filter-parent').isVisible()) {
        await menu.getByRole('menuitem', { name: '筛选主邮箱', exact: true }).click();
        await page.getByRole('menuitem', { name: '全部主邮箱', exact: true }).click();
      } else await page.keyboard.press('Escape');
      await page.screenshot({ path: `${output}/${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 2208, height: 900 });
  await toolbar.locator('[data-value="dead"]').click();
  const stateCells = page.locator('table[data-table="relay-aliases"] tbody [data-label="状态"]');
  for (const text of await stateCells.allTextContents()) assert.equal(text.trim(), '死号');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.locator('#relay-state-select').inputValue(), 'dead');
  await page.locator('#relay-state-select').selectOption('available');
  await page.setViewportSize({ width: 2208, height: 900 });
  assert.equal(await toolbar.locator('[data-value="available"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log('通过：20 个宽度/主题组合、单行/间距/菜单、状态切换；仅离线虚构资料。');
} finally { await browser.close(); }
