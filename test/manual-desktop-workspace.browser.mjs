import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createManualDesktopWorkspaces } from '../server/manual-desktop-workspace.mjs';

const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
const chrome = process.env.ID_MANUAL_QA_CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

test('普通桌面浏览器按操作者和账号隔离，重新启动恢复实际页面及浏览器本地状态', { timeout: 90000 }, async t => {
  await mkdir(runtime, { recursive: true });
  const profileRoot = await realpath(await mkdtemp(join(runtime, 'manual-desktop-')));
  const names = ['alpha', 'bravo', 'charlie'];
  const reports = [];
  let firstVisits = 0;
  const site = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/first') {
      const label = names[firstVisits++];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Synthetic first visit</title><script>' +
        'if (!localStorage.getItem("draft-label")) localStorage.setItem("draft-label", ' +
        JSON.stringify(label || 'unexpected') + ');location.replace("/work/" + localStorage.getItem("draft-label"));</script>');
    } else if (url.pathname.startsWith('/work/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Synthetic ongoing work</title><script>fetch("/view?path=" + ' +
        'encodeURIComponent(location.pathname) + "&draft=" + encodeURIComponent(localStorage.getItem("draft-label")));' +
        '</script><h1>离线工作区验收</h1>');
    } else if (url.pathname === '/view') {
      reports.push([url.searchParams.get('path'), url.searchParams.get('draft')]);
      res.writeHead(204).end();
    } else res.writeHead(404).end();
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const firstPage = 'http://127.0.0.1:' + site.address().port + '/first';
  const desk = createManualDesktopWorkspaces({ profileRoot, executable: chrome, firstPage });
  const alice = { operatorId: 'operator-a', accountId: 'record-a' };
  const otherAccount = { operatorId: 'operator-a', accountId: 'record-b' };
  const otherOperator = { operatorId: 'operator-b', accountId: 'record-a' };
  t.after(async () => {
    try { await Promise.all([alice, otherAccount, otherOperator].map(id => desk.close(id))); }
    finally { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
    await rm(profileRoot, { recursive: true, force: true });
  });
  async function expectPage(identity, marker, visits) {
    const start = Date.now();
    await desk.open(identity);
    while (reports.filter(([path, value]) => path === '/work/' + marker && value === marker).length < visits) {
      assert(Date.now() - start < 12000, '目标页面或浏览器本地资料未恢复：' + JSON.stringify({ marker, firstVisits, reports }));
      await delay(100);
    }
  }
  await expectPage(alice, 'alpha', 1);
  assert.deepEqual(await Promise.all([desk.open(alice), desk.open(alice)]),
    [{ state: 'running' }, { state: 'running' }]);
  await delay(400);
  assert.equal(firstVisits, 1);
  assert.deepEqual(reports, [['/work/alpha', 'alpha']]);
  assert.deepEqual(await Promise.all([desk.close(alice), desk.close(alice)]), [true, true]);
  const invalid = createManualDesktopWorkspaces({ profileRoot, executable: join(profileRoot, 'missing-browser'), firstPage });
  await assert.rejects(invalid.open(alice), { code: 'ENOENT' });
  await expectPage(alice, 'alpha', 2);
  assert.equal(firstVisits, 1, '关闭后重新打开不能跳回首页');
  await expectPage(otherAccount, 'bravo', 1);
  await expectPage(otherOperator, 'charlie', 1);
  assert.equal(firstVisits, 3);
  assert.deepEqual((await readdir(profileRoot)).map(name => /^manual-v1-[a-f0-9]{64}$/.test(name)), [true, true, true]);
});

