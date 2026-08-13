#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';
import { normalizeDatabaseConnection } from './lib/production-closure-audit.mjs';
import {
  describeBackupTransactions,
  findStaleBackupTransactions,
  inspectProductionBackupTransactions
} from './lib/production-backup-transactions.mjs';

const EXPECTED_PROJECT_REF = 'fjquufgbnxyocmuzltxi';
const USER_TABLE_PREFERENCES_RUNTIME_ACCESS_MIGRATION =
  '20260809090000_user_table_preferences_runtime_access';
const BEIJING_BUSINESS_TIMEZONE_MIGRATION = '20260812180000_beijing_business_timezone';
const BACKUP_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
const BACKUP_WAIT_POLL_MS = 5 * 1000;
const RECOVERABLE_ROLLED_BACK_MIGRATIONS = new Set([
  USER_TABLE_PREFERENCES_RUNTIME_ACCESS_MIGRATION,
  BEIJING_BUSINESS_TIMEZONE_MIGRATION
]);
const DATABASE_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'MIGRATION_DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'V2_RUNTIME_DATABASE_URL'
];

const args = parseArgs(process.argv.slice(2));
const backupPath = await validateBackup(args.backup, args.backupSha256);
const expectedConfirmation = `MIGRATE_${EXPECTED_PROJECT_REF}_${args.backupSha256.slice(0, 12)}`;
if (args.confirmation !== expectedConfirmation) {
  throw new Error(`确认口令不匹配；必须显式提供 ${expectedConfirmation}`);
}

await requireCleanSynchronizedMain();

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
  throw new Error('migration 目标不是已核验的生产 Supabase 项目');
}

await waitForProductionBackups(databaseUrl);
const before = await readMigrationState(databaseUrl);
const environment = { ...process.env };
for (const key of DATABASE_KEYS) delete environment[key];
environment.DATABASE_URL = databaseUrl;
environment.DIRECT_URL = databaseUrl;

if (args.resolveRolledBack) {
  await assertExpectedRolledBackMigration(databaseUrl, args.resolveRolledBack);
  await run(
    'npm',
    [
      'exec',
      '--workspace',
      '@apple-business/api',
      '--',
      'prisma',
      'migrate',
      'resolve',
      '--rolled-back',
      args.resolveRolledBack,
      '--schema',
      'prisma/schema.prisma'
    ],
    { environment }
  );
}

await run('npm', ['run', 'prisma:migrate:deploy', '--workspace', '@apple-business/api'], {
  environment
});

const after = await readMigrationState(databaseUrl);
console.log(
  JSON.stringify(
    {
      ok: true,
      projectRef: EXPECTED_PROJECT_REF,
      backup: backupPath,
      backupSha256: args.backupSha256,
      resolvedRolledBackMigration: args.resolveRolledBack ?? null,
      migrationsBefore: before,
      migrationsAfter: after
    },
    null,
    2
  )
);

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    if (value.startsWith('--backup=')) result.backup = value.slice('--backup='.length);
    else if (value.startsWith('--backup-sha256=')) {
      result.backupSha256 = value.slice('--backup-sha256='.length).toLowerCase();
    } else if (value.startsWith('--confirmation=')) {
      result.confirmation = value.slice('--confirmation='.length);
    } else if (value.startsWith('--resolve-rolled-back=')) {
      result.resolveRolledBack = value.slice('--resolve-rolled-back='.length);
    } else throw new Error(`未知参数：${value}`);
  }

  if (!path.isAbsolute(result.backup || '')) throw new Error('--backup 必须是绝对路径');
  if (!result.backupSha256?.match(/^[a-f0-9]{64}$/)) {
    throw new Error('--backup-sha256 必须是 64 位 SHA-256');
  }
  if (
    result.resolveRolledBack !== undefined &&
    !RECOVERABLE_ROLLED_BACK_MIGRATIONS.has(result.resolveRolledBack)
  ) {
    throw new Error(
      `只允许恢复已审查的失败 migration：${[...RECOVERABLE_ROLLED_BACK_MIGRATIONS].join('、')}`
    );
  }
  return result;
}

