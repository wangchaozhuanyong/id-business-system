import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export class NativeBrowserError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Rotate session parameter in dynamic/mobile proxy username using CSPRNG.
 * Ensures dynamic residential and mobile proxies assign a fresh IP every launch.
 */
export function resolveDynamicProxySession(username) {
  if (typeof username !== 'string' || !username) return '';
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const rand = 10000000 + (array[0] % 90000000);
  if (username.includes('{session}')) {
    return username.replaceAll('{session}', String(rand));
  }
  const sessionPattern = /([-_:]session[-_:])([a-zA-Z0-9_-]+?)((?:[-_:]sessiontime[-_:]|\b|$))/i;
  if (sessionPattern.test(username)) {
    return username.replace(sessionPattern, `$1${rand}$3`);
  }
  return username;
}

/**
 * Parse raw proxy input into structured protocol, host, port, and credentials.
 */
export function parseProxyServerConfig(proxyInput) {
  if (!proxyInput || typeof proxyInput !== 'string') return null;
  const text = proxyInput.trim();
  if (!text) return null;

  if (/^[a-z0-9+.-]+:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      const protocol = u.protocol.toLowerCase();
      const username = u.username ? decodeURIComponent(u.username) : '';
      const password = u.password ? decodeURIComponent(u.password) : '';
      const host = u.hostname;
      const port = Number(u.port || (protocol === 'https:' ? 443 : 80));
      return { protocol, host, port, username, password };
    } catch {
      // fallback to manual parsing below
    }
  }

  const parts = text.split(':');
  if (parts.length === 4) {
    return {
      protocol: 'http:',
      host: parts[0],
      port: Number(parts[1]),
      username: parts[2],
      password: parts[3]
    };
  }
  if (parts.length === 2 && !text.includes('@')) {
    return {
      protocol: 'http:',
      host: parts[0],
      port: Number(parts[1]),
      username: '',
      password: ''
    };
  }
  if (text.includes('@')) {
    const at = text.lastIndexOf('@');
    const cred = text.slice(0, at);
    const hostPort = text.slice(at + 1).split(':');
    const credParts = cred.split(':');
    return {
      protocol: 'http:',
      host: hostPort[0],
      port: Number(hostPort[1] || 80),
      username: credParts[0] || '',
      password: credParts[1] || ''
    };
  }
  return null;
}

/**
 * Creates an ephemeral local loopback tunnel that transparently handles
 * upstream Basic Auth and dynamic proxy rotation without triggering
 * Chrome's native credential dialog.
 */
export async function createLocalProxyTunnel({ upstreamHost, upstreamPort, username, password }) {
  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const server = http.createServer((clientReq, clientRes) => {
    const options = {
      hostname: upstreamHost,
      port: upstreamPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        'proxy-authorization': authHeader
      }
    };
    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
    });
    proxyReq.on('error', () => {
      try {
        clientRes.destroy();
      } catch {}
    });
    clientReq.pipe(proxyReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const payload = [
        `CONNECT ${req.url} HTTP/1.1`,
        `Host: ${req.url}`,
        `Proxy-Authorization: ${authHeader}`,
        'Proxy-Connection: Keep-Alive',
        '',
        ''
      ].join('\r\n');
      upstreamSocket.write(payload);
      if (head && head.length > 0) upstreamSocket.write(head);
    });

    let established = false;
    let buffer = Buffer.alloc(0);

    upstreamSocket.on('data', (chunk) => {
      if (!established) {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString('utf8');
          if (statusLine.includes('200')) {
            established = true;
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            const remainder = buffer.slice(headerEnd + 4);
            if (remainder.length > 0) clientSocket.write(remainder);
            clientSocket.pipe(upstreamSocket);
            upstreamSocket.pipe(clientSocket);
          } else {
            try {
              clientSocket.destroy();
            } catch {}
            try {
              upstreamSocket.destroy();
            } catch {}
          }
        }
      }
    });

    upstreamSocket.on('error', () => {
      try {
        clientSocket.destroy();
      } catch {}
    });
    clientSocket.on('error', () => {
      try {
        upstreamSocket.destroy();
      } catch {}
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
    server.on('error', reject);
  });
}

