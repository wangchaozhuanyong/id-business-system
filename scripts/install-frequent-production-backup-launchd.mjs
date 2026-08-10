#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveNativePostgresClient } from './lib/native-postgres-client.mjs';
import { assertExpectedBackupDatabase } from './lib/production-backup.mjs';

const BACKUP_LABEL = 'com.id-business-v2.frequent-production-backup';
const MONITOR_LABEL = 'com.id-business-v2.frequent-production-backup-monitor';
const BACKUP_MINUTES = [5, 20, 35, 50];
const args = parseArgs(process.argv.slice(2));

if (process.platform !== 'darwin') throw new Error('launchd 安装只允许在 macOS 执行');
process.umask(0o077);
const checkoutPath = await realpath(path.resolve(args.checkout));
const packageValue = JSON.parse(await readFile(path.join(checkoutPath, 'package.json'), 'utf8'));
if (packageValue.name !== 'apple-id-business-system')
  throw new Error('checkout 不是ID业务管理系统');

const runnerPath = await realpath(
  path.join(checkoutPath, 'scripts', 'run-frequent-production-backup.mjs')
);
const monitorPath = await realpath(
  path.join(checkoutPath, 'scripts', 'check-frequent-production-backup.mjs')
);
const publicKeyPath = path.join(checkoutPath, 'deploy', 'backup-recovery-public.pem');
const secretsPath = path.join(checkoutPath, '.deploy', 'cloudflare-free.secrets.json');
await validateRegularFile(publicKeyPath, false);
await validateRegularFile(secretsPath, true);
const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
assertExpectedBackupDatabase(secrets.BACKUP_DATABASE_URL);
const nativePostgresClient = await resolveNativePostgresClient();

const launchAgentsDirectory = path.join(homedir(), 'Library', 'LaunchAgents');
await mkdir(launchAgentsDirectory, { recursive: true });
const nodeProgramPath = await resolveStableNodeProgram();
const backupPlistPath = path.join(launchAgentsDirectory, `${BACKUP_LABEL}.plist`);
const monitorPlistPath = path.join(launchAgentsDirectory, `${MONITOR_LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
if (args.replace) {
  await assertReplaceablePlist(backupPlistPath, BACKUP_LABEL, runnerPath);
  await assertReplaceablePlist(monitorPlistPath, MONITOR_LABEL, monitorPath);
  await run('launchctl', ['bootout', `${domain}/${BACKUP_LABEL}`], { acceptFailure: true });
  await run('launchctl', ['bootout', `${domain}/${MONITOR_LABEL}`], { acceptFailure: true });
  await unlink(backupPlistPath).catch(ignoreMissingFile);
  await unlink(monitorPlistPath).catch(ignoreMissingFile);
} else {
  await assertPathMissing(backupPlistPath);
  await assertPathMissing(monitorPlistPath);
}
await assertLabelNotLoaded(`${domain}/${BACKUP_LABEL}`);
await assertLabelNotLoaded(`${domain}/${MONITOR_LABEL}`);

const environmentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const common = {
  checkoutPath,
  environmentPath,
  nodeProgramPath,
  postgresBinDirectory: nativePostgresClient.directory
};
const createdPaths = [];
const loadedLabels = [];
try {
  await writeSecurePlist(
    backupPlistPath,
    buildBackupPlist({ ...common, label: BACKUP_LABEL, programPath: runnerPath })
  );
  createdPaths.push(backupPlistPath);
  await writeSecurePlist(
    monitorPlistPath,
    buildMonitorPlist({ ...common, label: MONITOR_LABEL, programPath: monitorPath })
  );
  createdPaths.push(monitorPlistPath);
  await run('launchctl', ['bootstrap', domain, backupPlistPath]);
  loadedLabels.push(BACKUP_LABEL);
  await run('launchctl', ['bootstrap', domain, monitorPlistPath]);
  loadedLabels.push(MONITOR_LABEL);
} catch (error) {
  for (const label of loadedLabels.reverse()) {
    await run('launchctl', ['bootout', `${domain}/${label}`]).catch(() => undefined);
  }
  for (const filePath of createdPaths.reverse()) await unlink(filePath).catch(() => undefined);
  throw error;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      backupLabel: BACKUP_LABEL,
      monitorLabel: MONITOR_LABEL,
      schedule: '每小时 05、20、35、50 分钟',
      monitorIntervalSeconds: 300,
      output: '/dev/null',
      checkout: checkoutPath
    },
    null,
    2
  )
);

function buildBackupPlist({
  label,
  programPath,
  checkoutPath: cwd,
  environmentPath: pathValue,
  nodeProgramPath,
  postgresBinDirectory
}) {
  const intervals = BACKUP_MINUTES.map(
    (minute) => `    <dict><key>Minute</key><integer>${minute}</integer></dict>`
  ).join('\n');
  return plistDocument({
    label,
    programPath,
    checkoutPath: cwd,
    environmentPath: pathValue,
    nodeProgramPath,
    postgresBinDirectory,
    schedule: `<key>StartCalendarInterval</key>\n  <array>\n${intervals}\n  </array>`
  });
}

function buildMonitorPlist({
  label,
  programPath,
  checkoutPath: cwd,
  environmentPath: pathValue,
  nodeProgramPath,
  postgresBinDirectory
}) {
  return plistDocument({
    label,
    programPath,
    checkoutPath: cwd,
    environmentPath: pathValue,
    nodeProgramPath,
    postgresBinDirectory,
    schedule: '<key>StartInterval</key><integer>300</integer>'
  });
}

function plistDocument({
  label,
  programPath,
  checkoutPath: cwd,
  environmentPath,
  nodeProgramPath,
  postgresBinDirectory,
  schedule
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeProgramPath)}</string>
    <string>${escapeXml(programPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(environmentPath)}</string>
    <key>POSTGRES_BACKUP_BIN_DIR</key><string>${escapeXml(postgresBinDirectory)}</string>
  </dict>
  ${schedule}
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`;
}

