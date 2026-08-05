#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const EXPECTED_REPOSITORY = 'wangchaozhuanyong/id-business-system';
const args = parseArgs(process.argv.slice(2));
if (args.repository !== EXPECTED_REPOSITORY) throw new Error('GitHub 仓库目标不匹配');
const privateKeyPath = await realpath(path.resolve(args.privateKey));
const privateKeyStat = await stat(privateKeyPath);
if (!privateKeyStat.isFile() || (privateKeyStat.mode & 0o077) !== 0) {
  throw new Error('恢复私钥必须是仅所有者可读的普通文件');
}
const reportDirectory = path.resolve(args.reportDirectory);
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
if ((await realpath(reportDirectory)) !== reportDirectory) {
  throw new Error('恢复报告目录不得经过符号链接');
}
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'id-v2-monthly-restore-'));

try {
  const artifacts = JSON.parse(
    await capture('gh', ['api', `repos/${EXPECTED_REPOSITORY}/actions/artifacts?per_page=100`])
  )
    .artifacts.filter(
      (artifact) => !artifact.expired && artifact.name.startsWith('production-daily-')
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const artifact = artifacts[0];
  if (!artifact) throw new Error('没有可用的 production-daily 加密备份');
  await run(
    'gh',
    [
      'run',
      'download',
      String(artifact.workflow_run.id),
      '--repo',
      EXPECTED_REPOSITORY,
      '--name',
      artifact.name,
      '--dir',
      temporaryDirectory
    ],
    { timeoutMs: 5 * 60_000 }
  );
  const archivePath = await findSingleArchive(temporaryDirectory);
  const passphrase = await capture('security', [
    'find-generic-password',
    '-s',
    args.keychainService,
    '-a',
    args.keychainAccount,
    '-w'
  ]);
  if (!passphrase) throw new Error('macOS Keychain 未返回恢复私钥口令');
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rawResult = await capture(
    process.execPath,
    [
      path.join(scriptDirectory, 'restore-production-backup-drill.mjs'),
      `--archive=${archivePath}`,
      `--private-key=${privateKeyPath}`
    ],
    {
      timeoutMs: 20 * 60_000,
      environment: { ...process.env, BACKUP_PRIVATE_KEY_PASSPHRASE: passphrase }
    }
  );
  const drill = JSON.parse(rawResult);
  const reportPath = path.join(
    reportDirectory,
    `monthly-restore-${new Date().toISOString().replaceAll(':', '').replaceAll('-', '')}.json`
  );
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repository: EXPECTED_REPOSITORY,
        artifact: {
          id: artifact.id,
          name: artifact.name,
          createdAt: artifact.created_at,
          expiresAt: artifact.expires_at
        },
        drill
      },
      null,
      2
    )}\n`,
    { flag: 'wx', mode: 0o400 }
  );
  await chmod(reportPath, 0o400);
  console.log(JSON.stringify({ ok: true, report: reportPath, artifact: artifact.name }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function parseArgs(values) {
  const result = {
    repository: EXPECTED_REPOSITORY,
    privateKey: undefined,
    reportDirectory: 'backups/recovery-reports',
    keychainService: 'id-business-v2-production-backup',
    keychainAccount: process.env.USER || 'production-operator'
  };
  for (const value of values) {
    if (value.startsWith('--repository=')) result.repository = value.slice('--repository='.length);
    else if (value.startsWith('--private-key=')) {
      result.privateKey = value.slice('--private-key='.length);
    } else if (value.startsWith('--report-dir=')) {
      result.reportDirectory = value.slice('--report-dir='.length);
    } else if (value.startsWith('--keychain-service=')) {
      result.keychainService = value.slice('--keychain-service='.length);
    } else if (value.startsWith('--keychain-account=')) {
      result.keychainAccount = value.slice('--keychain-account='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (!result.privateKey) throw new Error('必须提供 --private-key');
  return result;
}

async function findSingleArchive(directory) {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(directory, { recursive: true }))
    .filter((file) => file.endsWith('.backup.enc'))
    .map((file) => path.join(directory, file));
  if (files.length !== 1) throw new Error('下载的 Artifact 必须且只能包含一份加密备份');
  return files[0];
}

function capture(command, arguments_, options = {}) {
  return run(command, arguments_, { ...options, capture: true });
}

function run(
  command,
  arguments_,
  { timeoutMs = 60_000, capture = false, environment = process.env } = {}
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
      if (code === 0 && !signal) resolve(stdout.trim());
      else reject(new Error(`${command} 执行失败：${stderr.trim().slice(-2000)}`));
    });
  });
}
