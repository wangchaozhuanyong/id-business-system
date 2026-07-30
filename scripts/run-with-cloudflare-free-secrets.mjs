import { spawn } from 'node:child_process';
import { constants as fileSystemConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  RELEASE_REQUIRED_ENV_KEYS,
  RELEASE_REQUIRED_ENV_KEY_GROUPS,
  isSmokeMfaBootstrapCommand,
  validateReleaseEnvironment
} from './lib/cloudflare-release.mjs';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : undefined;
const args = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : [];

if (!command) {
  throw new Error('用法: node scripts/run-with-cloudflare-free-secrets.mjs -- <command> [...args]');
}

const secretsPath = path.resolve('.deploy/cloudflare-free.secrets.json');
let secretsHandle;
try {
  secretsHandle = await open(
    secretsPath,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW
  );
} catch {
  throw new Error('部署凭据必须是可读取的普通文件，不能是符号链接');
}
let secretsContent;
try {
  const secretsStatBefore = await secretsHandle.stat();
  if (!secretsStatBefore.isFile() || (secretsStatBefore.mode & 0o077) !== 0) {
    throw new Error('部署凭据权限必须为 0600，且必须是普通文件');
  }
  secretsContent = await secretsHandle.readFile('utf8');
  const secretsStatAfter = await secretsHandle.stat();
  if (
    secretsStatBefore.dev !== secretsStatAfter.dev ||
    secretsStatBefore.ino !== secretsStatAfter.ino ||
    secretsStatBefore.size !== secretsStatAfter.size ||
    secretsStatBefore.mtimeMs !== secretsStatAfter.mtimeMs
  ) {
    throw new Error('部署凭据在读取期间发生变化，已停止执行');
  }
} finally {
  await secretsHandle.close();
}
const secrets = JSON.parse(secretsContent);
if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
  throw new Error('部署凭据文件必须是 JSON 对象');
}
const allowsSmokeMfaBootstrap = isSmokeMfaBootstrapCommand(command, args);

for (const key of RELEASE_REQUIRED_ENV_KEYS) {
  if (key === 'SMOKE_TEST_MFA_TOTP_SECRET' && allowsSmokeMfaBootstrap) {
    continue;
  }
  if (typeof secrets[key] !== 'string' || !secrets[key]) {
    throw new Error(`部署凭据缺少 ${key}`);
  }
}
for (const keys of RELEASE_REQUIRED_ENV_KEY_GROUPS) {
  if (!keys.some((key) => typeof secrets[key] === 'string' && secrets[key])) {
    throw new Error(`部署凭据缺少 ${keys.join(' 或 ')}`);
  }
}
const environmentErrors = validateReleaseEnvironment({
  ...secrets,
  SMOKE_TEST_MFA_TOTP_SECRET:
    allowsSmokeMfaBootstrap && !secrets.SMOKE_TEST_MFA_TOTP_SECRET
      ? 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
      : secrets.SMOKE_TEST_MFA_TOTP_SECRET
});
if (environmentErrors.length) {
  throw new Error(`部署凭据目标校验失败：${environmentErrors.join('；')}`);
}

const childEnvironment = {
  ...process.env,
  ...secrets
};
if (allowsSmokeMfaBootstrap) {
  delete childEnvironment.SMOKE_TEST_MFA_TOTP_SECRET;
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`无法启动 ${command}:`, error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`${command} 被信号 ${signal} 终止`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
