#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const EXPECTED_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
const args = parseArgs(process.argv.slice(2));
const expectedConfirmation = `BACKUP_${EXPECTED_PROJECT_REF}_${args.label}`;
if (args.confirmation !== expectedConfirmation) {
  throw new Error(`确认口令不匹配；必须显式提供 ${expectedConfirmation}`);
}

const secretsPath = await realpath(path.resolve('.deploy/cloudflare-free.secrets.json'));
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
const databaseUrl = secrets.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('部署凭据缺少 MIGRATION_DATABASE_URL');
const url = new URL(databaseUrl);
const direct =
  url.hostname === `db.${EXPECTED_PROJECT_REF}.supabase.co` && url.username === 'postgres';
const pooler =
  url.hostname.endsWith('.pooler.supabase.com') &&
  url.username === `postgres.${EXPECTED_PROJECT_REF}`;
if (!direct && !pooler) {
  throw new Error('备份目标不是已核验的生产 Supabase 项目');
}

const backupDirectory = await realpath(path.resolve('backups/postgres'));
if (backupDirectory !== path.resolve('backups/postgres')) {
  throw new Error('备份目录必须是当前项目内的真实目录');
}
const stamp = new Date()
  .toISOString()
  .replaceAll('-', '')
  .replaceAll(':', '')
  .replace(/\.\d{3}Z$/, 'Z');
const fileName = `${args.label}-${stamp}.dump`;
const backupPath = path.join(backupDirectory, fileName);
const postgresEnvironment = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
  PGSSLMODE: url.searchParams.get('sslmode') || 'require'
};

await runDockerBackup(postgresEnvironment, backupDirectory, fileName);
const fileStat = await stat(backupPath);
const sha256 = await hashFile(backupPath);
const manifestPath = backupPath.replace(/\.dump$/, '.manifest.json');
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      databaseProjectRef: EXPECTED_PROJECT_REF,
      databaseVersion: '17.6',
      pgDumpVersion: '17.6',
      format: 'custom',
      file: fileName,
      sizeBytes: fileStat.size,
      sha256,
      purpose: args.label
    },
    null,
    2
  )}\n`,
  { flag: 'wx', mode: 0o400 }
);
await chmod(backupPath, 0o400);
await chmod(manifestPath, 0o400);

console.log(
  JSON.stringify(
    {
      ok: true,
      file: backupPath,
      manifest: manifestPath,
      sizeBytes: fileStat.size,
      sha256
    },
    null,
    2
  )
);

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    if (value.startsWith('--label=')) result.label = value.split('=', 2)[1];
    else if (value.startsWith('--confirmation=')) result.confirmation = value.split('=', 2)[1];
    else throw new Error(`未知参数：${value}`);
  }
  if (!result.label?.match(/^[a-z0-9][a-z0-9-]{2,60}$/)) {
    throw new Error('备份标签必须使用 3-61 位小写字母、数字或连字符');
  }
  return result;
}

function runDockerBackup(environment, directory, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-e',
        'PGHOST',
        '-e',
        'PGPORT',
        '-e',
        'PGUSER',
        '-e',
        'PGPASSWORD',
        '-e',
        'PGDATABASE',
        '-e',
        'PGSSLMODE',
        '-v',
        `${directory}:/backup`,
        'postgres:17.6',
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file',
        `/backup/${file}`
      ],
      { env: environment, stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`生产备份失败，退出码 ${code ?? 'unknown'}`));
    });
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
