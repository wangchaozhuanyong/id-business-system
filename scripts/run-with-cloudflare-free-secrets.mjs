import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  RELEASE_REQUIRED_ENV_KEYS,
  RELEASE_REQUIRED_ENV_KEY_GROUPS
} from './lib/cloudflare-release.mjs';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : undefined;
const args = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : [];

if (!command) {
  throw new Error('用法: node scripts/run-with-cloudflare-free-secrets.mjs -- <command> [...args]');
}

const secretsPath = path.resolve('.deploy/cloudflare-free.secrets.json');
const secretsStat = await stat(secretsPath);
if ((secretsStat.mode & 0o077) !== 0) {
  throw new Error('部署凭据权限必须为 0600，不能允许组用户或其他用户读取');
}
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));

for (const key of RELEASE_REQUIRED_ENV_KEYS) {
  if (typeof secrets[key] !== 'string' || !secrets[key]) {
    throw new Error(`部署凭据缺少 ${key}`);
  }
}
for (const keys of RELEASE_REQUIRED_ENV_KEY_GROUPS) {
  if (!keys.some((key) => typeof secrets[key] === 'string' && secrets[key])) {
    throw new Error(`部署凭据缺少 ${keys.join(' 或 ')}`);
  }
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...secrets
  },
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
