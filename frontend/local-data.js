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
  let pendingWrites = 0;
  const revisionScopes = new Set(['inventory', 'commerce', 'settings', 'appleBalance', 'toolbox', 'saved-totp',
    'bitbrowser-connections', 'bitbrowser-proxies', 'bitbrowser-addresses', 'tenant-cards', 'recharge-codes',
    'order-sync', 'tools/mailbox-pool', 'tools/website-visits', 'apple-relay', 'operators', 'audit', 'finance-rates', 'card-types',
    'order-card-freeze', 'subscription-management', 'system-monitoring', 'recharge-card-plans']);
  const newer = (incoming, observed) => observed === undefined ||
    (/^\d+$/.test(incoming) && /^\d+$/.test(observed)
      ? BigInt(incoming) > BigInt(observed) : incoming !== observed);
  function publishChanges(scopes) {
    if (!scopes.length) return;
    const expanded = new Set(scopes);
    if (scopes.some(scope => ['inventory', 'commerce', 'settings', 'appleBalance'].includes(scope)) ||
        (canApproveRechargeCodes && scopes.includes('recharge-codes'))) expanded.add('overview');
    if (scopes.includes('inventory')) { expanded.add('appleBalance'); expanded.add('apple-relay'); expanded.add('tools/mailbox-pool'); }
    if (scopes.includes('operators')) expanded.add('order-owners');
    queries.invalidate([...expanded]);
    for (const listener of changeListeners) {
      try { listener([...scopes]); } catch { /* Notifications cannot fail a completed operation. */ }
    }
  }
  function acceptChangeVersions(versions, { reconcile = false } = {}) {
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return;
    const changed = [];
    for (const [scope, version] of Object.entries(versions)) {
      if (!revisionScopes.has(scope) || typeof version !== 'string' || !version || version.length > 128) continue;
      const previous = serverVersions.get(scope), observed = observedVersions.get(scope);
      serverVersions.set(scope, version);
      if (!reconcile && previous === version) continue;
      if (observed !== undefined ? newer(version, observed) : previous !== undefined && version !== previous) changed.push(scope);
    }
    publishChanges(changed);
  }
  function observeResult(resource, result) {
    if (resource === 'batch' && Array.isArray(result)) {
      for (const entry of result) observeResult(entry.domain, entry);
      return;
    }
    if (!revisionScopes.has(resource) || !Number.isSafeInteger(result?.version)) return;
    const version = String(result.version), previous = observedVersions.get(resource);
    if (previous === undefined || !newer(previous, version)) observedVersions.set(resource, version);
    const expected = serverVersions.get(resource);
    if (expected !== undefined && newer(expected, observedVersions.get(resource))) publishChanges([resource]);
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
      const started = Date.now();
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
          const { done, value } = await reader.read();
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
            if (data.version > version) { version = data.version; onChange?.(); }
          }
        }
      } catch (error) {
        if (!current()) return;
        if (Date.now() - started > 30_000) failures = 0;
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
    pendingWrites++;
    try {
      const result = await operation();
      queries.invalidate([...scopes, ...(scopes.includes('inventory') ? ['tools/mailbox-pool', 'appleBalance'] : []), 'overview', 'audit']);
      return result;
    } finally {
      pendingWrites--;
      if (!pendingWrites) Promise.resolve().then(() => window.dispatchEvent?.(new Event('id-data-write-idle')));
    }
  }

  async function request(resource, data, method = 'PUT', { keepalive = false } = {}) {
    const options =
      data === undefined
        ? { cache: 'no-store' }
        : {
            method,
            keepalive,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          };
    const receiptWrite = data !== undefined && method === 'PUT' &&
      ['commerce', 'inventory', 'settings', 'appleBalance', 'batch'].includes(resource);
    const operationId = receiptWrite && window.crypto?.randomUUID?.();
    if (operationId) options.headers['X-ID-Operation'] = operationId;
    // Retry only the same versioned operation. The server's durable receipt is
    // committed atomically, so a lost response never produces a second write.
    for (let attempt = 0; ; attempt++) {
      let response;
      try { response = await window.fetch('/api/local/' + resource, options); }
      catch (error) {
        if (operationId && attempt < 1) continue;
        throw error;
      }
      let result;
      try { result = await response.json(); } catch { result = null; }
      if (!response.ok || result === null) {
        if (operationId && attempt < 1 && (response.status >= 500 || (response.ok && result === null))) continue;
        if (response.status === 401) {
          queries.clear();
          window.IDLocalAuth?.lock?.(result?.reason);
        }
        const error = new Error(result?.error || result?.message || '本机数据接口未响应，请重试');
        error.status = response.status;
        if (Array.isArray(result?.matches)) error.matches = result.matches;
        throw error;
      }
      observeResult(resource.startsWith('finance/collection') ? 'finance-rates' : resource, result);
      return result;
    }
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

  let labels = new Map();
  let labelsRequest;
  function refreshOperatorLabels() {
    if (!authRequired || !actor) return Promise.resolve(false);
    labelsRequest ??= request('auth/display-names').then(({ items }) => {
      if (!Array.isArray(items)) return false;
      const changed = items.some(({ id, name }) => labels.get(id) !== name) || labels.size !== items.length;
      labels = new Map(items.map(({ id, name }) => [id, name]));
      return changed;
    }).catch(() => false).finally(() => { labelsRequest = undefined; });
    return labelsRequest;
  }

  window.IDLocalData = Object.freeze({
    acceptChangeVersions,
    clearChangeTracking() { observedVersions.clear(); serverVersions.clear(); },
    pendingChangeVersions(scopes) {
      return Object.fromEntries(scopes.filter(scope => serverVersions.has(scope) &&
        newer(serverVersions.get(scope), observedVersions.get(scope))).map(scope => [scope, serverVersions.get(scope)]));
    },
    acknowledgeChanges(versions) {
      for (const [scope, version] of Object.entries(versions)) {
        if (!['inventory', 'commerce', 'settings', 'appleBalance', 'toolbox'].includes(scope) &&
            serverVersions.get(scope) === version && newer(version, observedVersions.get(scope)))
          observedVersions.set(scope, version);
      }
    },
    subscribeChanges(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    writesPending: () => pendingWrites > 0,
    authRequired,
    canApproveRechargeCodes,
    actor: () => actor && ({ ...actor, name: labels.get(actor.id) || actor.name }),
    queries,
    operatorLabel: (id, fallback) => labels.get(id) || fallback || '',
    refreshOperatorLabels,
    saveColumnPreference: (change) => request('column-preferences', { ...change, actorId: actor?.id }, 'PATCH', { keepalive: true }),
    orderCards: () => request('order-cards'),
    cardTypes: () => request('card-types'),
    cardTypeAction: (command) => write(['card-types'], () => request('card-types', command, 'POST')),
    subscriptionCardEstimates: () => request('subscription-card-estimates?includeNext=1'),
    subscriptionCardStatus: () => request('subscription-card-status'),
    renewalCardStatus: (orderId, version) => request('subscription-card-status?' + new URLSearchParams({
      orderId, ...(version !== undefined && { version })
    })),
    subscriptionCardAccounts: (command) => request('subscription-card-status', { action: 'accounts', ...command }, 'POST'),
    subscriptionCardFreeze: (command) => write(['order-card-freeze', 'order-cards', 'tenant-cards'],
      () => request('subscription-card-status', command, 'POST')),
    subscriptionCardDetails: (command) => request('subscription-card-details', command, 'POST'),
    revealSubscriptionCard: (orderId, version) => request('subscription-card-reveal', { orderId, version }, 'POST'),
    copySubscriptionCard: (orderId, cardId, { context, version } = {}) =>
      request('subscription-card-copy', { orderId, cardId, context, version }, 'POST'),
    claudeGoogleSubscriptions: (params) => request('claude-google-subscriptions/list', params, 'POST'),
    subscriptions: (params) => request('subscriptions/list', params, 'POST'),
    subscriptionOwnerLookup: (order) => request('subscriptions/lookup', { order }, 'POST'),
    subscriptionCopy: (command) => request('subscriptions/copy', command, 'POST'),
    renewalContactCopy: command => request('subscriptions/contact-copy', command, 'POST'),
    renewalContactSettings: (suffix) => suffix === undefined
      ? request('subscriptions/renewal-settings', {}, 'POST')
      : write(['subscription-management'], () => request('subscriptions/renewal-settings', { suffix }, 'POST')),
    renewalCard: command => command.action === 'bind'
      ? write(['subscription-management'], () => request('subscription-renewal-card', command, 'POST'))
      : request('subscription-renewal-card', command, 'POST'),
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
      write([], () => request('claude-google-subscriptions/copy-settings', command)),
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
    load: (domain) => request(domain),
    financeCollection: (params) => request('finance/collection?' + new URLSearchParams(params)),
    financeCollectionAction: (command) => command.action === 'cleanup-preview'
      ? request('finance/collection', command, 'POST')
      : write(['finance-rates'], () => request('finance/collection', command, 'POST')),
    changeAccountLifecycle: (data) => write(['inventory', 'commerce'], () => request('inventory/account-lifecycle', data)),
    save: (domain, version, data, { action, base } = {}) => write([domain], () => request(domain, {
      version, data, action, ...(domain === 'commerce' && { recordChange: contactChange(action, base, data) })
    })),
    saveBatch: (entries) => write(entries.map((entry) => entry.domain), () => request('batch', entries)),
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
    managedMailboxPool: () => request('tools/mailbox-pool'),
    managedMailboxCode: (id) => request('tools/mailbox-pool', { id }, 'POST'),
    managedMailboxCodePage: (ids, version) => request('tools/mailbox-pool', { ids, version }, 'POST'),
    saveManagedMailboxPool: (data) => write(['tools/mailbox-pool'], () => request('tools/mailbox-pool', data)),
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
    savedTotpCodePage: (ids, version) => request('saved-totp/code', { ids, version }, 'POST'),
    savedTotpSecret: (id, version) => request('saved-totp/secret', { id, version }, 'POST'),
    websiteVisits: (filters) => request('tools/website-visits/search', filters, 'POST'),
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
