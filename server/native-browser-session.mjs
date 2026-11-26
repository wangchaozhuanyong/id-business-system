import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {
  NativeBrowserError,
  createLocalProxyTunnel,
  getActiveBrowser,
  getPageTargetWsUrl,
  launchNativeChrome,
  parseProxyServerConfig,
  resolveDynamicProxySession
} from './native-chrome-runner.mjs';
import { parseSessionPayload } from './native-browser-workbench.mjs';

const REGION_TO_COUNTRY = Object.freeze({
  ph: 'PH',
  eg: 'EG'
});

const REGION_LABELS = Object.freeze({
  auto: '自动（直连）',
  ph: '菲律宾 (PH)',
  eg: '埃及 (EG)'
});

/**
 * Load configured region proxies from environment variables.
 */
export function loadEnvRegionProxies(env = process.env) {
  const map = {};
  if (env.NATIVE_WORKBENCH_PROXIES_JSON) {
    try {
      const parsed = JSON.parse(env.NATIVE_WORKBENCH_PROXIES_JSON);
      if (parsed && typeof parsed === 'object') {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'string' && val.trim()) {
            map[key.toLowerCase()] = val.trim();
          }
        }
      }
    } catch {
      // Ignore malformed JSON env
    }
  }
  if (env.NATIVE_WORKBENCH_PROXY_PH) map.ph = env.NATIVE_WORKBENCH_PROXY_PH.trim();
  if (env.NATIVE_WORKBENCH_PROXY_EG) map.eg = env.NATIVE_WORKBENCH_PROXY_EG.trim();
  return map;
}

/**
 * Resolve the effective proxy URL and expected country code for a launch request.
 */
export function resolveWorkbenchProxy({
  proxyRegion = 'auto',
  customProxyUrl = '',
  savedProxyUrl = '',
  regionProxies = loadEnvRegionProxies()
} = {}) {
  const region = ['auto', 'ph', 'eg'].includes(String(proxyRegion || '').toLowerCase())
    ? String(proxyRegion).toLowerCase()
    : 'auto';
  const expectedCountry = REGION_TO_COUNTRY[region] || '';
  const explicitProxy = String(customProxyUrl || '').trim() || String(savedProxyUrl || '').trim();
  const regionProxy = region !== 'auto' ? String(regionProxies?.[region] || '').trim() : '';
  const proxyUrl = explicitProxy || regionProxy;

  if (expectedCountry && !proxyUrl) {
    throw new NativeBrowserError(
      400,
      `已选择${REGION_LABELS[region]}线路，但未配置可用代理。请在界面填写代理地址或配置 ${region.toUpperCase()} 地区代理。`
    );
  }

  return {
    region,
    regionLabel: REGION_LABELS[region] || REGION_LABELS.auto,
    expectedCountry,
    proxyUrl
  };
}

/**
 * Perform a lightweight HTTPS GET through an HTTP CONNECT proxy tunnel.
 */
async function fetchJsonViaHttpProxy(proxyConfig, targetUrl, timeoutMs = 5000) {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port || 443);
  const authHeader =
    proxyConfig.username || proxyConfig.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64')}\r\n`
      : '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('代理出口检测超时'));
    }, timeoutMs);

    const socket = net.connect(proxyConfig.port, proxyConfig.host, () => {
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${target.hostname}:${targetPort}\r\n` +
          authHeader +
          'Proxy-Connection: Keep-Alive\r\n\r\n'
      );
    });

    let headerBuf = Buffer.alloc(0);
    let tunneled = false;

    const fail = (err) => {
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      reject(err);
    };

    socket.on('error', fail);
    socket.on('data', (chunk) => {
      if (tunneled) return;
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const endIdx = headerBuf.indexOf('\r\n\r\n');
      if (endIdx === -1) return;

      const statusLine = headerBuf.subarray(0, headerBuf.indexOf('\r\n')).toString('utf8');
      if (!statusLine.includes('200')) {
        return fail(new Error(`代理 CONNECT 握手失败: ${statusLine}`));
      }
      tunneled = true;

      const tlsSocket = tls.connect(
        { socket, servername: target.hostname },
        () => {
          tlsSocket.write(
            `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
              `Host: ${target.hostname}\r\n` +
              'User-Agent: id-workbench-probe/1.0\r\n' +
              'Accept: application/json\r\n' +
              'Connection: close\r\n\r\n'
          );
        }
      );

      let raw = '';
      tlsSocket.setEncoding('utf8');
      tlsSocket.on('data', (d) => {
        raw += d;
      });
      tlsSocket.on('end', () => {
        clearTimeout(timer);
        const bodyIdx = raw.indexOf('\r\n\r\n');
        const body = bodyIdx >= 0 ? raw.slice(bodyIdx + 4) : raw;
        try {
          resolve(JSON.parse(body.trim()));
        } catch {
          reject(new Error('代理出口检测返回非 JSON 数据'));
        }
      });
      tlsSocket.on('error', fail);
    });
  });
}

