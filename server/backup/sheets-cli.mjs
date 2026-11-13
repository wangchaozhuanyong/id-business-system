import { watch } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { privateBackupFile } from './cloud-worker.mjs';
import { openReportSource } from './sheets-source.mjs';
import { createBusinessSheets, createReportSync } from './sheets-sync.mjs';
import { createWorkerReceipt } from '../monitoring-worker-receipts.mjs';

const normalDelay = 3_000;
const safeMessage = (error) => /^[A-Z][A-Z0-9_]{3,70}$/.test(error?.message) ?
  error.message : 'SHEETS_SYNC_FAILED';
const integrityErrors = new Set(['SHEETS_HEADER_MISMATCH', 'SHEETS_TAB_MISSING', 'SHEETS_TARGET_INVALID',
  'SHEETS_TARGET_NOT_PRIVATE', 'SHEETS_SOURCE_KEY_INVALID', 'SHEETS_SOURCE_REPLACED']);
let report;
let source;
let watcher;
let wake;

async function waitForChange(ms, shutdown, listen) {
  const idle = new AbortController();
  let sawChange = false;
  const stop = () => idle.abort();
  if (listen) wake = () => { sawChange = true; stop(); };
  shutdown.addEventListener('abort', stop, { once: true });
  try {
    await delay(ms, undefined, { signal: idle.signal });
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    wake = undefined;
    shutdown.removeEventListener('abort', stop);
  }
  if (sawChange && !shutdown.aborted) {
    // A journal event can arrive shortly before the transaction is committed.
    await delay(200, undefined, { signal: shutdown }).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  }
}

try {
  const [mode, flag, configPath, ...extra] = process.argv.slice(2);
  if (!['run', 'once'].includes(mode) || flag !== '--config' || !configPath || extra.length)
    throw new Error('SHEETS_ARGUMENTS_INVALID');
  const config = JSON.parse(await privateBackupFile(configPath, 32_768));
  report = createWorkerReceipt(process.env.ID_MONITOR_WORKER_RECEIPTS_DIR, 'sheets', config.dataDir);
  source = await openReportSource(config.dataDir);
  const sync = createReportSync({ source, destination: createBusinessSheets(config),
    now: () => performance.now(), minInterval: normalDelay });
  if (mode === 'run') {
    try {
      watcher = watch(config.dataDir, { persistent: false }, (_, name) => {
        if (!name || /^local-business\.sqlite(?:-(?:journal|wal|shm))?$/.test(name)) wake?.();
      });
      watcher.on('error', () => watcher.close());
    } catch {
      // Timed checks remain available when filesystem notifications cannot be installed.
    }
  }
  const shutdown = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
  let failures = 0;
  let integrityFailure = false;
  do {
    try {
      const result = await sync.tick();
      if (result) {
        process.stdout.write(JSON.stringify({ status: 'verified', ...result }) + '\n');
        integrityFailure = false;
      }
      failures = 0;
      if (mode === 'run') await report({ verified: Boolean(result), integrityFailure });
    } catch (error) {
      if (mode === 'once' || error.message === 'SHEETS_SOURCE_REPLACED') throw error;
      failures = Math.min(failures + 1, 7);
      const code = safeMessage(error);
      const integrity = integrityErrors.has(code);
      integrityFailure ||= integrity;
      process.stderr.write(JSON.stringify({ status: integrity ? 'integrity-failed' : 'retry', code }) + '\n');
      await report({ failures, integrityFailure });
    }
    if (mode === 'run' && !shutdown.signal.aborted) {
      await waitForChange(normalDelay * 2 ** failures, shutdown.signal, failures === 0);
    }
  } while (mode === 'run' && !shutdown.signal.aborted);
} catch (error) {
  const code = safeMessage(error);
  if (integrityErrors.has(code)) {
    process.stderr.write(JSON.stringify({ status: 'integrity-failed', code }) + '\n');
    await report?.({ failures: 1, integrityFailure: true });
  } else process.stderr.write(code + '\n');
  process.exitCode = 1;
} finally {
  watcher?.close();
  source?.close();
}
