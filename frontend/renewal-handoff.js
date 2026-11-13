(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData, Security = window.IDAccountSecurity;
  if (!A || !D?.authRequired) return;
  const E = A.esc, $ = A.$;
  const scope = 'renewal-handoffs';
  const staffRoot = 'workspace/renewals';
  const financeRoute = 'workspace/finance-renewals';
  const finishPrefix = 'workspace/renewal-submit/';
  const staffTabs = [['', '选订单'], ['/sent', '已送财务'], ['/ready', '待补资料'], ['/history', '办理记录']];
  const financeTabs = ['待处理', '处理中', '已处理'];
  const statuses = { pending: '待财务', processing: '财务处理中', paid: '待员工补资料',
    returned: '财务已退回', complete: '已续费' };
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'].map(value => [value, value]);
  const dates = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
  const beijing = value => {
    const date = value && new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : value.replace(' ', 'T') + '+08:00');
    return date && Number.isFinite(date.getTime()) ? dates.format(date) : '—';
  };
  const dateValue = date => dates.format(date).replace(' ', 'T');
  const currentRole = () => A.state.actor?.role;
  const canViewOrder = () => ['admin', 'super'].includes(currentRole());
  const storeKey = name => 'renewal-handoff:' + name;
  const defaults = () => ({ page: 1, pageSize: 20, status: '待处理', period: 'all', product: '', query: '' });
  let active;
  let preferredOrder;

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
  const tab = (label, route, current) => '<a class="button' + (current ? ' primary' : '') + '" href="#/' + route +
    '"' + (current ? ' aria-current="page"' : '') + '>' + label + '</a>';
  const navigation = route => '<nav class="panel renewal-progress-navigation" aria-label="续费办理进度">' +
    staffTabs.map(([path, label]) => tab(label, staffRoot + path, route === staffRoot + path)).join('') + '</nav>';
  const financeNavigation = current => '<div class="tabs" role="tablist" aria-label="财务续费状态">' +
    financeTabs.map(label => '<button type="button" class="tab' + (label === current ? ' active' : '') +
      '" role="tab" data-action="renewal-handoff-finance-tab" data-id="' + label + '" aria-selected="' +
      String(label === current) + '">' + label + '</button>').join('') + '</div>';

  function render() {
    const route = A.state.route;
    const finance = route === financeRoute, finishing = route.startsWith(finishPrefix);
    const title = finance ? '财务续费' : finishing ? '提交续费订单' : '续费管理';
    const help = finance ? '请先接手要办理的订单。核对实际付款后登记金额及用卡，交回员工完成新订单。'
      : finishing ? '根据财务已登记的实付资料，补齐客户实收和新的订阅周期。'
      : '选中需要续费的订单，确认后交给财务。财务办结后，请在「待补资料」提交新订单。';
    const back = finishing ? '<a class="button" href="#/workspace/renewals/ready">返回待补资料</a>'
      : !finance && canViewOrder() ? '<a class="button" href="#/workspace/renewals/reminders">续费提醒</a>' : '';
    const panel = '<section class="panel staff-workspace" data-renewal-handoff>' +
      '<div class="toolbar"><div class="toolbar-right">' + button('刷新', 'refresh') + '</div></div>' +
      '<p class="panel-body inline-notice warning" role="status" data-renewal-error hidden></p>' +
      '<div data-renewal-body></div><span data-renewal-progress></span></section>';
    return A.header(title, help, back) + (finance || finishing ? panel
      : '<div class="renewal-progress-layout">' + navigation(route) + panel + '</div>');
  }

  function selected() {
    return A.getSelection('renewal-handoff');
  }

  function rowsFor(view) {
    const query = view.filter.query.trim().toLowerCase();
    const choosing = view.route === staffRoot;
    const rows = choosing ? view.data.candidates.map(order => ({ id: order.id, order })) : view.data.items;
    const routeStatuses = { [staffRoot + '/sent']: ['pending', 'processing'], [staffRoot + '/ready']: ['paid'],
      [staffRoot + '/history']: ['returned', 'complete'] };
    const financeStatuses = { 待处理: ['pending'], 处理中: ['processing'], 已处理: ['paid', 'returned', 'complete'] };
    const accepted = view.finance ? financeStatuses[view.filter.status] : routeStatuses[view.route];
    const now = Date.now();
    return rows.filter(row => {
      const { order } = row;
      const expiry = Date.parse(order.expiry && /(?:Z|[+-]\d\d:\d\d)$/.test(order.expiry)
        ? order.expiry : String(order.expiry || '').replace(' ', 'T') + '+08:00');
      return (choosing || accepted?.includes(row.status)) && (!view.filter.product || order.product === view.filter.product) &&
        (!choosing || view.filter.period === 'all' || (view.filter.period === 'expired' ? expiry <= now :
          expiry > now && expiry <= now + (view.data.reminderHours || 168) * 3_600_000)) &&
        (!query || [order.number, order.account, order.customer, order.wechat, order.owner, row.submittedBy]
          .some(value => String(value || '').toLowerCase().includes(query)));
    }).sort((a, b) => choosing ? String(a.order.expiry || '').localeCompare(String(b.order.expiry || '')) ||
        a.order.number.localeCompare(b.order.number) : String(b.completedAt || b.paidAt || b.submittedAt)
          .localeCompare(String(a.completedAt || a.paidAt || a.submittedAt)));
  }

  function rowActions(view, row) {
    if (view.finance) {
      if (row.canTake) return button('接手', 'claim', row.id);
      if (row.status === 'processing' && row.assignedToMe)
        return (row.sourceChanged ? '' : button(row.paymentReview ? '核对并登记实付' : '登记实付', 'payment', row.id, 'primary')) +
          button('退回', 'return', row.id) + button('移交', 'transfer', row.id);
      if (row.canTransfer) return button('移交', 'transfer', row.id);
      return row.processingBy ? E(row.processingBy) : '—';
    }
    if (row.canFinish && !row.sourceChanged)
      return '<a class="button compact primary" href="#/' + finishPrefix + E(row.id) + '">补资料并提交</a>';
    return row.newOrderId && A.canVisit('orders/detail/' + row.newOrderId)
      ? '<a class="button compact" href="#/orders/detail/' + E(encodeURIComponent(row.newOrderId)) + '">查看新订单</a>' : '—';
  }

  function list(view) {
    const choosing = view.route === staffRoot;
    const rows = rowsFor(view);
    const { pageSize } = view.filter;
    view.filter.page = Math.max(1, Math.min(view.filter.page, Math.ceil(rows.length / pageSize)));
    const start = (view.filter.page - 1) * pageSize;
    const columns = [
      ['orderNo', '原订单', row => E(row.order.number || '—')],
      ['customer', '客户', row => E(row.order.customer)],
      ['account', '订阅账号', row => E(row.order.account || '待补资料')],
      ['plan', '产品与套餐', row => E([row.order.product, row.order.plan].join(' · '))],
      ['expiry', '原到期时间', row => E(beijing(row.order.expiry))],
      ['payment', '付款方式', row => E(row.order.payment)]
    ];
    if (choosing) {
      columns.push(['owner', '归属人', row => E(row.order.owner || '—')]);
    } else {
      columns.push(['submittedBy', '提交人', row => E(row.submittedBy || '—')],
        ...(view.finance ? [['submittedAt', '提交时间', row => E(beijing(row.submittedAt))],
          ['originalCard', '原用卡尾号', row => E(row.order.originalLast4 || '—')]] : []),
        ['status', '办理进度', row => A.tag(row.paymentReview ? '付款待核对' : row.sourceChanged && !['returned', 'complete'].includes(row.status) ? '原单待核对' :
          statuses[row.status] || '待核对', row.status === 'paid' ? 'success' : '')],
        ...(currentRole() === 'supervisor' ? [] : [
          ['amount', '本次实付', row => E(row.amount ? row.amount + ' ' + row.currency : '—')],
          ['last4', '本次用卡尾号', row => E(row.last4 || '—')]
        ]),
        ...(view.finance && view.filter.status === '已处理' ? [['paidAt', '付款登记时间', row => E(beijing(row.paidAt))],
          ['reference', '付款凭据编号', row => E(row.reference || '—')]] : []),
        ['newOrderNo', '结果', row => E(row.newOrderNo || row.returned || '—')], ['actions', '操作', row => rowActions(view, row)]);
    }
    return A.table(columns.map(([id, label, render]) => ({ id, label, render, action: id === 'actions' })),
      rows.slice(start, start + pageSize), choosing ? 'renewal-handoff' : '', choosing ? '待续费订单' :
        view.finance ? '财务续费订单' : '续费办理记录', { title: '暂无符合条件的订单', description: '可切换筛选或稍后刷新。' }) +
      window.IDPagination.render({ id: 'renewal-handoff-pagination', page: view.filter.page, pageSize, total: rows.length });
  }

  function selectionButton(view) {
    const anchor = $('[data-action="renewal-handoff-submit"]', view.host);
    if (!anchor) return;
    const count = selected(view).size;
    anchor.textContent = count ? '提交给财务（' + count + '）' : '提交给财务';
    anchor.disabled = count === 0 || view.saving;
  }

  function drawList(view) {
    const host = $('[data-renewal-list]', view.host);
    if (!host) return;
    host.innerHTML = list(view);
    selectionButton(view);
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
      ...(row.last4 ? [['本次银行卡尾号', row.last4]] : [])]) +
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
    window.IDSearchInput?.suspend(body);
    if (view.route.startsWith(finishPrefix)) {
      body.innerHTML = finishForm(view);
      return;
    }
    body.innerHTML = (view.finance ? financeNavigation(view.filter.status) : '') +
      '<div class="toolbar"><div class="toolbar-left"><div class="search-field">' + A.icon('search') +
      '<input id="renewal-handoff-search" data-auto-search aria-label="搜索续费订单" placeholder="搜索客户、账号或原订单编号" value="' +
      E(view.filter.query) + '"></div>' +
      '<label for="renewal-handoff-product">产品</label><select id="renewal-handoff-product">' +
      A.options([['', '全部产品'], 'GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'], view.filter.product) + '</select>' +
      (view.route === staffRoot ? '<label for="renewal-handoff-period">到期时间</label><select id="renewal-handoff-period">' +
        A.options([['all', '全部可续费'], ['upcoming', '即将到期'], ['expired', '已到期']], view.filter.period) + '</select>' : '') +
      '</div><div class="toolbar-right" data-page-actions>' + (view.route === staffRoot ? button('提交给财务', 'submit', '', 'primary') : '') +
      '</div></div><div data-renewal-list></div>';
    drawList(view);
    window.IDSearchInput?.restore(body);
  }

  function notifyError(view, text) {
    if (active !== view || !view.host.isConnected) return;
    const element = $('[data-renewal-error]', view.host);
    element.textContent = text;
    element.hidden = !text;
  }

  async function load(view, refresh = false) {
    const key = { view: view.finance ? 'finance' : 'staff' };
    const id = (view.request || 0) + 1;
    view.request = id;
    const cached = D.queries.peek(scope, key)?.data;
    const body = $('[data-renewal-body]', view.host);
    const latest = () => active === view && view.host.isConnected && view.request === id;
    if (!view.data && cached) {
      view.data = cached;
      draw(view);
    }
    const feedback = A.beginRegionRead(view.host, $('[data-renewal-progress]', view.host),
      { loadingText: view.data ? '' : '正在读取续费资料…', refreshButton: $('[data-action="renewal-handoff-refresh"]', view.host) });
    try {
      const data = await D.queries.read(scope, key, () => D.renewalHandoffs(key.view), { refresh });
      if (!latest()) return true;
      const openForm = $('#renewal-finish-form', view.host);
      view.data = data;
      if (openForm?.contains(document.activeElement) && data.items.some(row => row.id === openForm.dataset.renewalId &&
          row.version === Number(openForm.dataset.renewalVersion) && row.canFinish && !row.sourceChanged)) {
        notifyError(view, '');
        return true;
      }
      if (view.route === staffRoot) {
        const candidates = new Set(data.candidates.map(order => order.id));
        const selection = selected(view);
        for (const orderId of selection) if (!candidates.has(orderId)) selection.delete(orderId);
        if (preferredOrder) {
          if (candidates.has(preferredOrder)) {
            selection.add(preferredOrder);
            const index = rowsFor(view).findIndex(row => row.id === preferredOrder);
            if (index >= 0) view.filter.page = Math.floor(index / view.filter.pageSize) + 1;
          } else {
            const current = data.items.find(row => row.order.id === preferredOrder && row.status !== 'returned');
            if (current) {
              preferredOrder = undefined;
              A.go(staffRoot + (current.status === 'paid' ? '/ready' : current.status === 'complete' ? '/history' : '/sent'));
              return true;
            }
          }
          const unavailable = !candidates.has(preferredOrder);
          preferredOrder = undefined;
          if (unavailable) {
            draw(view);
            notifyError(view, '这笔原订单目前不可送财务，请核对客户资料和续费状态。');
            return true;
          }
        }
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
    notifyError(view, '');
    const formError = form?.querySelector('[data-renewal-form-error]');
    if (formError) {
      formError.hidden = true;
      formError.replaceChildren();
    }
    let feedback, timing;
    try {
      if (['paid', 'transfer'].includes(command.action) && !(await Security?.verify())) return;
      if (active !== view || (form && !form.isConnected)) return;
      if (form) form.inert = true;
      feedback = A.beginActionFeedback(submitter, '正在登记…');
      const measure = command.action === 'finish' ? 'order-save' : undefined;
      timing = measure ? window.IDSiteTiming?.start(measure) : undefined;
      const result = await D.saveRenewalHandoff(command, { operationId: crypto.randomUUID(), measure, timing });
      if (!result.saved) throw new Error('保存结果待核对，请刷新');
      timing?.finish();
      if (active !== view) return;
      if (form?.closest('dialog')) {
        A.state.drafts.delete(form.dataset.renewalDraft);
        A.closeDrawer();
      }
      if (command.action === 'submit') {
        selected(view).clear();
        A.go(staffRoot + '/sent');
      } else {
        if (command.action === 'finish') {
          A.state.drafts.delete(storeKey(view.route + ':form'));
          if (canViewOrder()) void A.modules.commerce?.refreshAfterOrderSync?.();
        }
        const updated = await load(view, true);
        if (!updated) notifyError(view, '已保存，列表暂未刷新。请点击刷新。');
      }
      const messages = { submit: '已提交给财务', claim: '已接手这笔续费', paid: '已交回续费管理，等待员工补资料',
        return: '已退回业务人员', finish: '订单提交成功', transfer: '已移交，其他财务可接手' };
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
      if (form?.isConnected) form.inert = false;
      feedback?.finish();
      if (active === view) selectionButton(view);
    }
  }

  function confirmSubmission(view, submitter) {
    const orders = view.data.candidates.filter(row => selected(view).has(row.id));
    if (!orders.length || orders.length > 50) {
      notifyError(view, orders.length ? '每次最多提交 50 笔，请分批办理。' : '请先勾选需要续费的订单。');
      return;
    }
    const preview = orders.slice(0, 4).map(row => row.number || row.customer).join('、');
    A.confirmAction('确认提交给财务', '已选 ' + orders.length + ' 笔。' + preview + (orders.length > 4 ? ' 等' : '') +
      '。请确认客户需要续费，提交后由财务办理。', () => {
      void save(view, { action: 'submit', confirmed: true, orders: orders.map(({ id, version }) => ({ id, version })) }, submitter);
    }, '确认送财务');
  }

  function paymentForm(view, row, returning) {
    const id = returning ? 'renewal-return-form' : 'renewal-payment-form';
    const draftKey = storeKey(id + ':' + row.id);
    const draft = A.state.drafts.get(draftKey) || {};
    const bank = row.order.payment === '银行卡';
    const mode = draft['renewal-cardMode'] || 'none';
    const details = returning ? inputField('退回原因', 'renewal-reason', draft['renewal-reason'] || '', 'required maxlength="160"')
      : inputField('实际付款金额', 'renewal-amount', draft['renewal-amount'] || '', 'maxlength="21" inputmode="decimal" required') +
      (bank ? fieldCurrency('付款币种', 'renewal-currency', draft['renewal-currency'] || row.order.previousPaidCurrency || 'USD')
        : props([['付款币种', 'USD']]) + '<input type="hidden" name="renewal-currency" value="USD">') +
      (bank ? selectField('本次使用的卡', 'renewal-cardMode', [['none', '暂不登记卡号'], ['original', '沿用原卡'],
        ['pool', '从系统选卡'], ['manual', '填写本次卡号']], mode) +
        '<div class="commerce-span-all" data-renewal-card-fields></div>' : '') +
      inputField('付款凭据编号（选填）', 'renewal-reference', draft['renewal-reference'] || '', 'maxlength="120"');
    const label = returning ? '确认退回' : '提交实付给员工';
    const check = returning ? '我已确认本次尚未付款' : bank ? '我已核对付款成功及本次用卡'
      : '我已核对苹果付款成功，并确认付款对应上方订阅账号';
    A.openDrawer(returning ? '退回续费申请' : '登记续费实付', '', props([
      ['原订单', row.order.number], ['客户', row.order.customer], ['订阅账号', row.order.account], ['付款方式', row.order.payment],
      ...(row.order.originalLast4 ? [['原用卡尾号', row.order.originalLast4]] : [])
    ]) + '<form id="' + id + '" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '" data-renewal-draft="' + E(draftKey) + '"><div class="form-grid">' + details +
      '</div><div class="form-section"><label class="checkbox-label"><input id="renewal-confirmed" name="renewal-confirmed" type="checkbox" required> ' +
      check + '</label></div><p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
      A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id + '">' + label + '</button>', draftKey);
    const form = $('#' + id, $('#drawer'));
    if (!returning && bank) updateCardFields(form, false);
    form.addEventListener('input', () => preserveForm(form));
  }

  function preserveForm(form) {
    if (!form?.isConnected || !form.dataset.renewalDraft) return;
    const values = Object.fromEntries(new FormData(form));
    delete values['renewal-cardNumber'];
    delete values['renewal-cardSerial'];
    delete values['renewal-confirmed'];
    A.state.drafts.set(form.dataset.renewalDraft, values);
  }

  function transferForm(row) {
    const id = 'renewal-transfer-form';
    A.openDrawer('移交财务续费', '先核对是否已经付款。付款未确认时，接手的人应先查付款凭证。', props([
      ['原订单', row.order.number], ['当前经办人', row.processingBy]
    ]) + '<form id="' + id + '" data-renewal-id="' + E(row.id) + '" data-renewal-version="' + row.version +
      '"><div class="form-grid">' + inputField('交接原因', 'renewal-reason', '', 'required maxlength="160"') +
      selectField('付款情况', 'renewal-review', [['review', '已付款或待核对'], ['unpaid', '已确认未付款']],
        'review') + '</div><label class="checkbox-label"><input name="renewal-confirmed" type="checkbox" required> 已核对以上资料</label>' +
      '<p class="field-error" role="alert" data-renewal-form-error hidden></p></form>',
    A.button('取消', 'drawer-close') + '<button type="submit" class="button primary" form="' + id + '">确认移交</button>');
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
      if (!(await Security?.verify())) return;
      node.disabled = true;
      const { items, poolUnavailable } = await D.renewalHandoffs('cards', form.dataset.renewalId);
      if (node.isConnected && form.elements['renewal-cardMode']?.value === 'pool') {
        const previous = A.state.drafts.get(form.dataset.renewalDraft)?.['renewal-cardId'] || '';
        container.innerHTML = (items.length ? selectField('银行卡尾号', 'renewal-cardId',
          [['', '请选择本次使用的卡'], ...items.map(row => [row.id, row.last4 + (row.label ? ' · ' + row.label : '')])], previous)
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
    else if (command === 'finance-tab') {
      view.filter.status = node.dataset.id;
      view.filter.page = 1;
      draw(view);
    } else if (command === 'submit') confirmSubmission(view, node);
    else if (command === 'cards') await loadCards(node.closest('form'), node);
    else {
      const row = view.data?.items.find(item => item.id === node.dataset.id);
      if (row && command === 'claim') await save(view, { action: 'claim', id: row.id, version: row.version }, node);
      if (row && ['payment', 'return'].includes(command)) paymentForm(view, row, command === 'return');
      if (row?.canTransfer && command === 'transfer') transferForm(row);
    }
    return true;
  }

  function onSubmit(form) {
    const actions = { 'renewal-finish-form': 'finish', 'renewal-payment-form': 'paid', 'renewal-return-form': 'return',
      'renewal-transfer-form': 'transfer' };
    const action = actions[form.id];
    if (!active || !action) return false;
    if (!form.reportValidity()) return true;
    const view = active, fields = Object.fromEntries(new FormData(form));
    const command = { action, id: form.dataset.renewalId, version: Number(form.dataset.renewalVersion) };
    for (const key of ['email', 'xHandle', 'start', 'expiry', 'saleAmount', 'saleCurrency', 'amount', 'currency',
      'reference', 'reason', 'cardMode', 'cardId', 'cardNumber', 'cardSerial'])
      if (typeof fields['renewal-' + key] === 'string') command[key] = fields['renewal-' + key].trim();
    if (action === 'paid' && command.cardMode === 'pool' && !command.cardId) {
      const notice = $('[data-renewal-form-error]', form);
      notice.textContent = '请选择本次实际使用的银行卡。';
      notice.hidden = false;
      return true;
    }
    if (action !== 'finish') command.confirmed = fields['renewal-confirmed'] === 'on';
    if (action === 'transfer') command.review = fields['renewal-review'] === 'review';
    const submitter = form.querySelector('[type="submit"]') || document.querySelector('[form="' + form.id + '"][type="submit"]');
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
    const values = selected(view);
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
    const view = { route, finance: route === financeRoute, filter: filters(route), host };
    active = view;
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
    void load(view);
  }

  window.IDRenewalHandoff = { select(id) {
    preferredOrder = id;
    const filter = filters(staffRoot);
    Object.assign(filter, { query: '', period: 'all', product: '', page: 1 });
    if (active?.route === staffRoot) void load(active);
    else A.go(staffRoot);
  } };
  window.IDDesignModules.push({ matches, render, afterRender: activate, onClick, onSubmit, onChange,
    deactivate() { active = undefined; },
    clearPageState() { active = preferredOrder = undefined; },
    onDataChanges(scopes) {
      if (!active || active.saving || !scopes.some(key => [scope, 'commerce'].includes(key))) return;
      const view = active;
      if (scopes.includes('commerce') && !scopes.includes(scope)) D.queries.invalidate([scope]);
      if (view.host.contains(document.activeElement) && view.route.startsWith(finishPrefix))
        preserveForm($('#renewal-finish-form', view.host));
      return load(view);
    } });
})();
