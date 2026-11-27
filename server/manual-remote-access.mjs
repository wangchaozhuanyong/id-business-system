import { createHash, randomBytes } from 'node:crypto';
import { request as sendRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import { canManageManualRenewals } from './access-roles.mjs';
import { manualDesktopOwnerKey } from './manual-desktop-workspace.mjs';

export const manualWorkspacePrefix = '/manual-workspaces/';
const routePattern = /^\/manual-workspaces\/([A-Za-z0-9_-]{1,128})\/(.*)$/;
const assetPattern = /^client\/((?:core|vendor)\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.js)$/;
const keyPattern = /^manual-v1-[a-f0-9]{64}$/;
const wsAccept = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const errors = new Map([[400, '工作区请求无效。'], [401, '请先登录业务系统，再打开工作区。'],
  [403, '无权访问此工作区。'], [404, '找不到此记录或资源。'], [405, '不支持此操作。'],
  [409, '桌面连接已断开，请重新连接。'],
  [423, '你已有另一个账号工作区正在运行。请回到该账号的工作区，点击「保存并关闭工作区」，再连接此账号。'],
  [429, '可用工作区已满，请稍后重试。'],
  [503, '桌面服务暂不可用，请稍后重试。']]);

class AccessError extends Error {
  constructor(status) { super(errors.get(status)); this.status = status; }
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
function reset(message) {
  desktop = null;
  keyboard.hidden = scale.hidden = stop.hidden = true;
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
    const response = await fetch('./open', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error(await response.text());
    const url = new URL('./stream', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(document.getElementById('screen'), url.href);
    desktop = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener('connect', () => {
      toggle.disabled = false;
      toggle.textContent = '断开连接';
      status.textContent = '已连接';
      scale.textContent = '原始大小';
      keyboard.hidden = scale.hidden = stop.hidden = false;
      fetch('./connected', { method: 'POST', credentials: 'same-origin' }).then(result => {
        if (desktop === rfb && !stopping && !result.ok) status.textContent = '已连接，上次打开时间未能登记。';
      }).catch(() => { if (desktop === rfb && !stopping) status.textContent = '已连接，上次打开时间未能登记。'; });
    });
    rfb.addEventListener('disconnect', event => {
      if (desktop !== rfb) return;
      if (stopping) {
        desktop = null;
        keyboard.hidden = scale.hidden = stop.hidden = true;
      } else reset(event.detail.clean ? '已断开。再次连接可继续操作。' : '连接中断，请重新连接。');
    });
    rfb.addEventListener('credentialsrequired', () => rfb.disconnect());
  } catch (error) {
    reset(${JSON.stringify([...errors.values()])}.includes(error.message) ? error.message : '无法连接工作区，请检查登录状态或稍后重试。');
  }
});
stop.addEventListener('click', async () => {
  if (!desktop || stopping || !window.confirm('保存并关闭此账号的工作区？其他设备上此账号的连接也会断开。下次连接会恢复浏览器保存的网页。')) return;
  const current = desktop;
  stopping = true;
  stop.disabled = toggle.disabled = true;
  status.textContent = '正在保存并关闭工作区…';
  const result = await fetch('./stop', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  stopping = false;
  if (result?.ok) {
    const stillConnected = desktop === current;
    reset('工作区已关闭。下次连接会恢复浏览器保存的网页。');
    if (stillConnected) current.disconnect();
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
  const match = routePattern.exec(request.url);
  if (!match || request.url.includes('?')) throw new AccessError(404);
  const [, id, path] = match;
  let key;
  try { ({ key } = store.resolveManualWorkspace(id, actor)); }
  catch (error) { throw new AccessError([401, 403, 404].includes(error.status) ? error.status : 503); }
  if (!keyPattern.test(key)) throw new AccessError(503);
  return { id, path, key, actor };
}

function brokerRequest(socketPath, path, method, owner) {
  return new Promise((resolve, reject) => {
    // A cold start includes service activation and the broker's 30-second display check.
    const timeout = method === 'POST' ? 45_000 : 10_000;
    const request = sendRequest({ socketPath, path, method, headers: owner && { 'X-Manual-Owner': owner },
      agent: false, signal: AbortSignal.timeout(timeout) },
      async response => {
        try {
          if (![200, 204].includes(response.statusCode)) {
            response.destroy();
            throw new AccessError([404, 423, 429].includes(response.statusCode) ? response.statusCode : 503);
          }
          let size = 0;
          const chunks = [];
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw new AccessError(503);
            if (method === 'GET') chunks.push(chunk);
          }
          resolve(Buffer.concat(chunks));
        } catch (error) { reject(error); }
      });
    request.on('error', reject).end();
  });
}

export function createManualRemoteAccess({ socketPath, publicOrigin, getActor, store, recheckInterval = 5000 }) {
  if (socketPath && (!isAbsolute(socketPath) || /[\0\r\n]/.test(socketPath)))
    throw new Error('工作区服务必须使用绝对 Unix socket 路径');
  const streams = new Set();
  const originFor = request => publicOrigin || 'http://' + request.headers.host;
  const validate = (req, write) => authorize(req, getActor, store, originFor(req), write);
  const statusOf = error => error instanceof AccessError ? error.status : 503;
  const sameSession = (entry, request, identity) => !entry.socket.destroyed &&
    entry.key === identity.key && entry.actorId === identity.actor.id &&
    entry.request.headers.cookie === request.headers.cookie;

  async function handle(request, response) {
    try {
      const method = request.method;
      const identity = validate(request, method !== 'GET');
      const { path, key, id, actor } = identity;
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
        await brokerRequest(socketPath, '/v1/workspaces/' + key + '/open', 'POST', manualDesktopOwnerKey(actor.id));
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
          store.markManualRenewalOpened(id, actor);
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
      if (!response.headersSent) reply(response, code, errors.get(code));
      else response.destroy();
    }
  }

  function upgrade(request, socket, head) {
    const reject = status => {
      if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + ' Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    try {
      const identity = validate(request, true);
      const challenge = request.headers['sec-websocket-key'];
      if (!socketPath) throw new AccessError(503);
      if (identity.path !== 'stream') throw new AccessError(404);
      if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
          request.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(challenge || '')) throw new AccessError(400);
      const protocols = request.headers['sec-websocket-protocol'];
      if (protocols && !protocols.split(',').map(p => p.trim()).includes('binary')) throw new AccessError(400);
      const privateKey = randomBytes(16).toString('base64');
      const upstream = sendRequest({ socketPath, path: '/v1/workspaces/' + identity.key + '/stream', agent: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': privateKey,
          'X-Manual-Owner': manualDesktopOwnerKey(identity.actor.id),
          'Sec-WebSocket-Version': '13', ...(protocols && { 'Sec-WebSocket-Protocol': 'binary' }) } });
      let bridged = false;
      const deadline = setTimeout(() => upstream.destroy(), 10_000);
      deadline.unref();
      socket.on('error', () => socket.destroy());
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
        const entry = { request, socket, key: identity.key, actorId: identity.actor.id, marked: false, receivedData: Boolean(first.length) };
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
  return { handle, upgrade, close() { for (const entry of streams) entry.socket.destroy(); } };
}
