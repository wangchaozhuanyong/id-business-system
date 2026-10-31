'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

// Observe existing page traffic only. CDP IDs are mapped to local ordinals; no
// URLs, response bodies, header values or raw network addresses leave here.
function observeSessionConnections(context, log, responseMetadata) {
  if (typeof context?.newCDPSession !== 'function') return { dispose() {} };
  const pages = new Map();
  const started = performance.now();
  let active = true,
    pageCount = 0,
    requestCount = 0;
  const emit = (value) => {
    if (!active) return;
    try {
      log({ ...value, elapsedMs: Math.round(performance.now() - started) });
    } catch {
      // Delivery failure cannot affect the request being observed.
    }
  };
  const official = (raw) => {
    try {
      const url = new URL(raw);
      return url.origin === 'https://chatgpt.com' && url.pathname === '/api/auth/session';
    } catch {
      return false;
    }
  };
  const detach = (state) => {
    if (!state.session || state.detaching) return;
    state.detaching = true;
    try {
      Promise.resolve(state.session.detach()).catch(() => {});
    } catch {
      // The page may already have been destroyed.
    }
  };
  const release = (state) => {
    state.active = false;
    clearTimeout(state.timer);
    for (const [event, handler] of state.listeners) {
      try {
        state.session?.off(event, handler);
      } catch {
        // Teardown is independent of the business outcome.
      }
    }
    try {
      state.page.off('close', state.close);
    } catch {
      // A closed page may already have removed its listeners.
    }
    state.requests.clear();
    detach(state);
  };
  const observe = (page) => {
    if (!active || pages.has(page) || pageCount >= 30) return;
    const state = {
      page,
      pageSequence: ++pageCount,
      active: true,
      requests: new Map(),
      listeners: [],
      session: null,
      detaching: false
    };
    pages.set(page, state);
    const emitFor = (row) => {
      if (state.active) emit({ pageSequence: state.pageSequence, ...row });
    };
    state.close = () => release(state);
    const failedSetup = () => {
      emitFor({ event: 'connection_observer', complete: false, reason: 'setup_incomplete' });
      release(state);
    };
    try {
      page.on('close', state.close);
      // Never wait for diagnostic setup on the login path. Late/missing setup
      // is explicit evidence loss, not an authentication verdict.
      state.timer = setTimeout(failedSetup, 1000);
      state.timer.unref?.();
      Promise.resolve()
        .then(() => (active && state.active ? context.newCDPSession(page) : null))
        .then(async (session) => {
          if (!session) return;
          state.session = session;
          try {
            if (!active || !state.active) return;
            const request = (event) => {
              try {
                if (!active || !state.active) return;
                const previous = state.requests.get(event.requestId);
                if (!official(event.request?.url) || requestCount >= 30) {
                  state.requests.delete(event.requestId);
                  return;
                }
                const row = {
                  requestSequence: ++requestCount,
                  requestId: previous?.requestId || requestCount,
                  redirectHop: previous ? previous.redirectHop + 1 : 0,
                  resourceType:
                    { Document: 'document', Fetch: 'fetch', XHR: 'xhr' }[event.type] || 'other'
                };
                state.requests.set(event.requestId, row);
                emitFor({ event: 'connection_request', ...row });
              } catch {
                emitFor({
                  event: 'connection_observer',
                  complete: false,
                  reason: 'event_read_failed'
                });
              }
            };
            const response = (event) => {
              try {
                const row = state.requests.get(event.requestId);
                if (!row || !official(event.response?.url)) return;
                const value = event.response;
                const metadata = responseMetadata(value.headers || {});
                const remote = String(value.remoteIPAddress || '');
                emitFor({
                  event: 'connection_response',
                  ...row,
                  complete: true,
                  httpStatus:
                    Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
                      ? value.status
                      : 0,
                  ...(Number.isSafeInteger(value.connectionId) && value.connectionId >= 0
                    ? { connectionId: value.connectionId }
                    : {}),
                  ...(typeof value.connectionReused === 'boolean'
                    ? { connectionReused: value.connectionReused }
                    : {}),
                  ...(isIP(remote)
                    ? {
                        remoteAddressHash: createHash('sha256')
                          .update(remote.toLowerCase())
                          .digest('hex')
                      }
                    : {}),
                  remoteAddressRole: 'remote_peer_not_client_exit',
                  contentType: metadata.contentType,
                  cfMitigated: metadata.cfMitigated,
                  server: metadata.server
                });
              } catch {
                emitFor({
                  event: 'connection_observer',
                  complete: false,
                  reason: 'event_read_failed'
                });
              }
            };
            const finish = (event, failed) => {
              try {
                const row = state.requests.get(event.requestId);
                if (!row) return;
                emitFor({ event: failed ? 'connection_failed' : 'connection_finished', ...row });
                state.requests.delete(event.requestId);
              } catch {
                emitFor({
                  event: 'connection_observer',
                  complete: false,
                  reason: 'event_read_failed'
                });
              }
            };
            for (const [name, handler] of [
              ['Network.requestWillBeSent', request],
              ['Network.responseReceived', response],
              ['Network.loadingFinished', (event) => finish(event, false)],
              ['Network.loadingFailed', (event) => finish(event, true)]
            ]) {
              session.on(name, handler);
              state.listeners.push([name, handler]);
            }
            await session.send('Network.enable');
            if (!active || !state.active) return;
            clearTimeout(state.timer);
            emitFor({ event: 'connection_observer', complete: true });
          } catch {
            if (active && state.active) failedSetup();
          } finally {
            if (!active || !state.active) detach(state);
          }
        })
        .catch(() => {
          if (active && state.active) failedSetup();
        });
    } catch {
      failedSetup();
    }
  };
  const dispose = () => {
    active = false;
    for (const [event, handler] of [
      ['page', observe],
      ['close', dispose]
    ]) {
      try {
        context.off(event, handler);
      } catch {
        // Context shutdown must not depend on diagnostic listener removal.
      }
    }
    for (const state of pages.values()) release(state);
    pages.clear();
  };
  try {
    context.on('page', observe);
    context.on('close', dispose);
    for (const page of context.pages()) observe(page);
  } catch {
    emit({ event: 'connection_observer', complete: false, reason: 'setup_incomplete' });
    dispose();
  }
  return { dispose };
}

module.exports = { observeSessionConnections };
