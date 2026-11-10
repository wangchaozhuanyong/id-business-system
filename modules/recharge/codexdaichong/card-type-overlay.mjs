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
    const options = [];
    for (const item of payload.items) {
      if (!item || typeof item.id !== 'string' || !item.id ||
          typeof item.name !== 'string' || !item.name.trim() ||
          typeof item.active !== 'boolean' || types.has(item.id)) {
        throw new Error('银行卡类型返回无效');
      }
      types.set(item.id, item.name);
      if (item.active) options.push({ id: item.id, name: item.name });
    }
    const assignments = new Map();
    for (const [id, typeId] of Object.entries(payload.assignments)) {
      if (/^recharge:[1-9]\d{0,19}$/.test(id) && typeof typeId === 'string' && types.has(typeId))
        assignments.set(id, typeId);
    }
    return { version: payload.version, types, options, assignments };
  }

  function acceptedNumbers(cards, receipt) {
    const counts = [receipt?.imported, receipt?.skipped, receipt?.failed];
    const failures = receipt?.failures;
    if (receipt?.success !== true ||
        counts.some(count => !Number.isSafeInteger(count) || count < 0 || count > cards.length) ||
        counts.reduce((sum, count) => sum + count, 0) !== cards.length ||
        !Array.isArray(failures) || failures.length !== receipt.failed)
      throw new Error('卡池导入结果待核对，请先刷新列表');
    const rejected = new Set(failures.map(item => item?.index));
    if (rejected.size !== receipt.failed || [...rejected].some(index =>
      !Number.isSafeInteger(index) || index < 0 || index >= cards.length))
      throw new Error('卡池导入结果待核对，请先刷新列表');
    return new Set(cards.flatMap((card, index) => rejected.has(index) ? [] :
      [card.card_number.replace(/[\s-]+/g, '')]));
  }

  function matchCardIds(numbers, cards) {
    const matches = new Map();
    for (const card of cards) {
      const number = card.card_number;
      if (!numbers.has(number)) continue;
      matches.set(number, matches.has(number) ? '' : cardKey(card.id));
    }
    const cardIds = [...new Set([...matches.values()].filter(Boolean))];
    return { cardIds, missing: numbers.size - cardIds.length };
  }

  function refresh() {
    if (pending) return pending;
    state = 'loading';
    pending = Promise.resolve().then(fetchSettings).then((payload) => {
      const next = parseSettings(payload);
      if (!snapshot || next.version >= snapshot.version) snapshot = next;
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
    acceptedNumbers,
    matchCardIds,
    refresh,
    invalidate,
    get version() { return state === 'ready' ? snapshot.version : null; },
    get options() { return snapshot?.options || []; },
    get failed() { return state === 'failed'; },
    get status() {
      if (state === 'loading') return '正在读取银行卡类型…';
      if (state === 'failed')
        return snapshot ? '银行卡类型刷新失败，已保留上次结果。' : '银行卡类型读取失败。';
      return '';
    },
    label(key) {
      if (!key) return '未设置';
      if (snapshot) return snapshot.types.get(snapshot.assignments.get(key)) || '未设置';
      return state === 'failed' ? '读取失败' : '加载中…';
    },
    typeId(key) { return snapshot?.assignments.get(key) || ''; }
  };
}
