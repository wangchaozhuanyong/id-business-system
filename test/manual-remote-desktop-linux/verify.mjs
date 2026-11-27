import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { chown, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManualRemoteAccess } from '../../server/manual-remote-access.mjs';
import { manualDesktopWorkspaceKey } from '../../server/manual-desktop-workspace.mjs';

const here = fileURLToPath(import.meta.url);
const output = process.env.ID_MANUAL_QA_OUTPUT;
assert(output, 'Use the Linux QA run.sh entry point');
const single = process.env.ID_MANUAL_QA_SINGLE === '1';
const nativeClose = process.env.ID_MANUAL_QA_NATIVE_CLOSE || '';
assert(['','window','quit'].includes(nativeClose));
const phoneWidth = Number(process.env.ID_MANUAL_QA_PHONE_WIDTH || 390);
assert([320,390].includes(phoneWidth));
const owners = {alpha: 'fixture-owner', delta: 'fixture-owner', bravo: 'fixture-colleague'};
const keys = Object.fromEntries(Object.entries(owners).map(([accountId,operatorId]) =>
  [accountId, manualDesktopWorkspaceKey({operatorId,accountId})]));
const unit = id => 'id-manual-workspace@' + keys[id] + '.service';

async function coordinator() {
  const marks = [], memory = [], owner = {id: 'fixture-owner', role: 'finance'};
  const sessions = { laptop: owner, phone: owner, colleague: {id:'fixture-colleague',role:'admin'}, outsider: {id: 'other-owner', role: 'admin'}, employee: {id: 'employee', role: 'employee'} };
  const getActor = req => sessions[/\bfixture=(\w+)/.exec(req.headers.cookie || '')?.[1]];
  const store = {
    resolveManualWorkspace(id, actor) {
      if (!Object.hasOwn(keys,id) || owners[id] !== actor.id) throw Object.assign(new Error(), {status:404});
      return {key: keys[id]};
    },
    markManualRenewalOpened(id, actor) { assert.equal(actor.id, owners[id]); marks.push(id); }
  };
  let gateway;
  const site = createServer((req, res) => {
    if (req.url.startsWith('/fixture-login/')) {
      const name = req.url.slice('/fixture-login/'.length);
      if (!Object.hasOwn(sessions, name)) return res.writeHead(404).end();
      return res.writeHead(200, {'Content-Type':'text/html', 'Set-Cookie': 'fixture=' + name + '; Path=/; HttpOnly; SameSite=Strict'}).end('<meta name="viewport" content="width=device-width,initial-scale=1">Synthetic login');
    }
    gateway.handle(req, res);
  });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const origin = 'http://127.0.0.1:' + site.address().port;
  gateway = createManualRemoteAccess({socketPath:'/run/id-manual-qa/broker/web.sock', publicOrigin:origin, getActor, store});
  site.on('upgrade', gateway.upgrade);
  const group = '/sys/fs/cgroup/' + process.env.ID_MANUAL_QA_SLICE + '/';
  const started = Date.now();
  async function metric(path, file) {
    return readFile(group + path + file, 'utf8').then(x => /^\d+$/.test(x.trim()) ? Number(x.trim()) : x.trim(), () => null);
  }
  async function sample(stage) {
    const stats = {stage, elapsedMs:Date.now()-started, totalCurrent:await metric('', 'memory.current'), totalPeak:await metric('', 'memory.peak'), workers:{}};
    for (const id of Object.keys(keys)) {
      const path = unit(id) + '/';
      const peak = await metric(path,'memory.peak');
      if (peak === null) continue;
      stats.workers[id] = {peak, current:await metric(path,'memory.current'), memoryMax:await metric(path,'memory.max'),
        swapMax:await metric(path,'memory.swap.max'), cpu:await metric(path,'cpu.stat'), events:await metric(path,'memory.events')};
      if (single) {
        assert.equal(stats.workers[id].memoryMax, 512*1024*1024);
        assert.equal(stats.workers[id].swapMax, 0);
      }
    }
    memory.push(stats);
  }
  const account = process.env.ID_MANUAL_QA_VIEWER_USER || 'qa';
  const uid = Number(execFileSync('id', ['-u', account])), gid = Number(execFileSync('id', ['-g', account]));
  assert(uid > 0 && gid > 0, 'Viewer must be an unprivileged QA account');
  await chown(output, uid, gid);
  const viewer = fork(here, ['viewer', origin], {uid, gid, env:{...process.env, HOME:'/home/' + account}, stdio:['ignore','inherit','inherit','ipc']});
  viewer.on('message', async command => {
    try {
      if (command === 'restart-broker') {
        const pid = () => execFileSync('systemctl',['show','-p','MainPID','--value','manualqa-broker.service']).toString().trim();
        const before = pid();
        assert(Number(before)>1);
        execFileSync('systemctl',['restart','manualqa-broker.service'],{timeout:20000});
        const after = pid();
        assert(Number(after)>1 && after !== before,'Broker restart must start a fresh process');
        const deadline = Date.now()+10000;
        let ready = false;
        while (!ready && Date.now()<deadline) {
          ready = await new Promise(resolve => {
            get({socketPath:'/run/id-manual-qa/broker/web.sock',path:'/v1/client/core/rfb.js',timeout:1000},response => {
              response.resume();
              resolve(response.statusCode===200);
            }).on('error',()=>resolve(false)).on('timeout',function(){this.destroy();});
          });
          if (!ready) await delay(100);
        }
        assert(ready,'Fresh broker must serve the real client asset');
      }
      if (command.startsWith('race-winner-') || command==='two-accounts-active') {
        const active = Object.keys(keys).filter(id =>
          execFileSync('systemctl',['show','-p','ActiveState','--value',unit(id)]).toString().trim()==='active');
        const expected = command==='two-accounts-active' ? ['alpha','bravo'] : [command.slice('race-winner-'.length)];
        assert.deepEqual(active.sort(),expected.sort());
      }
      if (command === 'two-accounts-active') {
        const result = execFileSync('/usr/bin/python3', ['-IB','/run/id-manual-qa/isolation.py',keys.alpha,keys.bravo], {timeout:12000});
        await writeFile(resolve(output, 'isolation.json'), result);
      }
      if (command === 'user-closed-last-window') {
        let state = '';
        const deadline = Date.now() + 12000;
        do {
          state = execFileSync('systemctl', ['show', '-p', 'ActiveState', '--value', unit('alpha')]).toString().trim();
          if (state === 'inactive') break;
          await delay(150);
        } while (Date.now() < deadline);
        assert.equal(state, 'inactive', 'GUI close must stop the worker without host intervention');
      }
      if (command === 'restart-alpha') {
        await sample('before-normal-worker-stop');
        execFileSync('systemctl', ['stop', unit('alpha')], {timeout:35000});
        assert.equal((await readFile('/run/id-manual-qa/workers/' + keys.alpha + '/.qa-stopped','utf8')), '0');
      } else await sample(command);
      viewer.send({ok:true});
    } catch(error) { viewer.send({error:error.message}); }
  });
  let result = 'fail';
  try {
    console.log('Guest loopback gateway: ' + origin + '/manual-workspaces/alpha/');
    const [code] = await once(viewer, 'exit'); assert.equal(code, 0);
    assert(marks.length >= (single ? 2 : 4));
    result = 'pass';
  } finally {
    await sample('finished');
    await writeFile(resolve(output, single ? 'single-memory.json' : 'memory.json'),
      JSON.stringify({result, platform:process.platform, architecture:process.arch, single, nativeClose, marks, memory},null,2));
    gateway.close(); site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
  }
}

