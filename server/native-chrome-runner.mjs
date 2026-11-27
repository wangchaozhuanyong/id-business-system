import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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
      '/state/chromium/chrome-wrapper',
      '/state/chromium/chrome',
      '/state/chromium/chromium',
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

const browserDebuggerPathPattern = /^\/devtools\/browser\/[a-f0-9-]{36}$/;
const pageDebuggerPathPattern = /^\/devtools\/page\/[a-f0-9-]{16,64}$/i;

function readDebuggerMarker(profileDir) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!opened.isFile() || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) {
      throw new NativeBrowserError(500, 'Chrome 调试标记文件无效');
    }
    const buffer = Buffer.alloc(129);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes === buffer.length) throw new NativeBrowserError(500, 'Chrome 调试标记文件无效');
    return buffer.toString('utf8', 0, bytes);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new NativeBrowserError(500, 'Chrome 调试标记文件无效');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function loopbackDebuggerUrl(value, port) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  return url?.protocol === 'ws:' && url.hostname === '127.0.0.1' &&
    Number(url.port) === port && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

async function requireBrowserDebugger(port, browserDebuggerPath) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !browserDebuggerPathPattern.test(browserDebuggerPath)) {
    throw new NativeBrowserError(500, 'Chrome 调试身份无效');
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    redirect: 'error',
    signal: AbortSignal.timeout(1000)
  });
  const version = response.ok ? await response.json() : null;
  if (loopbackDebuggerUrl(version?.webSocketDebuggerUrl, port)?.pathname !== browserDebuggerPath) {
    throw new NativeBrowserError(500, 'Chrome 调试身份无法核对');
  }
}

export async function waitForProfileDebugger(profileDir, previousMarker, isRunning, timeoutMs = 12000) {
  const previousPath = previousMarker.split(/\r?\n/)[1];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) throw new NativeBrowserError(409, '浏览器已关闭，请重新打开');
    const marker = readDebuggerMarker(profileDir);
    const match = /^([0-9]{1,5})\r?\n(\/devtools\/browser\/[a-f0-9-]{36})(?:\r?\n)?$/.exec(marker);
    if (match && match[2] !== previousPath) {
      const port = Number(match[1]);
      const browserDebuggerPath = match[2];
      let verified = false;
      try {
        await requireBrowserDebugger(port, browserDebuggerPath);
        verified = true;
      } catch {
        // A fresh file can appear before Chrome starts answering requests.
      }
      if (verified && isRunning() && readDebuggerMarker(profileDir) === marker) return { port, browserDebuggerPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new NativeBrowserError(500, 'Chrome 远程调试接口启动超时，请重试');
}

/**
 * Connect to Chrome DevTools Protocol via WebSocket and inject cookies.
 */
export async function injectCookiesAndNavigate(wsUrl, cookies, targetUrl = 'https://chatgpt.com/', timeoutMs = 10000) {
  const ws = new globalThis.WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    let nextId = 1;
    let settled = false;
    const callbacks = new Map();
    const timer = setTimeout(() => finish(new NativeBrowserError(500, 'Chrome 调试操作超时，请重试')), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) for (const callback of callbacks.values()) callback.reject(error);
      callbacks.clear();
      try {
        ws.close();
      } catch {}
      if (error) reject(error);
      else resolve({ ok: true });
    };

    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((res, rej) => {
        if (settled || ws.readyState !== globalThis.WebSocket.OPEN) {
          rej(new NativeBrowserError(500, 'Chrome 调试连接已关闭'));
          return;
        }
        callbacks.set(id, { resolve: res, reject: rej });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          callbacks.delete(id);
          rej(error);
        }
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

    ws.onerror = () => finish(new NativeBrowserError(500, 'Chrome 调试连接失败'));
    ws.onclose = () => finish(new NativeBrowserError(500, 'Chrome 调试连接已关闭'));

    ws.onopen = async () => {
      try {
        await send('Network.enable');
        if (Array.isArray(cookies) && cookies.length > 0) {
          const sessionCookies = cookies.filter((c) => /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(c.name));
          const otherCookies = cookies.filter((c) => !/^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(c.name));

          let shouldSetSession = sessionCookies.length > 0;
          if (shouldSetSession) {
            const existingRes = await send('Network.getCookies', {
              urls: ['https://chatgpt.com/', 'https://chatgpt.com/api/auth/session']
            });
            const existing = Array.isArray(existingRes?.cookies) ? existingRes.cookies : [];
            const currentSession = existing.filter(
              (c) =>
                c &&
                typeof c.name === 'string' &&
                /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(c.name) &&
                typeof c.domain === 'string' &&
                c.domain.replace(/^\./, '') === 'chatgpt.com' &&
                c.path === '/'
            );
            const expectedJoined = sessionCookies.map((c) => c.value).join('');
            const currentPlain = currentSession.filter((c) => c.name === '__Secure-next-auth.session-token');
            const currentChunks = currentSession
              .filter((c) => c.name !== '__Secure-next-auth.session-token')
              .sort((a, b) => Number(a.name.split('.').at(-1)) - Number(b.name.split('.').at(-1)));

            const unchanged =
              (currentPlain.length === 1 && !currentChunks.length && currentPlain[0].value === expectedJoined) ||
              (!currentPlain.length &&
                currentChunks.length > 0 &&
                currentChunks.every((c, idx) => c.name === `__Secure-next-auth.session-token.${idx}`) &&
                currentChunks.map((c) => c.value).join('') === expectedJoined);

            if (unchanged) {
              shouldSetSession = false;
            } else {
              for (const old of currentSession) {
                await send('Network.deleteCookies', {
                  name: old.name,
                  domain: old.domain,
                  path: old.path
                });
              }
            }
          }

          const toWrite = [...(shouldSetSession ? sessionCookies : []), ...otherCookies];
          if (toWrite.length > 0) {
            await send('Network.setCookies', { cookies: toWrite });
          }
        }
        await send('Page.navigate', { url: targetUrl });
        finish();
      } catch (err) {
        finish(err);
      }
    };
  });
}

