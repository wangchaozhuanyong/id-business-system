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
const worker = path.join(root, 'apps/api/src/id-business-v2/auto-registration/worker');
const options = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(python|workspace-js|label)=(.+)$/.exec(argument);
  assert.ok(match && !Object.hasOwn(options, match[1]), '未知或重复的验收参数');
  options[match[1]] = match[2];
}
const python = options.python || path.join(root, '.runtime/auto-registration/venv/bin/python');
const workspaceAsset = options['workspace-js'] || path.join(worker, 'id-workspace.js');
const label = options.label || 'candidate';
assert.match(label, /^[a-z][a-z0-9-]{0,40}$/, '验收输出名称无效');
for (const filename of [python, workspaceAsset])
  assert.ok(path.isAbsolute(filename) && existsSync(filename), '需要已有解释器及实际浏览器资源');
const output = path.join(
  root,
  '.runtime/registration-closure-release/console-draft-acceptance',
  label
);
mkdirSync(output, { recursive: true });

// Read actual served assets only; neither workspace startup nor a database/socket is permitted.
const exported = spawnSync(
  python,
  [
    '-B',
    '-c',
    String.raw`
import hashlib, json, re, socket, sqlite3, sys
from pathlib import Path
from unittest.mock import patch
directory, project, selected_asset = map(Path, sys.argv[1:4])
sys.path.insert(0, str(directory))
with patch.object(sqlite3, 'connect', side_effect=AssertionError('database disabled')), patch.object(socket.socket, 'connect', side_effect=AssertionError('network disabled')):
    import workspace
    resources = {}
    sources = [directory / 'workspace.py', selected_asset, directory / 'id-workspace.css']
    for name in ('index.html', 'accounts.html'):
        source = workspace.UPSTREAM_DIR / 'templates' / name
        sources.append(source)
        resources[name] = workspace.transform_asset(source.read_text(), html=True)
    for name in ('utils.js', 'app.js', 'accounts.js'):
        source = workspace.UPSTREAM_DIR / 'static/js' / name
        sources.append(source)
        resources[name] = workspace.transform_asset(source.read_text(), asset_name=name)
    source = workspace.UPSTREAM_DIR / 'static/css/style.css'
    sources.append(source)
    resources['style.css'] = workspace.transform_asset(source.read_text(), asset_name='style.css')
    resources['id-workspace.js'] = selected_asset.read_text()
    resources['id-workspace.css'] = (directory / 'id-workspace.css').read_text()
    skin = project / 'apps/admin/src/v2/styles/base.css'
    sources.append(skin)
    resources['id-system-skin.css'] = re.sub(r"^@import\s+['\"](?:element-plus/theme-chalk/dark/css-vars\.css|\./layout\.css)['\"];\s*", '', skin.read_text(), flags=re.M)
    print(json.dumps({'resources': resources, 'sourceHashes': {str(item): hashlib.sha256(item.read_bytes()).hexdigest() for item in sources}}, ensure_ascii=False))
`,
    worker,
    root,
    workspaceAsset
  ],
  { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
);
assert.equal(exported.status, 0, `纯资源转换失败：${exported.stderr.slice(0, 1000)}`);
const assets = JSON.parse(exported.stdout);
const assetSha256 = createHash('sha256').update(readFileSync(workspaceAsset)).digest('hex');
for (const [name, contents] of Object.entries(assets.resources))
  writeFileSync(path.join(output, name), contents);

const origin = 'https://registration-console-draft.acceptance.invalid';
const prefix = '/api/id-business-v2/auto-registration/workspace';
const mailboxA = '11111111-1111-4111-8111-111111111111';
const mailboxB = '22222222-2222-4222-8222-222222222222';
const proxyA = '33333333-3333-4333-8333-333333333333';
const proxyB = '44444444-4444-4444-8444-444444444444';
const candidates = (phase = 'available') => ({
  items: [
    ...(phase === 'removed'
      ? []
      : [
          {
            aliasId: mailboxA,
            email: 'first-mailbox@example.invalid',
            revision: 'first-fixture-revision',
            registrationStatus: 'unregistered',
            canRegister: phase !== 'expired',
            blockedReason: phase === 'expired' ? '邮箱授权已过期' : null
          }
        ]),
    {
      aliasId: mailboxB,
      email: 'second-mailbox@example.invalid',
      revision: 'second-fixture-revision',
      registrationStatus: 'unregistered',
      canRegister: true
    }
  ],
  proxies: [
    ...(phase === 'removed' ? [] : [{ id: proxyA, label: '测试代理甲 · 菲律宾' }]),
    { id: proxyB, label: '测试代理乙 · 美国' }
  ]
});
const report = {
  status: 'RUNNING',
  scope: 'ACTUAL_STATIC_ASSETS_BROWSER_WITH_SYNTHETIC_HTTP_AND_IN_MEMORY_PARENT_DRAFT',
  sourceHashes: assets.sourceHashes,
  acceptanceScriptSha256: createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex'),
  workspaceAsset,
  assetSha256,
  databaseOpened: false,
  websiteOrDatabaseStarted: false,
  registrationStarts: 0,
  outboundRequests: [],
  unexpectedRequests: [],
  assertions: [],
  serviceRebuilds: 0
};
let browser;
let page;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block'
  });
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  const deferredServices = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.addInitScript(() => {
    window.observedServiceChanges = [];
    document.addEventListener(
      'change',
      (event) => {
        if (event.target.id === 'email-service')
          window.observedServiceChanges.push({
            value: event.target.value,
            mailbox: document.getElementById('id-apple-choice')?.value,
            proxy: document.getElementById('id-system-route')?.value
          });
      },
      true
    );
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.outboundRequests.push(url.origin);
      return route.abort();
    }
    const json = (value) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><button id="open-console">注册控制台</button><button id="open-accounts">注册结果与凭据</button><script>
window.draftBridge={drafts:{},messages:[],pending:[],starts:[],readyPages:[]};
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==document.getElementById('workspace')?.contentWindow)return;
  const message=event.data;const bridge=window.draftBridge;
  if(message?.type==='id-registration:draft'){bridge.drafts[message.page]=structuredClone(message.values);bridge.messages.push(message);}
  if(message?.type==='id-registration:ready'){bridge.readyPages.push(message.page);event.source.postMessage({type:'id-registration:state',theme:'light',tokens:{},draft:bridge.drafts[message.page]||{}},location.origin);}
  if(message?.type==='id-registration:apple-request'){
    if(message.action==='candidates')bridge.pending.push({source:event.source,message});
    else{bridge.starts.push(message.action);event.source.postMessage({type:'id-registration:apple-response',requestId:message.requestId,ok:false,error:'离线验收禁止执行注册或任务操作'},location.origin);}
  }
});
window.replyCandidates=(data,ok=true)=>{const pending=window.draftBridge.pending.splice(0);for(const request of pending)request.source.postMessage({type:'id-registration:apple-response',requestId:request.message.requestId,ok,data,error:ok?undefined:'合成候选读取失败，请重试'},location.origin);return pending.length;};
window.openWorkspace=page=>{document.getElementById('workspace').src='${prefix}'+page;};
document.getElementById('open-console').onclick=()=>window.openWorkspace('/');
document.getElementById('open-accounts').onclick=()=>window.openWorkspace('/accounts');
</script><iframe id="workspace" title="自动注册工作区" style="display:block;width:100%;height:960px;border:0" src="${prefix}/"></iframe></body></html>`
      });
    if ([`${prefix}/`, `${prefix}/accounts`].includes(url.pathname))
      return route.fulfill({
        contentType: 'text/html',
        body: assets.resources[url.pathname.endsWith('/accounts') ? 'accounts.html' : 'index.html']
      });
    if (url.pathname.startsWith(`${prefix}/static/`)) {
      const name = path.basename(url.pathname);
      if (Object.hasOwn(assets.resources, name))
        return route.fulfill({
          contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css',
          body: assets.resources[name]
        });
    }
    if (url.pathname.startsWith(`${prefix}/api/`)) {
      const apiPath = url.pathname.slice(`${prefix}/api`.length);
      if (request.method() !== 'GET') {
        report.registrationStarts++;
        report.unexpectedRequests.push({ method: request.method(), path: apiPath });
        return route.fulfill({ status: 409, body: '{"detail":"offline writes forbidden"}' });
      }
      if (apiPath === '/registration/available-services') {
        deferredServices.push(route);
        return;
      }
      if (apiPath === '/accounts') return json({ accounts: [], total: 0, page: 1, page_size: 20 });
      if (apiPath === '/accounts/stats/summary')
        return json({ total: 0, by_status: { active: 0, expired: 0, failed: 0 } });
      if (['/cpa-services', '/sub2api-services', '/tm-services'].includes(apiPath)) return json([]);
    }
    report.unexpectedRequests.push({ method: request.method(), path: url.pathname });
    return route.fulfill({ status: 404, body: '{"detail":"offline route not mapped"}' });
  });

  const frame = () => page.frames().find((item) => item.url() === `${origin}${prefix}/`);
  const waitConsole = async () => {
    await page.waitForFunction(() => {
      const child = document.getElementById('workspace')?.contentDocument;
      return child?.getElementById('id-apple-choice') && child.readyState === 'complete';
    });
    return frame();
  };
  const releaseUpstreamServices = async (target) => {
    assert.equal(deferredServices.length, 1, '必须经过上游实际异步邮箱服务加载');
    await deferredServices.shift().fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        tempmail: { available: true, services: [{ id: 'fixture', name: '合成临时邮箱服务' }] },
        outlook: { available: false, count: 0, services: [] },
        custom_domain: { available: false, count: 0, services: [] },
        temp_mail: { available: false, count: 0, services: [] }
      })
    });
    await target.locator('#email-service option[value="tempmail:fixture"]').waitFor({
      state: 'attached'
    });
    report.serviceRebuilds++;
  };
  const reply = async (data, ok = true) => {
    await page.waitForFunction(() => window.draftBridge.pending.length > 0);
    // Drain the real service observer's message task before releasing delayed candidates.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
        )
    );
    const delivered = await page.evaluate(({ data, ok }) => window.replyCandidates(data, ok), {
      data,
      ok
    });
    assert.ok(delivered > 0);
    await frame().waitForFunction(() => !document.getElementById('id-apple-refresh').disabled);
  };
  const assertDraft = async (mailbox, proxy) => {
    await page.waitForFunction(
      ({ mailbox, proxy }) =>
        window.draftBridge.drafts['/']?.['id-apple-choice'] === mailbox &&
        window.draftBridge.drafts['/']?.['id-system-route'] === proxy,
      { mailbox, proxy }
    );
  };
  const assertSelection = async (target, mailbox, proxy) => {
    assert.equal(
      await target.locator('#id-apple-choice').inputValue(),
      mailbox,
      '指定邮箱被空选项覆盖'
    );
    assert.equal(
      await target.locator('#id-system-route').inputValue(),
      proxy,
      '指定代理被空选项覆盖'
    );
    await assertDraft(mailbox, proxy);
  };
  const submitWithoutStarting = async (target) => {
    await target
      .locator('#registration-form')
      .evaluate((form) =>
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      );
    assert.deepEqual(await page.evaluate(() => window.draftBridge.starts), []);
  };

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  let target = await waitConsole();
  await releaseUpstreamServices(target);
  await target.locator('#email-service').selectOption('apple_hidden');
  await reply(candidates());
  await target.locator('#id-apple-choice').selectOption(mailboxA);
  await target.locator('#id-system-route').selectOption(proxyA);
  await assertSelection(target, mailboxA, proxyA);
  report.assertions.push('用户指定 UUID 邮箱和代理写入所属页内存草稿');

  await page.locator('#open-accounts').click();
  await page
    .frameLocator('#workspace')
    .getByRole('heading', { name: '注册结果与凭据', exact: true })
    .waitFor();
  await page.locator('#open-console').click();
  target = await waitConsole();
  await page.waitForFunction(() => window.draftBridge.pending.length > 0);
  assert.equal(await target.locator('#id-apple-choice').inputValue(), '');
  assert.equal(await target.locator('#id-system-route').inputValue(), '');
  const changesBefore = await target.evaluate(() => window.observedServiceChanges.length);
  // Delay candidates until the real app.js fetch rebuilds its select and ensureService emits change.
  await releaseUpstreamServices(target);
  await target.waitForFunction(
    (count) =>
      window.observedServiceChanges.length > count &&
      window.observedServiceChanges.at(-1)?.value === 'apple_hidden',
    changesBefore
  );
  report.serviceChangeWhileCandidatesEmpty = await target.evaluate(() =>
    window.observedServiceChanges.at(-1)
  );
  await reply(candidates());
  await assertSelection(target, mailboxA, proxyA);
  report.assertions.push('切凭据页返回且候选晚于真实服务重建时，原 UUID 选择不被初始化空值覆盖');

  await target.locator('#id-apple-refresh').click();
  await reply(candidates('removed'));
  await assertSelection(target, mailboxA, proxyA);
  assert.equal(await target.locator('#id-apple-choice option:checked').isDisabled(), true);
  assert.equal(await target.locator('#id-system-route option:checked').isDisabled(), true);
  assert.match(
    await target.locator('#id-apple-choice option:checked').textContent(),
    /原选邮箱已不可用/
  );
  assert.match(
    await target.locator('#id-system-route option:checked').textContent(),
    /原选代理已不可用/
  );
  await submitWithoutStarting(target);
  await target.getByText('原选代理已不可用，请重新选择代理后再提交', { exact: true }).waitFor();
  report.assertions.push('移除的原邮箱和代理显示不可用，保留原值且禁止提交，不自动选默认项');

  await target.locator('#id-apple-refresh').click();
  await reply(candidates('expired'));
  await assertSelection(target, mailboxA, proxyA);
  assert.equal(await target.locator('#id-apple-choice option:checked').isDisabled(), true);
  assert.match(
    await target.locator('#id-apple-choice option:checked').textContent(),
    /邮箱授权已过期/
  );
  await submitWithoutStarting(target);
  await target.getByText('所选邮箱已不可用，请刷新邮箱池', { exact: true }).waitFor();
  report.assertions.push('过期原邮箱仍显示原值和过期原因，禁止提交');

  await target.locator('#id-apple-choice').selectOption(mailboxB);
  await target.locator('#id-system-route').selectOption(proxyB);
  await assertSelection(target, mailboxB, proxyB);
  report.assertions.push('用户真实重新选择能够更新草稿');
  await target.locator('#id-apple-refresh').click();
  await reply(null, false);
  await target.getByText('合成候选读取失败，请重试', { exact: true }).waitFor();
  await assertSelection(target, mailboxB, proxyB);
  assert.equal(await target.locator('#start-btn').isDisabled(), true);
  await submitWithoutStarting(target);
  report.assertions.push('候选刷新失败保留现有选择和草稿，禁用开始并拒绝程序化提交');
  await target.locator('#id-apple-refresh').click();
  await reply(candidates());
  await assertSelection(target, mailboxB, proxyB);
  assert.equal(await target.locator('#start-btn').isDisabled(), false);
  report.assertions.push('候选恢复后仍保留新选择，仅恢复可操作状态而不执行注册');
  await page.screenshot({ path: path.join(output, 'console-draft-restored.png'), fullPage: true });

  report.parentDrafts = await page.evaluate(() => window.draftBridge.drafts);
  report.bridgeStartActions = await page.evaluate(() => window.draftBridge.starts);
  report.readyPages = await page.evaluate(() => window.draftBridge.readyPages);
  report.pageErrors = pageErrors;
  assert.deepEqual(report.readyPages, ['/', '/accounts', '/']);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(report.bridgeStartActions, []);
  assert.equal(report.registrationStarts, 0);
  assert.deepEqual(report.outboundRequests, []);
  assert.deepEqual(report.unexpectedRequests, []);
  assert.equal(report.serviceRebuilds, 2);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = error.stack || String(error);
  if (page) {
    const snapshot = await page
      .evaluate(() => ({
        parentDrafts: window.draftBridge?.drafts,
        bridgeStartActions: window.draftBridge?.starts,
        readyPages: window.draftBridge?.readyPages
      }))
      .catch(() => ({}));
    Object.assign(report, snapshot);
    await page
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`PASS console draft: ${report.assertions.length} lifecycle assertions; ${assetSha256}`);
