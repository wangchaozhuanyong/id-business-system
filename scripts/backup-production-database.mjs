#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CORE_BACKUP_TABLES,
  EXPECTED_BACKUP_PROJECT_REF,
  POSTGRES_BACKUP_VERSION,
  assertExpectedBackupDatabase,
  atomicWriteJson,
  countFingerprint,
  encryptBackupBundle,
  parseCoreCounts,
  parsePgRestoreList,
  sha256File
} from './lib/production-backup.mjs';

const BACKUP_TIMEOUT_MS = 15 * 60 * 1000;
const args = parseArgs(process.argv.slice(2));
const expectedConfirmation = `BACKUP_${EXPECTED_BACKUP_PROJECT_REF}_${args.label}`;
if (args.confirmation !== expectedConfirmation) {
  throw new Error(`确认口令不匹配；必须显式提供 ${expectedConfirmation}`);
}

process.umask(0o077);
const databaseUrl = await resolveBackupDatabaseUrl();
const url = assertExpectedBackupDatabase(databaseUrl);
const backupDirectory = await resolveBackupDirectory(args.outputDirectory);
const lockPath = path.join(backupDirectory, '.production-backup.lock');
const stamp = timestamp();
const fileBase = `${args.label}-${stamp}`;
const partialDumpPath = path.join(backupDirectory, `.${fileBase}.dump.partial`);
const dumpPath = path.join(backupDirectory, `${fileBase}.dump`);
const partialManifestPath = path.join(backupDirectory, `.${fileBase}.manifest.json.partial`);
const manifestPath = path.join(backupDirectory, `${fileBase}.manifest.json`);
const partialArchivePath = path.join(backupDirectory, `.${fileBase}.backup.enc.partial`);
const archivePath = path.join(backupDirectory, `${fileBase}.backup.enc`);
const receiptPath = path.join(backupDirectory, `${fileBase}.receipt.json`);
const createdPaths = new Set();
let lockAcquired = false;

try {
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    { flag: 'wx', mode: 0o400 }
  );
  lockAcquired = true;
  createdPaths.add(lockPath);

  const postgresEnvironment = buildPostgresEnvironment(url);
  createdPaths.add(partialDumpPath);
  await runPostgresContainer({
    environment: postgresEnvironment,
    directory: backupDirectory,
    args: [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=30000',
      '--file',
      `/backup/${path.basename(partialDumpPath)}`
    ],
    timeoutMs: BACKUP_TIMEOUT_MS,
    capture: false
  });
  await chmod(partialDumpPath, 0o400);
  const dumpStat = await stat(partialDumpPath);
  if (!dumpStat.isFile() || dumpStat.size === 0) throw new Error('pg_dump 生成了空备份');

  const tocOutput = await runPostgresContainer({
    environment: {},
    directory: backupDirectory,
    readOnlyMount: true,
    args: ['pg_restore', '--list', `/backup/${path.basename(partialDumpPath)}`],
    timeoutMs: 60_000,
    capture: true
  });
  const toc = parsePgRestoreList(tocOutput);
  const coreCounts = parseCoreCounts(
    await runPostgresContainer({
      environment: postgresEnvironment,
      directory: backupDirectory,
      readOnlyMount: true,
      args: [
        'psql',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '--command',
        coreCountSql()
      ],
      timeoutMs: 60_000,
      capture: true
    })
  );
  const dumpSha256 = await sha256File(partialDumpPath);
  const manifest = {
    createdAt: new Date().toISOString(),
    databaseProjectRef: EXPECTED_BACKUP_PROJECT_REF,
    databaseVersion: POSTGRES_BACKUP_VERSION,
    pgDumpVersion: POSTGRES_BACKUP_VERSION,
    format: 'custom',
    file: path.basename(dumpPath),
    sizeBytes: dumpStat.size,
    sha256: dumpSha256,
    purpose: args.label,
    ...toc,
    coreCounts,
    countFingerprint: countFingerprint(coreCounts)
  };
  createdPaths.add(partialManifestPath);
  await writeFile(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o400
  });

  let archive;
  if (args.publicKeyPath) {
    const publicKeyPem = await readFile(await realpath(args.publicKeyPath), 'utf8');
    createdPaths.add(partialArchivePath);
    archive = await encryptBackupBundle({
      dumpPath: partialDumpPath,
      manifestPath: partialManifestPath,
      outputPath: partialArchivePath,
      publicKeyPem
    });
    await rename(partialArchivePath, archivePath);
    createdPaths.delete(partialArchivePath);
    createdPaths.add(archivePath);
    await atomicWriteJson(receiptPath, {
      createdAt: manifest.createdAt,
      archive: path.basename(archivePath),
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
      publicKeySha256: archive.publicKeySha256,
      encrypted: true
    });
    createdPaths.add(receiptPath);
  }

  if (args.ephemeralPlaintext) {
    await unlink(partialDumpPath);
    await unlink(partialManifestPath);
    createdPaths.delete(partialDumpPath);
    createdPaths.delete(partialManifestPath);
  } else {
    await rename(partialDumpPath, dumpPath);
    await rename(partialManifestPath, manifestPath);
    createdPaths.delete(partialDumpPath);
    createdPaths.delete(partialManifestPath);
    createdPaths.add(dumpPath);
    createdPaths.add(manifestPath);
  }

  const result = {
    ok: true,
    dump: args.ephemeralPlaintext ? null : dumpPath,
    manifest: args.ephemeralPlaintext ? null : manifestPath,
    archive: archivePath && archive ? archivePath : null,
    receipt: archive ? receiptPath : null,
    dumpSizeBytes: manifest.sizeBytes,
    dumpSha256,
    archiveSizeBytes: archive?.sizeBytes ?? null,
    archiveSha256: archive?.sha256 ?? null,
    tocEntries: toc.tocEntries,
    tableEntries: toc.tableEntries,
    tableDataEntries: toc.tableDataEntries,
    countFingerprint: manifest.countFingerprint
  };
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `archive=${result.archive ?? ''}`,
        `receipt=${result.receipt ?? ''}`,
        `archive_size_bytes=${result.archiveSizeBytes ?? ''}`,
        `archive_sha256=${result.archiveSha256 ?? ''}`
      ].join('\n') + '\n',
      { mode: 0o600 }
    );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  for (const candidate of [...createdPaths].reverse()) {
    if (candidate === lockPath) continue;
    await unlink(candidate).catch(() => undefined);
  }
  throw error;
} finally {
  if (lockAcquired) await unlink(lockPath).catch(() => undefined);
}

