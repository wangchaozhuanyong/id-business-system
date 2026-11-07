import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

test('redemption workspace aligns navigation, steps, account summary and actions without submitting a recharge', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL, headless: true });
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || path.join(root, '.runtime/redeem-layout-20261108');
  await mkdir(output, { recursive: true });
  const baseline = process.env.ID_REDEEM_QA_BASELINE === '1';
  const oldAssets = baseline ? JSON.parse(await readFile(path.join(output, 'before-assets.json'), 'utf8')).assets : null;
  const results = [];
  const prefix = '/integrations/codexdaichong';
  for (const width of baseline ? [1440] : [1440, 1024, 768, 390, 320]) for (const theme of baseline ? ['light'] : ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const intercepted = await interceptDesign(context);
    const mutations = [];
    await context.route(origin + prefix + '/api/**', async route => {
      const resource = new URL(route.request().url()).pathname.slice((prefix + '/api/').length);
      if (resource === 'verify-cdk') return route.fulfill({ json: { success: true, data: { plan_type: 'plus', plan_label: 'Plus（离线验收）' } } });
      if (route.request().method() !== 'GET') { mutations.push(resource); return route.abort(); }
      return intercepted.handle(route);
    });
    await context.route(origin + prefix + '/**', async route => {
      const url = new URL(route.request().url()), resource = url.pathname.slice(prefix.length);
      if (resource.startsWith('/api/')) return route.fallback();
      if (resource === '/workspace') {
        let asset = oldAssets?.[resource];
        if (!asset) {
          const { loadCodexdaichongAssets } = await import('../modules/recharge/codexdaichong/assets.mjs');
          asset = (await loadCodexdaichongAssets()).get(resource);
        }
        const html = asset.body.toString().replace('<html ', `<html data-id-theme="${theme}" `);
        return route.fulfill({ body: html, contentType: asset.type, headers: { 'Content-Security-Policy': asset.csp } });
      }
      if (oldAssets?.[resource]) return route.fulfill({ body: oldAssets[resource].body, contentType: oldAssets[resource].type });
      return route.fallback();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.goto(origin + prefix + '/workspace');
    await page.locator('body[data-standalone]').waitFor();
    await page.locator('#step1 .title-with-help').waitFor();
    await settle(page);
    const measure = () => page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { page: rect('.page-shell'), toolbar: rect('.workspace-recharge-heading'), step1: rect('#step1'), step2: rect('#step2'), codeLabel: rect('label[for="cdkInput"]'), accountLabel: rect('label[for="tokenInput"]'), code: rect('#cdkInput'), verify: rect('#redeemBtn'), account: rect('#tokenInput'), summary: rect('.workspace-recharge-summary'), submit: rect('#startBtn'), overflow: document.documentElement.scrollWidth > innerWidth, theme: document.documentElement.dataset.idTheme };
    });
    const initial = await measure();
    if (!baseline) {
      assert(!initial.overflow, `${width} ${theme}: page overflow`);
      assert.equal(initial.theme, theme);
      assert.equal(initial.step1.left, initial.step2.left);
      assert.equal(initial.step1.right, initial.step2.right);
      assert.equal(initial.code.left, initial.account.left, 'Form controls must share one left edge');
      assert(initial.codeLabel.right < initial.code.left && initial.accountLabel.right < initial.account.left, 'Labels stay to the left');
      assert.equal(initial.codeLabel.top, initial.code.top);
      assert.equal(initial.accountLabel.top, initial.account.top);
      if (width > 600) {
        assert.equal(initial.code.top, initial.verify.top);
        assert(Math.abs(initial.verify.right - initial.account.right) <= 1);
        assert(Math.abs(initial.submit.right - initial.account.right + 12) <= 1, 'Submit stays inside the aligned summary bar');
        assert(Math.abs(initial.submit.top + initial.submit.bottom - initial.summary.top - initial.summary.bottom) <= 2, 'Submit and summary stay vertically centered');
      }
      assert(initial.verify.height >= (width <= 900 ? 44 : 36));
      assert(initial.submit.height >= (width <= 900 ? 44 : 36));
      assert(await page.locator('#tokenInput').isDisabled());
      assert(await page.locator('#startBtn').isDisabled());
    }
    if (baseline || [1440, 390, 320].includes(width)) await page.screenshot({ path: path.join(output, `${baseline ? 'before' : 'after'}-${width}-${theme}.png`), fullPage: true });
    results.push({ width, theme, initial });
    if (baseline) { await context.close(); continue; }
    const help = page.locator('#step2 .title-with-help summary');
    await help.click();
    assert.equal((await measure()).step2.height, initial.step2.height, 'Help must not change layout');
    await page.getByRole('link', { name: '如何获取账号资料？', exact: true }).click();
    await page.locator('#workspaceGuide:not([hidden])').waitFor();
    assert(await page.locator('#flowStatusBadge').isHidden());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: '自助充值', exact: true }).click();
    await page.locator('#cdkInput').fill('LAYOUT-ONLY');
    await page.locator('#redeemBtn').click();
    await page.locator('#workspaceVerifiedPlan:not([hidden])').waitFor();
    assert(!(await page.locator('#tokenInput').isDisabled()));
    await page.locator('#tokenInput').fill('invalid fixture');
    await page.locator('#workspaceAccountHint').filter({ hasText: /JSON|资料/ }).waitFor();
    assert(await page.locator('#startBtn').isDisabled());
    const part = data => Buffer.from(JSON.stringify(data)).toString('base64url');
    const json = JSON.stringify({ user: { id: 'layout-fixture', email: 'layout@example.test' }, accessToken: [part({ typ: 'JWT', alg: 'RS256' }), part({ iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], scp: ['model.request'], exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_user_id: 'fixture' } }), 'synthetic'].join('.') });
    await page.locator('#tokenInput').fill(json);
    await page.locator('#workspaceAccount').filter({ hasText: 'layout@example.test' }).waitFor();
    await page.locator('#startBtn:not([disabled])').waitFor();
    await page.getByRole('button', { name: '兑换码查询', exact: true }).click();
    await page.locator('#querySection').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#queryInput').inputValue(), 'LAYOUT-ONLY');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const query = await page.locator('#querySection').boundingBox();
    assert(Math.abs(query.x - initial.step1.left) <= 1, 'Tabs use the same panel edge');
    await page.getByRole('button', { name: '自助充值', exact: true }).click();
    assert.equal(await page.locator('#tokenInput').inputValue(), json);
    assert.deepEqual(mutations, [], 'No recharge or payment request may be submitted');
    assert.deepEqual(errors, []);
    assert.deepEqual(intercepted.unavailable, []);
    assert.deepEqual(intercepted.external, []);
    await context.close();
  }
  if (!baseline) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const intercepted = await interceptDesign(context, { localFixtures: {}, actor: { id: 'fixture', name: '离线验收', role: 'admin' } });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(origin + '/#/workspace/recharge');
    const frame = page.frameLocator('#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])');
    await frame.locator('[data-recharge-workspace] #step1').waitFor();
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    await settle(page);
    assert.equal(await frame.locator('.workspace-recharge-standalone-title').count(), 0, 'Embedded view uses the host title');
    const geometry = await frame.locator('body').evaluate(body => {
      const rect = selector => body.querySelector(selector).getBoundingClientRect().toJSON();
      return { step1: rect('#step1'), step2: rect('#step2'), code: rect('#cdkInput'), account: rect('#tokenInput'), overflow: document.documentElement.scrollWidth > innerWidth, theme: document.documentElement.dataset.idTheme };
    });
    assert.equal(geometry.theme, theme);
    assert(!geometry.overflow);
    assert.equal(geometry.step1.left, geometry.step2.left);
    assert.equal(geometry.code.left, geometry.account.left);
    await page.screenshot({ path: path.join(output, `after-embedded-${width}-${theme}.png`), fullPage: true });
    results.push({ width, theme, embedded: true, geometry });
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
    await context.close();
  }
  await writeFile(path.join(output, baseline ? 'before-geometry.json' : 'geometry.json'), JSON.stringify(results, null, 2));
});