/**
 * Locate the available Chrome / Chromium executable on the current system.
 */
export function findChromeExecutable() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const platform = process.platform;
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    );
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Allocate an unused ephemeral TCP port on loopback.
 */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Wait until the Chrome remote debugging HTTP endpoint becomes reachable.
 */
export async function waitForDebuggerReady(port, timeoutMs = 12000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.webSocketDebuggerUrl === 'string') {
          return data;
        }
      }
    } catch {
      // Chrome is still starting up
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new NativeBrowserError(500, 'Chrome 远程调试接口启动超时，请重试');
}

/**
 * Connect to Chrome DevTools Protocol via WebSocket and inject cookies.
 */
export async function injectCookiesAndNavigate(wsUrl, cookies, targetUrl = 'https://chatgpt.com/') {
  const ws = new globalThis.WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    let nextId = 1;
    const callbacks = new Map();

    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        callbacks.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg && msg.id && callbacks.has(msg.id)) {
          const { resolve: cbResolve, reject: cbReject } = callbacks.get(msg.id);
          callbacks.delete(msg.id);
          if (msg.error) {
            cbReject(new Error(msg.error.message || 'CDP Command failed'));
          } else {
            cbResolve(msg.result);
          }
        }
      } catch (err) {
        // ignore parse error
      }
    };

    ws.onerror = (err) => {
      reject(new NativeBrowserError(500, `CDP WebSocket 错误: ${err.message || '连接失败'}`));
    };

    ws.onopen = async () => {
      try {
        await send('Network.enable');
        if (Array.isArray(cookies) && cookies.length > 0) {
          await send('Network.setCookies', { cookies });
        }
        await send('Page.navigate', { url: targetUrl });
        ws.close();
        resolve({ ok: true });
      } catch (err) {
        try {
          ws.close();
        } catch {}
        reject(err);
      }
    };
  });
}

const activeBrowsers = new Map();

/**
 * Check if a Chrome browser instance is currently running for the given profileKey.
 */
export function isBrowserRunning(profileKey) {
  const safeKey = String(profileKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const instance = activeBrowsers.get(safeKey);
  if (!instance) return false;
  try {
    process.kill(instance.pid, 0);
    return true;
  } catch {
    activeBrowsers.delete(safeKey);
    return false;
  }
}

/**
 * Return the active browser entry for profileKey if the process is still alive.
 */
export function getActiveBrowser(profileKey) {
  if (!isBrowserRunning(profileKey)) return null;
  const safeKey = String(profileKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return activeBrowsers.get(safeKey) || null;
}

/**
 * Resolve the page-level CDP WebSocket URL for the active tab on a debugging port.
 */
export async function getPageTargetWsUrl(port) {
  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!listRes.ok) {
    throw new NativeBrowserError(500, '无法读取 Chrome 页面调试目标');
  }
  const targets = await listRes.json();
  const pageTarget = Array.isArray(targets)
    ? targets.find((t) => t?.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
    : null;
  if (pageTarget) return pageTarget.webSocketDebuggerUrl;

  const newRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(3000)
  });
  if (newRes.ok) {
    const created = await newRes.json();
    if (created?.webSocketDebuggerUrl) return created.webSocketDebuggerUrl;
  }
  throw new NativeBrowserError(500, '未找到可用的 Chrome 页面调试目标');
}

/**
 * Terminate a running Chrome instance and immediately tear down its proxy tunnel.
 */