async function clients(origin) {
  const pw = process.env.ID_RECHARGE_QA_PLAYWRIGHT || fileURLToPath(new URL('../../node_modules/playwright/index.mjs',import.meta.url));
  const {chromium, devices: presets} = await import(pathToFileURL(pw));
  const browsers = [];
  const traffic = {};
  const started = Date.now();
  const chromiumOptions = {headless:true, chromiumSandbox:true, executablePath:process.env.ID_MANUAL_QA_CHROME || '/usr/bin/chromium'};
  async function newDevice(name) {
    const browser = await chromium.launch(chromiumOptions); browsers.push(browser);
    const page = await browser.newPage(name === 'phone'
      ? {viewport:{width:phoneWidth,height:844},userAgent:presets['Pixel 7'].userAgent,hasTouch:true,isMobile:true,deviceScaleFactor:1}
      : {viewport:{width:1200,height:800}});
    page.setDefaultTimeout(15000);
    const totals = traffic[name] = {webSockets:0, receivedFrameBytes:0, sentFrameBytes:0};
    page.on('websocket',socket => {
      if (!new URL(socket.url()).pathname.endsWith('/stream')) return;
      totals.webSockets++;
      const bytes = packet => typeof packet.payload==='string' ? Buffer.byteLength(packet.payload) : packet.payload.length;
      socket.on('framereceived',packet => { totals.receivedFrameBytes += bytes(packet); });
      socket.on('framesent',packet => { totals.sentFrameBytes += bytes(packet); });
    });
    page.on('pageerror', error => console.log('Viewer error: ' + error.message));
    page.on('response', response => {if (response.status() >= 400) console.log('Viewer HTTP ' + response.status() + ' ' + new URL(response.url()).pathname);});
    await page.goto(origin + '/fixture-login/' + name);
    return page;
  }
  async function checkpoint(name) {
    process.send(name); const [answer] = await once(process,'message'); if (answer.error) throw new Error(answer.error);
  }
  async function connect(page, id) {
    await page.goto(origin + '/manual-workspaces/' + id + '/');
    const action = page.getByRole('button', {name:'连接工作区'});
    if (page.viewportSize().width === phoneWidth) await action.tap(); else await action.click();
    try { await page.getByRole('button', {name:'断开连接'}).waitFor({timeout:39000}); }
    catch(error) { throw new Error('Connection: ' + await page.locator('#status').textContent(), {cause:error}); }
  }
  async function disconnect(page) {
    const action = page.getByRole('button', {name:'断开连接'});
    if (page.viewportSize().width === phoneWidth) await action.tap(); else await action.click();
    await page.getByRole('button', {name:'连接工作区'}).waitFor();
  }
  async function navigateRemote(page, path) {
    // The RFB handshake precedes the first painted desktop and Chrome's window focus.
    await page.waitForFunction(() => {
      const canvas=document.querySelector('#screen canvas');
      return canvas && canvas.width > 100 && canvas.getContext('2d')
        .getImageData(Math.floor(canvas.width/2), Math.floor(canvas.height/2), 1,1).data[3] === 255;
    });
    await page.locator('#screen canvas[tabindex]').focus();
    await page.keyboard.press('Control+l');
    await delay(450);
    await page.keyboard.type('http://127.0.0.1:18112/' + path,{delay:16});
    await page.keyboard.press('Enter');
  }
  async function pixels(page, expected, label) {
    try {
      await page.waitForFunction(rgb => {
        const canvas=document.querySelector('#screen canvas');
        if (!canvas || canvas.width < 10) return false;
        const ctx=canvas.getContext('2d');
        if (!ctx) return false;
        const values=ctx.getImageData(Math.floor(canvas.width/2), Math.floor(canvas.height*0.65), 1,1).data;
        return rgb.every((component,i) => Math.abs(component-values[i]) <= 10);
      }, expected, {timeout:24000});
    } catch(error) {
      await page.screenshot({path:resolve(output,'failed-' + label + '.png')}); throw new Error('Unexpected desktop pixels: ' + label,{cause:error});
    }
  }
  async function postFrom(page, id, action) {
    return page.evaluate(async ({id,action}) => {
      const response = await fetch('/manual-workspaces/' + id + '/' + action,{method:'POST'});
      return response.status;
    },{id,action});
  }
  async function saveAndClose(page,id) {
    page.once('dialog',dialog => dialog.accept());
    const stopped = page.waitForResponse(response => response.url().endsWith('/'+id+'/stop') && response.request().method()==='POST');
    await page.getByRole('button',{name:'保存并关闭工作区'}).click();
    assert.equal((await stopped).status(),204);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('工作区已关闭'),null,{timeout:30000});
  }
  async function assertLocked(page,id) {
    await page.goto(origin + '/manual-workspaces/' + id + '/');
    const response = page.waitForResponse(value=>value.url().endsWith('/'+id+'/open'));
    const action = page.getByRole('button',{name:'连接工作区'});
    if (page.viewportSize().width===phoneWidth) await action.tap(); else await action.click();
    assert.equal((await response).status(),423);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('保存并关闭工作区'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.getByRole('button',{name:'保存并关闭工作区'}).isHidden());
  }
  try {
    const a = await newDevice('laptop'), b = await newDevice('phone');
    const devices = {};
    for (const [name, client] of [['desktop',a],['mobile',b]]) {
      devices[name] = await client.evaluate(() => ({
        width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints,mobile:/Android.*Mobile/.test(navigator.userAgent)
      }));
    }
    assert.equal(devices.desktop.width,1200); assert.equal(devices.mobile.width,phoneWidth);
    assert(devices.mobile.touch > 0 && devices.mobile.mobile);
    await writeFile(resolve(output,'devices.json'),JSON.stringify(devices,null,2));
    const denied = await newDevice('outsider');
    assert.equal((await denied.request.get(origin + '/manual-workspaces/alpha/')).status(),404);
    await denied.goto(origin + '/fixture-login/employee');
    const access = {
      financeOwnPage:(await a.request.get(origin+'/manual-workspaces/alpha/')).status(),
      employeePage:(await denied.request.get(origin+'/manual-workspaces/alpha/')).status(),
      employeeOpen:await postFrom(denied,'alpha','open'),
      employeeStop:await postFrom(denied,'alpha','stop'),
      employeeClient:(await denied.request.get(origin+'/manual-workspaces/alpha/client/core/rfb.js')).status()
    };
    await denied.goto(origin+'/fixture-login/colleague');
    access.adminOwnPage=(await denied.request.get(origin+'/manual-workspaces/bravo/')).status();
    access.adminOtherOwnerRecord=(await denied.request.get(origin+'/manual-workspaces/alpha/')).status();
    assert.deepEqual(access,{financeOwnPage:200,employeePage:403,employeeOpen:403,employeeStop:403,
      employeeClient:403,adminOwnPage:200,adminOtherOwnerRecord:404});
    await writeFile(resolve(output,'access.json'),JSON.stringify(access,null,2));
    await browsers.pop().close();
    if (!single) {
      const different = await Promise.all([postFrom(a,'alpha','open'),postFrom(b,'delta','open')]);
      assert.deepEqual([...different].sort(),[204,423]);
      const winner = different[0] === 204 ? 'alpha' : 'delta';
      await checkpoint('race-winner-' + winner);
      await connect(a,winner);
      await saveAndClose(a,winner);
      const same = await Promise.all([postFrom(a,'alpha','open'),postFrom(b,'alpha','open')]);
      assert.deepEqual(same,[204,204]);
      await checkpoint('race-winner-alpha');
      await writeFile(resolve(output,'races.json'),JSON.stringify({different,same,winner},null,2));
    }
    await connect(a,'alpha'); await navigateRemote(a,'start/alpha'); await pixels(a,[36,174,112],'alpha-first');
    await a.locator('#screen canvas[tabindex]').click();
    await pixels(a,[38,108,202],'alpha-saved'); await checkpoint('alpha-active');
    if (!single) {
      // The worker allows one live controller. A second device takes over its existing desktop.
      await connect(b,'alpha');
      await pixels(b,[38,108,202],'same-record-observes-desktop-edit');
      await a.getByRole('button',{name:'连接工作区'}).waitFor();
      await checkpoint('same-record-mobile-takes-over-live-desktop');
      await b.goto(origin+'/fixture-login/phone'); // Pagehide disconnects the final client.
      await assertLocked(b,'delta');
      await checkpoint('disconnected-page-still-claims-slot');
      await checkpoint('restart-broker');
      await assertLocked(b,'delta');
      await b.screenshot({path:resolve(output,'phone-other-account-locked.png')});
      await checkpoint('fresh-broker-still-denies-other-record');
    } else await disconnect(a);
    await connect(b,'alpha'); await pixels(b,[38,108,202],'second-client-reconnect');
    const buttons = await b.locator('header button:visible').evaluateAll(nodes => nodes.map(node => {
      const {x,y,width,height,right,bottom}=node.getBoundingClientRect();
      return {name:node.textContent,x,y,width,height,right,bottom};
    }));
    assert.equal(buttons.length,4);
    assert(buttons.every(box=>box.width>=44 && box.height>=44 && box.x>=0 && box.right<=phoneWidth));
    for (const [i,box] of buttons.entries()) for (const other of buttons.slice(i+1)) {
      assert(box.right<=other.x || other.right<=box.x || box.bottom<=other.y || other.bottom<=box.y);
    }
    await writeFile(resolve(output,'mobile-controls.json'),JSON.stringify(buttons,null,2));
    await b.screenshot({path:resolve(output,'second-client-reconnect.png')});
    await b.getByRole('button',{name:'原始大小'}).tap();
    await b.getByRole('button',{name:'适合屏幕'}).tap();
    await b.locator('#screen canvas[tabindex]').tap();
    await b.getByRole('button',{name:'键盘'}).tap();
    assert(await b.locator('#keys').evaluate(node => document.activeElement === node));
    await b.keyboard.insertText('q'); await pixels(b,[89,57,157],'phone-remote-input');
    await b.screenshot({path:resolve(output,'phone-keyboard-input.png')});
    await b.keyboard.insertText('r'); await pixels(b,[38,108,202],'phone-input-edited');
    await checkpoint('phone-'+phoneWidth+'-touch-scale-keyboard-edited-remote-input');
    if (!single) {
      await a.goto(origin+'/fixture-login/colleague');
      assert.equal((await a.request.get(origin+'/manual-workspaces/alpha/')).status(),404);
      assert.equal((await b.request.get(origin+'/manual-workspaces/bravo/')).status(),404);
      await connect(a,'bravo'); await navigateRemote(a,'work/alpha'); await pixels(a,[81,69,75],'second-record-no-first-login');
      await navigateRemote(a,'start/bravo'); await pixels(a,[193,109,34],'bravo-own');
      await pixels(b,[38,108,202],'alpha-still-separate'); await checkpoint('two-accounts-active');
      await a.screenshot({path:resolve(output,'separate-record.png')});
      await saveAndClose(a,'bravo');
      await a.goto(origin+'/fixture-login/laptop');
    } else {
      await b.locator('#screen canvas[tabindex]').focus(); await b.keyboard.press('Control+t'); await delay(350); await navigateRemote(b,'work/alpha');
      await pixels(b,[36,174,112],'second-light-tab');
      await b.keyboard.press('Control+Shift+Tab'); await pixels(b,[38,108,202],'two-light-tabs');
      await checkpoint('single-two-light-tabs');
    }
    await disconnect(b);
    await checkpoint('restart-alpha'); await connect(a,'alpha');
    await pixels(a,[38,108,202],'normal-worker-restart');
    await a.screenshot({path:resolve(output,'normal-worker-restart.png')});
    await checkpoint('restarted-and-restored');
    const stopButton = a.getByRole('button', {name:'保存并关闭工作区'});
    a.once('dialog', dialog => dialog.dismiss());
    await stopButton.click(); await pixels(a,[38,108,202],'cancelled-stop-preserves-desktop');
    await saveAndClose(a,'alpha');
    await checkpoint('platform-stop-acknowledged');
    if (!single) {
      await connect(b,'delta');
      await checkpoint('save-close-allows-next-record');
      await assertLocked(a,'alpha');
      await saveAndClose(b,'delta');
    }
    await connect(b,'alpha'); await pixels(b,[38,108,202],'platform-save-reopen');
    await b.screenshot({path:resolve(output,'platform-save-reopen-phone.png')});
    await checkpoint('platform-save-reopen-restored');
    await disconnect(b);
    if (nativeClose) {
      await connect(a,'alpha');
      await pixels(a,[38,108,202],'before-native-close');
      await a.locator('#screen canvas[tabindex]').focus();
      await a.keyboard.press('Control+KeyT');
      await delay(350); await navigateRemote(a,'detail/alpha');
      await pixels(a,[151,119,36],'distinct-new-second-tab');
      await a.keyboard.press('Control+Shift+Tab'); await pixels(a,[38,108,202],'two-tabs-before-native-close');
      await a.screenshot({path:resolve(output,'two-tabs-before-close.png')});
      await a.locator('#screen canvas[tabindex]').focus();
      if (nativeClose === 'quit') {
        await a.keyboard.press('Alt+f'); await delay(350); await a.keyboard.press('End'); await delay(200);
        await a.screenshot({path:resolve(output,'chromium-menu-exit.png')}); await a.keyboard.press('Enter');
      } else await a.keyboard.press('Control+Shift+KeyW');
      await delay(600); await a.screenshot({path:resolve(output,'native-close-step.png')});
      await a.getByRole('button', {name:'连接工作区'}).waitFor({timeout:20000});
      await checkpoint('user-closed-last-window');
      await connect(b,'alpha'); await pixels(b,[38,108,202],'user-closed-window-restored');
      await b.screenshot({path:resolve(output,'user-closed-window-restored.png')});
      await b.locator('#screen canvas[tabindex]').focus(); await b.keyboard.press('Control+Tab');
      await pixels(b,[191,144,50],'second-tab-restored-with-original-history');
      await b.screenshot({path:resolve(output,'second-tab-restored.png')});
      await checkpoint('two-distinct-tab-histories-restored-after-native-' + nativeClose);
      await checkpoint('user-reopened-and-restored'); await disconnect(b);
    }
  } finally {
    await Promise.all(browsers.map(browser => browser.close()));
    await writeFile(resolve(output,'traffic.json'),JSON.stringify({
      elapsedMs:Date.now()-started, unit:'WebSocket payload bytes only, including RFB control, excluding transport overhead',
      clients:traffic
    },null,2));
  }
}
if (process.argv[2] === 'viewer') { await clients(process.argv[3]); process.disconnect(); }
else await coordinator();
