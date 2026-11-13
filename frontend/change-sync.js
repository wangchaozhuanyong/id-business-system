/* Push-driven updates. Timers only recover a disconnected stream or a failed known update. */
(() => {
  'use strict';
  const data = window.IDLocalData, A = window.IDDesignAPI;
  if (!data || !A || document.querySelector('meta[name="id-local-data-events"]')?.content !== 'enabled') return;
  const pending = new Map(), activeGroups = new Set();
  const deferred = new Map();
  const retryDelays = [500, 1500, 4500];
  // Coalesce scopes that refresh the same records. Other groups can finish
  // and retry independently while one is still reading.
  const groupOf = scope => {
    if (['commerce', 'subscription-management'].includes(scope)) return 'commerce';
    if (['inventory', 'tools/mailbox-pool', 'apple-relay'].includes(scope)) return 'inventory';
    if (['finance-rates', 'card-types', 'order-card-freeze', 'tenant-cards'].includes(scope)) return 'renewal-resources';
    return scope;
  };
  const failureCount = () => Math.max(0, ...Array.from(pending.values(), job => job.failures));
  const source = document.querySelector('meta[name="id-data-source"]')?.content;
  let controller, retry, stopped = false, connected = false, failures = 0, generation = 0;
  let snapshots = 0, changes = 0, scheduled = false, sourceUpdated = false;
  const blocked = () => stopped || document.hidden ||
    document.querySelector('#confirm-dialog[open], .row-action-menu:popover-open');
  const editing = () => document.querySelector('#main form[novalidate], #drawer[open] form:not([onsubmit="return false"])');
  function retryFailed() {
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.timer = undefined;
      job.failures = 0;
    }
    resume();
  }
  const resume = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; flush(); });
  };
  function flush() {
    if (stopped || (!pending.size && !deferred.size)) return;
    if (blocked()) { showStatus(); return; }
    if (A.usesSharedBusinessData?.(A.state.route) !== false) {
      for (const [scope, version] of deferred) {
        if (pending.has(scope)) continue;
        pending.set(scope, { version, failures: 0 });
        deferred.delete(scope);
      }
    }
    if (!pending.size) return;
    const groups = new Map();
    for (const [scope, job] of pending) {
      const group = groupOf(scope);
      if (activeGroups.has(group) || job.timer !== undefined || job.failures > retryDelays.length) continue;
      if (!groups.has(group) && data.writesPending(scope => groupOf(scope) === group)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([scope, job]);
    }
    for (const [group, jobs] of groups) {
      activeGroups.add(group);
      void refreshGroup(group, jobs);
    }
    showStatus();
  }
  async function refreshGroup(group, jobs) {
    for (const [, job] of jobs) job.active = true;
    const versions = Object.fromEntries(jobs.map(([scope, job]) => [scope, job.version]));
    const failed = !await applyChanges(versions);
    activeGroups.delete(group);
    if (stopped) return;
    const acknowledged = {};
    for (const [scope, job] of jobs) {
      job.active = false;
      if (pending.get(scope) !== job) continue;
      if (failed || (job.recheck && data.pendingChangeVersions([scope])[scope] === job.version)) {
        job.recheck = false;
        job.failures++;
        if (job.failures <= retryDelays.length) job.timer = setTimeout(() => {
          job.timer = undefined;
          resume();
        }, retryDelays[job.failures - 1]);
        if (job.failures === 1) A.notify('新数据暂未更新，已保留当前内容，正在重试。');
      } else {
        acknowledged[scope] = job.version;
        pending.delete(scope);
      }
    }
    data.acknowledgeChanges(acknowledged);
    showStatus();
    resume();
  }
  async function applyChanges(versions) {
    const scopes = Object.keys(versions), route = A.state.route;
    let failed = false;
    const has = scope => scopes.includes(scope);
    const refreshCommerce = has('commerce') || has('subscription-management');
    const inventoryPage = /^(mailboxes\/(google|microsoft)|accounts\/(gpt|claude|gemini|grok))$/.test(route);
    const refreshInventory = has('inventory') || (has('commerce') && inventoryPage);
    const shared = A.usesSharedBusinessData?.(route) !== false;
    for (const scope of ['commerce', 'inventory', 'subscription-management', 'appleBalance']) {
      if (!has(scope)) continue;
      if (shared) deferred.delete(scope);
      else deferred.set(scope, versions[scope]);
    }
    const run = async operation => {
      try { if (await operation() === false) failed = true; } catch { failed = true; }
    };
    try {
      if (has('settings')) await run(() => A.modules.operations?.loadSettings(true));
      if (shared && route !== 'overview' && has('appleBalance'))
        await run(() => A.modules.appleBalance?.refreshLocalBalance());
      if (route === 'overview' && (refreshCommerce || ['inventory', 'settings', 'appleBalance', 'apple-relay', 'finance-rates', 'order-expense-receipts'].some(has) ||
          (data.canApproveRechargeCodes && has('recharge-codes')))) {
        await run(() => A.modules.overview?.refresh({ refresh: true }));
      } else if (shared) {
        await Promise.all([
          refreshInventory ? run(() => A.modules.inventory?.refreshLocalInventory({ keepContent: true })) : null,
          refreshCommerce ? run(() => A.modules.commerce?.refreshCommerce()) : null
        ]);
        if (refreshInventory && A.state.route === route && inventoryPage && !blocked()) A.render();
      }
      if ((has('inventory') || has('apple-relay')) && A.state.route === 'mailboxes/relay')
        await run(() => A.modules.appleRelay?.refreshConnection());
      if (stopped) return false;
      if (has('settings') && A.state.route === route && route.startsWith('settings/') && !blocked()) A.render();
      if (has('toolbox')) {
        await run(() => window.IDLocalToolbox?.load({ refresh: true }));
        if (!blocked()) A.refreshToolbox?.();
      }
      if (has('operators')) {
        await run(() => window.IDLocalAuth?.refresh());
        let labelsChanged;
        await run(async () => { labelsChanged = await data.refreshOperatorLabels({ strict: true }); });
        if (A.state.route === 'settings/accounts') await run(() => window.IDLocalAuth?.loadEmployees(A, true));
        else if (labelsChanged && !blocked()) A.render();
      }
      if (stopped) return false;
      await Promise.all([
        run(() => A.modules.operations?.refreshLiveReads(scopes)),
        ...window.IDDesignModules.filter(module => module.onDataChanges).map(module => run(() => module.onDataChanges(scopes))),
        ...(has('audit') && A.state.route === 'settings/audit' ? [run(() => A.modules.operations?.refreshAudit())] : [])
      ]);
      if (stopped) return false;
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (new URL(frame.src, location.href).origin === location.origin)
            frame.contentWindow?.postMessage({ source: 'id-recharge-shell', type: 'data-change', scopes,
              ...(has('recharge-card-plans') && { cardPlanVersion: versions['recharge-card-plans'] }) }, location.origin);
        } catch { /* External tools retain their own update contract. */ }
      }
    } catch {
      failed = true;
    }
    return !failed;
  }
  const unsubscribe = data.subscribeChanges((scopes, { behind = false } = {}) => {
    for (const [scope, version] of Object.entries(data.pendingChangeVersions(scopes))) {
      const current = pending.get(scope);
      if (current?.version === version) {
        if (behind && current.active) current.recheck = true;
        continue;
      }
      clearTimeout(current?.timer);
      pending.set(scope, { version, failures: 0 });
    }
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
    if (payload?.schema === 1 && payload.versions && typeof payload.versions === 'object' && !Array.isArray(payload.versions)) {
      if (type === 'snapshot' && source && payload.source && payload.source !== source) { sourceChanged(); return; }
      if (data.acceptChangeVersions(payload.versions, { reconcile: type === 'snapshot' }) === false) {
        sourceChanged();
        return;
      }
      if (type === 'snapshot') { snapshots++; connected = true; showStatus(); }
      else changes++;
      window.IDRechargeActivity?.onVersion(payload.versions?.['recharge-activity']);
    }
  }
  async function connect() {
    if (stopped || controller || document.hidden) return;
    const current = ++generation;
    const started = Date.now();
    const startingSnapshots = snapshots;
    const connection = new AbortController();
    controller = connection;
    let reader, deadline;
    const armDeadline = () => {
      clearTimeout(deadline);
      // Heartbeats arrive every 20 seconds. This checks transport liveness,
      // without reading versions or business data on a fixed schedule.
      deadline = setTimeout(() => connection.abort(), 60_000);
    };
    armDeadline();
    try {
      const response = await fetch('/api/local/change-events', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: connection.signal
      });
      if (response.status === 401) { stop(); window.IDLocalAuth?.lock?.(); return; }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
        throw new Error('Change stream unavailable');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped && generation === current) {
        armDeadline();
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
      clearTimeout(deadline);
      connection.abort();
      await reader?.cancel().catch(() => {});
      if (generation === current) {
        controller = undefined;
        connected = false;
        showStatus();
        if (snapshots > startingSnapshots && Date.now() - started > 30_000) failures = 0;
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
    for (const job of pending.values()) clearTimeout(job.timer);
    pending.clear();
    deferred.clear();
    activeGroups.clear();
    unsubscribe();
    data.clearChangeTracking();
    document.getElementById?.('data-sync-status')?.remove();
  }
  function sourceChanged() {
    if (stopped) return;
    sourceUpdated = true;
    data.invalidateDataSource();
    stop();
    if (!editing() && !A.state.drafts?.size && !data.writesPending() && !document.querySelector('#confirm-dialog[open]')) {
      window.location.reload();
    } else {
      showStatus();
      A.notify('业务数据来源已变化，当前填写已保留。请先记录未保存的内容，再重新加载核对。', { kind: 'error', duration: 0 });
    }
  }
  const foreground = () => {
    if (document.hidden || stopped) return;
    retryFailed();
    if (!controller) { clearTimeout(retry); void connect(); }
  };
  function showStatus() {
    const footer = document.querySelector('.workspace-footer');
    if (!footer || (stopped && !sourceUpdated)) return;
    let status = document.getElementById('data-sync-status');
    if (!status) {
      status = document.createElement('button');
      status.id = 'data-sync-status';
      status.type = 'button';
      status.className = 'text-action';
      status.setAttribute('aria-live', sourceUpdated ? 'assertive' : 'polite');
      status.addEventListener('click', () => sourceUpdated ? window.location.reload() : foreground());
      footer.prepend(status);
    }
    if (sourceUpdated) {
      const host = document.querySelector('#confirm-dialog[open]') || document.querySelector('#drawer[open] .drawer-footer') ||
        document.querySelector('#drawer[open] .drawer-body') || footer;
      if (!host.contains(status)) host.append(status);
    }
    const refreshFailures = failureCount();
    const label = sourceUpdated ? '数据已恢复 · 重新加载' :
      refreshFailures > retryDelays.length ? '更新失败 · 点击重试' : !connected ? '实时连接恢复中' :
      activeGroups.size || refreshFailures ? '正在同步新数据' : pending.size ? '有更新待应用' : '实时更新已连接';
    if (status.textContent !== label) status.textContent = label;
    status.disabled = connected && !refreshFailures;
  }
  window.IDChangeSync = Object.freeze({ resume, retry: retryFailed, stop, sourceChanged,
    preserveEditor: () => (sourceUpdated || activeGroups.size > 0) && Boolean(editing()),
    status: () => ({ connected, snapshots, changes, pending: pending.size, refreshing: activeGroups.size > 0, refreshFailures: failureCount() }) });
  window.IDDesignModules.push({ id: 'change-sync', matches: () => false, clearPageState: stop });
  document.addEventListener('close', resume, true);
  document.addEventListener('close', () => { if (sourceUpdated) showStatus(); }, true);
  document.addEventListener('toggle', resume, true);
  document.addEventListener('visibilitychange', foreground);
  window.addEventListener('online', foreground);
  window.addEventListener('focus', foreground);
  window.addEventListener('id-data-write-settled', resume);
  window.addEventListener('pagehide', () => controller?.abort());
  window.addEventListener('pageshow', foreground);
  window.addEventListener('DOMContentLoaded', () => void connect(), { once: true });
})();
