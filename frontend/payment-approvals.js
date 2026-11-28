(() => {
  'use strict';
  const A = window.IDDesignAPI;
  if (!A || !window.IDLocalData?.authRequired) return;
  const toast = document.getElementById('payment-approval-toast');
  const drawer = document.getElementById('drawer');
  const endpoint = '/integrations/codexdaichong/api/admin/payment-approvals';
  const escape = A.esc, seen = new Set(), deferred = new Set(), busy = new Set();
  let rows = [], generation = 0, expiry, version, stopped = false, available = false, error = '', retry, failures = 0;
  const permitted = () => !stopped && A.state.actor?.role === 'super';
  const panel = () => drawer.open && drawer.querySelector('[data-payment-approval-list]');
  function button(label, action, id = '') {
    return '<button type="button" class="button compact" data-action="payment-approval-' + action + '" data-id="' +
      escape(id) + '"' + (busy.has(id) ? ' disabled' : '') + '>' + escape(label) + '</button>';
  }
  function speak(text) {
    if (document.hidden || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    const phrase = new SpeechSynthesisUtterance(text);
    phrase.lang = 'zh-CN';
    window.speechSynthesis.speak(phrase);
  }
  async function announce(items) {
    const fresh = items.filter(row => !seen.has(row.id) && row.expires > Date.now());
    if (!fresh.length || document.hidden) return;
    for (const row of fresh) seen.add(row.id);
    const say = () => {
      if (!permitted() || document.hidden) return;
      let count = fresh.length;
      // Only opaque reminder IDs are shared for deduplication across tabs.
      try {
        const key = 'payment-approval-voice:' + A.state.actor.id;
        const recent = JSON.parse(localStorage.getItem(key) || '[]').filter(item => item.expires > Date.now());
        const unread = fresh.filter(row => row.expires > Date.now() && !recent.some(item => item.id === row.id));
        count = unread.length;
        if (!count) return;
        recent.push(...unread.map(({ id, expires }) => ({ id, expires })));
        localStorage.setItem(key, JSON.stringify(recent.slice(-80)));
      } catch { /* Private browsing still gets this tab's once-only reminder. */ }
      speak(count === 1 ? '有新的充值订单等待确认付款，请查看右下角。' : '有' + count + '笔新的充值订单等待确认付款。');
    };
    if (navigator.locks) await navigator.locks.request('recharge-payment-voice', say).catch(() => {});
    else say();
  }
  function card(row, inList) {
    const fields = [['套餐', ({ plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500', pro_5x: 'Pro 100', pro_20x: 'Pro 200', pro_50x: 'Pro 500' })[row.plan] || row.plan],
      ['本次应付', row.currency + ' ' + row.amount], ['客户邮箱', row.email || '未提供'],
      ['充值码尾号', row.codeTail || '—'], ['任务尾号', row.jobTail],
      ['确认截止', new Date(row.expires).toLocaleTimeString('zh-CN', { hour12: false })]];
    return '<dl class="recharge-activity-fields">' + fields.map(([k,v]) =>
      '<dt>' + k + '</dt><dd>' + escape(v) + '</dd>').join('') + '</dl>' +
      (row.amount === '0.00' ? '<p>本次应付为 0，确认后将提交订阅开通。</p>' : '') +
      '<div class="recharge-activity-toast-actions">' +
      button('确认付款', 'approve', row.id) + (inList ? button('结束本次验证（不付款）', 'cancel', row.id) :
        button('稍后处理', 'defer', row.id) + button('查看待确认（' + rows.length + '）', 'open')) + '</div>';
  }
  function render() {
    clearTimeout(expiry);
    rows = rows.filter(row => row.expires > Date.now());
    const row = rows.find(item => !deferred.has(item.id));
    const target = panel();
    if (target) target.innerHTML = (error ? '<p role="alert">' + escape(error) + '</p>' : '') +
      (rows.length ? rows.map(item => '<section class="payment-approval-row">' + card(item, true) + '</section>').join('') :
        '<p role="status">' + (available ? '暂无待确认付款。' : '正在核对待确认付款…') + '</p>') +
      button('刷新', 'refresh') + button('试听语音', 'voice');
    toast.hidden = !row || Boolean(target);
    if (row && !toast.hidden) {
      const focused = toast.contains(document.activeElement) && document.activeElement.dataset.action;
      toast.innerHTML = '<div class="recharge-activity-toast-heading"><strong>有一笔充值等待确认付款</strong></div>' +
        card(row, false) + (error ? '<p role="alert">' + escape(error) + '</p>' : '');
      if (focused) [...toast.querySelectorAll('button')].find(b => b.dataset.action === focused)?.focus();
    } else toast.replaceChildren();
    if (rows.length) expiry = setTimeout(render, Math.max(1, Math.min(...rows.map(r => r.expires)) - Date.now()));
  }
  async function refresh() {
    if (!permitted()) return;
    const request = ++generation;
    clearTimeout(retry);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', credentials: 'same-origin' });
      if (request !== generation || !permitted()) return;
      if ([401,403].includes(response.status)) { stop(); return; }
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (request !== generation || !permitted()) return;
      if (!Array.isArray(result.items)) throw new Error();
      rows = result.items; available = true; error = ''; failures = 0;
      void announce(rows);
      for (const cache of [seen,deferred]) for (const id of cache) if (!rows.some(r => r.id === id)) cache.delete(id);
    } catch {
      if (request !== generation || !permitted()) return;
      error = '待确认付款暂时无法刷新，请重新核对。';
      if (++failures <= 3) retry = setTimeout(refresh, 1000 * failures);
    }
    render();
  }
  async function decide(id, action) {
    const row = rows.find(item => item.id === id);
    if (!row || row.expires <= Date.now() || busy.has(id)) return;
    busy.add(id); render();
    let message;
    try {
      const response = await fetch(endpoint + '/' + encodeURIComponent(id) + '/' + action,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 409 ? '此确认已失效。' : '未取得办理回执，请刷新核对。');
      message = action === 'approve' ? '已确认，等待原任务回报付款结果。' : '已登记结束，原任务将在提交前停止。';
    } catch (failure) { message = failure.message; }
    finally { busy.delete(id); if (permitted()) { A.notify(message); await refresh(); } }
  }
  function stop() {
    stopped = true; generation++; rows = []; seen.clear(); deferred.clear(); busy.clear();
    clearTimeout(expiry); clearTimeout(retry); toast.hidden = true; toast.replaceChildren();
    if (panel()) A.closeDrawer();
    document.removeEventListener('visibilitychange', visible);
    drawer.removeEventListener('close', render);
  }
  function visible() { if (!document.hidden && permitted()) void refresh(); }
  document.addEventListener('visibilitychange', visible);
  drawer.addEventListener('close', render);
  window.IDPaymentApprovals = Object.freeze({ onVersion(next) {
    if (permitted() && typeof next === 'string' && next !== version) { version = next; failures = 0; void refresh(); }
  } });
  window.IDDesignModules.push({ id: 'payment-approvals', matches: () => false, clearPageState: stop,
    onClick(name, node) {
      if (!permitted() || !name.startsWith('payment-approval-')) return false;
      const action = name.slice('payment-approval-'.length);
      if (action === 'open') {
        A.openDrawer('待确认付款', '每次确认仅对当前任务和本次应付金额有效。', '<div data-payment-approval-list></div>',
          '', 'recharge-activity', { kind: 'payment-approvals' });
        render(); void refresh();
      } else if (action === 'defer') { deferred.add(node.dataset.id); render(); }
      else if (action === 'refresh') void refresh();
      else if (action === 'voice') speak('有新的充值订单等待确认付款。');
      else if (['approve','cancel'].includes(action)) void decide(node.dataset.id, action);
      return true;
    }
  });
})();
