import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildProductionCommandEnvironment,
  resolveProductionCommand
} from './lib/production-command-profiles.mjs';

if (process.argv.length < 3) {
  throw new Error(
    '用法: node scripts/run-with-cloudflare-free-secrets.mjs <closure-audit|release-check|smoke-user-provision|data-maintenance|deploy> [args...]'
  );
}

const profile = resolveProductionCommand(process.argv[2]);
const extraArgs = process.argv.slice(3);
if (extraArgs.length > 0 && !profile.allowExtraArgs) {
  throw new Error(`生产操作 ${process.argv[2]} 不允许附加参数`);
}
const secretsPath = path.resolve('.deploy/cloudflare-free.secrets.json');
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const environment = buildProductionCommandEnvironment(process.env, secrets, profile);

const child = spawn(profile.command, [...profile.args, ...extraArgs], {
  cwd: process.cwd(),
  env: environment,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`无法启动生产操作 ${process.argv[2]}:`, error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`生产操作 ${process.argv[2]} 被信号 ${signal} 终止`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
