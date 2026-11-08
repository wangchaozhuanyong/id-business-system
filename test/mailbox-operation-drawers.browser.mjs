import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('邮箱池行操作使用右侧抽屉，查询、授权、状态、查询码和关闭保护保持完整', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  let release, releaseOAuth;
  t.after(async () => { release?.(); releaseOAuth?.(); await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await interceptDesign(context, { localFixtures: {}, actor: { id: 'drawer-admin', name: '合成管理员', role: 'admin' } });
  let snapshot = { version: 1, defaultValidDays: 7, items: ['google', 'apple', 'microsoft', 'google', 'relay'].map((provider, index) => ({
    id: `drawer-${index}`, email: `drawer-${index}@example.test`, label: '仅用于离线界面测试', provider,
    active: true, authorizationPending: index === 3, expiresAt: '2099-01-01T00:00:00Z'
  })) };
  let fail = true, oauthStarts = 0, slow = false, requestStarted, slowOAuth = false, oauthRequested, queryReads = 0;
  const writes = [], errors = [];
  await context.route(origin + '/api/local/tools/mailbox-pool', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: snapshot });
    const command = request.postDataJSON();
    if (request.method() === 'POST') return route.fulfill({ json: { code: `MBX-SYNTHETIC-${command.id}` } });
    writes.push(command);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '合成保存失败，请重试' } }); }
    snapshot = { ...snapshot, version: snapshot.version + 1, items: snapshot.items.map(row => row.id === command.id
      ? { ...row, active: command.action === 'status' ? command.active : row.active, authorizationPending: false } : row) };
    return route.fulfill({ json: { ...snapshot, ...(command.action === 'rotate' ? { issuedCode: 'MBX-SYNTHETIC-NEW-CODE' } : {}) } });
  });
  await context.route(origin + '/api/local/tools/mailbox-query', async route => {
    queryReads++;
    if (slow) { requestStarted?.(); await new Promise(resolve => { release = resolve; }); }
    return route.fulfill({ json: { email: 'drawer-0@example.test', items: [{ subject: slow ? '迟到的合成邮件' : '合成验证码邮件',
      extractedCode: '000000', body: '<p>虚构邮件内容</p><script>window.mailInjected=true</script><a href="https://example.test/verify">验证按钮</a>' }] } });
  });
  await context.route(origin + '/api/local/tools/mailbox-microsoft/start', async route => {
    oauthStarts++;
    if (slowOAuth) { oauthRequested?.(); await new Promise(resolve => { releaseOAuth = resolve; }); }
    return route.fulfill({ json: { authorizationId: 'synthetic-authorization', authorizationUrl: 'https://authorization.invalid/test' } });
  });
  await context.route('https://authorization.invalid/**', route => route.fulfill({ body: '离线合成授权页面' }));
  await context.route(origin + '/api/local/tools/mailbox-microsoft/finish', route => route.fulfill({ json: { ...snapshot, status: 'saved' } }));
  const evidence = new URL('../.runtime/mailbox-operation-drawers-20261108/', import.meta.url);
  if (process.env.ID_MAILBOX_DRAWER_SCREENSHOTS === '1') await mkdir(evidence, { recursive: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  async function bounded(promise, label) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '未开始或未完成')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const drawer = page.locator('#drawer');
  const pool = page.locator('#ops-mailbox-pool');
  const row = id => pool.locator('.mailbox-account').filter({ has: page.locator('strong', { hasText: `drawer-${id}@example.test` }) });
  async function more(id, label) {
    await row(id).locator('.mailbox-account__more').click();
    await row(id).locator('.mailbox-account__actions:popover-open').getByRole('button', { name: label, exact: true }).click();
    await drawer.locator('[data-mailbox-operation]').waitFor();
  }
  async function close() {
    await drawer.locator(':is([data-action="drawer-close"], [data-action="ops-mailbox-pool-cancel"]):visible').first().click();
    await drawer.waitFor({ state: 'hidden' });
  }
  async function submit() {
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/tools/mailbox-pool');
    await drawer.locator('button[form="ops-managed-pool-form"]').click();
    return (await response).status();
  }
  await page.goto(origin + '/#/plugins/mailboxes');
  await page.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
  await row(0).waitFor();
  await pool.getByRole('searchbox', { name: '搜索邮箱池' }).fill('drawer-');
  const listBefore = await pool.locator('.mailbox-account').count();
  await row(0).getByRole('button', { name: '查询', exact: true }).click();
  await drawer.getByText('合成验证码邮件', { exact: true }).waitFor();
  assert.equal(await page.locator('#ops-managed-mail-query').count(), 1, '复用查询表单，无重复编号');
  assert.equal(await page.getByRole('tab', { name: '邮箱池管理', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.mailInjected), undefined);
  const optionAlignment = await drawer.locator('#ops-managed-mail-query').evaluate(form => Math.abs(form.querySelector('#ops-managed-query-limit').getBoundingClientRect().top - form.querySelector('[type="submit"]').getBoundingClientRect().top));
  assert(optionAlignment <= 1, '查询封数和查询按钮在同一视觉行');
  assert.equal(await drawer.locator('#ops-managed-query-code').isVisible(), false, '按行查询无需再次填写查询码');
  if (process.env.ID_MAILBOX_DRAWER_SCREENSHOTS === '1') await drawer.screenshot({ path: fileURLToPath(new URL('query-1440.png', evidence)) });
  await close();
  assert.equal(await pool.getByRole('searchbox', { name: '搜索邮箱池' }).inputValue(), 'drawer-');
  assert.equal(await pool.locator('.mailbox-account').count(), listBefore);
  assert.equal(await page.locator('#ops-mailbox-query-panel #ops-managed-query-code').inputValue(), '');
  await more(0, '更新授权');
  assert.match(await drawer.locator('.mailbox-operation-summary').innerText(), /drawer-0@example.test/);
  await drawer.locator('#ops-managed-app-password').fill('synthetic-app-credential');
  assert.equal(await submit(), 503);
  await drawer.getByRole('alert').getByText('合成保存失败，请重试', { exact: true }).waitFor();
  assert.equal(await drawer.locator('#ops-managed-app-password').inputValue(), 'synthetic-app-credential');
  assert.equal(await submit(), 200);
  await drawer.locator('#ops-managed-pool-form').waitFor({ state: 'detached' });
  await close();
  await more(0, '更新授权');
  assert.equal(await drawer.locator('#ops-managed-app-password').inputValue(), '');
  await close();
  await more(0, '重置查询码');
  await drawer.locator('#ops-managed-days').fill('14');
  await close();
  await more(0, '重置查询码');
  assert.equal(await drawer.locator('#ops-managed-days').inputValue(), '14');
  assert.equal(await submit(), 200);
  await drawer.getByText('MBX-SYNTHETIC-NEW-CODE', { exact: true }).waitFor();
  await close();
  await more(0, '停用');
  assert.equal(writes.at(-1).action, 'rotate', '打开启停抽屉不会立即写入');
  await drawer.getByRole('button', { name: '确认停用', exact: true }).click();
  await row(0).getByText('已停用', { exact: true }).waitFor();
  await close();
  await row(2).getByRole('button', { name: '去授权', exact: true }).click();
  assert.equal(await drawer.locator('[data-mailbox-operation="oauth"]').count(), 1);
  assert.equal(oauthStarts, 0, '进入授权抽屉不提前执行 OAuth');
  const popupEvent = page.waitForEvent('popup');
  await drawer.getByRole('button', { name: '前往 Microsoft 授权', exact: true }).click();
  const popup = await popupEvent;
  await drawer.getByRole('button', { name: '核对并保存授权', exact: true }).waitFor();
  assert.equal(oauthStarts, 1);
  await popup.close();
  await close();
  await row(4).getByRole('button', { name: '去授权', exact: true }).click();
  assert.equal(await drawer.locator('[data-mailbox-operation="relay"]').count(), 1);
  assert(page.url().endsWith('#/plugins/mailboxes'));
  await close();
  await row(3).getByRole('button', { name: '去授权', exact: true }).click();
  assert.equal(await drawer.locator('#ops-managed-email').inputValue(), 'drawer-3@example.test');
  await close();

  slowOAuth = true;
  const oauthStarted = new Promise(resolve => { oauthRequested = resolve; });
  await row(2).getByRole('button', { name: '去授权', exact: true }).click();
  const delayedPopupEvent = page.waitForEvent('popup');
  await drawer.getByRole('button', { name: '前往 Microsoft 授权', exact: true }).click();
  const delayedPopup = await delayedPopupEvent;
  await bounded(oauthStarted, '延迟授权请求');
  await close();
  await more(1, '更新授权');
  const popupClosed = delayedPopup.waitForEvent('close');
  releaseOAuth();
  await bounded(popupClosed, '关闭过期授权窗口');
  assert.equal(await drawer.locator('#ops-managed-app-password').count(), 1);
  assert.equal(await drawer.getByRole('button', { name: '核对并保存授权', exact: true }).count(), 0, '迟到授权不覆盖其他操作');
  await close();
  slowOAuth = false;

  for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => innerWidth > 900 || document.querySelector('#sidebar').getBoundingClientRect().right <= 0);
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await more(1, '更新授权');
    const dismiss = page.locator('.toast-dismiss:visible');
    if (await dismiss.count()) await dismiss.click();
    const layout = await drawer.evaluate(node => {
      const r = node.getBoundingClientRect(), footer = node.querySelector('.drawer-footer').getBoundingClientRect();
      const fields = [...node.querySelectorAll('.field')].filter(field => field.checkVisibility());
      return { fits: r.left >= 0 && r.right <= innerWidth && footer.bottom <= innerHeight,
        noOverflow: node.scrollWidth <= node.clientWidth, fields: fields.length };
    });
    assert(layout.fits && layout.noOverflow, JSON.stringify({ width, dark, layout }));
    if (process.env.ID_MAILBOX_DRAWER_SCREENSHOTS === '1' && !dark && width !== 320)
      await page.screenshot({ path: fileURLToPath(new URL(`authorization-${width}.png`, evidence)) });
    await close();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  slow = true;
  const started = new Promise(resolve => { requestStarted = resolve; });
  await row(1).getByRole('button', { name: '查询', exact: true }).click();
  await bounded(started, '延迟邮件查询');
  await close();
  await more(1, '更新授权');
  const finished = page.waitForResponse(r => new URL(r.url()).pathname === '/api/local/tools/mailbox-query');
  release();
  await finished;
  assert.equal(await drawer.getByText('迟到的合成邮件', { exact: true }).count(), 0);
  assert.equal(await drawer.locator('#ops-managed-app-password').count(), 1);
  await close();
  slow = false;
  await page.goto(origin + '/#/overview');
  await page.getByRole('button', { name: '在线工具', exact: true }).click();
  await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'operations').onClick('tool-open', { dataset: { name: '邮箱查询与邮箱池' } }));
  await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
  await row(1).getByRole('button', { name: '去授权', exact: true }).click();
  assert.equal(await drawer.locator('#ops-mailbox-pool #ops-managed-pool-form').isVisible(), true, '已有在线工具抽屉内继续使用原表单，不破坏父界面');
  await pool.getByRole('button', { name: '取消', exact: true }).click();
  await row(1).getByRole('button', { name: '查询', exact: true }).click();
  await drawer.getByText('合成验证码邮件', { exact: true }).waitFor();
  assert.equal(await drawer.getByRole('tab', { name: '邮件查询', exact: true }).getAttribute('aria-selected'), 'true');
  const drafts = await page.evaluate(() => JSON.stringify([...window.IDDesignAPI.state.drafts.values()]));
  assert(!drafts.includes('synthetic-app-credential') && !drafts.includes('MBX-SYNTHETIC') && !drafts.includes('合成验证码邮件'));
  assert.deepEqual(errors, []);
});
