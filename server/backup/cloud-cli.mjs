import { parseArgs } from 'node:util';
import { createWorkerReceipt } from '../monitoring-worker-receipts.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrivateKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { unpackSnapshot } from './cloud-archive.mjs';
import { createBackupDrive } from './cloud-drive.mjs';
import { createCloudBackupWorker, privateBackupFile } from './cloud-worker.mjs';

const usage = [
  'node server/backup/cloud-cli.mjs preflight --config <私有配置文件>',
  'node server/backup/cloud-cli.mjs run --config <私有配置文件>',
  'node server/backup/cloud-cli.mjs unpack --input <加密归档> --output <新快照目录> --key <离线私钥>'
].join('\n');
const message = (error) => /^[A-Z][A-Z0-9_]{3,70}$/.test(error?.message) ? error.message : 'BACKUP_FAILED';

async function lockOutbox(outbox, shutdown) {
  if (typeof outbox !== 'string' || !isAbsolute(outbox)) throw new Error('BACKUP_OUTBOX_INVALID');
  const directory = await lstat(outbox);
  if (!directory.isDirectory() || directory.uid !== process.getuid() ||
      (directory.mode & 0o777) !== 0o700 || await realpath(outbox) !== outbox)
    throw new Error('BACKUP_OUTBOX_INVALID');
  const path = join(outbox, '.worker.lock');
  await open(path, 'wx', 0o600).then((file) => file.close()).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error('BACKUP_LOCK_INVALID');
  const child = spawn('flock', ['-n', path, 'cat'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const fail = () => {
        clearTimeout(timeout);
        shutdown.abort();
        reject(new Error('BACKUP_LOCK_UNAVAILABLE'));
      };
      const timeout = setTimeout(fail, 3000);
      child.once('error', fail);
      child.once('close', fail);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output === 'locked\n') { clearTimeout(timeout); resolve(); }
        else if (!'locked\n'.startsWith(output)) fail();
      });
      child.stdin.write('locked\n');
    });
    return child;
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
}

async function run(config) {
  const drive = createBackupDrive(config);
  if (config.mode === 'preflight') {
    await drive.preflight();
    process.stdout.write('{"driveFolderVerified":true}\n');
    return;
  }
  const recipient = await privateBackupFile(config.recipientFile, 16_384);
  const report = createWorkerReceipt(process.env.ID_MONITOR_WORKER_RECEIPTS_DIR, 'backup', config.dataDir);
  const shutdown = new AbortController();
  const lock = await lockOutbox(config.outbox, shutdown);
  let worker;
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown.abort());
  let failures = 0;
  try {
    worker = await createCloudBackupWorker({ ...config, recipient, drive,
      guard: () => shutdown.signal.throwIfAborted() });
    while (!shutdown.signal.aborted) {
      try {
        const result = await worker.tick();
        if (result.captured) process.stdout.write(JSON.stringify({ status: 'verified', ...result }) + '\n');
        failures = 0;
        await report({ verified: result.captured });
      } catch (error) {
        failures = Math.min(failures + 1, 6);
        process.stderr.write(JSON.stringify({ status: 'retry', code: message(error) }) + '\n');
        await report({ failures, integrityFailure: ['BACKUP_PENDING_DIGEST_MISMATCH', 'BACKUP_CHECKPOINT_INVALID',
          'BACKUP_PENDING_FILE_MISSING'].includes(error.message) });
      }
      await delay(5000 * 2 ** failures, undefined, { signal: shutdown.signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  } finally {
    worker?.close();
    lock.stdin.end();
  }
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
    key: { type: 'string' }, help: { type: 'boolean' }
  } });
  const [mode] = positionals;
  if (values.help && positionals.length === 0 && Object.keys(values).length === 1) {
    process.stdout.write(usage + '\n');
  } else if (positionals.length === 1 && ['run', 'preflight'].includes(mode) &&
      values.config && Object.keys(values).length === 1) {
    const config = JSON.parse(await privateBackupFile(values.config, 32_768));
    await run({ ...config, mode });
  } else if (positionals.length === 1 && mode === 'unpack' && values.input && values.output &&
      values.key && Object.keys(values).length === 3) {
    const key = createPrivateKey(await privateBackupFile(values.key, 16_384));
    process.stdout.write(JSON.stringify(await unpackSnapshot({ ...values, key })) + '\n');
  } else {
    throw new Error('BACKUP_ARGUMENTS_INVALID');
  }
} catch (error) {
  process.stderr.write(message(error) + '\n');
  process.exitCode = 1;
}
