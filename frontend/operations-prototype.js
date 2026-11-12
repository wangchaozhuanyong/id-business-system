/* global window, document, URL, FormData */
/* 运营页面支持设计预览和独立本机业务。 */
(() => {
  'use strict';
  const api = window.IDDesignAPI;
  if (!api) throw new Error('运营原型需要先加载共享设计运行时');
  const {
    esc,
    icon,
    button,
    tag,
    textAction,
    field,
    input,
    select,
    header,
    titleInfo,
    empty,
    table,
    pagination,
    pageRows,
    state,
    notify,
    setError,
    readForm,
    readDraft,
    confirmAction,
    openDrawer,
    closeDrawer,
    openToolboxPanel,
    copyText,
    render,
    money
  } = api;
  const $ = (selector) => document.querySelector(selector);
  const localData = window.IDLocalData;
  const pluginPages = {
    'plugins/mailboxes': { label: '邮箱查询与邮箱池', tool: '邮箱查询与邮箱池', description: '统一管理收信连接、Claude 待授权邮箱与验证码查询。' },
    'plugins/websites': { label: '网站监控', tool: '网站监控', description: '集中查看运行状态、告警记录、访问记录与网站检测，网站统计进入数据中心。' }
  };
  let pluginCleanup;
  function toolActive(node) {
    return Boolean(node?.isConnected && (node.closest('dialog[open]') ||
      node.closest('[data-plugin-tool]')?.dataset.route === state.route));
  }
  const now = () => api.nowText();
  const uid = (prefix) => api.newId(prefix);
  const draftKey = (key) => `operations:${key}`;
  const getDraft = (key, defaults = {}) => ({
    ...defaults,
    ...(state.drafts.get(draftKey(key)) || {})
  });
  function bindToolDraft(form, key) {
    if (!form) return;
    form.dataset.opsDraft = draftKey(key);
    const values = state.drafts.get(form.dataset.opsDraft) || {};
    for (const control of form.elements) {
      if (!Object.hasOwn(values, control.name) || control.hasAttribute('data-no-draft')) continue;
      if (control.type === 'checkbox' || control.type === 'radio')
        control.checked = values[control.name] === control.value;
      else control.value = values[control.name];
    }
    const remember = () => state.drafts.set(form.dataset.opsDraft, readDraft(form));
    form.addEventListener('input', remember);
    form.addEventListener('change', remember);
    remember();
  }
  function toolSubmission(form) {
    if (!form?.dataset.opsDraft) return null;
    const values = readDraft(form);
    state.drafts.set(form.dataset.opsDraft, values);
    return { key: form.dataset.opsDraft, form, values, json: JSON.stringify(values) };
  }
  function finishToolSubmission(submission, versionField, version) {
    if (!submission) return false;
    const { key, values, json } = submission;
    const current = [...document.querySelectorAll('form[data-ops-draft]')]
      .find((form) => form.dataset.opsDraft === key);
    const unchanged = current === submission.form && JSON.stringify(readDraft(current)) === json;
    const draft = state.drafts.get(key);
    if (draft && JSON.stringify(draft) === json) state.drafts.delete(key);
    else if (draft?.[versionField] === values[versionField]) draft[versionField] = String(version);
    if (current?.elements[versionField]?.value === values[versionField])
      current.elements[versionField].value = String(version);
    return unchanged;
  }
  const frameDraftScopes = new Set(['admin', 'workspace', 'public', 'bit-local']);
  const rechargeDraftFields = new Set((
    'gpt_api_enabled gpt_api_base_url gpt_api_plan_key gpt_api_plan_key_pro100 gpt_api_plan_key_pro200 ' +
    'gpt_api_plan_key_pro500 gpt_api_payment_region gpt_api_card_source orbitcard_base_url ' +
    'max_concurrent_activations maintenance_mode telegram_admin_chat_id telegram_group_chat_id ' +
    'telegram_notify_admin telegram_notify_group telegram_on_success telegram_on_failure ' +
    'telegram_on_card_pool_empty hcaptcha_enabled hcaptcha_no_vlm hcaptcha_captcha_platform_api_url ' +
    'hcaptcha_captcha_platform_timeout hcaptcha_vlm_base_url hcaptcha_vlm_model hcaptcha_vlm_timeout ' +
    'hcaptcha_solver_timeout hcaptcha_cdp_port region_selector checkout_plan_type checkout_plan_name ' +
    'checkout_region_selector checkout_log_autoscroll orbitcard_usage_keyword orbitcard_usage_plan ' +
    'orbitcard_usage_card_status orbitcard_usage_recharge_status orbitcard_strategy_product_code ' +
    'orbitcard_reuse_limit_plus orbitcard_reuse_limit_pro100 orbitcard_reuse_limit_pro200 ' +
    'orbitcard_reuse_limit_pro500 orbitcard_safety_margin_plus orbitcard_safety_margin_pro100 ' +
    'orbitcard_safety_margin_pro200 orbitcard_safety_margin_pro500 cdk_plan_type cdk_count ' +
    'session_search runtime_log_autoscroll runtime_log_pause ip_ban_cidr ip_ban_reason ip_ban_duration'
  ).split(' '));
  function frameDraftFieldAllowed(scope, key) {
    if (scope === 'admin') return rechargeDraftFields.has(key) ||
      /^address\/(?:new|[1-9]\d{0,15})\/addr_(?:line1|city|state|postal_code|country)$/.test(key);
    if (scope === 'bit-local') return ['workspace', 'bit-execution-proxy', 'ip-search', 'ip-filter', 'ip-sort', 'ip-page', 'ip-page-size'].includes(key) ||
      /^ip-draft\/[a-zA-Z0-9_-]{1,80}\/(?:name|country|kind|mode|protocol|version)$/.test(key) ||
      /^profile\/[a-zA-Z0-9_-]{1,80}\/(?:version|bit-connection-name|bit-account-name|bit-local-url|bit-core|bit-proxy-mode|bit-proxy-type|bit-proxy-country|bit-proxy-host|bit-proxy-port|bit-session-wait|bit-session-retries|groupPreference|tagPreference)$/.test(key);
    return false;
  }
  window.IDRechargeDrafts = Object.freeze({
    read(scope) {
      if (!frameDraftScopes.has(scope)) return {};
      return { ...(state.drafts.get(`recharge-frame:${scope}`) || {}) };
    },
    write(scope, values) {
      if (!frameDraftScopes.has(scope) || !values || typeof values !== 'object' ||
          Array.isArray(values)) return;
      const entries = Object.entries(values);
      if (entries.length > 500 || entries.some(([key, value]) => key.length > 150 ||
        !['string', 'boolean'].includes(typeof value) ||
        (typeof value === 'string' && value.length > 12000))) return;
      state.drafts.set(`recharge-frame:${scope}`,
        Object.fromEntries(entries.filter(([key]) => frameDraftFieldAllowed(scope, key))));
    }
  });
  const rowsByQuery = (rows) =>
    rows.filter(
      (row) =>
        !state.query ||
        Object.values(row).some((value) =>
          String(value).toLowerCase().includes(state.query.toLowerCase())
        )
    );
  const wide = (html) => `<div class="form-field-wide">${html}</div>`;
  const grid = (html, paired = false) =>
    `<div class="form-grid${paired ? ' form-grid--paired' : ''}">${html}</div>`;
  const formFooter = (form, label = '核对并保存', durable = false) =>
    `<span class="footnote">${durable ? '保存到数据库' : '仅更新演示内存，刷新重置'}</span>${button('取消', 'drawer-close')}<button class="button primary" form="${form}" type="submit">${esc(label)}</button>`;
  const search = (placeholder = '搜索名称、备注或编号', query = state.query || '') =>
    `<div class="search-field">${icon('search')}<input id="ops-list-search" aria-label="搜索当前列表" value="${esc(query)}" placeholder="${esc(placeholder)}" /></div>`;
  const { defaultPageSize, pageSizes } = window.IDPagination || {};
  const renderPagination = (options) => window.IDPagination?.render(options) || '';
  function finishDrawer() {
    const context = state.drawerContext;
    closeDrawer();
    if (context) state.drafts.delete(context);
  }
  const actionData = (id) => `data-id="${esc(id)}"`;
  const local = {
    staffTab: 'staff',
    staffRole: 'super',
    taskFilter: '',
    phraseQuery: '',
    phrasePage: 1,
    phrasePageSize: defaultPageSize,
    phraseSort: 'custom',
    toolName: '',
    toolResult: null
  };
  const audit = [
    {
      id: 'AUDIT-DEMO-001',
      time: '2026-11-03 10:30',
      actor: '演示系统',
      action: '打开原型',
      subject: '运营模块',
      result: '虚构资料，不是生产日志'
    }
  ];
  function recordAudit(action, subject, result = '演示完成') {
    audit.unshift({
      id: uid('AUDIT'),
      time: now(),
      actor: state.actor?.name || '演示管理员',
      action,
      subject,
      result
    });
  }
  // 订单页面仍读取这些虚构银行卡尾号，充值页面只使用独立网关。
  const resources = {
    cards: [
      {
        id: 'card-demo-1',
        name: '业务卡 A',
        last6: '062847',
        currency: 'USD',
        holder: 'DEMO HOLDER A',
        plans: 'Go、Plus、Pro 5x、Pro 20x、Pro 50x',
        status: '启用',
        notes: '仅尾号示例，无完整卡号或安全码'
      },
      {
        id: 'card-demo-2',
        name: '业务卡 B',
        last6: '062847',
        currency: 'MYR',
        holder: 'DEMO HOLDER B',
        plans: 'Go、Plus',
        status: '启用',
        notes: '同尾号不同资料，以独立编号识别'
      },
      {
        id: 'card-demo-php',
        name: '菲律宾演示卡',
        last6: '100003',
        currency: 'PHP',
        holder: 'DEMO HOLDER PH',
        plans: 'Go、Plus、Pro 20x',
        status: '启用',
        notes: '虚构资源，不付款'
      },
      {
        id: 'card-demo-clp',
        name: '智利演示卡',
        last6: '100004',
        currency: 'CLP',
        holder: 'DEMO HOLDER CL',
        plans: 'Pro 5x、Pro 50x',
        status: '启用',
        notes: '虚构资源，不付款'
      }
    ]
  };
  const mailboxTypes = [
    { id: 'google', label: '谷歌邮箱', enabled: true },
    { id: 'apple', label: '苹果 ID', enabled: true },
    { id: 'relay', label: '苹果隐藏邮箱', enabled: true },
    { id: 'microsoft', label: '微软邮箱', enabled: false }
  ];
  let customerTags = [];
  const defaultCustomerSources = ['微信', 'WhatsApp', 'Telegram', '网站', '客户推荐', '其他'];
  let customerSources = [...defaultCustomerSources];
  let settingsVersion = 0;
  let settingsState = 'idle';
  let settingsLoading;
  let settingsSaving = false;
  const auditViews = {
    audit: { query: '', pageSize: defaultPageSize, dirty: true },
    login: { query: '', pageSize: defaultPageSize, dirty: true }
  };
  let composingAuditSearch;

  function settingsSnapshot() {
    return {
      mailboxTypes: mailboxTypes.map((item) => ({ ...item })),
      customerTags: [...customerTags],
      customerSources: [...customerSources],
      costSettings: api.modules.commerce?.getCostSettings?.() || null
    };
  }
  function applySettings({ version, data }) {
    if (version < settingsVersion) return;
    if (data?.costSettings) {
      const service = api.modules.commerce;
      if (typeof service?.replaceCostSettings !== 'function')
        throw new Error('本机费用规则无法载入');
      service.replaceCostSettings(data.costSettings);
    }
    if (Array.isArray(data?.mailboxTypes)) {
      mailboxTypes.splice(0, mailboxTypes.length, ...data.mailboxTypes);
    }
    customerTags = Array.isArray(data?.customerTags) ? [...data.customerTags] : [];
    customerSources = Array.isArray(data?.customerSources) ? [...data.customerSources] : [...defaultCustomerSources];
    settingsVersion = version;
  }
  function loadSettings(retry = false) {
    if (!localData) return Promise.resolve(true);
    if (settingsLoading) return settingsLoading;
    if (!retry && settingsState !== 'idle') return Promise.resolve(settingsState === 'ready');
    const hadSettings = settingsState === 'ready';
    if (!hadSettings) settingsState = 'loading';
    settingsLoading = (async () => {
      try {
        applySettings(await localData.load('settings'));
        settingsState = 'ready';
        return true;
      } catch {
        if (!hadSettings) settingsState = 'error';
        return false;
      } finally {
        settingsLoading = undefined;
      }
    })();
    return settingsLoading;
  }
  function refreshSettingsPage() {
    if (['settings/mail-types', 'settings/costs'].includes(state.route)) render();
    api.modules.commerce?.refreshCustomerTagOptions?.();
  }
  function settingsStatusPage(title) {
    const failed = settingsState === 'error';
    return (
      header(title, '由本机业务数据统一保存。') +
      `<section class="panel">${empty(
        failed ? '本机设置读取失败' : '正在读取本机设置',
        failed ? '重新读取后再修改配置。' : '读取完成后可编辑。'
      )}${failed ? `<div class="toolbar">${button('重新读取', 'ops-settings-reload')}</div>` : ''}</section>`
    );
  }
  async function commitSettings(action, data, expectedVersion = settingsVersion) {
    if (settingsSaving) {
      notify('本机设置正在保存');
      return false;
    }
    if (settingsLoading || settingsState !== 'ready' || expectedVersion !== settingsVersion) {
      notify('配置已变化，请重新打开并核对后再保存');
      return false;
    }
    settingsSaving = true;
    try {
      const priorOptions = { sources: [...customerSources], tags: [...customerTags] };
      applySettings(
        await localData.save('settings', expectedVersion, data, {
          action,
          summary: '更新本机业务设置'
        })
      );
      // A successful save of another setting leaves these option lists unchanged.
      // Advance only that unchanged draft's document version, preserving its edits.
      for (const kind of ['sources', 'tags']) {
        const config = customerOptionConfig(kind);
        if (action === `customer_${kind}_save` || JSON.stringify(priorOptions[kind]) !==
            JSON.stringify(kind === 'sources' ? customerSources : customerTags)) continue;
        const draft = state.drafts.get(draftKey(config.key));
        if (draft?.[config.versionField] === String(expectedVersion))
          draft[config.versionField] = String(settingsVersion);
        const control = document.getElementById(config.formId)?.elements[config.versionField];
        if (control?.value === String(expectedVersion)) control.value = String(settingsVersion);
      }
      for (const view of Object.values(auditViews)) view.dirty = true;
      return true;
    } catch (error) {
      if (error?.status === 409) {
        preserveDraft();
        await loadSettings(true);
        notify('其他页面已更新配置，请重新读取并核对后再保存');
        refreshSettingsPage();
      } else notify('本机设置未保存，请重试');
      return false;
    } finally {
      settingsSaving = false;
    }
  }
  async function updateStatisticsCurrency(currency) {
    if (!localData || !['CNY', 'MYR'].includes(currency)) return false;
    if (!(await loadSettings())) {
      notify('费用规则读取失败，统计币种未修改');
      if (state.route === 'orders/statistics') render();
      return false;
    }
    const config = api.modules.commerce?.getCostSettings?.();
    if (!config || currency === config.currency) return false;
    const saved = await commitSettings('statistics_currency_save', {
      ...settingsSnapshot(),
      costSettings: { ...config, currency, version: config.version + 1 }
    });
    if (state.route === 'orders/statistics') render();
    if (saved) notify('统计币种已保存到本机');
    return saved;
  }
  function activeAuditView() {
    if (!localData || !isAdmin()) return;
    if (state.route === 'settings/audit') return 'audit';
    if (state.route === loginLogsRoute && loginLogTab === 'system' && localData.authRequired) return 'login';
  }
  function resetAuditViews() {
    for (const list of Object.values(auditViews)) Object.assign(list, {
      query: '', pageSize: defaultPageSize, dirty: true, pending: null, failedRequest: null,
      result: undefined, resultQuery: undefined, error: false
    });
  }
  function renderAuditRead(view) {
    if (activeAuditView() !== view) return;
    const focused = document.activeElement;
    if (composingAuditSearch && focused === composingAuditSearch) return;
    const editingSearch = focused?.id === 'ops-list-search';
    const paging = focused?.closest?.(`[data-pagination="operations-${view}"]`);
    const pageControl = paging && (focused.hasAttribute('data-pagination-size') ? '[data-pagination-size]'
      : focused.dataset.paginationNav ? `[data-pagination-nav="${focused.dataset.paginationNav}"]`
        : focused.closest('.pagination-jump') ? '.pagination-jump summary' : '[aria-current="page"]');
    const start = editingSearch ? focused.selectionStart : null;
    const end = editingSearch ? focused.selectionEnd : null;
    render();
    if (editingSearch) {
      const next = $('#ops-list-search');
      next?.focus({ preventScroll: true });
      if (start !== null && end !== null) next?.setSelectionRange(start, end);
    } else if (pageControl) {
      const pager = $(`[data-pagination="operations-${view}"]`);
      const target = pager?.querySelector(pageControl);
      (target && !target.disabled ? target : pager?.querySelector('[aria-current="page"], [data-pagination-size]'))
        ?.focus({ preventScroll: true });
    }
  }
  async function loadAudit(view = activeAuditView(), { page, pageSize, fresh = false } = {}) {
    if (!view) return;
    const list = auditViews[view];
    const request = {
      view,
      page: page ?? list.pending?.page ?? list.result?.page ?? 1,
      pageSize: pageSize ?? list.pageSize,
      query: list.query,
      ...(!fresh && list.result && list.resultQuery === list.query ? { snapshot: list.result.snapshot } : {})
    };
    list.dirty = false;
    list.error = false;
    list.failedRequest = null;
    list.pageSize = request.pageSize;
    list.pending = request;
    const status = $('[data-audit-read-status]');
    if (activeAuditView() === view && status) status.innerHTML = auditReadStatus(list);
    try {
      const result = await localData.auditPage(request);
      if (list.pending !== request) return;
      list.result = result;
      list.resultQuery = request.query;
      return true;
    } catch (error) {
      if (list.pending !== request) return;
      if (error?.status === 401 || error?.status === 403) {
        resetAuditViews();
        list.pending = request;
        list.dirty = false;
        composingAuditSearch = undefined;
      } else list.failedRequest = request;
      list.error = true;
      return false;
    } finally {
      if (list.pending === request) {
        list.pending = null;
        renderAuditRead(view);
      }
    }
  }
  function retryAudit(view = activeAuditView()) {
    if (!view) return;
    const failed = auditViews[view].failedRequest;
    return failed
      ? loadAudit(view, { page: failed.page, pageSize: failed.pageSize, fresh: failed.snapshot === undefined })
      : loadAudit(view, { fresh: true });
  }
  function auditReadStatus(list) {
    if (list.error)
      return `<p class="inline-notice warning" role="status">日志读取失败。${list.result ? '已保留上次结果和页码。' : ''}请重试。</p>`;
    if (list.pending || !list.result)
      return `<p class="inline-notice" role="status">${list.result ? '正在更新日志…' : '正在读取日志…'}</p>`;
    return '';
  }
  function auditPageContent(view, columns, tableId) {
    const list = auditViews[view];
    const result = list.result;
    return `<div data-audit-read-status>${auditReadStatus(list)}</div>${result ? table(columns, result.items, '', tableId) +
      renderPagination({ id: `operations-${view}`, page: result.page, pageSize: result.pageSize, total: result.total }) : ''}`;
  }
  const staff = [
    {
      id: 'staff-super',
      name: '演示超级管理员',
      email: 'super@example.test',
      role: '超级管理员',
      status: '启用',
      notes: '唯一管理身份，仅为设计示例'
    },
    {
      id: 'staff-lin',
      name: '林管理员',
      email: 'lin@example.test',
      role: '普通管理员',
      status: '启用',
      notes: ''
    },
    {
      id: 'staff-chen',
      name: '陈员工',
      email: 'chen@example.test',
      role: '普通员工',
      status: '启用',
      notes: ''
    }
  ];
  const permissions = {
    普通管理员: ['库存查看', '库存修改', '订单查看', '订单修改', '充值操作', '审计查看'],
    普通员工: ['库存查看', '订单查看']
  };
  const phrases = [
    {
      id: 'phrase-demo-1',
      title: '客户咨询回复',
      text: '您好，请问需要开通哪个套餐？',
      deleted: false
    },
    {
      id: 'phrase-demo-2',
      title: '续费提醒',
      text: '您的订阅即将到期，如需续费请联系。',
      deleted: false
    },
    {
      id: 'phrase-demo-3',
      title: '资料核对',
      text: '请核对账号和套餐，确认后再安排处理。',
      deleted: false
    }
  ];
  const toolbox = window.IDLocalToolbox;
  state.tasks ||= [];
  const tasks = state.tasks;

  function listPanel(title, description, columns, rows, actions = '', extra = '') {
    const filtered = rowsByQuery(rows);
    return (
      header(title, description, actions) +
      `<section class="panel"><div class="toolbar"><div class="toolbar-left">${search()}</div><div class="toolbar-right" data-page-actions>${button('列设置', 'column-settings', '', 'columns', `data-table-id="运营${esc(title)}"`)}${extra}</div></div>${table(columns, pageRows(filtered), '', `运营${title}`)}${pagination(filtered.length)}</section>`
    );
  }
  const onlineRechargeViews = [
    ['query', '查询状态', 'redeem?tab=query'],
    ['dashboard', '概览中心'],
    ['config', '系统配置'],
    ['proxies', '代理池'],
    ['tax_addresses', '免税地址'],
    ['checkout_debug', '支付链接调试'],
    ['cards', '银行卡池'],
    ['cdks', 'CDK 管理'],
    ['sessions', 'Session 管理'],
    ['cancel_renewal', '续费管理'],
    ['logs', '任务管理'],
    ['runtime_logs', '运行日志']
  ];
  const loginLogsRoute = 'settings/login-logs';
  const rechargeLoginLogsView = ['admin_login_logs', '充值登录日志与 IP 封禁'];
  let loginLogTab = 'system';
  const workspaceRechargeRoute = 'workspace/recharge';
  const workspaceRechargeView = ['redeem', '兑换开通', 'workspace'];
  const bitLoginRoute = 'recharge/start';
  const bitLoginView = ['bit-login', '比特登录', '/integrations/bitbrowser/local-login'];
  const onlineRechargeRoute = 'online-recharge/chatgpt';
  const onlineRechargeMount = '/integrations/codexdaichong/';
  let activeOnlineView = 'query';
  let onlineAdmin;
  let openingRechargeCardType;
  const currentIntegrationRequest = new WeakMap();
  const integrationRoot = () => api.activePageRegion?.() || document;
  function visibleRechargeCardFrame() {
    if (state.route !== onlineRechargeRoute || activeOnlineView !== 'cards') return null;
    return $('iframe[data-view="cards"][data-view-group="admin"]:not([hidden])', integrationRoot());
  }
  function openRechargeTaskLog(jobKey, returnFocus) {
    if (!isAdmin() || typeof jobKey !== 'string' || !/^[\w-]{1,128}$/.test(jobKey)) return;
    const src = onlineRechargeMount + 'admin?taskLog=' + encodeURIComponent(jobKey);
    openDrawer('充值详细日志', '', `<iframe class="recharge-task-log-frame" src="${src}" title="任务详情"></iframe>`);
    const drawer = $('#drawer');
    const logFrame = $('.recharge-task-log-frame', drawer);
    function releaseLog() {
      if (drawer.open && logFrame.isConnected) return;
      drawer.removeEventListener('close', releaseLog);
      logFrame.remove();
      if (!drawer.open) returnFocus?.();
    }
    drawer.addEventListener('close', releaseLog);
  }
  function setFrameVisible(frame, visible) {
    frame.contentWindow?.postMessage(
      { source: 'id-recharge-shell', type: 'visibility', visible }, window.location.origin
    );
  }
  function lockedRechargeFrame(root = document) {
    const frame = root.querySelector(
      'iframe[data-view-group="workspace"]:not([hidden]), iframe[data-view-group="public"]:not([hidden]), iframe[data-view-group="bit"]:not([hidden])'
    );
    return frame?.contentDocument?.documentElement?.dataset.rechargeNavigationLocked === 'true'
      ? frame
      : null;
  }
  function blockRechargeNavigation({ quiet = false } = {}) {
    if (![workspaceRechargeRoute, onlineRechargeRoute, bitLoginRoute].includes(state.route)) return false;
    if (!lockedRechargeFrame(integrationRoot())) return false;
    if (!quiet) notify('充值任务正在执行，请等待任务处理完成后再切换或刷新。');
    return true;
  }
  function selectOnlineView(nav, view) {
    activeOnlineView = view;
    for (const control of nav?.querySelectorAll('[data-view]') || []) {
      const selected = control.dataset.view === view;
      control.setAttribute('aria-pressed', String(selected));
      control.classList.toggle('active', selected);
    }
  }
  function preserveLockedRecharge(view) {
    const frame = lockedRechargeFrame(view);
    if (!frame) return false;
    finishIntegrationLoad(view);
    if (state.route === onlineRechargeRoute)
      selectOnlineView(
        view.closest('[data-recharge-module]')?.querySelector('nav'),
        frame.dataset.view
      );
    return true;
  }
  function integrationNavigation() {
    const actions = onlineRechargeViews
      .map(([id, label, publicPath]) => `<button type="button" class="tab${id === activeOnlineView ? ' active' : ''}" data-action="ops-integrated-view" data-view="${id}" aria-pressed="${id === activeOnlineView}" ${onlineAdmin === false && !publicPath ? 'disabled' : ''}>${esc(label)}</button>`)
      .join('');
    return `<nav class="recharge-integration__nav tabs" aria-label="ChatGPT 充值功能">${actions}</nav>`;
  }
  function renderBitBrowserLogin() {
    const showAddresses = localData && isAdmin();
    const jump = showAddresses
      ? button('前往地址管理', 'ops-bit-address-jump', 'bit-address-jump', '', 'aria-controls="bit-addresses-host"')
      : '';
    const login = renderRechargeRegion('bit');
    return (
      header('比特登录', '使用授权 JSON 登录账号，登录后保留比特浏览器窗口。') +
      (showAddresses
        ? `<div class="bit-login-layout">${jump}${login}<aside id="bit-addresses-host" aria-label="地址管理" tabindex="-1"></aside></div>`
        : login)
    );
  }
  function renderRechargeRegion(module, toolbar = '') {
    return `<section class="panel recharge-integration" data-recharge-module="${module}">
        ${toolbar}
        <div class="recharge-integration__view design-async-region" aria-busy="true">
          <div class="recharge-integration__content"></div>
          <div class="design-region-progress" role="status" hidden></div>
        </div>
      </section>`;
  }
  function renderIntegratedRecharge(workspace = false) {
    if (workspace)
      return header('兑换开通', '验码后自动匹配套餐，请核对账号再提交。') +
        renderRechargeRegion('workspace');
    return header('ChatGPT 充值', '查询充值状态并管理线上代充资源与任务。') +
      renderRechargeRegion('online', `<div class="recharge-integration__toolbar content-toolbar">
        ${integrationNavigation()}${button('刷新', 'ops-integrated-refresh')}
      </div>`);
  }
  function finishIntegrationLoad(view) {
    const request = currentIntegrationRequest.get(view);
    currentIntegrationRequest.delete(view);
    if (request) {
      request.controller.abort();
      request.read?.finish();
      clearTimeout(request.frameTimer);
      request.frame?.remove();
    }
    view.querySelector('.design-region-progress').hidden = true;
    view.setAttribute('aria-busy', 'false');
  }
  function showUnavailableIntegration(view, status, keepContent = false) {
    finishIntegrationLoad(view);
    const bit = view.closest('[data-recharge-module]')?.dataset.rechargeModule === 'bit';
    if (!bit && status !== 403) onlineAdmin = undefined;
    const auth = window.IDLocalAuth;
    const needsSetup = status === 401 && auth?.getState().status === 'unconfigured';
    const title =
      status === 401
        ? (needsSetup ? '请先设置本机管理员密码' : '需要系统登录')
        : status === 403
          ? '当前账号没有充值权限'
          : bit ? '比特登录页面未能加载' : 'ChatGPT 充值服务未就绪';
    if (keepContent && status !== 401 && status !== 403) {
      const progress = view.querySelector('.design-region-progress');
      progress.textContent = `${title}，已保留当前内容。`;
      progress.hidden = false;
      return;
    }
    const detail =
      needsSetup
        ? '在 Mac「终端」的设置窗口为本机管理员设置密码，完成后回到此页继续登录。'
        : status === 401 || status === 403
          ? '请使用有充值权限的本机系统账号。'
          : bit ? '请重新加载页面。' : '本机尚未连接独立充值服务。完成统一账号与服务配置后，可在这里使用。';
    const action = status === 401 && auth
      ? button(needsSetup ? '我已设置密码，去登录' : '去登录', 'ops-integrated-login', 'primary')
      : [workspaceRechargeRoute, loginLogsRoute, bitLoginRoute].includes(state.route) && status !== 401 && status !== 403
        ? button(bit ? '重新加载' : '重新检查服务', 'ops-integrated-refresh')
        : '';
    updateRechargeDescription('');
    view.dataset.unavailable = String(status);
    view.querySelector('.recharge-integration__content').innerHTML =
      empty(title, detail) +
      (action ? `<div class="recharge-integration__toolbar">${action}</div>` : '');
  }
  function integrationTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function sendIntegrationTheme(frame) {
    frame.contentWindow?.postMessage(
      { source: 'id-recharge-shell', type: 'theme', theme: integrationTheme() },
      window.location.origin
    );
  }
  function updateRechargeDescription(description) {
    const note = $('#page-title #page-description');
    if (!note || typeof description !== 'string') return;
    note.dataset.baseDescription ??= note.textContent;
    note.textContent = [note.dataset.baseDescription, description].filter(Boolean).join(' ');
  }
  function revealRechargeFrame(view, frame, request, height, description) {
    frame.dataset.bridgeReady = 'true';
    const root = frame.contentDocument?.documentElement;
    if (root) {
      const themeKey = frame.dataset.viewGroup === 'bit' ? 'theme' : 'idTheme';
      root.dataset[themeKey] = integrationTheme();
    }
    resizeRechargeFrame(frame, height);
    request.frame = null;
    finishIntegrationLoad(view);
    delete view.dataset.unavailable;
    // Keep one connected document per group. Replacing a group is reserved for
    // an explicit refresh; normal tab navigation only changes visibility.
    for (const sibling of [...frame.parentElement.children]) {
      if (sibling === frame) continue;
      if (sibling.matches('iframe') && sibling.dataset.viewGroup !== frame.dataset.viewGroup) {
        setFrameVisible(sibling, false);
        sibling.hidden = true;
      } else sibling.remove();
    }
    frame.dataset.description = description || '';
    frame.hidden = false;
    setFrameVisible(frame, true);
    api.restorePendingPageScroll();
    updateRechargeDescription(description);
  }
  function handleIntegrationMessage(event) {
    if (event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.source === 'id-codexdaichong' && message.type === 'close-task-log') {
      const frame = $('#drawer[open] .recharge-task-log-frame');
      if (frame?.contentWindow === event.source) closeDrawer();
      return;
    }
    const frame = [...document.querySelectorAll('.recharge-integration__frame')].find(
      (candidate) => candidate.contentWindow === event.source
    );
    if (!frame) return;
    const view = frame.closest('.recharge-integration__view');
    if (!view) return;
    const request = currentIntegrationRequest.get(view);
    if (
      frame.classList.contains('recharge-integration__frame--bit-local') &&
      event.data?.source === 'id-bitbrowser-local' &&
      event.data.type === 'resize' &&
      Number.isFinite(event.data.height) && event.data.height > 0
    ) {
      if (request?.frame === frame) revealRechargeFrame(view, frame, request, event.data.height);
      else if (!frame.hidden) resizeRechargeFrame(frame, event.data.height);
      return;
    }
    if (event.data?.source !== 'id-codexdaichong') return;
    if (message.type === 'edit-card-type') {
      const key = message.cardKey;
      if (!isAdmin() || frame !== visibleRechargeCardFrame() || $('#drawer')?.open ||
          typeof key !== 'string' || !/^recharge:[1-9]\d{0,19}$/.test(key)) return;
      const selector = `#cards.active [data-switch-panel="local"]:not([hidden]) [data-edit-recharge-card-type="${key}"]`;
      const trigger = () => visibleRechargeCardFrame() === frame ? frame.contentDocument?.querySelector(selector) : null;
      if (!trigger()) return;
      if (!localData || !api.modules.commerce?.openBankCardTypeAssignment) {
        notify('银行卡类型设置暂不可用');
        return;
      }
      const request = {};
      openingRechargeCardType = request;
      void api.modules.commerce.openBankCardTypeAssignment(key, {
        isCurrent: () => openingRechargeCardType === request && Boolean(trigger()),
        onClose: () => trigger()?.focus({ preventScroll: true })
      }).finally(() => {
        if (openingRechargeCardType === request) openingRechargeCardType = undefined;
      });
      return;
    }
    if (message.type === 'open-task-log') {
      if (state.route !== onlineRechargeRoute || activeOnlineView !== 'logs' ||
          frame.hidden || frame.dataset.viewGroup !== 'admin' ||
          typeof message.jobKey !== 'string' || !/^[\w-]{1,128}$/.test(message.jobKey)) return;
      openRechargeTaskLog(message.jobKey, () => {
        if (frame.isConnected && !frame.hidden)
          frame.contentDocument?.querySelector(`[data-view-task-log="${message.jobKey}"]`)?.focus({ preventScroll: true });
      });
      return;
    }
    if (event.data.type === 'ready' && request?.frame === frame) {
      if (preserveLockedRecharge(view)) return;
      revealRechargeFrame(view, frame, request, event.data.height, event.data.description);
    } else if (event.data.type === 'view-context' && !frame.hidden) {
      resizeRechargeFrame(frame, event.data.height);
      frame.dataset.description = event.data.description || '';
      updateRechargeDescription(event.data.description);
    } else if (event.data.type === 'navigation-lock' && event.data.locked && request) {
      preserveLockedRecharge(view);
    } else if (event.data.type === 'resize' && !frame.hidden) {
      resizeRechargeFrame(frame, event.data.height);
    } else if (event.data.type === 'session-expired' || event.data.type === 'unavailable') {
      if (event.data.type === 'session-expired') {
        localData?.queries?.clear();
        window.IDLocalAuth?.lock?.();
      }
      if (request?.frame !== frame && state.route === onlineRechargeRoute &&
          frame.dataset.view !== activeOnlineView) return;
      const keepContent = frame.hidden && Boolean(view.querySelector('iframe:not([hidden])'));
      showUnavailableIntegration(
        view,
        event.data.type === 'session-expired' ? 401 : 503,
        keepContent
      );
    }
  }
  function resizeRechargeFrame(frame, height) {
    if (!Number.isFinite(height) || height <= 0) return;
    const minimum = frame.dataset.viewGroup === 'bit' ? 360 : 290;
    const nextHeight = `${Math.max(minimum, Math.ceil(height))}px`;
    if (frame.style.height !== nextHeight) frame.style.height = nextHeight;
    frame.dataset.measuredHeight = String(height);
    positionRechargeOverlays();
  }
  function positionRechargeOverlays() {
    const frame = $('[data-recharge-module] iframe[data-view-group="admin"]:not([hidden])', integrationRoot());
    if (!frame || frame.dataset.viewGroup !== 'admin') return;
    const root = frame.contentDocument?.documentElement;
    if (!root) return;
    const bounds = frame.getBoundingClientRect();
    const top = Math.max(0, -bounds.top);
    const height = Math.min(window.innerHeight, bounds.bottom) - Math.max(0, bounds.top);
    if (height <= 0) return;
    root.style.setProperty('--embed-visible-top', `${top}px`);
    root.style.setProperty('--embed-visible-height', `${height}px`);
  }
  async function checkRechargeAccess(signal) {
    try {
      const response = await window.fetch(onlineRechargeMount + 'status', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)])
      });
      return { status: response.status, access: response.ok ? await response.json() : null };
    } catch {
      return { status: 503, access: null };
    }
  }
  async function loadIntegratedRecharge({ refresh = false } = {}) {
    const bit = state.route === bitLoginRoute;
    const workspace = state.route === workspaceRechargeRoute;
    const loginLogs = state.route === loginLogsRoute;
    const module = bit ? 'bit' : workspace ? 'workspace' : loginLogs ? 'login-logs' : 'online';
    const panel = $(`[data-recharge-module="${module}"]`, integrationRoot());
    const view = panel?.querySelector('.recharge-integration__view');
    if (!view) return;
    const selected = bit ? bitLoginView : workspace ? workspaceRechargeView :
      loginLogs ? rechargeLoginLogsView : onlineRechargeViews.find(([id]) => id === activeOnlineView);
    const group = bit ? 'bit' : workspace ? 'workspace' : selected[2] ? 'public' : 'admin';
    const existingFrame = view.querySelector('iframe:not([hidden])');
    const key = `${module}:${group}:${selected[0]}`;
    const pending = currentIntegrationRequest.get(view);
    if (!refresh && pending?.key === key && !pending.controller.signal.aborted) return;

    if (!refresh) {
      if (view.dataset.unavailable) return;
      const cachedFrame = view.querySelector(`iframe[data-view-group="${group}"][data-bridge-ready="true"]`);
      if (
        cachedFrame &&
        (group === 'bit' || group === 'public' || group === 'workspace' || onlineAdmin === true)
      ) {
        finishIntegrationLoad(view);
        for (const frame of view.querySelectorAll('iframe')) {
          if (frame !== cachedFrame && !frame.hidden) setFrameVisible(frame, false);
          frame.hidden = frame !== cachedFrame;
        }
        cachedFrame.title = selected[1];
        if (cachedFrame.dataset.view !== selected[0]) {
          cachedFrame.dataset.view = selected[0];
          cachedFrame.contentWindow?.postMessage(
            { source: 'id-recharge-shell', type: 'select-view', view: selected[0] }, window.location.origin
          );
        }
        sendIntegrationTheme(cachedFrame);
        setFrameVisible(cachedFrame, true);
        resizeRechargeFrame(cachedFrame, Number(cachedFrame.dataset.measuredHeight));
        updateRechargeDescription(cachedFrame.dataset.description || '');
        api.restorePendingPageScroll();
        return;
      }
    }

    finishIntegrationLoad(view);
    const controller = new AbortController();
    const request = { controller, key };
    currentIntegrationRequest.set(view, request);
    const active = () => panel.isConnected && currentIntegrationRequest.get(view) === request;
    const progress = view.querySelector('.design-region-progress');
    const needsAccessCheck = !bit && (refresh || onlineAdmin === undefined);
    request.read = api.beginRegionRead(view, progress, {
      loadingText: needsAccessCheck && !refresh && !existingFrame ? '正在检查充值服务' : '',
      refreshButton: panel.querySelector('.recharge-integration__toolbar > [data-action="ops-integrated-refresh"]')
    });

    if (needsAccessCheck) {
      const { status, access } = await checkRechargeAccess(controller.signal);
      if (!active() || preserveLockedRecharge(view)) return;
      if (access?.ready !== true) {
        onlineAdmin = undefined;
        showUnavailableIntegration(view, status, Boolean(existingFrame));
        return;
      }
      onlineAdmin = access.admin === true;
      request.read.setLoadingText('');
    }
    delete view.dataset.unavailable;
    if (!onlineAdmin && existingFrame?.dataset.viewGroup === 'admin') existingFrame.remove();
    panel.querySelectorAll('.recharge-integration__nav [data-view]').forEach((control) => {
      const publicPath = onlineRechargeViews.find(([id]) => id === control.dataset.view)?.[2];
      control.disabled = !onlineAdmin && !publicPath;
    });
    if (!onlineAdmin && !selected[2]) {
      showUnavailableIntegration(view, 403);
      // Only the selected view is restricted. Public views can still load.
      delete view.dataset.unavailable;
      return;
    }
    const frame = document.createElement('iframe');
    request.frame = frame;
    frame.className = 'recharge-integration__frame';
    if (bit) frame.classList.add('recharge-integration__frame--bit-local');
    frame.title = selected[1];
    frame.dataset.viewGroup = group;
    frame.dataset.view = selected[0];
    frame.referrerPolicy = 'no-referrer';
    frame.hidden = true;
    frame.src = bit ? selected[2] : onlineRechargeMount + (selected[2] || 'admin?view=' + selected[0]);
    // The gateway still authorizes every frame request and returns JSON if access changed.
    frame.addEventListener('load', async () => {
      if (!active() || frame.contentDocument?.contentType !== 'application/json') return;
      if (bit) {
        showUnavailableIntegration(view, 503);
        return;
      }
      onlineAdmin = undefined;
      const { status, access } = await checkRechargeAccess(controller.signal);
      if (!active() || preserveLockedRecharge(view)) return;
      const denied = status === 401 || status === 403 ||
        (access?.ready === true && access.admin !== true && !selected[2]);
      showUnavailableIntegration(view, denied ? (status === 401 ? 401 : 403) : 503, existingFrame?.isConnected);
    });
    request.frameTimer = setTimeout(() => {
      if (active()) showUnavailableIntegration(view, 503, existingFrame?.isConnected);
    }, 15000);
    view.querySelector('.recharge-integration__content').append(frame);
  }
  window.addEventListener?.('message', handleIntegrationMessage);
  window.addEventListener?.('scroll', positionRechargeOverlays, { capture: true, passive: true });
  window.addEventListener?.('resize', positionRechargeOverlays);
  $('#theme-toggle')?.addEventListener('click', () => {
    for (const frame of document.querySelectorAll('[data-recharge-module] iframe')) sendIntegrationTheme(frame);
  });
  function deactivateIntegration(region) {
    for (const view of region.querySelectorAll('.recharge-integration__view')) {
      finishIntegrationLoad(view);
      for (const frame of view.querySelectorAll('iframe')) {
        setFrameVisible(frame, false);
        frame.hidden = true;
      }
    }
  }
  function renderStaff() {
    if (localData && window.IDLocalAuth) return window.IDLocalAuth.renderEmployees(api);
    if (localData)
      return (
        header('员工与权限', '员工登录与角色权限待接入。') +
        `<section class="panel">${empty('员工登录与权限待接入', '本机业务操作暂以“本机操作员”身份登记。')}<div class="toolbar">${button('查看操作记录', 'ops-go', '', 'orders', 'data-route="settings/audit"')}</div></section>`
      );
    const superView = local.staffRole === 'super';
    const rolePreview = `<div class="toolbar"><label for="ops-role-preview">原型权限视角</label>${select(
      'ops-role-preview',
      [
        ['super', '超级管理员'],
        ['admin', '普通管理员'],
        ['employee', '普通员工']
      ],
      local.staffRole
    )}<span class="footnote">只切换设计状态，不修改登录身份</span></div>`;
    const tabs = `<div class="tabs" role="tablist" aria-label="账户设置" data-page-actions="tabs">${[
      ['staff', '员工账户'],
      ['permissions', '角色权限'],
      ['security', '安全中心']
    ]
      .map(
        ([id, label]) =>
          `<button type="button" class="tab ${local.staffTab === id ? 'active' : ''}" role="tab" aria-selected="${local.staffTab === id}" data-action="ops-staff-tab" data-tab="${id}">${label}</button>`
      )
      .join('')}</div>`;
    if (local.staffRole === 'employee')
      return (
        header('员工与权限', '普通员工没有访问员工管理、全局角色和安全设置的权限。') +
        `<section class="panel">${rolePreview}${empty('无权查看此模块', '这是原型权限视角，切换回管理员可继续查看设计。')}</section>`
      );
    let body;
    if (local.staffTab === 'staff')
      body = `<div class="toolbar"><div class="toolbar-left">${search('搜索演示员工名称或邮箱')}</div><div class="toolbar-right">${button('新增员工', 'ops-staff-add', 'primary', 'plus', superView ? '' : 'disabled')}</div></div>${table(
        [
          { id: 'id', label: '员工编号' },
          { id: 'name', label: '昵称' },
          { id: 'email', label: '登录邮箱' },
          { id: 'role', label: '角色' },
          {
            id: 'status',
            label: '状态',
            render: (row) => tag(row.status, row.status === '启用' ? 'success' : '')
          },
          { id: 'notes', label: '备注' },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (row) =>
              `<div class="action-links">${textAction(superView ? '编辑' : '查看', 'ops-staff-edit', actionData(row.id))}${textAction('更多操作', 'ops-staff-more', `${actionData(row.id)} aria-haspopup="menu" aria-expanded="false"`, '', 'down')}</div>`
          }
        ],
        pageRows(rowsByQuery(staff.filter((row) => row.status !== '已删除'))),
        '',
        '员工账户'
      )}${pagination(staff.filter((row) => row.status !== '已删除').length)}`;
    else if (local.staffTab === 'permissions') {
      const role = local.permissionRole || '普通员工';
      const labels = ['库存查看', '库存修改', '订单查看', '订单修改', '充值操作', '审计查看'];
      body = `<div class="form-panel"><form id="ops-permissions-form">${grid(field('角色', 'ops-permission-role', select('ops-permission-role', ['普通员工', '普通管理员'], role), true))}<div class="settings-list">${labels.map((label, index) => `<div class="setting-row"><label for="ops-permission-${index}">${label}</label><input type="checkbox" id="ops-permission-${index}" name="ops-permission" value="${label}" ${(permissions[role] || []).includes(label) ? 'checked' : ''} ${superView ? '' : 'disabled'} /></div>`).join('')}</div><div class="form-footer"><span class="footnote">唯一超级管理员不通过角色矩阵转让。</span><button type="submit" class="button primary" ${superView ? '' : 'disabled'}>核对演示权限</button></div></form></div>`;
    } else {
      const d = getDraft('security', {
        'ops-security-mfa': local.securityMfa || '保持原策略',
        'ops-security-ip': local.securityIp || '127.0.0.1'
      });
      body = `<div class="form-panel"><form id="ops-security-form" novalidate>${grid(field('强制登录验证', 'ops-security-mfa', select('ops-security-mfa', ['保持原策略', '演示开启强制验证'], d['ops-security-mfa']), true) + api.optionListEditor({ id: 'ops-security-ip', label: 'IP 白名单', itemLabel: 'IP', values: api.readOptionList(d['ops-security-ip']), minItems: 1, protectedValues: ['127.0.0.1'], draft: d, disabled: !superView }))}<div class="side-note">正式系统需验证管理员均已绑定 MFA、当前 IP 仍在白名单等保护条件。原型不生成验证码、不注销会话、不修改真实安全策略。</div><div class="form-footer"><button type="submit" class="button primary" ${superView ? '' : 'disabled'}>核对演示设置</button></div></form></div>`;
    }
    return (
      header(
        '员工与权限',
        '员工账户、角色和安全变更仅由唯一超级管理员操作；本页为权限设计演示。',
        button('查看审计', 'ops-go', '', 'orders', 'data-route="settings/audit"')
      ) + `<section class="panel">${rolePreview}${tabs}${body}</section>`
    );
  }
  function editStaff(id = '') {
    const original = staff.find((row) => row.id === id),
      context = `staff:${id || 'new'}`,
      d = getDraft(context, original || { role: '普通员工', status: '启用' });
    const readOnly = local.staffRole !== 'super';
    const fields =
      field(
        '员工昵称',
        'ops-staff-name',
        input('ops-staff-name', d['ops-staff-name'] ?? d.name ?? '', readOnly ? 'readonly' : ''),
        true
      ) +
      wide(
        field(
          '登录邮箱',
          'ops-staff-email',
          input(
            'ops-staff-email',
            d['ops-staff-email'] ?? d.email ?? '',
            readOnly || original ? 'readonly' : 'placeholder="staff@example.test"'
          ),
          true
        )
      ) +
      field(
        '角色',
        'ops-staff-role',
        original?.role === '超级管理员'
          ? input('ops-staff-role', original.role, 'readonly')
          : select('ops-staff-role', ['普通员工', '普通管理员'], d['ops-staff-role'] ?? d.role),
        true
      ) +
      wide(
        field(
          '备注',
          'ops-staff-notes',
          input(
            'ops-staff-notes',
            d['ops-staff-notes'] ?? d.notes ?? '',
            readOnly ? 'readonly' : ''
          )
        )
      );
    openDrawer(
      `${readOnly ? '查看' : original ? '编辑' : '新增'}员工`,
      '原型不创建真实账号、不生成或保存登录密码。角色预览不会改变实际身份。',
      `<form id="ops-staff-form" novalidate><input type="hidden" name="ops-staff-id" value="${esc(id)}" />${grid(fields)}</form>`,
      readOnly ? button('关闭', 'drawer-close') : formFooter('ops-staff-form'),
      draftKey(context)
    );
  }
  function saveStaff(form) {
    if (local.staffRole !== 'super') {
      notify('此权限视角只能查看，不能修改员工');
      return;
    }
    const values = readForm(form),
      id = values['ops-staff-id'],
      name = values['ops-staff-name'].trim(),
      email = values['ops-staff-email'].trim();
    const error = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? '请填写演示登录邮箱'
      : staff.some((row) => row.email.toLowerCase() === email.toLowerCase() && row.id !== id)
        ? '演示邮箱已存在'
        : '';
    setError('ops-staff-name', name ? '' : '请填写员工昵称');
    setError('ops-staff-email', error);
    if (!name || error) return;
    confirmAction('确认保存演示员工', `${name}。不创建真实登录身份，不发送开通通知。`, () => {
      const original = staff.find((row) => row.id === id);
      const next = {
        name,
        email,
        role: values['ops-staff-role'],
        notes: values['ops-staff-notes']
      };
      if (original) Object.assign(original, next);
      else staff.push({ ...next, id: uid('STAFF'), status: '启用' });
      finishDrawer();
      recordAudit('维护员工', name);
      render();
      notify('演示员工资料已保存');
    });
  }
  function staffMore(id, node) {
    const row = staff.find((item) => item.id === id),
      superView = local.staffRole === 'super';
    api.openActionMenu(node, `<div class="property-list"><div class="property-row"><span>员工</span><strong>${esc(row.name)}</strong></div><div class="property-row"><span>角色</span><strong>${esc(row.role)}</strong></div></div><div class="guide-list"><div class="guide-item"><div class="section-title-row"><h3>账号状态</h3>${titleInfo('账号状态', '唯一超级管理员和存在结果未确认任务的员工受保护。', 'staff-status-description')}</div><div class="toolbar">${button(row.status === '启用' ? '停用员工' : '启用员工', 'ops-staff-toggle', '', '', `${actionData(id)} ${superView ? '' : 'disabled'}`)}${button('模拟重置密码', 'ops-staff-reset', '', '', `${actionData(id)} ${superView ? '' : 'disabled'}`)}${button('删除演示员工', 'ops-staff-delete', 'danger', '', `${actionData(id)} ${superView ? '' : 'disabled'}`)}</div></div></div>`);
  }
  function renderMailboxTypes() {
    if (localData && settingsState !== 'ready') return settingsStatusPage('邮箱分类设置');
    return listPanel(
      '邮箱分类设置',
      '此分类全局统一；国家、来源、套餐等仍按各数据表独立配置。',
      [
        { id: 'id', label: '固定分类标识' },
        { id: 'label', label: '显示名称' },
        {
          id: 'enabled',
          label: '状态',
          render: (row) => tag(row.id === 'microsoft' ? '仅库存' : row.enabled ? '启用' : '停用', row.enabled ? 'success' : '')
        },
        {
          id: 'usage',
          label: localData ? '本机资料引用数' : '演示资料引用数',
          render: (row) =>
            String(
              [...api.collections.mailboxes, ...api.collections.accounts].filter(
                (item) => item.type === row.id || item.mailType === row.id
              ).length
            )
        },
        {
          id: 'actions',
          label: '操作',
          action: true,
          render: (row) =>
            `<div class="action-links">${textAction('编辑', 'ops-mail-type-edit', actionData(row.id))}${textAction('上移', 'ops-mail-type-move', `${actionData(row.id)} data-offset="-1"`)}${textAction('下移', 'ops-mail-type-move', `${actionData(row.id)} data-offset="1"`)}</div>`
        }
      ],
      mailboxTypes.filter((row) => row.id !== 'apple'),
      (localData ? button('重新读取', 'ops-settings-reload') : '') +
        button('新增分类', 'ops-mail-type-add', 'primary', 'plus')
    );
  }
  function editMailboxType(id = '') {
    if (localData && settingsState !== 'ready') return;
    const row = mailboxTypes.find((item) => item.id === id),
      supported = ['google', 'apple', 'relay'].includes(id),
      context = `mail-type:${id || 'new'}`;
    openDrawer(
      row ? '编辑邮箱分类' : '新增邮箱分类',
      id === 'microsoft' ? '可在邮箱管理登记微软邮箱库存。快捷提交、提取和下游选用接通后再开放此开关。'
        : '修改显示名称不改变资料归属。新增分类需接入对应业务后启用。',
      `<form id="ops-mail-type-form" novalidate><input type="hidden" name="ops-type-id" value="${esc(id)}" /><input type="hidden" name="ops-type-version" value="${settingsVersion}" />${grid(field('分类名称', 'ops-type-label', input('ops-type-label', row?.label || '', 'maxlength="30"'), true) + field('状态', 'ops-type-enabled', select('ops-type-enabled', supported ? ['启用', '停用'] : ['停用'], row?.enabled ? '启用' : '停用'), true))}</form>`,
      (localData ? button('重新读取', 'ops-mail-type-reload', '', '', actionData(id)) : '') +
        formFooter('ops-mail-type-form', '核对并保存', Boolean(localData)),
      draftKey(context)
    );
    bindToolDraft($('#ops-mail-type-form'), context);
  }
  function saveMailboxType(form) {
    const values = readForm(form),
      id = values['ops-type-id'],
      label = values['ops-type-label'].trim();
    if (!label || mailboxTypes.some((row) => row.label === label && row.id !== id)) {
      setError('ops-type-label', '名称不能为空，且不能与其他分类重复');
      return;
    }
    const expectedVersion = Number(values['ops-type-version']);
    const submitted = JSON.stringify(values);
    const submission = toolSubmission(form);
    const apply = () => {
      if (finishToolSubmission(submission, 'ops-type-version', settingsVersion)) {
        closeDrawer();
        state.drafts.delete(submission.key);
      }
      refreshSettingsPage();
      notify(localData ? '邮箱分类已保存到本机' : '演示邮箱分类已更新');
    };
    confirmAction('确认更新邮箱分类', `${label}。修改分类配置不迁移或删除现有资料。`, () => {
      if (!form.isConnected || JSON.stringify(readForm(form)) !== submitted) return;
      const rows = mailboxTypes.map((row) => ({ ...row }));
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.label = label;
        row.enabled =
          ['google', 'apple', 'relay'].includes(id) && values['ops-type-enabled'] === '启用';
      } else rows.push({ id: uid('mail-type'), label, enabled: false });
      if (localData) {
        void commitSettings(
          'mailbox_category_save',
          { ...settingsSnapshot(), mailboxTypes: rows },
          expectedVersion
        ).then((saved) => {
          if (saved) apply();
        });
        return;
      }
      mailboxTypes.splice(0, mailboxTypes.length, ...rows);
      recordAudit('配置邮箱分类', label);
      apply();
    });
  }
  function customerOptionConfig(kind) {
    const sources = kind === 'sources';
    return {
      kind: sources ? 'sources' : 'tags',
      key: sources ? 'customer-sources' : 'customer-tags',
      label: sources ? '来源' : '标签',
      property: sources ? 'customerSources' : 'customerTags',
      id: sources ? 'ops-customer-source-options' : 'ops-customer-tag-options',
      formId: sources ? 'ops-customer-sources-form' : 'ops-customer-tags-form',
      versionField: sources ? 'ops-customer-sources-version' : 'ops-customer-tags-version'
    };
  }
  function renderCustomerOptionSettings(kind) {
    const config = customerOptionConfig(kind);
    const draft = getDraft(config.key);
    return `<div class="form-panel design-async-region" aria-busy="false"><div data-customer-options-status role="status" hidden></div>
      <form id="${config.formId}" data-customer-options="${config.kind}" novalidate>
        <input type="hidden" name="${config.versionField}" value="${esc(draft[config.versionField] ?? settingsVersion)}" />
        ${api.optionListEditor({ id: config.id, label: `${config.label}清单`, itemLabel: config.label, values: config.kind === 'sources' ? customerSources : customerTags, minItems: 0, draft })}
        <div class="form-footer"><span class="footnote">移除选项不影响已保存的客户资料。</span>
          <button class="button primary" type="submit" form="${config.formId}">保存${config.label}设置</button></div>
      </form></div>`;
  }
  function dropdownSettingsTab() {
    const tab = getDraft('dropdown-settings').tab;
    return isAdmin() && ['sources', 'tags'].includes(tab) ? tab : 'costs';
  }
  function renderDropdownSettings() {
    const selected = dropdownSettingsTab();
    const tabs = [['costs', '费用规则'], ...(isAdmin() ? [['sources', '来源设置'], ['tags', '标签设置']] : [])];
    const ready = !localData || settingsState === 'ready';
    const actions = ready && localData ? button('重新读取', selected === 'costs' ? 'ops-settings-reload' : 'ops-customer-options-reload', '', '', `data-kind="${selected}"`) : '';
    const content = !ready
      ? `<div class="panel-body" role="${settingsState === 'error' ? 'alert' : 'status'}">${empty(
          settingsState === 'error' ? '设置读取失败' : '正在读取设置',
          settingsState === 'error' ? '请重新读取后继续编辑。' : '读取完成后可编辑。'
        )}${settingsState === 'error' ? `<div class="toolbar">${button('重新读取', 'ops-settings-reload')}</div>` : ''}</div>`
      : selected === 'costs' ? renderCosts() : renderCustomerOptionSettings(selected);
    return header('下拉设置', '统一维护费用规则、客户来源和客户标签。切换页签保留未保存输入。', actions) +
      `<section class="panel dropdown-settings"><div class="tabs" role="tablist" aria-label="下拉设置分类" data-page-actions="tabs">${tabs.map(([id, label]) =>
        `<button type="button" class="tab${id === selected ? ' active' : ''}" id="dropdown-settings-${id}" role="tab" aria-selected="${id === selected}" tabindex="${id === selected ? '0' : '-1'}" aria-controls="dropdown-settings-content" data-action="ops-dropdown-tab" data-tab="${id}">${label}</button>`).join('')}</div>
        <div id="dropdown-settings-content" role="tabpanel" aria-labelledby="dropdown-settings-${selected}">${content}</div></section>`;
  }
  function saveCustomerOptionSettings(form) {
    if (!isAdmin() || settingsSaving) return;
    const config = customerOptionConfig(form.dataset.customerOptions);
    if (api.optionListPending(form)) {
      setError(config.id, `请先添加或保存正在编辑的${config.label}。`);
      return;
    }
    const values = readForm(form);
    let options;
    try {
      options = api.readOptionList(values[config.id]);
      if (options.length > 100 || options.some((value) => value.length > 40 || /[\r\n]/.test(value)) ||
          new Set(options.map((value) => value.toLowerCase())).size !== options.length)
        throw new Error('无效的选项清单');
    } catch {
      setError(config.id, `最多设置 100 个${config.label}，每个最多 40 字，不得换行或重复。`);
      return;
    }
    const submitted = JSON.stringify(values);
    const key = draftKey(config.key);
    confirmAction(`确认保存客户${config.label}`, '设置仅更新可选清单，已保存的客户资料继续保留。', async () => {
      if (!form.isConnected || JSON.stringify(readForm(form)) !== submitted) return;
      const submit = document.querySelector(`button[form="${config.formId}"][type="submit"]`);
      if (submit) submit.disabled = true;
      form.setAttribute('aria-busy', 'true');
      try {
        if (localData) {
          if (!(await commitSettings(`customer_${config.kind}_save`,
            { ...settingsSnapshot(), [config.property]: options }, Number(values[config.versionField])))) return;
        } else {
          if (config.kind === 'sources') customerSources = options;
          else customerTags = options;
          recordAudit(`保存客户${config.label}设置`, '客户资料');
        }
        preserveDraft();
        const unchanged = form.isConnected && JSON.stringify(readForm(form)) === submitted;
        if (unchanged) {
          state.drafts.delete(key);
        } else {
          const draft = state.drafts.get(key);
          if (draft && JSON.stringify(draft) === submitted) state.drafts.delete(key);
          else if (draft?.[config.versionField] === values[config.versionField])
            draft[config.versionField] = String(settingsVersion);
          const currentForm = document.getElementById(config.formId);
          if (currentForm?.elements[config.versionField]?.value === values[config.versionField])
            currentForm.elements[config.versionField].value = String(settingsVersion);
        }
        if (unchanged) refreshSettingsPage();
        else api.modules.commerce?.refreshCustomerTagOptions?.();
        notify(`客户${config.label}设置已保存`);
      } finally {
        if (submit?.isConnected) submit.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }
  const costFields = [
    ['claudeBankFeeMyr', 'Claude 代付服务费', '每笔 Claude 银行卡订单加这笔马币费用，再按订单汇率折算。'],
    ['claudeAccountCostMyr', 'Claude KYC 认证成本', '按每笔的马币规则金额计入。已有核对后的 KYC 实付凭据时，按凭据核算。'],
    ['gmailCostCny', '谷歌邮箱成本', '使用有明确来源的谷歌邮箱时，录单可带入这笔人民币成本。'],
    ['appleCostCny', '苹果邮箱成本', '使用有明确来源的苹果隐藏邮箱时，录单可带入这笔人民币成本。'],
    ['microsoftCostCny', '微软邮箱成本', '使用有明确来源的微软邮箱时，录单可带入这笔人民币成本。'],
    ['appleDiscount', '苹果内购折扣', 'Claude 苹果内购成本等于订阅面额乘折扣。填 0.8 时，20 美元面额按 16 美元计成本。'],
    ['cardIssueUsd', '通用开卡成本', '每张卡一次，单位美元。单笔分摊等于这张卡的开卡费除以同卡成功开通笔数。'],
    ['cardPercent', '通用付款费率', '比例手续费等于本单代付金额乘费率。填 0.008 表示 0.8%。'],
    ['cardPerPaymentUsd', '通用付款固定费用', '每笔符合通用银行卡规则的付款固定加这笔美元费用。']
  ];
  function renderCosts() {
    const config = api.modules.commerce?.getCostSettings?.();
    if (!config)
      return `<div class="panel-body">${empty('订单配置服务未加载', '请刷新页面后重试。')}</div>`;
    const draft = getDraft('costs');
    const fields =
      field(
        '统计币种',
        'ops-cost-currency',
        select(
          'ops-cost-currency',
          [
            ['CNY', '人民币 CNY'],
            ['MYR', '马币 MYR']
          ],
          draft['ops-cost-currency'] ?? config.currency
        ),
        true,
        esc('点「核对费用规则」并确认后，订单统计的净收款、利润合计及订单列表的收益按所选币种折算。' +
          'Claude 代付和 KYC 成本按马币填写，邮箱成本按人民币填写，开卡费和每笔固定手续费按美元填写。折扣和费率按比例填写。' +
          '历史订单按各自保存的汇率折算。缺少所需汇率时，跨币种收款暂不计入合计，相关利润显示为待核算。')
      ) +
      costFields
        .map(([key, label, unit]) =>
          field(
            label,
            `ops-cost-${key}`,
            input(
              `ops-cost-${key}`,
              draft[`ops-cost-${key}`] ?? config[key],
              'inputmode="decimal"'
            ),
            true,
            esc(unit)
          )
        )
        .join('');
    const rates = api.modules.commerce.getFxRates?.() || {};
    const hasRates = Object.keys(rates).length > 0;
    return (
      `<div class="${hasRates ? 'two-column' : 'cost-layout'}"><section class="form-panel design-async-region" aria-busy="false"><div data-cost-read-status role="status" hidden></div><form id="ops-cost-form" novalidate><input type="hidden" name="ops-cost-version" value="${esc(draft['ops-cost-version'] ?? config.version)}" />${grid(fields)}${hasRates ? '' : `<div class="commerce-cost-strip section-gap"><span class="section-title-row"><strong>汇率状态</strong>${titleInfo('汇率状态', '订单核算使用各自登记的汇率快照，费用规则变化不会回写历史订单。', 'cost-rates-description')}</span><span>暂无汇率报价</span></div>`}<div class="form-footer"><span class="footnote">配置版本 ${config.version} · 保存后只影响新订单，历史金额不自动重算。</span><button class="button primary" type="submit">核对费用规则</button></div></form></section>${hasRates ? `<section class="side-panel"><div class="section-title-row"><h2>演示汇率</h2>${titleInfo('演示汇率', '全部为固定示例汇率，不是当前市场报价。正式接入复用已有供应商、有效期和快照，不把配置变化回写历史订单。', 'cost-rates-description')}</div><dl class="definition-list">${Object.entries(
        rates
      )
        .map(([code, value]) => `<dt>${esc(code)} / CNY</dt><dd>${esc(value)}</dd>`)
        .join('')}</dl></section>` : ''}</div>`
    );
  }
  function saveCosts(form) {
    const values = readForm(form),
      service = api.modules.commerce,
      config = service?.getCostSettings?.();
    if (!config) {
      notify('订单配置服务未加载');
      return;
    }
    const next = { ...config, currency: values['ops-cost-currency'] };
    if (!['CNY', 'MYR'].includes(next.currency)) {
      setError('ops-cost-currency', '请选择人民币或马币');
      return;
    }
    let invalid;
    for (const [key] of costFields) {
      const value = values[`ops-cost-${key}`];
      let message = '';
      try {
        money.units(value);
        if (money.compare(value, '0') < 0) message = '金额不能为负';
        if (
          key === 'appleDiscount' &&
          (money.compare(value, '0') <= 0 || money.compare(value, '1') > 0)
        )
          message = '折扣需大于零且不超过 1';
        if (key === 'cardPercent' && money.compare(value, '1') > 0) message = '费率不能超过 1';
      } catch {
        message = '请输入最多四位小数的非负金额';
      }
      setError(`ops-cost-${key}`, message);
      if (message) invalid ||= `ops-cost-${key}`;
      next[key] = value;
    }
    if (invalid) {
      document.getElementById(invalid).focus();
      return;
    }
    if (String(config.version) !== values['ops-cost-version']) {
      notify(localData ? '配置版本已变化，请重新读取后再编辑' : '配置版本已变化，请重新核对');
      return;
    }
    const expectedVersion = settingsVersion;
    const submitSnapshot = JSON.stringify(values);
    function afterSave() {
      if (localData && state.route === 'settings/costs') preserveDraft();
      const key = draftKey('costs');
      const draft = state.drafts.get(key);
      if (!draft || JSON.stringify(draft) === submitSnapshot) state.drafts.delete(key);
      else if (localData && draft['ops-cost-version'] === values['ops-cost-version']) {
        draft['ops-cost-version'] = String(service.getCostSettings().version);
      }
      refreshSettingsPage();
      notify(localData ? '费用规则已保存到本机' : '演示费用规则已保存');
    }
    confirmAction(
      '确认保存费用规则',
      '新订单将采用新配置版本，历史订单及已冻结费用快照保持原值。',
      () => {
        if (localData) {
          void commitSettings(
            'fee_rules_save',
            { ...settingsSnapshot(), costSettings: { ...next, version: config.version + 1 } },
            expectedVersion
          ).then((saved) => {
            if (saved) afterSave();
          });
          return;
        }
        const result = service.updateCostSettings(next);
        if (!result.ok) {
          notify(result.message || '配置未保存');
          return;
        }
        recordAudit('修改费用规则', `配置版本 ${result.settings?.version || '已更新'}`);
        afterSave();
      }
    );
  }
  function renderAudit() {
    const columns = [
      { id: 'time', label: '时间' },
      { id: 'actor', label: '操作人' },
      { id: 'action', label: '操作类型' },
      { id: 'subject', label: '对象' },
      { id: 'result', label: '结果' },
      {
        id: 'actions', label: '操作', action: true,
        render: (row) => textAction('查看详情', 'ops-audit-detail', actionData(row.id))
      }
    ];
    if (!localData) return listPanel('审计日志', '仅记录当前原型中的演示操作，不包含密码、Session、安全码或生产日志。', columns, audit);
    const tableId = '运营审计日志';
    return header('审计日志', '按北京时间记录业务操作及实际操作账号。本地可查询最近 1,000 条业务日志。') +
      `<section class="panel"><div class="toolbar"><div class="toolbar-left">${search('搜索操作人、操作、对象或编号（最近 1,000 条）', auditViews.audit.query)}<span class="toolbar-meta">可查最近 1,000 条</span></div><div class="toolbar-right" data-page-actions>${button('列设置', 'column-settings', '', 'columns', `data-table-id="${tableId}"`)}${button(auditViews.audit.error ? '重试读取' : '刷新日志', 'ops-audit-refresh')}</div></div>${auditPageContent('audit', columns, tableId)}</section>`;
  }
  function renderLoginLogs() {
    const title = header('登录日志', '统一账号的登录与退出记录。检索范围为最近 1,000 条业务日志；充值服务原有记录和 IP 封禁可在对应页签查看。');
    if (!isAdmin()) return title + `<section class="panel">${empty('无权查看登录日志', '请使用管理员账号。')}</section>`;
    const tabs = `<div class="tabs" role="tablist" aria-label="登录日志来源" data-page-actions="tabs">${[
      ['system', '系统登录'],
      ['recharge', '充值登录与 IP 封禁']
    ].map(([id, label]) =>
      `<button type="button" class="tab ${loginLogTab === id ? 'active' : ''}" role="tab" aria-selected="${loginLogTab === id}" data-action="ops-login-log-tab" data-tab="${id}">${label}</button>`
    ).join('')}</div>`;
    if (loginLogTab === 'recharge')
      return title + tabs + `<p class="inline-notice">此处的 IP 封禁仅作用于充值服务。</p>` +
        renderRechargeRegion('login-logs');
    if (!localData?.authRequired)
      return title + tabs + `<section class="panel">${empty('当前预览未启用统一登录', '启用员工账号后，登录和退出记录会显示在这里。')}</section>`;
    const columns = [
      { id: 'time', label: '时间' },
      { id: 'actor', label: '账号' },
      { id: 'action', label: '事件' }
    ];
    return title + tabs + `<section class="panel">
      <div class="toolbar"><div class="toolbar-left">${search('搜索账号、事件或编号（最近 1,000 条）', auditViews.login.query)}<span class="toolbar-meta">检索最近 1,000 条</span></div>
      <div class="toolbar-right">${button(auditViews.login.error ? '重试读取' : '刷新日志', 'ops-audit-refresh')}</div></div>
      ${auditPageContent('login', columns, '系统登录日志')}
    </section>`;
  }
  function phraseRows() {
    return localData ? toolbox?.current()?.data.phrases || [] : phrases;
  }
  function showPhrases() {
    state.toolsTab = '话术文案';
    if (localData && !toolbox?.current()) {
      const error = toolbox?.error();
      openToolboxPanel(state.toolsTab,
        `<div id="phrase-load" role="status">${error || !toolbox
          ? empty('话术读取失败', error || '请刷新本机页面。') +
            (toolbox ? button('重新读取', 'ops-phrases-retry') : '')
          : '<div class="inline-notice">正在读取个人话术…</div>'}</div>`);
      const pending = $('#phrase-load');
      if (toolbox && !error)
        void toolbox.load().finally(() => {
          if (pending.isConnected && $('#drawer').open) showPhrases();
        }).catch(() => {});
      return;
    }
    const query = local.phraseQuery.trim().toLowerCase();
    const rows = phraseRows().filter((row) =>
      Boolean(row.deleted) === Boolean(local.showDeleted) &&
      (!query || `${row.title} ${row.text}`.toLowerCase().includes(query)));
    if (local.phraseSort === 'title') rows.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
    if (local.phraseSort === 'updated') rows.sort((left, right) =>
      (right.updatedAt || '').localeCompare(left.updatedAt || ''));
    const pageSize = local.phrasePageSize;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    local.phrasePage = Math.max(1, Math.min(local.phrasePage, pages));
    const offset = (local.phrasePage - 1) * pageSize;
    const displayed = rows.slice(offset, offset + pageSize);
    const canReorder = !local.showDeleted && local.phraseSort === 'custom' && !query && rows.length > 1;
    const cards = displayed.map((row, index) => {
      const attrs = actionData(row.id);
      const position = offset + index;
      const title = canReorder
        ? `<button class="toolbox-phrase-title" type="button" draggable="true" data-phrase-order="${esc(row.id)}" aria-label="调整顺序：${esc(row.title)}" title="拖动标题或按上下键调整顺序">${esc(row.title)}</button>`
        : `<strong class="toolbox-phrase-title" title="${esc(row.title)}">${esc(row.title)}</strong>`;
      const more = local.showDeleted ? button('恢复', 'ops-phrase-restore', '', '', attrs)
        : `<details class="toolbox-phrase-more" data-dismiss-outside><summary aria-label="更多：${esc(row.title)}">更多</summary><div class="toolbox-phrase-menu">${textAction('查看全文', 'ops-phrase-more', attrs)}${textAction('编辑文案', 'ops-phrase-edit', attrs)}${canReorder ? textAction('上移', 'ops-phrase-move', `${attrs} data-offset="-1" ${position === 0 ? 'disabled' : ''}`) + textAction('下移', 'ops-phrase-move', `${attrs} data-offset="1" ${position === rows.length - 1 ? 'disabled' : ''}`) : ''}${textAction('删除文案', 'ops-phrase-delete', attrs, 'danger')}</div></details>`;
      return `<article class="toolbox-phrase-card" data-phrase-id="${esc(row.id)}">${title}${button('复制文案', 'ops-phrase-copy', '', '', attrs)}${more}</article>`;
    }).join('');
    const sort = select('ops-phrase-sort', [['custom', '自定义排序'], ['updated', '最近修改'], ['title', '标题排序']], local.phraseSort)
      .replace('<select ', '<select aria-label="话术文案排序" ');
    const emptyTitle = query ? '没有匹配的话术文案' : local.showDeleted ? '暂无已删除的话术' : '还没有话术文案';
    openToolboxPanel(state.toolsTab,
      `<div class="toolbox-phrase-toolbar"><input type="search" id="ops-phrase-search" aria-label="搜索话术标题或内容" value="${esc(local.phraseQuery)}" placeholder="搜索文案" maxlength="100" />${sort}${button('新增', 'ops-phrase-add', 'primary')}</div>
        <div id="ops-phrase-list">${cards || empty(emptyTitle, query ? '请调整搜索词。' : '新增后可一键复制正文。')}</div>
        ${renderPagination({ id: 'operations-phrases', page: local.phrasePage, pageSize, total: rows.length })}
        <div class="toolbox-phrase-archive">${textAction(local.showDeleted ? '返回正常话术' : '已删除', 'ops-phrase-deleted')}</div>`);
    if (!canReorder) return;
    const list = $('#ops-phrase-list');
    let dragged = '';
    list.addEventListener('dragstart', (event) => {
      dragged = event.target.closest('[data-phrase-order]')?.dataset.phraseOrder || '';
      if (!dragged) return;
      event.dataTransfer.setData('text/plain', '');
      event.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragover', (event) => {
      if (dragged && event.target.closest('[data-phrase-id]')) event.preventDefault();
    });
    list.addEventListener('dragend', () => { dragged = ''; });
    list.addEventListener('drop', (event) => {
      const target = event.target.closest('[data-phrase-id]')?.dataset.phraseId;
      if (!dragged || !target || dragged === target) return;
      event.preventDefault();
      void reorderPhrase(dragged, target);
      dragged = '';
    });
    list.addEventListener('keydown', (event) => {
      const id = event.target.dataset.phraseOrder;
      if (!id || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const index = rows.findIndex((row) => row.id === id);
      const target = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) void reorderPhrase(id, target.id);
    });
  }
  let phraseOrdering = false;
  async function reorderPhrase(id, target) {
    if (phraseOrdering || id === target) return;
    const startingPage = local.phrasePage;
    phraseOrdering = true;
    try {
      await changePhrases(toolbox?.current()?.version, (rows) => {
        const active = rows.filter((row) => !row.deleted);
        const from = active.findIndex((row) => row.id === id);
        const to = active.findIndex((row) => row.id === target);
        if (from < 0 || to < 0) throw new Error('找不到需要排序的话术');
        const [item] = active.splice(from, 1);
        active.splice(to, 0, item);
        let next = 0;
        rows.forEach((row, index) => { if (!row.deleted) rows[index] = active[next++]; });
      }, '调整话术顺序', () => {
        if (local.phrasePage === startingPage && local.phraseSort === 'custom' &&
            !local.showDeleted && !local.phraseQuery.trim()) {
          const position = phraseRows().filter((row) => !row.deleted).findIndex((row) => row.id === id);
          if (position !== -1) local.phrasePage = Math.floor(position / local.phrasePageSize) + 1;
        }
        showPhrases();
        $('#ops-phrase-list')?.querySelector(`[data-phrase-order="${CSS.escape(id)}"]`)?.focus();
      });
    } finally {
      phraseOrdering = false;
    }
  }
  function editPhrase(id = '') {
    const row = phraseRows().find((item) => item.id === id),
      context = `phrase:${id || 'new'}`,
      d = getDraft(context, row || {});
    if (id && (!row || row.deleted)) return notify('请先恢复这条话术。');
    const version = toolbox?.current()?.version;
    const localFields = toolbox
      ? `<input type="hidden" name="ops-phrase-version" value="${esc(d['ops-phrase-version'] ?? version)}" /><input type="hidden" name="ops-phrase-new-id" value="${esc(d['ops-phrase-new-id'] || (id ? '' : crypto.randomUUID()))}" /><div id="phrase-save-error" class="inline-notice warning" role="alert" hidden></div><div id="phrase-review" hidden>${button('重新核对当前话术', 'ops-phrase-review')}</div>`
      : '';
    openDrawer(
      row ? '编辑话术' : '新增话术',
      toolbox ? '保存后可从顶部“话术文案”复制使用。' : '保存到当前原型内存。',
      `<form id="ops-phrase-form" novalidate><input type="hidden" name="ops-phrase-id" value="${esc(id)}" />${grid(wide(field('标题', 'ops-phrase-title', input('ops-phrase-title', d['ops-phrase-title'] ?? d.title ?? '', 'maxlength="60"'), true)) + wide(field('话术内容', 'ops-phrase-text', `<textarea id="ops-phrase-text" name="ops-phrase-text" rows="6" maxlength="5000">${esc(d['ops-phrase-text'] ?? d.text ?? '')}</textarea>`, true)))}${localFields}</form>`,
      button('返回话术', 'ops-phrases') +
        `<button class="button primary" type="submit" form="ops-phrase-form">核对并保存</button>`,
      draftKey(context),
      { kind: 'toolbox-phrase-detail' }
    );
  }
  function savePhrase(form) {
    const values = readForm(form),
      id = values['ops-phrase-id'],
      title = values['ops-phrase-title'].trim(),
      text = values['ops-phrase-text'].trim();
    const titleError = !title
      ? '请填写话术标题'
      : title.length > 60
        ? '话术标题不能超过 60 字'
        : '';
    const textError = !text
      ? '请填写话术内容'
      : text.length > 5000
        ? '话术内容不能超过 5000 字'
        : '';
    setError('ops-phrase-title', titleError);
    setError('ops-phrase-text', textError);
    if (titleError || textError) return;
    confirmAction(
      toolbox ? '确认保存话术' : '确认保存演示话术',
      title,
      () => {
        const rowId = id || values['ops-phrase-new-id'] || uid('PHRASE');
        void changePhrases(
          Number(values['ops-phrase-version']),
          (rows) => {
            const row = rows.find((item) => item.id === rowId);
            if (row?.deleted) throw new Error('请先恢复这条话术。');
            if (row) Object.assign(row, { title, text, updatedAt: new Date().toISOString() });
            else if (id) throw new Error('找不到这条话术。');
            else rows.push({ id: rowId, title, text, deleted: false, updatedAt: new Date().toISOString() });
          },
          id ? '更新话术' : '新增话术',
          () => {
            finishDrawer();
            showPhrases();
          }
        );
      },
      '确认保存'
    );
  }
  async function changePhrases(version, change, action, done = showPhrases) {
    const drawer = $('#drawer');
    const panel = drawer.querySelector('.drawer-body');
    const submit = drawer.querySelector('button[form="ops-phrase-form"]');
    if (submit) submit.disabled = true;
    try {
      if (toolbox) await toolbox.save('phrases', version, change, action);
      else {
        change(phrases);
        recordAudit(action, '个人话术');
      }
      if (drawer.open && panel.isConnected) done();
      notify(toolbox ? '话术已保存' : '演示话术已保存');
    } catch (error) {
      if (drawer.open && panel.isConnected) {
        const notice = $('#phrase-save-error');
        if (notice) {
          notice.textContent = error.message;
          notice.hidden = false;
          $('#phrase-review').hidden = error.status !== 409;
        } else if (error.status === 409) showPhrases();
      }
      notify(error.message);
    } finally {
      if (submit) submit.disabled = false;
    }
  }
  async function reviewPhrase(form) {
    if (!toolbox || !form) return;
    try {
      await toolbox.load({ refresh: true });
    } catch (error) {
      notify(error.message);
      return;
    }
    if (!toolActive(form)) return;
    const values = readForm(form);
    const row = phraseRows().find(
      (item) => item.id === (values['ops-phrase-id'] || values['ops-phrase-new-id'])
    );
    if (row?.deleted) return notify('请先恢复这条话术。');
    const version = toolbox.current().version;
    confirmAction(
      '核对当前话术',
      row
        ? `当前保存的「${row.title}」内容为：${row.text}`
        : '当前没有这条话术。继续编辑会保留你刚才的输入。',
      () => {
        form.elements.namedItem('ops-phrase-version').value = version;
        $('#phrase-save-error').hidden = true;
        $('#phrase-review').hidden = true;
      },
      '继续编辑'
    );
  }
  function phraseMore(id) {
    const row = phraseRows().find((item) => item.id === id && !item.deleted);
    if (!row) return;
    openDrawer(
      row.title,
      '',
      `<div class="toolbox-phrase-full">${esc(row.text)}</div>`,
      button('复制文案', 'ops-phrase-copy', 'primary', 'copy', actionData(id)),
      '',
      { kind: 'toolbox-phrase-detail' }
    );
  }
  function isAdmin() {
    return !['employee', 'staff', '普通员工'].includes(state.actor?.role);
  }
  function openToolDrawer(name, description, body, context = '', sections = [], lead = '') {
    const tabs = sections.length ? `<div class="tabs online-tool-sections" role="tablist" aria-label="${esc(name)}功能">${sections.map(([id, label]) => `<button type="button" id="tab-${id}" class="tab" role="tab" data-action="ops-tool-section" data-panel="${id}" aria-controls="${id}" aria-selected="false" tabindex="-1">${esc(label)}</button>`).join('')}</div>` : '';
    const titles = { '计算 2FA 验证码': '2FA 动态验证码', '邮箱查询与邮箱池': '邮箱查询与管理' };
    const selected = getDraft(`tool-section:${name}`).panel;
    const section = sections.some(([id]) => id === selected) ? selected : sections[0]?.[0] || '';
    const toolbar = tabs || lead ? `<div class="tool-header-row">${tabs}${lead}</div>` : '';
    const page = pluginPages[state.route]?.tool === name ? $('#plugin-tool-host') : null;
    if (page) page.innerHTML = (name === '网站监控' ? `<div class="tool-header-row">${api.websiteMonitorTabs(section || 'ops-website-check')}</div>` : toolbar) + `<div class="drawer-body plugin-tool-body">${body}</div>`;
    else openDrawer(titles[name] || name, description, toolbar + body, '', context, { kind: 'online-tool', tool: name, section });
    const drawer = page || $('#drawer');
    drawer.dataset.tool = name;
    if (sections.length && !page) {
      const navigation = drawer.querySelector('.tool-header-row');
      drawer.querySelector('.drawer-header').after(navigation);
    }
    for (const [id] of sections) {
      const panel = drawer.querySelector(`#${id}`);
      if (!panel) continue;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `tab-${id}`);
      panel.dataset.toolPanel = '';
    }
    if (sections.length) {
      const saved = getDraft(`tool-section:${name}`).panel;
      selectToolSection(sections.some(([id]) => id === saved) ? saved : sections[0][0]);
      drawer.querySelector('[role="tablist"]:not(.monitor-navigation)')?.addEventListener('keydown', (event) => {
        const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click();
        tabs[next].focus();
      });
    }
  }
  function selectToolSection(id) {
    const panel = document.getElementById(id);
    if (!panel) return;
    const drawer = panel.closest('[data-plugin-tool], dialog');
    drawer.dataset.section = id;
    preserveDraft();
    const mailForm = drawer.querySelector('#ops-managed-mail-query');
    if (mailForm && id !== 'ops-mailbox-query-panel') finishManagedMailRead(mailForm);
    for (const item of drawer.querySelectorAll('[data-tool-panel]')) item.hidden = item !== panel;
    for (const tab of drawer.querySelectorAll('[data-action="ops-tool-section"]')) {
      const active = tab.dataset.panel === id;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    state.drafts.set(draftKey(`tool-section:${drawer.dataset.tool}`), { panel: id });
    if (['ops-mailbox-query-panel', 'ops-mailbox-pool'].includes(id))
      state.drafts.set(draftKey('mailbox-tools-view'), {
        ...getDraft('mailbox-tools-view'), tab: id === 'ops-mailbox-pool' ? 'manage' : 'query'
      });
    drawer.querySelector('.drawer-body').scrollTop = 0;
    if (!panel.dataset.loaded) {
      panel.dataset.loaded = 'true';
      if (id === 'ops-mailbox-pool') void loadManagedPool(panel);
    }
  }
  function savedTotpPanel() {
    return `<section class="form-section" id="ops-saved-totp" aria-label="已保存 2FA 账号"><div class="panel-heading"><div class="section-title-row"><h3>已保存账号</h3>${titleInfo('已保存账号', '密钥加密保存在服务器，同一账号换电脑仍可使用。支持搜索、分页、编辑、删除和复制当前验证码。', 'saved-totp-help')}</div>${button('新增账号', 'ops-saved-totp-add', 'primary', 'plus')}</div><form class="online-tool-search" id="ops-saved-totp-search-form" onsubmit="return false"><input type="search" id="ops-saved-totp-search" name="ops-saved-totp-search" aria-label="搜索已保存的 2FA 账号" placeholder="搜索账号名称或签发方"></form><div data-saved-totp-editor></div><div class="design-async-region"><div data-saved-totp-status role="status" hidden></div><div data-saved-totp-list></div></div></section>`;
  }
  const savedTotpSnapshots = new WeakMap();
  const temporaryTotpAccounts = new WeakMap();

  function paintSavedTotp(panel, snapshot, requestedPage = getDraft('saved-totp-page').page || 1) {
    if (!toolActive(panel) || snapshot.version < Number(panel.dataset.version)) return;
    savedTotpSnapshots.set(panel, snapshot);
    panel.dataset.version = String(snapshot.version);
    const search = panel.querySelector('#ops-saved-totp-search').value.trim().toLowerCase();
    const items = snapshot.items.filter((row) => [row.name, row.issuer].some((value) =>
      value?.toLowerCase().includes(search)));
    const draftSize = getDraft('saved-totp-page').pageSize;
    const pageSize = pageSizes.includes(draftSize) ? draftSize : defaultPageSize;
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(pages, Math.max(1, requestedPage));
    state.drafts.set(draftKey('saved-totp-page'), { page, pageSize });
    const list = panel.querySelector('[data-saved-totp-list]');
    if (!items.length) {
      list.innerHTML = (snapshot.items.length ? empty('没有匹配的账号', '可按账号名称或签发方搜索。')
        : empty('暂无已保存账号', '可将常用验证器账号保存到当前登录账户。')) +
        renderPagination({ id: 'operations-saved-totp', page, pageSize, total: 0 });
      return;
    }
    list.innerHTML = `<div class="saved-totp-table" data-pagination-table>${table([
      { id: 'name', label: '账号', render: row => `<div class="totp-account-name"><strong title="${esc(row.name)}">${esc(row.name)}</strong>${row.issuer ? `<small title="${esc(row.issuer)}">${esc(row.issuer)}</small>` : ''}</div>` },
      { id: 'code', label: '验证码', render: row => `<div class="totp-inline-code" data-saved-totp-code data-id="${esc(row.id)}">正在获取验证码…</div>` },
      { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${button('复制', 'ops-totp-copy', 'primary', '', 'disabled aria-label="复制验证码"')}${button('编辑', 'ops-saved-totp-edit', '', '', `data-id="${esc(row.id)}" data-name="${esc(row.name)}"`)}${button('删除', 'ops-saved-totp-delete', '', '', `data-id="${esc(row.id)}" data-name="${esc(row.name)}"`)}</div>` }
    ], items.slice((page - 1) * pageSize, page * pageSize), '', '已保存验证器账号')}</div>${renderPagination({ id: 'operations-saved-totp', page, pageSize, total: items.length })}`;
    refreshVisibleSavedTotp(panel);
  }
  async function loadSavedTotp(panel, { refresh = false } = {}) {
    if (!toolActive(panel)) return;
    const list = panel.querySelector('[data-saved-totp-list]');
    const status = panel.querySelector('[data-saved-totp-status]');
    const read = api.beginRegionRead(status.parentElement, status, {
      loadingText: savedTotpSnapshots.has(panel) ? '' : '正在读取账号…'
    });
    try {
      const snapshot = localData.queries
        ? await localData.queries.read('saved-totp', 'metadata', () => localData.savedTotp(), { refresh })
        : await localData.savedTotp();
      if (!read.current() || !toolActive(panel)) return;
      paintSavedTotp(panel, snapshot);
      const view = getDraft('saved-totp-view');
      if (panel.isConnected && view.editor && !panel.querySelector('#ops-saved-totp-form'))
        editSavedTotp(panel, { dataset: { id: view.id || '', name: view.name || '' } });
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (read.current() && toolActive(panel)) {
        if (error.status === 401 || error.status === 403) {
          list.replaceChildren();
          savedTotpSnapshots.delete(panel);
        }
        read.finish();
        status.hidden = false;
        status.className = 'inline-notice warning';
        status.textContent = error.message || '账号读取失败，请重试';
        status.insertAdjacentHTML('beforeend', button('重试', 'ops-saved-totp-reload'));
      }
      return false;
    } finally {
      read.finish();
    }
  }
  function editSavedTotp(panel, node) {
    if (panel.dataset.version === undefined) return;
    preserveDraft();
    state.drafts.set(draftKey('saved-totp-view'), {
      editor: true, id: node?.dataset.id || '', name: node?.dataset.name || ''
    });
    const editing = Boolean(node?.dataset.id);
    const previousSecret = panel.querySelector('#ops-totp-save-secret');
    if (previousSecret) previousSecret.value = '';
    panel.querySelector('[data-saved-totp-editor]').innerHTML = `<form id="ops-saved-totp-form" novalidate><input type="hidden" name="ops-totp-id" value="${esc(node?.dataset.id || '')}"><input type="hidden" name="ops-totp-version" value="${esc(panel.dataset.version)}">${grid(
      field('账号名称', 'ops-totp-name', input('ops-totp-name', node?.dataset.name || '', 'maxlength="80"'), true) +
      field('密钥', 'ops-totp-save-secret', `<div class="tool-input-row"><input type="text" id="ops-totp-save-secret" name="ops-totp-save-secret" autocomplete="off" spellcheck="false" maxlength="2048" data-no-draft>${button('重试读取', 'ops-saved-totp-secret-retry', '', '', 'hidden')}</div>`, !editing, '密钥加密保存在当前账号下，编辑时直接显示。')
    )}<div class="form-footer">${button('取消', 'ops-saved-totp-cancel')}<button type="submit" class="button primary">保存账号</button></div></form>`;
    bindToolDraft(panel.querySelector('#ops-saved-totp-form'), `saved-totp:${node?.dataset.id || 'new'}`);
    panel.querySelector('#ops-totp-name')?.focus();
    if (editing) void loadSavedTotpSecret(panel.querySelector('#ops-saved-totp-form'));
  }
  async function loadSavedTotpSecret(form) {
    if (!toolActive(form)) return;
    const control = form.querySelector('#ops-totp-save-secret');
    const submit = form.querySelector('[type="submit"]');
    const retry = form.querySelector('[data-action="ops-saved-totp-secret-retry"]');
    const request = String(Number(form.dataset.secretRequest || 0) + 1);
    form.dataset.secretRequest = request;
    let edited = false;
    const markEdited = () => { edited = true; };
    control.addEventListener('input', markEdited);
    submit.disabled = true;
    retry.hidden = true;
    control.placeholder = '正在读取密钥…';
    setError(control.id, '');
    try {
      const result = await localData.savedTotpSecret(form.elements['ops-totp-id'].value,
        Number(form.elements['ops-totp-version'].value));
      if (!toolActive(form) || form.dataset.secretRequest !== request) return;
      if (typeof result.secret !== 'string') throw new Error('密钥读取失败，请重试。');
      if (!edited) control.value = result.secret;
    } catch (error) {
      if (toolActive(form) && form.dataset.secretRequest === request) {
        setError(control.id, error.message || '密钥读取失败，请重试。');
        retry.hidden = false;
      }
    } finally {
      control.removeEventListener('input', markEdited);
      if (form.dataset.secretRequest === request) {
        control.placeholder = '请输入密钥';
        submit.disabled = false;
      }
    }
  }
  async function saveSavedTotp(panel, data, submission) {
    try {
      const snapshot = await localData.saveTotp(data);
      const secretUnchanged = !submission || submission.form.querySelector('#ops-totp-save-secret')?.value === data.secret;
      const unchanged = finishToolSubmission(submission, 'ops-totp-version', snapshot.version) && secretUnchanged;
      if (submission && !state.drafts.has(submission.key)) {
        const view = getDraft('saved-totp-view');
        if (draftKey(`saved-totp:${view.id || 'new'}`) === submission.key)
          state.drafts.delete(draftKey('saved-totp-view'));
      }
      if (!panel.isConnected) return;
      if (unchanged) panel.querySelector('[data-saved-totp-editor]').replaceChildren();
      if (data.action === 'create' && submission?.form.dataset.temporaryTotp === 'true' && unchanged) {
        const search = panel.querySelector('#ops-saved-totp-search');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        paintSavedTotp(panel, snapshot, Math.ceil(snapshot.items.length / (getDraft('saved-totp-page').pageSize || defaultPageSize)));
        panel.querySelector('[data-saved-totp-list]').scrollIntoView({ block: 'nearest' });
      } else paintSavedTotp(panel, snapshot);
      notify('已保存 2FA 账号变更');
    } catch (error) {
      if (panel.isConnected) notify(error.message);
      if (error.status === 409) await loadSavedTotp(panel, { refresh: true });
    }
  }
  function paintTotpCountdown(node, remaining) {
    node.textContent = String(remaining);
    node.closest('.totp-countdown')?.classList.toggle('is-expiring', remaining <= 5);
  }
  function refreshVisibleSavedTotp(panel) {
    if (!toolActive(panel) || panel.hidden || document.hidden) return;
    const now = Date.now();
    const due = [];
    for (const output of panel.querySelectorAll('[data-saved-totp-code]')) {
      const expiry = Number(output.dataset.expiry || 0);
      if (expiry > now) {
        paintTotpCountdown(output.querySelector('[data-totp-countdown]'), Math.ceil((expiry - now) / 1000));
      } else if (!output.dataset.pending && now >= Number(output.dataset.retryAt || 0)) {
        due.push(output);
      }
    }
    if (due.length) void loadSavedTotpCodes(panel, due);
  }
  async function loadSavedTotpCodes(panel, outputs) {
    if (!toolActive(panel)) return;
    const version = Number(panel.dataset.version);
    const started = Date.now();
    const rows = outputs.filter(output => output?.isConnected && !output.dataset.pending).map(output => {
      const copy = output.closest('tr').querySelector('[data-action="ops-totp-copy"]');
      output.dataset.pending = 'true';
      delete output.dataset.expiry;
      copy.disabled = true;
      delete copy.dataset.code;
      delete copy.dataset.expiresAt;
      output.textContent = '正在获取验证码…';
      return { output, copy, id: output.dataset.id };
    });
    if (!rows.length) return;
    let codes, serverNow, failure;
    try {
      const result = await localData.savedTotpCodePage(rows.map(row => row.id), version);
      if (result?.version !== version || !Number.isFinite(result.serverNow) || !Array.isArray(result.items))
        throw new Error('验证码读取失败，请重试');
      codes = new Map(result.items.map(item => [item.id, item]));
      serverNow = result.serverNow;
    } catch (error) {
      failure = error;
    }
    const current = toolActive(panel) && !panel.hidden && Number(panel.dataset.version) === version;
    for (const { output, copy, id } of rows) {
      delete output.dataset.pending;
      if (!current || !output.isConnected) continue;
      const result = codes?.get(id);
      if (!/^\d{6,8}$/.test(result?.code || '') || !Number.isFinite(result?.expiresAt)) {
        const stale = failure?.status === 409;
        output.dataset.retryAt = stale ? 'Infinity' : String(Date.now() + 15_000);
        output.innerHTML = `<span>${esc(failure?.message || result?.error || '验证码读取失败，请重试')}</span> ${stale
          ? button('刷新账号列表', 'ops-saved-totp-reload') : button('重试取码', 'ops-saved-totp-use')}`;
        continue;
      }
      const { code, expiresAt } = result;
      const expiry = started + Math.max(0, expiresAt - serverNow);
      const remaining = Math.ceil((expiry - Date.now()) / 1000);
      if (remaining <= 0) {
        output.textContent = '验证码已过期，正在更新…';
        output.dataset.retryAt = String(Date.now() + 500);
        continue;
      }
      output.dataset.expiry = String(expiry);
      output.innerHTML = `<div class="totp-code-card__reading"><strong class="ops-code" aria-label="当前验证码">${esc(code)}</strong><span class="totp-countdown"><span class="totp-countdown__label">剩余</span><span data-totp-countdown>${remaining}</span>秒</span></div>`;
      copy.dataset.code = code;
      copy.dataset.expiresAt = String(expiry);
      copy.disabled = false;
      paintTotpCountdown(output.querySelector('[data-totp-countdown]'), remaining);
    }
  }
  function openTotp() {
    openToolDrawer(
      '计算 2FA 验证码',
      '支持旧版的 Base32、验证器链接或「账号|密码|密钥」格式，每行一条。',
      `<section id="ops-totp-calculator"><form id="ops-totp-form" data-mode="single" novalidate>
        <div class="tool-mode-switch" role="group" aria-label="验证码查询方式">
          ${button('单个查询', 'ops-totp-mode', 'tab active', '', 'data-mode="single" aria-pressed="true"')}
          ${button('批量查询', 'ops-totp-mode', 'tab', '', 'data-mode="batch" aria-pressed="false"')}
        </div>${grid(
        wide(
          field(
            '密钥',
            'ops-totp-secret',
            `<div class="totp-input-actions"><input id="ops-totp-secret" name="ops-totp-secret" type="text" maxlength="20000" placeholder="粘贴 Base32 密钥或 otpauth 链接" autocomplete="off" spellcheck="false" data-no-draft><div class="totp-input-controls"><span data-totp-lines hidden>0 / 50 行</span>${button('一键粘贴', 'ops-tool-paste', '', 'copy', 'data-field="ops-totp-secret"')}${button('重试', 'ops-totp-retry', '', 'refresh', 'hidden')}</div></div>`,
            true,
            '<span data-totp-input-help>粘贴后自动生成。密钥仅在本机计算。</span>'
          )
        )
      )}<div class="form-footer totp-batch-actions">
        ${button('清空', 'ops-tool-clear', '', '', 'data-field="ops-totp-secret"')}
        <button type="submit" class="button primary">查询验证码</button>
      </div><div id="ops-totp-result" role="status"></div></form></section>${localData.authRequired ? savedTotpPanel() : ''}`
    );
    const drawer = $('#drawer');
    const form = $('#ops-totp-form');
    if (getDraft('totp-mode').mode === 'batch') selectTotpMode(form, 'batch');
    form.addEventListener('input', (event) => {
      if (event.target.id !== 'ops-totp-secret') return;
      temporaryTotpAccounts.delete(form);
      form.querySelector('#ops-totp-result').replaceChildren();
      form.querySelector('[data-totp-lines]').textContent =
        `${event.target.value.split(/\r?\n/).filter((line) => line.trim()).length} / 50 行`;
      setError('ops-totp-secret', '');
      form.querySelector('[data-action="ops-totp-retry"]').hidden = true;
    });
    form.addEventListener('keydown', (event) => {
      if (event.target.id === 'ops-totp-secret' && form.dataset.mode === 'single' && event.key === 'Enter') {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('paste', (event) => {
      if (event.target.id !== 'ops-totp-secret' || form.dataset.mode === 'batch') return;
      const value = event.clipboardData?.getData('text');
      if (!value) return;
      event.preventDefault();
      applyTotpPaste(form, value);
    });
    const saved = $('#ops-saved-totp');
    bindToolDraft($('#ops-saved-totp-search-form'), 'saved-totp-search');
    saved?.querySelector('#ops-saved-totp-search').addEventListener('input', () => {
      const snapshot = savedTotpSnapshots.get(saved);
      if (snapshot) paintSavedTotp(saved, snapshot, 1);
    });
    if (saved) void loadSavedTotp(saved);
    const timer = saved && window.setInterval(() => refreshVisibleSavedTotp(saved), 500);
    const clearSensitiveFields = () => {
      if (drawer.open && form.isConnected) return;
      drawer.removeEventListener('close', clearSensitiveFields);
      if (timer) window.clearInterval(timer);
      form.querySelector('#ops-totp-secret').value = '';
      temporaryTotpAccounts.delete(form);
      form.querySelector('#ops-totp-result').replaceChildren();
      const savedSecret = saved?.querySelector('#ops-totp-save-secret');
      if (savedSecret) savedSecret.value = '';
      saved?.querySelectorAll('[data-saved-totp-code]').forEach((row) => row.replaceChildren());
      saved?.querySelectorAll('[data-action="ops-totp-copy"]').forEach(button => { button.disabled = true; delete button.dataset.code; delete button.dataset.expiresAt; });
    };
    drawer.addEventListener('close', clearSensitiveFields);
  }
  function applyTotpPaste(form, value) {
    const previous = form.querySelector('#ops-totp-secret');
    if (!toolActive(form) || previous.disabled || !value.trim()) return;
    if (value.length > previous.maxLength) {
      setError(previous.id, '剪贴板内容超过输入上限。');
      return;
    }
    // Spreadsheets wrap cells containing newlines in quotes and escape a quote
    // inside the cell as two quotes. Unwrap the cell before counting accounts.
    let text = value.trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replaceAll('""', '"');
    const lines = text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
    const autoQuery = form.dataset.mode !== 'batch';
    if (autoQuery && lines.length > 1) {
      setError(previous.id, '多条密钥请切换到批量查询。');
      return;
    }
    const control = form.querySelector('#ops-totp-secret');
    control.value = lines.join('\n');
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.focus();
    if (autoQuery) form.requestSubmit();
  }
  function selectTotpMode(form, mode) {
    const batch = mode === 'batch';
    const previous = form.querySelector('#ops-totp-secret');
    if (form.querySelector('[type="submit"]').disabled || previous.tagName === (batch ? 'TEXTAREA' : 'INPUT')) return;
    state.drafts.set(draftKey('totp-mode'), { mode: batch ? 'batch' : 'single' });
    const control = document.createElement(batch ? 'textarea' : 'input');
    control.id = previous.id;
    control.name = previous.name;
    control.maxLength = previous.maxLength;
    control.autocomplete = 'off';
    control.spellcheck = false;
    control.dataset.noDraft = '';
    if (batch) {
      control.rows = 7;
      control.placeholder = '每行一个密钥、otpauth 链接，或 账号|密码|2FA|邮箱';
    } else {
      control.type = 'text';
      control.placeholder = '粘贴 Base32 密钥或 otpauth 链接';
    }
    previous.value = '';
    temporaryTotpAccounts.delete(form);
    previous.replaceWith(control);
    form.dataset.mode = mode;
    const lines = form.querySelector('[data-totp-lines]');
    lines.hidden = !batch;
    lines.textContent = '0 / 50 行';
    form.querySelector('[data-totp-input-help]').textContent = batch
      ? '每行一个密钥，无效行会单独提示。' : '粘贴后自动生成。密钥仅在本机计算。';
    for (const button of form.querySelectorAll('[data-mode]')) {
      button.classList.toggle('active', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    form.querySelector('#ops-totp-result').replaceChildren();
    setError(control.id, '');
    form.querySelector('[data-action="ops-totp-retry"]').hidden = true;
    control.focus();
  }
  let totpCalculatorModule, totpCalculatorAttempt = 0;
  async function addTemporaryTotpAccount(node) {
    const form = node.closest('#ops-totp-form');
    const accounts = temporaryTotpAccounts.get(form);
    const account = accounts?.[Number(node.dataset.index)];
    const panel = $('#ops-saved-totp');
    if (!account || !panel || !toolActive(form)) return;
    if (panel.dataset.version === undefined) await loadSavedTotp(panel);
    if (!toolActive(form) || temporaryTotpAccounts.get(form) !== accounts || panel.dataset.version === undefined) return;
    editSavedTotp(panel);
    const editor = panel.querySelector('#ops-saved-totp-form');
    editor.dataset.temporaryTotp = 'true';
    editor.querySelector('#ops-totp-save-secret').value = account.secretInput;
    const name = editor.querySelector('#ops-totp-name');
    if (!name.value && !/^第 \d+ 行$/.test(account.label)) name.value = account.label;
    name.dispatchEvent(new Event('input', { bubbles: true }));
    editor.scrollIntoView({ block: 'nearest' });
    name.focus();
  }
  function loadTotpCalculator() {
    if (!totpCalculatorModule) {
      // A failed dynamic import stays cached for its URL in this document.
      // Each explicit retry gets a fresh URL; successful loads remain shared.
      const attempt = ++totpCalculatorAttempt;
      totpCalculatorModule = import(`/assets/tools/totp.mjs?v=20261108&attempt=${attempt}`).catch(() => {
        totpCalculatorModule = undefined;
        const error = new Error('验证码组件暂时加载失败，输入已保留，请点击重试。');
        error.code = 'TOTP_MODULE_UNAVAILABLE';
        throw error;
      });
    }
    return totpCalculatorModule;
  }
  async function runTotp(form) {
    const control = form.querySelector('#ops-totp-secret');
    const submit = form.querySelector('button[type="submit"]');
    const output = form.querySelector('#ops-totp-result');
    if (submit.disabled) return;
    let source = control.value;
    form.querySelector('[data-action="ops-totp-retry"]').hidden = true;
    setError('ops-totp-secret', '');
    if (!source.trim()) {
      if (output.querySelector('[data-totp-account]')) return;
      setError('ops-totp-secret', '请输入验证器密钥');
      return;
    }
    output.replaceChildren();
    temporaryTotpAccounts.delete(form);
    submit.disabled = true;
    control.disabled = true;
    try {
      const { prepareTotpBatch } = await loadTotpCalculator();
      const { accounts, errors } = await prepareTotpBatch(source);
      source = '';
      if (!toolActive(form)) return;
      temporaryTotpAccounts.set(form, accounts);
      output.innerHTML = (accounts.length ? table([
        { id: 'label', label: '账号／行号' },
        { id: 'code', label: '验证码', render: () => '<div class="totp-inline-code" data-totp-account><strong class="ops-code" aria-label="当前验证码">—</strong><span class="totp-countdown">剩余 <span data-totp-countdown>—</span> 秒</span></div>' },
        { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${button('复制', 'ops-totp-copy', 'primary', '', 'disabled aria-label="复制验证码"')}${localData.authRequired ? button('新增账号', 'ops-totp-save', '', '', `data-index="${row.index}"`) : ''}</div>` }
      ], accounts.map(({ label }, index) => ({ id: 'totp-' + index, label, index })), '', '本次验证码') : '') +
        (errors.length ? `<div class="inline-notice warning">${errors.map(message => `<div>${esc(message)}</div>`).join('')}</div>` : '');
      const rows = [...output.querySelectorAll('[data-totp-account]')].map((reading) => ({
        code: reading.querySelector('.ops-code'),
        remaining: reading.querySelector('[data-totp-countdown]'),
        copy: reading.closest('tr').querySelector('button'),
        expiresAt: 0
      }));
      if (!rows.length) return;
      const tick = async () => {
        if (!rows[0].code.isConnected || !$('#drawer').open) return;
        const time = Date.now();
        try {
          await Promise.all(
            rows.map(async (row, index) => {
              if (row.expiresAt <= time) {
                row.copy.disabled = true;
                const { code, expiresAt } = await accounts[index].generate(time);
                row.expiresAt = expiresAt;
                row.code.textContent = code;
                row.copy.dataset.code = code;
                row.copy.dataset.expiresAt = String(expiresAt);
                row.copy.disabled = false;
              }
              paintTotpCountdown(row.remaining, Math.max(0, Math.ceil((row.expiresAt - time) / 1000)));
            })
          );
        } catch {
          if (rows[0].code.isConnected) output.textContent = '无法更新验证码，请重新计算。';
          return;
        }
        if (rows[0].code.isConnected) window.setTimeout(tick, 250);
      };
      void tick();
    } catch (error) {
      if (toolActive(form)) {
        setError('ops-totp-secret', error.message || '无法计算验证码');
        form.querySelector('[data-action="ops-totp-retry"]').hidden = error.code !== 'TOTP_MODULE_UNAVAILABLE';
      }
    } finally {
      source = '';
      submit.disabled = false;
      control.disabled = false;
    }
  }
  function openMediaResolver() {
    openToolDrawer(
      '抖音解析',
      '粘贴公开作品链接或分享文本，可下载解析结果提供的视频、原声或图片。',
      `<div class="inline-notice online-tool-notice">${icon('play')}<div><strong>只解析可公开访问的单个作品</strong><div class="field-help">支持抖音、TikTok、YouTube、Instagram、X、B 站等平台。</div></div></div><form id="ops-media-resolver" novalidate><div class="form-grid">${wide(
        field(
          '作品链接',
          'ops-media-text',
          '<textarea id="ops-media-text" name="ops-media-text" maxlength="4096" rows="3" placeholder="粘贴作品链接或包含链接的分享文本"></textarea>',
          true,
          '仅处理单个作品，最多下载 256 MB'
        )
      )}</div><div class="form-footer">${button('一键粘贴', 'ops-tool-paste', '', 'copy', 'data-field="ops-media-text"')}<button type="submit" class="button primary">${icon('search')}开始解析</button></div></form><div id="ops-media-result" class="form-section" role="status" aria-live="polite">${empty('粘贴作品链接后开始解析', '解析结果只在当前页面保留。')}</div><p class="footnote">请只下载你拥有或已获授权的内容。</p>`,
      draftKey('media-resolver')
    );
    const form = $('#ops-media-resolver');
    bindToolDraft(form, 'media-resolver');
    form.querySelector('#ops-media-text').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }
  async function resolveOnlineMedia(form) {
    const input = form.querySelector('#ops-media-text');
    const result = $('#ops-media-result');
    const submit = form.querySelector('[type="submit"]');
    if (!input.value.trim()) {
      setError(input.id, '请粘贴作品链接或分享文本');
      input.focus();
      return;
    }
    setError(input.id, '');
    if (submit.disabled) return;
    submit.disabled = true;
    result.textContent = '正在解析作品，请稍候';
    try {
      const media = await localData.resolveMedia(input.value);
      if (!form.isConnected || !result.isConnected) return;
      const groups = [
        ['video', '视频'],
        ['audio', '原声'],
        ['image', '图片']
      ];
      const platforms = { douyin: '抖音', tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', x: 'X', bilibili: 'B 站', weibo: '微博' };
      const kind = { video: '视频', audio: '原声', image: '图片' };
      result.innerHTML = `<section class="guide-item"><header class="panel-heading"><div>${tag(platforms[media.platform] || '公开作品')} ${tag(kind[media.mediaType] || '作品')} ${tag(media.engine === 'f2' ? '抖音专用解析' : '通用解析')}</div><small>下载有效至 ${formatMailboxDate(media.expiresAt)}</small></header><h3>${esc(media.title)}</h3><p>${esc(media.author || '作者未公开')}${media.durationSeconds ? ` · ${esc(media.durationSeconds)} 秒` : ''}</p>${groups
        .map(([type, title]) => {
          const options = media.options.filter((row) => row.mediaType === type);
          return `<section class="form-section" aria-label="${title}"><div class="panel-heading"><h4>${title}</h4><small>${options.length} ${type === 'image' ? '张' : '项'}</small></div>${options.length ? options.map((row) => {
            const size = row.estimatedBytes ? `${(row.estimatedBytes / 1048576).toFixed(1)} MB` : '';
            const dimensions = row.width && row.height ? `${row.width} × ${row.height}` : '';
            const format = [row.extension?.toUpperCase(), dimensions, size].filter(Boolean).join(' · ');
            return `<div class="online-tool-download-option"><div><strong>${esc(row.label)}</strong><small>${esc(format)}</small></div>${button(`下载${title}`, 'ops-media-download', '', 'download', `data-token="${esc(row.downloadToken)}" data-expiry="${Date.parse(media.expiresAt)}"`)}</div>`;
          }).join('') : `<p class="footnote">此作品未提供可下载的${title}。</p>`}</section>`;
        }).join('')}<div data-media-download-status role="status"></div></section>`;
    } catch (error) {
      if (result.isConnected) result.textContent = error.message || '作品解析失败，请重试';
    } finally {
      submit.disabled = false;
    }
  }
  async function downloadOnlineMedia(node) {
    const result = node.closest('#ops-media-result');
    const status = result?.querySelector('[data-media-download-status]');
    if (!status || result.dataset.downloading) return;
    if (Number(node.dataset.expiry) <= Date.now()) {
      status.textContent = '下载凭证已过期，请重新解析作品';
      return;
    }
    const drawer = $('#drawer');
    const controls = [...result.querySelectorAll('button[data-action="ops-media-download"]')];
    const submit = $('#ops-media-resolver button[type="submit"]');
    const controller = new AbortController();
    const onClose = () => controller.abort();
    drawer.addEventListener('close', onClose, { once: true });
    result.dataset.downloading = 'yes';
    controls.forEach((control) => { control.disabled = true; });
    if (submit) submit.disabled = true;
    status.textContent = '正在准备文件';
    try {
      const response = await localData.downloadMedia(node.dataset.token, controller.signal);
      const reader = response.body.getReader();
      const total = Number(response.headers.get('content-length'));
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('文件超过 256 MB，无法下载');
        }
        chunks.push(value);
        if (total > 0) status.textContent = `正在下载 ${Math.min(99, Math.floor(size / total * 100))}%`;
      }
      if (controller.signal.aborted || !result.isConnected) return;
      const filename = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') || '')?.[1];
      const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename ? decodeURIComponent(filename) : '媒体文件';
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      status.textContent = '文件已交给浏览器保存';
    } catch (error) {
      if (!controller.signal.aborted && result.isConnected)
        status.textContent = error.message || '下载失败，请重试';
    } finally {
      drawer.removeEventListener('close', onClose);
      delete result.dataset.downloading;
      controls.forEach((control) => { control.disabled = false; });
      if (submit) submit.disabled = false;
    }
  }
  const managedMailReads = new WeakMap();
  function finishManagedMailRead(form, read = managedMailReads.get(form)) {
    if (!read || managedMailReads.get(form) !== read) return;
    managedMailReads.delete(form);
    read.finish();
    form.querySelector('[type="submit"]').disabled = false;
  }
  function openMailboxTools() {
    const pageMode = pluginPages[state.route]?.tool === '邮箱查询与邮箱池';
    const manage = isAdmin() && localData.authRequired;
    openToolDrawer(
      '邮箱查询与邮箱池',
      '查询由本系统验证，直接读取已授权的谷歌、苹果或微软邮箱。买家查询码与邮箱应用专用密码相互独立。邮件正文只在本次请求中返回，不写入服务器数据库或浏览器持久缓存。',
      `<section class="form-section" id="ops-mailbox-query-panel"${pageMode ? ' hidden' : ''}><form id="ops-managed-mail-query">${grid(
        wide(field('邮件查询码', 'ops-managed-query-code', `<div class="tool-input-row"><input type="password" id="ops-managed-query-code" name="ops-managed-query-code" maxlength="100" autocomplete="off" data-no-draft required placeholder="请输入邮件查询码">${button('一键粘贴', 'ops-tool-paste', '', 'copy', 'data-field="ops-managed-query-code"')}</div>`, true))
      )}<div class="tool-query-options"><div class="form-grid">${wide(field('返回封数', 'ops-managed-query-limit', input('ops-managed-query-limit', '5', 'type="number" min="1" max="20"'), true))}</div><div class="form-footer">
        ${button('清空', 'ops-tool-clear', '', '', 'data-field="ops-managed-query-code"')}
        <button type="submit" class="button primary">查询邮件</button>
      </div></div><p class="footnote">邮件内容仅在本次查询时实时读取，不保存邮件正文。</p><div class="toolbar" data-mail-refresh hidden>
        <label><input type="checkbox" data-mail-auto-refresh> 每 30 秒自动刷新</label>
        ${button('立即刷新', 'ops-mail-refresh')}
      </div><div class="design-async-region"><div id="ops-managed-query-progress" role="status" hidden></div><div id="ops-managed-query-results"></div></div></form></section>${manage ? `<section class="form-section" data-tool-panel id="ops-mailbox-pool"${pageMode ? '' : ' hidden'}><div class="form-section"><div class="mailbox-pool-toolbar"><div class="section-title-row"><h3>邮箱池</h3>${titleInfo('邮箱池', '按实际收信服务商绑定邮箱。谷歌与苹果使用应用专用密码，Microsoft 通过 OAuth 连接。验证成功后可复制买家查询码交付，买家持码即可查信。查询码到期后需手动重置并重新交付；停用后停止买家查询，授权失效时先更新授权。', 'mailbox-pool-help')}</div><div class="mailbox-pool-actions">${button('绑定邮箱', 'ops-mailbox-pool-add', 'primary', 'plus', 'aria-haspopup="dialog"')}${pageMode ? button('邮箱查询', 'ops-mailbox-query-open', '', 'search', 'aria-haspopup="dialog" aria-controls="drawer"') : ''}${button('批量导入', 'ops-mailbox-pool-batch', '', '', 'aria-haspopup="dialog"')}${button('更多', 'ops-mailbox-related', '', 'more', 'aria-label="邮箱池更多操作" aria-haspopup="menu"')}</div></div><form class="online-tool-mail-filters" id="ops-mailbox-pool-search-form" onsubmit="return false"><input type="search" id="ops-mailbox-pool-search" name="ops-mailbox-pool-search" aria-label="搜索邮箱池" placeholder="搜索邮箱或备注">
        ${select('ops-mailbox-filter-provider', [['', '全部类型'], ['google', '谷歌邮箱'], ['apple', '苹果云邮箱'], ['microsoft', '微软邮箱']]).replace('<select ', '<select aria-label="邮箱类型" ')}
        ${select('ops-mailbox-filter-status', [['', '全部状态'], ['pending', '待授权'], ['active', '可查询'], ['disabled', '已停用'], ['auth_failed', '授权失效'], ['expired', '查询码已过期']]).replace('<select ', '<select aria-label="邮箱状态" ')}
        ${button('刷新', 'ops-mailbox-pool-reload', '', 'return')}</form><div data-mailbox-pool-editor></div><div data-mailbox-pool-issued role="status"></div><div class="design-async-region"><div data-mailbox-pool-status role="status" hidden></div><div data-mailbox-pool-list></div></div></div></section>` : ''}`,
      '',
      pageMode ? [] : [['ops-mailbox-query-panel', '邮件查询'], ...(manage ? [['ops-mailbox-pool', '邮箱池管理']] : [])],
      pageMode && manage ? '' : `<div class="tool-query-actions">${pageMode ? button('邮箱查询', 'ops-mailbox-query-open', 'primary', 'search', 'aria-haspopup="dialog" aria-controls="drawer"') : ''}<a class="button" href="/mailbox-query" target="_blank" rel="noopener noreferrer">打开买家查询页</a></div>`
    );
    const form = $('#ops-managed-mail-query');
    const drawer = form.closest('[data-plugin-tool], dialog');
    const pool = $('#ops-mailbox-pool');
    pool?.querySelector('#mailbox-pool-help').insertAdjacentHTML('beforeend',
      `<div class="mailbox-setup-guides">${['google', 'apple', 'microsoft'].map(provider =>
        `<section><strong>${esc(mailboxProviders[provider])}</strong>${mailboxCredentialHelp(provider)}</section>`).join('')}</div>`);
    bindToolDraft($('#ops-mailbox-pool-search-form'), 'mailbox-pool-search');
    const filters = $('#ops-mailbox-pool-search-form');
    filters?.addEventListener('input', () => {
      const snapshot = mailboxPoolSnapshots.get(pool);
      if (snapshot) paintManagedPool(pool, snapshot, 1);
    });
    bindToolDraft(form, 'mailbox-query');

    const refresh = form.querySelector('[data-mail-refresh]');
    const autoRefresh = form.querySelector('[data-mail-auto-refresh]');
    const timer = window.setInterval(() => {
      if (!toolActive(form)) {
        window.clearInterval(timer);
        return;
      }
      if (!document.hidden && !form.closest('section').hidden && autoRefresh.checked)
        void queryManagedMail(form);
    }, 30_000);
    form.addEventListener('input', (event) => {
      if (!['ops-managed-query-code', 'ops-managed-query-limit'].includes(event.target.id)) return;
      finishManagedMailRead(form);
      refresh.hidden = true;
      autoRefresh.checked = false;
      const status = form.querySelector('#ops-managed-query-progress');
      status.textContent = '';
      status.hidden = true;
      mailQuerySnapshots.delete(form);
      form.querySelector('#ops-managed-query-results').replaceChildren();
    });
    const clear = (force = false) => {
      if (force !== true && toolActive(form)) return;
      drawer.removeEventListener('close', clear);
      window.clearInterval(timer);
      finishManagedMailRead(form);
      form.querySelector('#ops-managed-query-code').value = '';
      mailQuerySnapshots.delete(form);
      form.querySelector('#ops-managed-query-results').replaceChildren();
      pool?.querySelector('[data-mailbox-pool-list]')?.replaceChildren();
      pool?.querySelector('[data-mailbox-pool-issued]')?.replaceChildren();
      const secret = pool?.querySelector('#ops-managed-app-password');
      if (secret) secret.value = '';
    };
    drawer.addEventListener('close', clear);
    if (drawer.matches('[data-plugin-tool]')) pluginCleanup = () => clear(true);
    if (pageMode && pool) void loadManagedPool(pool);
  }
  const mailQuerySnapshots = new WeakMap();
  function mailBodyParts(body) {
    const parts = [];
    const safeLink = (value) => {
      try {
        const link = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(link.protocol) && !link.username && !link.password ? link.href : '';
      } catch { return ''; }
    };
    const appendText = (text) => {
      let start = 0;
      for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if (match.index > start) parts.push({ text: text.slice(start, match.index) });
        const url = match[0].replace(/[.,;!?，。；！？）)]+$/, '');
        parts.push({ text: url, href: safeLink(url) });
        start = match.index + url.length;
      }
      if (start < text.length) parts.push({ text: text.slice(start) });
    };
    if (!/<[a-z][\s\S]*>/i.test(body)) { appendText(body); return parts; }
    const template = document.createElement('template');
    template.innerHTML = body;
    template.content.querySelectorAll('script,style,noscript,iframe,object,embed,svg,canvas,form,input,button,video,audio,source,picture,img,link,meta').forEach(node => node.remove());
    const visit = (node) => {
      if (node.nodeType === 3) return appendText(node.textContent || '');
      if (node.nodeType !== 1) return;
      if (node.tagName === 'A') {
        const href = safeLink(node.getAttribute('href') || '');
        parts.push({ text: node.textContent || href, href }); return;
      }
      if (['BR', 'HR'].includes(node.tagName)) parts.push({ text: '\n' });
      node.childNodes.forEach(visit);
      if (node.matches('p,div,section,article,header,footer,li,tr,table,h1,h2,h3,h4,h5,h6')) parts.push({ text: '\n' });
    };
    template.content.childNodes.forEach(visit);
    return parts;
  }
  function renderManagedMail(form, selectedAlias = '') {
    const response = mailQuerySnapshots.get(form);
    if (!response) return;
    const result = form.querySelector('#ops-managed-query-results');
    const items = response.items || [];
    const aliases = [...new Map(items.filter(row => row.virtualEmailId).map(row => [String(row.virtualEmailId), row.aliasEmail || row.to || '未标注收件邮箱'])).entries()];
    const filtered = items.map((row, index) => ({ row, index })).filter(({row}) => !selectedAlias || String(row.virtualEmailId) === selectedAlias);
    const daysLeft = response.remainingDays ?? (Number.isFinite(Date.parse(response.codeExpiresAt)) ? Math.max(0, Math.ceil((Date.parse(response.codeExpiresAt) - Date.now()) / 86400000)) : null);
    const summary = [response.aliasEmail || response.primaryEmail || response.email, response.codeExpiresAt ? `查询码到期：${formatMailboxDate(response.codeExpiresAt)}` : '', daysLeft != null ? `剩余 ${daysLeft} 天` : ''].filter(Boolean).map(esc).join(' · ');
    result.innerHTML = `<div class="panel-heading"><h3>查询结果</h3><span>共 ${filtered.length} 封邮件</span></div>${summary ? `<p class="footnote">${summary}</p>` : ''}${response.targetType === 'VIRTUAL' ? '<p class="footnote">仅展示该虚拟邮箱最近 5 封邮件。</p>' : ''}${response.targetType === 'PRIMARY' && aliases.length ? grid(wide(field('筛选虚拟邮箱', 'ops-mail-alias-filter', select('ops-mail-alias-filter', [['', '全部邮箱'], ...aliases], selectedAlias)))) : ''}${filtered.length ? `<div class="guide-list">${filtered.map(({row,index}, position) => {
      const body = mailBodyParts(String(row.body || ''));
      return `<section class="guide-item"><details ${position === 0 ? 'open' : ''}><summary><strong>${esc(row.subject || '无主题')}</strong></summary><p>发件人：${esc(row.from || '—')}<br>收件人：${esc(row.to || '—')}<br>接收时间：${esc(formatMailboxDate(row.receivedAt || row.savedAt))}</p><div class="toolbar">${row.extractedCode ? `<strong>验证码 ${esc(row.extractedCode)}</strong>${button('一键复制', 'ops-mail-copy-code', '', 'copy', `data-index="${index}"`)}` : '<span>验证码未识别</span>'}${button('复制邮件正文', 'ops-mail-copy-body', '', 'copy', `data-index="${index}"`)}</div><pre class="mail-plain-body">${body.map(part => part.href ? `<a href="${esc(part.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(part.text)}</a>` : esc(part.text)).join('') || '（无正文）'}</pre></details></section>`;
    }).join('')}</div>` : empty('暂无邮件', '请稍后重新查询。')}`;
    result.querySelector('#ops-mail-alias-filter')?.addEventListener('change', event => renderManagedMail(form, event.target.value));
  }
  async function queryManagedMail(form) {
    const field = form.querySelector('#ops-managed-query-code');
    const result = form.querySelector('#ops-managed-query-results');
    const progress = form.querySelector('#ops-managed-query-progress');
    const submit = form.querySelector('[type="submit"]');
    const refresh = form.querySelector('[data-mail-refresh]');
    const code = field.value.trim();
    if (submit.disabled || !code) return;
    const limitField = form.querySelector('#ops-managed-query-limit');
    const limit = Number(limitField.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      setError(limitField.id, '返回封数须为 1 至 20');
      limitField.focus();
      return;
    }
    setError(limitField.id, '');
    const read = api.beginRegionRead(result.parentElement, progress, {
      loadingText: result.childElementCount ? '' : '正在查询邮件…',
      refreshButton: refresh.querySelector('[data-action="ops-mail-refresh"]')
    });
    managedMailReads.set(form, read);
    submit.disabled = true;
    try {
      const response = await localData.queryManagedMailbox(code, /^BUY-/i.test(code) ? 5 : limit);
      if (!read.current() || field.value.trim() !== code || Number(limitField.value) !== limit) return;
      const maximum = response.targetType === 'VIRTUAL' || /^BUY-/i.test(code) ? 5 : limit;
      mailQuerySnapshots.set(form, { ...response, items: response.items?.slice(0, maximum) || [] });
      renderManagedMail(form);
      refresh.hidden = false;
    } catch (error) {
      if (read.current() && field.value.trim() === code && Number(limitField.value) === limit) {
        finishManagedMailRead(form, read);
        progress.className = 'inline-notice warning';
        progress.innerHTML = `<span>${esc(error.message || '邮件读取失败，请重试。')}</span>`;
        progress.insertAdjacentHTML('beforeend', button('重试', 'ops-mail-retry'));
        progress.hidden = false;
        form.querySelector('[data-mail-auto-refresh]').checked = false;
      }
    } finally {
      finishManagedMailRead(form, read);
    }
  }
  const mailboxPoolSnapshots = new WeakMap();
  const mailboxProviders = { google: '谷歌邮箱', apple: '苹果云邮箱', microsoft: '微软邮箱', relay: '苹果隐藏邮箱' };
  const mailboxStatuses = { pending: '待授权', active: '可查询', disabled: '已停用', auth_failed: '授权失效', expired: '查询码已过期' };
  const mailboxDate = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23'
  });
  function formatMailboxDate(value) {
    return Number.isFinite(Date.parse(value)) ? mailboxDate.format(new Date(value)) : '—';
  }
  function paintManagedPool(panel, snapshot, requestedPage = getDraft('mailbox-pool-page').page || 1) {
    if (!toolActive(panel) || snapshot.version < Number(panel.dataset.version)) return;
    mailboxPoolSnapshots.set(panel, snapshot);
    panel.dataset.version = String(snapshot.version);
    panel.dataset.defaultValidDays = String(snapshot.defaultValidDays);
    const search = panel.querySelector('#ops-mailbox-pool-search').value.trim().toLowerCase();
    const provider = panel.querySelector('#ops-mailbox-filter-provider').value;
    const status = panel.querySelector('#ops-mailbox-filter-status').value;
    const statusFor = (row) => row.authorizationPending ? 'pending' : row.authFailed ? 'auth_failed' : !row.active ? 'disabled'
      : Date.parse(row.expiresAt) <= Date.now() ? 'expired' : 'active';
    const items = snapshot.items.filter((row) =>
      (!provider || row.provider === provider) && (!status || statusFor(row) === status) &&
      [row.email, row.label].some((value) => value?.toLowerCase().includes(search)));
    const draftSize = getDraft('mailbox-pool-page').pageSize;
    const pageSize = pageSizes.includes(draftSize) ? draftSize : defaultPageSize;
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(requestedPage)) || 1));
    state.drafts.set(draftKey('mailbox-pool-page'), { page, pageSize });
    const list = panel.querySelector('[data-mailbox-pool-list]');
    if (!items.length) {
      list.innerHTML = (snapshot.items.length ? empty('没有匹配的邮箱', '可调整邮箱类型、状态或搜索词。')
        : empty('邮箱池暂无记录', '添加并验证邮箱后会显示在这里。')) +
        renderPagination({ id: 'operations-mailbox-pool', page, pageSize, total: 0 });
      return;
    }
    list.innerHTML = `<p class="mailbox-table-hint">左右滑动可查看完整列表与操作</p><div class="table-viewport online-tool-mail-list" tabindex="0" role="region" aria-label="邮箱池列表，可横向滚动"><table class="mailbox-pool-table"><colgroup><col><col class="mailbox-column-meta"><col class="mailbox-column-meta"><col class="mailbox-column-source"><col class="mailbox-column-code"><col class="mailbox-column-status"><col class="mailbox-column-date"><col class="mailbox-column-date"><col></colgroup><thead><tr><th scope="col">邮箱账号</th><th scope="col">类型</th><th scope="col">备注</th><th scope="col">来源</th><th scope="col">买家查询码</th><th scope="col">状态</th><th scope="col">到期时间</th><th scope="col">最近查询</th><th class="table-actions" scope="col">操作</th></tr></thead><tbody>${items.slice((page - 1) * pageSize, page * pageSize).map(row => {
      const attrs = `data-id="${esc(row.id)}" data-active="${row.active}" data-provider="${esc(row.provider)}" data-email="${esc(row.email)}"`;
      const status = statusFor(row);
      const authorize = button('去授权', 'ops-mailbox-pool-authorize', '', '', attrs);
      const primary = row.authFailed ? button('更新授权', 'ops-mailbox-pool-authorize', '', '', attrs)
        : button('查询', 'ops-mailbox-pool-query', '', '', attrs + (status === 'active' ? '' : ` disabled title="${esc(mailboxStatuses[status])}"`));
      const actions = row.authorizationPending ? authorize : primary + button('更多', 'ops-mailbox-pool-more', 'mailbox-account__more', 'more', `${attrs} aria-label="更多操作：${esc(row.email)}" aria-haspopup="menu"`);
      return `<tr class="mailbox-account"><td><div class="mailbox-account__heading"><strong title="${esc(row.email)}">${esc(row.email)}</strong></div></td><td class="mailbox-account__text" title="${esc(mailboxProviders[row.provider] || '待选择')}">${esc(mailboxProviders[row.provider] || '待选择')}</td><td class="mailbox-account__text" title="${esc(row.label || '未填写备注')}">${esc(row.label || '—')}</td><td>${row.source === 'claude' ? 'Claude 账号' : '手工登记'}</td><td><div class="mailbox-account__code">${row.authorizationPending ? '<span>授权后生成</span>' : `<output data-mailbox-code="${esc(row.id)}">正在读取…</output>${button('复制', 'ops-mailbox-pool-copy-existing', '', '', attrs + ' disabled')}`}</div></td><td>${tag(mailboxStatuses[status], status === 'active' ? 'success' : status === 'disabled' ? '' : 'warning')}</td><td class="mailbox-account__date">${formatMailboxDate(row.expiresAt)}</td><td class="mailbox-account__date">${formatMailboxDate(row.lastQueriedAt)}</td><td class="table-actions"><div class="action-links mailbox-row-actions">${actions}</div></td></tr>`;
    }).join('')}</tbody></table></div>${renderPagination({ id: 'operations-mailbox-pool', page, pageSize, total: items.length })}`;
    void loadVisibleMailboxCodes(panel);
  }
  async function loadVisibleMailboxCodes(panel) {
    const outputs = [...panel.querySelectorAll('[data-mailbox-code]')];
    if (!outputs.length) return;
    const version = Number(panel.dataset.version);
    let codes, failure;
    try {
      const result = await localData.managedMailboxCodePage(outputs.map(output => output.dataset.mailboxCode), version);
      if (result?.version !== version || !Array.isArray(result.items)) throw new Error('查询码返回格式无效');
      codes = new Map(result.items.map(({ id, code }) => [id, code]));
    } catch (error) {
      failure = error;
    }
    if (!toolActive(panel) || Number(panel.dataset.version) !== version) return;
    for (const output of outputs) {
      if (!output.isConnected) continue;
      const copy = output.nextElementSibling;
      const code = codes?.get(output.dataset.mailboxCode);
      const unavailable = !failure && typeof code === 'string' && !code;
      output.textContent = code || (unavailable ? '未登记查询码' : '读取失败');
      output.title = code || (unavailable ? '未登记查询码' :
        failure?.status === 409 ? '邮箱池已更新，请刷新列表' : '读取失败，点击复制重试');
      copy.disabled = unavailable || [401, 403, 409].includes(failure?.status);
    }
  }
  async function copyManagedMailboxCode(panel, node) {
    if (node.disabled) return;
    node.disabled = true;
    try {
      const { code } = await localData.managedMailboxCode(node.dataset.id);
      if (!panel.closest('dialog[open], [data-plugin-tool]') || !node.isConnected) return;
      const output = node.closest('.mailbox-account')?.querySelector('[data-mailbox-code]');
      if (output) {
        output.textContent = code;
        output.title = code;
      }
      try {
        await navigator.clipboard.writeText(code);
        notify('查询码已复制');
      } catch {
        panel.querySelector('[data-mailbox-pool-issued]').innerHTML =
          `<div class="inline-notice">请手动复制查询码 <strong>${esc(code)}</strong></div>`;
      }
    } catch (error) {
      if (panel.closest('dialog[open], [data-plugin-tool]')) notify(error.message);
    } finally {
      node.disabled = false;
    }
  }
  async function loadManagedPool(panel, { refresh = false } = {}) {
    if (!panel) return;
    const scope = 'tools/mailbox-pool';
    const status = panel.querySelector('[data-mailbox-pool-status]');
    const read = api.beginRegionRead(status.parentElement, status, {
      loadingText: mailboxPoolSnapshots.has(panel) ? '' : '正在读取邮箱池…',
      refreshButton: panel.querySelector('[data-action="ops-mailbox-pool-reload"]')
    });
    try {
      const snapshot = localData.queries
        ? await localData.queries.read(scope, 'list', () => localData.managedMailboxPool(), { refresh })
        : await localData.managedMailboxPool();
      if (!read.current() || !toolActive(panel)) return;
      paintManagedPool(panel, snapshot);
      if (panel.isConnected && !mailboxOperation(panel) && !panel.querySelector('#ops-managed-pool-form')) {
        const view = getDraft('mailbox-tools-view');
        if (['create', 'credential', 'rotate'].includes(view.editor))
          editManagedPool(panel, view.editor, view.id || '');
        else if (['batch', 'settings'].includes(view.editor))
          editMailboxBatchOrSettings(panel, view.editor);
      }
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (read.current()) {
        if (error.status === 401 || error.status === 403) {
          panel.querySelector('[data-mailbox-pool-list]').replaceChildren();
          panel.querySelector('[data-mailbox-pool-editor]').replaceChildren();
          mailboxPoolSnapshots.delete(panel);
        }
        read.finish();
        status.hidden = false;
        status.className = 'inline-notice warning';
        status.textContent = error.message;
        status.insertAdjacentHTML('beforeend', button('重试', 'ops-mailbox-pool-reload'));
      }
      return false;
    } finally {
      read.finish();
    }
  }
  function mailboxCredentialHelp(provider, batch = false, update = false) {
    if (provider === 'microsoft') return `<div class="tool-field-guide mailbox-credential-guide"><ol>
      <li><a class="button mailbox-guide-link" href="https://outlook.live.com/mail/" target="_blank" rel="noopener noreferrer">打开 Outlook 设置邮箱</a>进入“设置 → 邮件 → 转发和 IMAP”，开启“允许设备和应用使用 IMAP”并保存。</li>
      <li>${batch ? '每行填写“邮箱----备注”，点击“开始逐个授权”，依次在弹出的 Microsoft 页面登录对应邮箱。' : '填写邮箱后点击“连接 Microsoft 并添加”。已有邮箱使用“重新授权”进入 Microsoft 登录页。'}</li>
      <li>核对登录邮箱及 Microsoft 显示的权限后完成授权，回到本页点击“核对并保存授权”。批量导入会自动核对并继续下一条。</li>
      </ol><p>Microsoft 授权包含邮箱身份信息、IMAP 邮箱访问和保持授权；本系统以只读方式取信。授权窗口被拦截时，允许本网站弹窗后重试。取消或授权失效时可重新发起授权。</p>
      <a href="https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com" target="_blank" rel="noopener noreferrer">查看 Microsoft 官方步骤</a></div>`;
    if (provider === 'apple') return `<div class="tool-field-guide mailbox-credential-guide"><ol>
      <li><a class="button mailbox-guide-link" href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">打开 Apple 账户设置</a>登录实际收信邮箱对应的 Apple 账户，并开启双重认证。</li>
      <li>进入“登录和安全 → App 专用密码”，生成用于本系统的专用密码。</li>
      <li>${batch ? '按“邮箱----应用专用密码----备注”逐行填写 iCloud 收信资料，点击“验证并导入”，核对每行结果。' : update ? '返回本页核对当前邮箱，粘贴新生成的密码，点击“验证并更新”。' : '复制生成的密码，返回本页填写 iCloud 收信地址和应用专用密码，点击“验证并添加”。'}</li>
      </ol><p>请勿填写 Apple 账户登录密码。Apple ID 的登录地址可能与 iCloud 收信地址不同。更改账户主密码后，需要重新生成应用专用密码，再通过“更多 → 更新授权”保存。</p>
      <a href="https://support.apple.com/zh-cn/102654" target="_blank" rel="noopener noreferrer">查看 Apple 官方步骤</a></div>`;
    return `<div class="tool-field-guide mailbox-credential-guide"><ol>
      <li><a class="button mailbox-guide-link" href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noopener noreferrer">前往 Google 开启两步验证</a>登录准备绑定的谷歌邮箱并完成设置。</li>
      <li><a class="button mailbox-guide-link" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">前往 Google 生成应用专用密码</a>按页面提示创建用于本系统的 16 位密码。</li>
      <li>${batch ? '按“邮箱----应用专用密码----备注”逐行填写资料，点击“验证并导入”，核对每行结果。' : update ? '返回本页核对当前邮箱，粘贴新生成的密码，点击“验证并更新”。' : '复制生成的密码，返回本页填写同一邮箱地址和应用专用密码，点击“验证并添加”。'}</li>
      </ol><p>请勿填写 Gmail 登录密码。个人 Gmail 的 IMAP 已默认启用。找不到应用专用密码入口时，先确认两步验证已开启；公司或学校账户请询问管理员。仅使用安全密钥或启用高级保护的账户可能不支持，请按下方官方说明核对。更改账户主密码后，需要生成新密码并更新授权。</p>
      <a href="https://support.google.com/accounts/answer/185833?hl=zh-Hans" target="_blank" rel="noopener noreferrer">查看 Google 官方步骤</a>
      <a href="https://support.google.com/mail/answer/7126229?hl=zh-Hans" target="_blank" rel="noopener noreferrer">查看 Gmail IMAP 说明</a></div>`;
  }
  const mailboxOperationPanels = new WeakMap();
  function mailboxOperation(panel) {
    const root = $('#drawer[open] [data-mailbox-operation]');
    return root && mailboxOperationPanels.get(root) === panel ? root : null;
  }
  function mailboxIssued(panel) {
    return (mailboxOperation(panel) || panel).querySelector('[data-mailbox-pool-issued]');
  }
  function mailboxOperationIdentity(row) {
    if (!row) return '';
    const status = row.authorizationPending ? 'pending' : row.authFailed ? 'auth_failed' : !row.active ? 'disabled'
      : Date.parse(row.expiresAt) <= Date.now() ? 'expired' : 'active';
    return `<section class="mailbox-operation-summary" aria-label="当前邮箱"><strong>${esc(row.email)}</strong><div class="mailbox-operation-meta"><span>${esc(mailboxProviders[row.provider] || '待选择服务商')}</span>${tag(mailboxStatuses[status], status === 'active' ? 'success' : status === 'disabled' ? '' : 'warning')}${row.label ? `<span>${esc(row.label)}</span>` : ''}</div></section>`;
  }
  function onMailboxOperationClose(root, cleanup) {
    const dialog = $('#drawer');
    const detach = () => {
      dialog.removeEventListener('id-view-deactivate', deactivate);
      dialog.removeEventListener('close', closed);
    };
    const deactivate = () => {
      detach();
      if (dialog.querySelector('[data-mailbox-operation]') === root) cleanup();
    };
    const closed = () => {
      if (dialog.open) {
        if (dialog.querySelector('[data-mailbox-operation]') !== root) detach();
        return;
      }
      detach();
      cleanup();
    };
    dialog.addEventListener('id-view-deactivate', deactivate);
    dialog.addEventListener('close', closed);
  }
  function openMailboxOperation(panel, kind, title, row, body, footer, key = '') {
    preserveDraft();
    const descriptions = {
      create: '选择实际收信服务商，按字段右侧说明完成授权。验证成功后复制查询码交付买家。',
      credential: '生成新的应用专用密码后在这里验证并保存。现有买家查询码继续使用。',
      batch: '每批可导入 1 至 50 个邮箱。按服务商准备资料，提交后核对每行结果。失败行可修正后重新导入。',
      settings: '设置以后生成查询码的有效天数。同步现有码会从本次保存时间重新计算到期时间。',
      rotate: '重置后旧查询码立即失效，请复制并重新交付新码。',
      query: '按查询码读取邮件。验证码和正文仅在当前查询中展示。'
    };
    const identity = mailboxOperationIdentity(row);
    openDrawer(title, descriptions[kind] || '', `<section data-mailbox-operation="${esc(kind)}">${identity}<div data-mailbox-pool-editor>${body}</div><div data-mailbox-pool-issued role="status"></div></section>`, footer, key, { kind: 'mailbox-operation' });
    const root = $('#drawer [data-mailbox-operation]');
    mailboxOperationPanels.set(root, panel);
    root.dataset.mailboxId = row?.id || '';
    onMailboxOperationClose(root, () => {
      for (const secret of root.querySelectorAll('[data-no-draft]')) secret.value = '';
      const view = getDraft('mailbox-tools-view');
      if (view.editor === kind && view.id === (row?.id || ''))
        state.drafts.set(draftKey('mailbox-tools-view'), { tab: 'manage' });
    });
    return root;
  }
  function openMailboxAuthorization(panel, row) {
    if (!row) return;
    if (panel.closest('dialog')) return startMicrosoftMailbox(panel, { id: row.id, email: row.email, version: Number(panel.dataset.version) });
    const root = openMailboxOperation(panel, 'oauth', 'Microsoft 邮箱授权', row,
      `<section class="form-section"><div class="section-title-row"><h3>连接邮箱</h3>${titleInfo('连接邮箱', mailboxCredentialHelp('microsoft'), 'mailbox-operation-oauth-help', true)}</div></section>`,
      button('关闭', 'drawer-close') + button('前往 Microsoft 授权', 'ops-mailbox-pool-oauth-start', 'primary', '', `data-id="${esc(row.id)}"`));
    return root;
  }
  const mailboxQueryHosts = new WeakMap();
  function openMailboxQueryDrawer(panel, row) {
    const form = $('#ops-managed-mail-query');
    const host = mailboxQueryHosts.get(form) || form.parentElement;
    mailboxQueryHosts.set(form, host);
    const root = openMailboxOperation(panel, 'query', row ? '查询邮箱邮件' : '邮箱查询', row,
      '<div data-mailbox-query-slot></div>', button('关闭', 'drawer-close'));
    root.querySelector('[data-mailbox-query-slot]').append(form);
    form.querySelector('#ops-managed-query-code').closest('.field').parentElement.hidden = Boolean(row);
    form.querySelector('[data-action="ops-tool-clear"]').hidden = Boolean(row);
    onMailboxOperationClose(root, () => {
      finishManagedMailRead(form);
      form.querySelector('#ops-managed-query-code').value = '';
      form.querySelector('#ops-managed-query-code').closest('.field').parentElement.hidden = false;
      form.querySelector('[data-action="ops-tool-clear"]').hidden = false;
      form.querySelector('[type="submit"]').disabled = false;
      form.querySelector('[data-mail-auto-refresh]').checked = false;
      form.querySelector('[data-mail-refresh]').hidden = true;
      form.querySelector('#ops-managed-query-progress').hidden = true;
      form.querySelector('#ops-managed-query-results').replaceChildren();
      mailQuerySnapshots.delete(form);
      if (host.isConnected) host.append(form);
    });
    return root;
  }
  async function openMailboxPoolQuery(panel, id) {
    const row = mailboxPoolSnapshots.get(panel)?.items.find(item => item.id === id);
    if (!row) return;
    const form = $('#ops-managed-mail-query');
    const inDrawer = Boolean(panel.closest('dialog'));
    if (inDrawer) selectToolSection('ops-mailbox-query-panel');
    let root = mailboxOperation(panel);
    if (!inDrawer && (!root || root.dataset.mailboxOperation !== 'query' || root.dataset.mailboxId !== id))
      root = openMailboxQueryDrawer(panel, row);
    const current = root;
    const field = form.querySelector('#ops-managed-query-code');
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const progress = form.querySelector('#ops-managed-query-progress');
    const read = api.beginRegionRead(progress.parentElement, progress, { loadingText: '正在读取查询资料…' });
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const { code } = await localData.managedMailboxCode(id);
      if (!read.current() || (!inDrawer && mailboxOperation(panel) !== current)) return;
      read.finish();
      submit.disabled = false;
      field.value = code;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await queryManagedMail(form);
    } catch (error) {
      if (read.current()) {
        read.finish();
        progress.className = 'inline-notice warning';
        progress.innerHTML = `<span>${esc(error.message || '查询资料读取失败')}</span>${button('重试', 'ops-mailbox-pool-query', '', '', `data-id="${esc(id)}"`)}`;
        progress.hidden = false;
      }
    } finally {
      read.finish();
      if (inDrawer || mailboxOperation(panel) === current) submit.disabled = false;
    }
  }
  function editManagedPool(panel, action, id = '') {
    if (panel.dataset.version === undefined) return;
    preserveDraft();
    state.drafts.set(draftKey('mailbox-tools-view'), { tab: 'manage', editor: action, id });
    panel.querySelector('[data-mailbox-pool-issued]').replaceChildren();
    const row = mailboxPoolSnapshots.get(panel)?.items.find((item) => item.id === id);
    const newFields = action === 'create' ? wide(field('收信服务商', 'ops-managed-provider',
      select('ops-managed-provider', [['', '选择实际收信服务商'], ['google', '谷歌邮箱'], ['apple', '苹果云邮箱'], ['microsoft', '微软邮箱']], row ? row.provider : 'google'), true,
      '<div data-mailbox-provider-help>按实际收信服务商选择。Apple ID 登录邮箱不一定是 iCloud 收信邮箱。</div>')) +
      field('邮箱地址', 'ops-managed-email', input('ops-managed-email', row?.email || '', `${row ? 'readonly ' : ''}type="email" maxlength="254" placeholder="例如 name@gmail.com"`), true) +
      field('备注', 'ops-managed-label', input('ops-managed-label', '', 'maxlength="60" placeholder="例如：客户 A"')) : '';
    const password = action !== 'rotate' ? wide(field('应用专用密码', 'ops-managed-app-password',
      '<input type="password" id="ops-managed-app-password" name="ops-managed-app-password" autocomplete="new-password" maxlength="256" data-no-draft>', true,
      `<div data-mailbox-credential-help>${mailboxCredentialHelp(row?.provider || 'google', false, action === 'credential')}</div>`)) : '';
    const days = action !== 'credential' ? field('查询码有效期', 'ops-managed-days',
      input('ops-managed-days', panel.dataset.defaultValidDays || '7', 'type="number" min="1" max="365"'), true, '填写 1 至 365 天。有效期从生成查询码时开始，到期后停止买家查询。需要继续使用时，通过“更多 → 重置查询码”生成并交付新码。') : '';
    const label = action === 'rotate' ? '重置并生成新码' : action === 'credential' ? '验证并更新' : '验证并添加';
    const markup = `<form id="ops-managed-pool-form" class="mailbox-pool-form" novalidate><input type="hidden" name="ops-managed-action" value="${action}"><input type="hidden" name="ops-managed-id" value="${esc(id)}"><input type="hidden" name="ops-managed-version" value="${esc(panel.dataset.version)}">${action === 'rotate' ? '<div class="inline-notice warning">生成新码后旧查询码立即失效，请将新码重新交付买家。</div>' : ''}${row && panel.closest('dialog') ? `<p>当前邮箱 <strong>${esc(row.email)}</strong></p>` : ''}${grid(newFields + password + days)}<div class="form-footer">${button('取消', 'ops-mailbox-pool-cancel')}<button type="submit" class="button primary">${label}</button></div></form>`;
    const drawerMode = !panel.closest('dialog');
    let surface = panel;
    if (drawerMode) {
      const titles = { create: '绑定邮箱', credential: '更新邮箱授权', rotate: '重置查询码' };
      surface = openMailboxOperation(panel, action, titles[action], row, markup,
        button('取消', 'ops-mailbox-pool-cancel') + `<button type="submit" form="ops-managed-pool-form" class="button primary">${label}</button>`, draftKey(`mailbox-pool:${action}:${id || 'new'}`));
      surface.querySelector('.form-footer').hidden = true;
    } else panel.querySelector('[data-mailbox-pool-editor]').innerHTML = markup;
    bindToolDraft(surface.querySelector('#ops-managed-pool-form'), `mailbox-pool:${action}:${id || 'new'}`);
    if (row && action === 'create') surface.querySelector('#ops-managed-email').value = row.email;
    const provider = surface.querySelector('#ops-managed-provider');
    provider?.addEventListener('change', () => {
      const credential = surface.querySelector('#ops-managed-app-password');
      const microsoft = provider.value === 'microsoft';
      if (credential) {
        credential.value = '';
        credential.closest('.field').hidden = microsoft;
        credential.placeholder = provider.value === 'apple' ? '输入 Apple 生成的应用专用密码' : '输入 Google 生成的 16 位应用专用密码';
      }
      surface.querySelector('[data-mailbox-credential-help]').innerHTML = microsoft ? '' : mailboxCredentialHelp(provider.value);
      surface.querySelector('[data-mailbox-provider-help]').innerHTML = microsoft ? mailboxCredentialHelp('microsoft')
        : '按实际收信服务商选择。Apple ID 登录邮箱不一定是 iCloud 收信邮箱。应用专用密码右侧的说明提供设置步骤和直达链接。';
      for (const submit of surface.closest('dialog')?.querySelectorAll('[type="submit"][form="ops-managed-pool-form"]') || []) submit.textContent = microsoft ? '连接 Microsoft 并添加' : '验证并添加';
      surface.querySelector('[type="submit"]').textContent = microsoft ? '连接 Microsoft 并添加' : '验证并添加';
    });
    provider?.dispatchEvent(new Event('change'));
    surface.querySelector('#ops-managed-pool-form').scrollIntoView({ block: 'nearest' });
  }
  function editMailboxBatchOrSettings(panel, action) {
    if (panel.dataset.version === undefined) return;
    preserveDraft();
    state.drafts.set(draftKey('mailbox-tools-view'), { tab: 'manage', editor: action, id: '' });
    panel.querySelector('[data-mailbox-pool-issued]').replaceChildren();
    const fields = action === 'batch'
      ? wide(field('收信服务商', 'ops-managed-batch-provider',
          select('ops-managed-batch-provider', [['google', '谷歌邮箱'], ['apple', '苹果云邮箱'], ['microsoft', '微软邮箱']], 'google'), true,
          `<div data-mailbox-batch-help>${mailboxCredentialHelp('google', true)}</div>`)) +
        wide(field('邮箱数据', 'ops-managed-batch', '<textarea id="ops-managed-batch" name="ops-managed-batch" maxlength="16000" rows="6" autocomplete="off" data-no-draft></textarea>', true,
          '每行一条，每批 1 至 50 条。谷歌或苹果用“邮箱----应用专用密码----备注”，微软用“邮箱----备注”。也支持竖线分隔。提交后核对逐行结果，失败行修正后重新导入。'))
      : field('默认有效期', 'ops-managed-days', input('ops-managed-days', panel.dataset.defaultValidDays, 'type="number" min="1" max="365"'), true,
        '填写 1 至 365 天，用于以后生成的查询码；到期时间以北京时间显示。') +
        wide(field('同步现有查询码', 'ops-managed-apply-existing',
          '<label class="checkbox-label"><input type="checkbox" id="ops-managed-apply-existing" name="ops-managed-apply-existing" value="on"> <span>统一重算现有查询码到期时间</span></label>', false,
          '勾选后从保存时间重新计算所有现有码的到期时间，查询码本身不更换；不勾选则仅影响以后生成的新码。'));
    const label = action === 'batch' ? '验证并导入' : '保存设置';
    const markup = `<form id="ops-managed-pool-form" class="mailbox-pool-form" novalidate><input type="hidden" name="ops-managed-action" value="${action}"><input type="hidden" name="ops-managed-version" value="${esc(panel.dataset.version)}">${grid(fields)}<div class="form-footer">${button('取消', 'ops-mailbox-pool-cancel')}<button type="submit" class="button primary">${label}</button></div></form>`;
    let surface = panel;
    if (panel.closest('dialog')) panel.querySelector('[data-mailbox-pool-editor]').innerHTML = markup;
    else {
      surface = openMailboxOperation(panel, action, action === 'batch' ? '批量导入邮箱' : '查询码设置', null, markup,
        button('取消', 'ops-mailbox-pool-cancel') + `<button type="submit" form="ops-managed-pool-form" class="button primary">${label}</button>`, draftKey(`mailbox-pool:${action}:new`));
      surface.querySelector('.form-footer').hidden = true;
    }
    bindToolDraft(surface.querySelector('#ops-managed-pool-form'), `mailbox-pool:${action}:new`);
    const provider = surface.querySelector('#ops-managed-batch-provider');
    const updateGuide = () => {
      surface.querySelector('[data-mailbox-batch-help]').innerHTML = mailboxCredentialHelp(provider.value, true);
      const text = provider.value === 'microsoft' ? '开始逐个授权' : label;
      surface.querySelector('[type="submit"]').textContent = text;
      const footer = surface.closest('dialog')?.querySelector('[type="submit"][form="ops-managed-pool-form"]');
      if (footer) footer.textContent = text;
    };
    provider?.addEventListener('change', updateGuide);
    if (provider) updateGuide();
    surface.querySelector('#ops-managed-pool-form').scrollIntoView({ block: 'nearest' });
  }
  async function saveManagedPool(panel, body, receivedSnapshot, submission) {
    const operation = mailboxOperation(panel);
    try {
      const snapshot = receivedSnapshot || await localData.saveManagedMailboxPool(body);
      const unchanged = finishToolSubmission(submission, 'ops-managed-version', snapshot.version);
      if (submission && !state.drafts.has(submission.key)) {
        const view = getDraft('mailbox-tools-view');
        const viewKey = draftKey(`mailbox-pool:${view.editor}:${view.id || 'new'}`);
        if (viewKey === submission.key) state.drafts.set(draftKey('mailbox-tools-view'), { tab: view.tab });
      }
      if (!panel.isConnected) return;
      paintManagedPool(panel, snapshot);
      if (operation && mailboxOperation(panel) !== operation) return;
      const operationCurrent = operation && mailboxOperation(panel) === operation && (!submission || unchanged);
      if (unchanged || operationCurrent) (operationCurrent ? operation : panel).querySelector('[data-mailbox-pool-editor]').replaceChildren();
      if (operationCurrent) $('#drawer .drawer-footer').innerHTML = button('关闭', 'drawer-close');
      const issued = operation && mailboxOperation(panel) === operation ? operation.querySelector('[data-mailbox-pool-issued]') : panel.querySelector('[data-mailbox-pool-issued]');
      issued.innerHTML = snapshot.issuedCode
        ? `<div class="inline-notice">本次查询码 <strong>${esc(snapshot.issuedCode)}</strong> ${button('复制查询码', 'ops-mailbox-pool-copy', '', 'copy', `data-code="${esc(snapshot.issuedCode)}"`)}</div>`
        : '';
      if (snapshot.batch) issued.innerHTML = `<div class="guide-list">${snapshot.batch.map((row) =>
        `<div class="guide-item">第 ${row.line} 行：${row.success
          ? `<strong>${esc(row.issuedCode)}</strong> ${button('复制查询码', 'ops-mailbox-pool-copy', '', '', `data-code="${esc(row.issuedCode)}"`)}`
          : esc(row.error)}</div>`).join('')}</div>`;
      if (operationCurrent) {
        const row = snapshot.items?.find(row => row.id === operation.dataset.mailboxId);
        const identity = operation.querySelector('.mailbox-operation-summary');
        if (row && identity) identity.outerHTML = mailboxOperationIdentity(row);
        if (!issued.childElementCount) issued.innerHTML = `<div class="inline-notice success">${snapshot.updatedExistingCount === undefined ? '邮箱资料已保存。' : `已同步 ${snapshot.updatedExistingCount} 个查询码的到期时间。`}</div>`;
      } else notify(snapshot.batch ? '批量结果已列出' : snapshot.updatedExistingCount === undefined
        ? '邮箱池资料已保存' : `已同步 ${snapshot.updatedExistingCount} 个查询码的到期时间`);
    } catch (error) {
      if (operation && mailboxOperation(panel) === operation)
        operation.querySelector('[data-mailbox-pool-issued]').innerHTML = `<div class="inline-notice warning" role="alert">${esc(error.message || '保存失败，请重试')}</div>`;
      else if (panel.isConnected) notify(error.message);
      if (error.status === 409 && await loadManagedPool(panel, { refresh: true })) {
        if (submission?.form.isConnected && (!operation || mailboxOperation(panel) === operation)) {
          submission.form.elements['ops-managed-version'].value = panel.dataset.version;
          state.drafts.set(submission.key, readDraft(submission.form));
        }
      }
    }
  }
  async function authorizeMicrosoftBatch(panel, items, submission) {
    const operation = mailboxOperation(panel);
    const popup = window.open('about:blank', '_blank');
    if (!popup) return notify('请允许弹出授权窗口后重试');
    popup.opener = null;
    const status = mailboxIssued(panel);
    const active = () => toolActive(submission.form) && (!operation || mailboxOperation(panel) === operation);
    if (operation) onMailboxOperationClose(operation, () => popup.close());
    let snapshot = mailboxPoolSnapshots.get(panel);
    const batch = [];
    try {
      for (const [index, item] of items.entries()) {
        if (!active() || popup.closed) break;
        status.textContent = `正在授权第 ${index + 1} / ${items.length} 个微软邮箱`;
        try {
          const authorization = await localData.startMicrosoftMailbox({
            email: item.email, label: item.label, version: snapshot.version, validDays: snapshot.defaultValidDays
          });
          if (!active() || popup.closed) break;
          popup.location.replace(authorization.authorizationUrl);
          const deadline = Date.now() + 600_000;
          let result;
          while (active() && Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
            if (!active()) break;
            result = await localData.finishMicrosoftMailbox(authorization.authorizationId);
            if (result.status === 'saved') paintManagedPool(panel, result);
            if (result.status === 'saved' || popup.closed) break;
          }
          if (result?.status !== 'saved') throw new Error('本次授权未完成');
          snapshot = result;
          batch.push({ line: index + 1, success: true, issuedCode: result.issuedCode });
        } catch (error) {
          batch.push({ line: index + 1, success: false, error: error.message });
          if ([409, 503].includes(error.status)) break;
        }
      }
      if (!active()) return;
      for (let index = batch.length; index < items.length; index++)
        batch.push({ line: index + 1, success: false, error: '未执行授权，请重新提交此行' });
      await saveManagedPool(panel, null, { ...snapshot, issuedCode: undefined, batch }, submission);
    } finally {
      if (!popup.closed) popup.close();
    }
  }
  const microsoftSubmissions = new WeakMap();
  async function startMicrosoftMailbox(panel, data, submission) {
    const operation = mailboxOperation(panel);
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      notify('请允许弹出授权窗口后重试');
      return;
    }
    popup.opener = null;
    if (operation) onMailboxOperationClose(operation, () => popup.close());
    const result = mailboxIssued(panel);
    try {
      const authorization = await localData.startMicrosoftMailbox(data);
      if (!panel.isConnected || (operation && mailboxOperation(panel) !== operation)) {
        popup.close();
        return;
      }
      popup.location.replace(authorization.authorizationUrl);
      microsoftSubmissions.set(panel, { id: authorization.authorizationId, submission });
      result.innerHTML = `<div class="inline-notice">请在 Microsoft 窗口完成授权后回来保存。 ${button('核对并保存授权', 'ops-mailbox-pool-microsoft-finish', '', '', `data-id="${esc(authorization.authorizationId)}"`)}</div>`;
    } catch (error) {
      popup.close();
      if (panel.isConnected) notify(error.message);
    }
  }
  async function finishMicrosoftMailbox(panel, node) {
    if (node.disabled) return;
    node.disabled = true;
    const operation = mailboxOperation(panel);
    try {
      const result = await localData.finishMicrosoftMailbox(node.dataset.id);
      if (!panel.isConnected || (operation && mailboxOperation(panel) !== operation)) return;
      if (result.status === 'pending') notify('授权正在处理，请确认 Microsoft 窗口后重试');
      else {
        const pending = microsoftSubmissions.get(panel);
        void saveManagedPool(panel, null, result,
          pending?.id === node.dataset.id ? pending.submission : null);
        microsoftSubmissions.delete(panel);
      }
    } catch (error) {
      if (panel.isConnected) notify(error.message);
      if (error.status === 409) void loadManagedPool(panel, { refresh: true });
    } finally {
      node.disabled = false;
    }
  }
  function openOnlineTool(name) {
    if (localData && name === '计算 2FA 验证码') {
      openTotp();
      return;
    }
    if (localData && name === '抖音解析') {
      openMediaResolver();
      return;
    }
    if (localData && name === '网站监控') {
      openWebsiteMonitor();
      return;
    }
    if (localData && name === '邮箱查询与邮箱池') {
      openMailboxTools();
      return;
    }
    local.toolName = name;
    local.toolResult = null;
    let fields;
    if (name === '计算 2FA 验证码')
      fields = wide(
        field(
          '演示密钥',
          'ops-tool-secret',
          '<input id="ops-tool-secret" name="ops-tool-secret" value="DEMO-KEY-ONLY" autocomplete="off" data-no-draft />',
          true,
          '不输入真实密钥。此设计只显示无效的模拟验证码。'
        )
      );
    else if (name === '网站监控')
      fields =
        wide(
          field(
            '网站地址',
            'ops-tool-url',
            input('ops-tool-url', 'https://example.test', 'placeholder="https://example.test"'),
            true
          )
        ) +
        field(
          '模拟结果',
          'ops-tool-outcome',
          select('ops-tool-outcome', ['可用', '超时', '不可达'])
        );
    else if (name === '抖音解析')
      fields = wide(
        field(
          '视频链接',
          'ops-tool-url',
          input(
            'ops-tool-url',
            'https://www.douyin.com/video/DEMO',
            'placeholder="粘贴演示视频链接"'
          ),
          true
        )
      );
    else if (name === '邮箱查询与邮箱池')
      fields =
        field(
          '邮箱来源',
          'ops-tool-mail-type',
          select(
            'ops-tool-mail-type',
            mailboxTypes
              .filter((row) => row.enabled && row.id !== 'apple')
              .map((row) => [row.id, row.label])
          )
        ) +
        wide(
          field('邮箱账号', 'ops-tool-email', input('ops-tool-email', 'mail@example.test'), true)
        ) +
        field(
          '演示查询码',
          'ops-tool-query-code',
          '<input id="ops-tool-query-code" name="ops-tool-query-code" value="DEMO-QUERY" autocomplete="off" data-no-draft />',
          true
        ) +
        field(
          '模拟结果',
          'ops-tool-outcome',
          select('ops-tool-outcome', ['有邮件', '无邮件', '取信失败'])
        );
    else return;
    openToolDrawer(
      name,
      '保留现有功能的操作结构。所有结果均为模拟，不查询网站、邮箱或执行外部同步。',
      `<form id="ops-online-tool-form" novalidate><input type="hidden" name="ops-tool-name-key" value="${esc(name)}" />${grid(fields)}<div class="form-footer"><button type="submit" class="button primary">查看模拟结果</button></div></form><div id="ops-online-tool-result"></div>`,
      draftKey(`online-tool:${name}`)
    );
    bindToolDraft($('#ops-online-tool-form'), `online-tool:${name}`);
  }
  const websiteVisitQueries = new WeakMap();
  async function refreshWebsiteReport(result, status, label, load, renderReport, { scope, key, refresh = false } = {}) {
    const entry = scope && localData.queries?.peek(scope, key);
    const cached = entry?.data === undefined ? undefined : entry;
    if (cached) result.innerHTML = renderReport(cached.data);
    if (cached && !cached.stale && !refresh) {
      api.finishRegionRead(result.parentElement);
      status.hidden = true;
      status.textContent = '';
      return;
    }
    const hasResult = result.hasChildNodes();
    const read = api.beginRegionRead(result.parentElement, status, {
      loadingText: hasResult ? '' : `正在读取${label}…`,
      refreshButton: result.closest('.form-section').querySelector('[data-async-refresh]')
    });
    const dialog = result.closest('dialog, [data-plugin-tool]');
    const cancelClosedRead = () => {
      if (scope && localData.queries?.peek(scope, key)?.pending) localData.queries.invalidate(scope);
      read.finish();
    };
    const closedDialog = () => { if (!dialog.open) cancelClosedRead(); };
    dialog?.addEventListener('id-view-deactivate', cancelClosedRead, { once: true });
    dialog?.addEventListener('close', closedDialog, { once: true });
    try {
      const report = scope && localData.queries
        ? await localData.queries.read(scope, key, load, { refresh }) : await load();
      if (!read.current()) return;
      result.innerHTML = renderReport(report);
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (!read.current()) return;
      if (error.status === 401 || error.status === 403) {
        result.replaceChildren();
        if (scope) localData.queries?.invalidate(scope);
      }
      read.finish();
      status.className = 'inline-notice warning';
      status.textContent = `读取${label}失败。${result.hasChildNodes() ? '已保留上次结果。' : ''}${error?.message || '请稍后重试。'}`;
      status.hidden = false;
    } finally {
      dialog?.removeEventListener('id-view-deactivate', cancelClosedRead);
      dialog?.removeEventListener('close', closedDialog);
      read.finish();
    }
  }
  function websiteToolHeader(title, actions, help = '') {
    const heading = `<h3>${esc(title)}</h3>`;
    return `<div class="tool-panel-header">${help ? `<div class="section-title-row">${heading}${help}</div>` : heading}<div class="tool-panel-actions" data-page-actions>${actions}</div></div>`;
  }
  function websiteMetrics(items) {
    return `<div class="tool-metrics${items.length === 2 ? ' tool-metrics--two' : ''}">${items.map(([label, amount]) =>
      `<div class="tool-metric"><span>${esc(label)}</span><strong>${amount}</strong></div>`).join('')}</div>`;
  }
  function websiteVisitsPanel() {
    const title = '访问记录与访客 IP';
    const actions = button('刷新记录', 'ops-website-visit-refresh', '', 'return', 'data-async-refresh') +
      '<button type="submit" class="button primary">查询明细</button>';
    const help = titleInfo(title, '这里显示 flashcast.com.my 装修站的签名采集记录。', 'website-visits-help');
    return `<section class="form-section website-tool-panel" id="ops-website-visits"><form id="ops-website-visits-form" novalidate>${websiteToolHeader(title, actions, help)}${grid(
      field(
        '最近天数',
        'ops-visits-days',
        select(
          'ops-visits-days',
          [
            ['7', '最近 7 天'],
            ['30', '最近 30 天']
          ],
          '7'
        )
      ) +
        field(
          '排序',
          'ops-visits-sort',
          select(
            'ops-visits-sort',
            [
              ['newest', '最新优先'],
              ['oldest', '最早优先']
            ],
            'newest'
          )
        ) +
        field(
          'IP 地址',
          'ops-visits-ip',
          input('ops-visits-ip', '', 'maxlength="45" autocomplete="off" data-no-draft'),
          false,
          '可选，按完整 IP 精确查找。'
        )
    ).replace('class="form-grid"', 'class="form-grid tool-filter-grid"')}</form><div class="design-async-region" aria-busy="false"><div data-visits-status role="status" hidden></div><div data-visits-result></div></div></section>`;
  }
  async function showWebsiteVisits(form, paging, { refresh = false } = {}) {
    if (!form) return;
    const panel = form.closest('#ops-website-visits');
    if (!panel) return;
    const output = panel.querySelector('[data-visits-result]');
    const status = panel.querySelector('[data-visits-status]');
    let query;
    if (paging) {
      const previous = websiteVisitQueries.get(output);
      if (!previous) return;
      query = { ...previous, ...paging };
    } else {
      const values = readForm(form);
      query = {
        days: Number(values['ops-visits-days']),
        sort: values['ops-visits-sort'],
        page: 1,
        pageSize: websiteVisitQueries.get(output)?.pageSize || defaultPageSize,
        ip: values['ops-visits-ip'].trim()
      };
    }
    await refreshWebsiteReport(
      output,
      status,
      '访问明细',
      () => localData.websiteVisits(query),
      (report) => {
        const time = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Shanghai',
          dateStyle: 'short',
          timeStyle: 'medium'
        });
        const filters = `最近 ${query.days} 天 · ${query.sort === 'oldest' ? '最早优先' : '最新优先'}${query.ip ? ' · 按 IP 筛选' : ''}`;
        const count = (value) => Number.isSafeInteger(value) ? esc(value) : '—';
        const metrics = report.summary
          ? websiteMetrics([['已采集浏览量', count(report.summary.pageViews)], ['独立 IP 数', count(report.summary.visitors)]])
          : '';
        const view = getDraft('website-visits-view').view || 'daily';
        const dailyDraft = getDraft('website-visits-daily-page');
        const dailySize = dailyDraft.pageSize || defaultPageSize;
        const dailyTotal = report.daily?.length || 0;
        const dailyPage = Math.min(dailyDraft.page || 1, Math.max(1, Math.ceil(dailyTotal / dailySize)));
        const daily = report.daily?.length
          ? `<div class="tool-period" role="group" aria-label="访问记录展示方式">${button('每日统计', 'ops-website-visit-view', '', '', `data-view="daily" aria-pressed="${view === 'daily'}"`)}${button('IP 明细', 'ops-website-visit-view', '', '', `data-view="records" aria-pressed="${view === 'records'}"`)}</div><div class="tool-report-section" data-visit-view="daily" ${view === 'daily' ? '' : 'hidden'}><div class="table-viewport" tabindex="0" role="region" aria-label="每日访问统计"><table><thead><tr><th scope="col">日期（北京时间）</th><th scope="col" class="tool-data-number">已采集浏览量</th><th scope="col" class="tool-data-number">独立 IP 数</th></tr></thead><tbody>${[...report.daily].reverse().map((row, index) =>
              `<tr data-visit-day ${Math.floor(index / dailySize) + 1 !== dailyPage ? 'hidden' : ''}><td>${esc(row.date)}</td><td class="tool-data-number">${count(row.metrics?.pageViews)}</td><td class="tool-data-number">${count(row.metrics?.visitors)}</td></tr>`
            ).join('')}</tbody></table></div><div data-visit-daily-pagination data-pagination-footer>${renderPagination({ id: 'operations-website-days', page: dailyPage, pageSize: dailySize, total: dailyTotal })}</div></div>`
          : '';
        const updated = report.lastReceivedAt ? ` · 最近接收 ${esc(time.format(new Date(report.lastReceivedAt)))}` : '';
        const content = report.items.length
          ? `<p class="tool-report-meta">${filters} · 北京时间${updated}</p><div class="table-viewport" tabindex="0" role="region" aria-label="访问记录"><table><thead><tr><th scope="col">访问时间</th><th scope="col">页面</th><th scope="col">IP 地址</th></tr></thead><tbody>${report.items
              .map((row, index) => {
                const pathId = `website-visit-path-${index}`;
                const path = esc(row.path);
                return `<tr><td>${esc(time.format(new Date(row.occurredAt)))}</td><td><button type="button" class="text-button table-value-ellipsis" popovertarget="${pathId}" aria-label="查看完整页面路径" data-table-value-preview>${path}</button><div id="${pathId}" class="table-value-popover" popover="auto" role="region" aria-label="完整页面路径">${path}</div></td><td><span data-visit-ip>${esc(row.ipMasked)}</span> ${button('查看', 'ops-website-visit-ip', '', '', `data-id="${esc(row.id)}"`)}</td></tr>`;
              })
              .join(
                ''
              )}</tbody></table></div>`
          : empty('没有匹配的访问记录', `${filters}。可调整时间范围或 IP 后重新查询。`);
        websiteVisitQueries.set(output, { ...query, page: report.page, pageSize: report.pageSize });
        const pager = renderPagination({ id: 'operations-website-visits', page: report.page, pageSize: report.pageSize, total: report.total });
        return `<div class="tool-report">${metrics}${daily}<div class="tool-report-section" data-visit-view="records" ${daily && view === 'daily' ? 'hidden' : ''}>${content}${pager}</div></div>`;
      },
      { scope: 'tools/website-visits', key: query, refresh }
    );
  }
  async function showWebsiteVisitIp(node) {
    const value = node.closest('td')?.querySelector('[data-visit-ip]');
    if (!value || node.disabled) return;
    node.disabled = true;
    try {
      const { ip } = await localData.websiteVisitIp(node.dataset.id);
      const drawer = value.closest('dialog[open], [data-plugin-tool]');
      if (!drawer) {
        node.disabled = false;
        return;
      }
      const masked = value.textContent;
      value.textContent = ip;
      const mask = () => {
        window.clearTimeout(timer);
        drawer.removeEventListener('close', mask);
        drawer.removeEventListener('id-view-deactivate', mask);
        value.textContent = masked;
        node.disabled = false;
      };
      const timer = window.setTimeout(mask, 30_000);
      drawer.addEventListener('close', mask, { once: true });
      drawer.addEventListener('id-view-deactivate', mask, { once: true });
      return;
    } catch (error) {
      if (value.isConnected) notify(error.message);
    }
    node.disabled = false;
  }
  function openWebsiteMonitor() {
    const enabled = localData.authRequired;
    const visitsAllowed = enabled && isAdmin();
    openToolDrawer(
      '网站监控',
      '检查公网网站的访问状态、响应时间、跳转和 HTTPS 证书。',
      enabled
        ? `${visitsAllowed ? websiteVisitsPanel() : ''}<section class="form-section website-tool-panel" id="ops-website-check"><form id="ops-website-monitor-form" novalidate>${websiteToolHeader('网站健康检测', '<button class="button primary" type="submit">检测网站</button>')}${grid(
            wide(
              field(
                '网站地址',
                'ops-monitor-url',
                input(
                  'ops-monitor-url',
                  'https://flashcast.com.my',
                  'placeholder="https://example.com" autocomplete="off" maxlength="2048"'
                ),
                true
              )
            )
          )}</form><div class="design-async-region"><div id="ops-monitor-status" role="status"></div><div id="ops-monitor-result">${empty('等待检测', '输入网站地址后查看可用状态、响应时间和 HTTPS 证书。')}</div></div></section>`
        : empty('请先设置本机管理员密码', '在 Mac「终端」完成首次设置，登录后即可检测公网网站。') +
          `<div class="form-footer">${button('我已设置密码，去登录', 'ops-integrated-login', 'primary')}</div>`,
      '',
      visitsAllowed ? [
        ['ops-website-visits', '访问记录与 IP'],
        ['ops-website-check', '网站检测']
      ] : [],
      visitsAllowed ? '<div class="tool-query-actions website-statistics-entry"><a class="button" href="#/data">查看网站统计</a></div>' : ''
    );
    if (enabled) {
      bindToolDraft($('#ops-website-monitor-form'), 'website-monitor');
      const visits = $('#ops-website-visits-form');
      bindToolDraft(visits, 'website-visits');
      if (visitsAllowed) void showWebsiteVisits(visits);
      $('#ops-monitor-url').addEventListener('input', () => {
        $('#ops-monitor-status').textContent = '';
        $('#ops-monitor-result').replaceChildren();
        setError('ops-monitor-url', '');
      });
    }
  }
  async function checkWebsite(form) {
    const address = form.querySelector('#ops-monitor-url');
    const submit = form.querySelector('button[type="submit"]');
    const progress = $('#ops-monitor-status');
    const result = $('#ops-monitor-result');
    const url = address.value.trim();
    setError('ops-monitor-url', '');
    if (!url) {
      setError('ops-monitor-url', '请输入网站地址');
      return;
    }
    if (submit.disabled) return;
    submit.disabled = true;
    address.disabled = true;
    progress.textContent = '正在检测网站…';
    try {
      const report = await localData.websiteMonitor(url);
      if (!toolActive(form)) return;
      const statuses = {
        reachable: '网站可访问',
        http_error: '网站返回访问错误',
        tls_error: 'HTTPS 证书异常',
        unreachable: '无法访问网站'
      };
      const tlsLabels = {
        valid: '证书有效',
        invalid: '证书异常',
        not_applicable: '未使用 HTTPS',
        unknown: '未取得证书状态'
      };
      const details = [
        ['检测结果', statuses[report.status] || '检测完成'],
        ['最终地址', report.effectiveUrl || report.requestedUrl || '—'],
        ['HTTP 状态', report.statusCode ?? '—'],
        ['响应时间', report.latencyMs == null ? '—' : `${report.latencyMs} 毫秒`],
        ['HTTPS 证书', tlsLabels[report.tls] || '未取得证书状态']
      ];
      const failures = {
        dns: '域名解析失败',
        timeout: '检测超时',
        tls: 'HTTPS 证书校验失败',
        connection: '无法建立连接',
        redirect: '跳转失败或跳转次数过多',
        blocked_target: '跳转目标不属于允许检测的公网地址'
      };
      const warnings = {
        insecure_http: '目标使用未加密的 HTTP',
        certificate_expiring: 'HTTPS 证书即将到期',
        slow: '响应较慢',
        redirect_without_location: '服务器返回跳转状态但没有目标地址'
      };
      if (failures[report.failure]) details.push(['说明', failures[report.failure]]);
      for (const warning of report.warnings || []) {
        if (warnings[warning]) details.push(['提示', warnings[warning]]);
      }
      const hops = report.hops || [];
      if (hops.length > 1) {
        for (const [index, hop] of hops.entries())
          details.push([
            `访问路径 ${index + 1}`,
            `${hop.url} · ${hop.statusCode} · ${hop.latencyMs} 毫秒`
          ]);
      }
      result.innerHTML = `<div class="property-list">${details
        .map(
          ([label, value]) =>
            `<div class="property-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`
        )
        .join('')}</div>`;
      progress.textContent = '';
    } catch (error) {
      if (toolActive(form)) {
        progress.textContent =
          error.message + (result.childElementCount ? '，显示上次检测结果。' : '');
      }
    } finally {
      submit.disabled = false;
      address.disabled = false;
    }
  }
  function runOnlineTool(form) {
    const values = readForm(form),
      name = values['ops-tool-name-key'];
    if (values['ops-tool-url']) {
      try {
        const url = new URL(values['ops-tool-url']);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error();
      } catch {
        setError('ops-tool-url', '请填写不含账号密码的 HTTP/HTTPS 演示链接');
        return;
      }
    }
    if (
      name === '邮箱查询与邮箱池' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values['ops-tool-email'] || '')
    ) {
      setError('ops-tool-email', '请填写正确的演示邮箱');
      return;
    }
    const complete = () => {
      let result = '';
      if (name === '计算 2FA 验证码') {
        result =
          '<div class="side-note"><strong>模拟验证码（无效）</strong><span class="ops-code">000 000</span><p>仅展示动态口令结果样式，不能用于登录。未计算真实验证码。</p></div>';
        const control = $('#ops-tool-secret');
        if (control) control.value = '';
      }
      if (name === '网站监控')
        result = `<div class="side-note"><strong>模拟监控：${esc(values['ops-tool-outcome'])}</strong>示例响应 ${values['ops-tool-outcome'] === '可用' ? '200 · 120ms' : '未取得响应'}；没有向该网站发出请求。</div>`;
      if (name === '抖音解析')
        result =
          '<div class="guide-item"><h3>模拟解析结果</h3><p>示例标题：视频内容预览。未读取视频、未生成下载地址，真实清晰度与媒体信息待功能接入。</p></div>';
      if (name === '邮箱查询与邮箱池') {
        result = `<div class="guide-item"><h3>模拟取信：${esc(values['ops-tool-outcome'])}</h3><p>${values['ops-tool-outcome'] === '有邮件' ? '示例邮件：演示验证通知；验证码 000000（无效）。' : values['ops-tool-outcome'] === '无邮件' ? '当前模拟收件箱为空，可以重试设计流程。' : '模拟取信失败；保留输入并允许重新预览。'}</p></div>`;
        const control = $('#ops-tool-query-code');
        if (control) control.value = '';
      }
      $('#ops-online-tool-result').innerHTML = result;
    };
    complete();
  }

  function preserveDraft() {
    for (const form of document.querySelectorAll('#drawer form[data-ops-draft], [data-plugin-tool] form[data-ops-draft]'))
      state.drafts.set(form.dataset.opsDraft, readDraft(form));
    const form = $('#main form');
    if (!form) return;
    const key =
      {
        'ops-cost-form': 'costs',
        'ops-customer-sources-form': 'customer-sources',
        'ops-customer-tags-form': 'customer-tags',
        'ops-security-form': 'security',
      }[form.id];
    if (!key) return;
    const values = readForm(form);
    for (const node of form.querySelectorAll('[data-no-draft]'))
      if (node.name) delete values[node.name];
    for (const name of Object.keys(values))
      if (/session|cvv|secret|token|password/i.test(name)) delete values[name];
    state.drafts.set(draftKey(key), values);
  }
  function renderPage() {
    const route = state.route;
    if (pluginPages[route]) return header(pluginPages[route].label, pluginPages[route].description) +
      `<section id="plugin-tool-host" class="panel form-panel plugin-tool-page" data-plugin-tool data-route="${route}"></section>`;
    if (route === bitLoginRoute) return renderBitBrowserLogin();
    if (route === workspaceRechargeRoute) return renderIntegratedRecharge(true);
    if (route === onlineRechargeRoute) return renderIntegratedRecharge();
    if (route === 'settings/accounts') return renderStaff();
    if (route === 'settings/mail-types') return renderMailboxTypes();
    if (route === 'settings/costs') return renderDropdownSettings();
    if (route === loginLogsRoute) return renderLoginLogs();
    if (route === 'settings/audit')
      return isAdmin()
        ? renderAudit()
        : header('审计日志', '普通员工无权访问审计日志。') +
            `<section class="panel">${empty('无权访问审计日志', '正式系统继续沿用管理员边界。')}</section>`;
    return '';
  }
  function onClick(action, node) {
    const id = node.dataset.id;
    if (action === 'tool-open' && state.toolsTab === '在线工具') {
      openOnlineTool(node.dataset.name);
      return true;
    }
    if (!action.startsWith('ops-')) return false;
    if (action === 'ops-tool-section') {
      selectToolSection(node.dataset.panel);
      return true;
    }
    if (action === 'ops-website-visit-refresh') {
      void showWebsiteVisits($('#ops-website-visits-form'), { page: 1 }, { refresh: true });
      return true;
    }
    if (action === 'ops-website-visit-view') {
      const result = node.closest('[data-visits-result]');
      const view = node.dataset.view;
      state.drafts.set(draftKey('website-visits-view'), { view });
      for (const tab of result.querySelectorAll('[data-view]')) tab.setAttribute('aria-pressed', String(tab === node));
      for (const pane of result.querySelectorAll('[data-visit-view]')) pane.hidden = pane.dataset.visitView !== view;
      return true;
    }
    if (action === 'ops-website-visit-ip') {
      void showWebsiteVisitIp(node);
      return true;
    }
    if (['ops-mail-copy-code', 'ops-mail-copy-body', 'ops-mail-retry'].includes(action)) {
      const form = node.closest('#ops-managed-mail-query');
      if (!form) return true;
      if (action === 'ops-mail-retry') { void queryManagedMail(form); return true; }
      const row = mailQuerySnapshots.get(form)?.items[Number(node.dataset.index)];
      if (row) void copyText(action === 'ops-mail-copy-code' ? row.extractedCode : mailBodyParts(String(row.body || '')).map(part => part.text).join(''), action === 'ops-mail-copy-code' ? '验证码已复制' : '邮件正文已复制');
      return true;
    }
    if (action.startsWith('ops-mailbox-pool-')) {
      const panel = $('#ops-mailbox-pool');
      if (!panel || !isAdmin()) return true;
      if (action === 'ops-mailbox-pool-add') editManagedPool(panel, 'create');
      if (action === 'ops-mailbox-pool-batch') editMailboxBatchOrSettings(panel, 'batch');
      if (action === 'ops-mailbox-pool-settings') editMailboxBatchOrSettings(panel, 'settings');
      if (action === 'ops-mailbox-pool-more') {
        const row = mailboxPoolSnapshots.get(panel)?.items.find(item => item.id === id);
        if (!row || row.authorizationPending) return true;
        const attrs = `data-id="${esc(row.id)}" data-provider="${esc(row.provider)}"`;
        api.openActionMenu(node,
          button(row.provider === 'microsoft' ? '重新授权' : '更新授权', row.provider === 'relay' ? 'ops-mailbox-pool-authorize' : 'ops-mailbox-pool-credential', '', '', attrs) +
          button('重置查询码', 'ops-mailbox-pool-rotate', '', '', attrs) +
          button(row.active ? '停用' : '启用', 'ops-mailbox-pool-status', '', '', attrs + (row.authFailed ? ' disabled' : '')),
          { label: '邮箱操作' });
      }
      if (action === 'ops-mailbox-pool-authorize') {
        const row = mailboxPoolSnapshots.get(panel)?.items.find(item => item.id === id);
        if (!row) return true;
        if (row.provider === 'relay') {
          if (panel.closest('dialog')) { api.go('mailboxes/relay'); return true; }
          openMailboxOperation(panel, 'relay', '隐藏邮箱授权', row,
            '<section class="form-section"><h3>连接所属主邮箱</h3><p>隐藏邮箱通过所属主邮箱收信。请在隐藏邮箱管理中连接并授权主邮箱，完成后可回到邮箱池查询。</p></section>',
            button('关闭', 'drawer-close') + button('打开隐藏邮箱管理', 'ops-go', 'primary', '', 'data-route="mailboxes/relay"'));
        } else if (row.provider === 'microsoft' && !row.authorizationPending) {
          openMailboxAuthorization(panel, row);
        } else {
          editManagedPool(panel, row.authorizationPending ? 'create' : 'credential', id);
        }
      }
      if (action === 'ops-mailbox-pool-query') void openMailboxPoolQuery(panel, id);
      if (action === 'ops-mailbox-pool-credential') {
        if (node.dataset.provider === 'microsoft')
          openMailboxAuthorization(panel, mailboxPoolSnapshots.get(panel)?.items.find(row => row.id === id));
        else editManagedPool(panel, 'credential', id);
      }
      if (action === 'ops-mailbox-pool-oauth-start') {
        const row = mailboxPoolSnapshots.get(panel)?.items.find(row => row.id === id);
        if (row && !node.disabled) void api.withActionFeedback(node,
          () => startMicrosoftMailbox(panel, { id, email: row.email, version: Number(panel.dataset.version) }),
          { pending: '正在打开 Microsoft 授权…' });
      }
      if (action === 'ops-mailbox-pool-status-confirm') {
        if (!node.disabled) void api.withActionFeedback(node,
          () => saveManagedPool(panel, { action: 'status', id, active: node.dataset.active === 'true', version: Number(node.dataset.version) }),
          { pending: '正在保存查询状态…' });
      }
      if (action === 'ops-mailbox-pool-microsoft-finish') void finishMicrosoftMailbox(panel, node);
      if (action === 'ops-mailbox-pool-rotate') editManagedPool(panel, 'rotate', id);
      if (action === 'ops-mailbox-pool-cancel') {
        preserveDraft();
        if (mailboxOperation(panel)) { closeDrawer(); return true; }
        panel.querySelector('[data-mailbox-pool-editor]').replaceChildren();
        state.drafts.set(draftKey('mailbox-tools-view'), { tab: 'manage' });
      }
      if (action === 'ops-mailbox-pool-copy-existing') void copyManagedMailboxCode(panel, node);
      if (action === 'ops-mailbox-pool-copy') void copyText(node.dataset.code, '查询码已复制');
      if (action === 'ops-mailbox-pool-reload') void api.withActionFeedback(node,
        () => loadManagedPool(panel, { refresh: true }),
        { pending: '正在刷新邮箱池…', success: '邮箱池已刷新', failure: '邮箱池读取失败，已保留当前资料' });
      if (action === 'ops-mailbox-pool-status') {
        const row = mailboxPoolSnapshots.get(panel)?.items.find(row => row.id === id);
        if (!row) return true;
        const active = !row.active;
        if (panel.closest('dialog')) {
          confirmAction(active ? '启用邮箱查询' : '停用邮箱查询', '买家查询权限将按新状态更新。', () =>
            void saveManagedPool(panel, { action: 'status', id, active, version: Number(panel.dataset.version) }));
          return true;
        }
        openMailboxOperation(panel, 'status', active ? '启用邮箱查询' : '停用邮箱查询', row,
          `<section class="form-section"><div class="section-title-row"><h3>查询权限</h3></div><p>${active ? '启用后，买家可使用仍在有效期内的查询码查询此邮箱。' : '停用后，买家无法再使用查询码查询此邮箱。已有授权与历史资料保留。'}</p></section>`,
          button('取消', 'drawer-close') + button(active ? '确认启用' : '确认停用', 'ops-mailbox-pool-status-confirm', active ? 'primary' : 'danger', '',
            `data-id="${esc(id)}" data-active="${active}" data-version="${esc(panel.dataset.version)}"`));
      }
      return true;
    }
    if (action.startsWith('ops-saved-totp-')) {
      const panel = $('#ops-saved-totp');
      if (!panel) return true;
      if (action === 'ops-saved-totp-add') editSavedTotp(panel);
      if (action === 'ops-saved-totp-edit') editSavedTotp(panel, node);
      if (action === 'ops-saved-totp-cancel') {
        preserveDraft();
        panel.querySelector('#ops-totp-save-secret').value = '';
        panel.querySelector('[data-saved-totp-editor]').replaceChildren();
        state.drafts.delete(draftKey('saved-totp-view'));
      }
      if (action === 'ops-saved-totp-reload') void api.withActionFeedback(node,
        () => loadSavedTotp(panel, { refresh: true }),
        { pending: '正在刷新账号列表…', success: '账号列表已刷新', failure: '账号读取失败，请重试' });
      if (action === 'ops-saved-totp-use') void loadSavedTotpCodes(panel, [node.closest('[data-saved-totp-code]')]);
      if (action === 'ops-saved-totp-secret-retry') void loadSavedTotpSecret(node.closest('form'));
      if (action === 'ops-saved-totp-delete') {
        const version = Number(panel.dataset.version);
        confirmAction('删除已保存 2FA 账号', '删除后将无法使用此记录生成验证码。', () =>
          void saveSavedTotp(panel, { action: 'delete', id, version }));
      }
      return true;
    }
    if (action === 'ops-media-download') {
      void downloadOnlineMedia(node);
      return true;
    }
    if (action === 'ops-tool-paste' || action === 'ops-tool-clear') {
      const form = node.closest('form');
      const field = form?.querySelector('#' + node.dataset.field);
      if (!field || field.disabled) return true;
      if (action === 'ops-tool-clear') {
        field.value = '';
        if (field.id === 'ops-managed-query-code') form.querySelector('#ops-managed-query-limit').value = '5';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        return true;
      }
      void (async () => {
        try {
          const clipboardText = await navigator.clipboard.readText();
          const value = clipboardText.trim();
          if (!field.isConnected || field.disabled || !value) return;
          if (field.id === 'ops-totp-secret') {
            applyTotpPaste(form, clipboardText);
            return;
          }
          if (value.length > field.maxLength) {
            setError(field.id, '剪贴板内容超过输入上限。');
            return;
          }
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        } catch {
          if (field.isConnected) {
            field.focus();
            notify('无法读取剪贴板，请直接粘贴。');
          }
        }
      })();
      return true;
    }
    if (action === 'ops-totp-mode') {
      selectTotpMode(node.closest('form'), node.dataset.mode);
      return true;
    }
    if (action === 'ops-totp-retry') {
      node.closest('form').requestSubmit();
      return true;
    }
    if (action === 'ops-totp-save') {
      void addTemporaryTotpAccount(node);
      return true;
    }
    if (action === 'ops-mail-refresh') {
      const form = node.closest('form');
      if (form) void queryManagedMail(form);
      return true;
    }
    if (action === 'ops-mailbox-buyer-page') {
      window.open('/mailbox-query', '_blank', 'noopener,noreferrer');
      return true;
    }
    if (action === 'ops-mailbox-query-open') {
      const panel = $('#ops-mailbox-pool') || $('#plugin-tool-host');
      if (panel) openMailboxQueryDrawer(panel);
      return true;
    }
    if (action === 'ops-mailbox-related') {
      api.openActionMenu(node, `${button('查询码设置', 'ops-mailbox-pool-settings')}${button('查看谷歌邮箱库存', 'ops-go', '', 'mail', 'data-route="mailboxes/google"')}${button('提取邮箱', 'ops-go', '', 'database', 'data-route="workspace/mail-extract"')}${button('后台查询隐藏邮箱', 'ops-relay-query', '', 'search')}${button('打开买家查询页', 'ops-mailbox-buyer-page')}`, { label: '邮箱池更多操作' });
      return true;
    }
    if (action === 'ops-relay-query') {
      if (isAdmin()) api.modules.appleRelay?.openQuery();
      return true;
    }
    if (action === 'ops-totp-copy') {
      if (Number(node.dataset.expiresAt) <= Date.now()) notify('验证码已过期');
      else if (!navigator.clipboard) notify('请选中验证码手动复制');
      else
        navigator.clipboard.writeText(node.dataset.code).then(
          () => notify('验证码已复制', { kind: 'success' }),
          () => notify('复制失败，请选中验证码手动复制', { kind: 'error' })
        );
      return true;
    }
    if (localData && action.startsWith('ops-local-staff-')) {
      window.IDLocalAuth?.employeeAction(api, action, id);
      return true;
    }
    if (action === 'ops-integrated-view' && state.route === onlineRechargeRoute) {
      const view = node.dataset.view;
      if (onlineRechargeViews.some(([id]) => id === view) && view !== activeOnlineView) {
        if (blockRechargeNavigation()) return true;
        selectOnlineView(node.closest('nav'), view);
        void loadIntegratedRecharge();
      }
    } else if (action === 'ops-bit-address-jump' && state.route === bitLoginRoute) {
      const host = $('#bit-addresses-host', integrationRoot());
      host?.focus({ preventScroll: true });
      host?.scrollIntoView({ block: 'start' });
    } else if (action === 'ops-login-log-tab' && state.route === loginLogsRoute && isAdmin()) {
      loginLogTab = node.dataset.tab;
      state.page = 1;
      state.query = '';
      render();
    } else if (action === 'ops-integrated-login') {
      window.location.reload();
    } else if (action === 'ops-integrated-refresh') {
      if ([onlineRechargeRoute, workspaceRechargeRoute, loginLogsRoute, bitLoginRoute].includes(state.route)) {
        if (blockRechargeNavigation()) return true;
        void loadIntegratedRecharge({ refresh: true });
      }
    } else if (action === 'ops-staff-tab') {
      preserveDraft();
      local.staffTab = node.dataset.tab;
      state.page = 1;
      state.query = '';
      render();
    } else if (action === 'ops-staff-add') {
      if (local.staffRole === 'super') editStaff();
      else notify('只有超级管理员视角可演示此操作');
    } else if (action === 'ops-staff-edit') editStaff(id);
    else if (action === 'ops-staff-more') staffMore(id, node);
    else if (['ops-staff-toggle', 'ops-staff-reset', 'ops-staff-delete'].includes(action)) {
      if (local.staffRole !== 'super') {
        notify('只有超级管理员视角可演示此操作');
        return true;
      }
      const row = staff.find((item) => item.id === id);
      if (row.role === '超级管理员' && action !== 'ops-staff-reset') {
        notify('唯一超级管理员不能被停用或删除');
        return true;
      }
      if (
        action === 'ops-staff-delete' &&
        tasks.some(
          (task) =>
            task.ownerId === id &&
            [
              '等待执行',
              '执行中',
              '待确认付款',
              '付款已提交',
              '待核对',
              '待人工操作',
              '等待登录'
            ].includes(task.status)
        )
      ) {
        notify('员工存在执行中或待核对任务，不能删除');
        return true;
      }
      const label =
        action === 'ops-staff-delete'
          ? '删除演示员工'
          : action === 'ops-staff-reset'
            ? '模拟重置密码'
            : row.status === '启用'
              ? '停用员工'
              : '启用员工';
      confirmAction(
        `确认${label}`,
        `${row.name}。原型不修改真实账号、不发送消息或生成密码。`,
        () => {
          if (action === 'ops-staff-delete') row.status = '已删除';
          if (action === 'ops-staff-toggle') row.status = row.status === '启用' ? '停用' : '启用';
          closeDrawer();
          recordAudit(label, row.name);
          render();
          notify('演示操作已登记');
        }
      );
    } else if (action === 'ops-dropdown-tab') {
      if (!['costs', 'sources', 'tags'].includes(node.dataset.tab) || !isAdmin()) return true;
      preserveDraft();
      state.drafts.set(draftKey('dropdown-settings'), { tab: node.dataset.tab });
      render();
      document.getElementById(`dropdown-settings-${node.dataset.tab}`)?.focus({ preventScroll: true });
    } else if (action === 'ops-customer-options-reload') {
      if (!isAdmin()) return true;
      const config = customerOptionConfig(node.dataset.kind);
      const form = document.getElementById(config.formId);
      const submitted = form && JSON.stringify(readForm(form));
      confirmAction(`确认重新读取客户${config.label}`, '成功读取后清除当前未提交的设置。', () => {
        const region = form?.parentElement;
        const read = region && api.beginRegionRead(region, region.querySelector('[data-customer-options-status]'), { refreshButton: node });
        void loadSettings(true).then((loaded) => {
          if (!loaded) return notify('读取失败，已保留当前设置草稿');
          if (!form?.isConnected || JSON.stringify(readForm(form)) !== submitted) return;
          state.drafts.delete(draftKey(config.key));
          refreshSettingsPage();
          notify('客户选项已重新读取', { kind: 'success' });
        }).finally(() => read?.finish());
      });
    } else if (action === 'ops-settings-reload') {
      const form = $('#main #ops-cost-form');
      const values = form && readDraft(form);
      const config = values && api.modules.commerce?.getCostSettings?.();
      const hasEdits = config && Object.entries(values).some(([name, value]) =>
        value !== String(config[name.slice('ops-cost-'.length)]));
      const snapshot = JSON.stringify(values);
      const reload = () => {
        const region = form?.parentElement;
        const read = region && api.beginRegionRead(region, region.querySelector('[data-cost-read-status]'), {
          refreshButton: node
        });
        const label = form ? '费用规则' : '设置';
        void api.withActionFeedback(node, () => loadSettings(true),
          { pending: `正在读取${label}…`, success: `${label}已重新读取` }).then((loaded) => {
          read?.finish();
          const activeForm = $('#main #ops-cost-form');
          if (form && activeForm !== form) return;
          if (activeForm) preserveDraft();
          if (!loaded) notify('读取失败，已保留当前设置草稿');
          if (loaded && form && activeForm === form && JSON.stringify(readDraft(form)) === snapshot)
            state.drafts.delete(draftKey('costs'));
          if (loaded || !form) refreshSettingsPage();
        });
      };
      if (hasEdits) {
        confirmAction('确认重新读取费用规则', '成功读取后清除当前未提交的费用草稿。', reload);
      } else reload();
    } else if (action === 'ops-audit-refresh') {
      void api.withActionFeedback(node, () => retryAudit(),
        { pending: '正在刷新操作记录…', success: '操作记录已刷新', failure: '操作记录读取失败，请重试' });
    } else if (action === 'ops-mail-type-add') editMailboxType();
    else if (action === 'ops-mail-type-edit') editMailboxType(id);
    else if (action === 'ops-mail-type-reload') {
      const key = draftKey(`mail-type:${id || 'new'}`);
      const form = $('#ops-mail-type-form');
      const submitted = form && JSON.stringify(readForm(form));
      confirmAction('确认重新读取邮箱分类', '成功读取后清除当前未提交的分类修改。', () => {
        void loadSettings(true).then((loaded) => {
          if (!loaded) return notify('读取失败，已保留当前分类草稿');
          if (!form?.isConnected || JSON.stringify(readForm(form)) !== submitted) return;
          closeDrawer();
          state.drafts.delete(key);
          editMailboxType(id);
          refreshSettingsPage();
          notify('邮箱分类已重新读取', { kind: 'success' });
        });
      });
    }
    else if (action === 'ops-mail-type-move') {
      const index = mailboxTypes.findIndex((row) => row.id === id),
        next = index + Number(node.dataset.offset);
      if (index < 0 || next < 0 || next >= mailboxTypes.length) return true;
      const expectedVersion = settingsVersion;
      confirmAction('确认调整分类顺序', '调整下拉选项的显示顺序。', () => {
        const rows = mailboxTypes.map((row) => ({ ...row }));
        [rows[index], rows[next]] = [rows[next], rows[index]];
        if (localData) {
          void commitSettings(
            'mailbox_category_reorder',
            { ...settingsSnapshot(), mailboxTypes: rows },
            expectedVersion
          ).then((saved) => {
            if (saved) refreshSettingsPage();
          });
          return;
        }
        mailboxTypes.splice(0, mailboxTypes.length, ...rows);
        recordAudit('调整邮箱分类顺序', rows[next].label);
        render();
      });
    } else if (action === 'ops-audit-detail') {
      const row = (localData ? auditViews.audit.result?.items || [] : audit).find((item) => item.id === id);
      if (!row) return true;
      openDrawer(
        '审计详情',
        localData ? '本机业务操作摘要。' : '仅包含本原型的普通操作摘要，不记录原始凭据。',
        `<dl class="definition-list">${[
          ['日志编号', row.id],
          ['时间', row.time],
          ['操作人', row.actor],
          ['操作类型', row.action],
          ['对象', row.subject],
          ['结果', row.result]
        ]
          .map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`)
          .join('')}</dl>`,
        button('关闭', 'drawer-close')
      );
    } else if (action === 'ops-phrases') showPhrases();
    else if (action === 'ops-phrases-retry' && toolbox) {
      void api.withActionFeedback(node, async () => { await toolbox.load({ refresh: true }); return true; },
        { pending: '正在读取话术…', success: '话术已重新读取', failure: '话术读取失败，请重试' });
      showPhrases();
    } else if (action === 'ops-phrase-review') void reviewPhrase($('#ops-phrase-form'));
    else if (action === 'ops-phrase-add') editPhrase();
    else if (action === 'ops-phrase-edit') editPhrase(id);
    else if (action === 'ops-phrase-more') phraseMore(id);
    else if (action === 'ops-phrase-copy') {
      const row = phraseRows().find((item) => item.id === id);
      if (row) void copyText(row.text, toolbox ? '话术已复制' : undefined);
    } else if (action === 'ops-phrase-deleted') {
      local.showDeleted = !local.showDeleted;
      local.phrasePage = 1;
      showPhrases();
    } else if (action === 'ops-phrase-delete' || action === 'ops-phrase-restore') {
      const row = phraseRows().find((item) => item.id === id),
        label = action === 'ops-phrase-delete' ? '软删除' : '恢复';
      if (!row) return true;
      const version = toolbox?.current()?.version;
      confirmAction(`确认${label}话术`, `${row.title}。保留记录编号和内容。`, () => {
        void changePhrases(
          version,
          (rows) => {
            const item = rows.find((entry) => entry.id === id);
            if (!item) throw new Error('找不到这条话术。');
            item.deleted = action === 'ops-phrase-delete';
          },
          `${label}话术`
        );
      });
    } else if (action === 'ops-phrase-move') {
      const active = phraseRows().filter((row) => !row.deleted);
      const index = active.findIndex((row) => row.id === id);
      const target = active[index + Number(node.dataset.offset)];
      if (index >= 0 && target) void reorderPhrase(id, target.id);
    } else return false;
    return true;
  }
  function onSubmit(form) {
    if (!form.id.startsWith('ops-')) return false;
    if (localData && form.id === 'ops-local-staff-form')
      window.IDLocalAuth?.submitEmployee(api, form);
    else if (form.id === 'ops-staff-form') saveStaff(form);
    else if (form.id === 'ops-mail-type-form') saveMailboxType(form);
    else if (['ops-customer-tags-form', 'ops-customer-sources-form'].includes(form.id)) saveCustomerOptionSettings(form);
    else if (form.id === 'ops-cost-form') saveCosts(form);
    else if (form.id === 'ops-phrase-form') savePhrase(form);
    else if (form.id === 'ops-totp-form') void runTotp(form);
    else if (form.id === 'ops-website-monitor-form') void checkWebsite(form);
    else if (form.id === 'ops-website-visits-form') {
      state.drafts.delete(draftKey('website-visits-daily-page'));
      void showWebsiteVisits(form, undefined, { refresh: true });
    }
    else if (form.id === 'ops-managed-mail-query') void queryManagedMail(form);
    else if (form.id === 'ops-managed-pool-form') {
      const data = readForm(form);
      const submission = toolSubmission(form);
      const panel = form.closest('#ops-mailbox-pool') || mailboxOperationPanels.get(form.closest('[data-mailbox-operation]'));
      if (!panel || !toolActive(form)) return true;
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return true;
      submit.disabled = true;
      const footerSubmit = document.querySelector('button[form="ops-managed-pool-form"]');
      if (footerSubmit) footerSubmit.disabled = true;
      form.setAttribute('aria-busy', 'true');
      const finished = () => {
        submit.disabled = false;
        if (footerSubmit) footerSubmit.disabled = false;
        form.removeAttribute('aria-busy');
      };
      if (data['ops-managed-action'] === 'batch') {
        const input = form.querySelector('#ops-managed-batch');
        const provider = data['ops-managed-batch-provider'];
        const lines = String(data['ops-managed-batch'] || '').split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 1 || lines.length > 50) {
          setError(input.id, '每批可导入 1 至 50 个邮箱');
          finished();
          return true;
        }
        setError(input.id, '');
        const items = lines.map((line) => {
          const parts = line.split(line.includes('----') ? '----' : '|').map((item) => item.trim());
          if (provider === 'microsoft') {
            const [email, label, ...extra] = parts;
            return extra.length ? {} : { email, label };
          }
          const types = { 谷歌: 'google', 苹果: 'apple' };
          const selected = types[parts[0]] ? types[parts.shift()] : provider;
          const [email, appPassword, label, ...extra] = parts;
          return extra.length ? {} : { provider: selected, email, appPassword, label };
        });
        const pending = provider === 'microsoft' ? authorizeMicrosoftBatch(panel, items, submission)
          : saveManagedPool(panel, { action: 'batch', version: Number(data['ops-managed-version']), items }, null, submission);
        void pending.finally(finished);
        return true;
      }
      if (data['ops-managed-action'] === 'create' && data['ops-managed-provider'] === 'microsoft') {
        void startMicrosoftMailbox(panel, {
          email: data['ops-managed-email'], label: data['ops-managed-label'], validDays: Number(data['ops-managed-days']),
          version: Number(data['ops-managed-version'])
        }, submission).finally(finished);
        return true;
      }
      void saveManagedPool(panel, {
        action: data['ops-managed-action'], id: data['ops-managed-id'], version: Number(data['ops-managed-version']),
        email: data['ops-managed-email'], provider: data['ops-managed-provider'], label: data['ops-managed-label'],
        applyExisting: data['ops-managed-apply-existing'] === 'on',
        appPassword: data['ops-managed-app-password'], validDays: Number(data['ops-managed-days'])
      }, null, submission).finally(finished);
    }
    else if (form.id === 'ops-saved-totp-form') {
      const values = readForm(form);
      const submission = toolSubmission(form);
      const id = values['ops-totp-id'];
      const panel = form.closest('#ops-saved-totp');
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return true;
      submit.disabled = true;
      void saveSavedTotp(panel, {
        action: id ? 'update' : 'create', id, version: Number(values['ops-totp-version']),
        name: values['ops-totp-name'], secret: values['ops-totp-save-secret']
      }, submission).finally(() => { submit.disabled = false; });
    }
    else if (form.id === 'ops-media-resolver') void resolveOnlineMedia(form);
    else if (form.id === 'ops-online-tool-form') runOnlineTool(form);
    else if (form.id === 'ops-permissions-form') {
      if (local.staffRole !== 'super') {
        notify('当前视角无修改权限');
        return true;
      }
      const role = new FormData(form).get('ops-permission-role'),
        selected = new FormData(form).getAll('ops-permission');
      confirmAction('确认演示角色权限', `${role}。不修改真实登录角色。`, () => {
        permissions[role] = selected;
        recordAudit('修改角色权限', role);
        render();
        notify('演示角色权限已更新');
      });
    } else if (form.id === 'ops-security-form') {
      if (local.staffRole !== 'super') {
        notify('当前视角无修改权限');
        return true;
      }
      if (api.optionListPending(form)) {
        notify('请先添加或取消尚未提交的项目');
        return true;
      }
      preserveDraft();
      const values = readForm(form);
      const ips = api.readOptionList(values['ops-security-ip']);
      if (!ips.includes('127.0.0.1')) {
        setError('ops-security-ip', '演示白名单必须保留当前本机 IP 127.0.0.1');
        return true;
      }
      confirmAction('确认演示安全策略', '仅更新设计状态，不影响真实 MFA、IP 或会话。', () => {
        if (!ips.includes('127.0.0.1')) {
          setError('ops-security-ip', '演示白名单必须保留当前本机 IP 127.0.0.1');
          return;
        }
        local.securityMfa = values['ops-security-mfa'];
        local.securityIp = ips.join(',');
        const key = draftKey('security');
        if (JSON.stringify(state.drafts.get(key)) === JSON.stringify(values))
          state.drafts.delete(key);
        recordAudit('修改演示安全策略', '全局策略');
        render();
        notify('演示安全设置已更新');
      });
    } else return false;
    return true;
  }
  function onChange(node) {
    if (!node.id?.startsWith('ops-')) return false;
    if (node.id === 'ops-phrase-sort') {
      local.phraseSort = node.value;
      local.phrasePage = 1;
      showPhrases();
      $('#ops-phrase-sort')?.focus({ preventScroll: true });
    } else if (node.id === 'ops-role-preview') {
      preserveDraft();
      local.staffRole = node.value;
      render();
    } else if (node.id === 'ops-permission-role') {
      local.permissionRole = node.value;
      render();
    } else return false;
    return true;
  }
  function onInput(node) {
    if (node.id === 'ops-list-search') {
      const view = activeAuditView();
      if (view) {
        if (node === composingAuditSearch || auditViews[view].query === node.value) return true;
        auditViews[view].query = node.value;
        void loadAudit(view, { page: 1, fresh: true });
        return true;
      }
      state.query = node.value;
      state.page = 1;
      const cursor = node.selectionStart;
      render();
      const next = $('#ops-list-search');
      next?.focus({ preventScroll: true });
      next?.setSelectionRange(cursor, cursor);
      return true;
    }
    if (node.id === 'ops-phrase-search') {
      local.phraseQuery = node.value;
      local.phrasePage = 1;
      const cursor = node.selectionStart;
      showPhrases();
      const next = $('#ops-phrase-search');
      next?.focus({ preventScroll: true });
      next?.setSelectionRange(cursor, cursor);
      return true;
    }
    return false;
  }
  document.addEventListener('compositionstart', ({ target }) => {
    if (target.id === 'ops-list-search' && activeAuditView()) composingAuditSearch = target;
  });
  document.addEventListener('compositionend', ({ target }) => {
    if (target !== composingAuditSearch) return;
    composingAuditSearch = undefined;
    const view = activeAuditView();
    if (view && auditViews[view].query === target.value) renderAuditRead(view);
    else if (view) onInput(target);
  });
  document.addEventListener('id-pagination-change', (event) => {
    const { id, page, pageSize } = event.detail;
    const auditView = activeAuditView();
    if (auditView && id === `operations-${auditView}`) {
      void loadAudit(auditView, { page, pageSize });
    } else if (id === 'operations-saved-totp') {
      const panel = $('#ops-saved-totp');
      const snapshot = savedTotpSnapshots.get(panel);
      if (snapshot && panel.checkVisibility()) {
        state.drafts.set(draftKey('saved-totp-page'), { page, pageSize });
        paintSavedTotp(panel, snapshot, page);
      }
    } else if (id === 'operations-mailbox-pool') {
      const panel = $('#ops-mailbox-pool');
      const snapshot = mailboxPoolSnapshots.get(panel);
      if (snapshot && panel.checkVisibility()) {
        state.drafts.set(draftKey('mailbox-pool-page'), { page, pageSize });
        paintManagedPool(panel, snapshot, page);
      }
    } else if (id === 'operations-phrases') {
      if ($('#ops-phrase-list')?.checkVisibility()) {
        local.phrasePage = page;
        local.phrasePageSize = pageSize;
        showPhrases();
      }
    } else if (id === 'operations-website-visits') {
      if ($('[data-visit-view="records"]')?.checkVisibility())
        void showWebsiteVisits($('#ops-website-visits-form'), { page, pageSize });
    } else if (id === 'operations-website-days') {
      const pane = $('[data-visit-view="daily"]');
      if (!pane?.checkVisibility()) return;
      const rows = [...pane.querySelectorAll('[data-visit-day]')];
      state.drafts.set(draftKey('website-visits-daily-page'), { page, pageSize });
      rows.forEach((row, index) => { row.hidden = Math.floor(index / pageSize) + 1 !== page; });
      pane.querySelector('[data-visit-daily-pagination]').innerHTML =
        renderPagination({ id, page, pageSize, total: rows.length });
    }
  });
  api.modules.operations = {
    refreshRechargeCardTypes() {
      visibleRechargeCardFrame()?.contentWindow?.postMessage(
        { source: 'id-recharge-shell', type: 'data-change', scopes: ['card-types'] }, window.location.origin
      );
    },
    blockRechargeNavigation,
    openRechargeTaskLog,
    getResources: (kind) =>
      !localData && kind === 'cards' ? resources.cards.map((row) => ({ ...row })) : [],
    getMailboxTypes: () => mailboxTypes.map((row) => ({ ...row })),
    getCustomerTags: () => [...customerTags],
    getCustomerSources: () => [...customerSources],
    getCostRules: () => api.modules.commerce?.getCostSettings?.() || null,
    recordAudit,
    showPhrases,
    getAudit: () => (localData ? auditViews.audit.result?.items || [] : audit).map((row) => ({ ...row })),
    loadSettings,
    refreshAudit: () => loadAudit('audit', { fresh: true }),
    async refreshLiveReads(scopes) {
      const jobs = [];
      if (scopes.includes('audit') && activeAuditView() === 'login') jobs.push(loadAudit('login', { fresh: true }));
      const totp = $('#ops-saved-totp'), pool = $('#ops-mailbox-pool'), visits = $('#ops-website-visits-form');
      if (scopes.includes('saved-totp') && totp?.checkVisibility()) jobs.push(loadSavedTotp(totp, { refresh: true }));
      if (scopes.some(scope => ['inventory', 'tools/mailbox-pool'].includes(scope)) && pool?.checkVisibility()) jobs.push(loadManagedPool(pool, { refresh: true }));
      if (scopes.includes('tools/website-visits') && visits?.checkVisibility()) jobs.push(showWebsiteVisits(visits, {}, { refresh: true }));
      await Promise.all(jobs);
    },
    updateStatisticsCurrency
  };
  window.IDDesignModules.push({
    id: 'operations',
    retainPage: (route) => [bitLoginRoute, workspaceRechargeRoute, onlineRechargeRoute].includes(route),
    deactivate(region) {
      const host = region?.querySelector('[data-plugin-tool]');
      if (host) {
        host.dispatchEvent(new Event('id-view-deactivate'));
        pluginCleanup?.();
        pluginCleanup = undefined;
      }
      deactivateIntegration(region);
    },
    clearPageState() {
      deactivateIntegration(document.getElementById('main'));
      onlineAdmin = undefined;
      composingAuditSearch = undefined;
      resetAuditViews();
    },
    matches: (route) =>
      [
        bitLoginRoute,
        workspaceRechargeRoute,
        onlineRechargeRoute,
        'settings/accounts',
        'settings/mail-types',
        'settings/costs',
        loginLogsRoute,
        'settings/audit'
      ].includes(route) || Object.hasOwn(pluginPages, route),
    afterRender() {
      const settingsTabs = $('.dropdown-settings [role="tablist"]');
      settingsTabs?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...settingsTabs.querySelectorAll('[role="tab"]')];
        const index = tabs.indexOf(event.target);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click();
      });
      if (state.route === bitLoginRoute) {
        const host = $('#bit-addresses-host', integrationRoot());
        if (host && isAdmin()) api.modules.bitbrowserAddresses?.mount(host);
        void loadIntegratedRecharge();
        return;
      }
      if (pluginPages[state.route]) { openOnlineTool(pluginPages[state.route].tool); api.compactListToolbars?.(document.getElementById('main')); return; }
      const auditView = activeAuditView();
      if (auditView) {
        if (auditViews[auditView].dirty && !auditViews[auditView].pending) void loadAudit(auditView, { fresh: true });
      }
      else if (localData && state.route === 'settings/accounts')
        void window.IDLocalAuth?.loadEmployees(api);
      else void loadIntegratedRecharge();
    },
    render: renderPage,
    onClick,
    onSubmit,
    onChange,
    onInput,
    preserveDraft
  });
  if (localData) void loadSettings().then(refreshSettingsPage);
})();
