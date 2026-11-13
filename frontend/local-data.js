(() => {
  'use strict';

  const authRequired = document.querySelector('meta[name="id-local-auth"]')?.content === 'required';
  const encodedActor = document.querySelector('meta[name="id-local-actor"]')?.content;
  const actor = authRequired
    ? encodedActor
      ? Object.freeze(JSON.parse(decodeURIComponent(encodedActor)))
      : null
    : Object.freeze({ id: 'local-operator', name: '本机操作员', role: 'admin' });
  const canApproveRechargeCodes = authRequired && ['admin', 'super'].includes(actor?.role);

  const queryEntries = new Map();
  const mailboxUpdateStops = new Set();
  const observedVersions = new Map(), serverVersions = new Map(), changeListeners = new Set();
  const pageBaseline = new Set(), pendingInitialChanges = new Set();
  const pendingWrites = new Set();
  let sourceInvalidated = false;
  const dataSource = document.querySelector('meta[name="id-data-source"]')?.content;
  const supportsDocumentDelta = document.querySelector('meta[name="id-document-delta"]')?.content === 'enabled';
  const sourceError = () => Object.assign(new Error('业务数据来源已变化，请重新加载页面后核对'), {
    status: 409, code: 'DATA_SOURCE_CHANGED'
  });
  const expenseScope = 'order-expense-receipts';
  const revisionScopes = new Set(['inventory', 'commerce', 'settings', 'appleBalance', 'toolbox', 'saved-totp',
    'bitbrowser-connections', 'bitbrowser-proxies', 'bitbrowser-addresses', 'tenant-cards', 'recharge-codes',
    'order-sync', 'tools/mailbox-pool', 'tools/website-visits', 'apple-relay', 'operators', 'audit', 'finance-rates', 'card-types',
    'order-card-freeze', 'subscription-management', 'system-monitoring', 'recharge-card-plans', 'tools/mailbox-delivery',
    expenseScope, 'site-observations', 'site-resources', 'site-backups', 'renewal-handoffs', 'recharge-billing']);
  const counters = new Set(['inventory', 'commerce', 'settings', 'appleBalance', 'toolbox', expenseScope, 'subscription-management']);
  const numeric = value => typeof value === 'string' && /^\d+$/.test(value);
  const validRevision = version => typeof version === 'string' && version.length > 0 && version.length <= 128;
  const revisionEntries = versions => versions && typeof versions === 'object' && !Array.isArray(versions)
    ? Object.entries(versions).filter(([scope, version]) => revisionScopes.has(scope) && validRevision(version)) : [];
  try {
    const baseline = document.querySelector('meta[name="id-data-versions"]')?.content;
    if (baseline) for (const [scope, version] of revisionEntries(JSON.parse(decodeURIComponent(baseline)))) {
      serverVersions.set(scope, version);
      pageBaseline.add(scope);
    }
  } catch { /* The initial event snapshot provides a baseline if none is embedded. */ }
  const newer = (incoming, observed) => observed === undefined ||
    (/^\d+$/.test(incoming) && /^\d+$/.test(observed)
      ? BigInt(incoming) > BigInt(observed) : incoming !== observed);
  function notifyChanges(scopes, details) {
    for (const listener of changeListeners) {
      try { listener([...scopes], details); } catch { /* Notifications cannot fail a completed operation. */ }
    }
  }
  function publishChanges(scopes) {
    if (!scopes.length) return;
    const expanded = new Set(scopes);
    if (scopes.some(scope => ['inventory', 'commerce', 'settings', 'appleBalance', 'apple-relay', 'finance-rates', expenseScope].includes(scope)) ||
        (canApproveRechargeCodes && scopes.includes('recharge-codes'))) expanded.add('overview');
    if (scopes.includes('inventory')) { expanded.add('appleBalance'); expanded.add('apple-relay'); expanded.add('tools/mailbox-pool'); }
    if (scopes.includes('operators')) expanded.add('order-owners');
    if (scopes.some(scope => ['commerce', 'inventory', 'order-sync'].includes(scope))) expanded.add('site-data-health');
    if (scopes.some(scope => ['commerce', 'inventory', 'subscription-management'].includes(scope))) expanded.add('renewal-sidebar');
    queries.invalidate([...expanded]);
    notifyChanges(scopes);
  }
  function acceptChangeVersions(versions, { reconcile = false } = {}) {
    const entries = revisionEntries(versions);
    if (entries.some(([scope, version]) => {
      const previous = serverVersions.get(scope);
      return counters.has(scope) && numeric(previous) && numeric(version) && BigInt(version) < BigInt(previous);
    })) return false;
    const changed = [];
    for (const [scope, version] of entries) {
      const previous = serverVersions.get(scope), observed = observedVersions.get(scope);
      serverVersions.set(scope, version);
      // A base document may already have been fetched while a dependent list
      // still holds the older projection. Reconcile that first change as well.
      if (reconcile && pageBaseline.delete(scope) && version !== previous) pendingInitialChanges.add(scope);
      if (!reconcile && previous === version) continue;
      if (pendingInitialChanges.has(scope) ||
          (observed !== undefined ? newer(version, observed) : previous !== undefined && version !== previous)) changed.push(scope);
    }
    publishChanges(changed);
  }
  function observeResult(resource, result) {
    if (resource === 'batch' && Array.isArray(result)) {
      for (const entry of result) observeResult(entry.domain, entry);
      return;
    }
    if (!revisionScopes.has(resource) || !Number.isSafeInteger(result?.version)) return;
    const expected = serverVersions.get(resource);
    // External source receipts are opaque revisions, not document counters.
    // A numeric HTTP result cannot acknowledge or invalidate that revision:
    // the change dispatcher acknowledges it only after all affected reads pass.
    if (expected !== undefined && !/^\d+$/.test(expected)) return;
    const version = String(result.version), previous = observedVersions.get(resource);
    if (previous === undefined || !/^\d+$/.test(previous) || !newer(previous, version))
      observedVersions.set(resource, version);
    if (expected !== undefined && newer(expected, observedVersions.get(resource))) {
      // The stream already invalidated these caches. Let the dispatcher retry
      // this version without invalidating the read that just reported it.
      notifyChanges([resource], { behind: true });
    }
  }
  let queryEpoch = 0;
  function queryKey(value) {
    if (Array.isArray(value)) return '[' + value.map(queryKey).join(',') + ']';
    if (value && typeof value === 'object') {
      if (Object.prototype.toString.call(value) !== '[object Object]' ||
          (Object.getPrototypeOf(value) !== null && value.constructor?.name !== 'Object'))
        throw new TypeError('读取参数只接受普通对象');
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + queryKey(value[key])).join(',') + '}';
    }
    if (value === undefined) return 'undefined';
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('读取参数必须是有限数值');
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
      throw new TypeError('读取参数格式不受支持');
    return JSON.stringify(value);
  }
  const cloneQuery = (value) => value === undefined ? undefined : structuredClone(value);
  const supersededQuery = () => Object.assign(new Error('读取已被更新的请求替代'), {
    name: 'AbortError', code: 'READ_SUPERSEDED'
  });
  function queryEntry(scope, key, create = false) {
    if (typeof scope !== 'string' || !scope) throw new TypeError('读取范围不能为空');
    const id = JSON.stringify(scope) + ':' + queryKey(key);
    let entry = queryEntries.get(id);
    if (!entry && create) {
      entry = { scope, generation: 0, stale: true, hasData: false, data: undefined, pending: null };
      queryEntries.set(id, entry);
    }
    return entry;
  }
  const queries = Object.freeze({
    peek(scope, key) {
      const entry = queryEntry(scope, key);
      return entry && { data: cloneQuery(entry.data), stale: entry.stale, pending: Boolean(entry.pending) };
    },
    read(scope, key, loader, { refresh = false, isFresh = () => true } = {}) {
      const entry = queryEntry(scope, key, true);
      const epoch = queryEpoch;
      const generation = entry.generation;
      const current = () => queryEpoch === epoch && entry.generation === generation;
      const receive = (data) => {
        if (!current()) throw supersededQuery();
        return cloneQuery(data);
      };
      if (entry.pending) return entry.pending.then(receive);
      if (!refresh && entry.hasData && !entry.stale) return Promise.resolve(entry.data).then(receive);
      const pending = Promise.resolve().then(loader).then((data) => {
        if (!current()) throw supersededQuery();
        entry.data = cloneQuery(data);
        entry.hasData = true;
        entry.stale = !isFresh(data);
        return data;
      }, (error) => {
        if (!current()) throw supersededQuery();
        if (error?.status === 401 || error?.status === 403) queries.clear();
        else entry.stale = true;
        throw error;
      }).finally(() => {
        if (current() && entry.pending === pending) entry.pending = null;
      });
      entry.pending = pending;
      return pending.then(receive);
    },
    invalidate(scopes) {
      const selected = scopes === undefined ? null : new Set(Array.isArray(scopes) ? scopes : [scopes]);
      for (const entry of queryEntries.values()) if (!selected || selected.has(entry.scope)) {
        entry.generation++;
        entry.stale = true;
        entry.pending = null;
      }
    },
    clear() {
      queryEpoch++;
      for (const stop of [...mailboxUpdateStops]) stop(true);
      queryEntries.clear();
      observedVersions.clear();
    }
  });

  function watchManagedMailbox(queryCode, { onChange, onError, source } = {}) {
    let stopped = false, connection, retryTimer, failures = 0;
    const epoch = queryEpoch;
    const current = () => !stopped && epoch === queryEpoch;
    function stop(invalidated = false) {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(retryTimer);
      connection?.abort();
      mailboxUpdateStops.delete(stop);
      if (invalidated) {
        try { onError?.(new Error('读取状态已重置，请重新查询后开启自动更新。')); } catch {}
      }
    }
    async function open() {
      if (!current()) return;
      const controller = new AbortController();
      connection = controller;
      let readyAt;
      const connecting = window.setTimeout(() => controller.abort(), 45_000);
      let reader;
      try {
        const response = await window.fetch(source === 'relay' ? '/api/local/apple-relay/public-query' : '/api/local/tools/mailbox-query', {
          method: 'POST', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ queryCode })
        });
        window.clearTimeout(connecting);
        if (!current()) { await response.body?.cancel(); return; }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw Object.assign(new Error(payload.error || '邮件更新连接暂不可用'), {
            status: response.status, retryAfter: Number(response.headers.get('retry-after')) || 0
          });
        }
        if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream'))
          throw new Error('邮件更新连接暂不可用');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', version = -1;
        while (current()) {
          // The server sends a heartbeat every 20 seconds. A silent transport
          // must reconnect; healthy heartbeats never trigger a mailbox read.
          const idleDeadline = window.setTimeout(() => controller.abort(), 60_000);
          let chunk;
          try { chunk = await reader.read(); }
          finally { window.clearTimeout(idleDeadline); }
          const { done, value } = chunk;
          if (done) throw new Error('邮件更新连接已断开');
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          if (buffer.length > 8192) throw new Error('邮件更新通知格式无效');
          let end;
          while (current() && (end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = /^event: ?(.+)$/m.exec(frame)?.[1];
            if (!['ready', 'changed', 'stopped'].includes(event)) continue;
            const data = JSON.parse(/^data: ?(.+)$/m.exec(frame)?.[1] || '{}');
            if (event === 'stopped') throw Object.assign(new Error(
              data.reason === 'authorization' ? '查询授权已变化，请重新查询' : '邮件更新连接已断开'
            ), { status: data.reason === 'authorization' ? 403 : 503 });
            if (!Number.isSafeInteger(data.version) || data.version < 0) throw new Error('邮件更新通知格式无效');
            readyAt ??= Date.now();
            if (data.version > version) { version = data.version; onChange?.(); }
          }
        }
      } catch (error) {
        if (!current()) return;
        if (readyAt !== undefined && Date.now() - readyAt > 30_000) failures = 0;
        const terminal = [400, 401, 403, 404, 409, 415].includes(error.status);
        if (terminal || failures >= 3) { stop(); onError?.(error); return; }
        const delay = Math.max([1000, 3000, 10_000][failures++], Math.min(300, error.retryAfter || 0) * 1000);
        retryTimer = window.setTimeout(open, delay);
      } finally {
        window.clearTimeout(connecting);
        await reader?.cancel().catch(() => {});
        controller.abort();
      }
    }
    mailboxUpdateStops.add(stop);
    void open();
    return stop;
  }

  async function write(scopes, operation) {
    const affected = [...scopes, ...(scopes.includes('inventory') ? ['tools/mailbox-pool', 'appleBalance'] : [])];
    pendingWrites.add(affected);
    try {
      const result = await operation();
      queries.invalidate([...affected, 'overview', 'audit']);
      return result;
    } finally {
      pendingWrites.delete(affected);
      void Promise.resolve().then(() => window.dispatchEvent?.(new Event('id-data-write-settled')));
    }
  }

  async function request(resource, data, method = 'PUT', {
    keepalive = false, operationId: suppliedOperation, boundedRead = false, writeTimeout, measure, timing, stepUp = false,
    retryWrite = true
  } = {}) {
    if (sourceInvalidated) throw sourceError();
    const timeout = data === undefined || boundedRead ? 12_000 : writeTimeout;
    let signal = timeout ? AbortSignal.timeout(timeout) : undefined;
    const timeoutError = () => writeTimeout
      ? Object.assign(new Error('保存结果暂未确认，请读取最新资料核对后再操作'), { code: 'WRITE_OUTCOME_UNKNOWN' })
      : new Error('读取超时，请重试');
    const options =
      data === undefined
        ? { cache: 'no-store' }
        : {
            method,
            keepalive,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          };
    if (signal) options.signal = signal;
    if (data !== undefined && dataSource) options.headers['X-ID-Data-Source'] = dataSource;
    const receiptWrite = (data !== undefined && method === 'PUT' &&
      ['commerce', 'inventory', 'settings', 'appleBalance', 'batch'].includes(resource)) ||
      (resource === 'card-types' && data?.action === 'health');
    const operationId = suppliedOperation || (receiptWrite && window.crypto?.randomUUID?.());
    const retryable = operationId && retryWrite;
    if (operationId) options.headers['X-ID-Operation'] = operationId;
    if (measure) (options.headers ||= {})['X-ID-Measured-Action'] = measure;
    // Retry only the same versioned operation. The server's durable receipt is
    // committed atomically, so a lost response never produces a second write.
    let confirmed = false;
    for (let attempt = 0; ; attempt++) {
      let response;
      try { response = await window.fetch('/api/local/' + resource, options); }
      catch (error) {
        if (signal?.aborted) throw timeoutError();
        if (retryable && attempt < 1) continue;
        throw error;
      }
      timing?.response(response);
      let result;
      try { result = await response.json(); } catch { result = null; }
      if (signal?.aborted) throw timeoutError();
      if (sourceInvalidated) throw sourceError();
      if (!response.ok || result === null) {
        if (retryable && attempt < 1 && (response.status >= 500 || (response.ok && result === null))) continue;
        if (stepUp && !confirmed && response.status === 403 &&
            result?.code === 'SECURITY_CONFIRMATION_REQUIRED' && window.IDAccountSecurity) {
          confirmed = await window.IDAccountSecurity.verify();
          if (confirmed) {
            if (sourceInvalidated) throw sourceError();
            if (signal) options.signal = signal = AbortSignal.timeout(timeout);
            attempt--;
            continue;
          }
        }
        if (response.status === 401) {
          queries.clear();
          window.IDLocalAuth?.lock?.(result?.reason);
        }
        if (response.status === 409 && result?.code === 'DATA_SOURCE_CHANGED') {
          invalidateDataSource();
          window.IDChangeSync?.sourceChanged();
          throw sourceError();
        }
        const error = new Error(result?.error || result?.message || '本机数据接口未响应，请重试');
        error.status = response.status;
        if (typeof result?.code === 'string') error.code = result.code;
        if (Array.isArray(result?.matches)) error.matches = result.matches;
        throw error;
      }
      const scope = resource === 'finance/expense-receipts' ? expenseScope :
        resource.startsWith('finance/collection') ? 'finance-rates' : resource;
      observeResult(scope, result);
      return result;
    }
  }

  const readQuery = (resource, params, options) => request(resource, params, 'POST', { ...options, boundedRead: true });
  function invalidateDataSource() {
    sourceInvalidated = true;
    queries.invalidate();
  }

  function contactChange(action, before, after) {
    if (!before || !['新增资料', '修改资料'].includes(action)) return;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if ([...new Set([...Object.keys(before), ...Object.keys(after)])].some(key =>
      !['customers', 'tenants', 'logs'].includes(key) && !same(before[key], after[key]))) return;
    const changes = [];
    for (const list of ['customers', 'tenants']) {
      if (!Array.isArray(before[list]) || !Array.isArray(after[list])) return;
      const original = new Map(before[list].map(row => [row.id, row]));
      if (before[list].some(row => !after[list].some(next => next.id === row.id))) return;
      for (const row of after[list]) if (!same(original.get(row.id), row))
        changes.push({ list, before: original.get(row.id) || null, after: row });
    }
    if (changes.length !== 1 || Object.hasOwn(changes[0].after, 'initialCards') ||
        after.logs?.length !== before.logs?.length + 1 || !same(after.logs.slice(1), before.logs)) return;
    return { ...changes[0], log: after.logs[0] };
  }

  async function saveDocument(domain, version, data, { action, base, measure, timing } = {}) {
    const recordChange = domain === 'commerce' && contactChange(action, base, data);
    let payload = { version, data, action, ...(recordChange && { recordChange }) };
    let rules;
    if (supportsDocumentDelta && ['admin', 'super'].includes(actor?.role) && version > 0 && base &&
        !recordChange && ['commerce', 'inventory'].includes(domain)) {
      rules = await import('/modules/data/document-delta.mjs').catch(() => undefined);
      const delta = rules?.documentDelta(domain, base, data);
      if (delta) payload = { version, action, delta };
    }
    const result = await request(domain, payload, 'PUT', { measure, timing, stepUp: domain === 'settings' });
    if (!result.delta) return result;
    const committed = rules?.applyDocumentDelta(domain, base, result.delta);
    if (committed) return { ...result, data: committed };
    return { ...result, ...await request(domain, undefined, 'GET') };
  }

  let labels = new Map();
  let labelsRequest;
  function refreshOperatorLabels({ strict = false } = {}) {
    if (!authRequired || !actor) return Promise.resolve(false);
    labelsRequest ??= request('auth/display-names').then(({ items }) => {
      if (!Array.isArray(items)) return false;
      const changed = items.some(({ id, name }) => labels.get(id) !== name) || labels.size !== items.length;
      labels = new Map(items.map(({ id, name }) => [id, name]));
      return changed;
    }).finally(() => { labelsRequest = undefined; });
    return strict ? labelsRequest : labelsRequest.catch(() => false);
  }

  window.IDLocalData = Object.freeze({
    acceptChangeVersions,
    invalidateDataSource,
    clearChangeTracking() { observedVersions.clear(); serverVersions.clear(); pageBaseline.clear(); pendingInitialChanges.clear(); },
    pendingChangeVersions(scopes) {
      return Object.fromEntries(scopes.filter(scope => serverVersions.has(scope) &&
        (pendingInitialChanges.has(scope) || newer(serverVersions.get(scope), observedVersions.get(scope))))
        .map(scope => [scope, serverVersions.get(scope)]));
    },
    acknowledgeChanges(versions) {
      for (const [scope, version] of Object.entries(versions)) {
        if (serverVersions.get(scope) !== version) continue;
        pendingInitialChanges.delete(scope);
        if (!['inventory', 'commerce', 'settings', 'appleBalance', 'toolbox'].includes(scope) &&
            newer(version, observedVersions.get(scope)))
          observedVersions.set(scope, version);
      }
    },
    subscribeChanges(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    writesPending: matches => matches
      ? Array.from(pendingWrites).some(scopes => scopes.some(matches))
      : pendingWrites.size > 0,
    authRequired,
    canApproveRechargeCodes,
    actor: () => actor && ({ ...actor, name: labels.get(actor.id) || actor.name }),
    queries,
    operatorLabel: (id, fallback) => labels.get(id) || fallback || '',
    refreshOperatorLabels,
    saveColumnPreference: (change) => request('column-preferences', { ...change, actorId: actor?.id }, 'PATCH', { keepalive: true }),
    orderCards: () => request('order-cards'),
    cardTypes: () => request('card-types'),
    cardTypeAction: (command) => write(['card-types'], () => request('card-types', command, 'POST', { stepUp: true })),
    subscriptionCardEstimates: () => request('subscription-card-estimates?includeNext=1'),
    subscriptionCardStatus: ({ stepUp = false } = {}) =>
      request('subscription-card-status?includeDetails=1', undefined, 'GET', { stepUp }),
    renewalCardStatus: (orderId, version) => request('subscription-card-status?' + new URLSearchParams({
      orderId, ...(version !== undefined && { version })
    })),
    subscriptionCardAccounts: (command) =>
      request('subscription-card-status', { action: 'accounts', ...command }, 'POST', { stepUp: true }),
    subscriptionCardFreeze: (command) => write(['order-card-freeze', 'order-cards', 'tenant-cards'],
      () => request('subscription-card-status', command, 'POST', { stepUp: true })),
    subscriptionCardDetails: (command) => readQuery('subscription-card-details', command),
    revealSubscriptionCard: (orderId, version) =>
      request('subscription-card-reveal', { orderId, version }, 'POST', { stepUp: true }),
    copySubscriptionCard: (orderId, cardId, { context, version } = {}) =>
      request('subscription-card-copy', { orderId, cardId, context, version }, 'POST', { stepUp: true }),
    claudeGoogleSubscriptions: (params) => readQuery('claude-google-subscriptions/list', params),
    subscriptions: (params) => readQuery('subscriptions/list', params),
    subscriptionOwnerLookup: (order) => request('subscriptions/lookup', { order }, 'POST'),
    subscriptionCopy: (command) => request('subscriptions/copy', command, 'POST'),
    renewalContactCopy: command => request('subscriptions/contact-copy', command, 'POST'),
    renewalContactSettings: command => command === undefined
      ? readQuery('subscriptions/renewal-settings', {})
      : write(['subscription-management'], () => request('subscriptions/renewal-settings', command, 'POST', { writeTimeout: 15_000 })),
    renewalCard: command => command.action === 'bind'
      ? write(['subscription-management'], () => request('subscription-renewal-card', command, 'POST', { stepUp: true }))
      : command.action === 'prepare' ? readQuery('subscription-renewal-card', command)
        : request('subscription-renewal-card', command, 'POST', { stepUp: command.action === 'copy' }),
    renewalHandoffs: (view, id) => request('renewals?' + new URLSearchParams({ view, ...(id && { id }) })),
    renewalSidebar: () => request('renewal-sidebar'),
    saveRenewalHandoff: (command, options) => write(['renewal-handoffs',
      ...(command.action === 'finish' ? ['commerce', 'appleBalance'] : [])],
      () => request('renewals', command, 'POST', options)),
    subscriptionConfirm: (command) => write(['subscription-management'], () => request('subscriptions/confirm', command, 'POST')),
    subscriptionOwner: (command) => write(['subscription-management'], () => request('subscriptions/owner', command, 'POST')),
    claudeHistoryIntake: (command) => command.mode === 'preview'
      ? request('claude-history-intake', command, 'POST')
      : write(['inventory'], () => request('claude-history-intake', command, 'POST')),
    claudeHistoricalSaleAccounts: () => request('claude-history-intake', { mode: 'sales-candidates' }, 'POST'),
    saveClaudeHistoricalSale: (command) => write(['commerce'],
      () => request('claude-history-intake', { ...command, mode: 'record-sale' }, 'POST')),
    employeeStatistics: (params) => request('employee-statistics?' + new URLSearchParams(params)),
    systemMonitoring: (params) => request('system-monitoring?' + new URLSearchParams(params)),
    systemMonitoringAction: (command) => write(['system-monitoring'], () => request('system-monitoring', command, 'POST')),
    copyClaudeGoogleSubscription: (command) => request('claude-google-subscriptions/copy', command, 'POST'),
    claudeGoogleCopySettings: () => request('claude-google-subscriptions/copy-settings'),
    saveClaudeGoogleCopySettings: (command) =>
      write(['tools/mailbox-delivery'], () => request('claude-google-subscriptions/copy-settings', command)),
    orderOwners: () => request('auth/order-owners'),
    tenantOwnerTransfer: (tenantId) => request('tenant-owner-transfer?tenantId=' + encodeURIComponent(tenantId)),
    transferTenantOwner: (command) => write(['commerce'], () => request('tenant-owner-transfer', command, 'POST')),
    tenantCards: (tenantId) => request('tenant-cards?tenantId=' + encodeURIComponent(tenantId)),
    tenantCardAction: (command) => ['copy', 'reveal', 'lookup'].includes(command.action)
      ? request('tenant-cards', command, 'POST')
      : write(['commerce', 'order-cards', 'tenant-cards'], () => request('tenant-cards', command, 'POST')),
    rechargeCodeRequests: () => request('recharge-codes'),
    async rechargeCodePendingSummary() {
      const result = await request('recharge-codes?view=pending-summary');
      observeResult('recharge-codes', result);
      return result;
    },
    rechargeCodes: () => request('recharge-codes?view=codes'),
    rechargeActivity: (page = 1) => request('recharge-activity?page=' + encodeURIComponent(page)),
    rechargeActivityDetail: id => request('recharge-activity/' + encodeURIComponent(id)),
    readRechargeActivity: (id, event) =>
      request('recharge-activity/' + encodeURIComponent(id) + '/read?event=' + encodeURIComponent(event), {}, 'POST'),
    rechargeCodeAction: (command) => write(['recharge-codes'], () => request('recharge-codes', command, 'POST')),
    orderCompletion: (params) => request('order-completion' + (params ? '?' + new URLSearchParams(params) : '')),
    saveOrderCompletion: (command) => write(['commerce'], () => request('order-completion', command, 'POST')),
    orderSync: (command) => command.mode === 'preview'
      ? request('order-sync', command, 'POST')
      : write(['order-sync', 'commerce', 'inventory', 'recharge-codes'], () => request('order-sync', command, 'POST')),
    load: (domain, options) => request(domain, undefined, 'GET', options),
    staffWorkspace: (resource, body, operationId) => request('staff/' + resource, body, body === undefined ? 'GET' : 'POST',
      { operationId, retryWrite: false }),
    expenseReceipts: () => request('finance/expense-receipts'),
    saveExpenseReceipt: command => write([expenseScope],
      () => request('finance/expense-receipts', command, 'POST', { writeTimeout: 15_000 })),
    siteManagement: (params) => request('site-management?' + new URLSearchParams(params)),
    async siteExport(filter, operationId) {
      if (sourceInvalidated) throw sourceError();
      const response = await window.fetch('/api/local/site-management/export', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-ID-Operation': operationId,
          ...(dataSource && { 'X-ID-Data-Source': dataSource }) },
        body: JSON.stringify(filter)
      });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/csv')) {
        const result = await response.json().catch(() => null);
        if (response.status === 401) window.IDLocalAuth?.lock?.(result?.reason);
        if (response.status === 409 && result?.code === 'DATA_SOURCE_CHANGED') {
          invalidateDataSource();
          window.IDChangeSync?.sourceChanged();
          throw sourceError();
        }
        throw Object.assign(new Error(result?.error || '资料暂时无法下载，请重试'), { status: response.status });
      }
      return { content: await response.blob(), count: Number(response.headers.get('X-ID-Export-Count')) };
    },
    financeCollection: (params) => request('finance/collection?' + new URLSearchParams(params)),
    financeCollectionAction: (command) => command.action === 'cleanup-preview'
      ? request('finance/collection', command, 'POST')
      : write(['finance-rates'], () => request('finance/collection', command, 'POST', { stepUp: true })),
    changeAccountLifecycle: (data) => write(['inventory', 'commerce'], () => request('inventory/account-lifecycle', data)),
    save: (domain, version, data, options) => write([domain], () => saveDocument(domain, version, data, options)),
    saveBatch: (entries, options) => write(entries.map((entry) => entry.domain), () =>
      request('batch', entries, 'PUT', { ...options, stepUp: entries.some(entry => entry.domain === 'settings') })),
    audit: () => request('audit'),
    auditPage: (params) => request('audit/page?' + new URLSearchParams(params)),
    relay(operation, data) {
      const send = () => request('apple-relay/' + operation, data, 'POST');
      if (operation === 'alias-intake-confirm') return write(['inventory', 'commerce', 'apple-relay'], send);
      return ['primary-save', 'primary-import', 'alias-register', 'code-reset-confirm', 'mail-reassign-confirm'].includes(operation)
        ? write(['inventory', 'apple-relay', 'tools/mailbox-pool'], send) : send();
    },
    saveBitBrowserAddresses: (data) => write(['bitbrowser-addresses'], () => request('bitbrowser-addresses', data)),
    startMicrosoftMailbox: (data) => request('tools/mailbox-microsoft/start', data, 'POST'),
    finishMicrosoftMailbox: (authorizationId) => write(['tools/mailbox-pool'], () => request('tools/mailbox-microsoft/finish', { authorizationId }, 'POST')),
    customerQuery: (action, command, options) => readQuery('customer-query/' + action, command, options),
    mailboxDeliverySettings: () => request('tools/mailbox-delivery'),
    saveMailboxDeliverySettings: (data) => write(['tools/mailbox-delivery'], () => request('tools/mailbox-delivery', data)),
    copyGoogleMailboxCredentials: (data) => request('tools/mailbox-delivery', data, 'POST', { stepUp: true }),
    resetMailboxDelivery: (scope, data, operationId) => scope === 'relay'
      ? write(['apple-relay'], () => request('apple-relay/code-delivery-reset', data, 'POST', { operationId }))
      : write(['tools/mailbox-pool'], () => request('tools/mailbox-pool', { action: 'rotate-delivery', scope, ...data }, 'PUT', { operationId })),
    managedMailboxPool: () => request('tools/mailbox-pool'),
    managedMailboxCode: (id) => request('tools/mailbox-pool', { id }, 'POST'),
    managedMailboxCodePage: (ids, version) => readQuery('tools/mailbox-pool', { ids, version }),
    saveManagedMailboxPool: (data) => write(['tools/mailbox-pool'], () => request('tools/mailbox-pool', data)),
    registrationMailboxChoices: (id) => request('tools/mailbox-pool/registration-access?' + new URLSearchParams({ id })),
    assignRegistrationMailbox: (data) => write(['tools/mailbox-pool', 'inventory'],
      () => request('tools/mailbox-pool/registration-access', data, 'POST', { stepUp: true })),
    async queryManagedMailbox(queryCode, limit) {
      const legacy = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{20}$/.test(queryCode);
      if (legacy || queryCode.startsWith('MBX-')) {
        try {
          return { ...await request('tools/mailbox-query', { queryCode, limit }, 'POST'), supportsUpdates: true };
        } catch (error) {
          if (!legacy || error.status !== 404) throw error;
          try {
            return await request('apple-relay/public-query', { queryCode }, 'POST');
          } catch {
            throw error;
          }
        }
      }
      return request('apple-relay/public-query', { queryCode }, 'POST');
    },
    watchManagedMailbox,
    savedTotp: () => request('saved-totp'),
    saveTotp: (data) => write(['saved-totp'], () => request('saved-totp', data)),
    savedTotpCodePage: (ids, version) => readQuery('saved-totp/code', { ids, version }),
    savedTotpSecret: (id, version) => request('saved-totp/secret', { id, version }, 'POST', { stepUp: true }),
    websiteVisits: (filters) => readQuery('tools/website-visits/search', filters),
    websiteVisitIp: (id) => request('tools/website-visits/reveal', { id }, 'POST'),
    websiteAnalytics: (days, site) => request('tools/website-analytics?' + new URLSearchParams(site ? { days, site } : { days })),
    sheetsStatus: () => request('tools/sheets-status'),
    websiteMonitor: (url) => request('tools/website-monitor', { url }, 'POST'),
    resolveMedia: (url) => request('tools/media/resolve', { url }, 'POST'),
    async downloadMedia(token, signal) {
      const response = await window.fetch('/api/local/tools/media/download?token=' + encodeURIComponent(token), {
        cache: 'no-store', signal
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        if (response.status === 401 && authRequired) window.IDLocalAuth?.lock?.();
        throw new Error(result?.error || '无法下载作品，请重新解析后重试');
      }
      return response;
    }
  });
})();
