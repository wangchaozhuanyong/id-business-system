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

async function readBinding(file, selection = false) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      value?.version !== 1 ||
      (selection
        ? !/^Exit-[a-f0-9]{32}$/.test(value.profile || '')
        : !/^[a-f0-9]{64}$/.test(value.exitHash || ''))
    )
      throw new Error('invalid binding');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw fault('PROFILE_BINDING_INVALID', '浏览器出口绑定记录无效');
    return null;
  }
}

async function writeBinding(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function prepareFreshProfile(directory, profile) {
  const target = path.join(directory, profile);
  await fs.mkdir(target, { mode: 0o700 });
  await fs.writeFile(
    path.join(target, 'Preferences'),
    JSON.stringify({
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
      autofill: { profile_enabled: false, credit_card_enabled: false }
    }),
    { mode: 0o600, flag: 'wx' }
  );
  return target;
}

async function probeExit(context, signal, attempts) {
  while (attempts.used < 5) {
    signal?.throwIfAborted();
    const attempt = ++attempts.used;
    console.log(`正在检查代理连通性...（第 ${attempt}/5 次）`);
    let response;
    try {
      response = await context.request.get('http://api.ipify.org/?format=text', { timeout: 15000 });
      if (!response.ok()) throw new Error('probe rejected');
      const ip = (await response.text()).trim();
      if (!net.isIP(ip)) throw new Error('invalid probe');
      signal?.throwIfAborted();
      console.log(`代理连接成功! 代理公网 IP 已核验（第 ${attempt}/5 次）`);
      return digest(ip.toLowerCase());
    } catch (error) {
      if (signal?.aborted || String(error.code || '').startsWith('PROFILE_')) throw error;
      console.warn(`[代理检查] 第 ${attempt}/5 次请求未完成`);
      if (attempt === 5)
        throw fault('PROXY_CONNECTION_FAILED', '代理连通性检测已用尽 5 次，仍未完成核验，已停止');
    } finally {
      await response?.dispose().catch(() => {});
    }
  }
  throw fault('PROXY_CONNECTION_FAILED', '代理连通性检测已用尽 5 次，仍未完成核验，已停止');
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
  const closeOwnedBrowser = async () => {
    if (!context) return;
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
      context = undefined;
      browserPid = undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    if (closed) return;
    await closeOwnedBrowser();
    active.delete(directory);
    closed = true;
  };
  const selectionFile = path.join(directory, '.active-profile.json');
  const launch = async (profile) => {
    options.signal?.throwIfAborted();
    context = await chromium.launchPersistentContext(directory, {
      // Use full Chromium in headed and headless runs; headless-shell does not provide
      // the same cross-process profile exclusivity in the isolated regression.
      channel: options.channel || 'chromium',
      ...options.launchOptions,
      args: [
        ...(options.launchOptions?.args || []).filter(
          (arg) => !arg.startsWith('--profile-directory=')
        ),
        `--profile-directory=${profile}`
      ]
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
    // The native user-data-dir lock is stable across profile generations. A worker
    // that read an old selection before another worker restarted must not use it.
    const selected = (await readBinding(selectionFile, true))?.profile || 'Default';
    if (selected !== profile) throw fault('PROFILE_BUSY', '浏览器会话分区已更新，请稍后重试');
  };
  try {
    const selection = await readBinding(selectionFile, true);
    const profile = selection?.profile || 'Default';
    const receipt = path.join(
      profile === 'Default' ? directory : path.join(directory, profile),
      '.exit-binding.json'
    );
    let previous = await readBinding(receipt);
    if (selection && !previous) throw fault('PROFILE_BINDING_INVALID', '浏览器出口绑定记录缺失');
    const attempts = { used: 0 };
    await launch(profile);
    // Receipt reads before the native lock can be stale when another worker has
    // just finished. Re-read after ownership is established, before any probe.
    previous = await readBinding(receipt);
    if (selection && !previous) throw fault('PROFILE_BINDING_INVALID', '浏览器出口绑定记录缺失');
    const exitHash = await probeExit(context, options.signal, attempts);
    if (previous && previous.exitHash !== exitHash) {
      if (attempts.used === 5)
        throw fault('PROXY_CONNECTION_FAILED', '代理连通性检测已用尽 5 次，无法核验新会话，已停止');
      const next = `Exit-${crypto.randomBytes(16).toString('hex')}`;
      const fresh = await prepareFreshProfile(directory, next);
      await writeBinding(path.join(fresh, '.exit-binding.json'), { version: 1, exitHash });
      options.signal?.throwIfAborted();
      // Publish while still holding Chromium's native lock. Preserve every old
      // profile; never copy cookies/storage/clearance into the new partition.
      await writeBinding(selectionFile, { version: 1, profile: next });
      console.log('[浏览器会话] 代理出口变化，启用独立资料分区并重新核验登录');
      await closeOwnedBrowser();
      await launch(next);
      // The fresh partition has no inherited cookies/storage/clearance. A proxy
      // observation is not an authentication verdict and need not match the
      // previous browser's exit. Keep only this partition's latest observation;
      // the caller must still verify the real Session and target account.
      const observedExit = await probeExit(context, options.signal, attempts);
      await writeBinding(path.join(fresh, '.exit-binding.json'), {
        version: 1,
        exitHash: observedExit
      });
      console.log('[浏览器会话] 新分区代理连通性已核验，继续官网真实登录核验');
    } else if (!previous) {
      await writeBinding(receipt, { version: 1, exitHash });
    }
    options.signal?.throwIfAborted();
    return { context, close, profileKey: key };
  } catch (error) {
    await close();
    if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(String(error.message)))
      throw fault('PROFILE_BUSY', '同一账号与代理的浏览器正在使用，请稍后重试');
    // Launch errors can contain paths/arguments/proxy credentials. Do not propagate them.
    if (
      String(error.code || '').startsWith('PROFILE_') ||
      error.code === 'PROXY_CONNECTION_FAILED' ||
      options.signal?.aborted
    )
      throw error;
    throw fault('PROFILE_LAUNCH_FAILED', '专用浏览器启动未完成，请检查浏览器安装与运行环境');
  }
}

module.exports = { binding, launchProfile };
