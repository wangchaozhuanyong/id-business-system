import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { consumeCommittedJobs } from '../modules/external-events/committed-jobs.mjs';
import { financeReconciliation } from '../modules/website/pages.mjs';

const actor = { id: 'event-runtime', role: 'super' };
const localScopes = ['settings', 'recharge-codes', 'inventory', 'finance-rates', 'card-types'];
async function* envelopes(stream) {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    if (buffer.length > 128 * 1024) throw new Error('event_frame_too_large');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      yield JSON.parse(line);
    }
  }
  if (buffer) throw new Error('event_frame_incomplete');
}

// The child reads MySQL only. The parent alone owns business writes and ACKs.
// Timers retry a broken transport; they never poll the source for business data.
export function createRechargeEvents({ config, store, orderSync, activity, onReaderStatus,
  spawnProcess = spawn, schedule = setTimeout, cancel = clearTimeout }) {
  let child, reconnect, stopped = false, started = false, retry = 0, unsubscribe;
  let work = Promise.resolve(), localQueued = false, observed;
  const versions = new Map();
  const controller = new AbortController();
  const source = { ...config, sinceEpochSeconds: orderSync.eventBoundary() };
  delete source.pythonPath; delete source.checkpointPath;
  const fingerprint = () => {
    const all = store.changeVersions(actor);
    return localScopes.map(scope => all[scope]).join(':');
  };
  function queue(operation) {
    const current = work.then(() => { controller.signal.throwIfAborted(); return operation(); });
    work = current.catch(() => {});
    return current;
  }
  async function changed(scopes, event) {
    await activity?.collect({ jobKeys: event.jobs, reconcile: event.reconcile, strict: true });
    // Only resources whose upstream rows actually committed receive a new
    // opaque revision. Activity retains its per-actor visibility filtering.
    const domains = new Set();
    if (scopes.includes('cdk_codes')) domains.add('recharge-codes');
    if (scopes.includes('billing_records')) domains.add(financeReconciliation.scope);
    if (scopes.some(scope => ['card_assets', 'orbitcard_card_usage', 'orbitcard_card_recharges'].includes(scope))) {
      domains.add('tenant-cards'); domains.add('card-types');
    }
    for (const domain of domains) versions.set(domain, event.receipt);
    if (domains.size) store.notifyChanges();
  }
  function wakeLocal() {
    const next = fingerprint();
    if (observed === next || stopped) return;
    observed = next;
    if (localQueued) return;
    localQueued = true;
    void queue(async () => {
      localQueued = false;
      const jobs = orderSync.pendingJobs();
      for (let index = 0; index < jobs.length; index += 6)
        await orderSync.runCommitted({ apply: true, jobKeys: jobs.slice(index, index + 6) });
      await activity?.collect({ jobKeys: [], reconcile: true, strict: true });
    }).catch(() => {
      onReaderStatus?.('reconnecting'); activity?.unavailable();
      // Force source reconnection and a catch-up pass after a failed local
      // reconciliation. The outstanding jobs remain in the durable store.
      child?.kill();
    });
  }
  function launch() {
    if (stopped) return;
    const process = spawnProcess('python3', ['-B', fileURLToPath(new URL('../modules/external-events/recharge_cdc.py', import.meta.url)),
      '--config-fd', config.checkpointPath], {
      env: { PATH: globalThis.process.env.PATH, PYTHONPATH: config.pythonPath, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });
    child = process;
    let fatal = false, ready = false, finished = false, stderr = '';
    function finish(code) {
      if (finished) return;
      finished = true;
      process.kill();
      if (child === process) child = undefined;
      if (stopped) return;
      const review = code === 2 || fatal;
      onReaderStatus?.(review ? 'review' : 'reconnecting');
      activity?.unavailable();
      if (review) return;
      reconnect = schedule(launch, [1000, 3000, 10_000, 30_000, 60_000][Math.min(retry++, 4)]);
      reconnect.unref?.();
    }
    process.once('error', () => finish(1));
    process.once('close', code => finish(code));
    process.stdin.on('error', () => {}); process.stdio[3].on('error', () => {});
    process.stderr.on('data', chunk => {
      if (finished) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > 1024) return finish(2);
      let end;
      while ((end = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, end); stderr = stderr.slice(end + 1);
        if (line === 'recharge_event_subscriber_review_required') fatal = true;
        if (line === 'recharge_event_subscriber_ready' && !ready && !fatal) {
          ready = true;
          // Reconnection also retries durable pending work once, without an
          // idle timer or a new source commit being required.
          observed = undefined; wakeLocal();
        }
        if (line === 'recharge_event_subscriber_heartbeat' && ready && !fatal)
          onReaderStatus?.('connected');
      }
    });
    process.stdio[3].end(JSON.stringify(source));
    void (async () => {
      for await (const event of envelopes(process.stdout)) {
        await queue(() => consumeCommittedJobs([event], {
          signal: controller.signal, run: command => orderSync.runCommitted(command),
          pendingJobs: () => orderSync.pendingJobs(), changed,
          acknowledge: receipt => new Promise((resolve, reject) => {
            if (finished || !process.stdin.writable) return reject(new Error('event_source_closed'));
            process.stdin.write(receipt + '\n', error => {
              if (error) reject(error);
              else { retry = 0; resolve(); }
            });
          })
        }));
      }
    })().catch(() => finish(1));
  }
  return {
    versions: () => Object.fromEntries(versions),
    start() {
      if (started || stopped) return;
      started = true; observed = fingerprint();
      unsubscribe = store.subscribeChanges(wakeLocal);
      launch();
    },
    close() {
      stopped = true; controller.abort(); unsubscribe?.(); cancel(reconnect); child?.kill();
    }
  };
}
