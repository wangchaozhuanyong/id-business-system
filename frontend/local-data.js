(() => {
  'use strict';

  const authRequired = document.querySelector('meta[name="id-local-auth"]')?.content === 'required';
  const encodedActor = document.querySelector('meta[name="id-local-actor"]')?.content;
  const actor = authRequired
    ? encodedActor
      ? Object.freeze(JSON.parse(decodeURIComponent(encodedActor)))
      : null
    : Object.freeze({ id: 'local-operator', name: '本机操作员', role: 'admin' });

  const queryEntries = new Map();
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
      queryEntries.clear();
    }
  });

  async function write(scopes, operation) {
    const result = await operation();
    queries.invalidate([...scopes, 'overview', 'audit']);
    return result;
  }

  async function request(resource, data, method = 'PUT') {
    const options =
      data === undefined
        ? { cache: 'no-store' }
        : {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          };
    const response = await window.fetch('/api/local/' + resource, options);
    let result;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (!response.ok || result === null) {
      if (response.status === 401) {
        queries.clear();
        window.IDLocalAuth?.lock?.();
      }
      const error = new Error(result?.error || result?.message || '本机数据接口未响应，请重试');
      error.status = response.status;
      throw error;
    }
    return result;
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
    authRequired,
    actor: () => actor && ({ ...actor, name: labels.get(actor.id) || actor.name }),
    queries,
    operatorLabel: (id, fallback) => labels.get(id) || fallback || '',
    refreshOperatorLabels,
    orderCards: () => request('order-cards'),
    orderOwners: () => request('auth/order-owners'),
    tenantCards: (tenantId) => request('tenant-cards?tenantId=' + encodeURIComponent(tenantId)),
    tenantCardAction: (command) => ['copy', 'reveal'].includes(command.action)
      ? request('tenant-cards', command, 'POST')
      : write(['commerce', 'order-cards', 'tenant-cards'], () => request('tenant-cards', command, 'POST')),
    rechargeCodeRequests: () => request('recharge-codes'),
    rechargeCodes: () => request('recharge-codes?view=codes'),
    rechargeCodeAction: (command) => write(['recharge-codes'], () => request('recharge-codes', command, 'POST')),
    orderSyncStatus: () => request('order-sync'),
    orderSync: (command) => command.mode === 'preview'
      ? request('order-sync', command, 'POST')
      : write(['order-sync', 'commerce', 'inventory', 'recharge-codes'], () => request('order-sync', command, 'POST')),
    load: (domain) => request(domain),
    save: (domain, version, data, { action } = {}) => write([domain], () => request(domain, { version, data, action })),
    saveBatch: (entries) => write(entries.map((entry) => entry.domain), () => request('batch', entries)),
    audit: () => request('audit'),
    relay: (operation, data) => ['primary-save', 'primary-import', 'alias-register', 'code-reset-confirm', 'mail-reassign-confirm'].includes(operation)
      ? write(['inventory', 'apple-relay', 'tools/mailbox-pool'], () => request('apple-relay/' + operation, data, 'POST'))
      : request('apple-relay/' + operation, data, 'POST'),
    saveBitBrowserAddresses: (data) => write(['bitbrowser-addresses'], () => request('bitbrowser-addresses', data)),
    startMicrosoftMailbox: (data) => request('tools/mailbox-microsoft/start', data, 'POST'),
    finishMicrosoftMailbox: (authorizationId) => write(['tools/mailbox-pool'], () => request('tools/mailbox-microsoft/finish', { authorizationId }, 'POST')),
    managedMailboxPool: () => request('tools/mailbox-pool'),
    managedMailboxCode: (id) => request('tools/mailbox-pool', { id }, 'POST'),
    saveManagedMailboxPool: (data) => write(['tools/mailbox-pool'], () => request('tools/mailbox-pool', data)),
    async queryManagedMailbox(queryCode, limit) {
      const legacy = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{20}$/.test(queryCode);
      if (legacy || queryCode.startsWith('MBX-')) {
        try {
          return await request('tools/mailbox-query', { queryCode, limit }, 'POST');
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
    savedTotp: () => request('saved-totp'),
    saveTotp: (data) => write(['saved-totp'], () => request('saved-totp', data)),
    savedTotpCode: (id) => request('saved-totp/code', { id }, 'POST'),
    websiteVisits: (filters) => request('tools/website-visits/search', filters, 'POST'),
    websiteVisitIp: (id) => request('tools/website-visits/reveal', { id }, 'POST'),
    websiteAnalytics: (days) => request('tools/website-analytics?days=' + days),
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