async function assertExpectedRolledBackMigration(databaseUrl, migrationName) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: 'id-v2-production-migration-recovery-gate'
  });
  await client.connect();
  try {
    const failed = await client.query(
      `SELECT id, applied_steps_count
       FROM public._prisma_migrations
       WHERE migration_name = $1
         AND finished_at IS NULL
         AND rolled_back_at IS NULL`,
      [migrationName]
    );
    if (failed.rowCount !== 1) {
      throw new Error('目标 migration 不存在唯一、尚未处理的失败记录');
    }
    if (failed.rows[0].applied_steps_count !== 0) {
      throw new Error('失败 migration 已记录部分执行步骤，拒绝自动标记回滚');
    }

    if (migrationName === USER_TABLE_PREFERENCES_RUNTIME_ACCESS_MIGRATION) {
      const state = (
        await client.query(`
        SELECT
          CASE
            WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime')
            THEN has_table_privilege(
              'id_business_v2_runtime',
              'public.id_business_v2_user_table_preferences',
              'SELECT'
            )
            ELSE NULL
          END AS runtime_select,
          (
            SELECT count(*)::integer
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'id_business_v2_user_table_preferences'
              AND policyname IN ('id_business_v2_runtime_access', 'id_business_v2_audit_read')
          ) AS policy_count
      `)
      ).rows[0];
      if (state.runtime_select !== false || state.policy_count !== 0) {
        throw new Error('失败 migration 存在未预期的部分生效状态，拒绝自动标记回滚');
      }
      return;
    }

    if (migrationName === BEIJING_BUSINESS_TIMEZONE_MIGRATION) {
      const state = (
        await client.query(`
          SELECT
            (
              SELECT column_default
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'id_business_v2_finance_settings'
                AND column_name = 'timezone'
            ) AS timezone_default,
            (
              SELECT count(*)::integer
              FROM public.id_business_v2_finance_settings
              WHERE timezone = 'Asia/Shanghai'
            ) AS shanghai_count
        `)
      ).rows[0];
      if (
        !String(state.timezone_default).includes('Asia/Kuala_Lumpur') ||
        state.shanghai_count !== 0
      ) {
        throw new Error('失败的北京时间 migration 存在未预期的部分生效状态，拒绝自动标记回滚');
      }
      return;
    }

    throw new Error('目标 migration 缺少恢复状态校验');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForProductionBackups(databaseUrl) {
  const deadline = Date.now() + BACKUP_WAIT_TIMEOUT_MS;
  while (true) {
    const { transactions } = await inspectProductionBackupTransactions(databaseUrl, {
      applicationName: 'id-v2-production-migration-backup-gate'
    });
    const stale = findStaleBackupTransactions(transactions);
    if (stale.length > 0) {
      throw new Error(
        `发现专用备份角色遗留的空闲事务（${describeBackupTransactions(stale)}），` +
          '已在 Prisma 执行前停止。请先确认备份进程已结束并清理遗留连接。'
      );
    }
    if (transactions.length === 0) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `生产备份事务在 3 分钟内未完成（${describeBackupTransactions(transactions)}），` +
          '已在 Prisma 执行前停止，请等待备份完成后重试。'
      );
    }
    console.log(
      `检测到生产备份正在执行（${describeBackupTransactions(transactions)}），等待完成后再迁移。`
    );
    await delay(Math.min(BACKUP_WAIT_POLL_MS, remainingMs));
  }
}

async function validateBackup(inputPath, expectedSha256) {
  const resolvedPath = await realpath(inputPath);
  const gitCommonDirectory = await realpath(
    await capture('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  );
  const allowedRoots = [
    path.resolve('backups/postgres'),
    path.join(path.dirname(gitCommonDirectory), 'backups/postgres')
  ];
  if (
    !allowedRoots.some((root) => resolvedPath.startsWith(`${root}${path.sep}`)) ||
    !resolvedPath.endsWith('.dump')
  ) {
    throw new Error('生产 migration 备份必须是当前项目 backups/postgres 下的 .dump 文件');
  }

  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error('生产 migration 备份无效');
  const actualSha256 = await hashFile(resolvedPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`生产 migration 备份 SHA-256 不匹配：${actualSha256}`);
  }
  const manifest = JSON.parse(
    await readFile(resolvedPath.replace(/\.dump$/, '.manifest.json'), 'utf8')
  );
  if (manifest.sha256 !== actualSha256 || manifest.sizeBytes !== fileStat.size) {
    throw new Error('生产 migration 备份 manifest 与 dump 不一致');
  }
  return resolvedPath;
}

async function requireCleanSynchronizedMain() {
  const [branch, status, head, originHead] = await Promise.all([
    capture('git', ['branch', '--show-current']),
    capture('git', ['status', '--porcelain']),
    capture('git', ['rev-parse', 'HEAD']),
    capture('git', ['rev-parse', 'origin/main'])
  ]);
  if (branch !== 'main') throw new Error('生产 migration 只允许从 main 执行');
  if (status) throw new Error('生产 migration 要求工作区干净');
  if (head !== originHead) throw new Error('生产 migration 要求 HEAD 与 origin/main 完全一致');
}

async function readMigrationState(databaseUrl) {
  const client = new Client({
    ...normalizeDatabaseConnection(databaseUrl),
    application_name: 'id-v2-production-migration-gate'
  });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT migration_name, finished_at
      FROM public._prisma_migrations
      WHERE rolled_back_at IS NULL
      ORDER BY finished_at NULLS LAST, migration_name
    `);
    return {
      count: result.rowCount,
      latest: result.rows.at(-1)?.migration_name ?? null
    };
  } finally {
    await client.end();
  }
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

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(' ')} 失败：${stderr.trim()}`));
    });
  });
}

function run(command, args, { environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`生产 migration 失败，退出码 ${code ?? 'unknown'}`));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
