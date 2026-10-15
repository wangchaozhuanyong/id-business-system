#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.runtime/auto-registration-review-20261016/native-UI');
const worker = path.join(root, 'apps/api/src/id-business-v2/auto-registration/worker');
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg.startsWith('--python=')), '未知验收参数');
const python =
  args[0]?.slice('--python='.length) ||
  path.join(root, '.runtime/auto-registration/venv/bin/python');
assert.ok(path.isAbsolute(python) && existsSync(python), '需要项目已有的 Python 解释器及运行依赖');
mkdirSync(output, { recursive: true });

// Import definitions only. Opening SQLite or making an outbound socket fails immediately.
const exported = spawnSync(
  python,
  [
    '-B',
    '-c',
    String.raw`
import hashlib, json, re, socket, sqlite3, sys
from pathlib import Path
from unittest.mock import patch
directory, project = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(directory))
with patch.object(sqlite3, 'connect', side_effect=AssertionError('database disabled')), patch.object(socket.socket, 'connect', side_effect=AssertionError('network disabled')):
    import workspace
    resources = {}
    resources['accounts.html'] = workspace.transform_asset((workspace.UPSTREAM_DIR / 'templates/accounts.html').read_text(), html=True)
    for name in ('utils.js', 'accounts.js'):
        resources[name] = workspace.transform_asset((workspace.UPSTREAM_DIR / 'static/js' / name).read_text(), asset_name=name)
    resources['style.css'] = workspace.transform_asset((workspace.UPSTREAM_DIR / 'static/css/style.css').read_text(), asset_name='style.css')
    for name in ('id-workspace.js', 'id-workspace.css'):
        resources[name] = (directory / name).read_text()
    skin = (project / 'apps/admin/src/v2/styles/base.css').read_text()
    resources['id-system-skin.css'] = re.sub(r"^@import\s+['\"](?:element-plus/theme-chalk/dark/css-vars\.css|\./layout\.css)['\"];\s*", '', skin, flags=re.M)
    sources = [directory / 'workspace.py', directory / 'id-workspace.js', directory / 'id-workspace.css', workspace.UPSTREAM_DIR / 'templates/accounts.html', workspace.UPSTREAM_DIR / 'static/js/utils.js', workspace.UPSTREAM_DIR / 'static/js/accounts.js', workspace.UPSTREAM_DIR / 'static/css/style.css', project / 'apps/admin/src/v2/styles/base.css']
    hashes = {str(item.relative_to(project)): hashlib.sha256(item.read_bytes()).hexdigest() for item in sources}
    print(json.dumps({'resources': resources, 'sourceHashes': hashes}, ensure_ascii=False))
`,
    worker,
    root
  ],
  { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
);
assert.equal(exported.status, 0, `纯资源转换失败：${exported.stderr.slice(0, 1000)}`);
const assets = JSON.parse(exported.stdout);
for (const [name, contents] of Object.entries(assets.resources))
  writeFileSync(path.join(output, name), contents);

const origin = 'https://native-registration.acceptance.invalid';
const prefix = '/api/id-business-v2/auto-registration/workspace';
const taskUuid = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-10-16T01:00:00Z';
const report = {
  status: 'RUNNING',
  sourceHashes: assets.sourceHashes,
  scope: 'ACTUAL_TRANSFORMED_NATIVE_ASSETS_WITH_SYNTHETIC_HTTP_ONLY',
  databaseOpened: false,
  externalRequests: [],
  variants: []
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const variant of [
    { theme: 'light', width: 1440 },
    { theme: 'dark', width: 390 }
  ]) {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: 1000 },
      acceptDownloads: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    const unexpected = [];
    const requests = [];
    let phase = 'partial';
    const facts = () => ({
      sourceTaskUuid: taskUuid,
      provider: 'apple_hidden',
      creationConfirmed: true,
      authorizationStatus: phase === 'partial' ? 'pending' : 'complete',
      syncStatus: phase === 'saved' ? 'saved' : phase === 'partial' ? 'failed' : 'pending',
      systemAccountId: phase === 'saved' ? accountId : null,
      taskRunning: false,
      canResume: phase === 'partial',
      canRetrySync: phase !== 'saved'
    });
    const account = () => ({
      id: 7,
      email: 'native-fixture@example.invalid',
      password: '********',
      email_service: 'apple_hidden',
      status: phase === 'partial' ? 'expired' : 'active',
      cpa_uploaded: false,
      last_refresh: stamp,
      created_at: stamp,
      registration_facts: facts()
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        report.externalRequests.push(url.origin);
        return route.abort();
      }
      const pathname = url.pathname;
      if (pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="注册结果与凭据" style="display:block;width:100%;height:990px;border:0" src="${prefix}/accounts"></iframe><script>
window.nativeMessages=[];window.addEventListener('message',event=>{if(event.origin!==location.origin)return;window.nativeMessages.push(event.data);if(event.data?.type==='id-registration:ready')event.source.postMessage({type:'id-registration:state',theme:'${variant.theme}',draft:{},tokens:{}},location.origin)});
</script></body></html>`
        });
      if (pathname === `${prefix}/accounts`)
        return route.fulfill({ contentType: 'text/html', body: assets.resources['accounts.html'] });
      if (pathname.startsWith(`${prefix}/static/`)) {
        const name = path.basename(pathname);
        const value = assets.resources[name];
        if (value !== undefined)
          return route.fulfill({
            contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css',
            body: value
          });
      }
      const apiPath = pathname.slice(`${prefix}/api`.length);
      const json = (value) =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (pathname.startsWith(`${prefix}/api/`)) {
        requests.push({ method: request.method(), path: apiPath });
        if (request.method() === 'GET' && apiPath === '/accounts/stats/summary')
          return json({
            total: 1,
            by_status: {
              active: phase === 'partial' ? 0 : 1,
              expired: phase === 'partial' ? 1 : 0,
              failed: 0
            }
          });
        if (request.method() === 'GET' && apiPath === '/accounts')
          return json({ accounts: [account()], total: 1, page: 1, page_size: 20 });
        if (
          request.method() === 'POST' &&
          apiPath === `/registration/tasks/${taskUuid}/authorization-resume`
        ) {
          phase = 'verified';
          return json({ accepted: true, taskUuid, record: {} });
        }
        if (
          request.method() === 'POST' &&
          apiPath === `/registration/tasks/${taskUuid}/sync-retry`
        ) {
          phase = 'saved';
          return json({ accepted: true });
        }
        if (
          request.method() === 'POST' &&
          ['/accounts/batch-refresh', '/payment/accounts/batch-upload-tm'].includes(apiPath)
        )
          return json({ success: true, success_count: 1, failed_count: 0, skipped_count: 0 });
        if (request.method() === 'POST' && apiPath === '/accounts/export/json')
          return route.fulfill({
            contentType: 'application/json',
            headers: { 'Content-Disposition': 'attachment; filename=native-fixture.json' },
            body: JSON.stringify([{ id: 7, email: account().email }])
          });
      }
      unexpected.push({ method: request.method(), path: pathname });
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{"detail":"offline route not mapped"}'
      });
    });
    await page.goto(origin, { waitUntil: 'networkidle' });
    const frame = page.frames().find((item) => item.url().endsWith(`${prefix}/accounts`));
    assert.ok(frame, '缺少实际原生注册结果页');
    await frame.getByText('官网已创建 · 待完成授权', { exact: true }).waitFor();
    assert.equal(await frame.locator('html').getAttribute('data-theme'), variant.theme);
    assert.equal(
      await frame.getByRole('heading', { name: '注册结果与凭据', exact: true }).count(),
      1
    );
    assert.equal(await frame.locator('#batch-check-sub-btn').count(), 0);
    assert.equal(await frame.getByRole('columnheader', { name: '订阅', exact: true }).count(), 0);
    assert.equal(await frame.locator('[onclick*="markSubscription"]').count(), 0);
    assert.equal(await frame.locator('a[href$="/payment"]').count(), 0);
    assert.equal(await frame.getByRole('columnheader', { name: '注册资料与台账' }).count(), 1);
    assert.equal(await frame.locator('#batch-refresh-btn').count(), 1);
    assert.equal(await frame.locator('#batch-validate-btn').count(), 1);
    assert.equal(await frame.locator('#export-menu .dropdown-item').count(), 4);
    assert.equal(await frame.locator('#upload-menu .dropdown-item').count(), 3);
    await page.screenshot({
      path: path.join(output, `${variant.theme}-${variant.width}-partial.png`),
      fullPage: true
    });

    await frame.getByRole('button', { name: '继续授权', exact: true }).click();
    await frame.getByText('授权已完成', { exact: true }).waitFor();
    await frame.getByText('等待同步', { exact: true }).waitFor();
    await frame.waitForFunction(
      () =>
        document.getElementById('active-accounts')?.textContent === '1' &&
        document.getElementById('expired-accounts')?.textContent === '0'
    );
    // Exercise the adapter's actual pending timer, without injecting an alternate loader.
    await page.waitForRequest(
      (request) =>
        request.method() === 'GET' && new URL(request.url()).pathname === `${prefix}/api/accounts`
    );
    await frame.getByText('等待同步', { exact: true }).waitFor();
    assert.equal(await frame.getByRole('button', { name: '继续授权', exact: true }).count(), 0);
    await frame.getByRole('button', { name: '重试同步', exact: true }).click();
    await frame.getByText('已同步主台账', { exact: true }).waitFor();
    await frame.getByRole('button', { name: '查看主台账', exact: true }).click();
    await page.waitForFunction(
      (id) =>
        window.nativeMessages.some(
          (item) =>
            item.type === 'id-registration:account-open' &&
            item.page === '/accounts' &&
            item.accountId === id
        ),
      accountId
    );

    await frame.locator('#accounts-table input[data-id="7"]').check();
    await frame.locator('#batch-refresh-btn').click();
    await frame.locator('#confirm-ok').click();
    await frame.getByText('成功刷新 1 个，失败 0 个', { exact: true }).waitFor();
    await frame.locator('#batch-upload-btn').click();
    await frame.locator('#batch-upload-tm-item').click();
    await frame.locator('#confirm-ok').click();
    await frame.getByText('成功: 1', { exact: true }).waitFor();
    await frame.locator('#export-btn').click();
    const downloadPromise = page.waitForEvent('download');
    await frame.locator('#export-menu [data-format="json"]').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'native-fixture.json');
    await download.delete();
    await frame.getByText('导出成功', { exact: true }).waitFor();
    while (await frame.locator('.toast-close').count())
      await frame.locator('.toast-close').first().click();
    await frame.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(output, `${variant.theme}-${variant.width}-saved.png`),
      fullPage: true
    });
    assert.deepEqual(errors, [], '实际变换资产出现页面异常');
    assert.deepEqual(unexpected, [], '出现未定义的离线请求');
    assert.deepEqual(
      requests.filter((request) => request.method === 'POST').map((request) => request.path),
      [
        `/registration/tasks/${taskUuid}/authorization-resume`,
        `/registration/tasks/${taskUuid}/sync-retry`,
        '/accounts/batch-refresh',
        '/payment/accounts/batch-upload-tm',
        '/accounts/export/json'
      ]
    );
    report.variants.push({
      ...variant,
      passed: true,
      states: ['partial', 'verified_pending', 'saved'],
      pageErrors: errors.length,
      requests
    });
    await context.close();
  }
  for (const [file, hash] of Object.entries(assets.sourceHashes))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
      hash,
      `验收过程中源码变化：${file}`
    );
  assert.deepEqual(report.externalRequests, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = String(error);
  throw error;
} finally {
  await browser?.close();
  writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    status: report.status,
    variants: report.variants.length,
    databaseOpened: false,
    externalRequests: report.externalRequests.length,
    output
  })
);
