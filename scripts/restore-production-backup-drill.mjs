#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  CORE_BACKUP_TABLES,
  POSTGRES_BACKUP_VERSION,
  countFingerprint,
  decryptBackupBundle,
  parseCoreCounts
} from './lib/production-backup.mjs';

const args = parseArgs(process.argv.slice(2));
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'id-v2-restore-drill-'));
const containerName = `id-v2-restore-drill-${process.pid}-${randomBytes(4).toString('hex')}`;
const postgresPassword = randomBytes(24).toString('base64url');
let containerStarted = false;

try {
  const privateKeyPem = await readFile(path.resolve(args.privateKey), 'utf8');
  const decrypted = await decryptBackupBundle({
    archivePath: path.resolve(args.archive),
    privateKeyPem,
    passphrase: process.env.BACKUP_PRIVATE_KEY_PASSPHRASE
  });
  const dumpPath = path.join(temporaryDirectory, 'restore.dump');
  await writeFile(dumpPath, decrypted.dump, { flag: 'wx', mode: 0o600 });

  await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      'POSTGRES_DB=restore_drill',
      '-v',
      `${temporaryDirectory}:/backup:ro`,
      `postgres:${POSTGRES_BACKUP_VERSION}`
    ],
    {
      environment: { ...process.env, POSTGRES_PASSWORD: postgresPassword },
      timeoutMs: 60_000
    }
  );
  containerStarted = true;
  await waitForPostgres();
  await dockerExec([
    'psql',
    '-U',
    'postgres',
    '-d',
    'restore_drill',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `DROP SCHEMA public CASCADE;
     CREATE SCHEMA public;
     DO $do$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
         CREATE ROLE id_business_v2_runtime NOLOGIN;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
         CREATE ROLE id_business_v2_audit NOLOGIN;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_v2_backup') THEN
         CREATE ROLE id_v2_backup NOLOGIN;
       END IF;
     END
     $do$;`
  ]);
  await dockerExec(
    [
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      'restore_drill',
      '--schema=public',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '/backup/restore.dump'
    ],
    10 * 60_000
  );

  const restoredCounts = parseCoreCounts(
    await dockerExec(
      [
        'psql',
        '-U',
        'postgres',
        '-d',
        'restore_drill',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '--command',
        coreCountSql()
      ],
      60_000,
      true
    )
  );
  if (countFingerprint(restoredCounts) !== decrypted.manifest.countFingerprint) {
    throw new Error('隔离恢复后的核心表计数与备份时点不一致');
  }
  const integrity = JSON.parse(
    await dockerExec(
      [
        'psql',
        '-U',
        'postgres',
        '-d',
        'restore_drill',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '--command',
        integritySql()
      ],
      60_000,
      true
    )
  );
  if (
    integrity.failedMigrations !== 0 ||
    integrity.unvalidatedForeignKeys !== 0 ||
    integrity.unbalancedJournals !== 0
  ) {
    throw new Error(`隔离恢复完整性检查失败：${JSON.stringify(integrity)}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: 'isolated-restore-drill',
        postgresVersion: POSTGRES_BACKUP_VERSION,
        createdAt: decrypted.manifest.createdAt,
        countFingerprint: decrypted.manifest.countFingerprint,
        restoredCounts,
        integrity
      },
      null,
      2
    )
  );
} finally {
  if (containerStarted) {
    await run('docker', ['rm', '--force', containerName], {
      environment: process.env,
      timeoutMs: 30_000,
      allowFailure: true
    });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    if (value.startsWith('--archive=')) result.archive = value.slice('--archive='.length);
    else if (value.startsWith('--private-key=')) {
      result.privateKey = value.slice('--private-key='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (!result.archive?.endsWith('.backup.enc')) throw new Error('必须提供 .backup.enc 归档');
  if (!result.privateKey) throw new Error('必须提供 --private-key');
  return result;
}

async function waitForPostgres() {
  let lastError;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await dockerExec(['pg_isready', '-U', 'postgres', '-d', 'restore_drill'], 5_000);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

function dockerExec(arguments_, timeoutMs = 60_000, capture = false) {
  return run('docker', ['exec', containerName, ...arguments_], {
    environment: process.env,
    timeoutMs,
    capture
  });
}

function run(
  command,
  arguments_,
  { environment, timeoutMs, capture = false, allowFailure = false }
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    if (capture) child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if ((code === 0 && !signal) || allowFailure) resolve(stdout.trim());
      else reject(new Error(`${command} 执行失败：${stderr.trim().slice(-2000)}`));
    });
  });
}

function coreCountSql() {
  return CORE_BACKUP_TABLES.map(
    (table) => `SELECT '${table}=' || count(*)::bigint::text FROM public."${table}";`
  ).join('\n');
}

function integritySql() {
  return `
    SELECT json_build_object(
      'failedMigrations', (
        SELECT count(*)::int FROM public._prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL
      ),
      'unvalidatedForeignKeys', (
        SELECT count(*)::int FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated
      ),
      'unbalancedJournals', (
        SELECT count(*)::int FROM (
          SELECT journal_id
          FROM public.id_business_v2_finance_journal_lines
          GROUP BY journal_id
          HAVING COALESCE(sum(amount_cny) FILTER (WHERE direction::text = 'debit'), 0)
               <> COALESCE(sum(amount_cny) FILTER (WHERE direction::text = 'credit'), 0)
        ) unbalanced
      )
    )::text;
  `;
}
