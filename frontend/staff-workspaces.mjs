import { describeCardImport, inspectCardImport } from '/modules/recharge/codexdaichong/card-import-preview.mjs';

export function createPage(A, definition) {
  const D = window.IDLocalData, Security = window.IDAccountSecurity;
  const E = A.esc, $ = A.$;
  const plans = [['plus', 'Plus'], ['pro100', 'Pro 100'], ['pro200', 'Pro 200'], ['pro500', 'Pro 500']];
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'].map(value => [value, value]);
  const types = { google: '谷歌邮箱', apple: '苹果邮箱', microsoft: '微软邮箱', relay: '苹果隐藏邮箱',
    gpt: 'GPT 账号', claude: 'Claude 账号', gemini: 'Gemini 账号', grok: 'Grok 账号' };
  const resource = definition.resource.slice('staff/'.length);
  const isCards = definition.route === 'staff/finance/cards';
  // Super administrators use the original card pool; finance keeps its existing
  // scoped commands. Pending staff maintenance receipts remain visible in both.
  const cardPool = isCards && A.state.actor?.role === 'super' ? A.modules.operations.cardPool : null;
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

  function form(action, fields, label, attributes = '') {
    return `<form data-staff-form="${action}" class="form-section"${attributes}><div class="form-grid">${fields}</div>
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
      heading('本人订单', '需要续费时，前往快速操作中的续费管理。', 'staff-orders-help') +
      list(matching, current, '本人订单', [
        ['orderNo', '订单编号'], ['product', '产品'], ['plan', '套餐'],
        ['customer', '客户', row => E(customerNames.get(row.customerId) || '—')],
        ['expiry', '到期时间']
      ]);
  }

  function customers(current) {
    if (current.orderCustomerId) return orderForm(current);
    const draft = current.draft.customer || {};
    const fields = A.modules.commerce.customerProfileFields(
      (label, name, attrs) => input(label, name, draft[name], attrs), { employee: true });
    return `<form data-staff-form="customer">${fields}
      <div class="form-footer"><button type="submit" class="button primary">保存客户</button></div></form>` +
      search('客户、微信、订单或邮箱', '按客户、微信、订单或邮箱搜索') +
      `<div data-staff-list>${customerTable(current.result, current)}</div>`;
  }

  function proxyView(current) {
    const draft = current.draft.proxy || {};
    const personalField = field => field.replace('<div class="field"',
      '<div class="field" data-staff-proxy-personal' + (draft.target === 'recharge' ? ' hidden' : ''));
    return form('proxy', select('使用范围', 'target', [['personal', '我的比特执行 IP'],
      ['recharge', '自动代充业务代理']], draft.target || 'personal') +
      personalField(input('名称', 'name', draft.name, 'maxlength="80"')) +
      select('代理类型', 'kind', [['dynamic_residential', '动态住宅'], ['static_residential', '静态住宅'],
        ['dedicated_static_residential', '独享静态住宅'], ['mobile', '移动代理']], draft.kind || 'static_residential') +
      input('国家或地区代码', 'countryCode', draft.countryCode, 'maxlength="2" placeholder="例如 PH、EG"') +
      personalField(select('代理协议', 'protocol', [['auto', '按地址识别'], ['socks5', 'SOCKS5'],
        ['http', 'HTTP'], ['https', 'HTTPS']], draft.protocol || 'auto')) +
      input('代理链接', 'link', '', 'required type="password" autocomplete="off" data-no-draft'), '登记业务 IP') +
      `<div data-staff-list>${proxyList(current)}</div>`;
  }

  function proxyList(current) {
    return list(current.result.items, current, '业务 IP',
      [['name', '名称'], ['endpoint', '地址'], ['countryCode', '国家或地区'], ['protocol', '连接方式']]);
  }

  const searchField = (placeholder, current, label = placeholder) => `<div class="search-field">${A.icon('search')}
    <input type="search" id="staff-list-search" data-auto-search data-staff-query aria-label="${E(label)}" value="${E(current.query || '')}"
    placeholder="${E(placeholder)}" /></div>`;
  const search = (placeholder, label) => `<div class="toolbar list-filter-toolbar"><div class="toolbar-left">${searchField(placeholder, active.current, label)}</div></div>`;

  function registrationList(current) {
    const { mailboxes = [], accounts = [] } = current.result.data || {};
    const rows = [...mailboxes, ...accounts].filter(row => !current.query ||
      [row.email, row.xHandle].some(value => value?.toLowerCase().includes(current.query.toLowerCase())));
    return list(rows, current, '本人登记记录', [
      ['email', '邮箱或账号', row => E(row.loginMethod === 'x' ? row.xHandle : row.email)], ['type', '类型', row => E(types[row.type] || '—')], ['status', '状态'],
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
    const inventory = A.modules.inventory;
    const choices = Object.entries(types).filter(([id]) => id !== 'relay');
    const type = draft.type || 'google', val = key => draft[key];
    const personal = type === 'gemini' || type === 'grok';
    const account = window.IDInventoryList.inventoryAccountTypes.includes(type);
    const mailboxChoices = [['', '暂不关联'], ...(data.mailboxes || []).filter(row =>
      !row.used && (type !== 'gemini' || row.type === 'google')).map(row => [row.id, row.email])];
    const passwordRequired = window.IDInventoryList.inventoryPasswordRequired(type);
    return heading('录入邮箱或平台账号', '收件验证码需要已连接的邮箱。保存好的动态验证码可从左侧「动态验证码」查看。', 'registration-entry-help') +
      form('registration', select('资料类型', 'type', choices, type) +
        input(type === 'gemini' ? 'Google 账号邮箱' : '邮箱', 'email', draft.email,
          (type === 'grok' ? '' : 'required ') + 'type="email" maxlength="254"') +
        (personal ? inventory.personalLoginFields(type, 'staff-', val) : '') +
        (type === 'microsoft' ? inventory.microsoftLoginField('staff-', val('microsoft-login')) : '') +
        input('登录密码', 'password', '', (passwordRequired ? 'required ' : '') + 'type="password" autocomplete="new-password" data-no-draft') +
        input('动态验证码密钥', 'totp', '', 'type="password" autocomplete="off" data-no-draft') +
        (!account ? input('应用专用密码', 'appPassword', '', 'type="password" autocomplete="off" data-no-draft') : '') +
        (type === 'microsoft' ? input('辅助邮箱', 'auxiliary', draft.auxiliary, 'type="email" maxlength="254"') +
          inventory.microsoftVerificationFields('staff-', val) : '') +
        (account ? select('关联本人登记的原邮箱', 'mailboxId', mailboxChoices, draft.mailboxId) : '') +
        input('国家或地区', 'country', draft.country, 'maxlength="100"') +
        input('注册设备', 'device', draft.device, 'maxlength="200"') +
        input('注册代理链接', 'proxyUrl', '', 'type="password" autocomplete="off" data-no-draft') +
        input('备注', 'notes', draft.notes, 'maxlength="600"'), '保存登记', ` data-registration-type="${E(type)}"`) +
      heading('录入隐藏邮箱', '选中已授权的 Apple 主邮箱，登记在 Apple 创建好的隐藏邮箱。', 'registration-relay-help') +
      (parents.length ? form('alias', select('所属主邮箱', 'parentId', parentChoices, current.draft.alias?.parentId) +
        A.modules.appleRelay.aliasEmailField('staff-aliasEmail', current.draft.alias?.aliasEmail) +
        A.modules.appleRelay.aliasNoteField('staff-aliasNote', current.draft.alias?.aliasNote), '登记隐藏邮箱') :
        '<p class="inline-notice">暂无可用主邮箱，请管理员先连接主邮箱。</p>') +
      heading('本人登记记录', '邮箱连接后可以查验证码。使用公司邮箱池的收信权限，请管理员在邮箱池授权。', 'registration-list-help') + search('搜索邮箱或账号') +
      `<div data-staff-list>${registrationList(current)}</div>`;
  }

  function cardList(current) {
    const all = current.result.items || [];
    const query = (current.query || '').trim().replace(/[\s-]+/g, '');
    const rows = all.filter(row => (!query || (row.cardNumber || row.last4).includes(query)) &&
      (!current.cardStatus || cardState(row) === current.cardStatus) &&
      (!current.cardPlan || (current.cardPlan === 'unconfigured' ? !row.plans?.length : row.plans?.includes(current.cardPlan))));
    const size = current.pageSize || 20;
    current.page = Math.max(1, Math.min(current.page, Math.ceil(rows.length / size)));
    const columns = [
      { id: 'last4', label: '银行卡号', mobileSummary: true,
        render: row => `<strong>${E(row.cardNumber || '未留存完整卡号')}</strong>` },
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
      description: all.length ? '可调整卡号、状态或套餐筛选。' : '点击「导入银行卡」添加，并选择允许使用的套餐。'
    }) + window.IDPagination.render({ id: 'staff-list', page: current.page, pageSize: size, total: rows.length });
  }

  const cardState = row => row.state || (row.active ? '可用' : '已停用');
  const cardPolicyLabel = current => current.result.strict ? '仅使用已配置套餐的卡' : '未配置套餐的卡按现有规则使用';

  function cardToolbar() {
    const filter = (label, key, choices, selected) => `<label class="list-filter-field">${label}${
      A.select('staff-card-' + key, choices, selected).replace('<select', `<select data-card-filter="${key}" aria-label="${key === 'status' ? '银行卡状态' : '允许套餐'}"`)}</label>`;
    return `<div class="toolbar toolbar--inline finance-toolbar list-filter-toolbar"><div class="toolbar-left">${searchField('按卡号查找银行卡', state)}<div class="list-filter-fields">${
      filter('状态', 'status', [['', '全部状态'], ...['可用', '暂缓使用', '已停用', '不可用'].map(value => [value, value])], state.cardStatus || '')}${
      filter('套餐', 'plan', [['', '全部套餐'], ...plans, ['unconfigured', '未配置套餐']], state.cardPlan || '')}</div></div>
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
    if (cardPool) return A.header(definition.label, definition.description) +
      `<section class="panel staff-workspace finance-workspace" data-staff-workspace hidden>
        <p class="finance-feedback" data-staff-status role="status" hidden></p>
        <div data-staff-content></div></section>` + cardPool.render();
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
    if (cardPool) {
      body.innerHTML = view.current.result ? cardReviewSection(view.current) : '';
      view.host.hidden = !body.childElementCount && $('[data-staff-status]', view.host).hidden;
      return;
    }
    body.innerHTML = view.current.result ? content[view.route](view.current) : A.empty('资料未能读取', '请点击刷新重试。');
  }

  async function loadCardReviews(view, refresh = false) {
    const read = {};
    view.reviewRead = read;
    const current = () => active === view && view.host.isConnected && view.reviewRead === read;
    try {
      const snapshot = await D.queries.read(definition.scope, 'pending', async () => {
        const result = await request(resource + '/pending');
        if (!Array.isArray(result?.pending)) throw new Error('暂时无法读取待核对的银行卡维护');
        return result;
      }, { refresh });
      if (!current()) return false;
      view.current.result = snapshot;
      view.current.failed = false;
      message(view, '');
      draw(view);
      return true;
    } catch (error) {
      if (!current() || error.code === 'READ_SUPERSEDED') return false;
      view.current.failed = true;
      if (error.status === 401 || error.status === 403) {
        view.current.result = undefined;
        draw(view);
      }
      message(view, error.message);
      return false;
    }
  }

  async function load(view, paint = true, { refreshOrder = false, afterProxyWrite = false } = {}) {
    if (cardPool) return loadCardReviews(view);
    if (view.loading && !refreshOrder && !afterProxyWrite && !(view.saving && view.read?.refreshOrder)) return view.loading;
    const read = { refreshOrder };
    view.read = read;
    const { current, host } = view;
    current.failed = false;
    view.loading = (async () => {
      host.setAttribute('aria-busy', 'true');
      if (isCards) for (const button of host.querySelectorAll('.finance-toolbar [data-staff-action]')) button.disabled = true;
      try {
        const snapshot = await request(resource);
        if (active !== view || !host.isConnected || view.read !== read) return false;
        if (refreshOrder) {
          const form = $('[data-staff-form="manual-order"]', host);
          if (!form || view.saving || current.orderAttempts?.get(form.dataset.staffDraft)?.write) return true;
          // Updating an option list must not adopt a newer customer/order snapshot for this draft.
          current.result = { ...current.result, orderCurrencies: snapshot.orderCurrencies,
            orderCurrenciesByProduct: snapshot.orderCurrenciesByProduct };
          A.syncOrderSaleCurrencySelect(form.elements['staff-saleCurrency'], current.result, form.elements['order-entry-product'].value);
          saveDraft(form, current);
          if (snapshot.version !== current.version) message(view, '客户或订单资料已更新，请刷新核对。');
          return true;
        }
        current.result = snapshot;
        current.version = snapshot.version ?? 0;
        current.failed = false;
        if (paint) draw(view);
        return true;
      } catch (error) {
        if (active !== view || view.read !== read) return false;
        current.failed = true;
        if (!current.result) draw(view);
        message(view, error.message);
        return false;
      } finally {
        if (view.read === read) {
          host.removeAttribute('aria-busy');
          view.loading = undefined;
          if (isCards) for (const button of host.querySelectorAll('.finance-toolbar [data-staff-action]'))
            button.disabled = button.dataset.staffAction !== 'refresh' && (!current.result || current.failed);
        }
      }
    })();
    return view.loading;
  }

  function request(path, body, operation) {
    return D.staffWorkspace(path, body, operation);
  }

  function message(view, value, continuation = null) {
    if (active !== view || !view.host.isConnected) return;
    const status = $('[data-staff-status]', view.host);
    status.textContent = value;
    if (continuation && A.canVisit(continuation.route)) {
      const link = document.createElement('a');
      link.href = '#/' + continuation.route;
      link.textContent = continuation.label;
      status.append(' ', link);
    }
    status.hidden = !value;
    if (cardPool) view.host.hidden = !value && !view.current.result?.pending?.length;
  }

  function values(form) {
    return Object.fromEntries([...new FormData(form)].filter(([name]) => name.startsWith('staff-'))
      .map(([name, value]) => [name.slice(6), value]));
  }
  const selection = form => new FormData(form).getAll('staff-plans');
  const privateFields = new Set(['password', 'totp', 'appPassword', 'proxyUrl', 'lines', 'link']);
  function saveDraft(form, current) {
    const action = form.dataset.staffForm;
    const key = form.dataset.staffDraft || action;
    if (action === 'registration' && form.elements['staff-type'].value !== form.dataset.registrationType) return;
    current.draft[key] = Object.fromEntries(Object.entries(values(form)).filter(([name]) => !privateFields.has(name)));
    if (!form.dataset.staffDraft) current.draft[key].plans = selection(form);
  }

  async function write(view, action, payload, formNode, onError) {
    const { current } = view;
    const orderKey = formNode?.dataset.staffDraft;
    const orderAttempts = orderKey && (current.orderAttempts ||= new Map());
    const previousAttempt = orderAttempts && orderAttempts.get(orderKey);
    if (view.saving || previousAttempt?.pending || current.failed || active !== view) return;
    const attempt = orderKey ? previousAttempt || {} : view;
    if (orderKey) {
      orderAttempts.set(orderKey, attempt);
      attempt.pending = true;
      formNode.inert = true;
    }
    view.saving = true;
    const control = formNode?.querySelector('[type="submit"]');
    if (control) control.disabled = true;
    const safeRetry = ['customer', 'renewal', 'manual-order', 'registration'].includes(action) ||
      action.startsWith('card-') && payload.action !== 'reconcile';
    const proxyInput = action === 'proxy' ? formNode.elements['staff-link'] : null;
    const submittedDraft = current.draft[orderKey || action];
    const submittedVersion = payload.version ?? current.version;
    let refreshChoices = false;
    try {
      const body = { ...payload, version: submittedVersion };
      let operation;
      if (safeRetry) {
        // Retrying the same staff order after navigating back must reuse its original document version and receipt.
        const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([action, orderKey ? payload : body])));
        const digest = Array.from(new Uint8Array(fingerprint), value => value.toString(16).padStart(2, '0')).join('');
        if (!attempt.write || attempt.write.digest !== digest)
          attempt.write = { digest, id: crypto.randomUUID(), version: submittedVersion };
        body.version = attempt.write.version;
        operation = attempt.write.id;
      }
      if (action.startsWith('card-') && payload.action !== 'reconcile' &&
          (!await Security.verify() || active !== view)) return;
      const result = action === 'alias'
        ? await D.relay('alias-register', payload)
        : await request(resource, body, operation);
      attempt.write = undefined;
      const failedLines = result.failedLines || [];
      let retainImport = false;
      if (action === 'card-import' && formNode?.isConnected) {
        const input = formNode.elements['staff-lines'];
        const failed = new Set(failedLines);
        retainImport = input.value !== payload.lines || failed.size > 0;
        if (input.value === payload.lines && failed.size)
          input.value = payload.lines.split(/\r?\n/).filter((_, index) => failed.has(index + 1)).join('\n');
        if (retainImport && Number.isSafeInteger(result.version)) formNode.dataset.importVersion = String(result.version);
      }
      if (orderKey) {
        if (JSON.stringify(current.draft[orderKey]) === JSON.stringify(submittedDraft)) {
          delete current.draft[orderKey];
          current.orderReceipt = { draftKey: orderKey, id: result.savedId };
          if (active?.current === current && $('[data-staff-form="manual-order"]', active.host)?.dataset.staffDraft === orderKey)
            draw(active);
        }
      } else if (proxyInput) {
        if (proxyInput.isConnected && proxyInput.value === payload.link) proxyInput.value = '';
      } else if (!retainImport) delete current.draft[action];
      if (!orderKey && !proxyInput && !retainImport && formNode?.isConnected) {
        formNode.reset();
        for (const input of formNode.querySelectorAll('[data-no-draft]')) input.value = '';
      }
      if (cardPool) {
        D.queries.invalidate(definition.scope);
        if (active !== view || !view.host.isConnected) return true;
      }
      const proxyViewMounted = active?.current === current && active.host.isConnected;
      const receiptView = proxyInput ? (proxyViewMounted ? active : null) : view;
      const changed = receiptView && await load(receiptView, !proxyInput && payload.action !== 'reconcile', {
        afterProxyWrite: Boolean(proxyInput)
      });
      if (proxyInput) {
        if (current.draft.proxy === submittedDraft) {
          if (payload.action === 'recharge') {
            const { name, protocol } = submittedDraft;
            current.draft.proxy = { name, protocol };
          } else delete current.draft.proxy;
          if (active?.current === current && active.host.isConnected) draw(active);
        } else if (changed && active === receiptView) drawList(receiptView);
      }
      if (changed && payload.action === 'reconcile' && !cardPool) {
        drawCardReviews(view);
        drawList(view);
      }
      const importDetails = result.skipped || failedLines.length
        ? '，跳过重复 ' + (result.skipped || 0) + ' 张，失败 ' + failedLines.length + ' 张' +
          (failedLines.length ? '（第 ' + failedLines.join('、') + ' 行，请核对当前输入）' : '') : '';
      const proxyReceipt = payload.action === 'recharge'
        ? '自动代充代理新增 ' + result.added + ' 条，补标国家 ' + result.labeled + ' 条，跳过重复 ' + result.skipped + ' 条' : '';
      const text = result.unconfirmed ? '已记录结果未确认，请以当前卡池资料为准' :
        result.reconciled ? '已核对银行卡维护结果' : orderKey ? '订单提交成功' :
        proxyReceipt || (result.count === undefined ? '保存成功' : '已导入 ' + result.count + ' 张银行卡' + importDetails);
      if (receiptView) message(receiptView, changed ? text : text + '，列表刷新失败，请点击刷新。');
      return true;
    } catch (error) {
      if (error.status < 500 && !action.startsWith('card-')) attempt.write = undefined;
      refreshChoices = orderKey && error.status === 400;
      const renewal = action === 'manual-order' && error.status === 409 &&
        error.message === window.IDOrderOpening.existingSubscriptionRenewalMessage;
      message(view, error.message, renewal ? { route: 'workspace/renewals', label: '前往续费管理' } : null);
      onError?.(error);
      if (!formNode) A.notify(error.message);
      if (action.startsWith('card-') && payload.action !== 'reconcile' && error.status >= 500 &&
          await load(view, false) && current.result?.pending?.length) drawCardReviews(view);
      return false;
    } finally {
      view.saving = false;
      if (orderKey) {
        attempt.pending = false;
        if (!attempt.write) orderAttempts.delete(orderKey);
        if (formNode.isConnected) formNode.inert = false;
      }
      if (control?.isConnected) control.disabled = false;
      if (refreshChoices && active === view && formNode.isConnected) void load(view, true, { refreshOrder: true });
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
    if (action === 'registration') {
      const inventory = A.modules.inventory;
      if (data.type === 'gemini' || data.type === 'grok') {
        const problem = inventory.personalAccountError(data);
        if (problem) return message(view, problem);
      }
      if (data.type === 'microsoft') {
        try {
          const security = inventory.microsoftFormSecurity(key => data[key]);
          data.microsoftSecurity = inventory.readMicrosoftSecurity(data, security, () => current.result.data.mailboxes || []);
          for (const key of Object.keys(data)) if (key.startsWith('microsoft-')) delete data[key];
        } catch (error) {
          message(view, error.message);
          formNode.elements[error.cause?.replace('inventory-', 'staff-')]?.focus();
          return;
        }
      }
      return write(view, action, data, formNode);
    }
    if (action === 'proxy') {
      const { target, name, protocol, kind, countryCode, link } = data;
      const proxy = { kind, countryCode, link };
      if (target === 'recharge') return write(view, action, { ...proxy, action: 'recharge' }, formNode);
      if (!name.trim()) return message(view, '请填写 IP 名称。');
      return write(view, action, { ...proxy, name, protocol }, formNode);
    }
    if (action === 'alias') {
      const parent = current.result.data?.appleRelay?.parents?.find(row => row.id === data.parentId);
      if (!parent) return message(view, '请选择已授权的主邮箱。');
      return write(view, action, A.modules.appleRelay.singleAliasRegistration(
        parent.id, parent.version ?? 1, data.aliasEmail, data.aliasNote), formNode);
    }
    if (action === 'card-import') {
      const chosen = selection(formNode);
      if (!chosen.length) return message(view, '请至少选择一个套餐。');
      return write(view, action, { action: 'import', lines: data.lines, plans: chosen, version }, formNode);
    }
    if (action === 'manual-order') {
      const customer = current.result.data.customers.find(row => row.id === formNode.dataset.customerId && row.active !== false);
      if (!customer) return message(view, '请选择本人负责的有效客户。');
      if (formNode.elements['order-entry-product'].value === 'Grok') {
        const rules = window.IDOrderOpening, account = rules.grokOrderAccount(data.email);
        const valid = account.loginMethod === 'x' ? rules.validOrderXHandle(account.xHandle) : rules.validOrderEmail(account.email);
        A.setError('staff-email', valid ? '' : '请填写有效的订单邮箱或 X @账号', formNode);
        if (!valid) {
          formNode.elements['staff-email'].focus();
          return;
        }
      }
      return write(view, action, { ...data, action, customerId: customer.id }, formNode);
    }
    if (action === 'customer') return write(view, action, { ...data, action: 'customer' }, formNode);
    return write(view, action, data, formNode);
  }

  function orderForm(current) {
    const customerId = current.orderCustomerId;
    const customer = current.result.data.customers.find(row => row.id === customerId && row.active !== false);
    const back = control('返回本人客户', 'order-back');
    if (!customer) return A.empty('客户资料已变化', '请返回本人客户重新选择。') + back;
    const products = ['GPT', 'Claude Max', 'Gemini', 'Grok'];
    const product = current.draft['order-product:' + customerId] || products[0];
    const draftKey = 'manual-order:' + JSON.stringify([customerId, product]);
    if (current.orderReceipt?.draftKey === draftKey) {
      const id = current.orderReceipt.id;
      const route = id && 'orders/detail/' + encodeURIComponent(id);
      return '<div class="form-footer">' + (route && A.canVisit(route)
        ? `<a class="button" href="#/${E(route)}">查看此订单</a>` : '') + back + '</div>';
    }
    const draft = current.draft[draftKey] || {};
    const choices = A.modules.commerce.orderPlansFor(product).map(plan => [product + '|' + plan, plan]);
    const plan = choices.find(([value]) => value === draft.planChoice) || choices[0];
    const payments = A.modules.commerce.orderPaymentChoices(product, plan[1]);
    const payment = payments.includes(draft.payment) ? draft.payment : payments[0];
    const saleChoices = window.IDOrderOpening.orderSaleCurrencyChoices(current.result, product, draft.saleCurrency);
    if (saleChoices[0]?.[0] === '' && draft.saleCurrency && current.orderAttempts?.get(draftKey)?.write)
      saleChoices[0] = [draft.saleCurrency, draft.saleCurrency + '（上次提交待核对）'];
    const sections = A.orderSubmissionSections({
      idPrefix: 'staff-order',
      identity: A.field('客户资料', 'order-entry-customer', A.input('order-entry-customer', customer.name, 'readonly')) +
        A.field('产品', 'order-entry-product', A.select('order-entry-product', products, product), true) +
        select('开通套餐', 'planChoice', choices, plan[0]) +
        input('邮箱账号', 'email', draft.email, product === 'Grok'
          ? 'type="text" required maxlength="254" placeholder="填写邮箱或 X @账号"'
          : 'type="email" required maxlength="254"'),
      payment: select('支付方式', 'payment', payments, payment) + A.orderAmountGroups({
        paid: select('代付币种', 'paidCurrency', payment === '苹果内购' ? ['USD'] : currencies, draft.paidCurrency || 'USD') +
          input('实际代付金额', 'paidAmount', draft.paidAmount, 'required inputmode="decimal"'),
        sale: A.field('实收币种', 'staff-saleCurrency', A.select('staff-saleCurrency', saleChoices,
          draft.saleCurrency ?? 'CNY').replace('<select ', '<select required '), true) +
          input('客户实收金额', 'saleAmount', draft.saleAmount, 'required inputmode="decimal"')
      }),
      period: A.orderPeriodInputs({ prefix: 'staff', start: draft.start, expiry: draft.expiry,
        startLabel: '开通时间（北京）', expiryLabel: '到期时间（北京）' })
    });
    return `<form data-staff-form="manual-order" class="order-submission-form" data-customer-id="${E(customer.id)}"
      data-staff-draft="${E(draftKey)}">${sections}<div class="form-footer">
      <button type="submit" class="button primary">提交订单</button>${back}</div></form>`;
  }

  function cardPlan(view, row) {
    const summarizePlans = item => (item.plans || []).map(key => plans.find(([value]) => value === key)?.[1])
      .filter(Boolean).join(' / ') || '未配置套餐';
    let version = view.current.version, needsReview = false;
    A.openDrawer('设置允许套餐', '保存后，这张银行卡只用于本次选择的套餐。', `<p>银行卡号 ${E(row.cardNumber || '未留存完整卡号')}</p>` +
      form('card-plan', optionPlans('staff-edit-plan', row.plans || []), '保存套餐') +
      `<p data-current-card-plans>当前已设置套餐：${E(summarizePlans(row))}</p>
      <p class="field-error" data-staff-dialog-status role="alert" hidden></p>
      <button class="button" type="button" data-card-plan-review hidden>读取最新套餐</button>`, '', 'staff-card-plan');
    const drawer = $('#drawer'), formNode = $('[data-staff-form]', drawer);
    const status = $('[data-staff-dialog-status]', drawer), review = $('[data-card-plan-review]', drawer);
    const showError = (text, conflict = false) => {
      if (!formNode.isConnected || !drawer.open) return;
      status.textContent = text;
      status.hidden = !text;
      if (conflict) needsReview = true;
      review.hidden = !needsReview;
    };
    review.addEventListener('click', async () => {
      if (active !== view || view.saving) return;
      review.disabled = true;
      try {
        const loaded = await load(view);
        if (!formNode.isConnected || !drawer.open) return;
        if (!loaded) return showError('暂时无法读取最新套餐，请重试。', true);
        const latest = view.current.result.items.find(item => item.id === row.id);
        if (!latest) return showError('此银行卡已不在当前列表，请关闭后核对。', true);
        $('[data-current-card-plans]', drawer).textContent = '当前已设置套餐：' + summarizePlans(latest);
        version = view.current.version;
        needsReview = false;
        showError('已读取最新套餐。你的选择已保留，请核对上方套餐后再次点击保存。');
      } finally { review.disabled = false; }
    });
    formNode.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      if (active !== view || view.saving) return;
      if (needsReview || view.current.version !== version)
        return showError('套餐设置已更新，已保留你的选择。请先读取最新套餐。', true);
      const chosen = selection(formNode);
      if (!chosen.length) return showError('请至少选择一个套餐。');
      showError('');
      if (await write(view, 'card-plan', { action: 'plans', cardIds: [row.id], plans: chosen, version }, formNode,
        error => showError(error.message, error.status === 409)) && formNode.isConnected)
        A.closeDrawer();
    });
  }

  function cardImport(view) {
    const version = view.current.version;
    A.openDrawer('导入银行卡', '每行一张卡，按卡号、有效期、安全码、持卡人填写，用空格或竖线分隔。持卡人可留空。',
      form('card-import', A.field('银行卡资料', 'staff-lines',
        '<textarea id="staff-lines" name="staff-lines" rows="7" required autocomplete="off" spellcheck="false" data-no-draft></textarea>', true) +
        '<p class="commerce-span-all" data-card-import-preview role="status">填写银行卡资料后将逐行检查。格式有误时整批不提交。</p>' +
        optionPlans('staff-import-plan', view.current.draft['card-import']?.plans), '保存导入') +
      '<p class="field-error" data-staff-dialog-status role="alert" hidden></p>', '', 'staff-card-import');
    const drawer = $('#drawer'), formNode = $('[data-staff-form]', drawer);
    const lines = formNode.elements['staff-lines'], preview = $('[data-card-import-preview]', formNode);
    formNode.dataset.importVersion = String(version);
    const inspect = () => inspectCardImport(lines.value, view.current.result.items.map(row => row.cardNumber).filter(Boolean));
    const showPreview = (rows) => {
      preview.textContent = rows.length ? describeCardImport(rows) + '。格式有误时整批不提交。' :
        '填写银行卡资料后将逐行检查。格式有误时整批不提交。';
    };
    formNode.classList.add('finance-card-import');
    formNode.addEventListener('input', event => {
      saveDraft(formNode, view.current);
      if (event.target === lines) showPreview(inspect());
    });
    formNode.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      const error = $('[data-staff-dialog-status]', drawer);
      error.hidden = true;
      message(view, '');
      const rows = inspect();
      showPreview(rows);
      if (selection(formNode).length && rows.some(row => row.state === 'invalid')) {
        error.textContent = '存在格式错误。整批未提交，输入已保留。';
        error.hidden = false;
        return;
      }
      const saved = await onSubmit(event, view, Number(formNode.dataset.importVersion));
      if (!formNode.isConnected || !drawer.open) return;
      if (saved && !lines.value) return A.closeDrawer();
      error.textContent = $('[data-staff-status]', view.host)?.textContent || '';
      error.hidden = !error.textContent;
      showPreview(inspect());
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
    if (action === 'card-import-open') return cardImport(view);
    if (action === 'card-settings') return cardSettings(view);
    if (action === 'order' || action === 'order-back') {
      if (view.saving) return;
      const previous = current.orderCustomerId;
      current.orderCustomerId = action === 'order' ? id : '';
      current.orderReceipt = undefined;
      message(view, '');
      draw(view);
      const focus = action === 'order' ? $('#order-entry-product', view.host)
        : [...view.host.querySelectorAll('[data-staff-action="order"]')].find(button => button.dataset.id === previous);
      focus?.focus();
      return;
    }
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
      if (!pending?.canReview || view.reviewing || view.saving || current.failed) return;
      view.reviewing = true;
      try {
        // Freeze the version the operator is about to confirm. If the embedded list has not loaded,
        // obtain it only for this review. The server compares it again before recording the result.
        const version = cardPool ? (cardPool.version?.() ?? (await request(resource)).version) : current.version;
        if (active !== view || !current.result?.pending?.some(row => row.id === id && row.canReview)) return;
        if (!Number.isSafeInteger(version) || version < 0) throw new Error('暂时无法确认卡池版本，请刷新重试');
        if (await Security.confirmChange(unconfirmed ? '登记未确认' : '核对上次操作',
          unconfirmed ? '请先核对列表。这一步只记录结果未确认。后续维护请以卡池当前资料为准。' :
            '系统将查看当前银行卡和用卡规则。如与上次提交一致，会补记结果。')) {
          await write(view, action, { action: 'reconcile', id, version, confirmed: true, ...(unconfirmed && { outcome: 'unconfirmed' }) });
        }
      } catch (error) { message(view, error.message); }
      finally { view.reviewing = false; }
      return;
    }
    const card = current.result.items?.find(row => String(row.id) === id);
    if (!card) return;
    if (action === 'card-plan') return cardPlan(view, card);
    if (action === 'card-stop') {
      const version = current.version;
      const confirmed = await Security.confirmChange('停用银行卡',
        '银行卡 ' + (card.cardNumber || '编号 ' + card.id) + ' 停用后不再参与自动代充，历史记录会继续保留。');
      if (!confirmed || active !== view) return;
      if (current.version !== version) return message(view, '银行卡资料已更新，请核对当前资料后重新确认停用。');
      await write(view, action, { action: 'stop', id: card.id, version }, undefined,
        error => { if (error.status === 409) void load(view); });
    }
  }

  function drawList(view) {
    if (cardPool) return;
    const policy = $('[data-card-policy]', view.host);
    if (policy) policy.textContent = '取卡规则：' + cardPolicyLabel(view.current);
    const node = $('[data-staff-list]', view.host);
    if (node) {
      const builder = { 'staff/customers': () => customerTable(view.current.result, view.current),
        'staff/registration': () => registrationList(view.current), 'staff/finance/cards': () => cardList(view.current),
        'staff/business-proxies': () => proxyList(view.current) };
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
    if (active?.host === host) { cardPool?.afterRender(); return; }
    const controller = new AbortController();
    const listenerOptions = { signal: controller.signal };
    const view = { host, route: definition.route, current: state, controller };
    active = view;
    if (view.current.result) draw(view);
    host.addEventListener('click', event => void onClick(event, view), listenerOptions);
    host.addEventListener('submit', event => void onSubmit(event, view), listenerOptions);
    host.addEventListener('input', event => {
      const form = event.target.closest('[data-staff-form]');
      if (form) saveDraft(form, view.current);
      if (event.target.matches('[data-staff-query]')) {
        view.current.query = event.target.value;
        view.current.page = 1;
        if (view.current.result) drawList(view);
      }
    }, listenerOptions);
    host.addEventListener('change', event => {
      if (event.target.id === 'staff-target' && event.target.form?.dataset.staffForm === 'proxy') {
        for (const field of event.target.form.querySelectorAll('[data-staff-proxy-personal]'))
          field.hidden = event.target.value === 'recharge';
      }
      if (event.target.id === 'staff-type' && event.target.form?.dataset.staffForm === 'registration') {
        const current = view.current, previous = event.target.form.dataset.registrationType;
        if (view.saving) { event.target.value = previous; return; }
        const drafts = current.registrationDrafts ||= new Map();
        if (current.draft.registration) drafts.set(previous, current.draft.registration);
        const type = event.target.value;
        current.draft.registration = { ...drafts.get(type), type };
        drafts.delete(type);
        draw(view);
        $('#staff-type', host)?.focus({ preventScroll: true });
        return;
      }
      const form = event.target.closest('[data-staff-form="manual-order"]');
      if (form && ['order-entry-product', 'staff-planChoice', 'staff-payment'].includes(event.target.id)) {
        saveDraft(form, view.current);
        if (event.target.id === 'order-entry-product')
          view.current.draft['order-product:' + form.dataset.customerId] = event.target.value;
        if (event.target.id === 'staff-payment' && event.target.value === '苹果内购') {
          const draft = view.current.draft[form.dataset.staffDraft];
          if (draft.paidCurrency !== 'USD') {
            if (draft.paidAmount) A.notify('付款方式已切换为苹果内购，请按美元重新填写实际代付金额。');
            draft.paidCurrency = 'USD';
            draft.paidAmount = '';
          }
        }
        draw(view);
        $('#' + event.target.id, host)?.focus({ preventScroll: true });
        return;
      }
      const key = event.target.dataset.cardFilter;
      if (!key) return;
      view.current[key === 'status' ? 'cardStatus' : 'cardPlan'] = event.target.value;
      view.current.page = 1;
      if (view.current.result) drawList(view);
    }, listenerOptions);
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
    }, listenerOptions);
    void load(view);
    cardPool?.afterRender();
  }

  return { render, afterRender: activate, retainPage: () => Boolean(cardPool),
    onClick(action) {
      if (!cardPool || action !== 'staff-card-pool-refresh') return false;
      if (active && !active.saving) {
        message(active, '');
        void loadCardReviews(active, true);
        cardPool.refresh();
      }
      return true;
    },
    deactivate(region) { active?.controller.abort(); active = undefined; cardPool?.deactivate(region); },
    clearPageState() { active?.controller.abort(); active = undefined; state = initialState(); },
    onDataChanges(scopes) {
      if (!active || active.saving || !scopes.includes(definition.scope)) return;
      const view = active;
      if ($('[data-staff-form="manual-order"]', view.host)) return load(view, true, { refreshOrder: true });
      if (view.host.querySelector('form :focus') || [...view.host.querySelectorAll('[data-no-draft]')].some(input => input.value)) {
        message(view, '资料已有更新，填写完成后可刷新核对。');
        return;
      }
      return load(view);
    }
  };
}
