'use strict';

// Dedicated, account-bound browser state. Never use a user's normal Chrome directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { resolveProjectPath } = require('./paths.cjs');
const active = new Set();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code });

function binding(sessionRaw, proxy, channel = '') {
  const resolved = require('./upstream/session-auth').resolveSessionInput(sessionRaw);
  const data = resolved?.sessionData;
  if (!data?.account?.id || !data?.user?.id)
    throw fault('PROFILE_IDENTITY_MISSING', '缺少账号及用户标识，不能复用浏览器会话');
  let proxyBinding = 'direct';
  if (proxy) {
    try {
      proxyBinding = new URL(proxy).href;
    } catch {
      throw fault('PROFILE_PROXY_INVALID', '代理绑定格式无效');
    }
  }
  // The original upstream proxy is used, never the relay's random local port.
  return digest(
    JSON.stringify([data.account.id, data.user.id, proxyBinding, channel || 'chromium'])
  );
}

async function prepareDirectory(root, key) {
  const base = resolveProjectPath(root);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const directory = path.join(base, key);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw fault('PROFILE_DIRECTORY_INVALID', '浏览器状态目录无效');
    const staging = await fs.mkdtemp(path.join(base, '.prepare-'));
    try {
      await fs.mkdir(path.join(staging, 'Default'), { mode: 0o700 });
      await fs.writeFile(
        path.join(staging, 'Default', 'Preferences'),
        JSON.stringify({
          credentials_enable_service: false,
          profile: { password_manager_enabled: false },
          autofill: { profile_enabled: false, credit_card_enabled: false }
        }),
        { mode: 0o600 }
      );
      try {
        await fs.rename(staging, directory);
      } catch (renameError) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(renameError.code)) throw renameError;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  resolveProjectPath(directory);
  await fs.chmod(directory, 0o700);
  return directory;
}

async function verifyExit(context, directory, signal) {
  const receipt = path.join(directory, '.exit-binding.json');
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(receipt, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw fault('PROFILE_BINDING_INVALID', '浏览器出口绑定记录无效');
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    signal?.throwIfAborted();
    console.log(`正在检查代理连通性...（第 ${attempt}/5 次）`);
    let response;
    try {
      response = await context.request.get('http://api.ipify.org/?format=text', { timeout: 15000 });
      if (!response.ok()) throw new Error('probe rejected');
      const ip = (await response.text()).trim();
      if (!net.isIP(ip)) throw new Error('invalid probe');
      signal?.throwIfAborted();
      const exitHash = digest(ip.toLowerCase());
      if (previous && previous.exitHash !== exitHash)
        throw fault(
          'PROFILE_EXIT_CHANGED',
          '当前代理出口与浏览器会话绑定不一致，已停止；未切换代理'
        );
      if (!previous)
        await fs.writeFile(receipt, JSON.stringify({ version: 1, exitHash }), { mode: 0o600 });
      console.log(`代理连接成功! 代理公网 IP 已核验（第 ${attempt}/5 次）`);
      return;
    } catch (error) {
      if (signal?.aborted || error.code?.startsWith('PROFILE_')) throw error;
      console.warn(`[代理检查] 第 ${attempt}/5 次请求未完成`);
      if (attempt === 5)
        throw fault('PROXY_CONNECTION_FAILED', '代理连通性检查连续 5 次失败，已停止后续操作');
    } finally {
      await response?.dispose().catch(() => {});
    }
  }
}

async function launchProfile(chromium, options) {
  const key = binding(options.sessionRaw, options.proxyBinding, options.channel);
  const directory = await prepareDirectory(options.root, key);
  if (active.has(directory))
    throw fault('PROFILE_BUSY', '同一账号与代理的浏览器正在使用，请稍后重试');
  active.add(directory);
  let context,
    browserPid,
    closed = false;
  const close = async () => {
    if (closed) return;
    if (!context) {
      active.delete(directory);
      closed = true;
      return;
    }
    let timer;
    try {
      const finished = await Promise.race([
        context.close().then(
          () => true,
          () => false
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        })
      ]);
      if (!finished && context.browser()?.isConnected()) {
        // PID obtained from this owned browser's CDP session, never another task/browser.
        if (!browserPid) throw fault('PROFILE_CLEANUP_FAILED', '浏览器关闭未确认，未释放会话');
        try {
          process.kill(browserPid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        for (let i = 0; i < 20 && context.browser()?.isConnected(); i++)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (context.browser()?.isConnected())
        throw fault('PROFILE_CLEANUP_FAILED', '浏览器关闭未确认，未释放会话');
      active.delete(directory);
      closed = true;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    context = await chromium.launchPersistentContext(directory, {
      // Use full Chromium in headed and headless runs; headless-shell does not provide
      // the same cross-process profile exclusivity in the isolated regression.
      channel: options.channel || 'chromium',
      ...options.launchOptions
    });
    // Chrome's native profile lock also excludes concurrent worker processes.
    const cdp = await context.browser().newBrowserCDPSession();
    try {
      const command = await cdp.send('Browser.getBrowserCommandLine');
      if (command.arguments.includes(`--user-data-dir=${directory}`)) {
        const info = await cdp.send('SystemInfo.getProcessInfo');
        const pid = info.processInfo.find((item) => item.type === 'browser')?.id;
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) browserPid = pid;
      }
    } finally {
      await cdp.detach();
    }
    await verifyExit(context, directory, options.signal);
    return { context, close, profileKey: key };
  } catch (error) {
    await close();
    if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(String(error.message)))
      throw fault('PROFILE_BUSY', '同一账号与代理的浏览器正在使用，请稍后重试');
    // Launch errors can contain paths/arguments/proxy credentials. Do not propagate them.
    if (
      error.code?.startsWith('PROFILE_') ||
      error.code === 'PROXY_CONNECTION_FAILED' ||
      options.signal?.aborted
    )
      throw error;
    throw fault('PROFILE_LAUNCH_FAILED', '专用浏览器启动未完成，请检查浏览器安装与运行环境');
  }
}

module.exports = { binding, launchProfile };
