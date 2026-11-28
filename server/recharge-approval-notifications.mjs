import { createHash } from 'node:crypto';

// Read the authoritative pending queue after a real task change or reconnect. Notification
// delivery and its retries are independent of the executor and order reconciliation.
export function createApprovalNotifications({ list, observe, publish }) {
  let version = '0', running, queued, retry, failures = 0, closed = false;
  async function collect() {
    queued = true;
    if (closed || running) return running;
    running = (async () => {
      while (queued && !closed) {
        queued = false;
        try {
          const { items } = await list();
          if (closed) return;
          if (!Array.isArray(items)) throw new Error('未取得待确认付款清单');
          const pending = items.filter(row => row.expires > Date.now());
          const next = createHash('sha256').update(pending.map(row => row.id).sort().join(',')).digest('hex');
          if (next !== version) {
            observe(pending.map(({ id }) => ({ scope: id, status: 'bad', code: 'recharge_approval' })));
            version = next; publish();
          }
          failures = 0; clearTimeout(retry);
        } catch {
          clearTimeout(retry);
          if (!closed && ++failures <= 4) retry = setTimeout(collect, 1000 * 2 ** failures).unref();
        }
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { collect, version: () => version, close() { closed = true; clearTimeout(retry); } };
}
