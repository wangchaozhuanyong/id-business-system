#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  RELEASE_PUBLIC_URL,
  RELEASE_SUPABASE_API_BASE_URL,
  RELEASE_SUPABASE_PROJECT_REF,
  createCloudflareProductionBuildEnvironment
} from './lib/cloudflare-release.mjs';

await run('node', ['scripts/validate-cloudflare-free-release.mjs']);

const config = JSON.parse(await readFile('wrangler.cloudflare-free.jsonc', 'utf8'));
const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const shortCommit = commit.slice(0, 12);

await run('npm', ['run', 'build:supabase-v2-api']);
await syncSupabaseRuntimeSecrets();
await run('npx', [
  'supabase@2.111.0',
  'functions',
  'deploy',
  'v2-api',
  '--project-ref',
  RELEASE_SUPABASE_PROJECT_REF,
  '--no-verify-jwt'
]);
await run('node', [
  'scripts/verify-cloudflare-free-deployment.mjs',
  RELEASE_SUPABASE_API_BASE_URL,
  '--api-only'
]);

await run('npm', ['run', 'build:cloudflare-free'], {
  env: createCloudflareProductionBuildEnvironment(process.env)
});
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
      apiBaseUrl: RELEASE_SUPABASE_API_BASE_URL,
      smokeVerified: true
    },
    null,
    2
  )
);

async function syncSupabaseRuntimeSecrets() {
  const requiredSecrets = [
    'V2_RUNTIME_DATABASE_URL',
    'JWT_SECRET',
    'FIELD_ENCRYPTION_KEY',
    'HASH_SECRET'
  ];
  for (const key of requiredSecrets) {
    if (typeof process.env[key] !== 'string' || !process.env[key]) {
      throw new Error(`Supabase 运行密钥缺少 ${key}`);
    }
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'id-v2-supabase-secrets-'));
  const envFile = path.join(temporaryDirectory, 'runtime.env');
  const entries = {
    APP_PUBLIC_URL: RELEASE_PUBLIC_URL,
    AUTH_PROVIDER: 'local',
    CORS_ORIGIN: RELEASE_PUBLIC_URL,
    FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY,
    HASH_SECRET: process.env.HASH_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,
    V2_RUNTIME_DATABASE_URL: process.env.V2_RUNTIME_DATABASE_URL
  };

  try {
    await writeFile(
      envFile,
      `${Object.entries(entries)
        .map(([key, value]) => `${key}=${encodeEnvValue(value)}`)
        .join('\n')}\n`,
      { mode: 0o600 }
    );
    await run('npx', [
      'supabase@2.111.0',
      'secrets',
      'set',
      '--env-file',
      envFile,
      '--project-ref',
      RELEASE_SUPABASE_PROJECT_REF
    ]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function encodeEnvValue(value) {
  if (/[\r\n]/.test(value)) {
    throw new Error('Supabase 运行密钥不得包含换行符');
  }
  return JSON.stringify(value);
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
