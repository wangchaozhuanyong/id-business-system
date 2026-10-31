'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const SETUP_BUDGET_MS = 1000;
function setupError(error) {
  try {
    const name = error?.name;
    const errorName = ['Error', 'TypeError', 'TimeoutError', 'ProtocolError'].includes(name)
      ? name
      : error == null
        ? 'none'
        : 'other';
    const message = typeof error?.message === 'string' ? error.message : '';
    const errorClass =
      error == null
        ? 'none'
        : errorName === 'TimeoutError' || /timed?\s*out|timeout/i.test(message)
          ? 'timeout'
          : /execution context was destroyed/i.test(message)
            ? 'context_destroyed'
            : /target.*closed|page.*closed|context.*closed|browser.*closed/i.test(message)
              ? 'target_closed'
              : /connection.*closed|disconnected/i.test(message)
                ? 'connection_closed'
                : /not supported|unsupported|not implemented/i.test(message)
                  ? 'unsupported'
                  : errorName === 'ProtocolError' || /protocol error/i.test(message)
                    ? 'protocol_error'
                    : 'other';
    return { errorName, errorClass };
  } catch {
    return { errorName: 'other', errorClass: 'other' };
  }
}

// Observe existing page traffic only. CDP IDs are mapped to local ordinals; no
// URLs, response bodies, header values or raw network addresses leave here.
function observeSessionConnections(context, log, responseMetadata) {
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
  const incomplete = (
    setupOperation,
    setupFailure,
    error,
    operationStarted = started,
    setupStarted = started
  ) => ({
    event: 'connection_observer',
    complete: false,
    reason: 'setup_incomplete',
    setupOperation,
    setupFailure,
    ...setupError(error),
    setupBudgetMs: SETUP_BUDGET_MS,
    setupElapsedMs: Math.max(0, Math.round(performance.now() - setupStarted)),
    operationElapsedMs: Math.max(0, Math.round(performance.now() - operationStarted))
  });
  if (typeof context?.newCDPSession !== 'function') {
    emit(incomplete('context_support', 'unsupported'));
    return { dispose() {} };
  }
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
      detaching: false,
      setupComplete: false,
      setupOperation: 'page_listener',
      setupStarted: performance.now(),
      operationStarted: performance.now()
    };
    pages.set(page, state);
    const emitFor = (row) => {
      if (state.active) emit({ pageSequence: state.pageSequence, ...row });
    };
    const failedSetup = (setupFailure, error) => {
      if (!active || !state.active) return;
      emitFor(
        incomplete(
          state.setupOperation,
          setupFailure,
          error,
          state.operationStarted,
          state.setupStarted
        )
      );
      release(state);
    };
    const operation = (name) => {
      state.setupOperation = name;
      state.operationStarted = performance.now();
    };
    state.close = () => {
      if (!state.setupComplete) failedSetup('page_closed');
      else release(state);
    };
    state.cancelSetup = (reason) => {
      if (!state.setupComplete) failedSetup(reason);
    };
    try {
      page.on('close', state.close);
      // Never wait for diagnostic setup on the login path. Late/missing setup
      // is explicit evidence loss, not an authentication verdict.
      state.timer = setTimeout(() => failedSetup('deadline'), SETUP_BUDGET_MS);
      state.timer.unref?.();
      Promise.resolve()
        .then(() => {
          if (!active || !state.active) return null;
          operation('new_cdp_session');
          return context.newCDPSession(page);
        })
        .then(async (session) => {
          if (!session) return;
          state.session = session;
          try {
            if (!active || !state.active) return;
            operation('register_network_listeners');
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
            operation('network_enable');
            await session.send('Network.enable');
            if (!active || !state.active) return;
            clearTimeout(state.timer);
            state.setupComplete = true;
            emitFor({ event: 'connection_observer', complete: true });
          } catch (error) {
            failedSetup('exception', error);
          } finally {
            if (!active || !state.active) detach(state);
          }
        })
        .catch((error) => {
          failedSetup('exception', error);
        });
    } catch (error) {
      failedSetup('exception', error);
    }
  };
  const onContextClose = () => dispose('context_closed');
  const dispose = (reason = 'observer_disposed') => {
    if (!active) return;
    for (const state of pages.values())
      state.cancelSetup(reason === 'context_closed' ? 'context_closed' : 'observer_disposed');
    active = false;
    for (const [event, handler] of [
      ['page', observe],
      ['close', onContextClose]
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
  let rootOperation = 'context_listeners';
  let rootOperationStarted = performance.now();
  try {
    context.on('page', observe);
    context.on('close', onContextClose);
    rootOperation = 'enumerate_pages';
    rootOperationStarted = performance.now();
    for (const page of context.pages()) observe(page);
  } catch (error) {
    emit(incomplete(rootOperation, 'exception', error, rootOperationStarted));
    dispose();
  }
  return { dispose };
}

module.exports = { observeSessionConnections };
