(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData, Security = window.IDAccountSecurity;
  if (!A || !D?.authRequired || !Security) return;
  const E = A.esc, $ = A.$;
  const plans = [['plus', 'Plus'], ['pro100', 'Pro 100'], ['pro200', 'Pro 200'], ['pro500', 'Pro 500']];
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'].map(value => [value, value]);
  const types = { google: '谷歌邮箱', apple: '苹果邮箱', microsoft: '微软邮箱', relay: '苹果隐藏邮箱',
    gpt: 'GPT 账号', claude: 'Claude 账号', gemini: 'Gemini 账号', grok: 'Grok 账号' };
  const pages = {
    'staff/customers': ['客户服务', '查看本人负责的客户和订单，录入新客户或提交续费申请。', 'customer-service', 'commerce'],
    'staff/team': ['小组工作', '查看直接分配到本组的员工及其订单、客户数量。', 'team', 'renewal-handoffs'],
    'staff/business-proxies': ['业务 IP', '登记比特执行 IP 或自动代充代理。网站登录网络由超级管理员管理。', 'business-proxies', 'bitbrowser-proxies'],
    'staff/registration': ['注册工作台', '登记邮箱和平台账号，获取本账号录入邮箱的邮件验证码。', 'registration', 'inventory'],
    'staff/finance/cards': ['自动代充银行卡', '导入银行卡、配置每张卡允许使用的套餐。影响取卡的操作须完成安全确认。', 'finance/cards', 'recharge-card-plans'],
    'staff/finance/reconciliation': ['代充对账', '按日期查看自动代充账单，订单成本和实收请到订单统计核对。', 'finance/reconciliation', 'commerce']
  };
  const states = new Map();
  let active;

  function state(route) {
    if (!states.has(route)) states.set(route, { draft: {}, page: 1, reviewPage: { page: 1 }, version: 0 });
    return states.get(route);
  }

  const control = (label, action, attrs = '') => `<button type="button" class="button" data-staff-action="${action}" ${attrs}>${label}</button>`;
  const rowAction = (label, action, id) => control(label, action, `data-id="${E(id)}"`);
  const input = (label, name, value = '', attrs = '') => A.field(label, 'staff-' + name, A.input('staff-' + name, value, attrs), attrs.includes('required'));
  const select = (label, name, choices, value = '') => A.field(label, 'staff-' + name, A.select('staff-' + name, choices, value), true);
  const heading = (title, help, id) => `<div class="section-title-row"><h2>${title}</h2>${A.titleInfo(title, help, id)}</div>`;
  const time = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  };

  function form(action, fields, label) {
    return `<form data-staff-form="${action}" class="form-section"><div class="form-grid">${fields}</div>
      <div class="form-footer"><button type="submit" class="button primary">${label}</button></div></form>`;
  }
  const optionPlans = (prefix, values = []) => `<fieldset class="staff-plan-picker commerce-span-all"><legend>允许使用的套餐</legend>
    <div class="inline-checks">${plans.map(([key, label]) => `<label><input type="checkbox" name="staff-plans" id="${prefix}-${key}" value="${key}" ${values.includes(key) ? 'checked' : ''} /> ${label}</label>`).join('')}</div></fieldset>`;
  const fields = columns => columns.map(([id, label, render]) => ({ id, label, render, ...(id === 'actions' ? { action: true } : {}) }));
  const table = (title, columns, rows) => rows.length
    ? A.table(fields(columns), rows, '', title) : A.empty('暂无记录', '');

  function list(rows, current, tableId, columns, paginationId = 'staff-list') {
    const size = 20;
    current.page = Math.max(1, Math.min(current.page, Math.ceil(rows.length / size)));
    return table(tableId, columns, rows.slice((current.page - 1) * size, current.page * size)) +
      (rows.length > size ? window.IDPagination.render({ id: paginationId, page: current.page, pageSize: size,
        pageSizes: [20], total: rows.length }) : '');
  }

  function customerTable(snapshot, current) {
    const key = (current.query || '').toLowerCase();
    const { orders = [], customers = [] } = snapshot.data || {};
    const customerNames = new Map(customers.map(row => [row.id, row.name]));
    const matching = orders.filter(row => !key || [row.orderNo, row.product, row.email, customerNames.get(row.customerId)]
      .some(value => String(value || '').toLowerCase().includes(key)));
    const contacts = customers.filter(row => !key || [row.name, row.wechat].some(value => String(value || '').toLowerCase().includes(key)));
    return heading('本人客户', '可按姓名或微信查找。', 'staff-customer-help') +
      table('本人客户', [['name', '姓名'], ['wechat', '微信'], ['actions', '操作', row =>
        row.active === false ? '已停用' : rowAction('登记订单', 'order', row.id)]], contacts.slice(0, 20)) +
      heading('本人订单', '登记续费后会新增一笔订单，保留原记录。', 'staff-orders-help') +
      list(matching, current, '本人订单', [
        ['orderNo', '订单编号'], ['product', '产品'], ['plan', '套餐'],
        ['customer', '客户', row => E(customerNames.get(row.customerId) || '—')],
        ['expiry', '到期时间'], ['actions', '操作', row => !row.draft && !row.cancelled && !row.subscriptionEnded
          ? rowAction('提交续费', 'renewal', row.id) : '—']
      ]);
  }

  function customers(current) {
    const draft = current.draft.customer || {};
    return form('customer', input('客户姓名', 'name', draft.name, 'required maxlength="80"') +
      input('客户微信', 'wechat', draft.wechat, 'maxlength="120"'), '保存客户') + search('按客户、微信、订单或邮箱搜索') +
      `<div data-staff-list>${customerTable(current.result, current)}</div>`;
  }

  function proxyView(current) {
    const draft = current.draft.proxy || {};
    return form('proxy', select('使用范围', 'target', [['personal', '我的比特执行 IP'],
      ['recharge', '自动代充业务代理']], draft.target || 'personal') +
      input('名称', 'name', draft.name, 'maxlength="80"') +
      select('代理类型', 'kind', [['dynamic_residential', '动态住宅'], ['static_residential', '静态住宅'],
        ['dedicated_static_residential', '独享静态住宅'], ['mobile', '移动代理']], draft.kind || 'static_residential') +
      input('国家或地区代码', 'countryCode', draft.countryCode, 'maxlength="2" placeholder="例如 PH、EG"') +
      input('代理链接', 'link', '', 'required type="password" autocomplete="off" data-no-draft'), '登记业务 IP') +
      list(current.result.items, current, '业务 IP',
        [['name', '名称'], ['endpoint', '地址'], ['countryCode', '国家或地区'], ['protocol', '连接方式']]);
  }

  function search(placeholder) {
    return `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${A.icon('search')}
      <input type="search" id="staff-list-search" data-auto-search data-staff-query aria-label="${E(placeholder)}" value="${E(active.current.query || '')}"
      placeholder="${E(placeholder)}" /></div></div></div>`;
  }

  function registrationList(current) {
    const { mailboxes = [], accounts = [] } = current.result.data || {};
    const rows = [...mailboxes, ...accounts].filter(row => !current.query ||
      row.email?.toLowerCase().includes(current.query.toLowerCase()));
    return list(rows, current, '本人登记记录', [
      ['email', '邮箱或账号'], ['type', '类型', row => E(types[row.type] || '—')], ['status', '状态'],
      ['actions', '操作', row => {
        if (row.used || row.inventoryState && row.inventoryState !== 'available') return '—';
        const mail = mailboxes.includes(row) ? rowAction('查邮箱验证码', 'mail-code', row.id) : '';
        const totp = row.hasAuthenticator ? rowAction('动态验证码', 'registration-code', row.id) : '';
        return mail + totp || '—';
      }]
    ]);
  }

  function registration(current) {
    const draft = current.draft.registration || {};
    const data = current.result.data || {};
    const parents = (data.appleRelay?.parents || []).filter(row => row.status === 'ACTIVE');
    const parentChoices = [['', '请选择主邮箱'], ...parents.map(row => [row.id, row.email])];
    const choices = Object.entries(types).filter(([id]) => id !== 'relay');
    const mailboxChoices = [['', '暂不关联'], ...(data.mailboxes || []).filter(row => !row.used).map(row => [row.id, row.email])];
    return heading('录入邮箱或平台账号', '收件验证码需要已连接的邮箱。保存好的动态验证码可从左侧「动态验证码」查看。', 'registration-entry-help') +
      form('registration', select('资料类型', 'type', choices, draft.type || 'google') +
        input('邮箱', 'email', draft.email, 'required type="email" maxlength="254"') +
        input('登录密码', 'password', '', 'type="password" autocomplete="new-password" data-no-draft') +
        input('动态验证码密钥', 'totp', '', 'type="password" autocomplete="off" data-no-draft') +
        input('应用专用密码', 'appPassword', '', 'type="password" autocomplete="off" data-no-draft') +
        select('关联本人登记的原邮箱', 'mailboxId', mailboxChoices, draft.mailboxId) +
        input('国家或地区', 'country', draft.country, 'maxlength="100"') +
        input('注册设备', 'device', draft.device, 'maxlength="200"') +
        input('注册代理链接', 'proxyUrl', '', 'type="password" autocomplete="off" data-no-draft') +
        input('备注', 'notes', draft.notes, 'maxlength="600"'), '保存登记') +
      heading('录入隐藏邮箱', '选中已授权的 Apple 主邮箱，登记在 Apple 创建好的隐藏邮箱。', 'registration-relay-help') +
      (parents.length ? form('alias', select('所属主邮箱', 'parentId', parentChoices, current.draft.alias?.parentId) +
        input('隐藏邮箱地址', 'aliasEmail', current.draft.alias?.aliasEmail, 'type="email" required maxlength="254"') +
        input('备注', 'aliasNote', current.draft.alias?.aliasNote, 'maxlength="120"'), '登记隐藏邮箱') :
        '<p class="inline-notice">暂无可用主邮箱，请管理员先连接主邮箱。</p>') +
      heading('本人登记记录', '邮箱连接后可以查验证码。使用公司邮箱池的收信权限，请管理员在邮箱池授权。', 'registration-list-help') + search('搜索邮箱或账号') +
      `<div data-staff-list>${registrationList(current)}</div>`;
  }

  function cardList(current) {
    const rows = (current.result.items || []).filter(row => !current.query || row.last4.includes(current.query.trim()));
    return list(rows, current, '银行卡和套餐', [
      ['last4', '银行卡尾号'], ['active', '状态', row => E(row.state || (row.active ? '可用' : '已停用'))],
      ['uses', '使用次数'], ['plans', '允许套餐', row => row.plans?.map(key => plans.find(([value]) => key === value)?.[1]).filter(Boolean).join('、') || '未设置'],
      ['actions', '操作', row => rowAction('设置套餐', 'card-plan', row.id) +
        (row.active ? rowAction('停用', 'card-stop', row.id) : '')]
    ]);
  }

  function cardReviewSection(current) {
    const pending = current.result.pending || [];
    return !pending.length ? '' : '<section class="panel-body">' +
      heading('待核对的银行卡维护', '核对只读取现有银行卡资料。与提交时的资料一致后，系统会补记结果。', 'staff-card-review') +
      '<div data-staff-card-reviews>' + cardReviews(current) + '</div></section>';
  }

  function cards(current) {
    return cardReviewSection(current) + heading('导入银行卡', '每行一张卡，按卡号、有效期、安全码、持卡人填写，用空格或竖线分隔。持卡人可留空。', 'staff-import-help') +
      form('card-import', A.field('银行卡资料', 'staff-lines',
        '<textarea id="staff-lines" name="staff-lines" rows="5" required autocomplete="off" spellcheck="false" data-no-draft></textarea>', true) +
        optionPlans('staff-import-plan', current.draft['card-import']?.plans), '核对并导入') +
      `<div class="toolbar"><div class="toolbar-left"><span>${current.result.strict ? '仅使用已配置套餐的卡' : '未配置套餐的卡按现有规则使用'}</span></div>
      <div class="toolbar-right">${control(current.result.strict ? '取消严格取卡' : '仅使用已配置套餐的卡', 'card-strict')}</div></div>` +
      search('按尾号查找银行卡') + `<div data-staff-list>${cardList(current)}</div>`;
  }

  function cardReviews(current) {
    return list(current.result.pending, current.reviewPage, '待核对的银行卡维护', [
      ['label', '操作'], ['submittedBy', '提交人'], ['at', '提交时间', row => E(time(row.at))],
      ['actions', '处理', row => row.canReview ? rowAction('核对上次操作', 'card-reconcile', row.id) +
        rowAction('登记未确认', 'card-unconfirmed', row.id) : '请提交人核对']
    ], 'staff-card-review-list');
  }

  function reconciliation(current) {
    const rows = current.result.items || [];
    return form('billing-filter', input('开始日期', 'from', current.from || '', 'type="date"') +
      input('结束日期', 'to', current.to || '', 'type="date"'), '按日期查看') +
      table('代充对账记录', [['time', '扣款时间', row => E(time(row.time))], ['reference', '账单编号'],
        ['last4', '卡尾号'], ['plan', '套餐', row => E(plans.find(([key]) => key === row.plan)?.[1] || '—')],
        ['amount', '原币金额'], ['currency', '币种'],
        ['status', '扣款状态', row => E(({ success: '成功', failed: '失败', pending: '待确认' })[row.status] || row.status || '—')]], rows) +
      `<div class="toolbar"><div class="toolbar-left">
        ${control('上一页', 'billing-prev', current.page <= 1 ? 'disabled' : '')}<span>第 ${current.page} 页</span>
        ${control('下一页', 'billing-next', !current.result.hasMore ? 'disabled' : '')}</div>
        <div class="toolbar-right"><a class="button" href="#/orders/statistics">查看订单统计</a></div></div>`;
  }

  const content = {
    'staff/customers': customers,
    'staff/team': current => list(current.result.items, current, '小组员工',
      [['name', '员工'], ['orders', '订单数'], ['customers', '客户数']]),
    'staff/business-proxies': proxyView,
    'staff/registration': registration,
    'staff/finance/cards': cards,
    'staff/finance/reconciliation': reconciliation
  };

  function render() {
    const [title, help] = pages[A.state.route];
    return A.header(title, help) + `<section class="panel staff-workspace" data-staff-workspace>
      <div class="toolbar"><div class="toolbar-right">${control('刷新', 'refresh')}</div></div>
      <div class="panel-body"><p data-staff-status role="status" hidden></p><div data-staff-content>正在读取资料…</div></div>
    </section>`;
  }

  function draw(view) {
    const body = $('[data-staff-content]', view.host);
    body.innerHTML = view.current.result ? content[view.route](view.current) : A.empty('资料未能读取', '请点击刷新重试。');
  }

  async function load(view, paint = true) {
    if (view.loading) return view.loading;
    const { current, route, host } = view;
    const path = pages[route][2];
    const query = route === 'staff/finance/reconciliation'
      ? '?' + new URLSearchParams({ page: String(current.page), ...(current.from && { from: current.from }),
        ...(current.to && { to: current.to }) }) : '';
    current.failed = false;
    view.loading = (async () => {
      host.setAttribute('aria-busy', 'true');
      try {
        const snapshot = await request(path + query);
        if (active !== view || !host.isConnected) return false;
        current.result = snapshot;
        current.version = snapshot.version ?? 0;
        current.failed = false;
        if (paint) draw(view);
        return true;
      } catch (error) {
        if (active !== view) return false;
        current.failed = true;
        if (!current.result) draw(view);
        message(view, error.message);
        return false;
      } finally {
        host.removeAttribute('aria-busy');
        view.loading = undefined;
      }
    })();
    return view.loading;
  }

  async function request(path, body, operation, prefix = '/api/local/staff/') {
    const response = await fetch(prefix + path, { cache: 'no-store', credentials: 'same-origin', ...(body && {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(operation && { 'X-ID-Operation': operation }) },
      body: JSON.stringify(body)
    }) });
    const data = await response.json().catch(() => null);
    if (response.status === 401) window.IDLocalAuth?.lock?.(data?.reason);
    if (!response.ok || !data) throw Object.assign(new Error(data?.error || '暂时无法确认结果，请刷新后核对。'), { status: response.status });
    return data;
  }

  function message(view, value) {
    if (active !== view || !view.host.isConnected) return;
    const status = $('[data-staff-status]', view.host);
    status.textContent = value;
    status.hidden = !value;
  }

  function values(form) {
    return Object.fromEntries([...new FormData(form)].filter(([name]) => name.startsWith('staff-'))
      .map(([name, value]) => [name.slice(6), value]));
  }
  const selection = form => new FormData(form).getAll('staff-plans');
  const privateFields = new Set(['password', 'totp', 'appPassword', 'proxyUrl', 'lines', 'link']);
  function saveDraft(form, current) {
    const action = form.dataset.staffForm;
    current.draft[action] = Object.fromEntries(Object.entries(values(form)).filter(([key]) => !privateFields.has(key)));
    current.draft[action].plans = selection(form);
  }

  async function write(view, action, payload, formNode) {
    if (view.saving || view.current.failed || active !== view) return;
    const { current, route } = view;
    view.saving = true;
    const control = formNode?.querySelector('[type="submit"]');
    if (control) control.disabled = true;
    const safeRetry = ['customer', 'renewal', 'manual-order', 'registration'].includes(action) ||
      action.startsWith('card-') && payload.action !== 'reconcile';
    const submittedVersion = payload.version ?? current.version;
    try {
      const body = { ...payload, version: submittedVersion };
      let operation;
      if (safeRetry) {
        const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([action, body])));
        const digest = Array.from(new Uint8Array(fingerprint), value => value.toString(16).padStart(2, '0')).join('');
        if (!view.write || view.write.digest !== digest) view.write = { digest, id: crypto.randomUUID() };
        operation = view.write.id;
      }
      if ((action.startsWith('card-') || payload.action === 'recharge') &&
          (!await Security.verify() || active !== view)) return;
      const path = pages[route][2];
      const result = action === 'alias'
        ? await request('alias-register', payload, undefined, '/api/local/apple-relay/')
        : await request(path, body, operation);
      view.write = undefined;
      delete current.draft[action];
      if (formNode?.isConnected) {
        formNode.reset();
        for (const input of formNode.querySelectorAll('[data-no-draft]')) input.value = '';
      }
      const changed = await load(view, payload.action !== 'reconcile');
      if (changed && payload.action === 'reconcile') {
        drawCardReviews(view);
        drawList(view);
      }
      const text = result.unconfirmed ? '已记录结果未确认，请以当前卡池资料为准' :
        result.reconciled ? '已核对银行卡维护结果' :
        result.count === undefined ? '保存成功' : '已导入 ' + result.count + ' 张银行卡';
      message(view, changed ? text : text + '，列表刷新失败，请点击刷新。');
      return true;
    } catch (error) {
      if (error.status < 500 && !action.startsWith('card-')) view.write = undefined;
      message(view, error.message);
      if (!formNode) A.notify(error.message);
      if (action.startsWith('card-') && payload.action !== 'reconcile' && error.status >= 500 &&
          await load(view, false) && current.result?.pending?.length) drawCardReviews(view);
      return false;
    } finally {
      view.saving = false;
      if (control?.isConnected) control.disabled = false;
    }
  }

  async function onSubmit(event, view) {
    const formNode = event.target.closest('[data-staff-form]');
    if (!formNode) return;
    event.preventDefault();
    event.stopPropagation();
    if (!formNode.reportValidity()) return;
    if (view.saving) return;
    const { current } = view;
    const action = formNode.dataset.staffForm;
    const data = values(formNode);
    saveDraft(formNode, current);
    if (action === 'billing-filter') {
      if (data.from && data.to && data.from > data.to) return message(view, '开始日期不能晚于结束日期。');
      Object.assign(current, { page: 1, from: data.from, to: data.to });
      return load(view);
    }
    if (action === 'proxy') {
      const { target, ...proxy } = data;
      if (target === 'recharge') return write(view, action, { ...proxy, action: 'recharge' }, formNode);
      if (!proxy.name.trim()) return message(view, '请填写 IP 名称。');
      return write(view, action, proxy, formNode);
    }
    if (action === 'alias') {
      const parent = current.result.data?.appleRelay?.parents?.find(row => row.id === data.parentId);
      if (!parent) return message(view, '请选择已授权的主邮箱。');
      return write(view, action, { parentId: parent.id, parentVersion: parent.version ?? 1, days: 30,
        rows: [{ email: data.aliasEmail, note: data.aliasNote }] }, formNode);
    }
    if (action === 'card-import') {
      const chosen = selection(formNode);
      if (!chosen.length) return message(view, '请至少选择一个套餐。');
      if (!await Security.confirmChange('确认导入银行卡', '导入后，符合条件的银行卡会参与所选套餐的自动取卡。')) return;
      return write(view, action, { action: 'import', lines: data.lines, plans: chosen }, formNode);
    }
    if (action === 'customer') return write(view, action, { ...data, action: 'customer' }, formNode);
    return write(view, action, data, formNode);
  }

  function orderForm(view, customerId) {
    const { current } = view;
    const customer = current.result.data?.customers?.find(row => row.id === customerId);
    if (!customer || customer.active === false) return;
    const action = 'manual-order';
    const draftKey = action + ':' + customerId;
    const draft = current.draft[draftKey] || {};
    const choices = [
      ['GPT|Plus', 'GPT Plus'], ['GPT|Pro 100', 'GPT Pro 100'], ['GPT|Pro 200', 'GPT Pro 200'], ['GPT|Pro 500', 'GPT Pro 500'],
      ['Claude Max|Max 5x', 'Claude Max 5x'], ['Claude Max|Max 20x', 'Claude Max 20x'],
      ...['Google AI Plus', 'Google AI Pro', 'Google AI Ultra 5x', 'Google AI Ultra 20x'].map(plan => ['Gemini|' + plan, plan]),
      ...['The X Subscription Plus', 'The X Subscription Premium', 'The X Subscription Super',
        'The X Subscription Ultra', 'SuperGrok Lite', 'SuperGrok', 'SuperGrok Plus', 'SuperGrok Heavy',
        'X Premium', 'X Premium+'].map(plan => ['Grok|' + plan, plan])
    ];
    const fields = form(action, select('产品与套餐', 'planChoice', choices, draft.planChoice || 'GPT|Plus') +
      input('订单邮箱', 'email', draft.email, 'type="email" required maxlength="254"') +
      input('开通时间（北京）', 'start', draft.start, 'type="datetime-local" required') +
      input('到期时间（北京）', 'expiry', draft.expiry, 'type="datetime-local" required') +
      select('付款方式', 'payment', [['银行卡', '银行卡'], ['苹果内购', '苹果内购']], draft.payment || '银行卡') +
      input('实际代付金额', 'paidAmount', draft.paidAmount, 'required inputmode="decimal"') +
      select('代付币种', 'paidCurrency', currencies, draft.paidCurrency || 'USD') +
      input('客户实收金额', 'saleAmount', draft.saleAmount, 'required inputmode="decimal"') +
      select('实收币种', 'saleCurrency', currencies, draft.saleCurrency || 'CNY'), '保存已完成订单');
    A.openDrawer('登记完成订单', '填写已实际完成的业务。', `<p>${E(customer.name)}</p>${fields}`, '', 'staff-order');
    const formNode = $('#drawer [data-staff-form]');
    formNode.addEventListener('input', () => { current.draft[draftKey] = values(formNode); });
    formNode.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      const data = values(formNode);
      if (await write(view, action, { ...data, action, customerId: customer.id }, formNode)) {
        delete current.draft[draftKey];
        if (formNode.isConnected) A.closeDrawer();
      } else if (formNode.isConnected) {
        let status = $('[data-drawer-error]', formNode);
        if (!status) {
          status = document.createElement('p');
          status.dataset.drawerError = '';
          status.setAttribute('role', 'alert');
          formNode.append(status);
        }
        status.textContent = $('[data-staff-status]', view.host)?.textContent || '保存尚未确认，请刷新后核对。';
      }
    });
  }

  function cardPlan(view, row) {
    A.openDrawer('设置允许套餐', '保存后，这张银行卡只用于本次选择的套餐。', `<p>银行卡尾号 ${E(row.last4)}</p>` +
      form('card-plan', optionPlans('staff-edit-plan', row.plans || []), '保存套餐'), '', 'staff-card-plan');
    const formNode = $('#drawer [data-staff-form]');
    formNode.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      const chosen = selection(formNode);
      if (!chosen.length) return A.notify('请至少选择一个套餐。');
      if (await write(view, 'card-plan', { action: 'plans', cardIds: [row.id], plans: chosen }, formNode) && formNode.isConnected)
        A.closeDrawer();
    });
  }

  async function onClick(event, view) {
    const button = event.target.closest('[data-staff-action]');
    if (!button || button.disabled) return;
    const { current } = view;
    const action = button.dataset.staffAction;
    const id = button.dataset.id;
    if (action === 'refresh') {
      if (view.saving || view.loading) return;
      if (view.host.querySelector('[data-no-draft]:not([type="hidden"])') &&
          [...view.host.querySelectorAll('[data-no-draft]')].some(input => input.value) &&
          !await Security.confirmChange('刷新资料', '刷新后须重新填写当前页面的密码、密钥或银行卡资料。')) return;
      message(view, '');
      return load(view);
    }
    if (action === 'billing-prev' || action === 'billing-next') {
      current.page += action === 'billing-prev' ? -1 : 1;
      return load(view);
    }
    if (action === 'renewal') return window.IDRenewalHandoff?.select(id);
    if (action === 'order') return orderForm(view, id);
    if (action === 'mail-code') {
      button.disabled = true;
      try {
        const data = await request('mail-code', { id });
        if (active !== view) return;
        A.openDrawer('邮箱验证码', '查看本人登记邮箱的最新验证码。', data.items.length ?
          `<div class="property-list">${data.items.map(row => `<div class="property-row"><span>${E(row.receivedAt || '收到邮件')}</span><strong class="mono">${E(row.code)}</strong></div>`).join('')}</div>` :
          A.empty('近期没有识别到验证码', '可稍后重新查询。'));
      } catch (error) { message(view, error.message); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'registration-code') {
      button.disabled = true;
      try {
        const data = await request('registration-code', { id });
        if (active !== view) return;
        A.openDrawer('动态验证码', '验证码到期后可重新获取。',
          `<div class="property-list"><div class="property-row"><span>当前验证码</span><strong class="mono">${E(data.code)}</strong></div>
          <div class="property-row"><span>有效至（北京）</span><strong>${E(time(data.expiresAt))}</strong></div></div>`);
      } catch (error) { message(view, error.message); }
      finally { button.disabled = false; }
      return;
    }
    if (action === 'card-strict') {
      const strict = !current.result.strict;
      if (await Security.confirmChange('更改取卡规则', strict
        ? '没有配置套餐的银行卡将暂停自动使用。' : '没有配置套餐的银行卡会按现有规则参与自动取卡。'))
        await write(view, action, { action: 'strict', strict });
      return;
    }
    if (action === 'card-reconcile' || action === 'card-unconfirmed') {
      const pending = current.result.pending?.find(row => row.id === id);
      const unconfirmed = action === 'card-unconfirmed';
      if (pending?.canReview && await Security.confirmChange(unconfirmed ? '登记未确认' : '核对上次操作',
        unconfirmed ? '请先核对列表。这一步只记录结果未确认。后续维护请以卡池当前资料为准。' :
          '系统将查看当前银行卡和用卡规则。如与上次提交一致，会补记结果。')) {
        await write(view, action, { action: 'reconcile', id: pending.id, confirmed: true, ...(unconfirmed && { outcome: 'unconfirmed' }) });
      }
      return;
    }
    const card = current.result.items?.find(row => String(row.id) === id);
    if (!card) return;
    if (action === 'card-plan') return cardPlan(view, card);
    if (action === 'card-stop' && await Security.confirmChange('停用银行卡',
      '尾号 ' + card.last4 + ' 的银行卡停用后不再参与自动代充，历史记录会继续保留。'))
      await write(view, action, { action: 'stop', id: card.id });
  }

  function drawList(view) {
    const node = $('[data-staff-list]', view.host);
    if (node) {
      const builder = { 'staff/customers': () => customerTable(view.current.result, view.current),
        'staff/registration': () => registrationList(view.current), 'staff/finance/cards': () => cardList(view.current) };
      node.innerHTML = builder[view.route]();
    } else draw(view);
  }

  function drawCardReviews(view) {
    const host = $('[data-staff-content]', view.host);
    const section = $('[data-staff-card-reviews]', host);
    if (!view.current.result.pending.length) {
      section?.closest('section')?.remove();
    } else if (section) {
      section.innerHTML = cardReviews(view.current);
    } else {
      host.insertAdjacentHTML('afterbegin', cardReviewSection(view.current));
    }
  }

  function activate() {
    const region = A.activePageRegion();
    const host = $('[data-staff-workspace]', region);
    if (!host) return;
    const route = A.state.route;
    const view = { host, route, current: state(route) };
    active = view;
    if (view.current.result) draw(view);
    host.addEventListener('click', event => void onClick(event, view));
    host.addEventListener('submit', event => void onSubmit(event, view));
    host.addEventListener('input', event => {
      const form = event.target.closest('[data-staff-form]');
      if (form) saveDraft(form, view.current);
      if (event.target.matches('[data-staff-query]')) {
        view.current.query = event.target.value;
        view.current.page = 1;
        drawList(view);
      }
    });
    host.addEventListener('id-pagination-change', event => {
      if (event.detail.id === 'staff-card-review-list') {
        view.current.reviewPage.page = event.detail.page;
        $('[data-staff-card-reviews]', view.host).innerHTML = cardReviews(view.current);
        return;
      }
      if (event.detail.id !== 'staff-list') return;
      view.current.page = event.detail.page;
      drawList(view);
    });
    void load(view);
  }

  window.IDDesignModules.push({ matches: route => Object.hasOwn(pages, route), render, afterRender: activate,
    deactivate() { active = undefined; },
    clearPageState() { active = undefined; states.clear(); },
    onDataChanges(scopes) {
      if (!active || active.saving || !scopes.includes(pages[active.route][3])) return;
      const view = active;
      if (view.host.querySelector('form :focus') || [...view.host.querySelectorAll('[data-no-draft]')].some(input => input.value)) {
        message(view, '资料已有更新，填写完成后可刷新核对。');
        return;
      }
      return load(view);
    }
  });
})();
