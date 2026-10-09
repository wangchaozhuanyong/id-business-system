'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
let ownedTransient = null;
function transientRoot() {
  if (!ownedTransient) {
    ownedTransient = fs.mkdtempSync(path.join(os.tmpdir(), 'id-online-recharge-'));
    fs.chmodSync(ownedTransient, 0o700);
  }
  return ownedTransient;
}
function clearTransientRoot() {
  if (!ownedTransient) return;
  const target = ownedTransient;
  ownedTransient = null;
  fs.rmSync(target, { recursive: true, force: true });
}
function projectRoots() {
  const workspace = path.resolve(__dirname, '../../../../../..');
  const roots = [__dirname];
  if (
    fs.existsSync(path.join(workspace, 'package.json')) &&
    fs.existsSync(path.join(workspace, 'apps', 'api', 'src', 'id-business-v2'))
  )
    roots.push(workspace);
  for (const marker of ['/.codex-worktrees/', '/.worktrees/']) {
    const at = workspace.indexOf(marker);
    if (at >= 0) {
      const original = workspace.slice(0, at);
      if (
        fs.existsSync(path.join(original, 'package.json')) &&
        fs.existsSync(path.join(original, 'apps', 'api', 'src', 'id-business-v2'))
      )
        roots.push(original);
    }
  }
  return roots;
}
function resolveProjectPath(input, fallback) {
  if (input && !path.isAbsolute(input)) throw new Error('执行器输出目录必须为项目内绝对路径');
  const target = path.resolve(input || fallback);
  const inside = (v) =>
    projectRoots().some((root) => v === root || v.startsWith(`${root}${path.sep}`));
  if (!inside(target)) throw new Error('执行器输出目录必须属于当前 ID 项目');
  let existing = target;
  const tail = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  if (!inside(path.join(fs.realpathSync(existing), ...tail)))
    throw new Error('执行器输出目录不能通过链接指向项目外');
  return target;
}
function runtimeRoot() {
  return resolveProjectPath(
    process.env.ONLINE_RECHARGE_RUNTIME_DIR,
    path.join(__dirname, 'runtime')
  );
}
function mediaRoot() {
  return resolveProjectPath(
    process.env.ONLINE_RECHARGE_MEDIA_DIR,
    path.join(runtimeRoot(), 'media')
  );
}
module.exports = {
  projectRoots,
  resolveProjectPath,
  runtimeRoot,
  mediaRoot,
  transientRoot,
  clearTransientRoot
};