/**
 * Default exit IP/country probe (supports direct fetch or HTTP proxy).
 */
export async function probeExitCountry(proxyUrl = '') {
  const endpoint = 'https://api.country.is/';
  if (!proxyUrl) {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`出口检测接口返回 ${res.status}`);
    const data = await res.json();
    return { ip: String(data?.ip || ''), country: String(data?.country || '').toUpperCase() };
  }

  const parsed = parseProxyServerConfig(proxyUrl);
  if (!parsed) {
    throw new NativeBrowserError(400, '代理地址格式无效，请检查协议、主机与端口');
  }
  const username = parsed.username ? resolveDynamicProxySession(parsed.username) : '';
  const data = await fetchJsonViaHttpProxy(
    { ...parsed, username },
    endpoint,
    5000
  );
  return { ip: String(data?.ip || ''), country: String(data?.country || '').toUpperCase() };
}

/**
 * Verify that the selected proxy (or direct exit) matches the expected country.
 */
export async function verifyProxyExitCountry({
  proxyUrl = '',
  expectedCountry = '',
  probeFn = probeExitCountry
} = {}) {
  if (!expectedCountry && !proxyUrl) {
    return { verified: false, ip: '', country: '', mode: 'direct' };
  }
  try {
    const info = await probeFn(proxyUrl);
    const country = String(info?.country || '').toUpperCase();
    const ip = String(info?.ip || '');
    if (expectedCountry && country !== expectedCountry) {
      throw new NativeBrowserError(
        400,
        `出口国家校验失败：期望 ${expectedCountry}，实际检测到 ${country || '未知'} (${ip || '无 IP'})`
      );
    }
    return {
      verified: Boolean(country),
      ip,
      country,
      mode: proxyUrl ? 'proxy' : 'direct'
    };
  } catch (err) {
    if (err instanceof NativeBrowserError) throw err;
    if (expectedCountry) {
      throw new NativeBrowserError(400, `代理出口检测失败: ${err.message || '网络不可达'}`);
    }
    return { verified: false, ip: '', country: '', mode: proxyUrl ? 'proxy' : 'direct', error: err.message };
  }
}

/**
 * Lightweight CDP client over WebSocket for one-shot commands or streaming sessions.
 */
export function createCdpClient(wsUrl, WebSocketImpl = globalThis.WebSocket) {
  const ws = new WebSocketImpl(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Set();

  const ready = new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanupInit();
      resolve();
    };
    const onError = (err) => {
      cleanupInit();
      reject(new NativeBrowserError(500, `CDP 连接失败: ${err?.message || 'WebSocket 错误'}`));
    };
    const cleanupInit = () => {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    };
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    } else {
      ws.onopen = onOpen;
      ws.onerror = onError;
    }
  });

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP 命令执行失败'));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const listener of eventListeners) {
        try {
          listener(msg);
        } catch {}
      }
    }
  };

  ws.onclose = () => {
    for (const { reject } of pending.values()) {
      reject(new Error('CDP 连接已关闭'));
    }
    pending.clear();
  };

  const send = async (method, params = {}) => {
    await ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const onEvent = (fn) => {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  };

  const close = () => {
    try {
      ws.close();
    } catch {}
  };

  return { ready, send, onEvent, close };
}

/**
 * Evaluate the live ChatGPT session inside the Chrome page target and compare against expectedEmail.
 */
