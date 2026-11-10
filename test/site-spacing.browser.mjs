import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  root,
  origin,
  interceptDesign,
  settle,
  spacingSnapshot
} from './helpers/offline-design.mjs';
const { chromium } = await import(
  process.env.ID_RECHARGE_QA_PLAYWRIGHT
    ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href
    : 'playwright'
);
const browser = await chromium.launch({ headless: true }),
  output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/site-spacing-20261107',
  results = [];
await mkdir(output, { recursive: true });
const drawerActions = [
  'inventory-add',
  'inventory-detail',
  'relay-parent-add',
  'relay-alias-detail',
  'commerce-contact-add',
  'commerce-contact-detail',
  'commerce-order-detail',
  'apple-add',
  'apple-details',
  'ops-mail-type-add',
  'ops-audit-detail'
];
const capture = async (page, width, theme, route, state) => {
  results.push({ width, theme, route, state, ...(await spacingSnapshot(page)) });
};
try {
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } }),
        requests = await interceptDesign(context);
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.setDefaultTimeout(5000);
      await page.goto(origin + '/#/overview');
      if (theme === 'dark') await page.locator('#theme-toggle').click();
      const routes = await page.evaluate(() =>
        window.IDDesignAPI.navigation.flatMap((group) => group[2].map((item) => item[1]))
      );
      for (const route of routes) {
        await page.evaluate((route) => {
          location.hash = '#/' + route;
        }, route);
        await settle(page);
        await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
        await capture(page, width, theme, route, 'initial');
        if ([1440, 390].includes(width)) {
          for (const action of drawerActions) {
            const control = page.locator('#main [data-action="' + action + '"]:visible').first();
            if (!(await control.count()) || !(await control.isEnabled())) continue;
            await control.click();
            await settle(page);
            const drawer = page.locator('#drawer[open]');
            await drawer.waitFor();
            const geometry = await drawer.evaluate((el) => {
              const body = el.querySelector('.drawer-body'),
                footer = el.querySelector('.drawer-footer');
              const a = el.getBoundingClientRect(),
                b = body.getBoundingClientRect(),
                style = getComputedStyle(body);
              const first = body.querySelector('.field > label');
              return {
                overflow: el.scrollWidth > el.clientWidth + 1,
                padding: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
                labelInset: first ? first.getBoundingClientRect().left - a.left : null,
                footerInset:
                  footer && footer.children.length
                    ? a.right - footer.lastElementChild.getBoundingClientRect().right
                    : null
              };
            });
            assert(
              !geometry.overflow && geometry.padding.every((v) => v >= 14),
              `${route} ${action}: ${JSON.stringify(geometry)}`
            );
            if (geometry.labelInset != null) assert(geometry.labelInset >= 14);
            if (geometry.footerInset != null) assert(geometry.footerInset >= 14);
            results.push({ width, theme, route, state: action, findings: [], geometry });
            await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
            await settle(page);
          }
        }
        const tabs = await page
          .locator('#main .panel > .tabs button, #main .panel > .content-toolbar > .tabs button')
          .evaluateAll((nodes) =>
            nodes.filter(n => n.checkVisibility()).map((n) => ({
              text: n.textContent,
              selector:
                'button' +
                [...n.attributes]
                  .filter((a) => a.name.startsWith('data-'))
                  .map((a) => '[' + a.name + '="' + a.value + '"]')
                  .join('')
            }))
          );
        for (const tab of tabs) {
          if (tab.selector === 'button') continue;
          await page.locator('#main ' + tab.selector + ':visible').click();
          await settle(page);
          await capture(page, width, theme, route, tab.text);
        }
        if (route === 'mailboxes/relay') {
          await page.locator('[data-action="relay-tab"][data-tab="query"]').click();
          await settle(page);
          const insets = await page.locator('#relay-query-form').evaluate((form) => {
            const card = form.closest('.panel').getBoundingClientRect(),
              label = form.querySelector('label').getBoundingClientRect(),
              input = form.querySelector('input').getBoundingClientRect(),
              button = form.querySelector('[type=submit]').getBoundingClientRect();
            return {
              label: label.left - card.left,
              input: card.right - input.right,
              button: card.right - button.right,
              bottom: card.bottom - button.bottom
            };
          });
          assert(
            Object.values(insets).every((v) => v >= 16),
            JSON.stringify(insets)
          );
          await page.screenshot({ path: output + `/after-relay-${width}-${theme}.png` });
        }
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests.unavailable, []);
      assert.deepEqual(requests.external, []);
      console.log(JSON.stringify({ width, theme, routes: routes.length }));
      await context.close();
    }
  // Exercise the actual API-mode DOM with synthetic data; include failure/empty branches.
  const fixture = JSON.parse(
    await readFile(root + '/docs/audits/2026-11-06-design-review/visual-fixtures.json', 'utf8')
  );
  for (const width of [1440, 390])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await interceptDesign(context, { localFixtures: fixture });
      const page = await context.newPage();
      await page.goto(origin + '/#/mailboxes/relay');
      if (theme === 'dark') await page.locator('#theme-toggle').click();
      await page.locator('[data-action="relay-tab"][data-tab="query"]').click();
      await page.locator('#relay-query').waitFor();
      await settle(page);
      await capture(page, width, theme, 'mailboxes/relay', 'configured API query');
      await page.screenshot({ path: output + `/after-relay-api-${width}-${theme}.png` });
      await page.locator('#relay-query').fill('layout-query');
      await page.locator('[data-action="relay-tab"][data-tab="parents"]').click();
      await page.locator('[data-action="relay-tab"][data-tab="query"]').click();
      assert.equal(await page.locator('#relay-query').inputValue(), 'layout-query');
      await page.evaluate(() => {
        location.hash = '#/settings/accounts';
      });
      await settle(page);
      await capture(page, width, theme, 'settings/accounts', 'API placeholder');
      await context.close();
      const failed = await browser.newContext({ viewport: { width, height: 900 } });
      await interceptDesign(failed, { localFixtures: {} });
      await failed.route('**/api/local/inventory', (route) =>
        route.fulfill({ status: 503, json: { error: '合成读取失败' } })
      );
      const failurePage = await failed.newPage();
      await failurePage.goto(origin + '/#/mailboxes/relay');
      if (theme === 'dark') await failurePage.locator('#theme-toggle').click();
      await failurePage.getByRole('button', { name: '重试', exact: true }).waitFor();
      await capture(failurePage, width, theme, 'mailboxes/relay', 'API read failure');
      await failed.close();
    }
  await writeFile(output + '/spacing-results.json', JSON.stringify(results, null, 2));
  const failures = results.filter((r) => r.findings.length || r.overflow);
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify({
      scenarios: results.length,
      failures: failures.length,
      network: 'fully intercepted; no website server or database'
    })
  );
} finally {
  await browser.close();
}
