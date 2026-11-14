export function createPage(A, definition) {
  const D = window.IDLocalData, Security = window.IDAccountSecurity;
  const E = A.esc, $ = A.$;
  const plans = [['plus', 'Plus'], ['pro100', 'Pro 100'], ['pro200', 'Pro 200'], ['pro500', 'Pro 500']];
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'].map(value => [value, value]);
  const types = { google: '谷歌邮箱', apple: '苹果邮箱', microsoft: '微软邮箱', relay: '苹果隐藏邮箱',
    gpt: 'GPT 账号', claude: 'Claude 账号', gemini: 'Gemini 账号', grok: 'Grok 账号' };
  const resource = definition.resource.slice('staff/'.length);
  const isCards = definition.route === 'staff/finance/cards';
  const initialState = () => ({ draft: {}, page: 1, reviewPage: { page: 1 }, version: 0 });
  let state = initialState();
  let active;

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

  const searchField = (placeholder, current) => `<div class="search-field">${A.icon('search')}
    <input type="search" id="staff-list-search" data-auto-search data-staff-query aria-label="${E(placeholder)}" value="${E(current.query || '')}"
    placeholder="${E(placeholder)}" /></div>`;
  const search = placeholder => `<div class="toolbar"><div class="toolbar-left">${searchField(placeholder, active.current)}</div></div>`;

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
    const all = current.result.items || [];
    const rows = all.filter(row => (!current.query || row.last4.includes(current.query.trim())) &&
      (!current.cardStatus || cardState(row) === current.cardStatus) &&
      (!current.cardPlan || (current.cardPlan === 'unconfigured' ? !row.plans?.length : row.plans?.includes(current.cardPlan))));
    const size = current.pageSize || 20;
    current.page = Math.max(1, Math.min(current.page, Math.ceil(rows.length / size)));
    const columns = [
      { id: 'last4', label: '银行卡尾号', render: row => `<strong>${E(row.last4)}</strong>` },
      { id: 'active', label: '状态', mobileSummary: true, render: row => {
        const value = cardState(row);
        return A.tag(value, value === '可用' ? 'success' : value === '暂缓使用' ? 'warning' : value === '不可用' ? 'danger' : '');
      } },
      { id: 'plans', label: '允许套餐', mobileSummary: true, render: row => row.plans?.length
        ? `<span class="finance-card-plans">${row.plans.map(key => A.tag(plans.find(([value]) => key === value)?.[1] || key)).join('')}</span>`
        : '<span class="finance-muted">未配置套餐</span>' },
      { id: 'uses', label: '使用次数', mobileSummary: true },
      { id: 'lastUsedAt', label: '最近使用（北京）', render: row => E(time(row.lastUsedAt)) },
      { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${rowAction('设置套餐', 'card-plan', row.id)}${
        row.active ? rowAction('停用', 'card-stop', row.id) : ''}</div>` }
    ];
    return A.table(columns, rows.slice((current.page - 1) * size, current.page * size), '', '银行卡和套餐', {
      title: all.length ? '没有符合条件的银行卡' : '暂无银行卡',
      description: all.length ? '可调整尾号、状态或套餐筛选。' : '点击「导入银行卡」添加，并选择允许使用的套餐。'
    }) + window.IDPagination.render({ id: 'staff-list', page: current.page, pageSize: size, total: rows.length });
  }

  const cardState = row => row.state || (row.active ? '可用' : '已停用');
  const cardPolicyLabel = current => current.result.strict ? '仅使用已配置套餐的卡' : '未配置套餐的卡按现有规则使用';

  function cardToolbar() {
    const filter = (label, key, choices, selected) => `<label class="finance-filter">${label}${
      A.select('staff-card-' + key, choices, selected).replace('<select', `<select data-card-filter="${key}" aria-label="${key === 'status' ? '银行卡状态' : '允许套餐'}"`)}</label>`;
    return `<div class="toolbar toolbar--inline finance-toolbar"><div class="toolbar-left">${searchField('按尾号查找银行卡', state)}${
      filter('状态', 'status', [['', '全部状态'], ...['可用', '暂缓使用', '已停用', '不可用'].map(value => [value, value])], state.cardStatus || '')}${
      filter('套餐', 'plan', [['', '全部套餐'], ...plans, ['unconfigured', '未配置套餐']], state.cardPlan || '')}</div>
      <div class="toolbar-right">${control('刷新', 'refresh')}${control('取卡设置', 'card-settings', 'disabled')}
      <button type="button" class="button primary" data-staff-action="card-import-open" disabled>导入银行卡</button></div></div>`;
  }

  function cardReviewSection(current) {
    const pending = current.result.pending || [];
    return !pending.length ? '' : '<section class="finance-card-review">' +
      heading('待核对的银行卡维护', '核对只读取现有银行卡资料。与提交时的资料一致后，系统会补记结果。', 'staff-card-review') +
      '<div data-staff-card-reviews>' + cardReviews(current) + '</div></section>';
  }

  function cards(current) {
    return cardReviewSection(current) + `<div class="finance-list-meta"><span data-card-policy>取卡规则：${E(cardPolicyLabel(current))}</span>${
      A.titleInfo('取卡规则', '已配置套餐的卡只参与所选套餐。未配置套餐的卡是否参与取卡，由「取卡设置」控制。', 'staff-card-policy-help')
    }</div><div data-staff-list>${cardList(current)}</div>`;
  }

  function cardReviews(current) {
    return list(current.result.pending, current.reviewPage, '待核对的银行卡维护', [
      ['label', '操作'], ['submittedBy', '提交人'], ['at', '提交时间', row => E(time(row.at))],
      ['actions', '处理', row => row.canReview ? rowAction('核对上次操作', 'card-reconcile', row.id) +
        rowAction('登记未确认', 'card-unconfirmed', row.id) : '请提交人核对']
    ], 'staff-card-review-list');
  }

  const content = {
    'staff/customers': customers,
    'staff/team': current => list(current.result.items, current, '小组员工',
      [['name', '员工'], ['orders', '订单数'], ['customers', '客户数']]),
    'staff/business-proxies': proxyView,
    'staff/registration': registration,
    'staff/finance/cards': cards
  };

  function render() {
    if (isCards) return A.header(definition.label, definition.description) +
      `<section class="panel staff-workspace finance-workspace" data-staff-workspace>${cardToolbar()}
      <p class="finance-feedback" data-staff-status role="status" hidden></p>
      <div data-staff-content><p class="finance-feedback">正在读取银行卡…</p></div></section>`;
    return A.header(definition.label, definition.description) + `<section class="panel staff-workspace" data-staff-workspace>
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
    const { current, host } = view;
    current.failed = false;
    view.loading = (async () => {
      host.setAttribute('aria-busy', 'true');
      if (isCards) for (const button of host.querySelectorAll('.finance-toolbar [data-staff-action]')) button.disabled = true;
      try {
        const snapshot = await request(resource);
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
        if (isCards) for (const button of host.querySelectorAll('.finance-toolbar [data-staff-action]'))
          button.disabled = button.dataset.staffAction !== 'refresh' && (!current.result || current.failed);
      }
    })();
    return view.loading;
  }

  function request(path, body, operation) {
    return D.staffWorkspace(path, body, operation);
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
    const { current } = view;
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
      const result = action === 'alias'
        ? await D.relay('alias-register', payload)
        : await request(resource, body, operation);
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

  async function onSubmit(event, view, version = view.current.version) {
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
      return write(view, action, { action: 'import', lines: data.lines, plans: chosen, version }, formNode);
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

  function cardImport(view) {
    const version = view.current.version;
    A.openDrawer('导入银行卡', '每行一张卡，按卡号、有效期、安全码、持卡人填写，用空格或竖线分隔。持卡人可留空。',
      form('card-import', A.field('银行卡资料', 'staff-lines',
        '<textarea id="staff-lines" name="staff-lines" rows="7" required autocomplete="off" spellcheck="false" data-no-draft></textarea>', true) +
        optionPlans('staff-import-plan', view.current.draft['card-import']?.plans), '核对并导入') +
      '<p class="field-error" data-staff-dialog-status role="alert" hidden></p>', '', 'staff-card-import');
    const drawer = $('#drawer'), formNode = $('[data-staff-form]', drawer);
    formNode.classList.add('finance-card-import');
    formNode.addEventListener('input', () => saveDraft(formNode, view.current));
    formNode.addEventListener('submit', async event => {
      const error = $('[data-staff-dialog-status]', drawer);
      error.hidden = true;
      message(view, '');
      if (await onSubmit(event, view, version)) {
        if (formNode.isConnected) A.closeDrawer();
      } else if (formNode.isConnected && $('[data-staff-status]', view.host)?.textContent) {
        error.textContent = $('[data-staff-status]', view.host).textContent;
        error.hidden = false;
      }
    });
    drawer.addEventListener('id-view-deactivate', () => {
      for (const input of formNode.querySelectorAll('[data-no-draft]')) input.value = '';
    }, { once: true });
  }

  function cardSettings(view) {
    const version = view.current.version;
    A.openDrawer('取卡设置', '已配置套餐的银行卡只用于所选套餐。这里决定未配置套餐的银行卡是否参与自动取卡。',
      `<div class="property-list"><div class="property-row"><span>当前规则</span><strong>${E(cardPolicyLabel(view.current))}</strong></div></div>` +
      '<p class="field-error" data-staff-dialog-status role="alert" hidden></p>',
      control(view.current.result.strict ? '取消严格取卡' : '仅使用已配置套餐的卡', 'card-strict'), 'staff-card-settings');
    const drawer = $('#drawer'), button = $('[data-staff-action="card-strict"]', drawer);
    const strict = !view.current.result.strict;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (!await Security.confirmChange('更改取卡规则', strict
          ? '没有配置套餐的银行卡将暂停自动使用。' : '没有配置套餐的银行卡会按现有规则参与自动取卡。')) return;
        if (await write(view, 'card-strict', { action: 'strict', strict, version })) {
          if (button.isConnected) A.closeDrawer();
        } else if (button.isConnected) {
          const error = $('[data-staff-dialog-status]', drawer);
          error.textContent = $('[data-staff-status]', view.host)?.textContent || '';
          error.hidden = !error.textContent;
        }
      } finally { button.disabled = false; }
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
    if (action === 'renewal') return window.IDRenewalHandoff?.select(id);
    if (action === 'card-import-open') return cardImport(view);
    if (action === 'card-settings') return cardSettings(view);
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
    const policy = $('[data-card-policy]', view.host);
    if (policy) policy.textContent = '取卡规则：' + cardPolicyLabel(view.current);
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
    const view = { host, route: definition.route, current: state };
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
        if (view.current.result) drawList(view);
      }
    });
    host.addEventListener('change', event => {
      const key = event.target.dataset.cardFilter;
      if (!key) return;
      view.current[key === 'status' ? 'cardStatus' : 'cardPlan'] = event.target.value;
      view.current.page = 1;
      if (view.current.result) drawList(view);
    });
    host.addEventListener('id-pagination-change', event => {
      if (event.detail.id === 'staff-card-review-list') {
        view.current.reviewPage.page = event.detail.page;
        $('[data-staff-card-reviews]', view.host).innerHTML = cardReviews(view.current);
        return;
      }
      if (event.detail.id !== 'staff-list') return;
      view.current.page = event.detail.page;
      if (isCards) view.current.pageSize = event.detail.pageSize;
      drawList(view);
    });
    void load(view);
  }

  return { render, afterRender: activate,
    deactivate() { active = undefined; },
    clearPageState() { active = undefined; state = initialState(); },
    onDataChanges(scopes) {
      if (!active || active.saving || !scopes.includes(definition.scope)) return;
      const view = active;
      if (view.host.querySelector('form :focus') || [...view.host.querySelectorAll('[data-no-draft]')].some(input => input.value)) {
        message(view, '资料已有更新，填写完成后可刷新核对。');
        return;
      }
      return load(view);
    }
  };
}
