import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex >= 0 ? process.argv[separatorIndex + 1] : undefined;
const args = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 2) : [];

if (!command) {
  throw new Error('用法: node scripts/run-with-cloudflare-free-secrets.mjs -- <command> [...args]');
}

const secretsPath = path.resolve('.deploy/cloudflare-free.secrets.json');
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const requiredKeys = ['DATABASE_URL', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'HASH_SECRET'];

for (const key of requiredKeys) {
  if (typeof secrets[key] !== 'string' || !secrets[key]) {
    throw new Error(`部署凭据缺少 ${key}`);
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
