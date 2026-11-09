export function createRechargeCardTypeOverlay({ fetchSettings, onChange }) {
  let snapshot = null;
  let pending = null;
  let queued = null;
  let state = 'idle';

  function cardKey(id) {
    const numeric = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
    return typeof numeric === 'string' && /^[1-9]\d{0,19}$/.test(numeric)
      ? 'recharge:' + numeric
      : '';
  }

  function parseSettings(payload) {
    if (!Number.isSafeInteger(payload?.version) || payload.version < 0 ||
        !Array.isArray(payload.items) || !payload.assignments ||
        typeof payload.assignments !== 'object' || Array.isArray(payload.assignments)) {
      throw new Error('银行卡类型返回无效');
    }
    const types = new Map();
    for (const item of payload.items) {
      if (!item || typeof item.id !== 'string' || !item.id ||
          typeof item.name !== 'string' || !item.name.trim() ||
          typeof item.active !== 'boolean' || types.has(item.id)) {
        throw new Error('银行卡类型返回无效');
      }
      types.set(item.id, item.name);
    }
    const names = new Map();
    for (const [id, typeId] of Object.entries(payload.assignments)) {
      if (/^recharge:[1-9]\d{0,19}$/.test(id) && typeof typeId === 'string' && types.has(typeId))
        names.set(id, types.get(typeId));
    }
    return names;
  }

  function refresh() {
    if (pending) return pending;
    state = 'loading';
    pending = Promise.resolve().then(fetchSettings).then((payload) => {
      snapshot = parseSettings(payload);
      state = 'ready';
    }).catch(() => {
      state = 'failed';
    }).finally(() => {
      pending = null;
      onChange();
    });
    onChange();
    return pending;
  }

  function invalidate() {
    if (!pending) return refresh();
    // A read already in flight may have captured the version before the notification.
    queued ??= pending.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }

  return {
    cardKey,
    refresh,
    invalidate,
    get failed() { return state === 'failed'; },
    get status() {
      if (state === 'loading') return '正在读取银行卡类型…';
      if (state === 'failed')
        return snapshot ? '银行卡类型刷新失败，已保留上次结果。' : '银行卡类型读取失败。';
      return '';
    },
    label(key) {
      if (!key) return '未设置';
      if (snapshot) return snapshot.get(key) || '未设置';
      return state === 'failed' ? '读取失败' : '加载中…';
    }
  };
}
