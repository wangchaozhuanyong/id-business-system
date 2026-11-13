// Offline design previews only: all HTTP is fulfilled from local sources or synthetic fixtures.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { interceptDesign, origin, root, settle, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';
import assert from 'node:assert/strict';

const output = path.join(root, 'docs/design/site-visual-v2-20261113');
import {clock, actor, fixture} from './helpers/site-visual-v2-fixtures.mjs';
const routes = [
  ['order-entry', 'workspace/order/gpt'], ['accounts', 'accounts/gpt'], ['orders', 'orders/gpt']
];
const widths = process.argv.includes('--matrix') ? [1920, 1440, 390, 320] : [1920];
const themes = process.argv.includes('--matrix') ? ['light', 'dark'] : ['light'];
const candidate = !process.argv.includes('--before');
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
const evidence = { source: '4f49095e98a45e9de4e0b2b27aec42517918dab4', candidate, syntheticData: true, errors: [], scenes: [] };
try {
  for (const width of widths) for (const theme of themes) {
    const context = await browser.newContext({ viewport: { width, height: width < 900 ? 844 : 1080 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Kuala_Lumpur', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const requests = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.clock.setFixedTime(clock);
    page.on('pageerror', error => evidence.errors.push(error.message));
    for (const [name, route] of routes) {
      if (width < 900) await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(origin + '/#/' + route);
      await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) await toggleDesignTheme(page);
      await page.waitForFunction(() => document.querySelector('tbody tr:not(.empty-row)'));
      await settle(page);
      if (name !== 'order-entry') {
        // Use the existing column-settings interaction in both before/after views; no fields are removed.
        const visible = new Set(name === 'accounts'
          ? ['emailType', 'email', 'acquisitionMethod', 'country', 'status', 'use', 'registered', 'createdBy', 'notes', 'actions']
          : ['orderNo', 'customerId', 'email', 'plan', 'payment', 'paidAmount', 'saleAmount', 'profit', 'expiry', 'expiryStatus', 'actions']);
        await page.getByRole('button', { name: '列设置', exact: true }).click();
        const choices = await page.locator('[data-column-toggle]').evaluateAll(nodes => nodes.filter(n => !n.disabled).map(n => n.dataset.column));
        for (const id of choices) if (!visible.has(id)) await page.locator('[data-column-toggle][data-column="' + id + '"]').uncheck();
        await page.locator('#drawer').getByRole('button', { name: '完成', exact: true }).click();
        await settle(page);
      }
      if (width < 900) await page.setViewportSize({ width, height: 844 });
      if (name === 'order-entry') {
        // Fill only local controls for a representative draft; no submit is performed.
        const customer = page.locator('#commerce-customerId');
        if (await customer.count()) await customer.evaluate(el => { el.value = 'visual-draft-customer'; el.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.locator('#commerce-email').fill('ye.zhixia@example.test');
        await page.locator('#commerce-cardTypeId').selectOption('visual-type');
        await page.locator('#commerce-paidAmount').fill('983');
        await page.locator('#commerce-saleAmount').fill('138');
      }
      await page.evaluate(() => document.activeElement?.blur());

      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#main')?.scrollTo(0, 0); });
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      await settle(page);
      await page.mouse.move(width - 5, 4);
      const geometry = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme, pageWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        h1: { text: document.querySelector('h1')?.textContent, size: getComputedStyle(document.querySelector('h1')).fontSize },
        tableColumns: [...document.querySelectorAll('#main thead th')].map(el => el.textContent.trim()),
        visibleRows: [...document.querySelectorAll('#main tbody tr')].filter(row => {
          const box = row.getBoundingClientRect(), scroll = row.closest('.table-viewport')?.getBoundingClientRect();
          return row.checkVisibility() && box.width > 0 && box.top >= 0 && box.bottom <= Math.min(innerHeight, scroll?.bottom ?? innerHeight);
        }).length,
        titleHelpOpen: [...document.querySelectorAll('.title-help')].some(el => el.hasAttribute('open')),
        entry: (() => {
          const editor=document.querySelector('#commerce-order-form');
          if (!editor) return null;
          const panel=editor.closest('.form-panel').getBoundingClientRect(), records=document.querySelector('.entry-records').getBoundingClientRect();
          return {clientHeight:editor.clientHeight,scrollHeight:editor.scrollHeight,sideBySide:records.left>=panel.right};
        })()
        ,formMetrics: [...document.querySelectorAll('#commerce-order-form .form-section')].map(el => ({ height: el.getBoundingClientRect().height, top: el.getBoundingClientRect().top, grid: [...el.querySelectorAll('.commerce-field-grid,.order-account-fields')].map(n => ({ class: n.className, gap: getComputedStyle(n).gap })) }))
      }));
      assert.equal(geometry.theme, theme);
      const spacing = await separatorSnapshot(page);
      const filename = `${candidate ? 'after' : 'before'}-${name}-${width}-${theme}.png`;
      await page.screenshot({ path: path.join(output, filename), animations: 'disabled' });
      await writeFile(path.join(output, `${candidate ? 'after' : 'before'}-${name}-dom.html`), await page.locator('#main').innerHTML());
      evidence.scenes.push({ name, route, width, theme, filename, ...geometry, spacing });
      console.log(JSON.stringify({ filename, rows: geometry.visibleRows, columns: geometry.tableColumns, spacing: spacing.findings.length }));
    }
    evidence.errors.push(...requests.unavailable.map(x => 'missing: ' + x), ...requests.external.map(x => 'external blocked: ' + x));
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, candidate ? 'preview-checks.json' : 'baseline-checks.json'), JSON.stringify(evidence, null, 2));
assert.deepEqual(evidence.errors,[]);
for (const scene of evidence.scenes) {
  assert(scene.scrollWidth<=scene.width+1,`${scene.filename}: no document overflow`);
  assert.deepEqual(scene.spacing.findings,[],`${scene.filename}: toolbar clearance`);
  assert.equal(scene.titleHelpOpen,false,`${scene.filename}: help collapsed by default`);
  if (candidate && scene.width===1920 && scene.entry) {
    assert(scene.entry.sideBySide,`${scene.filename}: form and records remain side by side`);
    assert(scene.entry.scrollHeight<=scene.entry.clientHeight+1,`${scene.filename}: compact draft fits the editor`);
  }
}
if (candidate) {
  const baseline=JSON.parse(await readFile(path.join(output,'baseline-checks.json'),'utf8'));
  for (const before of baseline.scenes) {
    const after=evidence.scenes.find(scene=>scene.name===before.name && scene.width===before.width && scene.theme===before.theme);
    if(after) assert(after.visibleRows>=before.visibleRows,`${after.filename}: keep visible record density`);
  }
}
console.log(JSON.stringify({ scenes: evidence.scenes.length, errors: evidence.errors }));
