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
const distribution = path.join(root, 'apps/admin/dist');
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every((arg) => arg.startsWith('--python=')));
const python = args[0]?.slice(9) || path.join(root, '.runtime/auto-registration/venv/bin/python');
assert.ok(path.isAbsolute(python) && existsSync(python));
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端');
const output = path.join(root, '.runtime/registration-browser-20261016/browser');
mkdirSync(output, { recursive: true });
const exported = spawnSync(
  python,
  [
    '-B',
    '-c',
    String.raw`
import json,re,socket,sqlite3,sys
from pathlib import Path
from unittest.mock import patch
directory,project=map(Path,sys.argv[1:3]);sys.path.insert(0,str(directory))
with patch.object(sqlite3,'connect',side_effect=AssertionError('database disabled')),patch.object(socket.socket,'connect',side_effect=AssertionError('network disabled')):
 import workspace
 resources={'index.html':workspace.transform_asset((workspace.UPSTREAM_DIR/'templates/index.html').read_text(),html=True)}
 for name in ('app.js','utils.js'):
  resources[name]=workspace.transform_asset((workspace.UPSTREAM_DIR/'static/js'/name).read_text(),asset_name=name)
 resources['style.css']=workspace.transform_asset((workspace.UPSTREAM_DIR/'static/css/style.css').read_text(),asset_name='style.css')
 for name in ('id-workspace.js','id-workspace.css'):resources[name]=(directory/name).read_text()
 skin=(project/'apps/admin/src/v2/styles/base.css').read_text()
 resources['id-system-skin.css']=re.sub(r"^@import\s+['\"](?:element-plus/theme-chalk/dark/css-vars\.css|\./layout\.css)['\"];\s*",'',skin,flags=re.M)
 print(json.dumps(resources,ensure_ascii=False))
`,
    worker,
    root
  ],
  { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
);
assert.equal(exported.status, 0, exported.stderr.slice(0, 1000));
const assets = JSON.parse(exported.stdout);
const stamp = '2026-10-16T05:00:00.000Z';
const taskUuid = '11111111-1111-4111-8111-111111111111';
const prefix = '/api/id-business-v2/auto-registration/workspace';
const user = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'flow-acceptance',
  displayName: '注册验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const observation = (extra = {}) => ({
  observedAt: stamp,
  httpStatus: 200,
  contentType: 'json',
  jsonKind: 'object',
  pageKind: 'new_account',
  officialOrigin: true,
  redirectHosts: [],
  redirectsTruncated: false,
  requestIdPresent: true,
  requestIdSha256: 'a'.repeat(64),
  decision: 'accepted',
  reason: null,
  ...extra
});
const details = (extra = {}) => ({
  errorSignal: 'none',
  errorShape: 'missing',
  errorsShape: 'missing',
  errorKind: 'none',
  pageShape: 'type_known',
  ...extra
});
const evidence = (phase) => {
  if (phase === 'legacy') return undefined;
  let signup = observation({ responseDetails: details() });
  if (phase === 'invalid')
    signup = observation({
      jsonKind: 'invalid',
      pageKind: 'not_checked',
      decision: 'rejected',
      reason: 'invalid_json'
    });
  if (phase === 'upstream_error')
    signup = observation({
      decision: 'rejected',
      reason: 'upstream_error',
      responseDetails: details({
        errorSignal: 'error',
        errorShape: 'object',
        errorKind: 'account_creation_failed'
      })
    });
  if (phase === 'unknown_page')
    signup = observation({
      pageKind: 'unknown',
      decision: 'rejected',
      reason: 'unexpected_page',
      responseDetails: details({ pageShape: 'type_unknown' })
    });
  if (phase === 'bad_page')
    signup = observation({
      pageKind: 'missing',
      decision: 'rejected',
      reason: 'unexpected_page',
      responseDetails: details({ pageShape: 'type_non_string' })
    });
  if (phase === 'malicious')
    signup = observation({
      pageKind: 'secret-fixture-page',
      decision: 'rejected',
      reason: 'secret-fixture-reason',
      rawUrl: 'https://secret-fixture-url.invalid/?token=secret-fixture-token',
      responseDetails: details({
        errorSignal: 'secret-fixture-signal',
        errorShape: 'secret-fixture-shape',
        errorsShape: 'secret-fixture-errors',
        errorKind: 'secret-fixture-code',
        pageShape: 'secret-fixture-type'
      })
    });
  if (phase === 'old_v1') signup = observation();
  return {
    version: phase === 'old_v1' ? 1 : 2,
    authorize: observation({
      contentType: 'html',
      jsonKind: 'not_checked',
      pageKind: 'not_checked'
    }),
    signup,
    ...(['accepted', 'old_v1'].includes(phase)
      ? {
          password: observation({
            httpStatus: 400,
            pageKind: 'not_checked',
            jsonKind: 'not_checked',
            decision: 'observed'
          })
        }
      : {})
  };
};
const mailbox = {
  aliasId: 'fixture-alias',
  email: 'flow-fixture@example.invalid',
  primaryEmail: 'primary@example.invalid',
  mailboxStatus: 'ACTIVE',
  authorizationValid: true,
  primaryAvailable: true,
  registrationStatus: 'unknown',
  registrationIp: null,
  registrationCountryCode: null,
  source: null,
  note: null,
  revision: 3,
  updatedAt: stamp,
  taskUuid,
  taskStatus: 'interrupted',
  activeTaskUuid: taskUuid,
  canRegister: false,
  blockedReason: '结果待核对',
  syncStatus: 'not_started'
};
const task = (phase) => ({
  taskUuid,
  status: 'interrupted',
  logs: ['合成原始失败记录'],
  ...(phase === 'legacy'
    ? {}
    : {
        browserRegistration: {
          phase: phase === 'invalid' ? 'human_verification_required' : 'profile_required',
          needAction: true,
          profileId: 'fixture-profile'
        }
      }),
  record: {
    email: mailbox.email,
    stage: phase === 'invalid' ? 'signup' : 'password',
    syncStatus: 'not_started',
    localSaveStatus: 'not_started',
    identityStatus: 'not_verified',
    firstFailure: {
      stage: phase === 'invalid' ? 'signup' : 'password',
      errorKind: phase === 'invalid' ? 'unknown' : 'account_creation_failed',
      httpStatus: phase === 'invalid' ? 200 : 400,
      elapsedMs: 649,
      observedAt: stamp
    }
  },
  ...(evidence(phase) ? { flowEvidence: evidence(phase) } : {})
});
const report = {
  status: 'RUNNING',
  scope: 'ACTUAL_ADMIN_BUILD_AND_TRANSFORMED_IFRAME_WITH_SYNTHETIC_REQUESTS',
  databaseOpened: false,
  websiteStarted: false,
  realRegistrationStarts: 0,
  externalRequests: [],
  unexpectedRequests: [],
  variants: [],
  sourceHashes: Object.fromEntries(
    ['id-workspace.js', 'id-workspace.css'].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(worker, name)))
        .digest('hex')
    ])
  )
};
const browser = await chromium.launch({ headless: true });
let activePage;
try {
  for (const surface of ['admin'])
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1280, 1024, 900, 768, 390])
        for (const phase of ['invalid', 'legacy', 'upstream_error']) {
          const origin = `https://${surface}-flow.acceptance.invalid`;
          const context = await browser.newContext({
            viewport: { width, height: 1100 },
            serviceWorkers: 'block'
          });
          const page = await context.newPage();
          activePage = page;
          page.setDefaultTimeout(15000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await context.addInitScript(
            ({ fixture, selectedTheme }) => {
              localStorage.setItem('apple_business_access_token', 'synthetic-flow-acceptance');
              localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
              window.flowTheme = selectedTheme;
            },
            { fixture: user, selectedTheme: theme }
          );
          await context.route('**/*', async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (
              url.origin === 'http://127.0.0.1:55324' &&
              request.method() === 'GET' &&
              url.pathname === '/health'
            )
              return route.fulfill({
                headers: { 'Access-Control-Allow-Origin': origin },
                contentType: 'application/json',
                body: JSON.stringify({
                  service: 'id-business-v2-auto-registration-connector',
                  version: 1,
                  ok: true
                })
              });
            if (url.origin !== origin) {
              report.externalRequests.push(url.origin);
              return route.abort();
            }
            const json = (data) =>
              route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
            if (surface === 'iframe') {
              if (url.pathname === '/')
                return route.fulfill({
                  contentType: 'text/html',
                  body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="workspace" title="自动注册工作区" style="display:block;width:100%;height:1080px;border:0" src="${prefix}/"></iframe><script>window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==document.getElementById('workspace').contentWindow)return;let m=event.data;if(m?.type==='id-registration:ready')event.source.postMessage({type:'id-registration:state',theme:${JSON.stringify(theme)},tokens:{},draft:{'email-service':'apple_hidden','storage:appleTask':${JSON.stringify(JSON.stringify({ taskUuid }))}}},location.origin);if(m?.type==='id-registration:apple-request'){let data=m.action==='candidates'?{items:[],proxies:[]}:m.action==='task'?${JSON.stringify(task(phase))}:null;event.source.postMessage({type:'id-registration:apple-response',requestId:m.requestId,ok:data!==null,data,error:'离线验收禁止执行注册'},location.origin);}});</script></body></html>`
                });
              if (url.pathname === `${prefix}/`)
                return route.fulfill({ contentType: 'text/html', body: assets['index.html'] });
              if (url.pathname.startsWith(`${prefix}/static/`)) {
                const name = path.basename(url.pathname);
                if (Object.hasOwn(assets, name))
                  return route.fulfill({
                    contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css',
                    body: assets[name]
                  });
              }
              const api = url.pathname.slice(`${prefix}/api`.length);
              if (request.method() === 'GET') {
                if (api === '/registration/available-services')
                  return json({
                    tempmail: { available: true, services: [] },
                    outlook: { available: false, services: [] },
                    custom_domain: { available: false, services: [] },
                    temp_mail: { available: false, services: [] }
                  });
                if (api === '/accounts')
                  return json({ accounts: [], total: 0, page: 1, page_size: 20 });
                if (api === '/accounts/stats/summary')
                  return json({ total: 0, by_status: { active: 0, expired: 0, failed: 0 } });
                if (['/cpa-services', '/sub2api-services', '/tm-services'].includes(api))
                  return json([]);
              }
            } else if (url.pathname.startsWith('/api/')) {
              const endpoint = url.pathname;
              if (endpoint === '/api/realtime/events')
                return route.fulfill({
                  contentType: 'text/event-stream',
                  body: 'retry: 60000\n: fixture\n\n'
                });
              let data;
              if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) data = user;
              else if (endpoint.endsWith('/branding/public'))
                data = {
                  appName: 'ID 业务管理',
                  logoText: 'ID',
                  logoUrl: '/brand/default-logo.svg',
                  appSubtitle: '业务管理',
                  documentTitleSuffix: 'ID 业务管理'
                };
              else if (endpoint.endsWith('/id-business-v2/time'))
                data = { now: stamp, timezone: 'Asia/Shanghai' };
              else if (endpoint.endsWith('/change-versions'))
                data = { generatedAt: stamp, versions: {} };
              else if (
                endpoint.endsWith('/table-preferences') ||
                endpoint.endsWith('/workspace-shortcuts')
              )
                data = { items: [] };
              else if (endpoint.endsWith('/quick-actions')) data = { items: [], updatedAt: stamp };
              else if (
                endpoint.endsWith('/warning-summary') ||
                endpoint.endsWith('/renewal-warnings')
              )
                data = {
                  warningDays: 3,
                  defaultWarningDays: 3,
                  upcomingCount: 0,
                  expiredCount: 0,
                  totalCount: 0,
                  items: [],
                  evaluatedAt: stamp,
                  revalidateAt: stamp
                };
              else if (endpoint.endsWith('/sensitive-access/approvals/summary'))
                data = { pendingCount: 0, items: [], generatedAt: stamp };
              else if (endpoint.endsWith('/auto-registration/status'))
                data = {
                  ready: true,
                  workspacePath: prefix + '/',
                  version: 'fixture',
                  sourceCommit: 'fixture'
                };
              else if (endpoint.endsWith('/workspace-session'))
                data = { expiresAt: '2099-01-01T00:00:00Z' };
              else if (endpoint.startsWith(prefix))
                return route.fulfill({
                  contentType: 'text/html',
                  body: '<!doctype html><html><body>合成工作区</body></html>'
                });
              else if (endpoint.endsWith('/apple-mailboxes/candidates'))
                data = {
                  items: [],
                  total: 0,
                  available: 0,
                  proxies: [{ id: 'fixture-proxy', label: '菲律宾 · 动态住宅' }]
                };
              else if (endpoint.endsWith('/apple-mailboxes/resume'))
                data = { resumed: 0, synchronized: 0 };
              else if (
                endpoint.endsWith('/auto-registration/apple-mailboxes') &&
                request.method() === 'GET'
              )
                data = { items: [mailbox], total: 1, page: 1, pageSize: 20 };
              else if (
                endpoint.endsWith('/apple-mailboxes/tasks/' + taskUuid) &&
                request.method() === 'GET'
              )
                data = task(phase);
              if (data !== undefined)
                return json({
                  success: true,
                  data,
                  message: 'OK',
                  requestId: 'fixture-request',
                  timestamp: stamp
                });
            } else if (surface === 'admin') {
              const relative = url.pathname.startsWith('/v2/') ? '/index.html' : url.pathname;
              const asset = path.resolve(distribution, '.' + relative);
              if (asset.startsWith(distribution + path.sep) && existsSync(asset))
                return route.fulfill({
                  contentType:
                    {
                      '.html': 'text/html',
                      '.js': 'text/javascript',
                      '.css': 'text/css',
                      '.svg': 'image/svg+xml',
                      '.png': 'image/png',
                      '.ico': 'image/x-icon',
                      '.woff2': 'font/woff2'
                    }[path.extname(asset)] || 'application/octet-stream',
                  body: readFileSync(asset)
                });
            }
            if (request.method() !== 'GET') report.realRegistrationStarts++;
            report.unexpectedRequests.push({
              surface,
              method: request.method(),
              path: url.pathname
            });
            return route.fulfill({ status: 404, body: 'offline route not mapped' });
          });
          await page.goto(origin + (surface === 'admin' ? '/v2/auto-registration' : '/'), {
            waitUntil: 'domcontentloaded'
          });
          let target = page;
          if (surface === 'admin') {
            await page.getByRole('tab', { name: '苹果隐藏邮箱', exact: true }).click();
            await page
              .getByText(mailbox.email, { exact: true })
              .filter({ visible: true })
              .first()
              .waitFor();
            await page.evaluate((selected) => {
              document.documentElement.dataset.v2Theme = selected;
              document.documentElement.classList.toggle('dark', selected === 'dark');
              document.documentElement.style.colorScheme = selected;
            }, theme);
            await page.getByText('助手已连接，可以使用浏览器注册。', { exact: true }).waitFor();
            const proxyControl = page.getByRole('combobox', {
              name: '浏览器注册代理',
              exact: true
            });
            await proxyControl.click();
            await page.getByRole('option', { name: '菲律宾 · 动态住宅', exact: true }).click();
            const alignment = await page
              .locator('.el-form-item')
              .filter({ has: proxyControl })
              .evaluate((el) => {
                const label = el.querySelector('.el-form-item__label');
                const control = el.querySelector('.el-select');
                const l = label.getBoundingClientRect(),
                  c = control.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(label);
                const t = range.getBoundingClientRect();
                return {
                  labelLeft: l.left,
                  labelRight: l.right,
                  controlLeft: c.left,
                  controlRight: c.right,
                  textTop: t.top,
                  textBottom: t.bottom,
                  controlTop: c.top,
                  controlBottom: c.bottom
                };
              });
            assert.ok(alignment.labelRight <= alignment.controlLeft + 1, '注册代理标签在控件左侧');
            assert.ok(
              alignment.textTop >= alignment.controlTop - 2 &&
                alignment.textBottom <= alignment.controlBottom + 2,
              '真实标签文字与首行控件对齐'
            );
            await page
              .getByRole('button', { name: '更多操作', exact: true })
              .filter({ visible: true })
              .first()
              .click();
            await page.getByRole('menuitem', { name: '查看任务', exact: true }).click();
            await page.getByRole('button', { name: '刷新进度', exact: true }).waitFor();
          } else {
            await page
              .frameLocator('#workspace')
              .getByRole('heading', { name: '💻 监控台' })
              .waitFor();
            target = page.frameLocator('#workspace');
            await target.getByText('合成原始失败记录', { exact: false }).waitFor();
          }
          if (phase !== 'legacy') {
            await page
              .getByText(
                '请在原比特浏览器窗口完成官网要求的验证或资料填写，完成后助手会继续。请保留原窗口，不要重复注册。',
                { exact: true }
              )
              .waitFor();
            await page
              .getByText(phase === 'invalid' ? /本人完成官网验证/ : /补齐官网要求的资料/)
              .filter({ visible: true })
              .first()
              .waitFor();
          }
          const panel = target.getByRole('region', { name: '注册流程观察', exact: true });
          if (phase === 'legacy')
            assert.equal(
              (await panel.count()) === 0 || !(await panel.isVisible()),
              true,
              '旧任务不显示虚构观察'
            );
          else {
            await panel.waitFor({ state: 'visible' });
            assert.equal(await panel.getByRole('listitem').count(), 3);
            const text = await panel.innerText();
            for (const title of ['授权入口', '提交注册邮箱', '提交注册密码'])
              assert.ok(text.includes(title));
            assert.ok(text.includes(phase === 'invalid' ? '已停止，等待核对' : '已确认继续'));
            if (!['accepted', 'old_v1'].includes(phase)) assert.ok(text.includes('尚未观察'));
            if (phase === 'upstream_error') {
              assert.ok(text.includes('官网响应携带错误'));
              assert.ok(text.includes('上游错误分类：拒绝创建账号'));
              assert.ok(text.includes('页面结构：类型已识别'));
            }
            if (phase === 'unknown_page') assert.ok(text.includes('未知页面：类型尚未识别'));
            if (phase === 'bad_page') assert.ok(text.includes('页面类型不是文本'));
            if (phase === 'old_v1') assert.ok(!text.includes('单项错误结构'));
            assert.ok(!text.includes('secret-fixture-'), '恶意或秘密字符串不能进入诊断详情');
            assert.ok(!text.includes('a'.repeat(64)), '请求编号摘要不应直接展示');
            await panel.scrollIntoViewIfNeeded();
          }
          await page.evaluate(() =>
            Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {}))
            )
          );
          const geometry = await page.evaluate(() => ({
            width: window.innerWidth,
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1
          }));
          assert.equal(geometry.overflow, false, '页面不应横向溢出');
          if (surface === 'iframe')
            assert.equal(
              await page
                .frameLocator('#workspace')
                .locator('html')
                .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
              false,
              '工作区不应横向溢出'
            );
          assert.deepEqual(errors, []);
          const filename = `${surface}-${theme}-${width}-${phase}.png`;
          await page.screenshot({ path: path.join(output, filename), fullPage: true });
          const detail = phase === 'legacy' ? undefined : filename.replace('.png', '-detail.png');
          if (detail) await panel.screenshot({ path: path.join(output, detail) });
          report.variants.push({
            surface,
            theme,
            width,
            phase,
            screenshot: filename,
            detailScreenshot: detail,
            geometry
          });
          await context.close();
          activePage = undefined;
        }
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.unexpectedRequests, []);
  assert.equal(report.realRegistrationStarts, 0);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.failure = error.message;
  if (activePage)
    await activePage
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(
  JSON.stringify({
    status: report.status,
    variants: report.variants.length,
    externalRequests: 0,
    registrationStarts: 0,
    databaseOpened: false,
    output
  })
);