const activeBrowsers = new Map();
const launchingProfiles = new Set();
const ownedProfilePattern = /^(chatgpt|proto)_[a-f0-9]{64}$/;

function hasOwner(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function operatorBrowserProfileKey(kind, ownerId, scopeId) {
  if (!['chatgpt', 'proto'].includes(kind) || !hasOwner(ownerId) || !hasOwner(scopeId)) {
    throw new NativeBrowserError(400, '缺少有效的浏览器归属或范围');
  }
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([kind, ownerId, scopeId]))
    .digest('hex');
  return kind + '_' + hash;
}

function ownedBrowserEntry(profileKey, ownerId) {
  if (typeof profileKey !== 'string' || !ownedProfilePattern.test(profileKey) || !hasOwner(ownerId)) {
    return null;
  }
  const instance = activeBrowsers.get(profileKey);
  if (!instance || instance.ownerId !== ownerId) return null;
  return instance.child.pid && instance.child.exitCode === null && instance.child.signalCode === null
    ? instance
    : null;
}

export function isBrowserRunning(profileKey, ownerId) {
  return getActiveBrowser(profileKey, ownerId) !== null;
}

export function getActiveBrowser(profileKey, ownerId) {
  const instance = ownedBrowserEntry(profileKey, ownerId);
  return instance && !instance.closing && !launchingProfiles.has(profileKey) ? instance : null;
}

/**
 * Resolve the page-level CDP WebSocket URL for the active tab on a debugging port.
 */
