import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseDoctorOptions(args) {
  const options = { runtime: 'native', mysqlClient: 'mysql', mysqlServer: 'mysqld' };
  const flags = new Map([
    ['--runtime', 'runtime'],
    ['--mysql-client', 'mysqlClient'],
    ['--mysql-server', 'mysqlServer']
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const [flag, ...parts] = args[index].split('=');
    const key = flags.get(flag);
    const value = parts.length > 0 ? parts.join('=') : args[++index];
    if (!key || seen.has(flag) || !value || value.startsWith('--') || /[\r\n\0]/.test(value)) {
      throw new Error('Invalid doctor arguments.');
    }
    options[key] = value;
    seen.add(flag);
  }
  if (!['native', 'docker'].includes(options.runtime)) {
    throw new Error('Invalid doctor runtime.');
  }
  return options;
}

export function runDoctor({
  args = [],
  cwd = rootDir,
  spawn = spawnSync,
  exists = existsSync,
  lstat = lstatSync,
  readFile = readFileSync
} = {}) {
  const checks = [];
  const addCheck = (name, ok, detail) => checks.push({ name, ok, detail });
  let options;
  try {
    options = parseDoctorOptions(args);
  } catch {
    addCheck(
      'Doctor arguments',
      false,
      'use --runtime=native|docker and optional --mysql-client / --mysql-server executable paths'
    );
    return { checks, failed: 1 };
  }

  function commandResult(command, commandArgs, timeout = 10000) {
    try {
      const result = spawn(command, commandArgs, {
        cwd,
        encoding: 'utf8',
        shell: false,
        timeout,
        maxBuffer: 1024 * 1024
      });
      return result.error || result.status !== 0 ? null : result;
    } catch {
      return null;
    }
  }

  function commandVersion(command, pattern) {
    const result = commandResult(command, ['--version']);
    const version = result?.stdout?.trim().split('\n')[0].match(pattern);
    return version ? version[1] : null;
  }

  const nodeVersion = commandVersion('node', /^v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/);
  addCheck(
    'Node.js >= 22',
    Number(nodeVersion?.split('.')[0]) >= 22,
    nodeVersion ?? 'not available'
  );
  const npmVersion = commandVersion('npm', /^(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/);
  addCheck('npm >= 10', Number(npmVersion?.split('.')[0]) >= 10, npmVersion ?? 'not available');

  let envContent = null;
  try {
    if (exists(resolve(cwd, '.env'))) envContent = readFile(resolve(cwd, '.env'), 'utf8');
  } catch {
    // Report a fixed failure message; file errors may contain sensitive paths or values.
  }
  addCheck('.env exists', Boolean(envContent), envContent ? '.env found' : 'run npm run setup:env');
  for (const workspaceEnv of ['apps/api/.env', 'apps/admin/.env']) {
    let isSymlink = false;
    try {
      const envPath = resolve(cwd, workspaceEnv);
      isSymlink = exists(envPath) && lstat(envPath).isSymbolicLink();
    } catch {
      // Treat an unreadable link as a failed prerequisite.
    }
    addCheck(
      `${workspaceEnv} symlink`,
      isSymlink,
      isSymlink ? 'linked to root .env' : 'run npm run setup:env'
    );
  }
  if (envContent) {
    const hasDatabaseUrl = /^DATABASE_URL=mysql:\/\//m.test(envContent);
    addCheck(
      'DATABASE_URL uses MySQL',
      hasDatabaseUrl,
      hasDatabaseUrl ? 'configured' : 'missing or invalid'
    );
    const placeholders = [
      'JWT_SECRET',
      'FIELD_ENCRYPTION_KEY',
      'HASH_SECRET',
      'SEED_ADMIN_PASSWORD'
    ].filter((key) => envContent.includes(`${key}=change_me`));
    addCheck(
      '.env secrets are not placeholders',
      placeholders.length === 0,
      placeholders.length === 0 ? 'configured' : 'replace placeholder values in .env'
    );
  }

  if (options.runtime === 'native') {
    for (const [name, command] of [
      ['MySQL 8.4 client installed', options.mysqlClient],
      ['MySQL 8.4 server installed', options.mysqlServer]
    ]) {
      const versionResult = commandResult(command, ['--version']);
      const output = versionResult?.stdout ?? '';
      const version = !/MariaDB/i.test(output)
        ? output.match(/(?:^|\s)(?:\S*[/\\])?mysql(?:d)?\s+Ver\s+(8\.4\.\d+)\b/i)?.[1]
        : null;
      addCheck(
        name,
        Boolean(version),
        version
          ? `${version}; database connection not checked`
          : 'not available; provide the installed executable path'
      );
    }
  } else {
    const dockerVersion = commandVersion('docker', /^Docker version (\d+\.\d+\.\d+)(?:[,\s]|$)/);
    addCheck('Docker CLI installed', Boolean(dockerVersion), dockerVersion ?? 'not available');
    if (dockerVersion) {
      const composeResult = commandResult('docker', ['compose', 'version']);
      const composeVersion = composeResult?.stdout?.match(
        /Docker Compose version v?(\d+\.\d+\.\d+)/
      )?.[1];
      addCheck(
        'Docker Compose available',
        Boolean(composeVersion),
        composeVersion ?? 'not available'
      );
      const dockerInfo = commandResult('docker', ['info']);
      addCheck(
        'Docker daemon running',
        Boolean(dockerInfo),
        dockerInfo ? 'running' : 'not available'
      );
    }
  }

  const prismaResult = commandResult('npm', ['run', 'prisma:validate', '--silent'], 60000);
  addCheck(
    'Prisma schema validates',
    Boolean(prismaResult),
    prismaResult ? 'valid' : 'validation failed; details suppressed'
  );
  return { checks, failed: checks.filter((check) => !check.ok).length };
}

export function formatDoctorReport({ checks, failed }) {
  const lines = checks.map(
    (check) => `[${check.ok ? 'OK' : 'FAIL'}] ${check.name}: ${check.detail}`
  );
  lines.push(
    failed > 0
      ? `\nEnvironment doctor found ${failed} issue(s).\nSee README.md for setup notes.`
      : '\nEnvironment doctor passed.'
  );
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runDoctor({ args: process.argv.slice(2) });
  console.log(formatDoctorReport(result));
  process.exitCode = result.failed > 0 ? 1 : 0;
}
