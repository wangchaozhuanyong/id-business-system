import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export const dataChangeRoute = '/api/local/change-events';

export async function dataSourceIdentity(databasePath) {
  if (databasePath === ':memory:') return randomUUID();
  const { dev, ino, birthtimeNs } = await stat(databasePath, { bigint: true });
  return createHash('sha256').update(`${dev}:${ino}:${birthtimeNs}`).digest('hex');
}

export function changedVersions(previous, next) {
  return Object.fromEntries(Object.entries(next).filter(([scope, version]) => previous[scope] !== version));
}

// Only scope revisions cross the stream. Business records and credentials stay
// behind their existing read endpoints and permissions.
export function createDataChangeStream({ getVersions, getActor, subscribe, source, watchPaths = [], heartbeatMs = 20_000 }) {
  const clients = new Set(), watchers = [];
  let queued = false, closed = false;
  const send = (client, initial = false) => {
    if (closed || client.response.destroyed || client.response.writableEnded) return;
    try {
      const actor = getActor(client.request);
      if (!actor || actor.id !== client.actorId) {
        client.response.write('event: auth-expired\ndata: {}\n\n');
        client.response.end();
        return;
      }
      const versions = getVersions(actor);
      const changes = initial ? versions : changedVersions(client.versions, versions);
      client.versions = versions;
      if (!initial && !Object.keys(changes).length) return;
      if (client.response.writableLength > 64 * 1024) return client.response.end();
      client.response.write(`event: ${initial ? 'snapshot' : 'change'}\ndata: ${JSON.stringify({
        schema: 1, ...(initial && source && { source }), versions: changes
      })}\n\n`);
    } catch {
      // A temporary read failure must not revoke a valid browser session.
      client.response.end();
    }
  };
  const notify = () => {
    if (queued || closed || !clients.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const client of clients) send(client);
    });
  };
  const unsubscribe = subscribe(notify);
  const directories = new Map();
  for (const file of watchPaths) {
    const directory = dirname(file);
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(basename(file));
  }
  // File events also cover another process committing to the same data files.
  // They trigger revision comparison, never periodic business-data polling.
  for (const [directory, names] of directories) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (!name || names.has(String(name))) notify();
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { /* In-process commit notifications remain available. */ }
  }
  return {
    notify,
    handle(request, response, actor) {
      if (request.method !== 'GET') return response.writeHead(405, { Allow: 'GET' }).end();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive'
      });
      response.flushHeaders?.();
      const client = { request, response, actorId: actor.id, versions: {} };
      clients.add(client);
      const heartbeat = setInterval(() => {
        try {
          const current = getActor(request);
          if (!current || current.id !== client.actorId) {
            response.write('event: auth-expired\ndata: {}\n\n');
            response.end();
          } else response.write(': heartbeat\n\n');
        } catch { response.end(); }
      }, heartbeatMs);
      heartbeat.unref?.();
      response.once('close', () => { clearInterval(heartbeat); clients.delete(client); });
      send(client, true);
    },
    close() {
      closed = true;
      unsubscribe();
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.response.end();
      clients.clear();
    }
  };
}