export async function getPageTargetWsUrl(port, browserDebuggerPath) {
  await requireBrowserDebugger(port, browserDebuggerPath);
  const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000)
  });
  if (!listRes.ok) {
    throw new NativeBrowserError(500, '无法读取 Chrome 页面调试目标');
  }
  const targets = await listRes.json();
  for (const target of Array.isArray(targets) ? targets : []) {
    if (target?.type !== 'page') continue;
    const url = loopbackDebuggerUrl(target.webSocketDebuggerUrl, port);
    if (url && pageDebuggerPathPattern.test(url.pathname)) {
      await requireBrowserDebugger(port, browserDebuggerPath);
      return url.href;
    }
  }
  throw new NativeBrowserError(500, '未找到可用的 Chrome 页面调试目标');
}

/**
 * Terminate a running Chrome instance and immediately tear down its proxy tunnel.
 */
function closeBrowserProxy(instance) {
  const cleanup = instance.proxyCleanup;
  instance.proxyCleanup = null;
  try {
    cleanup?.();
  } catch {}
}

export function closeNativeBrowser(profileKey, ownerId, expectedPid) {
  const instance = ownedBrowserEntry(profileKey, ownerId);
  if (!instance || instance.closing || (expectedPid !== undefined && instance.pid !== expectedPid)) return false;
  instance.closing = true;
  try {
    if (!instance.child.kill('SIGTERM')) {
      instance.closing = false;
      return false;
    }
  } catch {
    instance.closing = false;
    return false;
  }
  closeBrowserProxy(instance);
  return true;
}

export function getRunningProfileKeys(ownerId) {
  return [...activeBrowsers.keys()].filter((key) => isBrowserRunning(key, ownerId));
}

/**
 * Resolve a writable base directory for isolated browser profiles.
 */
export function resolveBaseProfilesDir() {
  if (process.env.NATIVE_BROWSER_PROFILE_DIR) {
    return process.env.NATIVE_BROWSER_PROFILE_DIR;
  }
  const roots = process.platform === 'linux'
    ? [os.homedir(), '/state', os.tmpdir()]
    : [os.homedir(), os.tmpdir()];
  for (const root of roots) {
    if (!root) continue;
    try {
      fs.accessSync(root, fs.constants.W_OK);
      return path.join(root, '.id_business_profiles');
    } catch {
      // Try next writable root
    }
  }
  return path.join(os.tmpdir(), '.id_business_profiles');
}

/**
 * Launch an isolated native Chrome instance with independent profile and optional proxy.
 */
export async function launchNativeChrome(options = {}) {
  const { profileKey, ownerId, scopeId } = options;
  const kind = typeof profileKey === 'string' ? ownedProfilePattern.exec(profileKey)?.[1] : undefined;
  if (profileKey !== operatorBrowserProfileKey(kind, ownerId, scopeId)) {
    throw new NativeBrowserError(403, '无权使用该浏览器配置');
  }
  if (activeBrowsers.has(profileKey) && activeBrowsers.get(profileKey).ownerId !== ownerId) {
    throw new NativeBrowserError(403, '无权使用该浏览器配置');
  }
  if (launchingProfiles.has(profileKey)) {
    throw new NativeBrowserError(409, '该浏览器正在打开，请稍后重试');
  }
  launchingProfiles.add(profileKey);
  try {
    return await launchOwnedBrowser(options);
  } finally {
    launchingProfiles.delete(profileKey);
  }
}

