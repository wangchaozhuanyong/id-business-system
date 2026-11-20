(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData;
  if (!A || !D?.authRequired) return;
  const E = A.esc, $ = A.$;
  const { subscriptionTime, subscriptionDuration } = window.IDOrderOpening;
  const scope = 'renewal-handoffs';
  const staffRoot = 'workspace/renewals';
  const declinedRoute = staffRoot + '/declined';
  const financeRoute = 'workspace/finance-renewals';
  const finishPrefix = 'workspace/renewal-submit/';
  const staffTabs = [['', '选订单'], ['/sent', '已送财务'], ['/ready', '待补资料'], ['/history', '办理记录'], ['/declined', '拒绝续费']];
  const financeTabs = ['待处理', '处理中', '已处理'];
  const staffStages = { pending: '/sent', processing: '/sent', paid: '/ready', returned: '/history',
    withdrawn: '/history', complete: '/history' };
  const financeStages = { pending: '待处理', processing: '处理中', paid: '已处理', returned: '已处理',
    withdrawn: '已处理', complete: '已处理' };
  const statuses = { pending: '待财务', processing: '财务处理中', paid: '待员工补资料',
    returned: '财务已退回', withdrawn: '已撤回', complete: '已续费' };
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'].map(value => [value, value]);
  const dates = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
  const beijing = value => {
    const time = subscriptionTime(value);
    return Number.isFinite(time) ? dates.format(time) : '—';
  };
  const dateValue = date => dates.format(date).replace(' ', 'T');
  const currentRole = () => A.state.actor?.role;
  const canViewOrder = () => ['admin', 'super'].includes(currentRole());
  const handledPeriods = ['refused', 'renewed'];
  const selectableOrder = order => order.canSubmitToFinance !== false && !handledPeriods.includes(order.reminderState);
  const originalCardText = row => row.order.payment === '银行卡'
    ? row.originalCardNumber || '完整卡号待核对' : '—';
  const actualCardText = row => row.order.payment === '银行卡' && ['paid', 'complete'].includes(row.status)
    ? row.cardNumber || (row.last4 ? '完整卡号待核对' : '未登记卡号') : '—';
  const storeKey = name => 'renewal-handoff:' + name;
  const defaults = () => ({ page: 1, pageSize: 20, status: '待处理', period: 'upcoming', product: '', query: '' });
  const financeUnavailable = '当前没有其他账号可以处理这笔续费，请先启用财务账号。';
  const accountFieldId = 'renewal-account-reference';
  const readAccountRules = () => import('/modules/orders/renewal-account-reference.mjs');
  const reminderDuration = hours => {
    const days = Math.floor(hours / 24), remainder = hours % 24;
    return [days && days + ' 天', remainder && remainder + ' 小时'].filter(Boolean).join(' ');
  };
  let active;
  let auditNavigation;

  function matches(route) {
    return staffTabs.some(([segment]) => route === staffRoot + segment) ||
      route === financeRoute || route.startsWith(finishPrefix);
  }

  function filters(route) {
    const key = storeKey(route);
    if (!A.state.drafts.has(key)) A.state.drafts.set(key, defaults());
    return A.state.drafts.get(key);
  }

  const button = (label, action, id = '', kind = '') =>
    A.button(label, 'renewal-handoff-' + action, kind, '', id ? 'data-id="' + E(id) + '"' : '');
  function progressNavigation(route, auditTarget) {
    const finance = route === financeRoute;
    const currentStatus = finance && filters(route).status;
    const statusLinks = finance
      ? financeTabs.map((label, index) => {
          const selected = label === currentStatus;
          return '<button type="button" class="button" role="tab" id="renewal-status-' + index +
            '" aria-controls="renewal-finance-orders" aria-selected="' + selected + '" tabindex="' + (selected ? 0 : -1) +
            '" data-action="renewal-handoff-finance-tab" data-id="' + label + '">' + label + '</button>';
        }).join('')
      : staffTabs.map(([path, label]) => '<a class="button" href="#/' + staffRoot + path + '"' +
          (route === staffRoot + path ? ' aria-current="page"' : '') + '>' + label + '</a>').join('');
    const settings = !finance && canViewOrder()
      ? A.button('提醒设置', 'commerce-renewal-settings') +
        (D.renewalContactSettings ? A.button('续费提醒话术', 'commerce-renewal-suffix') : '') : '';
    return '<nav class="panel renewal-progress-navigation" aria-label="续费办理进度">' +
      '<div class="renewal-navigation-section"><span class="renewal-navigation-label">办理进度</span>' +
      '<div class="renewal-navigation-items"' +
      (finance ? ' role="tablist" aria-label="财务续费状态" data-renewal-statuses' : '') + '>' +
      statusLinks + '</div></div>' +
      (auditTarget ? '' : '<div class="renewal-navigation-section" role="group" aria-label="续费设置">' +
        '<span class="renewal-navigation-label">设置</span><div class="renewal-navigation-items">' +
        settings + button('常用备注', 'remark-settings') + '</div></div>') + '</nav>';
  }

  function render() {
    const route = A.state.route;
    const finance = route === financeRoute, finishing = route.startsWith(finishPrefix);
    const title = finance ? '财务续费' : finishing ? '提交续费订单' : '续费管理';
    const help = finance ? '接手后按提交备注办理续费，核对实际付款并登记金额及用卡，交回业务人员。'
      : finishing ? '根据财务已登记的实付资料，补齐客户实收和新的订阅周期。'
      : route === declinedRoute ? '查看已确认拒绝续费的原订单、登记人和登记时间。'
      : '选订单默认显示达到提醒时间且尚未到期的订阅。委托财务办理时填写备注。客户确认不续费时可勾选归档。线下已完成的续费可直接登记。';
    const back = finishing ? '<a class="button" href="#/workspace/renewals/ready">返回待补资料</a>' : '';
    const submit = route === staffRoot
      ? '<div class="renewal-selection-actions" role="group" aria-label="处理所选订单">' +
        A.button('拒绝续费', 'renewal-handoff-decline', 'danger', '', 'hidden disabled') +
        A.button('提交给财务', 'renewal-handoff-submit', 'primary', '', 'hidden disabled') + '</div>' : '';
    const auditTarget = auditNavigation?.route === route || (active?.route === route && active.auditId);
    const toolbar = '<div class="toolbar toolbar--inline list-filter-toolbar renewal-toolbar">' +
      (finishing ? '' : '<div class="toolbar-left" data-renewal-filters hidden></div>') +
      '<div class="toolbar-right" data-page-actions>' +
      (route === staffRoot ? '<span class="footnote" data-reminder-window hidden></span>' : '') +
      button('刷新', 'refresh') + submit +
      (auditTarget ? button('查看全部续费', 'show-all', '', 'primary') : '') + '</div></div>';
    const panel = '<section class="panel staff-workspace" data-renewal-handoff>' +
      toolbar +
      (route === staffRoot ? '<p class="panel-body inline-notice warning" role="status" data-renewal-finance-unavailable hidden></p>' : '') +
      '<p class="panel-body inline-notice warning" role="status" data-renewal-error hidden></p>' +
      '<div data-renewal-body' + (finance && !auditTarget ? ' id="renewal-finance-orders" role="tabpanel" aria-labelledby="renewal-status-' +
        financeTabs.indexOf(filters(route).status) + '"' : '') + '></div><span data-renewal-progress></span></section>';
    return A.header(title, help, back) + (finishing || (finance && auditTarget) ? panel
      : '<div class="renewal-progress-layout">' + progressNavigation(route, auditTarget) + panel + '</div>');
  }

  function selected() {
    return A.getSelection('renewal-handoff');
  }

  function reminderPeriod(order, now) {
    if (order.reminderState === 'expired' || handledPeriods.includes(order.reminderState)) return order.reminderState;
    if (order.reminderState === 'upcoming') return subscriptionTime(order.expiry) <= now ? 'expired' : 'upcoming';
    return '';
  }

  function rowsFor(view) {
    const query = view.filter.query.trim().toLowerCase();
    const choosing = view.route === staffRoot;
    const rows = choosing ? view.data.candidates.map(order => ({ id: order.id, order })) : view.data.items;
    if (view.auditId) return rows.filter(row => row.id === view.auditId);
    const now = Date.now();
    return rows.filter(row => {
      const { order } = row;
      const inStage = view.finance ? financeStages[row.status] === view.filter.status : staffRoot + staffStages[row.status] === view.route;
      return (choosing || view.route === declinedRoute || inStage) && (!view.filter.product || order.product === view.filter.product) &&
        (!choosing || reminderPeriod(order, now) === view.filter.period) &&
        (!query || [order.number, order.account, order.customer, order.wechat, order.contactSearch, order.owner, row.submittedBy, row.declinedBy]
          .some(value => String(value || '').toLowerCase().includes(query)));
    }).sort((a, b) => view.route === declinedRoute
      ? (subscriptionTime(b.declinedAt) || 0) - (subscriptionTime(a.declinedAt) || 0) || a.id.localeCompare(b.id)
      : choosing ? String(a.order.expiry || '').localeCompare(String(b.order.expiry || '')) ||
        a.order.number.localeCompare(b.order.number) : String(b.withdrawnAt || b.completedAt || b.paidAt || b.submittedAt)
          .localeCompare(String(a.withdrawnAt || a.completedAt || a.paidAt || a.submittedAt)));
  }

  function rowActions(view, row) {
    if (view.finance) {
      if (row.sourceReview) return button('核对原单', 'review-source', row.id, 'primary');
      if (row.canTake) return button('接手', 'claim', row.id);
      if (row.status === 'processing' && row.assignedToMe)
        return (row.sourceChanged ? '' : button(row.paymentReview ? '核对并登记实付' : '登记实付', 'payment', row.id, 'primary')) +
          button('退回', 'return', row.id) + button('移交', 'transfer', row.id);
      if (row.canTransfer) return button('移交', 'transfer', row.id);
      return row.processingBy ? E(row.processingBy) : '—';
    }
    if (row.canFinish && !row.sourceChanged)
      return '<a class="button compact primary" href="#/' + finishPrefix + E(row.id) + '">补资料并提交</a>';
    if (row.canWithdraw) return button('撤回', 'withdraw', row.id);
    return row.newOrderId && A.canVisit('orders/detail/' + row.newOrderId)
      ? '<a class="button compact" href="#/orders/detail/' + E(encodeURIComponent(row.newOrderId)) + '">查看新订单</a>' : '—';
  }

  function list(view) {
    const choosing = view.route === staffRoot;
    const canSelect = choosing && !handledPeriods.includes(view.filter.period);
    const rows = rowsFor(view);
    const { pageSize } = view.filter;
    view.filter.page = Math.max(1, Math.min(view.filter.page, Math.ceil(rows.length / pageSize)));
    const start = (view.filter.page - 1) * pageSize;
    const now = Date.now();
    const columns = [
      ['orderNo', '原订单', row => E(row.order.number || '—')],
      ['customer', '客户', row => E(row.order.customer)],
      ['account', '订阅账号', row => E(row.order.account || '待补资料')],
      ['plan', '产品与套餐', row => E([row.order.product, row.order.plan].join(' · '))],
      ['expiry', '原到期时间', row => E(beijing(row.order.expiry))]
    ];
    if (view.route === declinedRoute) {
      columns.push(['owner', '归属人', row => E(row.order.owner || '—')],
        ['declinedBy', '登记人', row => E(row.declinedBy || '历史未记录')],
        ['declinedAt', '登记时间', row => E(beijing(row.declinedAt))]);
    } else {
      columns.push(['days', '到期倒计时', row => {
        const expiry = subscriptionTime(row.order.expiry);
        if (!Number.isFinite(expiry)) return row.order.expiry ? '到期时间待核对' : '未登记到期时间';
        return '<span class="tag ' + (expiry <= now ? 'danger' : 'success') + '" data-renewal-countdown="' +
          expiry + '">' + E(subscriptionDuration(expiry, now)) + '</span>';
      }],
      ['payment', '付款方式', row => E(row.order.payment)]);
    }
    if (choosing) {
      columns.push(['owner', '归属人', row => E(row.order.owner || '—') +
        (canSelect && !selectableOrder(row.order) ? ' ' + A.tag('交接待核对') : '')]);
      if (canViewOrder()) columns.push(['actions', '操作', row =>
        '<span class="action-links">' + button('详情', 'order-details', row.id, 'compact') +
        (D.renewalContactCopy && ['upcoming', 'expired'].includes(row.order.reminderState)
          ? A.button('复制订阅信息', 'commerce-renewal-contact', 'compact', '', 'data-id="' + E(row.id) + '"') : '') +
        button('更多操作', 'order-actions', row.id, 'compact') + '</span>']);
    } else if (view.route !== declinedRoute) {
      columns.push(['submittedBy', '提交人', row => E(row.submittedBy || '—')],
        ['remark', '提交备注', row => E(row.remark || '—')],
        ['financeRemark', '财务回复', row => E(row.financeRemark || '—')],
        ...(view.finance || view.route === staffRoot + '/sent' ? [['accountReference', '账号 JSON / ID', row =>
          row.accountReference ? button('查看账号资料', 'view-account', row.id, 'compact') : '—']] : []),
        ...(view.finance ? [['submittedAt', '提交时间', row => E(beijing(row.submittedAt))],
          ['originalCard', '原用卡号', row => E(originalCardText(row))]] : []),
        ['status', '办理进度', row => A.tag(row.paymentReview ? '付款待核对' : row.sourceChanged && !['returned', 'withdrawn', 'complete'].includes(row.status) ? '原单待核对' :
          statuses[row.status] || '待核对', row.status === 'paid' ? 'success' : '')],
        ...(currentRole() === 'supervisor' ? [] : [
          ['amount', '本次实付', row => E(row.amount ? row.amount + ' ' + row.currency : '—')],
          ['last4', '本次用卡号', row => E(actualCardText(row))]
        ]),
        ...(view.finance && view.filter.status === '已处理' ? [['paidAt', '付款登记时间', row => E(beijing(row.paidAt))],
          ['reference', '付款凭据编号', row => E(row.reference || '—')]] : []),
        ['newOrderNo', '结果', row => E(row.newOrderNo || row.returned || '—')], ['actions', '操作', row => rowActions(view, row)]);
    }
    return A.table(columns.map(([id, label, render]) => ({ id, label, render, action: id === 'actions',
      long: ['remark', 'financeRemark'].includes(id),
      mobileSummary: ['days', 'declinedAt'].includes(id) || (view.auditId ? ['orderNo', 'status', 'newOrderNo'].includes(id)
        : id === (view.route === staffRoot + '/ready' ? 'financeRemark' : 'remark')) })),
      rows.slice(start, start + pageSize), canSelect ? 'renewal-handoff' : '', choosing ? '待续费订单' :
        view.route === declinedRoute ? '拒绝续费' : view.finance ? '财务续费订单' : '续费办理记录', { title: view.route === declinedRoute ? '暂无符合条件的拒绝续费记录' : '暂无符合条件的订单',
        description: choosing && view.filter.period === 'upcoming' && Number.isFinite(view.data.reminderHours)
          ? '当前按到期前 ' + reminderDuration(view.data.reminderHours) + ' 的设置显示提醒订单。' : '可切换筛选或稍后刷新。' },
      row => selectableOrder(row.order)) +
      window.IDPagination.render({ id: 'renewal-handoff-pagination', page: view.filter.page, pageSize, total: rows.length });
  }

  function selectionButton(view) {
    const anchor = $('[data-action="renewal-handoff-submit"]', view.host);
    if (!anchor) return;
    const count = selected().size;
    anchor.textContent = count ? '提交给财务（' + count + '）' : '提交给财务';
    anchor.disabled = count === 0 || view.saving || view.data?.canSubmitToFinance !== true;
    anchor.hidden = handledPeriods.includes(view.filter.period);
    const notice = $('[data-renewal-finance-unavailable]', view.host);
    notice.textContent = financeUnavailable;
    notice.hidden = anchor.hidden || view.data?.canSubmitToFinance !== false;
    const decline = $('[data-action="renewal-handoff-decline"]', view.host);
    decline.textContent = count ? '拒绝续费（' + count + '）' : '拒绝续费';
    decline.disabled = count === 0 || view.saving;
    decline.hidden = anchor.hidden;
  }

  function drawList(view) {
    const host = $('[data-renewal-list]', view.host);
    if (!host) return;
    if (view.route === staffRoot) {
      const now = Date.now();
      const candidates = new Set();
      view.nextExpiry = Infinity;
      for (const order of view.data.candidates) {
        const period = reminderPeriod(order, now);
        if (period === view.filter.period && selectableOrder(order)) candidates.add(order.id);
        if (period === 'upcoming') view.nextExpiry = Math.min(view.nextExpiry, subscriptionTime(order.expiry));
      }
      for (const id of selected()) if (!candidates.has(id)) selected().delete(id);
    }
    host.innerHTML = list(view);
    selectionButton(view);
    updateCountdowns(view);
  }

  function updateCountdowns(view) {
    clearTimeout(view.countdownTimer);
    if (active !== view || !view.host.isConnected || document.hidden) return;
    const now = Date.now(), hour = 3_600_000;
    if (view.nextExpiry <= now) {
      drawList(view);
      return;
    }
    if (view.nextReminderAt && view.nextReminderAt <= now && !view.saving) {
      view.nextReminderAt = undefined;
      void load(view, true);
    }
    const nextReminder = view.saving ? Infinity : (view.nextReminderAt ?? Infinity);
    let next = Math.min(view.nextExpiry ?? Infinity, nextReminder) - now;
    for (const counter of view.host.querySelectorAll('[data-renewal-countdown]')) {
      const expiry = Number(counter.dataset.renewalCountdown), remaining = expiry - now;
      counter.textContent = subscriptionDuration(expiry, now);
      counter.classList.toggle('danger', remaining <= 0);
      counter.classList.toggle('success', remaining > 0);
      next = Math.min(next, remaining > 0 ? remaining % hour : hour - (-remaining % hour));
    }
    if (Number.isFinite(next))
      view.countdownTimer = setTimeout(() => updateCountdowns(view), Math.min(2_147_000_000, Math.max(50, next + 50)));
  }

  function inputField(label, id, value, attrs = '') {
    return A.field(label, id, A.input(id, value, attrs), /\brequired\b/.test(attrs));
  }

  function selectField(label, id, options, value) {
    return A.field(label, id, A.select(id, options, value).replace('<select ', '<select required '), true);
  }

  const fieldCurrency = (label, id, preferred) => selectField(label, id,
    currencies.some(([value]) => value === preferred) || !/^[A-Z]{3}$/.test(preferred) ? currencies
      : [[preferred, preferred], ...currencies], preferred);
  const props = values => '<div class="property-list">' + values.map(([label, value]) =>
    '<div class="property-row"><span>' + label + '</span><strong>' + E(value || '—') + '</strong></div>').join('') + '</div>';

  function finishForm(view) {
    const row = view.data.items.find(row => view.route === finishPrefix + row.id);
    if (!row) return A.empty('没有这笔续费', '请从「待补资料」打开本人负责的订单。');
    if (row.status === 'complete') return '<div class="panel-body">' +
      props([['新订单编号', row.newOrderNo], ['原订单', row.order.number], ['完成时间', beijing(row.completedAt)]]) +
      '<a class="button" href="#/workspace/renewals/history">查看办理记录</a>' +
      (row.newOrderId && A.canVisit('orders/detail/' + row.newOrderId)
        ? ' <a class="button" href="#/orders/detail/' + E(encodeURIComponent(row.newOrderId)) + '">查看新订单</a>' : '') + '</div>';
    if (row.sourceChanged || !row.canFinish) return A.empty('这笔续费暂不能提交', '请先核对原单和财务处理结果。');
    const draft = A.state.drafts.get(storeKey(view.route + ':form')) || {};
    const { order } = row;
    const date = dateValue(new Date());
    return '<div class="form-section panel-body">' + props([['原订单', order.number], ['客户', order.customer],
      ['产品与套餐', order.product + ' · ' + order.plan], ['原到期时间', beijing(order.expiry)],
      ['财务已登记实付', row.amount + ' ' + row.currency], ['本次付款方式', order.payment],
      ...(order.payment === '银行卡' ? [['本次银行卡号', actualCardText(row)]] : []),
      ...(row.remark ? [['提交备注', row.remark]] : []), ...(row.financeRemark ? [['财务回复', row.financeRemark]] : [])]) +
      '<form id="renewal-finish-form" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '" data-renewal-draft="' + E(storeKey(view.route + ':form')) + '"><div class="form-grid">' +
      (order.account ? props([['订阅账号', order.account]]) : inputField('订阅邮箱', 'renewal-email', draft['renewal-email'] || '',
        'type="email" maxlength="254"') + (order.product === 'Grok' ? inputField('X 账号', 'renewal-xHandle', draft['renewal-xHandle'] || '',
          'maxlength="16" placeholder="@账号"') : '')) +
      inputField('开通时间（北京）', 'renewal-start', draft['renewal-start'] || date, 'type="datetime-local" required') +
      inputField('新到期时间（北京）', 'renewal-expiry', draft['renewal-expiry'] || '', 'type="datetime-local" required') +
      inputField('客户实收金额', 'renewal-saleAmount', draft['renewal-saleAmount'] || '',
        'maxlength="21" inputmode="decimal" required') +
      fieldCurrency('实收币种', 'renewal-saleCurrency', draft['renewal-saleCurrency'] || row.saleCurrency || 'CNY') +
      '</div><div class="field-error" data-renewal-form-error role="alert" hidden></div><div class="form-footer">' +
      '<button class="button primary" type="submit">提交订单</button></div></form></div>';
  }

  function draw(view) {
    const body = $('[data-renewal-body]', view.host);
    if (view.route.startsWith(finishPrefix)) {
      body.innerHTML = finishForm(view);
      return;
    }
    const filters = $('[data-renewal-filters]', view.host);
    window.IDSearchInput?.suspend(filters);
    const searchPlaceholder = view.route === staffRoot && canViewOrder()
      ? '搜索客户、联系方式、账号或订单编号' : '搜索客户、账号或原订单编号';
    filters.innerHTML = '<div class="search-field">' + A.icon('search') +
      '<input id="renewal-handoff-search" data-auto-search aria-label="搜索续费订单" title="' + searchPlaceholder +
      '" placeholder="' + (canViewOrder() && view.route === staffRoot ? '客户、联系方式、账号或单号' : '客户、账号或订单号') + '" value="' +
      E(view.filter.query) + '"></div>' +
      '<div class="list-filter-fields"><div class="list-filter-field"><label for="renewal-handoff-product">产品</label><select id="renewal-handoff-product">' +
      A.options([['', '全部产品'], 'GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'], view.filter.product) + '</select></div>' +
      (view.route === staffRoot ? '<div class="list-filter-field"><label for="renewal-handoff-period">订单状态</label><select id="renewal-handoff-period">' +
        A.options([['upcoming', '即将到期'], ['expired', '已到期'],
          ...(canViewOrder() ? [['refused', '已拒续'], ['renewed', '已续费']] : [])],
          view.filter.period) + '</select></div>' : '') + '</div>';
    const reminder = $('[data-reminder-window]', view.host);
    if (reminder) {
      reminder.hidden = Boolean(view.auditId) || !Number.isFinite(view.data.reminderHours);
      reminder.textContent = reminder.hidden ? '' : '提前 ' + reminderDuration(view.data.reminderHours) + '提醒';
    }
    filters.hidden = Boolean(view.auditId);
    body.innerHTML = '<div data-renewal-list></div>';
    drawList(view);
    window.IDSearchInput?.restore(filters);
  }

  function notifyError(view, text) {
    if (active !== view || !view.host.isConnected) return;
    const element = $('[data-renewal-error]', view.host);
    element.textContent = text;
    element.hidden = !text;
  }

  async function load(view, refresh = false) {
    const key = { view: view.finance ? 'finance' : view.route === declinedRoute ? 'declined' : 'staff' };
    const id = (view.request || 0) + 1;
    view.request = id;
    const cached = D.queries.peek(scope, key)?.data;
    const crossedReminder = view.route === staffRoot && Number.isFinite(cached?.nextReminderAt) &&
      cached.nextReminderAt <= Date.now();
    const body = $('[data-renewal-body]', view.host);
    const latest = () => active === view && view.host.isConnected && view.request === id;
    if (!view.data && cached && !view.auditId) {
      view.data = cached;
      if (view.route === staffRoot && cached.nextReminderAt > Date.now()) view.nextReminderAt = cached.nextReminderAt;
      draw(view);
    }
    const feedback = A.beginRegionRead(view.host, $('[data-renewal-progress]', view.host),
      { loadingText: view.data ? '' : '正在读取续费资料…', refreshButton: $('[data-action="renewal-handoff-refresh"]', view.host) });
    try {
      const data = await D.queries.read(scope, key, () => D.renewalHandoffs(key.view), { refresh: refresh || crossedReminder });
      if (!latest()) return true;
      const openForm = $('#renewal-finish-form', view.host);
      view.data = data;
      if (view.route === staffRoot) view.nextReminderAt = data.nextReminderAt > Date.now() ? data.nextReminderAt : undefined;
      if (view.auditId) {
        const target = data.items.find(row => row.id === view.auditId);
        if (target && view.finance) view.filter.status = financeStages[target.status] || view.filter.status;
        draw(view);
        notifyError(view, target ? '' : '这笔续费目前无法读取，请核对原操作。');
        return true;
      }
      if (openForm?.contains(document.activeElement) && data.items.some(row => row.id === openForm.dataset.renewalId &&
          row.version === Number(openForm.dataset.renewalVersion) && row.canFinish && !row.sourceChanged)) {
        notifyError(view, '');
        return true;
      }
      draw(view);
      notifyError(view, '');
      return true;
    } catch (error) {
      if (!latest()) return true;
      if (error.code === 'READ_SUPERSEDED') return false;
      if (!view.data) body.innerHTML = A.empty('续费资料暂时无法读取', '请点击刷新重试。');
      notifyError(view, error.message || '续费资料暂时无法更新。');
      return false;
    } finally { feedback.finish(); }
  }

  async function save(view, command, submitter, form) {
    if (active !== view || view.saving) return;
    view.saving = true;
    selectionButton(view);
    notifyError(view, '');
    const formError = form?.querySelector('[data-renewal-form-error]');
    if (formError) {
      formError.hidden = true;
      formError.replaceChildren();
    }
    let feedback, timing;
    try {
      if (active !== view || (form && !form.isConnected)) return;
      if (form) form.inert = true;
      if (form?.hasAttribute('data-protect-drawer-dismiss')) form.setAttribute('aria-busy', 'true');
      feedback = A.beginActionFeedback(submitter, '正在登记…');
      const measure = command.action === 'finish' ? 'order-save' : undefined;
      timing = measure ? window.IDSiteTiming?.start(measure) : undefined;
      const requestKey = command.action === 'submit' ? form.dataset.renewalDraft + ':request' : '';
      let fingerprint = ['submit', 'review-source', 'decline'].includes(command.action) ? JSON.stringify(command) : '';
      if (command.accountReference) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
        fingerprint = Array.from(new Uint8Array(digest)).join(',');
        if (active !== view || !form.isConnected) return;
      }
      const previous = requestKey ? A.state.drafts.get(requestKey) : view.pendingWrite;
      const operationId = fingerprint && previous?.command === fingerprint ? previous.operationId : crypto.randomUUID();
      if (requestKey) A.state.drafts.set(requestKey, { command: fingerprint, operationId });
      if (!requestKey && fingerprint) view.pendingWrite = { command: fingerprint, operationId };
      const result = await D.saveRenewalHandoff(command, { operationId, measure, timing });
      if (!result.saved) throw new Error('保存结果待核对，请刷新');
      if (!requestKey && view.pendingWrite?.operationId === operationId) view.pendingWrite = undefined;
      if (requestKey && A.state.drafts.get(requestKey)?.operationId === operationId) {
        A.state.drafts.delete(requestKey);
        const draftKey = form.dataset.renewalDraft;
        if (active !== view && A.state.drafts.get(draftKey)?.['renewal-remark']?.trim() === command.remark)
          A.state.drafts.delete(draftKey);
      }
      timing?.finish();
      if (active !== view) return;
      if (form?.closest('dialog')) {
        A.closeDrawer();
        A.state.drafts.delete(form.dataset.renewalDraft);
      }
      if (command.action === 'submit') {
        selected().clear();
        const sentRoute = staffRoot + '/sent';
        Object.assign(filters(sentRoute), { query: '', product: '', page: 1 });
        window.IDSearchInput?.discardPage(sentRoute, 'renewal-handoff-search');
        A.go(sentRoute);
      } else if (command.action === 'decline') {
        selected().clear();
        Object.assign(filters(declinedRoute), { query: '', product: '', page: 1 });
        window.IDSearchInput?.discardPage(declinedRoute, 'renewal-handoff-search');
        if (canViewOrder()) void A.modules.commerce?.refreshAfterOrderSync?.();
        A.go(declinedRoute);
      } else {
        if (command.action === 'finish') {
          A.state.drafts.delete(storeKey(view.route + ':form'));
          if (canViewOrder()) void A.modules.commerce?.refreshAfterOrderSync?.();
        }
        const updated = await load(view, true);
        if (!updated) notifyError(view, '已保存，列表暂未刷新。请点击刷新。');
      }
      const messages = { submit: '已进入财务续费队列，等待财务接手', claim: '已接手这笔续费', paid: '已交回续费管理，等待员工补资料',
        withdraw: '已撤回续费申请',
        decline: '已移入拒绝续费，已停止所选原订单的续费提醒',
        return: '已退回业务人员', finish: '订单提交成功', transfer: '已移交，其他财务可接手',
        'review-source': '原单已核对，员工可以补资料提交订单' };
      A.notify(messages[command.action] + (result.orderNo ? ' · ' + result.orderNo : ''), { kind: 'success' });
      return true;
    } catch (error) {
      const diagnostic = timing?.finish(error);
      if (active === view) {
        if (formError?.isConnected) {
          formError.textContent = error.message || '结果待核对，请刷新后再试。';
          formError.hidden = false;
          window.IDSiteTiming?.show(formError, diagnostic);
        } else notifyError(view, error.message || '结果待核对，请刷新后再试。');
      }
    } finally {
      view.saving = false;
      if (form?.isConnected) {
        form.inert = false;
        form.removeAttribute('aria-busy');
      }
      feedback?.finish();
      if (active === view) {
        selectionButton(view);
        updateCountdowns(view);
      }
    }
  }

  function remarkField(label, id, value, attributes = '', help = '') {
    return (window.IDRenewalRemarks?.picker(id) || '') + A.field(label, id, A.input(id, value,
      'maxlength="160" ' + attributes), /\brequired\b/.test(attributes), help);
  }

  function accountInput(value = '', readonly = false) {
    const controls = '<div class="form-footer">' + button('一键复制', 'copy-account') +
      (readonly ? '' : button('一键粘贴', 'paste-account')) + '</div>';
    return A.field('账号 JSON / ID', accountFieldId,
      '<textarea id="' + accountFieldId + '" name="' + accountFieldId + '" rows="4" maxlength="2048" autocomplete="off" ' +
      'spellcheck="false" data-no-draft ' + (readonly ? 'readonly' :
        'placeholder="填写账号 ID 或基础账号 JSON" aria-describedby="' + accountFieldId + '-error"') + '>' + E(value) + '</textarea>' +
      controls, false, readonly ? '' : '填写账号 ID 或基础账号 JSON。登录凭据请通过现有授权入口处理。');
  }

  function showAccount(row) {
    A.openDrawer('账号资料', '', props([['原订单', row.order.number]]) +
      '<div data-renewal-account-row="' + E(row.id) + '">' + accountInput(row.accountReference, true) + '</div>',
      A.button('关闭', 'drawer-close'));
  }

  async function accountClipboard(view, node, paste) {
    const drawer = node.closest('#drawer[open]');
    const field = drawer && $('#' + accountFieldId, drawer);
    if (!field || (paste && field.readOnly)) return;
    const isCurrent = () => active === view && field.isConnected && drawer.open && !field.closest('[inert]');
    const setError = message => A.setError(accountFieldId, message, drawer);
    try {
      const clip = paste ? await navigator.clipboard.readText() : '';
      const { validateRenewalAccountReference } = await readAccountRules();
      if (!isCurrent()) return;
      const rowId = field.closest('[data-renewal-account-row]')?.dataset.renewalAccountRow;
      const raw = paste ? clip : rowId ? view.data?.items.find(row => row.id === rowId)?.accountReference : field.value;
      let value;
      try { value = validateRenewalAccountReference(raw ?? ''); }
      catch (error) { setError(error.message); return; }
      if (!value) { setError(paste ? '剪贴板没有账号资料。' : '请先填写或读取账号资料。'); return; }
      setError('');
      if (paste) {
        field.value = value;
        field.focus();
      } else {
        await A.copyText(value, '账号资料已复制', { current: isCurrent });
      }
    } catch {
      if (!isCurrent()) return;
      field.focus();
      setError(paste ? '无法读取剪贴板，请使用键盘粘贴。' : '无法复制，请选中文字后手动复制。');
    }
  }

  function submitSelected(view, submitter, action) {
    if (view.saving || !view.data || (action === 'submit' && view.data.canSubmitToFinance !== true)) return;
    const orders = view.data.candidates.filter(row => selected().has(row.id) && selectableOrder(row));
    if (!orders.length || orders.length > 50) {
      notifyError(view, orders.length ? '每次最多提交 50 笔，请分批办理。' : '请先勾选需要续费的订单。');
      return;
    }
    if (action === 'decline') {
      const names = orders.slice(0, 3).map(order => order.number || order.id).join('、');
      const command = { action, confirmed: true, orders: orders.map(({ id, version }) => ({ id, version })) };
      A.confirmAction('确认拒绝续费', '已与客户确认不再续费？所选 ' + orders.length + ' 笔原订单（' +
        names + (orders.length > 3 ? ' 等' : '') + '）将移入「拒绝续费」，并停止这些订单的续费提醒。',
        () => save(view, command, submitter), '确认拒绝续费');
      return;
    }
    const id = 'renewal-submit-form';
    const key = storeKey(id + ':' + JSON.stringify(orders.map(order => order.id).sort()));
    const draft = A.state.drafts.get(key) || {};
    A.openDrawer('提交给财务', '财务在「快速操作 → 财务续费」的待处理队列中接手并办理续费。',
      props([['原订单（' + orders.length + ' 笔）', orders.map(order => order.number).join('、')]]) +
      '<form id="' + id + '" data-protect-drawer-dismiss data-renewal-draft="' + E(key) + '" data-renewal-orders="' +
      E(JSON.stringify(orders.map(({ id, version }) => ({ id, version })))) + '">' +
      remarkField('提交备注', 'renewal-remark', draft['renewal-remark'] || '',
        'required placeholder="说明需要财务处理的事项"', '批量提交时，同一备注会写入选中的每笔订单。') +
      (orders.length === 1 ? accountInput() : '<p class="footnote">填写账号 JSON / ID 时，请单独提交对应订单。</p>') +
      '<p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
      A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id +
      '">确认提交给财务</button>', key);
    window.IDRenewalRemarks?.bind($('#' + id, $('#drawer')));
  }

  function paymentForm(view, row, returning) {
    const id = returning ? 'renewal-return-form' : 'renewal-payment-form';
    const draftKey = storeKey(id + ':' + row.id);
    const draft = A.state.drafts.get(draftKey) || {};
    const bank = row.order.payment === '银行卡';
    const mode = draft['renewal-cardMode'] || 'none';
    const details = returning ? '<div class="form-field-wide">' +
      remarkField('退回原因', 'renewal-reason', draft['renewal-reason'] || '', 'required') + '</div>'
      : inputField('实际付款金额', 'renewal-amount', draft['renewal-amount'] || '', 'maxlength="21" inputmode="decimal" required') +
      (bank ? fieldCurrency('付款币种', 'renewal-currency', draft['renewal-currency'] || row.order.previousPaidCurrency || 'USD')
        : props([['付款币种', 'USD']]) + '<input type="hidden" name="renewal-currency" value="USD">') +
      (bank ? selectField('本次使用的卡', 'renewal-cardMode', [['none', '暂不登记卡号'], ['original', '沿用原卡'],
        ['pool', '从系统选卡'], ['manual', '填写本次卡号']], mode) +
        '<div class="commerce-span-all" data-renewal-card-fields></div>' : '') +
      inputField('付款凭据编号（选填）', 'renewal-reference', draft['renewal-reference'] || '', 'maxlength="120"') +
      '<div class="form-field-wide">' + remarkField('财务回复', 'renewal-financeRemark', draft['renewal-financeRemark'] || '',
        'placeholder="填写本次续费处理结果"') + '</div>';
    const label = returning ? '登记未付款并退回' : '保存实付';
    A.openDrawer(returning ? '退回续费申请' : '登记续费实付', '', props([
      ['原订单', row.order.number], ['客户', row.order.customer], ['订阅账号', row.order.account], ['付款方式', row.order.payment],
      ...(row.remark ? [['提交备注', row.remark]] : []),
      ...(bank ? [['原用卡号', originalCardText(row)]] : [])
    ]) + (row.accountReference ? '<div data-renewal-account-row="' + E(row.id) + '">' +
      accountInput(row.accountReference, true) + '</div>' : '') +
      '<form id="' + id + '" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '" data-renewal-draft="' + E(draftKey) + '"' +
      '><div class="form-grid">' + details +
      '</div><p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
      A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id + '">' + label + '</button>', draftKey);
    const form = $('#' + id, $('#drawer'));
    if (!returning && bank) updateCardFields(form, false);
    form.addEventListener('input', () => preserveForm(form));
    window.IDRenewalRemarks?.bind(form);
  }

  function preserveForm(form) {
    if (!form?.isConnected || !form.dataset.renewalDraft) return;
    const values = Object.fromEntries(new FormData(form));
    delete values['renewal-cardNumber'];
    delete values['renewal-cardSerial'];
    A.state.drafts.set(form.dataset.renewalDraft, values);
  }

  function transferForm(row) {
    const id = 'renewal-transfer-form';
    A.openDrawer('移交财务续费', '先核对是否已经付款。付款未确认时，接手的人应先查付款凭证。', props([
      ['原订单', row.order.number], ['当前经办人', row.processingBy]
    ]) + '<form id="' + id + '" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '"><div class="form-grid">' + inputField('交接原因', 'renewal-reason', '', 'required maxlength="160"') +
      selectField('付款情况', 'renewal-review', [['review', '已付款或待核对'], ['unpaid', '已确认未付款']],
        'review') + '</div>' +
      '<p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
    A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id + '">确认移交</button>');
  }

  function reviewSourceForm(row) {
    const id = 'renewal-review-source-form';
    const review = row.sourceReview;
    const key = storeKey(id + ':' + row.id);
    const draft = A.state.drafts.get(key) || {};
    A.openDrawer('核对原订单', '请核对原订单更正前后的资料和本次付款凭据。确认后员工可以继续补资料。', props([
      ['原订单', row.order.number], ['客户', row.order.customer], ['订阅账号', row.order.account],
      ['原到期时间', beijing(row.order.expiry)], ['最新到期时间', beijing(review.expiry)],
      ...(row.order.payment === '银行卡' ? [['原单用卡号', originalCardText(row)], ['本次付款用卡号', actualCardText(row)]] : []),
      ['已登记实付', [row.amount, row.currency].filter(Boolean).join(' ')], ['付款凭据编号', row.reference]
    ]) + '<form id="' + id + '" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '" data-source-version="' + review.version + '" data-renewal-draft="' + E(key) + '"><div class="form-grid">' +
      inputField('原单更正原因', 'renewal-reason', draft['renewal-reason'] || '', 'required maxlength="160"') +
      '</div><p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
    A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id + '">确认并交回员工</button>', key);
    $('#' + id, $('#drawer')).addEventListener('input', event => preserveForm(event.currentTarget));
  }

  function updateCardFields(form, readPool) {
    const node = $('[data-renewal-card-fields]', form);
    const mode = form.elements['renewal-cardMode'].value;
    if (mode === 'manual') {
      node.innerHTML = '<div class="form-grid">' + inputField('本次银行卡号', 'renewal-cardNumber', '',
        'type="password" inputmode="numeric" autocomplete="off" required maxlength="25" data-no-draft') +
        inputField('卡序列号（选填）', 'renewal-cardSerial', '', 'maxlength="120" autocomplete="off" data-no-draft') + '</div>';
    } else if (mode === 'pool') {
      node.innerHTML = button('读取可用银行卡', 'cards');
      if (readPool) void loadCards(form, $('button', node));
    } else node.replaceChildren();
  }

  async function loadCards(form, node) {
    if (!form?.isConnected || !node) return;
    const container = $('[data-renewal-card-fields]', form);
    try {
      node.disabled = true;
      const { items, poolUnavailable } = await D.renewalHandoffs('cards', form.dataset.renewalId);
      if (node.isConnected && form.elements['renewal-cardMode']?.value === 'pool') {
        const previous = A.state.drafts.get(form.dataset.renewalDraft)?.['renewal-cardId'] || '';
        container.innerHTML = (items.length ? selectField('银行卡号', 'renewal-cardId',
          [['', '请选择本次使用的卡'], ...items.map(row => [row.id, row.number + (row.label ? ' · ' + row.label : '')])], previous)
          : '<p>暂无可选卡。请核对后填写本次实际用卡。</p>') +
          (poolUnavailable ? '<p role="status">代充卡暂时无法读取，可稍后重试或填写实际用卡。</p>' : '');
      }
    } catch (error) {
      const notice = $('[data-renewal-form-error]', form);
      if (notice?.isConnected) { notice.textContent = error.message; notice.hidden = false; }
    } finally { node.disabled = false; }
  }

  async function onClick(action, node) {
    const view = active;
    if (!view || !action.startsWith('renewal-handoff-')) return false;
    const command = action.slice('renewal-handoff-'.length);
    if (command === 'refresh') await load(view, true);
    else if (command === 'remark-settings') window.IDRenewalRemarks?.settings(node);
    else if (['order-details', 'order-actions'].includes(command)) {
      const order = view.route === staffRoot && canViewOrder() &&
        view.data?.candidates.find(candidate => candidate.id === node.dataset.id);
      const commerce = A.modules.commerce;
      if (order && command === 'order-details') void commerce?.openRenewalWorktableDetails?.(order, node);
      if (order && command === 'order-actions') {
        const actions = await commerce?.renewalWorktableActions?.(order);
        if (active === view && node.isConnected && actions)
          A.openActionMenu(node, actions, { onSelect: choice => commerce.runRenewalWorktableAction(choice, node) });
      }
    }
    else if (command === 'paste-account' || command === 'copy-account') await accountClipboard(view, node, command === 'paste-account');
    else if (command === 'show-all' && view.auditId) {
      auditNavigation = undefined;
      view.auditId = undefined;
      A.render();
      $('#renewal-handoff-search', A.activePageRegion())?.focus({ preventScroll: true });
    } else if (command === 'finance-tab') {
      const tabs = node.closest('[data-renewal-statuses]');
      for (const tab of tabs.children) {
        tab.setAttribute('aria-selected', String(tab === node));
        tab.tabIndex = tab === node ? 0 : -1;
      }
      $('[data-renewal-body]', view.host).setAttribute('aria-labelledby', node.id);
      view.filter.status = node.dataset.id;
      view.filter.page = 1;
      if (view.data) drawList(view);
    } else if (command === 'submit' || command === 'decline') submitSelected(view, node, command);
    else if (command === 'cards') await loadCards(node.closest('form'), node);
    else {
      const row = view.data?.items.find(item => item.id === node.dataset.id);
      if (row?.accountReference && command === 'view-account') showAccount(row);
      if (row?.canWithdraw && command === 'withdraw')
        A.confirmAction('撤回续费申请', '确认撤回原订单 ' + row.order.number + ' 的续费申请？', () =>
          void save(view, { action: 'withdraw', id: row.id, version: row.version }, node), '确认撤回');
      if (row && command === 'claim') await save(view, { action: 'claim', id: row.id, version: row.version }, node);
      if (row && ['payment', 'return'].includes(command)) paymentForm(view, row, command === 'return');
      if (row?.canTransfer && command === 'transfer') transferForm(row);
      if (row?.sourceReview && command === 'review-source') reviewSourceForm(row);
    }
    return true;
  }

  async function onSubmit(form) {
    const actions = { 'renewal-submit-form': 'submit', 'renewal-finish-form': 'finish', 'renewal-payment-form': 'paid', 'renewal-return-form': 'return',
      'renewal-transfer-form': 'transfer', 'renewal-review-source-form': 'review-source' };
    const action = actions[form.id];
    if (!active || !action) return false;
    if (!form.reportValidity()) return true;
    const view = active, fields = Object.fromEntries(new FormData(form));
    const submitter = form.querySelector('[type="submit"]') || document.querySelector('[form="' + form.id + '"][type="submit"]');
    if (action === 'submit') {
      const remark = fields['renewal-remark'].trim();
      if (!remark) {
        const notice = $('[data-renewal-form-error]', form);
        notice.textContent = '请填写提交备注。';
        notice.hidden = false;
        form.elements['renewal-remark'].focus();
        return true;
      }
      let accountReference = '';
      if (fields[accountFieldId]?.trim()) {
        try {
          const { validateRenewalAccountReference } = await readAccountRules();
          if (active !== view || !form.isConnected || !form.closest('dialog')?.open) return true;
          accountReference = validateRenewalAccountReference(fields[accountFieldId]);
        } catch (error) {
          if (form.isConnected) A.setError(accountFieldId, error.message || '账号资料无法核对，请刷新后重试。', form);
          form.elements[accountFieldId]?.focus();
          return true;
        }
      }
      A.setError(accountFieldId, '', form);
      void save(view, { action, remark, orders: JSON.parse(form.dataset.renewalOrders),
        ...(accountReference && { accountReference }) }, submitter, form);
      return true;
    }
    const command = { action, id: form.dataset.renewalId, version: Number(form.dataset.renewalVersion) };
    for (const key of ['email', 'xHandle', 'start', 'expiry', 'saleAmount', 'saleCurrency', 'amount', 'currency',
      'reference', 'reason', 'cardMode', 'cardId', 'cardNumber', 'cardSerial'])
      if (typeof fields['renewal-' + key] === 'string') command[key] = fields['renewal-' + key].trim();
    if (action === 'paid' && fields['renewal-financeRemark']?.trim()) command.financeRemark = fields['renewal-financeRemark'].trim();
    if (action === 'paid' && command.cardMode === 'pool' && !command.cardId) {
      const notice = $('[data-renewal-form-error]', form);
      notice.textContent = '请选择本次实际使用的银行卡。';
      notice.hidden = false;
      return true;
    }
    if (action === 'transfer') command.review = fields['renewal-review'] === 'review';
    if (action === 'review-source') command.sourceVersion = Number(form.dataset.sourceVersion);
    void save(view, command, submitter, form);
    return true;
  }

  function onChange(node) {
    const view = active;
    if (!view) return false;
    if (node.id === 'renewal-cardMode') {
      preserveForm(node.form);
      updateCardFields(node.form, node.value === 'pool');
      return true;
    }
    if (['renewal-handoff-product', 'renewal-handoff-period'].includes(node.id)) {
      view.filter[node.id.split('-').at(-1)] = node.value;
      view.filter.page = 1;
      drawList(view);
      return true;
    }
    if (node.dataset.select !== 'renewal-handoff' && node.dataset.selectAll !== 'renewal-handoff') return false;
    const values = selected();
    const controls = node.dataset.selectAll ? [...node.closest('table').querySelectorAll('[data-select="renewal-handoff"]')] : [node];
    for (const control of controls) {
      control.checked = node.checked;
      if (node.checked) values.add(control.dataset.id);
      else values.delete(control.dataset.id);
    }
    const all = node.closest('table').querySelector('[data-select-all="renewal-handoff"]');
    const checked = [...all.closest('table').querySelectorAll('tbody [data-select]')].filter(input => input.checked).length;
    all.checked = checked > 0 && checked === all.closest('table').querySelectorAll('tbody [data-select]').length;
    all.indeterminate = checked > 0 && !all.checked;
    selectionButton(view);
    return true;
  }

  function activate() {
    const host = $('[data-renewal-handoff]', A.activePageRegion());
    if (!host || active?.host === host) return;
    const route = A.state.route;
    if (auditNavigation && (auditNavigation.route !== route || auditNavigation.actorId !== A.state.actor?.id))
      auditNavigation = undefined;
    const auditId = auditNavigation?.id;
    const view = { route, finance: route === financeRoute, filter: auditId ? defaults() : filters(route), host, auditId };
    active = view;
    const tabs = host.parentElement.querySelector('[data-renewal-statuses]');
    tabs?.addEventListener('keydown', event => {
      const items = Array.from(tabs.children);
      const index = items.indexOf(event.target);
      if (index < 0) return;
      const last = items.length - 1;
      const positions = { Home: 0, End: last, ArrowDown: (index + 1) % items.length,
        ArrowRight: (index + 1) % items.length, ArrowUp: (index + last) % items.length,
        ArrowLeft: (index + last) % items.length };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      const next = items[positions[event.key]];
      next.focus();
      next.click();
    });
    host.addEventListener('input', event => {
      const node = event.target;
      if (node.id === 'renewal-handoff-search') {
        view.filter.query = node.value;
        view.filter.page = 1;
        drawList(view);
      } else if (node.form?.id === 'renewal-finish-form') {
        A.state.drafts.set(storeKey(route + ':form'), Object.fromEntries(new FormData(node.form)));
      }
    });
    host.addEventListener('id-pagination-change', ({ detail }) => {
      if (detail.id !== 'renewal-handoff-pagination') return;
      Object.assign(view.filter, { page: detail.page, pageSize: detail.pageSize });
      drawList(view);
    });
    const refresh = auditNavigation?.refresh === true;
    if (refresh) auditNavigation.refresh = false;
    void load(view, refresh);
  }

  window.IDRenewalHandoff = { refreshWorktable() {
    if (active?.route === staffRoot) return load(active, true);
  }, openAuditRecord({ id, state }) {
    if (!id || A.state.route !== 'settings/audit' || !canViewOrder()) return;
    const route = A.canVisit(financeRoute) ? financeRoute : staffRoot + (staffStages[state] || '/history');
    auditNavigation = { id, route, actorId: A.state.actor.id, refresh: true };
    A.go(route);
    if (A.state.route !== route) auditNavigation = undefined;
  } };
  document.addEventListener('visibilitychange', () => { if (active) updateCountdowns(active); });
  window.IDDesignModules.push({ matches, render, afterRender: activate, onClick, onSubmit, onChange,
    deactivate() {
      clearTimeout(active?.countdownTimer);
      if (auditNavigation && A.state.route !== auditNavigation.route) auditNavigation = undefined;
      active = undefined;
    },
    clearPageState() { clearTimeout(active?.countdownTimer); active = auditNavigation = undefined; },
    onDataChanges(scopes) {
      if (!active || active.saving || !scopes.some(key => [scope, 'commerce'].includes(key))) return;
      const view = active;
      if (view.host.contains(document.activeElement) && view.route.startsWith(finishPrefix))
        preserveForm($('#renewal-finish-form', view.host));
      return load(view);
    } });
})();
