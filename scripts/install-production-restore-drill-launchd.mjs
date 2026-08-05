#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const LABEL = 'com.id-business-v2.monthly-restore-drill';
const args = parseArgs(process.argv.slice(2));
if (process.platform !== 'darwin') throw new Error('launchd 安装只允许在 macOS 执行');
const checkoutPath = await realpath(path.resolve(args.checkout));
const privateKeyPath = await realpath(path.resolve(args.privateKey));
const runnerPath = path.join(checkoutPath, 'scripts/run-monthly-production-restore-drill.mjs');
await realpath(runnerPath);
const reportDirectory = path.join(checkoutPath, 'backups/recovery-reports');
const runtimeDirectory = path.join(checkoutPath, '.runtime');
await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
const launchAgentsDirectory = path.join(homedir(), 'Library/LaunchAgents');
await mkdir(launchAgentsDirectory, { recursive: true });
const plistPath = path.join(launchAgentsDirectory, `${LABEL}.plist`);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(runnerPath)}</string>
    <string>--private-key=${escapeXml(privateKeyPath)}</string>
    <string>--report-dir=${escapeXml(reportDirectory)}</string>
    <string>--keychain-account=${escapeXml(args.keychainAccount)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(checkoutPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Day</key><integer>1</integer><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>${escapeXml(path.join(runtimeDirectory, 'monthly-restore-drill.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(runtimeDirectory, 'monthly-restore-drill.error.log'))}</string>
</dict>
</plist>
`;
await writeFile(plistPath, plist, { flag: 'wx', mode: 0o600 });
await chmod(plistPath, 0o600);
await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
console.log(
  JSON.stringify(
    { ok: true, label: LABEL, plist: plistPath, schedule: 'day 1 04:17 local' },
    null,
    2
  )
);

function parseArgs(values) {
  const result = {
    checkout: undefined,
    privateKey: undefined,
    keychainAccount: process.env.USER || 'production-operator'
  };
  for (const value of values) {
    if (value.startsWith('--checkout=')) result.checkout = value.slice('--checkout='.length);
    else if (value.startsWith('--private-key=')) {
      result.privateKey = value.slice('--private-key='.length);
    } else if (value.startsWith('--keychain-account=')) {
      result.keychainAccount = value.slice('--keychain-account='.length);
    } else throw new Error(`未知参数：${value}`);
  }
  if (!result.checkout || !result.privateKey) throw new Error('必须提供 checkout 和 private key');
  return result;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${command} 执行失败：${stderr.trim()}`));
    });
  });
}
