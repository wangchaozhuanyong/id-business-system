import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createManualDesktopWorkspaces } from '../server/manual-desktop-workspace.mjs';

test('普通桌面浏览器按操作者和账号隔离，重新启动恢复实际页面及浏览器本地状态', { timeout: 90000 }, async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const profileRoot = await realpath(await mkdtemp(join(runtime, 'manual-desktop-')));
  const executable = process.env.ID_MANUAL_QA_CHROME ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
  const desk = createManualDesktopWorkspaces({ profileRoot, executable, firstPage });
  const alice = { operatorId: 'operator-a', accountId: 'record-a' };
  const otherAccount = { operatorId: 'operator-a', accountId: 'record-b' };
  const otherOperator = { operatorId: 'operator-b', accountId: 'record-a' };
  t.after(async () => {
    try { await Promise.all([alice, otherAccount, otherOperator].map(id => desk.close(id))); }
    finally { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
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