export function closeNativeBrowser(profileKey) {
  const safeKey = String(profileKey || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const instance = activeBrowsers.get(safeKey);
  if (!instance) return false;
  try {
    if (instance.proxyCleanup) {
      try {
        instance.proxyCleanup();
      } catch {}
    }
    process.kill(instance.pid, 'SIGTERM');
  } catch {}
  activeBrowsers.delete(safeKey);
  return true;
}

/**
 * Return list of all currently active profileKeys.
 */
export function getRunningProfileKeys() {
  const active = [];
  for (const [key, instance] of activeBrowsers.entries()) {
    try {
      process.kill(instance.pid, 0);
      active.push(key);
    } catch {
      activeBrowsers.delete(key);
    }
  }
  return active;
}

/**
 * Launch an isolated native Chrome instance with independent profile and optional proxy.
 */
export async function launchNativeChrome({
  profileKey,
  proxyUrl = '',
  token = '',
  deviceId = '',
  customArgs = [],
  headless = process.env.NATIVE_BROWSER_HEADLESS === '1' || (process.platform === 'linux' && !process.env.DISPLAY),
  windowSize = '1520,960',
  ownerId = '',
  exitInfo = null,
  targetUrl = 'https://chatgpt.com/'
} = {}) {
  const executable = findChromeExecutable();
  if (!executable) {
    throw new NativeBrowserError(500, '系统未找到可用的 Google Chrome 或 Chromium 浏览器，请先安装 Chrome');
  }

  const baseProfilesDir =
    process.env.NATIVE_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.id_business_profiles');
  const safeKey = String(profileKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

  // If a previous instance is already running for this profile, close it first
  if (isBrowserRunning(safeKey)) {
    closeNativeBrowser(safeKey);
  }

  const profileDir = path.join(baseProfilesDir, safeKey);
  fs.mkdirSync(profileDir, { recursive: true });

  const port = await getFreePort();
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    `--window-size=${windowSize}`,
    ...(headless ? ['--headless=new', '--disable-gpu', '--no-sandbox'] : []),
    ...customArgs
  ];

  let proxyCleanup = null;
  if (proxyUrl) {
    const parsedProxy = parseProxyServerConfig(proxyUrl);
    if (parsedProxy) {
      if (parsedProxy.username && parsedProxy.password) {
        const resolvedUsername = resolveDynamicProxySession(parsedProxy.username);
        const tunnel = await createLocalProxyTunnel({
          upstreamHost: parsedProxy.host,
          upstreamPort: parsedProxy.port,
          username: resolvedUsername,
          password: parsedProxy.password
        });
        args.push(`--proxy-server=${tunnel.url}`);
        proxyCleanup = () => tunnel.close();
      } else {
        const scheme = parsedProxy.protocol.startsWith('socks') ? parsedProxy.protocol : 'http:';
        args.push(`--proxy-server=${scheme}//${parsedProxy.host}:${parsedProxy.port}`);
      }
    } else {
      args.push(`--proxy-server=${proxyUrl}`);
    }
  }

  // Open initial blank page so we can inject cookies before opening chatgpt.com
  args.push('about:blank');

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore'
  });

  const browserEntry = {
    pid: child.pid,
    child,
    port,
    profileDir,
    proxyCleanup,
    ownerId,
    exitInfo,
    startedAt: new Date().toISOString()
  };
  activeBrowsers.set(safeKey, browserEntry);

  child.on('exit', () => {
    if (proxyCleanup) {
      try {
        proxyCleanup();
      } catch {}
    }
    activeBrowsers.delete(safeKey);
  });
  child.unref();

  const debugInfo = await waitForDebuggerReady(port);
  const wsUrl = debugInfo.webSocketDebuggerUrl;

  // Build the complete cookie set:
  const cookiesToSet = [];
  if (token) {
    const chunks = token.match(/.{1,3936}/g) || [token];
    for (let i = 0; i < chunks.length; i++) {
      cookiesToSet.push({
        name: '__Secure-next-auth.session-token' + (chunks.length > 1 ? `.${i}` : ''),
        value: chunks[i],
        domain: '.chatgpt.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      });
    }
  }

  if (deviceId) {
    cookiesToSet.push({
      name: 'oai-did',
      value: deviceId,
      domain: '.chatgpt.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    });
  }

  // Inject cookies and navigate to targetUrl
  await injectCookiesAndNavigate(wsUrl, cookiesToSet, targetUrl);

  return {
    ok: true,
    pid: child.pid,
    port,
    profileDir,
    profileKey: safeKey,
    exitInfo
  };
}
