import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// This component runs inside an operator's isolated graphical desktop. Its caller
// supplies the authenticated operator ID and a record already owned by that operator.
export function createManualDesktopWorkspaces({ profileRoot, executable, firstPage = 'https://chatgpt.com/' }) {
  if (!profileRoot || !isAbsolute(profileRoot) || !executable || !isAbsolute(executable))
    throw new Error('请指定独立桌面的持久目录和本机 Chrome 的绝对路径');
  const home = new URL(firstPage);
  if (home.username || home.password || home.search || home.hash ||
      !(home.protocol === 'https:' || (home.protocol === 'http:' && home.hostname === '127.0.0.1')))
    throw new Error('浏览器主页地址无效');
  const opening = new Map();
  const children = new Map();

  function keyOf({ operatorId, accountId }) {
    if (![operatorId, accountId].every(id => typeof id === 'string' && id.trim() && id.length <= 256))
      throw new Error('缺少操作员或账号标识');
    return 'manual-v1-' + createHash('sha256').update(JSON.stringify([operatorId, accountId])).digest('hex');
  }

  async function privateDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077))))
      throw new Error('工作区必须使用当前桌面用户的专用私有目录');
  }

  async function start(key) {
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      throw new Error('当前环境缺少独立图形桌面');
    await access(executable, constants.X_OK);
    await privateDirectory(profileRoot);
    const directory = join(await realpath(profileRoot), key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privateDirectory(directory);
    // "Local State" is Chrome's installation marker. Only its existence matters.
    // The browser owns all page/session data and performs its own process locking.
    const established = await lstat(join(directory, 'Local State')).then(() => true, e => {
      if (e.code === 'ENOENT') return false;
      throw e;
    });
    const args = ['--user-data-dir=' + directory, '--no-first-run', '--no-default-browser-check',
      '--restore-last-session', '--focus=' + home.origin + '/*'];
    if (!established && !children.has(key)) args.push(home.href);
    const current = children.get(key);
    const reusing = Boolean(current && !current.closing);
    if (current?.closing) await current.closing;
    const env = {};
    for (const name of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH',
      'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(executable, args, { stdio: 'ignore', detached: true, env });
    const closed = new Promise(resolve => {
      child.once('close', (code, signal) => {
        if (children.get(key)?.child === child) children.delete(key);
        resolve({ code, signal });
      });
    });
    await once(child, 'spawn');
    child.unref();
    if (!reusing) children.set(key, { child, closed });
    const earlyExit = await Promise.race([closed, delay(400, null)]);
    if (earlyExit && earlyExit.code !== 0) throw new Error('Chrome 未能启动，请检查桌面和持久目录');
    // A second invocation is handed to Chrome's profile singleton. It never
    // closes the original browser or navigates its working page to the homepage.
    return { state: reusing ? 'running' : 'opened' };
  }

  return {
    open(identity) {
      const key = keyOf(identity);
      if (!opening.has(key))
        opening.set(key, start(key).finally(() => opening.delete(key)));
      return opening.get(key);
    },
    async close(identity) {
      const key = keyOf(identity);
      await opening.get(key);
      const active = children.get(key);
      if (!active) return false;
      if (!active.closing) {
        active.closing = (async () => {
          if (process.platform === 'darwin') {
            // Native quit lets this particular Chrome save its open windows.
            const quit = 'ObjC.import("AppKit"); function run(args) { ' +
              'return $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0])).terminate; }';
            const { stdout } = await promisify(execFile)('/usr/bin/osascript',
              ['-l', 'JavaScript', '-e', quit, String(active.child.pid)], { timeout: 5000 });
            if (stdout.trim() !== 'true') throw new Error('请在该工作区的 Chrome 菜单中退出浏览器');
          } else active.child.kill('SIGTERM');
          const result = await Promise.race([active.closed, delay(10000, null, { ref: false })]);
          if (!result) throw new Error('浏览器仍在运行，请处理窗口中的提示后再退出');
          return true;
        })().finally(() => { active.closing = null; });
      }
      return active.closing;
    }
  };
}
