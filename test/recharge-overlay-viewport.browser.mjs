import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('scrolled recharge overlays keep their controls below the pinned host navigation', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }])
    for (const theme of ['light', 'dark']) await t.test(`${viewport.width} ${theme}`, async t => {
      const context = await browser.newContext({ viewport });
      t.after(() => context.close());
      const traffic = await interceptDesign(context, { actor: { id: 'overlay-layout', name: '离线验收', role: 'super' } });
      const sessions = Array.from({ length: 8 }, (_, index) => ({ job_key: 'layout-' + index, status: 'failed',
        token_preview: '隔离示例资料 ' + index, has_session: true, time: '2026-11-14 10:00',
        message: '仅用于布局的合成任务说明。'.repeat(12) }));
      const api = '/integrations/codexdaichong/api/admin/';
      const writes = [];
      await context.route(url => url.pathname === api + 'activation-manual-holds', route => route.fulfill({
        json: { success: true, holds: [{ id: 1, accountEmail: 'overlay@example.test', reason: '隔离布局验收' }] }
      }));
      context.on('request', request => {
        if (new URL(request.url()).pathname.startsWith(api) && request.method() !== 'GET') writes.push(request.method());
      });
      await context.route(url => url.pathname === api + 'sessions', route => route.fulfill({ json: { items: sessions, total: sessions.length } }));
      await context.route(url => url.pathname === api + 'sessions/layout-0', route => route.fulfill({ json: { success: true,
        session: { session_payload: JSON.stringify({ note: '无凭据的离线布局示例', lines: Array(20).fill('仅用于滚动验收') }) } } }));
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(6000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#/online-recharge/chatgpt');
      if (theme === 'dark') await toggleDesignTheme(page);
      const frame = page.frameLocator('iframe[data-view-group="admin"]:visible');

      async function check(modal, close, name) {
        await modal.waitFor();
        await page.evaluate(() => scrollBy(0, 200));
        await settle(page);
        const bounds = await modal.boundingBox(), button = await close.boundingBox();
        const header = await page.locator('.topbar').boundingBox();
        const position = await page.locator('.topbar').evaluate(node => getComputedStyle(node).position);
        const top = ['fixed', 'sticky'].includes(position) ? Math.max(0, header.y + header.height) : 0;
        assert(bounds.y >= top + 8, name + ': header is not hidden behind host navigation');
        assert(bounds.y + bounds.height <= viewport.height - 8, name + ': bottom remains visible');
        assert(button.y >= top && button.y + button.height <= viewport.height, name + ': close button remains reachable');
        assert(button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width, name + ': close button is not clipped');
        results.push({ viewport, theme, name, bounds, button, hostHeaderBottom: top });
        if (output) await page.screenshot({ path: join(output, `${name}-${viewport.width}-${theme}.png`) });
        await close.click();
        await modal.waitFor({ state: 'hidden' });
      }

      await page.locator('[data-action="ops-integrated-view"][data-view="logs"]').click();
      await frame.getByRole('tab', { name: '待人工确认', exact: true }).click();
      await frame.getByRole('button', { name: '解除', exact: true }).click();
      await check(frame.locator('.admin-confirm-dialog'), frame.locator('#admin_confirm_cancel'), 'confirmation');
      await page.locator('[data-action="ops-integrated-view"][data-view="sessions"]').click();
      await frame.locator('#sessions.active').waitFor();
      await frame.locator('[data-view-session="layout-0"]').waitFor();
      await frame.locator('[data-view-session="layout-0"]').click();
      await frame.locator('#session_modal_body').getByText(/无凭据的离线布局示例/).waitFor();
      await check(frame.locator('#session_modal_overlay .screenshot-modal'),
        frame.locator('#session_modal_overlay').getByRole('button', { name: '关闭', exact: true }), 'session-detail');
      await frame.locator('#session_body .recharge-cell-text').first().click();
      await check(frame.locator('.recharge-cell-dialog'),
        frame.locator('.recharge-cell-dialog').getByRole('button', { name: '关闭', exact: true }), 'full-text');
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], 'cancelled dialogs do not perform business writes');
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(traffic.unavailable, []);
    });
  if (output) await writeFile(join(output, 'overlay-layout.json'), JSON.stringify(results, null, 2));
});