export async function verifyChatGptLogin({
  port,
  expectedEmail = '',
  getTargetWsUrlFn = getPageTargetWsUrl,
  createCdpClientFn = createCdpClient,
  timeoutMs = 6000
} = {}) {
  const wsUrl = await getTargetWsUrlFn(port);
  const cdp = createCdpClientFn(wsUrl);
  const deadline = Date.now() + timeoutMs;

  const evalExpr = `(async () => {
    const href = String(location.href || '');
    if (!href.includes('chatgpt.com')) {
      return { loggedIn: false, reason: 'not_on_chatgpt', url: href };
    }
    try {
      const res = await fetch('/backend-api/me', { credentials: 'include' });
      if (res.ok) {
        const me = await res.json();
        return {
          loggedIn: Boolean(me && (me.email || me.id)),
          email: String(me?.email || ''),
          accountId: String(me?.id || ''),
          url: href
        };
      }
      return { loggedIn: false, status: res.status, reason: 'me_unauthorized', url: href };
    } catch (err) {
      return { loggedIn: false, reason: 'fetch_error', error: String(err?.message || err), url: href };
    }
  })()`;

  try {
    await cdp.ready;
    await cdp.send('Runtime.enable');
    let probe = null;
    while (Date.now() < deadline) {
      const res = await cdp.send('Runtime.evaluate', {
        expression: evalExpr,
        awaitPromise: true,
        returnByValue: true
      });
      probe = res?.result?.value || null;
      if (probe?.loggedIn) break;
      if (probe?.status === 401 || probe?.status === 403) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    const actualEmail = String(probe?.email || '').trim();
    const expected = String(expectedEmail || '').trim();
    const loggedIn = Boolean(probe?.loggedIn);

    if (!loggedIn) {
      return {
        status: 'unauthenticated',
        loggedIn: false,
        actualEmail: '',
        expectedEmail: expected,
        url: probe?.url || '',
        message: '未检测到有效登录态，请在站内操作窗内手动登录或检查 JSON 凭据'
      };
    }

    if (expected && actualEmail && actualEmail.toLowerCase() !== expected.toLowerCase()) {
      return {
        status: 'mismatch',
        loggedIn: true,
        actualEmail,
        expectedEmail: expected,
        url: probe?.url || '',
        message: `已登录账号 (${actualEmail}) 与 JSON 账号 (${expected}) 不一致`
      };
    }

    if (expected && actualEmail) {
      return {
        status: 'matched',
        loggedIn: true,
        actualEmail,
        expectedEmail: expected,
        url: probe?.url || '',
        message: `登录核验通过：${actualEmail}`
      };
    }

    return {
      status: 'logged_in_unverified',
      loggedIn: true,
      actualEmail,
      expectedEmail: expected,
      url: probe?.url || '',
      message: '检测到登录态，但未能核对完整邮箱信息'
    };
  } catch (err) {
    return {
      status: 'error',
      loggedIn: false,
      actualEmail: '',
      expectedEmail: String(expectedEmail || '').trim(),
      url: '',
      message: `登录核验异常: ${err.message || '未知错误'}`
    };
  } finally {
    cdp.close();
  }
}

/**
 * Launch an isolated prototype browser session with proxy validation and real login verification.
 */
export async function launchPrototypeWorkbenchSession({
  sessionJson,
  proxyRegion = 'auto',
  customProxyUrl = '',
  ownerId = 'local-operator',
  regionProxies = loadEnvRegionProxies(),
  probeFn = probeExitCountry,
  launchChromeFn = launchNativeChrome,
  verifyLoginFn = verifyChatGptLogin
} = {}) {
  const parsed = parseSessionPayload(sessionJson);
  const proxyConfig = resolveWorkbenchProxy({
    proxyRegion,
    customProxyUrl,
    regionProxies
  });

  const exitInfo = await verifyProxyExitCountry({
    proxyUrl: proxyConfig.proxyUrl,
    expectedCountry: proxyConfig.expectedCountry,
    probeFn
  });

  const safeProfileKey = `proto_${parsed.profileKey}`;
  const launchResult = await launchChromeFn({
    profileKey: safeProfileKey,
    proxyUrl: proxyConfig.proxyUrl,
    token: parsed.token,
    deviceId: parsed.deviceId,
    windowSize: '1280,800',
    ownerId,
    exitInfo: {
      ...exitInfo,
      region: proxyConfig.region,
      regionLabel: proxyConfig.regionLabel
    }
  });

  const loginVerification = await verifyLoginFn({
    port: launchResult.port,
    expectedEmail: parsed.email
  });

  return {
    ok: true,
    profileKey: safeProfileKey,
    pid: launchResult.pid,
    account: {
      email: parsed.email,
      plan: parsed.plan,
      deviceId: parsed.deviceId,
      expires: parsed.expires
    },
    proxy: {
      region: proxyConfig.region,
      regionLabel: proxyConfig.regionLabel,
      exitInfo
    },
    loginVerification
  };
}

/**
 * Bridge a client WebSocket to a running Chrome page target's CDP screencast and input events.
 */
export async function attachPrototypeWsBridge({
  ws,
  profileKey,
  ownerId = '',
  getBrowserFn = getActiveBrowser,
  getTargetWsUrlFn = getPageTargetWsUrl,
  createCdpClientFn = createCdpClient,
  verifyLoginFn = verifyChatGptLogin
} = {}) {
  const browser = getBrowserFn(profileKey);
  if (!browser) {
    ws.sendJson({ type: 'error', message: '浏览器实例未运行或已关闭' });
    ws.close(1008, 'Browser not running');
    return;
  }
  if (browser.ownerId && ownerId && browser.ownerId !== ownerId) {
    ws.sendJson({ type: 'error', message: '无权访问该浏览器会话' });
    ws.close(1008, 'Forbidden');
    return;
  }

  let cdp;
  try {
    const targetWsUrl = await getTargetWsUrlFn(browser.port);
    cdp = createCdpClientFn(targetWsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 75,
      maxWidth: 1280,
      maxHeight: 800
    });
  } catch (err) {
    ws.sendJson({ type: 'error', message: `连接浏览器画面失败: ${err.message || '未知错误'}` });
    ws.close(1011, 'CDP attach failed');
    cdp?.close();
    return;
  }

  ws.sendJson({
    type: 'ready',
    profileKey,
    exitInfo: browser.exitInfo || null
  });

  const offEvent = cdp.onEvent((msg) => {
    if (ws.isClosed) return;
    if (msg.method === 'Page.screencastFrame' && msg.params) {
      const { data, metadata, sessionId } = msg.params;
      ws.sendJson({ type: 'frame', data, metadata });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    } else if (msg.method === 'Page.frameNavigated' && msg.params?.frame?.parentId === undefined) {
      ws.sendJson({ type: 'navigated', url: msg.params.frame.url || '' });
    }
  });

  ws.onMessage(async (raw) => {
    let cmd;
    try {
      cmd = JSON.parse(String(raw));
    } catch {
      return;
    }
    try {
      switch (cmd.type) {
        case 'mouse':
          await cdp.send('Input.dispatchMouseEvent', {
            type: cmd.eventType,
            x: Math.round(Number(cmd.x) || 0),
            y: Math.round(Number(cmd.y) || 0),
            button: cmd.button || 'left',
            clickCount: Number(cmd.clickCount) || 1
          });
          break;
        case 'wheel':
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Math.round(Number(cmd.x) || 0),
            y: Math.round(Number(cmd.y) || 0),
            deltaX: Number(cmd.deltaX) || 0,
            deltaY: Number(cmd.deltaY) || 0
          });
          break;
        case 'key':
          await cdp.send('Input.dispatchKeyEvent', {
            type: cmd.eventType,
            key: cmd.key || '',
            code: cmd.code || '',
            windowsVirtualKeyCode: Number(cmd.keyCode) || 0,
            modifiers: Number(cmd.modifiers) || 0,
            ...(cmd.text ? { text: cmd.text } : {})
          });
          break;
        case 'text':
          if (typeof cmd.text === 'string' && cmd.text.length > 0) {
            await cdp.send('Input.insertText', { text: cmd.text });
          }
          break;
        case 'navigate':
          if (typeof cmd.url === 'string' && /^https?:\/\//i.test(cmd.url.trim())) {
            await cdp.send('Page.navigate', { url: cmd.url.trim() });
          }
          break;
        case 'reload':
          await cdp.send('Page.reload');
          break;
        case 'back':
          await cdp.send('Runtime.evaluate', { expression: 'history.back()' });
          break;
        case 'recheckLogin': {
          const verification = await verifyLoginFn({
            port: browser.port,
            expectedEmail: cmd.expectedEmail || ''
          });
          ws.sendJson({ type: 'loginVerification', verification });
          break;
        }
      }
    } catch (err) {
      ws.sendJson({ type: 'error', message: err.message || '操作执行失败' });
    }
  });

  ws.onClose(() => {
    offEvent();
    cdp.send('Page.stopScreencast').catch(() => {});
    cdp.close();
  });
}
