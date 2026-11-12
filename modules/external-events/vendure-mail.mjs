const invalid = () => new Error('mail_event_stream_unavailable');

// Consumer of Vendure's existing IcloudMailStreamController protocol. Caller
// must validate the local binding and query capability before starting and on
// reconciliation. No route or production configuration is installed here.
export async function consumeVendureMail({ shopUrl, queryCode, cursor, signal,
  onChange, onCursor, fetchImpl = fetch }) {
  const shop = new URL(shopUrl);
  if (!['http:', 'https:'].includes(shop.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(shop.hostname) ||
      shop.username || shop.password || shop.search || shop.hash ||
      typeof queryCode !== 'string' || !/^(BUY|MSTR)-[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/i.test(queryCode) ||
      (cursor !== undefined && !/^\d{1,20}$/.test(cursor))) throw invalid();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let deadline = setTimeout(() => controller.abort(), 20_000);
  let reader;
  try {
    const response = await fetchImpl(new URL('/storefront-realtime/mail-events', shop.origin), {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: combined,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ queryCode, ...(cursor !== undefined && { cursor }) })
    });
    clearTimeout(deadline);
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream'))
      throw invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder(), seen = new Set();
    let buffer = '', ready = false;
    while (!combined.aborted) {
      // The source advertises 15s heartbeats. This timeout detects a dead
      // transport; it never queries mail or generates a refresh notification.
      deadline = setTimeout(() => controller.abort(), 45_000);
      const { done, value } = await reader.read();
      clearTimeout(deadline);
      if (done) throw invalid();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 16384) throw invalid();
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: ?(.+)$/m.exec(frame)?.[1];
        if (!event) continue;
        const data = JSON.parse(/^data: ?(.+)$/m.exec(frame)?.[1] || '{}');
        if (['access-denied', 'unavailable'].includes(event)) throw invalid();
        if (event === 'ready') {
          if (ready || data.version !== 1 || !/^\d{1,20}$/.test(data.cursor) || data.reconcile !== true) throw invalid();
          ready = true;
          await onChange();
          await onCursor?.(data.cursor);
        } else if (event === 'reconcile') {
          if (!ready) throw invalid();
          await onChange();
        } else if (event === 'mail') {
          if (!ready || typeof data.eventId !== 'string' ||
              !/^[a-f0-9-]{36}$/i.test(data.eventId) || !/^\d{1,20}$/.test(data.cursor)) throw invalid();
          if (seen.has(data.eventId)) continue;
          // IDs can commit out of cursor order; deduplicate event identity only.
          await onChange();
          seen.add(data.eventId);
          if (seen.size > 256) seen.delete(seen.values().next().value);
          await onCursor?.(data.cursor);
        }
      }
    }
    combined.throwIfAborted();
  } catch {
    throw invalid(); // Never surface a query code, response body or service URL.
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}
