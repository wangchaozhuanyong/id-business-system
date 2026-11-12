import { createHash } from 'node:crypto';

const signature = item => createHash('sha256').update(JSON.stringify([
  item.id, item.provider, item.email, item.appPassword || ''
])).digest('hex');
const unavailable = () => Object.assign(new Error('邮件更新连接暂不可用'), { status: 503 });

// Reuse each mailbox's authenticated IMAP listener across viewers. The browser
// receives an opaque counter only; all credentials and mail reads stay server-side.
export function createMailboxUpdates({ store, watchMailbox, clock = Date.now }) {
  const sources = new Map(), clients = new Set();
  let closed = false;
  function release(source) {
    if (source.clients.size) return;
    source.controller.abort();
    source.handle?.close();
    if (sources.get(source.key) === source) sources.delete(source.key);
  }
  async function handle(request, response, code, item) {
    if (closed || !watchMailbox || clients.size >= 40) throw unavailable();
    const key = signature(item);
    let source = sources.get(key);
    if (!source) {
      if (sources.size >= 3) throw unavailable();
      source = { key, clients: new Set(), controller: new AbortController(), version: 0 };
      sources.set(key, source);
      source.ready = Promise.resolve().then(() => watchMailbox(item, {
        signal: source.controller.signal,
        onChange() {
          source.version++;
          for (const client of [...source.clients]) client.send('changed');
        },
        onError(error) {
          for (const client of [...source.clients]) client.close(error.code === 'AUTH_REJECTED' ? 'authorization' : 'connection');
        }
      })).then(handle => {
        source.handle = handle;
        if (!source.clients.size) release(source);
        return handle;
      });
    }
    let ended = false, started = false, heartbeat, expiry, unsubscribe;
    const valid = () => {
      const latest = store.findManagedMailbox(code, clock());
      return latest && signature(latest) === key;
    };
    function close(reason) {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat); clearTimeout(expiry);
      unsubscribe?.();
      response.removeListener?.('close', onClose);
      request.removeListener?.('aborted', onClose);
      source.clients.delete(client); clients.delete(client);
      release(source);
      if (started && !response.destroyed) {
        if (reason) response.write(`event: stopped\ndata: ${JSON.stringify({ reason })}\n\n`);
        response.end();
      } else if (reason && !response.destroyed) {
        response.writeHead(reason === 'authorization' ? 404 : 503, {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store'
        });
        response.end(JSON.stringify({ error: reason === 'authorization' ? '邮件查询码无效或已过期' : '邮件更新连接暂不可用' }));
      }
    }
    const onClose = () => close();
    function send(event) {
      if (ended || !started) return;
      if (!valid()) return close('authorization');
      if (!response.write(`event: ${event}\ndata: {"version":${source.version}}\n\n`)) close();
    }
    const client = { close, send };
    clients.add(client); source.clients.add(client);
    response.once?.('close', onClose);
    request.once?.('aborted', onClose);
    function checkExpiry() {
      if (ended) return;
      const latest = store.findManagedMailbox(code, clock());
      if (!latest || signature(latest) !== key) return close('authorization');
      clearTimeout(expiry);
      const remaining = Date.parse(latest.expiresAt) - clock();
      if (Number.isFinite(remaining)) {
        if (remaining <= 0) return close('authorization');
        expiry = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
        expiry.unref?.();
      }
    }
    unsubscribe = store.subscribeChanges?.(checkExpiry);
    checkExpiry();
    try {
      await source.ready;
      if (ended || response.destroyed) return;
      if (!valid()) throw Object.assign(new Error('邮件查询码无效或已过期'), { status: 404 });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store',
        'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff'
      });
      started = true;
      response.flushHeaders?.();
      send('ready');
      if (!ended) {
        // A transport comment keeps proxies alive. It never reads or refreshes mail.
        heartbeat = setInterval(() => { if (!response.write(': keepalive\n\n')) close(); }, 20_000);
        heartbeat.unref?.();
      }
    } catch (error) {
      const disconnected = ended || response.destroyed;
      close();
      if (disconnected) return;
      if (error.code === 'IDLE_UNSUPPORTED') throw Object.assign(new Error('此邮箱服务尚不支持新邮件通知，请使用立即刷新'), { status: 409 });
      if (error.code === 'AUTH_REJECTED') throw Object.assign(new Error('邮箱授权已失效，请联系管理员核对'), { status: 403 });
      throw error.status ? error : unavailable();
    }
  }
  return { handle, close() { closed = true; for (const client of [...clients]) client.close('connection'); } };
}
