(() => {
  'use strict';

  const data = window.IDLocalData, A = window.IDDesignAPI;
  if (!data?.authRequired || !A) return;
  const toggle = document.querySelector('#recharge-activity-toggle');
  const toast = document.querySelector('#recharge-activity-toast');
  const announcement = document.querySelector('#recharge-activity-announcement');
  const drawer = document.querySelector('#drawer');
  const labels = Object.freeze({ running: '正在充值', success: '充值成功', failed: '充值失败', review: '付款待核对' });
  const coverageMessages = {
    checking: '正在核对代充任务…',
    limited: '部分代充任务暂未核对，已保留现有记录。',
    unavailable: '暂时无法核对新任务，已保留现有记录。'
  };
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hourCycle: 'h23'
  });
  const esc = A.esc;
  const events = new Map();
  let version, loaded = false, stopped = false, pending = false, refreshQueued = false;
  let refreshTimer, dismissTimer, retryDelay = 1000, currentToast;

  const plan = row => row.plan ? 'ChatGPT ' + row.plan : 'ChatGPT · 套餐待核对';
  const owner = row => row.owner ? row.owner.name || '领用人名称待核对' : '归属待核对';
  const email = row => row.email || '邮箱待核对';
  const code = row => row.codeTail ? '•••• ' + row.codeTail : '码尾不可用';
  const status = row => labels[row.status];
  const action = (label, name, id) =>
    '<button type="button" class="button compact" data-action="recharge-activity-' + name + '"' +
    (id ? ' data-id="' + esc(id) + '"' : '') + '>' + label + '</button>';
  const property = (label, value) => '<dt>' + label + '</dt><dd>' + esc(value) + '</dd>';

  function hideToast() {
    clearTimeout(dismissTimer);
    currentToast = undefined;
    toast.hidden = true;
    toast.replaceChildren();
    announcement.textContent = '';
  }

  function armDismiss() {
    clearTimeout(dismissTimer);
    if (!currentToast || toast.matches(':hover') || toast.contains(document.activeElement)) return;
    dismissTimer = setTimeout(hideToast, currentToast.status === 'review' ? 12_000 : 8000);
  }

  function showToast(items) {
    if (!items.length || document.hidden) return;
    const row = items[0];
    if (toast.contains(document.activeElement) && currentToast?.id !== row.id) return;
    const focusedAction = toast.contains(document.activeElement) ? document.activeElement.dataset.action : '';
    currentToast = row;
    toast.dataset.status = row.status;
    toast.innerHTML = '<div class="recharge-activity-toast-heading"><strong>' +
      esc(status(row) + ' · ' + plan(row)) + '</strong><button type="button" class="icon-button" ' +
      'aria-label="收起代充提醒" data-action="recharge-activity-dismiss">' + A.icon('close') + '</button></div>' +
      '<dl class="recharge-activity-fields">' + property('充值邮箱', email(row)) + property('充值码', code(row)) +
      property('码归属', owner(row)) + '</dl>' +
      '<p class="recharge-activity-meta">自助代充 · ' + esc(time.format(row.updatedAt)) +
      ' · 任务尾号 ' + esc(row.jobTail) + '</p>' +
      '<div class="recharge-activity-toast-actions">' +
      (items.length > 1 ? action('还有 ' + (items.length - 1) + ' 笔新动态', 'open') : '') +
      action('查看任务', 'detail', row.id) + '</div>';
    toast.hidden = false;
    announcement.textContent = status(row) + '，' + plan(row) + '，' + owner(row);
    if (focusedAction) toast.querySelector('[data-action="' + focusedAction + '"]')?.focus();
    armDismiss();
  }

  function renderBadge(unread) {
    toggle.hidden = false;
    toggle.setAttribute('aria-label', unread ? '代充动态，' + unread + ' 条未读' : '代充动态');
    toggle.innerHTML = A.icon('bolt') +
      (unread ? '<span class="recharge-activity-count" aria-hidden="true">' + Math.min(unread, 99) + (unread > 99 ? '+' : '') + '</span>' : '');
  }

  function refresh() {
    refreshQueued = true;
    if (stopped || pending) return;
    pending = true;
    void (async () => {
      while (refreshQueued && !stopped) {
        refreshQueued = false;
        try {
          const result = await data.rechargeActivity();
          if (stopped) return;
          const newItems = loaded ? result.items.filter(row => row.unread && events.get(row.id) !== row.event) : [];
          for (const row of result.items) events.set(row.id, row.event);
          loaded = true;
          clearTimeout(refreshTimer);
          retryDelay = 1000;
          renderBadge(result.unread);
          showToast(newItems);
        } catch (error) {
          if (stopped) return;
          if ([401, 403].includes(error.status)) return stop();
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(refresh, retryDelay);
          retryDelay = Math.min(15_000, retryDelay * 2);
        }
      }
      pending = false;
    })();
  }

  function openView(title, description) {
    A.openDrawer(title, description, '<div class="recharge-activity-view" aria-busy="true"><p role="status">正在读取代充动态…</p></div>',
      '', 'recharge-activity', { kind: 'recharge-activity' });
    return drawer.querySelector('.recharge-activity-view');
  }

  const currentView = panel => !stopped && drawer.open && panel.isConnected;

  async function history(page = 1, panel) {
    if (!panel) panel = openView('代充动态', '查看充值任务的进度、未读提醒和待核对结果。');
    panel.setAttribute('aria-busy', 'true');
    try {
      const result = await data.rechargeActivity(page);
      if (!currentView(panel)) return;
      const rows = result.items.map(row =>
        '<li><div class="recharge-activity-history-summary"><strong>' + esc(status(row) + ' · ' + plan(row)) +
        (row.unread ? '<span class="recharge-activity-unread">未读</span>' : '') +
        '</strong><span>' + esc(email(row) + ' · ' + code(row) + ' · ' + owner(row)) + '</span>' +
        '<span class="recharge-activity-meta">' + esc(time.format(row.updatedAt) + ' · 任务尾号 ' + row.jobTail) + '</span></div>' +
        action('查看任务', 'detail', row.id) + '</li>').join('');
      panel.innerHTML =
        (coverageMessages[result.coverage] ? '<p class="inline-notice" role="status">' + coverageMessages[result.coverage] + '</p>' : '') +
        (rows ? '<ul class="recharge-activity-history">' + rows + '</ul>' :
          result.coverage === 'ready' ? '<p class="inline-notice">暂无代充动态。</p>' : '') +
        '<div class="recharge-activity-history-footer">' + action('刷新', 'page', result.page) +
        (result.page > 1 ? action('上一页', 'page', result.page - 1) : '') +
        (result.pages > 1 ? '<span>第 ' + result.page + ' / ' + result.pages + ' 页</span>' : '') +
        (result.page < result.pages ? action('下一页', 'page', result.page + 1) : '') + '</div>';
    } catch (error) {
      if (!currentView(panel)) return;
      if ([401, 403].includes(error.status)) return stop();
      panel.innerHTML = '<p class="inline-notice warning" role="status">代充动态暂不可读。</p>' + action('重试', 'page', page);
    } finally {
      if (currentView(panel)) panel.removeAttribute('aria-busy');
    }
  }

  async function detail(id) {
    const panel = openView('代充任务', '查看这笔任务的充值资料和状态记录。');
    hideToast();
    try {
      const row = await data.rechargeActivityDetail(id);
      if (!currentView(panel)) return;
      const timeline = row.events.map(event => '<li><strong>' + esc(status(event)) + '</strong> <time datetime="' +
        new Date(event.at).toISOString() + '">' + esc(time.format(event.at)) + '</time>' +
        (event.reason ? '<p>' + esc(event.reason) + '</p>' : '') + '</li>').join('');
      panel.innerHTML = '<strong class="recharge-activity-detail-status" data-status="' + esc(row.status) + '">' +
        esc(status(row) + ' · ' + plan(row)) + '</strong><dl class="recharge-activity-fields">' +
        property('充值邮箱', row.fullEmail || email(row)) + property('充值码', row.fullCode || code(row)) +
        property('码归属', owner(row)) + property('来源', '自助代充') + property('任务尾号', row.jobTail) +
        property('任务登记', time.format(row.createdAt)) +
        (row.batchNo ? property('领用批次', row.batchNo) : '') +
        (row.issuedAt && Number.isFinite(Date.parse(row.issuedAt)) ? property('领用时间', time.format(Date.parse(row.issuedAt))) : '') +
        (row.status === 'success' ? property('订单同步', row.orderSynced ? '已入单' : '未确认入单') : '') +
        '</dl><ol class="recharge-activity-timeline">' + timeline + '</ol>' + action('返回动态', 'open');
      if (row.unread) void data.readRechargeActivity(id, row.event).then(refresh, error => {
        if ([401, 403].includes(error.status)) stop();
        else refresh();
      });
    } catch (error) {
      if (!currentView(panel)) return;
      if ([401, 403].includes(error.status)) return stop();
      panel.innerHTML = '<p class="inline-notice warning" role="status">' +
        (error.status === 404 ? '这笔任务已无法查看。' : '任务详情暂不可读。') + '</p>' + action('返回动态', 'open');
    } finally {
      if (currentView(panel)) panel.removeAttribute('aria-busy');
    }
  }

  function stop() {
    stopped = true;
    clearTimeout(refreshTimer);
    events.clear();
    hideToast();
    toggle.hidden = true;
    toggle.replaceChildren();
    if (drawer.dataset.layout === 'recharge-activity') {
      if (drawer.open) A.closeDrawer();
      drawer.replaceChildren();
    }
  }

  toast.addEventListener('pointerenter', () => clearTimeout(dismissTimer));
  toast.addEventListener('pointerleave', armDismiss);
  toast.addEventListener('focusin', () => clearTimeout(dismissTimer));
  toast.addEventListener('focusout', () => queueMicrotask(armDismiss));
  window.IDRechargeActivity = Object.freeze({
    onVersion(next) {
      if (typeof next !== 'string' || next === version || stopped) return;
      version = next;
      refresh();
    }
  });
  window.IDDesignModules.push({
    id: 'recharge-activity',
    matches: () => false,
    clearPageState: stop,
    onClick(name, node) {
      if (stopped || !name.startsWith('recharge-activity-')) return false;
      if (name === 'recharge-activity-open') {
        hideToast();
        void history();
      } else if (name === 'recharge-activity-page') {
        const panel = node.closest('.recharge-activity-view');
        if (panel && !panel.hasAttribute('aria-busy')) void history(Number(node.dataset.id), panel);
      } else if (name === 'recharge-activity-detail') void detail(node.dataset.id);
      else if (name === 'recharge-activity-dismiss') {
        if (toast.contains(document.activeElement)) toggle.focus();
        hideToast();
      }
      return true;
    }
  });
})();
