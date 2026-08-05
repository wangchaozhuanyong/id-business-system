#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  POSTGRES_BACKUP_VERSION,
  decryptBackupBundle,
  parsePgRestoreList,
  validatePlaintextBackup
} from './lib/production-backup.mjs';

const args = parseArgs(process.argv.slice(2));
let temporaryDirectory;

try {
  let dumpPath;
  let manifest;
  if (args.archive) {
    if (!args.privateKey) throw new Error('验证加密备份必须提供 --private-key');
    const privateKeyPem = await readFile(path.resolve(args.privateKey), 'utf8');
    const decrypted = await decryptBackupBundle({
      archivePath: path.resolve(args.archive),
      privateKeyPem,
      passphrase: process.env.BACKUP_PRIVATE_KEY_PASSPHRASE
    });
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'id-v2-backup-verify-'));
    dumpPath = path.join(temporaryDirectory, 'verified.dump');
    await writeFile(dumpPath, decrypted.dump, { flag: 'wx', mode: 0o600 });
    manifest = decrypted.manifest;
  } else {
    dumpPath = path.resolve(args.backup);
    manifest = await validatePlaintextBackup({
      dumpPath,
      manifestPath: dumpPath.replace(/\.dump$/u, '.manifest.json')
    });
  }

  const toc = parsePgRestoreList(await inspectDump(dumpPath));
  if (
    toc.tocEntries !== manifest.tocEntries ||
    toc.tableEntries !== manifest.tableEntries ||
    toc.tableDataEntries !== manifest.tableDataEntries
  ) {
    throw new Error('实际 pg_restore 目录统计与 manifest 不一致');
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        encrypted: Boolean(args.archive),
        createdAt: manifest.createdAt,
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        countFingerprint: manifest.countFingerprint,
        ...toc
      },
      null,
      2
    )
  );
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    if (value.startsWith('--backup=')) result.backup = value.slice('--backup='.length);
    else if (value.startsWith('--archive=')) result.archive = value.slice('--archive='.length);
    else if (value.startsWith('--private-key=')) {
      result.privateKey = value.slice('--private-key='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (Boolean(result.backup) === Boolean(result.archive)) {
    throw new Error('必须且只能提供 --backup 或 --archive');
  }
  if (result.backup && !result.backup.endsWith('.dump')) throw new Error('--backup 必须是 .dump');
  if (result.archive && !result.archive.endsWith('.backup.enc')) {
    throw new Error('--archive 必须是 .backup.enc');
  }
  return result;
}

function inspectDump(dumpPath) {
  return new Promise((resolve, reject) => {
    const directory = path.dirname(dumpPath);
    const file = path.basename(dumpPath);
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-v',
        `${directory}:/backup:ro`,
        `postgres:${POSTGRES_BACKUP_VERSION}`,
        'pg_restore',
        '--list',
        `/backup/${file}`
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal) resolve(stdout);
      else reject(new Error(`pg_restore --list 失败：${stderr.trim().slice(-1000)}`));
    });
  });
}
