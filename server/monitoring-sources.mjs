import { statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { beijingDay, monitorPath } from './monitoring-policy.mjs';
import { projectRechargeMonitoring } from './monitoring-recharge.mjs';
import { readBackupMonitorReceipt, readWorkerReceipt, sheetsReceiptMaxAge } from './monitoring-worker-receipts.mjs';
import { managedMailboxQueryRoute, storefrontMailboxQueryRoute } from './tools/mailbox-pool.mjs';

const minute = 60_000;
const day = 24 * 60 * minute;
const orderSyncTimeout = 10 * minute;
const mailboxPaths = new Set([managedMailboxQueryRoute, storefrontMailboxQueryRoute, '/api/local/apple-relay/public-query']);
const privateReads = new Set(['/api/local/saved-totp/secret', '/api/local/subscription-card-reveal',
  '/api/local/subscription-card-copy']);

function counter(map, at) {
  const cutoff = Math.floor(at / minute);
  if (!map.has(cutoff)) map.set(cutoff, { total: 0, failures: 0 });
  for (const key of map.keys()) if (key < cutoff - 9) map.delete(key);
  return map.get(cutoff);
}
function counts(map, at, length = 10) {
  const cutoff = Math.floor(at / minute) - length + 1;
  const total = { total: 0, failures: 0 };
  for (const [key, row] of map) if (key >= cutoff) {
    total.total += row.total;
    total.failures += row.failures;
  }
  return total;
}

export function createMonitoringSources({ monitor, databasePath, externalProbe = false, runtimeProbe, rechargeClient,
  getFinance, syncEnabled, syncViaEvents = false, workerReceiptDirectory, backupReceiptDirectory, clock = Date.now,
  readDisk = statfs, readReceipt = readWorkerReceipt, readBackupReceipt = readBackupMonitorReceipt }) {
  const startedAt = clock();
  const dataDirectory = dirname(databasePath);
  const workerReports = typeof workerReceiptDirectory === 'string' && isAbsolute(workerReceiptDirectory) &&
    resolve(workerReceiptDirectory) !== resolve(dataDirectory);
  const backupReports = typeof backupReceiptDirectory === 'string' && isAbsolute(backupReceiptDirectory) &&
    resolve(backupReceiptDirectory) !== resolve(dataDirectory);
  const api = new Map(), mailbox = new Map(), logins = new Map(), privateAccess = new Map();
  const refusals = new Map();
  let orderSync = { failures: 0, at: null };
  let orderReader = { state: 'waiting', at: startedAt };
  let timer, deliveryTimer, active = false, closed = false;
  let lastDigest;

  function recordHttp(path, status, actor) {
    const now = clock();
    if (path.startsWith('/api/local/') && path !== monitorPath && (status < 400 || status >= 500)) {
      const row = counter(api, now);
      row.total++;
      if (status >= 500) row.failures++;
    }
    if (mailboxPaths.has(path) && (status < 400 || status >= 500)) {
      const row = counter(mailbox, now);
      row.total++;
      if (status >= 500) row.failures++;
    }
    if (actor && status >= 200 && status < 300 && (privateReads.has(path) ||
        /^\/integrations\/codexdaichong\/api\/admin\/(?:sessions\/[a-zA-Z0-9_-]+|cards)(?:\/)?$/.test(path))) {
      if (privateAccess.size < 1000 || privateAccess.has(actor.id)) {
        if (!privateAccess.has(actor.id)) privateAccess.set(actor.id, new Map());
        counter(privateAccess.get(actor.id), now).total++;
      }
    }
  }

  function recordAuth(event) {
    const now = clock();
    if (event.kind === 'admin_access') {
      try { monitor.observe([{ code: 'admin_access', scope: randomUUID(), status: 'bad' }]); } catch {}
      return;
    }
    const bucket = counter(logins, now);
    bucket.total++;
    if (event.kind === 'limited') bucket.failures++;
    bucket.accounts ??= new Map();
    if (event.accountKey && (bucket.accounts.size < 2000 || bucket.accounts.has(event.accountKey)))
      bucket.accounts.set(event.accountKey, (bucket.accounts.get(event.accountKey) ?? 0) + 1);
  }

  function recordRecharge(outcome) {
    if (!['recharge_cards', 'recharge_route'].includes(outcome)) return;
    if (outcome === 'recharge_cards' && monitor.legacyStatus().phase !== 'managed') return;
    const now = clock();
    const window = Math.floor(now / (15 * minute));
    const previous = refusals.get(outcome);
    refusals.set(outcome, { code: outcome, scope: 'window-' + window, status: 'bad',
      count: previous?.window === window ? previous.count + 1 : 1, at: now, window });
  }

  function recordOrderSync(success) {
    orderSync = { failures: success ? 0 : orderSync.failures + 1, at: clock() };
  }

  function recordOrderSyncReader(state) {
    if (state === 'connected' || orderReader.state !== state) orderReader = { state, at: clock() };
  }

  function orderSyncSample(now) {
    const sample = (status, reason) => ({ code: 'order_sync', status, count: orderSync.failures, reason });
    if (!syncEnabled) return sample('disabled', 'sync_disabled');
    if (syncViaEvents) {
      if (orderReader.state === 'review') return sample('bad', 'sync_reader_review');
      if (now - orderReader.at > orderSyncTimeout) return sample('bad', 'sync_reader_stale');
    } else if (!orderSync.at) return sample('unknown', 'sync_missing');
    if (orderSync.at && (!syncViaEvents || orderSync.failures) && now - orderSync.at > orderSyncTimeout)
      return sample('bad', 'sync_stale');
    if (orderSync.failures >= 3) return sample('bad');
    if (syncViaEvents && orderReader.state !== 'connected') return sample('unknown', 'sync_reader_waiting');
    if (orderSync.failures) return sample('unknown', 'recovering');
    return sample('ok', syncViaEvents ? 'sync_reader_active' : undefined);
  }

  function usageSamples(now) {
    const apiWindow = counts(api, now);
    const mailboxWindow = counts(mailbox, now);
    const accounts = new Map();
    for (const [bucket, row] of logins) if (bucket >= Math.floor(now / minute) - 4) {
      for (const [key, count] of row.accounts ?? []) accounts.set(key, (accounts.get(key) ?? 0) + count);
    }
    const attempts = counts(logins, now, 5);
    const maxAttempts = Math.max(0, ...accounts.values());
    const access = Math.max(0, ...[...privateAccess.values()].map(window => counts(window, now).total));
    for (const [id, window] of privateAccess) if (!counts(window, now).total) privateAccess.delete(id);
    return [
      { code: 'api_errors', status: apiWindow.total < 50 ? 'unknown' :
        apiWindow.failures >= 5 && apiWindow.failures / apiWindow.total >= 0.05 ? 'bad' : 'ok', count: apiWindow.failures,
      reason: apiWindow.total < 50 ? 'insufficient_requests' : undefined },
      { code: 'mailbox', status: mailboxWindow.failures >= 3 ? 'bad' :
        mailboxWindow.total - mailboxWindow.failures >= 2 && mailboxWindow.failures === 0 ? 'ok' : 'unknown', count: mailboxWindow.failures,
      reason: mailboxWindow.failures < 3 && (mailboxWindow.failures || mailboxWindow.total < 2) ? 'mailbox_samples' : undefined },
      { code: 'login_abuse', status: maxAttempts >= 5 || attempts.failures >= 12 ? 'bad' : 'ok',
        count: maxAttempts >= 5 ? maxAttempts : attempts.failures },
      { code: 'sensitive_reads', status: access >= 20 ? 'bad' : 'ok', count: access }
    ];
  }

  async function background(now) {
    const results = await Promise.allSettled([
      readDisk(dataDirectory), workerReports && !backupReports && readReceipt(workerReceiptDirectory, 'backup'),
      workerReports && readReceipt(workerReceiptDirectory, 'sheets'),
      backupReports && readBackupReceipt(backupReceiptDirectory)
    ]);
    const [disk, backup, sheets, report] = results.map(row => row.status === 'fulfilled' ? row.value : null);
    const available = disk && disk.blocks > 0 ? Math.round(100 * disk.bavail / disk.blocks) : null;
    const job = (code, receipt, stale, configured = workerReports) => ({ code, status: !configured ? 'disabled' :
      !receipt || receipt.at > now + minute ? 'unknown' :
      receipt.integrityFailure || receipt.failures >= 3 || now - receipt.at > stale ? 'bad' :
        receipt.verifiedAt && receipt.failures === 0 ? 'ok' : 'unknown', count: receipt?.failures,
      reason: !configured ? 'receipt_disabled' : !receipt ? 'receipt_missing' :
        receipt.at > now + minute ? 'receipt_future' : receipt.integrityFailure ? 'integrity_failed' :
        now - receipt.at > stale ? 'receipt_stale' : !receipt.verifiedAt ? 'verification_missing' :
        receipt.failures > 0 && receipt.failures < 3 ? 'recovering' : undefined });
    const output = [
      { code: 'disk_space', status: available === null ? 'unknown' : available < 15 ? 'bad' : 'ok', count: available,
        reason: available === null ? 'disk_unavailable' : undefined },
      job('sheets', sheets, sheetsReceiptMaxAge),
      orderSyncSample(now)
    ];
    if (!backupReports) {
      output.push(job('backup', backup, 20 * minute),
        { code: 'recharge_backup', status: 'disabled', reason: 'receipt_disabled' });
    } else if (!report || report.at > now + minute || now - report.at > 3 * minute) {
      for (const code of ['backup', 'recharge_backup'])
        output.push({ code, status: 'bad', reason: 'backup_collector_unavailable' });
    } else {
      const drive = report.drive;
      output.push(drive ? job('backup', drive, 20 * minute, true) :
        { code: 'backup', status: 'bad', reason: 'receipt_missing' });
      const mysql = report.mysql;
      const age = mysql && now - mysql.capturedAt;
      const reason = !report.mysqlTimerActive ? 'mysql_timer_inactive' :
        report.mysqlAttemptFailed ? 'mysql_attempt_failed' :
        !mysql ? 'receipt_missing' :
        mysql.verifiedAt > now + minute ? 'receipt_future' :
        age > 35 * minute ? 'mysql_backup_stale' : undefined;
      output.push({ code: 'recharge_backup', status: reason ? 'bad' : 'ok', reason,
        count: mysql ? Math.max(0, Math.floor(age / minute)) : undefined });
    }
    try {
      const finance = getFinance?.()?.read()?.data;
      const enabled = finance?.settings.enabled && finance.settings.provider !== 'disabled';
      output.push({ code: 'exchange_rates', status: !enabled ? 'disabled' : finance.state.failures >= 3 ? 'bad' :
        finance.state.failures === 0 && finance.state.lastSuccessAt ? 'ok' : 'unknown', count: finance?.state.failures,
        reason: !enabled ? 'rates_disabled' : finance.state.failures > 0 && finance.state.failures < 3 ? 'recovering' :
          !finance.state.lastSuccessAt && finance.state.failures < 3 ? 'rates_missing' : undefined });
    } catch { output.push({ code: 'exchange_rates', status: 'unknown', reason: 'rates_unavailable' }); }
    return output;
  }

  async function recharge(now) {
    if (!runtimeProbe) return ['recharge_runtime', 'recharge_review', 'recharge_stuck', 'recharge_burst']
      .map(code => ({ code, status: 'disabled', reason: 'runtime_disabled' }));
    const [runtime, tasks] = await Promise.allSettled([runtimeProbe(), rechargeClient.get('/api/admin/task-logs?limit=200')]);
    const result = [{ code: 'recharge_runtime', status: runtime.status === 'fulfilled' && runtime.value.ready ? 'ok' : 'bad' }];
    for (const code of ['recharge_cards', 'recharge_route']) {
      const row = refusals.get(code);
      if (row && now - row.at < 15 * minute) result.push(row);
    }
    if (tasks.status === 'rejected' || !Array.isArray(tasks.value?.tasks)) return [...result,
      ...['recharge_review', 'recharge_stuck', 'recharge_burst']
        .map(code => ({ code, status: 'unknown', reason: 'tasks_unavailable' }))];
    const projection = projectRechargeMonitoring(tasks.value.tasks, now, monitor.legacyStatus().since);
    const output = [...result, ...projection.samples];
    for (const code of ['recharge_review', 'recharge_stuck']) if (!projection.samples.some(row => row.code === code))
      output.push({ code, status: 'unknown', reason: projection.complete ? 'tasks_empty' : 'tasks_incomplete' });
    const dayKey = beijingDay(now - day);
    if (projection.complete && lastDigest !== dayKey && new Date(now + 8 * 60 * minute).getUTCHours() >= 9) {
      const cohort = projection.rows.filter(row => beijingDay(row.createdAt) === dayKey);
      if (cohort.every(row => row.review || ['success', 'failed'].includes(row.status))) {
        output.push({ code: 'digest', scope: dayKey, status: 'bad', summary: {
          success: cohort.filter(row => row.status === 'success').length,
          failure: cohort.filter(row => row.status === 'failed').length,
          review: cohort.filter(row => row.review).length,
          open: monitor.activeCount()
        } });
      }
    }
    return output;
  }

  async function tick() {
    if (active || closed) return;
    active = true;
    try {
      const now = clock();
      const site = monitor.probeAt();
      const output = usageSamples(now);
      if (!externalProbe || now - (site || startedAt) > 4 * minute || !site)
        output.push({ code: 'external_probe', status: !externalProbe ? 'disabled' :
          now - (site || startedAt) > 4 * minute ? 'bad' : 'unknown',
          reason: !externalProbe ? 'probe_disabled' : now - (site || startedAt) > 4 * minute ? 'probe_stale' : 'probe_missing' });
      if (!externalProbe || !site) for (const code of ['public_site', 'tls_expiry'])
        output.push({ code, status: 'unknown', reason: !externalProbe ? 'probe_disabled' : 'probe_missing' });
      const results = await Promise.allSettled([background(now), recharge(now)]);
      for (const result of results) if (result.status === 'fulfilled') output.push(...result.value);
      if (closed) return;
      monitor.observe(output);
      lastDigest = output.find(item => item.code === 'digest')?.scope || lastDigest;
    } finally { active = false; }
  }

  return { recordHttp, recordAuth, recordRecharge, recordOrderSync, recordOrderSyncReader, tick,
    start() {
      if (closed || timer) return;
      const collect = () => void tick().catch(() => {});
      collect();
      timer = setInterval(collect, minute);
      deliveryTimer = setInterval(() => void monitor.dispatch().catch(() => {}), 2000);
      timer.unref();
      deliveryTimer.unref();
    },
    close() { closed = true; clearInterval(timer); clearInterval(deliveryTimer); }
  };
}