function parseArgs(values) {
  const result = {
    outputDirectory: 'backups/postgres',
    ephemeralPlaintext: false,
    label: undefined,
    confirmation: undefined,
    publicKeyPath: undefined
  };
  for (const value of values) {
    if (value.startsWith('--label=')) result.label = value.slice('--label='.length);
    else if (value.startsWith('--confirmation=')) {
      result.confirmation = value.slice('--confirmation='.length);
    } else if (value.startsWith('--output-dir=')) {
      result.outputDirectory = value.slice('--output-dir='.length);
    } else if (value.startsWith('--public-key=')) {
      result.publicKeyPath = value.slice('--public-key='.length);
    } else if (value === '--ephemeral-plaintext') result.ephemeralPlaintext = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!result.label?.match(/^[a-z0-9][a-z0-9-]{2,60}$/u)) {
    throw new Error('备份标签必须使用 3-61 位小写字母、数字或连字符');
  }
  if (result.ephemeralPlaintext && !result.publicKeyPath) {
    throw new Error('--ephemeral-plaintext 必须同时提供 --public-key');
  }
  return result;
}

async function resolveBackupDatabaseUrl() {
  if (process.env.BACKUP_DATABASE_URL) return process.env.BACKUP_DATABASE_URL;
  const secretsPath = await realpath(path.resolve('.deploy/cloudflare-free.secrets.json'));
  const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
  if (!secrets.BACKUP_DATABASE_URL) throw new Error('部署凭据缺少 BACKUP_DATABASE_URL');
  return secrets.BACKUP_DATABASE_URL;
}

async function resolveBackupDirectory(input) {
  const resolved = path.resolve(input);
  const projectRoot = path.resolve('.');
  if (resolved !== path.join(projectRoot, 'backups', 'postgres')) {
    throw new Error('生产备份目录必须固定为项目内 backups/postgres');
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const actual = await realpath(resolved);
  if (actual !== resolved) throw new Error('生产备份目录不得经过符号链接');
  return actual;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function buildPostgresEnvironment(url) {
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGSSLMODE: url.searchParams.get('sslmode') || 'require'
  };
}

function coreCountSql() {
  return CORE_BACKUP_TABLES.map(
    (table) => `SELECT '${table}=' || count(*)::bigint::text FROM public."${table}";`
  ).join('\n');
}

function runPostgresContainer({
  environment,
  directory,
  args,
  timeoutMs,
  capture,
  readOnlyMount = false
}) {
  return new Promise((resolve, reject) => {
    const dockerArgs = [
      'run',
      '--rm',
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`
    ];
    for (const key of Object.keys(environment)) dockerArgs.push('-e', key);
    dockerArgs.push(
      '-v',
      `${directory}:/backup${readOnlyMount ? ':ro' : ''}`,
      `postgres:${POSTGRES_BACKUP_VERSION}`,
      ...args
    );
    const child = spawn('docker', dockerArgs, {
      env: { ...process.env, ...environment },
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    if (capture) child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!capture) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal) resolve(stdout);
      else if (signal === 'SIGTERM') reject(new Error(`生产备份命令超过 ${timeoutMs}ms 超时`));
      else
        reject(
          new Error(`生产备份命令失败，退出码 ${code ?? 'unknown'}：${stderr.trim().slice(-1000)}`)
        );
    });
  });
}
