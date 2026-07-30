#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { getSoleActiveVersionId } from './lib/cloudflare-deployment.mjs';

await run('node', ['scripts/validate-cloudflare-free-release.mjs']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const shortCommit = commit.slice(0, 12);
const wranglerCommand = 'wrangler@4.114.0';
const wranglerConfig = 'wrangler.cloudflare-free.jsonc';

await run('npm', ['run', 'build:cloudflare-free']);
const previousDeployment = parseJson(
  await capture('npx', [
    wranglerCommand,
    'deployments',
    'status',
    '--config',
    wranglerConfig,
    '--json'
  ]),
  'Cloudflare 当前部署状态'
);
const rollbackVersionId = getSoleActiveVersionId(previousDeployment);

try {
  await run('npx', [
    wranglerCommand,
    'deploy',
    '--config',
    wranglerConfig,
    '--strict',
    '--message',
    `git:${commit} branch:main`,
    '--tag',
    `git-${shortCommit}`
  ]);
  await run('node', ['scripts/verify-cloudflare-free-deployment.mjs', config.vars.APP_PUBLIC_URL]);
} catch (releaseError) {
  try {
    await run('npx', [
      wranglerCommand,
      'rollback',
      rollbackVersionId,
      '--config',
      wranglerConfig,
      '--message',
      `Automatic rollback after failed smoke for git:${commit}`
    ]);
    await run('node', [
      'scripts/verify-cloudflare-free-deployment.mjs',
      config.vars.APP_PUBLIC_URL
    ]);
  } catch (rollbackError) {
    throw new AggregateError(
      [releaseError, rollbackError],
      `发布失败且自动回滚到 ${rollbackVersionId} 后仍未通过验收`,
      { cause: rollbackError }
    );
  }
  throw new Error(`发布后验收失败，已自动回滚到 ${rollbackVersionId}`, {
    cause: releaseError
  });
}

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

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
}
