import { createHash } from 'node:crypto';
import { consumeVendureMail } from '../../modules/external-events/vendure-mail.mjs';

const unavailable = () => Object.assign(new Error('邮件更新连接暂不可用'), { status: 503 });
export const supportsRelayUpdates = code => /^(BUY|MSTR)-[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/i.test(code);

// One upstream connection per capability, with local binding checks before
// every notification. No credentials, mailbox IDs or mail content reach SSE.
export function createRelayMailUpdates({ shopUrl, authorize, identity, validLocal, subscribeChanges,
  fetchImpl, consume = consumeVendureMail, clock = Date.now }) {
  const sources = new Map(), clients = new Set();
  let closed = false;
  async function handle(request, response, code) {
    if (closed || !shopUrl || clients.size >= 40 || !supportsRelayUpdates(code)) throw unavailable();
    const target = await authorize(code);
    if (closed || response.destroyed) return;
    // The captured target must still be the same local binding after the
    // asynchronous capability authorization has completed.
    if (!await validLocal(target)) throw unavailable();
    if (clients.size >= 40) throw unavailable();
    const key = createHash('sha256').update(JSON.stringify([code, identity(target)])).digest('hex');
    let source = sources.get(key);
    if (!source) {
      if (sources.size >= 6) throw unavailable();
      source = { controller: new AbortController(), clients: new Set(), version: 0, ready: false };
      sources.set(key, source);
    }
    let ended = false, started = false, heartbeat, expiry, unsubscribe, checking = Promise.resolve();
    const stillValid = async () => (target.expiresAt == null || Date.parse(target.expiresAt) > clock()) &&
      await validLocal(target);
    function close(reason) {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat); clearTimeout(expiry); unsubscribe?.();
      response.removeListener?.('close', disconnect); request.removeListener?.('aborted', disconnect);
      clients.delete(client); source.clients.delete(client);
      if (!source.clients.size) {
        source.controller.abort();
        if (sources.get(key) === source) sources.delete(key);
      }
      if (!response.destroyed && !response.writableEnded) {
        if (started && reason) response.write(`event: stopped\ndata: ${JSON.stringify({ reason })}\n\n`);
        else if (!started && reason) {
          response.writeHead(reason === 'authorization' ? 403 : 503, {
            'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'
          });
          response.end(JSON.stringify({ error: reason === 'authorization' ? '查询授权已变化，请重新查询' : '邮件更新连接暂不可用' }));
          return;
        }
        response.end();
      }
    }
    const disconnect = () => close();
    function send(event) {
      checking = checking.then(async () => {
        if (ended) return;
        if (!await stillValid()) return close('authorization');
        if (ended || !source.ready) return;
        if (!started) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
          started = true;
          response.flushHeaders?.();
          event = 'ready';
          heartbeat = setInterval(() => { if (!response.write(': keepalive\n\n')) close(); }, 20_000);
          heartbeat.unref?.();
        }
        if (event && !response.write(`event: ${event}\ndata: {"version":${source.version}}\n\n`)) close();
      }).catch(() => close('authorization'));
      return checking;
    }
    const client = { send, close };
    clients.add(client); source.clients.add(client);
    response.once?.('close', disconnect); request.once?.('aborted', disconnect);
    unsubscribe = subscribeChanges?.(() => void send());
    function checkExpiry() {
      if (ended || target.expiresAt == null) return;
      const remaining = Date.parse(target.expiresAt) - clock();
      if (!Number.isFinite(remaining) || remaining <= 0) return close('authorization');
      expiry = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      expiry.unref?.();
    }
    checkExpiry();
    if (!source.task) {
      source.task = consume({ shopUrl, queryCode: code, signal: source.controller.signal, fetchImpl,
        async onChange() {
          source.ready = true; source.version++;
          await Promise.all([...source.clients].map(client => client.send('changed')));
        }
      }).catch(() => { for (const client of [...source.clients]) client.close('connection'); });
    }
    if (source.ready) await send('ready');
  }
  return { handle, close() { closed = true; for (const client of [...clients]) client.close('connection'); } };
}
