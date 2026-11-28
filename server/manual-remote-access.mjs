import { createHash, randomBytes } from 'node:crypto';
import { request as sendRequest } from 'node:http';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { canManageManualRenewals } from './access-roles.mjs';
import { manualRechargeWindowId } from './manual-browser-records.mjs';
import { manualDesktopOwnerKey, manualDesktopWorkspaceKey } from './manual-desktop-workspace.mjs';

export const manualWorkspacePrefix = '/manual-workspaces/';
const routePattern = /^\/manual-workspaces\/([A-Za-z0-9_-]{1,128})\/(.*)$/;
const assetPattern = /^client\/((?:core|vendor)\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.js)$/;
const keyPattern = /^manual-v1-[a-f0-9]{64}$/;
const rechargeIdPattern = /^recharge-[a-f0-9]{64}$/;
const runPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const viewerUrl = (id, runId) => manualWorkspacePrefix + id + '/?run=' + runId;
const canonicalIp = ip => isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname : ip;
const wsAccept = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const staleRouteMessage = '套餐或代理线路配置已变更，请返回工作台重新测速。';
const errors = new Map([[400, '工作区请求无效。'], [401, '请先登录业务系统，再打开工作区。'],
  [403, '无权访问此工作区。'], [404, '找不到此记录或资源。'], [405, '不支持此操作。'],
  [409, '桌面连接已断开，请重新连接。'],
  [423, '你已有另一个账号工作区正在运行。请回到该账号的工作区，点击「保存并关闭工作区」，再连接此账号。'],
  [422, '浏览器出口未通过核验，请返回工作台重新测速。'],
  [429, '可用工作区已满，请稍后重试。'],
  [503, '桌面服务暂不可用，请稍后重试。']]);

class AccessError extends Error {
  constructor(status, message = errors.get(status)) { super(message); this.status = status; }
}

