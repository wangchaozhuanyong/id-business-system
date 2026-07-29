#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

await run('node', ['scripts/validate-cloudflare-free-release.mjs']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const shortCommit = commit.slice(0, 12);

await run('npm', ['run', 'build:cloudflare-free']);
await run('npx', [
  'wrangler@4.114.0',
  'deploy',
  '--config',
  'wrangler.cloudflare-free.jsonc',
  '--strict',
  '--message',
  `git:${commit} branch:main`,
  '--tag',
  `git-${shortCommit}`
]);
await run('node', ['scripts/verify-cloudflare-free-deployment.mjs', config.vars.APP_PUBLIC_URL]);

console.log(
  JSON.stringify(
    {
      ok: true,
      commit,
      worker: config.name,
      publicUrl: config.vars.APP_PUBLIC_URL,
      smokeVerified: true
    },
    null,
    2
  )
);

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
        return;
      }
      reject(new Error(`${command} 执行失败${signal ? `，信号 ${signal}` : `，退出码 ${code}`}`));
    });
  });
}
