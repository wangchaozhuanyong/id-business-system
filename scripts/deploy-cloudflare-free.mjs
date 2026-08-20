#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  RELEASE_PUBLIC_URL,
  createCloudflareProductionBuildEnvironment
} from './lib/cloudflare-release.mjs';

await run('node', ['scripts/validate-cloudflare-free-release.mjs']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const shortCommit = commit.slice(0, 12);
const apiUpstreamBaseUrl = process.env.API_UPSTREAM_BASE_URL;

await run('bash', ['scripts/deploy-pm2-api.sh']);
await run('node', [
  'scripts/verify-cloudflare-free-deployment.mjs',
  apiUpstreamBaseUrl,
  '--api-only'
]);

await run('npm', ['run', 'build:cloudflare-free'], {
  env: createCloudflareProductionBuildEnvironment(process.env)
});
await syncCloudflareRuntimeSecrets();
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
await run('node', ['scripts/verify-cloudflare-free-deployment.mjs', RELEASE_PUBLIC_URL]);

console.log(
  JSON.stringify(
    {
      ok: true,
      commit,
      worker: config.name,
      publicUrl: RELEASE_PUBLIC_URL,
      apiBaseUrl: apiUpstreamBaseUrl,
      smokeVerified: true
    },
    null,
    2
  )
);

async function syncCloudflareRuntimeSecrets() {
  const secret = process.env.V2_TRUSTED_PROXY_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Cloudflare 运行密钥缺少 V2_TRUSTED_PROXY_SECRET');
  }
  if (typeof apiUpstreamBaseUrl !== 'string' || !apiUpstreamBaseUrl) {
    throw new Error('Cloudflare 运行配置缺少 API_UPSTREAM_BASE_URL');
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'id-v2-cloudflare-secrets-'));
  const secretFile = path.join(temporaryDirectory, 'worker-secrets.json');
  try {
    await writeFile(
      secretFile,
      JSON.stringify({
        API_UPSTREAM_BASE_URL: apiUpstreamBaseUrl,
        V2_TRUSTED_PROXY_SECRET: secret
      }),
      { mode: 0o600 }
    );
    await run('npx', [
      'wrangler@4.114.0',
      'secret',
      'bulk',
      secretFile,
      '--config',
      'wrangler.cloudflare-free.jsonc'
    ]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env ?? process.env,
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
