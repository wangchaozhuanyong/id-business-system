/** Transport-only SSE helpers; task stores remain the only source of business state. */
export function openProgressStream(res) {
  let closed = false;
  const cleanups = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const cleanup of cleanups) cleanup();
    if (!res.destroyed) res.end();
  };
  const write = value => {
    if (closed || res.destroyed) return close();
    try { if (!res.write(value)) close(); } catch { close(); }
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.once('close', close);
  res.once('error', close);
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
  const lifetime = setTimeout(close, 300_000);
  heartbeat.unref?.(); lifetime.unref?.();
  cleanups.add(() => { clearInterval(heartbeat); clearTimeout(lifetime); });
  write('event: ready\ndata: {"heartbeatIntervalMs":15000}\n\n');
  return {
    close,
    cleanup(fn) { if (closed) fn(); else cleanups.add(fn); },
    send(task) {
      write('event: task\ndata: ' + JSON.stringify(task) + '\n\n');
      if (['succeeded', 'failed', 'expired'].includes(task.status)) close();
    }
  };
}

export async function readProgressStream(body, onTask) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n');
    if (buffer.length > 65536) throw new Error('Progress frame too large');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (!frame.startsWith('event: task\n')) continue;
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      await onTask(JSON.parse(data));
    }
  }
}
