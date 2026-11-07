/* Server change notifications; timers only reconnect the event channel. */
(() => {
  'use strict';
  const data = window.IDLocalData, A = window.IDDesignAPI;
  if (!data || !A || document.querySelector('meta[name="id-local-data-events"]')?.content !== 'enabled') return;
  const pending = new Set();
  let controller, retry, stopped = false, connected = false, failures = 0, generation = 0;
  let snapshots = 0, changes = 0;
  let refreshing = false, changeGeneration = 0, scheduled = false;
  const blocked = () => document.hidden || data.writesPending() ||
    document.querySelector('#confirm-dialog[open], .row-action-menu:popover-open, #main form[novalidate], #drawer[open] form:not([onsubmit="return false"])');
  const resume = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void flush(); });
  };
  async function flush() {
    if (stopped || refreshing || !pending.size || blocked()) return;
    const versions = data.pendingChangeVersions([...pending]);
    const scopes = Object.keys(versions), seen = changeGeneration, route = A.state.route;
    pending.clear();
    if (!scopes.length) return;
    refreshing = true;
    let failed = false;
    const has = scope => scopes.includes(scope);
    const run = async operation => {
      try { if (await operation() === false) failed = true; } catch { failed = true; }
    };
    try {
      if (has('settings')) await run(() => A.modules.operations?.loadSettings(true));
      if (has('appleBalance')) await run(() => A.modules.appleBalance?.refreshLocalBalance());
      if (route === 'overview' && ['inventory', 'commerce', 'settings', 'appleBalance'].some(has)) {
        await run(() => A.modules.overview?.refresh({ refresh: true }));
      } else {
        await Promise.all([
          has('inventory') ? run(() => A.modules.inventory?.refreshLocalInventory({ keepContent: true })) : null,
          has('commerce') ? run(() => A.modules.commerce?.refreshOverview()) : null
        ]);
        if (has('inventory') && A.state.route === route && /^(mailboxes\/google|accounts\/(gpt|claude))$/.test(route) && !blocked()) A.render();
      }
      if ((has('inventory') || has('apple-relay')) && A.state.route === 'mailboxes/relay')
        await run(() => A.modules.appleRelay?.refreshConnection());
      if (has('settings') && A.state.route === route && route.startsWith('settings/') && !blocked()) A.render();
      if (has('toolbox')) {
        await run(() => window.IDLocalToolbox?.load({ refresh: true }));
        if (!blocked()) A.refreshToolbox?.();
      }
      if (has('operators')) {
        await run(() => window.IDLocalAuth?.refresh());
        const labelsChanged = await data.refreshOperatorLabels();
        if (A.state.route === 'settings/accounts') await run(() => window.IDLocalAuth?.loadEmployees(A, true));
        else if (labelsChanged && !blocked()) A.render();
      }
      await run(() => A.modules.operations?.refreshLiveReads(scopes));
      for (const module of window.IDDesignModules) if (module.onDataChanges)
        await run(() => module.onDataChanges(scopes));
      if (has('audit') && A.state.route === 'settings/audit') await run(() => A.modules.operations?.refreshAudit());
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (new URL(frame.src, location.href).origin === location.origin)
            frame.contentWindow?.postMessage({ source: 'id-recharge-shell', type: 'data-change', scopes }, location.origin);
        } catch { /* External tools retain their own update contract. */ }
      }
    } finally {
      if (failed) {
        for (const scope of scopes) pending.add(scope);
        A.notify('新数据暂未更新，已保留当前内容。可稍后重试。');
      } else data.acknowledgeChanges(versions);
      refreshing = false;
      if (changeGeneration !== seen && pending.size) resume();
    }
  }
  const unsubscribe = data.subscribeChanges(scopes => {
    for (const scope of scopes) pending.add(scope);
    changeGeneration++;
    resume();
  });
  function applyFrame(frame) {
    let type = 'message';
    const parts = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) parts.push(line.slice(5).trimStart());
    }
    if (type === 'auth-expired') { stop(); window.IDLocalAuth?.lock?.(); return; }
    if (!['snapshot', 'change'].includes(type) || !parts.length) return;
    const payload = JSON.parse(parts.join('\n'));
    if (payload.schema === 1) {
      if (type === 'snapshot') snapshots++; else changes++;
      data.acceptChangeVersions(payload.versions, { reconcile: type === 'snapshot' });
    }
  }
  async function connect() {
    if (stopped || controller || document.hidden) return;
    const current = ++generation;
    controller = new AbortController();
    try {
      const response = await fetch('/api/local/change-events', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: controller.signal
      });
      if (response.status === 401) { stop(); window.IDLocalAuth?.lock?.(); return; }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
        throw new Error('Change stream unavailable');
      connected = true;
      failures = 0;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      while (!stopped && generation === current) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
        if (buffer.length > 64 * 1024) throw new Error('Invalid change frame');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!stopped && generation === current) applyFrame(frame);
        }
      }
    } catch { /* Keep the last successful content and reconnect. */ }
    finally {
      if (generation === current) {
        controller = undefined;
        connected = false;
        if (!stopped) retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)));
      }
    }
  }
  function stop() {
    stopped = true;
    connected = false;
    generation++;
    controller?.abort();
    controller = undefined;
    clearTimeout(retry);
    pending.clear();
    unsubscribe();
    data.clearChangeTracking();
  }
  const foreground = () => {
    if (document.hidden || stopped) return;
    resume();
    if (!controller) { clearTimeout(retry); void connect(); }
  };
  window.IDChangeSync = Object.freeze({ resume, stop, status: () => ({ connected, snapshots, changes, pending: pending.size, refreshing }) });
  window.IDDesignModules.push({ id: 'change-sync', matches: () => false, clearPageState: stop });
  document.addEventListener('close', resume, true);
  document.addEventListener('toggle', resume, true);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener('online', foreground);
  window.addEventListener('focus', foreground);
  window.addEventListener('id-data-write-idle', resume);
  window.addEventListener('pagehide', () => controller?.abort());
  window.addEventListener('pageshow', foreground);
  window.addEventListener('DOMContentLoaded', () => void connect(), { once: true });
})();
