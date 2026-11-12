import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';
import { withClaudeMailboxCandidates } from '../server/tools/claude-mailbox-candidates.mjs';
import { mailboxPoolCodePage, mailboxPoolMetadata, prepareVerifiedMailboxWrite } from '../server/tools/mailbox-pool.mjs';

test('插件导航、Claude 待授权、授权后取码与可点击邮件链接', { timeout: 90_000 }, async t => {
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.inventory.data.accounts = [
    { id: 'claude-pending', type: 'claude', email: 'pending@example.test', emailType: 'google' },
    { id: 'claude-existing', type: 'claude', email: 'existing@example.test', emailType: 'google' }
  ];
  let snapshot = { version: 1, data: { defaultValidDays: 7, items: Array.from({ length: 23 }, (_, i) => ({
    id: `connected-${i}`, provider: 'google', email: i ? `other-${i}@example.test` : 'existing@example.test',
    active: true, label: '长备注'.repeat(30), expiresAt: '2099-01-01T00:00:00Z', queryCode: 'MBX-' + 'a'.repeat(32)
  })) } };
  const view = () => withClaudeMailboxCandidates(mailboxPoolMetadata(snapshot), fixture.inventory.data);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await interceptDesign(context, { localFixtures: fixture, actor: { id: 'qa', name: '隔离测试', role: 'admin' } });
  let rejectAuthorization = true, queried = 0;
  const codeReads = [];
  await context.route(origin + '/api/local/tools/mailbox-pool', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: view() });
    if (request.method() === 'POST') {
      const command = request.postDataJSON();
      const { id, ids } = command;
      codeReads.push(...(ids || [id]));
      assert((ids || [id]).every(id => !id.startsWith('claude:')), '待授权记录不能读取查询码');
      if (ids) return route.fulfill({ json: mailboxPoolCodePage(snapshot, command) });
      return route.fulfill({ json: { code: snapshot.data.items.find(row => row.id === id).queryCode } });
    }
    try {
      const plan = await prepareVerifiedMailboxWrite(snapshot, request.postDataJSON(), async () => {
        if (rejectAuthorization) throw Error();
      });
      snapshot = { version: snapshot.version + 1, data: plan };
      return route.fulfill({ json: { ...view(), issuedCode: plan.issuedCode } });
    } catch (error) { return route.fulfill({ status: 422, json: { error: error.message } }); }
  });
  await context.route(origin + '/api/local/tools/mailbox-query', route => {
    queried++;
    return route.fulfill({ json: { success: true, items: [{ subject: '合成验证码', extractedCode: '123456',
      body: '<p>验证码 123456</p><a href="https://example.test/verify/synthetic">验证邮箱按钮</a><script>window.injectedMail=true</script><img src="https://tracking.invalid/pixel"><a href="javascript:alert(1)">危险链接</a>' }] } });
  });
  await context.route('https://example.test/verify/synthetic', route => route.fulfill({ body: 'synthetic verification target' }));
  await context.route(origin + '/api/local/tools/sheets-status', route => route.fulfill({ json: {
    state: 'no_receipt', reportedAt: null, verifiedAt: null, failures: null, tabs: []
  } }));
  await context.route(origin + '/api/local/tools/website-visits/search', route => route.fulfill({ json: {
    items: [{ id: 'synthetic-visit', ipMasked: '203.0.*.*', path: '/long-path/'.repeat(20), occurredAt: '2026-11-07T08:00:00Z' }],
    page: 1, pageSize: 20, total: 1, summary: { pageViews: 1, visitors: 1 }, daily: []
  } }));
  await context.route(origin + '/api/local/tools/website-monitor', route => route.fulfill({ json: {
    status: 'reachable', effectiveUrl: 'https://example.test', statusCode: 200, latencyMs: 25, tls: 'valid'
  } }));
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/plugins/mailboxes');
  assert.equal(await page.locator('#drawer').isVisible(), false, '插件使用整页布局');
  await page.locator('#ops-mailbox-pool').waitFor();
  const pool = page.locator('#ops-mailbox-pool');
  await pool.locator('.mailbox-account').first().waitFor();
  await pool.getByRole('searchbox', { name: '搜索邮箱池' }).fill('pending@example.test');
  const pending = pool.locator('.mailbox-account');
  assert.equal(await pending.count(), 1);
  assert.match(await pending.innerText(), /待授权/);
  await pending.locator('[data-action="ops-mailbox-pool-authorize"]').first().click();
  assert.equal(await page.locator('#ops-managed-email').inputValue(), 'pending@example.test');
  assert.equal(await page.locator('#ops-managed-email').getAttribute('readonly'), '');
  assert.equal(await page.locator('#ops-managed-provider').inputValue(), 'google');
  await page.locator('.field').filter({ has: page.locator('#ops-managed-app-password') }).locator('.field-title-help summary').click();
  assert.equal(await page.getByRole('link', { name: '前往 Google 生成', exact: true }).getAttribute('href'), 'https://myaccount.google.com/apppasswords');
  await page.locator('#ops-managed-app-password').fill('synthetic-credential');
  await page.locator('#drawer button[form="ops-managed-pool-form"]').click();
  await page.getByText(/邮箱授权验证失败/).waitFor();
  assert.equal(await page.locator('#ops-managed-app-password').inputValue(), 'synthetic-credential', '失败保留本次输入供重试');
  rejectAuthorization = false;
  await page.locator('#drawer button[form="ops-managed-pool-form"]').click();
  await pending.getByText('可查询', { exact: true }).waitFor();
  assert.equal(await pending.count(), 1, '授权后按邮箱合并，不保留重复待授权记录');
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await pending.locator('[data-action="ops-mailbox-pool-query"]').click();
  const link = page.getByRole('link', { name: '验证邮箱按钮', exact: true });
  await link.waitFor();
  assert.equal(queried, 1);
  assert.equal(await page.evaluate(() => window.injectedMail), undefined);
  assert.equal(await page.locator('.mail-plain-body img, .mail-plain-body script').count(), 0);
  assert.equal(await page.getByRole('link', { name: '危险链接', exact: true }).count(), 0);
  const popupEvent = page.waitForEvent('popup');
  await link.click();
  const popup = await popupEvent;
  await popup.waitForURL('https://example.test/verify/synthetic');
  await popup.close();
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await page.locator('#ops-mailbox-pool').waitFor();
  await pool.getByRole('searchbox', { name: '搜索邮箱池' }).fill('');
  await page.goto(origin + '/#/plugins/websites');
  await page.goto(origin + '/#/plugins/mailboxes');
  await pool.locator('.mailbox-account').first().waitFor();
  const output = root + '/.runtime/plugin-management-20261107';
  await mkdir(output, { recursive: true });
  for (const width of [1440, 1024, 901, 900, 768, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle(page);
    const geometry = await pool.evaluate(el => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      rows: [...el.querySelectorAll('tbody tr')].map(row => ({ height: row.getBoundingClientRect().height,
        cells: [...row.cells].map(cell => getComputedStyle(cell).whiteSpace) }))
    }));
    assert.equal(geometry.overflow, false, JSON.stringify({ width, theme, geometry }));
    assert(geometry.rows.every(row => row.height <= 62 && row.cells.every(value => value === 'nowrap')), '所有数据行保持单行');
    if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/mailboxes-${width}-${theme}.png` });
  }
  await page.goto(origin + '/#/plugins/websites');
  await page.getByRole('tab', { name: '访问统计', exact: true }).click();
  await page.getByRole('heading', { name: '数据中心', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/data');
  await page.goto(origin + '/#/plugins/websites');
  await page.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
  await page.locator('[data-visits-result] table tbody tr').waitFor();
  assert.equal(await page.locator('[data-visits-result] td').nth(1).evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap');
  await page.getByRole('tab', { name: '网站检测', exact: true }).click();
  assert.equal(await page.locator('#ops-website-monitor-form').isVisible(), true);
  await page.locator('#ops-monitor-url').fill('https://example.test');
  await page.locator('#ops-website-monitor-form button[type="submit"]').click();
  await page.locator('#ops-monitor-result').getByText('网站可访问', { exact: true }).waitFor();
  await page.goto(origin + '/#/plugins/sheets');
  await page.getByText('未收到有效回执', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/data/sheets');
  await page.goto(origin + '/#/plugins/mailboxes');
  await page.locator('#ops-mailbox-pool').waitFor();
  assert.equal(await pool.getByRole('searchbox', { name: '搜索邮箱池' }).inputValue(), '');
  assert.deepEqual(errors, []);
  assert(!codeReads.some(id => id.startsWith('claude:')));
});