const controlScript = `
const status = document.getElementById('status');
const toggle = document.getElementById('connect');
const keyboard = document.getElementById('keyboard');
const keyboardInput = document.getElementById('keys');
const scale = document.getElementById('scale');
const stop = document.getElementById('stop');
let desktop;
let stopping = false;
const recharge = location.pathname.startsWith('/manual-workspaces/recharge-');
const run = recharge ? location.search : '';
const legacy = recharge && !run;
const viewId = recharge ? crypto.randomUUID() : '';
const runHeaders = recharge ? {'X-Manual-View': viewId} : {};
const workbench = '/#/recharge/start';
const activityWarning = document.getElementById('idle-warning');
let idleDeadline = 0;
let lastTouch = 0;
let touchTimer;
let leaving = false;
function touch() {
  if (!recharge || !desktop || stopping || leaving) return;
  idleDeadline = Date.now() + 300_000;
  activityWarning.hidden = true;
  if (touchTimer) return;
  const current = desktop;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    if (current !== desktop || stopping || leaving) return;
    lastTouch = Date.now();
    fetch('./activity' + run, {method:'POST', credentials:'same-origin', headers:runHeaders}).catch(() => {});
  }, Math.max(0, 2000 - (Date.now() - lastTouch)));
}
function reset(message) {
  clearTimeout(touchTimer);
  touchTimer = null;
  idleDeadline = 0;
  activityWarning.hidden = true;
  desktop = null;
  keyboard.hidden = scale.hidden = true;
  stop.hidden = !recharge;
  stop.disabled = false;
  keyboardInput.value = '';
  toggle.disabled = false;
  toggle.textContent = '连接工作区';
  status.textContent = message;
}
toggle.addEventListener('click', async () => {
  if (desktop) { desktop.disconnect(); return; }
  toggle.disabled = true;
  status.textContent = '正在连接桌面…';
  try {
    const { default: RFB } = await import('./client/core/rfb.js');
    const response = await fetch('./open' + run, { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error(await response.text());
    const prepared = response.status === 200 ? await response.json() : null;
    const url = new URL('./stream' + run, location.href);
    if (recharge) url.searchParams.set('view', viewId);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(document.getElementById('screen'), url.href);
    desktop = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener('connect', () => {
      toggle.disabled = false;
      toggle.textContent = '断开连接';
      status.textContent = prepared
        ? '已连接 · 出口 ' + prepared.exitIp + ' · ' + prepared.country + ' · 请在 ChatGPT 中核对账号'
        : '已连接';
      scale.textContent = '原始大小';
      keyboard.hidden = scale.hidden = stop.hidden = false;
      idleDeadline = Date.now() + 300_000;
      async function recordConnection() {
        if (desktop !== rfb || stopping || leaving) return;
        const result = await fetch('./connected' + run, { method: 'POST', credentials: 'same-origin', headers:runHeaders }).catch(() => null);
        if (desktop !== rfb || stopping || leaving) return;
        if (!result?.ok) {
          status.textContent = '窗口已打开，记录待保存。';
          setTimeout(recordConnection, 2500);
        } else if (status.textContent === '窗口已打开，记录待保存。') status.textContent = '已连接，窗口记录已保存。';
      }
      void recordConnection();
    });
    rfb.addEventListener('disconnect', event => {
      if (desktop !== rfb) return;
      if (stopping) {
        desktop = null;
        keyboard.hidden = scale.hidden = stop.hidden = true;
      } else reset(recharge ? '连接已断开。窗口仍运行时可重连，结束后请返回工作台重新测速。' : event.detail.clean ? '已断开。再次连接可继续操作。' : '连接中断，请重新连接。');
    });
    rfb.addEventListener('credentialsrequired', () => rfb.disconnect());
  } catch (error) {
    reset(${JSON.stringify([...errors.values(), staleRouteMessage])}.includes(error.message) ? error.message : '无法连接工作区，请检查登录状态或稍后重试。');
  }
});
stop.addEventListener('click', async () => {
  if ((!desktop && !recharge) || stopping) return;
  const prompt = recharge ? '结束此窗口并返回工作台？其他设备上此窗口的连接也会断开。' : '保存并关闭此账号的工作区？其他设备上此账号的连接也会断开。下次连接会恢复浏览器保存的网页。';
  if (!window.confirm(prompt)) return;
  const current = desktop;
  stopping = true;
  stop.disabled = toggle.disabled = true;
  status.textContent = '正在保存并关闭工作区…';
  const result = await fetch('./stop' + run, { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  stopping = false;
  if (result?.ok) {
    const stillConnected = desktop === current;
    reset(recharge ? '窗口已关闭，浏览器资料已保留。' : '工作区已关闭。下次连接会恢复浏览器保存的网页。');
    if (stillConnected) current?.disconnect();
    if (recharge) { leaving = true; location.replace(workbench); }
    return;
  }
  const message = result?.status === 423 ? ${JSON.stringify(errors.get(423))} : '未能确认工作区已保存并关闭，请重新检查连接后重试。';
  if (desktop === current) {
    stop.disabled = toggle.disabled = false;
    status.textContent = message;
  } else reset(message);
});
scale.addEventListener('click', () => {
  if (!desktop) return;
  desktop.scaleViewport = !desktop.scaleViewport;
  desktop.clipViewport = !desktop.scaleViewport;
  desktop.dragViewport = !desktop.scaleViewport;
  scale.textContent = desktop.scaleViewport ? '原始大小' : '适合屏幕';
});
keyboard.addEventListener('click', () => {
  if (!desktop) return;
  keyboardInput.value = '\\u200b';
  keyboardInput.focus();
});
for (const name of ['paste','drop']) keyboardInput.addEventListener(name, event => event.preventDefault());
keyboardInput.addEventListener('beforeinput', event => {
  if (['insertFromPaste','insertFromDrop'].includes(event.inputType)) event.preventDefault();
});
function sendTypedText() {
  if (!desktop) return;
  const value = keyboardInput.value;
  keyboardInput.value = '\\u200b';
  if (!value) { desktop.sendKey(0xff08, 'Backspace'); return; }
  for (const character of value.replace(/^\\u200b/, '')) {
    const code = character.codePointAt(0);
    desktop.sendKey(code <= 255 ? code : 0x1000000 + code, null);
  }
}
keyboardInput.addEventListener('input', event => { if (!event.isComposing) sendTypedText(); });
keyboardInput.addEventListener('compositionend', sendTypedText);
keyboardInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && desktop) {
    event.preventDefault(); desktop.sendKey(0xff0d, 'Enter');
  }
});
keyboardInput.addEventListener('blur', () => { keyboardInput.value = ''; });
window.addEventListener('pagehide', () => desktop?.disconnect());
if (recharge) {
  stop.hidden = false;
  stop.textContent = '结束并返回工作台';
  // A normal reload keeps the same run. The previous history entry represents
  // the deliberate Back action and offers immediate release of the last viewer.
  if (history.state?.manualViewer !== run) history.pushState({manualViewer: run}, '');
  addEventListener('popstate', async () => {
    if (leaving) return;
    leaving = true;
    try { if (!legacy) await fetch('./leave' + run, {method:'POST',credentials:'same-origin',headers:runHeaders,signal:AbortSignal.timeout(45000)}); }
    finally { location.replace(workbench); }
  });
  for (const name of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart', 'input']) {
    document.addEventListener(name, event => {
      if (event.isTrusted && (event.target === keyboardInput || document.getElementById('screen').contains(event.target))) touch();
    }, {capture:true,passive:true});
  }
  activityWarning.onclick = event => { if (event.isTrusted) touch(); };
  setInterval(() => {
    if (desktop && idleDeadline) activityWarning.hidden = Date.now() < idleDeadline - 30000;
  }, 1000);
  if (legacy) {
    toggle.hidden = true;
    status.textContent = '此链接属于旧版工作区。请结束旧窗口，再在工作台测速打开。';
  } else toggle.click();
}
`;
const scriptHash = createHash('sha256').update(controlScript).digest('base64');
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>账号工作区</title>
<style>*{box-sizing:border-box}body{margin:0;display:flex;flex-direction:column;height:100vh;height:100dvh;background:#152137;color:#18263d;font:15px/1.45 system-ui,sans-serif}
header{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:8px max(12px,env(safe-area-inset-left));background:#fff}
h1{font-size:17px;margin:0}#status{flex:1 1 12em;color:#475569}button{min-height:44px;border:1px solid #bcc5d2;border-radius:6px;padding:6px 12px;color:inherit;background:white;font:inherit}
#connect{background:#174ea6;color:white;border-color:#174ea6}button:focus-visible{outline:3px solid #79aefd}#screen{flex:1;min-height:0;overflow:hidden}#keys{position:fixed;opacity:0;pointer-events:none;left:0;top:0;width:1px;height:1px;font-size:16px}
@media(max-width:580px){
  header{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;grid-template-areas:"title status connect" "scale keyboard stop";gap:5px 6px}
  header:has(#stop[hidden]){grid-template-areas:"title title connect" "status status status"}
  h1{grid-area:title;font-size:16px}#status{grid-area:status;min-width:0;font-size:14px;overflow-wrap:anywhere}
  header button{min-width:44px;padding:6px 8px;font-size:14px;white-space:nowrap}
  #connect{grid-area:connect;justify-self:end}#scale{grid-area:scale}#keyboard{grid-area:keyboard}#stop{grid-area:stop}
}</style></head>
<body><header><h1>账号工作区</h1><span id="status" role="status">连接后可继续上次打开的网页。</span>
<button id="connect">连接工作区</button><button id="scale" hidden>原始大小</button><button id="keyboard" hidden>键盘</button><button id="stop" hidden>保存并关闭工作区</button></header>
<button hidden id="idle-warning">即将因长时间无操作结束，点击继续使用</button>
<main id="screen" aria-label="账号桌面"></main><input id="keys" aria-label="远程键盘" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" tabindex="-1">
<script type="module">${controlScript}</script></body></html>`;

function reply(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Cache-Control': 'private, no-store', 'Content-Type': type,
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}

function authorize(request, getActor, store, expectedOrigin, mutation) {
  const actor = getActor(request);
  if (!actor) throw new AccessError(request.localAuthUnavailable ? 503 : 401);
  if (!canManageManualRenewals(actor)) throw new AccessError(403);
  const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
  if ((mutation || origin) && origin !== expectedOrigin) throw new AccessError(403);
  if (site && !['same-origin', 'none'].includes(site)) throw new AccessError(403);
  const [rawPath, query] = request.url.split('?', 2);
  const match = routePattern.exec(rawPath);
  if (!match) throw new AccessError(404);
  const [, id, path] = match;
  const recharge = rechargeIdPattern.test(id);
  if (recharge && !['admin', 'super'].includes(actor.role)) throw new AccessError(403);
  const hasRun = recharge && !assetPattern.test(path);
  const queryParts = query?.split('&');
  const runId = queryParts?.[0]?.slice(4);
  const viewId = hasRun && path === 'stream' ? queryParts?.[1]?.slice(5) : request.headers['x-manual-view'];
  const legacy = hasRun && query === undefined && ['', 'stop'].includes(path);
  if (hasRun && !legacy) {
    const streaming = path === 'stream';
    if (!runPattern.test(runId || '') || (streaming && !runPattern.test(viewId || '')) ||
        (viewId !== undefined && !runPattern.test(viewId)) ||
        request.url !== rawPath + '?run=' + runId + (streaming ? '&view=' + viewId : '')) throw new AccessError(404);
  } else if (query !== undefined) throw new AccessError(404);
  let key;
  try {
    key = recharge ? manualDesktopWorkspaceKey({ operatorId: actor.id, accountId: id })
      : store.resolveManualWorkspace(id, actor).key;
  } catch (error) { throw new AccessError([401, 403, 404].includes(error.status) ? error.status : 503); }
  if (!keyPattern.test(key)) throw new AccessError(503);
  return { id, path, key, actor, recharge, runId, viewId, legacy };
}

function brokerRequest(socketPath, path, method, owner, payload, runId, leavingView) {
  const body = payload && Buffer.from(JSON.stringify(payload));
  const headers = { ...(runId && { 'X-Manual-Run': runId }), ...(leavingView && { 'X-Manual-Leaving-View': leavingView }), ...(owner && { 'X-Manual-Owner': owner }), ...(body && {
    'Content-Type': 'application/json', 'Content-Length': body.length
  }) };
  return new Promise((resolve, reject) => {
    // A cold start includes service activation and the broker's 30-second display check.
    const timeout = body ? 65_000 : method === 'POST' ? 45_000 : runId ? 55_000 : 10_000;
    const request = sendRequest({ socketPath, path, method, headers,
      agent: false, signal: AbortSignal.timeout(timeout) },
      async response => {
        try {
          if (![200, 204].includes(response.statusCode)) {
            response.destroy();
            throw new AccessError([404, 409, 422, 423, 429].includes(response.statusCode) ? response.statusCode : 503);
          }
          let size = 0;
          const chunks = [];
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw new AccessError(503);
            if (method === 'GET' || body) chunks.push(chunk);
          }
          resolve(Buffer.concat(chunks));
        } catch (error) { reject(error); }
      });
    request.on('error', reject).end(body);
  });
}

function rechargeResult(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new AccessError(503); }
  if (body.length > 512 || !isIP(parsed?.exitIp || '') ||
      typeof parsed.country !== 'string' || !/^[A-Z]{2}$/.test(parsed.country) ||
      parsed.accountStatus !== 'check-in-browser') throw new AccessError(503);
  return { exitIp: parsed.exitIp, country: parsed.country, accountStatus: 'check-in-browser' };
}

export function createManualRemoteAccess({ socketPath, publicOrigin, getActor, store, checkRechargeRoute, rechargeOnly = false, recheckInterval = 5000 }) {
  if (socketPath && (!isAbsolute(socketPath) || /[\0\r\n]/.test(socketPath)))
    throw new Error('工作区服务必须使用绝对 Unix socket 路径');
  const streams = new Set();
  const originFor = request => publicOrigin || 'http://' + request.headers.host;
  const validate = (req, write) => {
    const identity = authorize(req, getActor, store, originFor(req), write);
    if (rechargeOnly && !identity.recharge) throw new AccessError(404);
    return identity;
  };
  const statusOf = error => error instanceof AccessError ? error.status : 503;
  const sameSession = (entry, request, identity) => !entry.socket.destroyed &&
    entry.key === identity.key && entry.runId === identity.runId && entry.viewId === identity.viewId && entry.actorId === identity.actor.id &&
    entry.request.headers.cookie === request.headers.cookie;

  async function rechargeReady(request) {
    const local = request?.socket?.localAddress === '127.0.0.1' && request.socket.remoteAddress === '127.0.0.1' &&
      /^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(request.headers.host || '');
    if (!socketPath || (!publicOrigin && !local)) return false;
    try {
      const body = await brokerRequest(socketPath, '/v1/recharge/status', 'GET');
      return body.length < 128 && JSON.parse(body)?.rechargeBootstrap === 1;
    } catch { return false; }
  }

  function rechargeActor(request, mutation) {
    const actor = getActor(request);
    if (!actor) throw new AccessError(401);
    if (!['admin', 'super'].includes(actor.role) || ((mutation || request.headers.origin) && request.headers.origin !== originFor(request)) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      throw new AccessError(403);
    return actor;
  }

  async function rechargeOccupancy(request) {
    const actor = rechargeActor(request, false);
    const body = await brokerRequest(socketPath, '/v1/recharge/occupancy', 'GET', manualDesktopOwnerKey(actor.id));
    const active = JSON.parse(body).active;
    if (active === null) return null;
    if (!rechargeIdPattern.test(active?.id) || !runPattern.test(active?.runId)) throw new AccessError(503);
    const delay = active.recheckAfterMs;
    return { id: active.id, runId: active.runId, viewerUrl: viewerUrl(active.id, active.runId),
      recheckAfterMs: Number.isSafeInteger(delay) && delay >= 1000 && delay <= 310_000 ? delay : 15_000 };
  }

  async function releaseLegacyRecharge(request, {email}) {
    const actor = rechargeActor(request, true);
    const id = manualRechargeWindowId(actor.id, email);
    const key = manualDesktopWorkspaceKey({operatorId: actor.id, accountId:id});
    await brokerRequest(socketPath, '/v1/workspaces/' + key + '/stop-legacy', 'POST', manualDesktopOwnerKey(actor.id));
  }

  async function releaseRecharge(request, {id, runId}, leavingView) {
    const actor = rechargeActor(request, true);
    if (!rechargeIdPattern.test(id) || !runPattern.test(runId)) throw new AccessError(400);
    const key = manualDesktopWorkspaceKey({operatorId: actor.id, accountId: id});
    await brokerRequest(socketPath, '/v1/workspaces/' + key + '/stop', 'POST',
      manualDesktopOwnerKey(actor.id), null, runId, leavingView);
    if (!leavingView) for (const entry of streams) {
      if (entry.key === key && entry.runId === runId) entry.socket.destroy();
    }
  }

  async function checkCurrentRoute(request, identity) {
    if (!checkRechargeRoute || !identity.recharge) return;
    try {
      await checkRechargeRoute(identity.actor, identity.id, identity.runId);
    } catch (error) {
      if (error?.status !== 409) throw new AccessError(503);
      await releaseRecharge(request, identity);
      throw new AccessError(409, staleRouteMessage);
    }
  }

  async function prepareRecharge(request, { email, proxyUrl, expectedCountry, expectedIp, runId }) {
    const actor = rechargeActor(request, true);
    if (!runPattern.test(runId) || !isIP(expectedIp || '') || !/^[A-Z]{2}$/.test(expectedCountry))
      throw new AccessError(400);
    if (!await rechargeReady(request)) throw new AccessError(503);
    const id = manualRechargeWindowId(actor.id, email);
    const key = manualDesktopWorkspaceKey({ operatorId: actor.id, accountId: id });
    const result = rechargeResult(await brokerRequest(socketPath, '/v1/workspaces/' + key + '/prepare', 'POST',
      manualDesktopOwnerKey(actor.id), { email, proxyUrl, expectedCountry, expectedIp, runId, id }));
    if (canonicalIp(result.exitIp) !== canonicalIp(expectedIp) || result.country !== expectedCountry) {
      await releaseRecharge(request, {id, runId});
      throw new AccessError(422);
    }
    return { viewerUrl: viewerUrl(id, runId), runId, ...result };
  }

  async function handle(request, response) {
    try {
      const method = request.method;
      const identity = validate(request, method !== 'GET');
      const { path, key, id, actor, recharge, runId } = identity;
      if (!socketPath) throw new AccessError(503);
      if (!path && method === 'GET') {
        const streamOrigin = new URL(originFor(request));
        streamOrigin.protocol = streamOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ${streamOrigin.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        response.setHeader('Permissions-Policy', 'clipboard-read=(), clipboard-write=(), camera=(), microphone=(), geolocation=()');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return reply(response, 200, page, 'text/html; charset=utf-8');
      }
      if (path === 'open' && method === 'POST') {
        if (recharge) {
          await checkCurrentRoute(request, identity);
          const result = rechargeResult(await brokerRequest(socketPath, '/v1/workspaces/' + key + '/recharge-status',
            'GET', manualDesktopOwnerKey(actor.id), null, runId));
          return reply(response, 200, JSON.stringify(result), 'application/json; charset=utf-8');
        }
        await brokerRequest(socketPath, '/v1/workspaces/' + key + '/open', 'POST', manualDesktopOwnerKey(actor.id));
        return reply(response, 204);
      }
      if (recharge && ['stop','leave'].includes(path) && method === 'POST') {
        if (path === 'leave' && !identity.viewId) throw new AccessError(400);
        if (identity.legacy) {
          // Only the old owner's exact recharge-profile key is addressable. The
          // broker rejects an unversioned stop if a newer run owns the key.
          await brokerRequest(socketPath, '/v1/workspaces/' + key + '/stop-legacy', 'POST', manualDesktopOwnerKey(actor.id));
        } else await releaseRecharge(request, {id, runId}, path === 'leave' ? identity.viewId : undefined);
        return reply(response, 204);
      }
      if (path === 'activity' && recharge && method === 'POST') {
        if (![...streams].some(entry => sameSession(entry, request, identity))) throw new AccessError(409);
        await brokerRequest(socketPath, '/v1/workspaces/' + key + '/activity', 'POST', manualDesktopOwnerKey(actor.id), null, runId);
        return reply(response, 204);
      }
      if (path === 'stop' && method === 'POST') {
        const connected = [...streams].filter(stream => stream.key === key);
        await brokerRequest(socketPath, '/v1/workspaces/' + key + '/stop', 'POST', manualDesktopOwnerKey(actor.id));
        for (const stream of connected) stream.socket.destroy();
        return reply(response, 204);
      }
      if (path === 'connected' && method === 'POST') {
        const active = [...streams].filter(entry => sameSession(entry, request, identity));
        if (!active.length) throw new AccessError(409);
        const fresh = active.find(entry => !entry.marked && entry.receivedData);
        if (fresh) {
          if (recharge) store.markManualBrowserConnected(id, runId, actor);
          else store.markManualRenewalOpened(id, actor);
          fresh.marked = true;
        } else if (!active.some(entry => entry.marked)) throw new AccessError(409);
        return reply(response, 204);
      }
      const asset = assetPattern.exec(path);
      if (asset && method === 'GET') {
        const body = await brokerRequest(socketPath, '/v1/client/' + asset[1], 'GET');
        return reply(response, 200, body, 'text/javascript; charset=utf-8');
      }
      throw new AccessError(['', 'open', 'stop', 'connected', 'stream'].includes(path) || asset ? 405 : 404);
    } catch (error) {
      const code = statusOf(error);
      if (!response.headersSent) reply(response, code, error instanceof AccessError ? error.message : errors.get(code));
      else response.destroy();
    }
  }

  async function upgrade(request, socket, head) {
    const reject = status => {
      if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + ' Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    socket.on('error', () => socket.destroy());
    try {
      const identity = validate(request, true);
      const challenge = request.headers['sec-websocket-key'];
      if (!socketPath) throw new AccessError(503);
      if (identity.path !== 'stream') throw new AccessError(404);
      if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
          request.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(challenge || '')) throw new AccessError(400);
      const protocols = request.headers['sec-websocket-protocol'];
      if (protocols && !protocols.split(',').map(p => p.trim()).includes('binary')) throw new AccessError(400);
      await checkCurrentRoute(request, identity);
      if (socket.destroyed) return;
      const privateKey = randomBytes(16).toString('base64');
      const streamPath = identity.recharge ? '/recharge-stream' : '/stream';
      const upstream = sendRequest({ socketPath, path: '/v1/workspaces/' + identity.key + streamPath, agent: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': privateKey,
          'X-Manual-Owner': manualDesktopOwnerKey(identity.actor.id), ...(identity.runId && { 'X-Manual-Run': identity.runId, 'X-Manual-View': identity.viewId }),
          'Sec-WebSocket-Version': '13', ...(protocols && { 'Sec-WebSocket-Protocol': 'binary' }) } });
      let bridged = false;
      const deadline = setTimeout(() => upstream.destroy(), identity.recharge ? 55_000 : 10_000);
      deadline.unref();
      socket.once('close', () => { clearTimeout(deadline); upstream.destroy(); });
      upstream.once('response', response => { response.destroy(); reject([423, 429].includes(response.statusCode) ? response.statusCode : 503); });
      upstream.on('error', () => { if (!bridged) reject(503); });
      upstream.once('upgrade', (response, peer, first) => {
        clearTimeout(deadline);
        const valid = () => {
          try {
            const current = validate(request, true);
            return current.key === identity.key && current.actor.id === identity.actor.id;
          } catch { return false; }
        };
        const protocol = response.headers['sec-websocket-protocol'];
        if (socket.destroyed || response.statusCode !== 101 ||
            response.headers['sec-websocket-accept'] !== wsAccept(privateKey) ||
            response.headers.upgrade?.toLowerCase() !== 'websocket' || response.headers['sec-websocket-extensions'] ||
            (protocols ? protocol !== 'binary' : Boolean(protocol))) { peer.destroy(); return reject(503); }
        if (!valid()) { peer.destroy(); return reject(403); }
        bridged = true;
        const entry = { request, socket, key: identity.key, runId: identity.runId, viewId: identity.viewId, actorId: identity.actor.id, marked: false, receivedData: Boolean(first.length) };
        streams.add(entry);
        const timer = setInterval(() => { if (!valid()) socket.destroy(); }, recheckInterval);
        timer.unref();
        const cleanup = () => { clearInterval(timer); streams.delete(entry); peer.destroy(); socket.destroy(); };
        peer.on('error', cleanup).once('close', cleanup);
        socket.once('close', cleanup);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' +
          wsAccept(challenge) + (protocol ? '\r\nSec-WebSocket-Protocol: binary' : '') + '\r\n\r\n');
        if (first.length) socket.write(first);
        if (head.length) peer.write(head);
        peer.once('data', () => { entry.receivedData = true; });
        peer.pipe(socket);
        socket.pipe(peer);
      });
      upstream.end();
    } catch (error) { reject(statusOf(error)); }
  }
  return { handle, upgrade, rechargeReady, rechargeOccupancy, releaseLegacyRecharge, releaseRecharge, prepareRecharge, close() { for (const entry of streams) entry.socket.destroy(); } };
}