test('全新桌面管理实例恢复两个原标签及有效网站登录，过期后两页均要求重新登录', { timeout: 90000 }, async t => {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'manual-desktop-tabs-'));
  const profileRoot = join(directory, 'profiles'), executable = join(directory, 'fixture-chrome');
  await mkdir(profileRoot, { mode: 0o700 });
  // The loopback fixture opens its second tab with a normal target=_blank link.
  // Pass the executable as data so overridden Chrome paths are never parsed as shell code.
  await writeFile(join(directory, 'chrome-path'), chrome + '\n');
  await writeFile(executable, [
    '#!/bin/sh', 'IFS= read -r chrome < "$(dirname "$0")/chrome-path" || exit 1',
    'exec "$chrome" --disable-popup-blocking --disable-background-networking --disable-component-update --disable-sync --no-proxy-server "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" "$@"', ''
  ].join('\n'), { mode: 0o700 });

  const paths = ['/work/inbox', '/work/renewals'];
  const demoCookie = 'qa_demo_signed_in=on; Path=/; HttpOnly; SameSite=Strict; Max-Age=';
  let phase = 'initial', homeVisits = 0, signIns = 0, expiresAfter = 0;
  const reports = [];
  const witnessed = (stage, path) => reports.some(row => row.phase === stage && row.path === path);
  const site = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const signedIn = /(?:^|;\s*)qa_demo_signed_in=on(?:;|$)/.test(req.headers.cookie || '');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/start') {
      homeVisits++;
      if (phase !== 'initial') return res.writeHead(409).end();
      return res.end('<form method="post" action="/login"><button>进入虚构账号</button></form><script>document.forms[0].requestSubmit()</script>');
    }
    if (path === '/login' && req.method === 'POST') {
      signIns++;
      if (phase !== 'initial') return res.writeHead(409).end();
      return res.writeHead(303, { 'Set-Cookie': demoCookie + '3600', Location: paths[0] }).end();
    }
    if (paths.includes(path)) {
      if (!signedIn) return res.writeHead(401).end('<h1>请重新登录</h1><script>fetch("/login-required?path="+location.pathname)</script>');
      const nextTab = phase === 'initial' && path === paths[0]
        ? '<a id="other" target="_blank" rel="noopener" href="/work/renewals">续费</a><script>document.querySelector("#other").click()</script>' : '';
      return res.end(`<!doctype html><title>本地虚构工作区</title><h1>已登录</h1>${nextTab}<script>
        const path = location.pathname, restored = history.state?.previousPage === path;
        if (!restored) history.replaceState({previousPage: path}, "");
        const bus = new BroadcastChannel("fixture-tabs");
        const repeat = setInterval(() => bus.postMessage(path), 400);
        bus.onmessage = async ({data}) => {
          if (data === path) return;
          bus.onmessage = null;
          clearInterval(repeat);
          bus.postMessage(path);
          const reply = await fetch("/peer?path=" + path + "&restored=" + restored);
          if (reply.status === 200) await fetch("/expiry-armed");
        };
        bus.postMessage(path);
      </script>`);
    }
    if (['/peer', '/login-required'].includes(path)) {
      const page = url.searchParams.get('path');
      if (!paths.includes(page)) return res.writeHead(400).end();
      reports.push({ phase, path: page, signedIn, restored: url.searchParams.get('restored') === 'true', kind: path });
      // Shorten the site's real cookie lifetime only after both original tabs reported
      // a valid login. This also works on machines with a slow graphical startup.
      if (phase === 'restored' && path === '/peer' && paths.every(p => witnessed(phase, p)))
        return res.writeHead(200, { 'Set-Cookie': demoCookie + '3' }).end();
      return res.writeHead(204).end();
    }
    if (path === '/expiry-armed' && phase === 'restored' && signedIn) {
      expiresAfter = Date.now() + 4000;
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const firstPage = 'http://127.0.0.1:' + site.address().port + '/start';
  const record = { operatorId: 'synthetic-operator', accountId: 'synthetic-account' };
  let desk;
  t.after(async () => {
    try { if (desk) await desk.close(record); }
    finally { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  for (const stage of ['initial', 'restored', 'expired']) {
    phase = stage;
    if (stage === 'expired') await delay(Math.max(0, expiresAfter - Date.now()));
    desk = createManualDesktopWorkspaces({ profileRoot, executable, firstPage });
    assert.equal((await desk.open(record)).state, 'opened');
    const deadline = Date.now() + 18000;
    while (!paths.every(path => witnessed(stage, path)) || (stage === 'restored' && !expiresAfter)) {
      assert(Date.now() < deadline, stage + ' 等待原标签回报超时：' + JSON.stringify(reports));
      await delay(100);
    }
    const observed = reports.filter(row => row.phase === stage);
    assert.equal(observed.length, 2);
    for (const row of observed) {
      assert.equal(row.kind, stage === 'expired' ? '/login-required' : '/peer');
      assert.equal(row.signedIn, stage !== 'expired');
      assert.equal(row.restored, stage === 'restored');
    }
    assert(await desk.close(record), '普通浏览器正常退出');
  }
  assert.equal(homeVisits, 1);
  assert.equal(signIns, 1);
});
