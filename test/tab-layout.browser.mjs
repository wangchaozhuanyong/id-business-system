import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

// Real static UI with isolated data; never starts a server or contacts a business API.
const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
const baseline = process.env.ID_TABS_QA_BASELINE === '1';
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/tab-consistency-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const screenshots = ['workspace/renewals', 'customers/new', 'workspace/order-completion', 'workspace/recharge'];
const snapshot = () => {
  const visible = n => !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  return [...document.querySelectorAll('.tabs, [data-recharge-workspace] .tab-nav')].filter(visible).map(nav => {
    const row = nav.closest('.list-controls, .content-toolbar, .workspace-recharge-heading, .bit-local__workspace-bar, .tool-header-row') || nav;
    const rect = row.getBoundingClientRect(), navRect = nav.getBoundingClientRect();
    const container = row.closest('.panel, .recharge-card, #bit-login-form');
    const first = container && container.firstElementChild === row;
    const style = getComputedStyle(nav);
    return {
      label: nav.getAttribute('aria-label') || nav.className,
      row: row.className, height: rect.height, navHeight: navRect.height,
      topGap: first ? rect.top - container.getBoundingClientRect().top - parseFloat(getComputedStyle(container).borderTopWidth) : null,
      lineInset: first ? container.clientWidth - rect.width : null,
      border: parseFloat(style.borderBottomWidth), rowBorder: parseFloat(getComputedStyle(row).borderBottomWidth),
      separateRow: row !== nav,
      hasActions: [...row.querySelectorAll('button,input,select,summary')].some(node => !nav.contains(node)),
      underlineGap: rect.bottom - navRect.bottom,
      tabs: [...nav.querySelectorAll(':scope > .tab, :scope > .tab-btn')].filter(visible).map(tab => {
        const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && !node.textContent.trim()) {}
        const range = document.createRange();
        if (node) range.selectNodeContents(node);
        const text = range.getBoundingClientRect(), bounds = tab.getBoundingClientRect(), css = getComputedStyle(tab);
        return { text: tab.textContent.trim(), height: bounds.height, font: css.fontSize,
          centerOffset: (text.top + text.bottom - bounds.top - bounds.bottom) / 2,
          padding: [css.paddingTop, css.paddingBottom], shadow: css.boxShadow,
          border: [css.borderTopWidth, css.borderBottomWidth],
          clipped: bounds.width > nav.clientWidth + 1 };
      })
    };
  });
};
try {
  for (const width of baseline ? [1440] : [1920, 1440, 1024, 901, 900, 768, 390, 320]) {
    for (const theme of baseline ? ['light'] : ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const traffic = await interceptDesign(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.setDefaultTimeout(7000);
      await page.goto(origin + '/#/overview');
      if (theme === 'dark') await toggleDesignTheme(page);
      const routes = baseline ? screenshots : await page.evaluate(() => window.IDDesignAPI.navigation.flatMap(g => g[2].map(i => i[1])));
      const capture = async (route, state = 'initial') => {
        await settle(page);
        for (const frame of page.frames()) {
          if (frame !== page.mainFrame() && !await frame.frameElement().then(el => el.isVisible())) continue;
          results.push({ width, theme, route, state, frame: frame === page.mainFrame() ? 'main' : new URL(frame.url()).pathname,
            bars: await frame.evaluate(snapshot), overflow: await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
        }
      };
      const switchTabs = async (route, scope) => {
        const selectors = await scope.locator('.tabs > button[data-action]').evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).map(n =>
          'button' + [...n.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}="${a.value}"]`).join('')));
        for (const selector of selectors) {
          const tab = scope.locator(selector + ':visible').first();
          if (!await tab.isVisible() || !await tab.isEnabled()) continue;
          const label = await tab.innerText();
          await tab.click();
          await capture(route, label);
        }
      };
      for (const route of routes) {
        await page.evaluate(route => { location.hash = '#/' + route; }, route);
        await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
        if (route === 'workspace/recharge') {
          await page.frameLocator('[data-recharge-module="workspace"] iframe:not([hidden])').locator('.tab-nav').waitFor();
        }
        await capture(route);
        if (screenshots.includes(route) && [1440, 390].includes(width))
          await page.screenshot({ path: output + `/${baseline ? 'before' : 'after'}-${route.replaceAll('/', '-')}-${width}-${theme}.png` });
        if (!baseline && route !== 'online-recharge/chatgpt') await switchTabs(route, page.locator('#main'));
        if (!baseline && route === 'workspace/recharge') {
          const frame = page.frameLocator('[data-recharge-module="workspace"] iframe:not([hidden])');
          for (const tab of ['guide', 'query', 'redeem']) {
            await frame.locator(`[data-tab="${tab}"]`).click();
            await capture(route, tab);
          }
          await frame.locator('[data-tab="guide"]').focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          assert(await frame.locator('[data-tab="guide"]').evaluate(n => getComputedStyle(n).outlineStyle !== 'none'), '键盘焦点不可见');
        }
        if (!baseline && route === 'online-recharge/chatgpt') {
          for (const view of ['cards', 'logs']) {
            await page.locator(`button[data-view="${view}"]`).click();
            const frame = page.frameLocator('[data-recharge-module="online"] iframe:not([hidden])');
            await frame.locator(`#${view}.active`).waitFor();
            await capture(route, view);
          }
        }
      }
      // Order completion exists only in business-data mode, unlike the other prototype routes.
      const apiTraffic = await interceptDesign(context, { localFixtures: { 'order-completion': { items: [], canAssign: true } } });
      await page.goto(origin + '/#/workspace/order-completion');
      await page.reload();
      if (theme === 'dark') await toggleDesignTheme(page);
      await page.locator('[data-action="completion-tab"]').first().waitFor();
      await capture('workspace/order-completion', 'API empty');
      if (!baseline) {
        if (width >= 901) assert.equal((await page.locator('#completion-list > .list-controls').boundingBox()).height, 61, '宽屏搜索与页签应在同一行');
        await switchTabs('workspace/order-completion', page.locator('#main'));
      }
      if ([1440, 390].includes(width)) await page.screenshot({ path: output + `/${baseline ? 'before' : 'after'}-completion-${width}-${theme}.png` });
      assert.deepEqual(errors, []);
      assert.deepEqual([...traffic.external, ...apiTraffic.external], []);
      assert.deepEqual([...traffic.unavailable, ...apiTraffic.unavailable], []);
      await context.close();
      console.log(JSON.stringify({ width, theme, routes: routes.length }));
    }
  }
  await writeFile(output + `/${baseline ? 'before' : 'after'}-geometry.json`, JSON.stringify(results, null, 2));
  if (!baseline) {
    for (const record of results) {
      const message = JSON.stringify(record);
      assert(!record.overflow, message);
      for (const bar of record.bars) {
        assert(bar.topGap === null || bar.topGap <= 1, '页签上方重复留白: ' + message);
        assert(bar.lineInset === null || Math.abs(bar.lineInset) <= 1, '分隔线未覆盖整个页签行: ' + message);
        const minimumHeight = record.width <= 900 && bar.row === 'content-toolbar' ? 52 : 60;
        assert(bar.tabs.every(tab => tab.height >= minimumHeight && Math.abs(tab.centerOffset) <= 2), '页签高度或文字居中不符: ' + message);
        assert(bar.tabs.every(tab => tab.font === '14px' && tab.shadow === 'none'), '页签皮肤不一致: ' + message);
        // A borderless wrapper containing only tabs still lets the tabs own their separator.
        if (bar.separateRow && (bar.hasActions || bar.rowBorder > 0))
          assert(bar.border === 0, '页签和操作行重复分隔线: ' + message);
      }
    }
  }
  console.log(JSON.stringify({ scenarios: results.length, bars: results.reduce((sum, r) => sum + r.bars.length, 0), baseline }));
} finally { await browser.close(); }
