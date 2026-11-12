/* Push-driven updates. Timers only recover a disconnected stream or a failed known update. */
(() => {
  'use strict';
  const data = window.IDLocalData, A = window.IDDesignAPI;
  if (!data || !A || document.querySelector('meta[name="id-local-data-events"]')?.content !== 'enabled') return;
  const pending = new Set();
  const failedVersions = new Map();
  let refreshRetry, refreshFailures = 0;
  let controller, retry, stopped = false, connected = false, failures = 0, generation = 0;
  let snapshots = 0, changes = 0;
  let refreshing = false, changeGeneration = 0, scheduled = false;
  const blocked = () => document.hidden || data.writesPending() ||
    document.querySelector('#confirm-dialog[open], .row-action-menu:popover-open');
  const editing = () => document.querySelector('#main form[novalidate], #drawer[open] form:not([onsubmit="return false"])');
  function retryFailed() {
    clearTimeout(refreshRetry);
    refreshRetry = undefined;
    refreshFailures = 0;
    resume();
  }
  const resume = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void flush(); });
  };
  async function flush() {
    if (stopped || refreshing || refreshRetry !== undefined || refreshFailures > 3 || !pending.size || blocked()) return;
    // A successful base read must not hide a failed dependent view update.
    const versions = { ...Object.fromEntries(failedVersions), ...data.pendingChangeVersions([...pending]) };
    const scopes = Object.keys(versions), seen = changeGeneration, route = A.state.route;
    pending.clear();
    if (!scopes.length) return;
    refreshing = true;
    showStatus();
    let failed = false;
    const has = scope => scopes.includes(scope);
    const refreshCommerce = has('commerce') || has('subscription-management');
    const inventoryPage = /^(mailboxes\/(google|microsoft)|accounts\/(gpt|claude|gemini|grok))$/.test(route);
    const refreshInventory = has('inventory') || (has('commerce') && inventoryPage);
    const run = async operation => {
      try { if (await operation() === false) failed = true; } catch { failed = true; }
    };
    try {
      if (has('settings')) await run(() => A.modules.operations?.loadSettings(true));
      if (has('appleBalance')) await run(() => A.modules.appleBalance?.refreshLocalBalance());
      if (route === 'overview' && (refreshCommerce || ['inventory', 'settings', 'appleBalance'].some(has) ||
          (data.canApproveRechargeCodes && has('recharge-codes')))) {
        await run(() => A.modules.overview?.refresh({ refresh: true }));
      } else {
        await Promise.all([
          refreshInventory ? run(() => A.modules.inventory?.refreshLocalInventory({ keepContent: true })) : null,
          refreshCommerce ? run(() => A.modules.commerce?.refreshOverview()) : null
        ]);
        if (refreshInventory && A.state.route === route && inventoryPage && !blocked()) A.render();
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
    } catch {
      failed = true;
    } finally {
      if (stopped) { refreshing = false; return; }
      if (failed) {
        for (const scope of scopes) { pending.add(scope); failedVersions.set(scope, versions[scope]); }
        refreshFailures++;
        if (refreshFailures <= 3) refreshRetry = setTimeout(() => {
          refreshRetry = undefined;
          resume();
        }, [500, 1500, 4500][refreshFailures - 1]);
        if (refreshFailures === 1) A.notify('新数据暂未更新，已保留当前内容，正在重试。');
        // A revision received during the final failed attempt must not get
        // stranded behind the retry limit for an older revision.
        if (refreshFailures > 3 && Object.entries(data.pendingChangeVersions([...pending]))
          .some(([scope, version]) => versions[scope] !== version)) refreshFailures = 0;
      } else {
        for (const scope of scopes) failedVersions.delete(scope);
        refreshFailures = 0;
        data.acknowledgeChanges(versions);
      }
      refreshing = false;
      showStatus();
      if (changeGeneration !== seen && pending.size) resume();
    }
  }
  const unsubscribe = data.subscribeChanges(scopes => {
    for (const scope of scopes) pending.add(scope);
    changeGeneration++;
    // A new revision is new work, independent of an exhausted older retry.
    if (refreshFailures > 3) refreshFailures = 0;
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
      window.IDRechargeActivity?.onVersion(payload.versions?.['recharge-activity']);
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
      showStatus();
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
        showStatus();
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
    clearTimeout(refreshRetry);
    failedVersions.clear();
    pending.clear();
    unsubscribe();
    data.clearChangeTracking();
    document.getElementById?.('data-sync-status')?.remove();
  }
  const foreground = () => {
    if (document.hidden || stopped) return;
    retryFailed();
    if (!controller) { clearTimeout(retry); void connect(); }
  };
  function showStatus() {
    const footer = document.querySelector('.workspace-footer');
    if (!footer || stopped) return;
    let status = document.getElementById('data-sync-status');
    if (!status) {
      status = document.createElement('button');
      status.id = 'data-sync-status';
      status.type = 'button';
      status.className = 'text-action';
      status.setAttribute('aria-live', 'polite');
      status.addEventListener('click', foreground);
      footer.prepend(status);
    }
    const label = refreshFailures > 3 ? '更新失败 · 点击重试' : !connected ? '实时连接恢复中' :
      refreshing || refreshFailures ? '正在同步新数据' : '实时更新已连接';
    if (status.textContent !== label) status.textContent = label;
    status.disabled = connected && !refreshFailures;
  }
  window.IDChangeSync = Object.freeze({ resume, retry: retryFailed, stop,
    preserveEditor: () => refreshing && Boolean(editing()),
    status: () => ({ connected, snapshots, changes, pending: pending.size, refreshing, refreshFailures }) });
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
