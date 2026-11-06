(() => {
  'use strict';

  const authRequired = document.querySelector('meta[name="id-local-auth"]')?.content === 'required';
  const encodedActor = document.querySelector('meta[name="id-local-actor"]')?.content;
  const actor = authRequired
    ? encodedActor
      ? Object.freeze(JSON.parse(decodeURIComponent(encodedActor)))
      : null
    : Object.freeze({ id: 'local-operator', name: '本机操作员', role: 'admin' });

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
      if (response.status === 401) window.IDLocalAuth?.lock?.();
      const error = new Error(result?.error || result?.message || '本机数据接口未响应，请重试');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  window.IDLocalData = Object.freeze({
    authRequired,
    actor: () => actor,
    load: (domain) => request(domain),
    save: (domain, version, data, { action } = {}) => request(domain, { version, data, action }),
    saveBatch: (entries) => request('batch', entries),
    audit: () => request('audit'),
    relay: (operation, data) => request('apple-relay/' + operation, data, 'POST'),
    saveBitBrowserAddresses: (data) => request('bitbrowser-addresses', data),
    startMicrosoftMailbox: (data) => request('tools/mailbox-microsoft/start', data, 'POST'),
    finishMicrosoftMailbox: (authorizationId) => request('tools/mailbox-microsoft/finish', { authorizationId }, 'POST'),
    managedMailboxPool: () => request('tools/mailbox-pool'),
    managedMailboxCode: (id) => request('tools/mailbox-pool', { id }, 'POST'),
    saveManagedMailboxPool: (data) => request('tools/mailbox-pool', data),
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
    saveTotp: (data) => request('saved-totp', data),
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
