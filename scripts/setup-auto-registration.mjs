import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, '.runtime/auto-registration');
const requirements = resolve(
  root,
  'apps/api/src/id-business-v2/auto-registration/worker/requirements.lock.txt'
);
const venvPython = resolve(runtime, 'venv/bin/python');
const explicit = process.argv.find((arg) => arg.startsWith('--python='))?.slice(9);
const candidates = [
  explicit,
  'python3.12',
  'python3.11',
  resolve(homedir(), '.local/bin/python3.11'),
  'python3'
].filter(Boolean);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('自动注册运行环境配置失败');
};

mkdirSync(runtime, { recursive: true, mode: 0o700 });
if (!existsSync(venvPython)) {
  const python = candidates.find(
    (candidate) =>
      spawnSync(candidate, ['-c', 'import sys; raise SystemExit(sys.version_info < (3, 10))'], {
        stdio: 'ignore'
      }).status === 0
  );
  if (!python) throw new Error('需要 Python 3.10 或更新版本，可通过 --python=/绝对路径 指定');
  run(python, ['-m', 'venv', resolve(runtime, 'venv')]);
}
const fingerprint = createHash('sha256').update(readFileSync(requirements)).digest('hex');
const stamp = resolve(runtime, 'dependencies.sha256');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== fingerprint) {
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements]);
  run(venvPython, ['-m', 'pip', 'check']);
  writeFileSync(stamp, `${fingerprint}\n`);
}
console.log('自动注册本地运行环境已就绪；启动系统 API 后会自动启动独立注册服务。');