async function launchOwnedBrowser({
  profileKey,
  proxyUrl = '',
  token = '',
  deviceId = '',
  customArgs = [],
  headless = process.env.NATIVE_BROWSER_HEADLESS === '1' || (process.platform === 'linux' && !process.env.DISPLAY),
  windowSize = '1520,960',
  ownerId,
  exitInfo = null,
  targetUrl = 'https://chatgpt.com/',
  skipSessionRotation = false
}) {
  const executable = findChromeExecutable();
  if (!executable) {
    throw new NativeBrowserError(500, '系统未找到可用的 Google Chrome 或 Chromium 浏览器，请先安装 Chrome');
  }

  const baseProfilesDir = resolveBaseProfilesDir();

  // A profile may only be opened once, including while its prior Chrome exits.
  const previous = ownedBrowserEntry(profileKey, ownerId);
  if (previous) {
    if (!previous.closing && !closeNativeBrowser(profileKey, ownerId, previous.pid)) {
      throw new NativeBrowserError(409, '前一个浏览器仍在运行，请关闭后重试');
    }
    try {
      await once(previous.child, 'exit', { signal: AbortSignal.timeout(5000) });
    } catch {
      throw new NativeBrowserError(409, '前一个浏览器仍在关闭，请稍后重试');
    }
  }

  const operatorDir = path.join(baseProfilesDir, 'operator-v1');
  fs.mkdirSync(operatorDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(operatorDir).isDirectory()) {
    throw new NativeBrowserError(500, 'Chrome 用户配置目录无效');
  }
  const profileDir = path.join(operatorDir, profileKey);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(profileDir).isDirectory()) {
    throw new NativeBrowserError(500, 'Chrome 用户配置目录无效');
  }
  const previousDebuggerMarker = readDebuggerMarker(profileDir);

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    `--window-size=${windowSize}`,
    ...(headless ? ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...customArgs,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`
  ];

  let proxyCleanup = null;
  if (proxyUrl) {
    const parsedProxy = parseProxyServerConfig(proxyUrl);
    if (parsedProxy) {
      if (parsedProxy.username && parsedProxy.password) {
        const resolvedUsername = skipSessionRotation
          ? parsedProxy.username
          : resolveDynamicProxySession(parsedProxy.username);
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

  const spawnEnv = process.platform === 'linux'
    ? {
        ...process.env,
        HOME: profileDir,
        XDG_CONFIG_HOME: path.join(profileDir, '.config'),
        XDG_CACHE_HOME: path.join(profileDir, '.cache')
      }
    : process.env;

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: spawnEnv
  });

  const browserEntry = {
    pid: child.pid,
    child,
    profileDir,
    proxyCleanup,
    ownerId,
    exitInfo,
    startedAt: new Date().toISOString()
  };
  activeBrowsers.set(profileKey, browserEntry);

  const forgetBrowser = () => {
    closeBrowserProxy(browserEntry);
    if (activeBrowsers.get(profileKey) === browserEntry) activeBrowsers.delete(profileKey);
  };
  child.once('exit', forgetBrowser);
  child.once('error', forgetBrowser);
  child.unref();

  // Build the complete cookie set (host-only url matching direct-login.mjs):
  const cookiesToSet = [];
  if (token) {
    const chunks = token.match(/.{1,3936}/g) || [token];
    for (let i = 0; i < chunks.length; i++) {
      cookiesToSet.push({
        name: '__Secure-next-auth.session-token' + (chunks.length > 1 ? `.${i}` : ''),
        value: chunks[i],
        url: 'https://chatgpt.com/',
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
      url: 'https://chatgpt.com/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax'
    });
  }

  // Inject cookies and navigate to targetUrl
  try {
    const isCurrent = () => ownedBrowserEntry(profileKey, ownerId) === browserEntry && !browserEntry.closing;
    const { port, browserDebuggerPath } = await waitForProfileDebugger(profileDir, previousDebuggerMarker, isCurrent);
    const wsUrl = await getPageTargetWsUrl(port, browserDebuggerPath);
    if (!isCurrent()) throw new NativeBrowserError(409, '浏览器已关闭，请重新打开');
    await injectCookiesAndNavigate(wsUrl, cookiesToSet, targetUrl);
    if (!isCurrent()) throw new NativeBrowserError(409, '浏览器已关闭，请重新打开');
    Object.assign(browserEntry, { port, browserDebuggerPath });
  } catch (error) {
    closeNativeBrowser(profileKey, ownerId, child.pid);
    throw error;
  }

  return {
    ok: true,
    pid: child.pid,
    port: browserEntry.port,
    profileDir,
    profileKey,
    exitInfo
  };
}
