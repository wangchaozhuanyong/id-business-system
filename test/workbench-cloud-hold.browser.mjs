import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const path = '/integrations/bitbrowser/local-login';
const endpoint = origin + '/api/local/native-browser-workbench';
const html = await readFile(new URL('../frontend/bitbrowser-local.html', import.meta.url), 'utf8');
const account = {
  id: 'fixture-record',
  email: 'workbench@example.test',
  currentPlan: 'plus',
  status: 'pending_renewal',
  proxySummary: '合成资料',
  renewalNotes: '合成备注',
  profileKey: 'fixture-profile',
  isRunning: true,
};
const sessionJson = JSON.stringify({ user: { email: account.email }, sessionToken: 'fixture-session' });

test('正式工作台暂缓云端操作时保留记录、保存和单号登录', { timeout: 45_000 }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        await interceptDesign(context, { skipRechargeAssets: true });
        await context.route(origin + path, route => route.fulfill({
          contentType: 'text/html',
          body: html.replace('<body class="bit-local">', '<body class="bit-local" data-cloud-workbench-paused>'),
        }));
        const writes = [];
        await context.route(endpoint + '**', async (route) => {
          const request = route.request();
          const action = new URL(request.url()).searchParams.get('action');
          if (request.method() === 'POST') {
            writes.push({ action, body: request.postDataJSON() });
            return route.fulfill({ json: { ok: true, record: account } });
          }
          return route.fulfill({ json: action === 'preferences' ? {} : { items: [account], version: 1 } });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        page.on('dialog', dialog => dialog.accept());
        await page.goto(origin + path);
        await page.getByText('云端浏览器暂缓开放').waitFor();
        await page.getByText(account.email, { exact: true }).waitFor();
        assert.equal(await page.locator('#wb-save-and-open, #wb-update-json-save-and-launch').count(), 0);
        assert.equal(await page.locator('.wb-btn-launch, .wb-btn-attach, .wb-btn-close').count(), 0);
        assert(await page.getByRole('tab', { name: '单号登录' }).isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator('#wb-json-input').fill(sessionJson);
        await page.locator('#wb-save-only').click();
        await page.waitForFunction(() => document.querySelector('#wb-json-input').value === '');
        assert.deepEqual(writes.map(write => write.action), [null]);
        await page.getByRole('button', { name: '更换 JSON' }).click();
        await page.locator('#wb-update-json-textarea').fill(sessionJson);
        await page.locator('#wb-update-json-save-only').click();
        await page.locator('#wb-update-json-dialog').waitFor({ state: 'hidden' });
        assert.deepEqual(writes.map(write => write.action), [null, 'update-json']);
        assert.equal(writes[1].body.autoLaunch, false);
      } finally {
        await context.close();
      }
    });
  }
});