async function validateRegularFile(filePath, mustBePrivate) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`安装所需路径不是普通文件：${path.basename(filePath)}`);
  }
  if (mustBePrivate) {
    if (metadata.uid !== process.getuid()) throw new Error('备份凭据文件不属于当前用户');
    if ((metadata.mode & 0o077) !== 0) throw new Error('备份凭据文件权限过宽');
  }
}

async function resolveStableNodeProgram() {
  const stablePath = path.join(homedir(), '.local', 'bin', 'node');
  try {
    const metadata = await lstat(stablePath);
    if (metadata.isFile() || metadata.isSymbolicLink()) return stablePath;
  } catch {
    // 没有稳定入口时才退回当前 Node 绝对路径。
  }
  return process.execPath;
}

async function assertPathMissing(filePath) {
  try {
    await lstat(filePath);
    throw new Error(`launchd 配置已存在，拒绝覆盖：${path.basename(filePath)}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function assertReplaceablePlist(filePath, expectedLabel, expectedProgramPath) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`拒绝替换非普通 launchd 文件：${path.basename(filePath)}`);
  }
  const source = await readFile(filePath, 'utf8');
  if (
    !source.includes(`<string>${escapeXml(expectedLabel)}</string>`) ||
    !source.includes(escapeXml(expectedProgramPath))
  ) {
    throw new Error(`拒绝替换不属于当前项目的 launchd 文件：${path.basename(filePath)}`);
  }
}

async function assertLabelNotLoaded(serviceTarget) {
  const result = await run('launchctl', ['print', serviceTarget], { acceptFailure: true });
  if (result.code === 0) throw new Error(`launchd 服务已加载，拒绝重复安装：${serviceTarget}`);
}

async function writeSecurePlist(filePath, value) {
  await writeFile(filePath, value, { flag: 'wx', mode: 0o600 });
  await chmod(filePath, 0o600);
}

function parseArgs(values) {
  const result = { checkout: undefined, replace: false };
  for (const value of values) {
    if (value.startsWith('--checkout=')) result.checkout = value.slice('--checkout='.length);
    else if (value === '--replace') result.replace = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!result.checkout) throw new Error('必须提供 checkout 绝对路径');
  return result;
}

function ignoreMissingFile(error) {
  if (error?.code !== 'ENOENT') throw error;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(command, arguments_, { acceptFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!signal && (code === 0 || acceptFailure)) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} 执行失败：${stderr.trim().slice(-500)}`));
    });
  });
}
