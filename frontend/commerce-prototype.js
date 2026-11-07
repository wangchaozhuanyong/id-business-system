/* Commerce views share the isolated local store when the local runtime is enabled. */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  if (!A) throw new Error('设计基础模块尚未就绪');
  const S = A.state;
  const localData = window.IDLocalData;
  const M = A.money;
  const $ = (selector, root = document) => root.querySelector(selector);
  const E = A.esc;
  const value = (form, name) => String(form[`commerce-${name}`] ?? '').trim();
  const beijingClock = new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai'
  });
  const now = () =>
    localData ? beijingClock.format(new Date()) : A.nowText ? A.nowText() : '2026-11-03 10:30';
  const uid = (prefix) =>
    localData
      ? `${prefix}-${crypto.randomUUID()}`
      : A.newId
        ? A.newId(prefix)
        : `${prefix}-${Date.now()}-${++sequence}`;
  let sequence = 0;
  let quickReturn = null;
  let customerSettingsReturn = null;
  let finance;
  let orderPrices = {};
  let priceLoad;
  let orderCards = [];
  const tenantCards = new Map();
  const cardLoads = new WeakMap();
  const appleMatchDefaults = {
    Plus: ['20', '99'], 'Pro 100': ['100', '199'], 'Pro 200': ['220', '499'], 'Pro 500': ['500', ''],
    Pro: ['20', '99'], 'Max 5x': ['100', '249'], 'Max 20x': ['250', '']
  };
  const automaticSnapshotRequests = new Set();
  const fxRates = {
    CNY: '1',
    MYR: '1.65',
    USD: '7.2',
    PHP: '0.125',
    CLP: '0.0075',
    IDR: '0.00045'
  };
  const costSettings = {
    currency: 'CNY',
    claudeBankFeeMyr: '100',
    claudeAccountCostMyr: '50',
    gmailCostCny: '15',
    appleCostCny: '25',
    microsoftCostCny: '5',
    appleDiscount: '0.8',
    cardIssueUsd: '0.5',
    cardPercent: '0.008',
    cardPerPaymentUsd: '0.3',
    version: 1
  };
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR'];
  const currencyNames = {
    CNY: '人民币',
    MYR: '马币',
    USD: '美元',
    PHP: '菲律宾比索',
    CLP: '智利比索',
    IDR: '印尼盾'
  };
  const currencyLabel = (code) => `${currencyNames[code] || code} ${code}`;
  const currencyChoices = (codes = currencies) => codes.map((code) => [code, currencyLabel(code)]);
  const productPlans = {
    GPT: ['Plus', 'Pro 100', 'Pro 200', 'Pro 500'],
    'Claude Pro': ['Pro'],
    'Claude Max': ['Max 5x', 'Max 20x']
  };
  const pendingRenewalProducts = ['Gemini', 'Grok'].filter((product) => !Object.hasOwn(productPlans, product));
  const customerChannels = [
    ['phone', '联系电话'],
    ['wechat', '客户微信'],
    ['qq', 'QQ'],
    ['whatsapp', 'WhatsApp'],
    ['telegram', 'Telegram']
  ];
  const orderContactFields = customerChannels.map(([name]) => [
    name === 'phone' ? 'customerPhone' : name,
    name
  ]);
  const customers = [
    {
      id: 'customer-demo-1',
      name: '林先生',
      wechat: 'demo_lin',
      phone: '演示电话 01',
      whatsapp: '演示 WhatsApp 01',
      telegram: '@demo_lin',
      source: '微信',
      qq: '演示 QQ 01',
      tags: ['长期客户'],
      notes: '演示客户资料',
      version: 1,
      active: true
    },
    {
      id: 'customer-demo-2',
      name: '陈女士',
      wechat: 'demo_chen',
      phone: '演示电话 02',
      whatsapp: '演示 WhatsApp 02',
      telegram: '@demo_chen',
      source: '客户推荐',
      qq: '',
      tags: ['客户推荐'],
      notes: '',
      version: 1,
      active: true
    },
    {
      id: 'customer-demo-3',
      name: '周先生',
      wechat: 'demo_zhou',
      phone: '演示电话 03',
      whatsapp: '',
      telegram: '@demo_zhou',
      source: '网站',
      qq: '',
      tags: [],
      notes: '',
      version: 1,
      active: true
    }
  ];
  const tenants = [
    {
      id: 'tenant-demo-1',
      name: '陈租户',
      phone: '演示租户电话 01',
      owner: '林负责人',
      notes: '租户与认证人分别记录',
      active: true,
      version: 1
    },
    {
      id: 'tenant-demo-2',
      name: '林租户',
      phone: '演示租户电话 02',
      owner: '陈负责人',
      notes: '',
      active: true,
      version: 1
    },
    {
      id: 'tenant-demo-3',
      name: '周租户',
      phone: '演示租户电话 03',
      owner: '林负责人',
      notes: '',
      active: true,
      version: 1
    }
  ];
  const orders = S.demoOrders;
  const operating = new Map();
  const rentBatches = [];
  const logs = [];
  const renewalRoute = 'workspace/renewals';
  const customerLossRoute = 'workspace/customer-loss';
  const renewalOrderPrefix = 'workspace/order/renew/';
  const gptOrderRoute = 'workspace/order/gpt';
  const claudeOrderRoute = 'workspace/order/claude';
  const isOrderEntry = (route) => ['workspace/order', gptOrderRoute, claudeOrderRoute].includes(route);
  const entryRoute = (product) => product === 'GPT' ? gptOrderRoute : claudeOrderRoute;
  const automaticOrder = (row) => row?.source === '线上代充' && Boolean(row.taskId);
  const entryDraft = (product) => `commerce-order:new:${product === 'GPT' ? 'gpt' : 'claude'}`;
  const defaultWarningHours = 72;
  const maxWarningHours = 365 * 24;
  let renewalWarningHours = defaultWarningHours;
  let localVersion = 0;
  let localPhase = localData ? 'initial' : 'ready';
  let saving = false;
  const moduleState = {
    customerMode: 'active',
    tenantMode: 'active',
    orderTab: 'all',
    claudeTab: 'active',
    statsTab: 'overview',
    detailTab: 'details',
    renewalTab: 'upcoming',
    productFilter: '',
    statusFilter: ''
  };

  function amountValid(input, optional = false) {
    return optional && input === ''
      ? true
      : /^\d+(?:\.\d{1,4})?$/.test(String(input)) && M.compare(String(input), '0') >= 0;
  }
  function normalized(input = '0') {
    return M.formatUnits(M.units(String(input), 4), 4);
  }
  function display(input) {
    if (input === null || input === undefined || input === '') return '待核算';
    const number = normalized(input);
    return number.replace(/(\.\d{2})0+$/, '$1');
  }
  function sum(items, mapper) {
    return items.reduce((total, item) => M.add(total, mapper(item) || '0'), '0');
  }
  function cny(input, currency, rates = fxRates) {
    return M.convert(input, rates[currency]);
  }
  function shownCurrency(input, currency = costSettings.currency, rates = fxRates) {
    return currency === 'CNY' ? input : M.divide(input, rates[currency]);
  }
  function safeClone(input) {
    return structuredClone(input);
  }
  function commerceSnapshot() {
    return safeClone({ customers, tenants, orders, operating: [...operating], rentBatches, logs, renewalWarningHours });
  }
  function applyCommerceSnapshot(data) {
    customers.splice(0, customers.length, ...(data?.customers || []));
    tenants.splice(0, tenants.length, ...(data?.tenants || []));
    orders.splice(0, orders.length, ...(data?.orders || []));
    rentBatches.splice(0, rentBatches.length, ...(data?.rentBatches || []));
    logs.splice(0, logs.length, ...(data?.logs || []));
    const legacyWarningDays = data?.renewalWarningDays;
    renewalWarningHours = data?.renewalWarningHours ??
      (legacyWarningDays == null ? defaultWarningHours : legacyWarningDays * 24);
    operating.clear();
    for (const [key, row] of data?.operating || []) operating.set(key, row);
  }
  function acceptLocalCommerce(response) {
    if (response.version < localVersion) return;
    localVersion = response.version;
    applyCommerceSnapshot(response.data);
    localPhase = 'ready';
  }
  let commerceLoad;
  function loadLocalCommerce(retry = false, refresh = false) {
    if (commerceLoad) return commerceLoad;
    if (!localData || (!refresh && localPhase !== 'initial' && !(retry && localPhase === 'error')))
      return Promise.resolve(localPhase === 'ready');
    const hadData = localPhase === 'ready';
    if (!hadData) localPhase = 'loading';
    commerceLoad = localData
      .load('commerce')
      .then(
        (result) => {
          acceptLocalCommerce(result);
          return true;
        },
        () => {
          if (!hadData) localPhase = 'error';
          return false;
        }
      )
      .finally(() => {
        commerceLoad = undefined;
        updateRenewalReminder();
        if (matches(S.route) && (!hadData || !$('#main form[data-commerce-draft]'))) A.render();
      });
    return commerceLoad;
  }
  function persistCommerce(action, mutate, completed, dependencies = [], afterCommit) {
    if (!localData) {
      if (mutate() !== false) completed();
      return;
    }
    if (localPhase !== 'ready' || saving) {
      A.notify(saving ? '正在保存，请稍候' : '本机业务数据尚未就绪');
      return;
    }
    const route = S.route;
    const drawerContext = S.drawerContext;
    const submittedForm = $('#drawer[open] form[data-commerce-draft]') ||
      $('#main form[data-commerce-draft]');
    const submittedKey = submittedForm?.dataset.commerceDraft;
    const submittedValues = submittedForm ? readCommerceDraft(submittedForm) : null;
    const submittedDraft = submittedValues ? JSON.stringify(submittedValues) : '';
    saveDrafts();
    let next;
    const before = commerceSnapshot();
    try {
      if (mutate() === false) return;
      next = commerceSnapshot();
    } catch {
      A.notify('未能生成保存内容，请重新核对');
      return;
    } finally {
      applyCommerceSnapshot(before);
    }
    saving = true;
    let commit;
    const participants = dependencies.filter((item) => item?.entry);
    if (participants.length) {
      commit = localData
        .saveBatch([
          { domain: 'commerce', version: localVersion, data: next, action },
          ...participants.map((item) => item.entry)
        ])
        .then((results) => {
          for (const item of participants)
            item.apply(results.find((row) => row.domain === item.entry.domain));
          const inventory = results.find((row) => row.domain === 'inventory');
          if (inventory && !participants.some((item) => item.entry.domain === 'inventory'))
            A.modules.inventory?.applyCommittedInventory?.(inventory);
          return results.find((row) => row.domain === 'commerce');
        });
    } else {
      commit = localData.save('commerce', localVersion, next, { action, summary: action });
    }
    void commit
      .then(
        (result) => {
          if (result.inventory) A.modules.inventory?.applyCommittedInventory?.(result.inventory);
          acceptLocalCommerce(result);
          afterCommit?.();
          const unchanged = !submittedForm || (submittedForm.isConnected &&
            JSON.stringify(readCommerceDraft(submittedForm)) === submittedDraft);
          if (S.route === route && S.drawerContext === drawerContext && unchanged) completed();
          else {
            saveDrafts();
            const activeForms = [...document.querySelectorAll(
              '#main form[data-commerce-draft], #drawer[open] form[data-commerce-draft]'
            )].filter(form => form.dataset.commerceDraft === submittedKey);
            if (submittedKey && !activeForms.length &&
                JSON.stringify(S.drafts.get(submittedKey)) === submittedDraft)
              S.drafts.delete(submittedKey);
            else if (submittedValues) {
              const prior = recordForDraft(before, submittedForm.id, submittedValues);
              const saved = recordForDraft(result.data, submittedForm.id, submittedValues);
              const draft = S.drafts.get(submittedKey);
              if (prior && saved && draft &&
                  String(prior.version) === submittedValues['commerce-version'] &&
                  draft['commerce-id'] === submittedValues['commerce-id'] &&
                  draft['commerce-version'] === submittedValues['commerce-version']) {
                draft['commerce-version'] = String(saved.version);
                for (const form of activeForms)
                  form.elements.namedItem('commerce-version').value = String(saved.version);
              }
            }
            if (matches(S.route) && !$('#main form[data-commerce-draft]')) A.render();
            A.notify(unchanged ? '记录已保存到本机' : '记录已保存，后续输入已保留');
          }
        },
        async (error) => {
          if (error?.status === 409) {
            try {
              acceptLocalCommerce(await localData.load('commerce'));
              await Promise.all(participants.map((item) => item.reload?.()));
            } catch {
              localPhase = 'error';
            }
            A.notify(`${error.message || '资料已经变化'}。本次未保存，请重新打开并核对当前数据`);
          } else if (error?.status >= 400 && error.status < 500) {
            A.notify('本机保存失败，未登记本次操作，请重新核对');
          } else {
            localPhase = 'error';
            A.notify('暂时无法确认本机保存结果，请刷新页面核对记录后再提交');
          }
        }
      )
      .finally(() => {
        saving = false;
      });
  }
  function log(type, entityId, detail, relatedOrderId) {
    logs.unshift({
      id: uid('commerce-log'),
      type,
      entityId,
      detail,
      ...(relatedOrderId ? { relatedOrderId } : {}),
      at: now(),
      actor: currentOperator().name || '历史未记录',
      actorId: currentOperator().id
    });
  }
  function normalizedPlan(plan) {
    return (
      {
        plus: 'Plus',
        pro: 'Pro 100',
        pro100: 'Pro 100',
        pro200: 'Pro 200',
        pro500: 'Pro 500',
        'Pro 5x': 'Pro 100',
        'Pro 20x': 'Pro 200',
        'Pro 50x': 'Pro 500',
        go: 'Go',
        max5: 'Max 5x',
        max20: 'Max 20x',
        pro_5x: 'Pro 100',
        pro_20x: 'Pro 200',
        pro_50x: 'Pro 500'
      }[plan] ||
      plan ||
      'Plus'
    );
  }
  function isExternal(source) {
    return /vendure|兑换码|cdk|redeem/i.test(String(source));
  }
  function parseDate(text) {
    const date = String(text || '').replace(' ', 'T');
    if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(date))
      return Date.parse(date + '+08:00');
    return /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(date) ? Date.parse(date) : NaN;
  }
  function dateInput(text) {
    const timestamp = parseDate(text);
    return Number.isFinite(timestamp) ? beijingClock.format(timestamp).replace(' ', 'T') : '';
  }
  function customerLabel(id) {
    return customers.find((row) => row.id === id)?.name || '待补充客户';
  }
  function tenantLabel(id) {
    return tenants.find((row) => row.id === id)?.name || '未关联租户';
  }
  function cleanClose(key) {
    if (key) {
      S.drafts.delete(key);
      for (const form of document.querySelectorAll('form[data-commerce-draft]'))
        if (form.dataset.commerceDraft === key) form.removeAttribute('data-commerce-draft');
    }
    const drawer = $('#drawer');
    if (drawer?.open) drawer.close();
    S.drawerContext = '';
  }
  function field(label, id, control, required = false, help = '', span = '', hidden = false) {
    const html = A.field(label, `commerce-${id}`, control, required, help)
      .replace(`for="commerce-${id}"`, `for="commerce-${id}${control.includes(`id="commerce-${id}-picker"`) ? '-picker' : ''}"`);
    const attributes = `data-commerce-field="${id}"${hidden ? ' hidden' : ''}`;
    return span
      ? `<div class="${span}" ${attributes}>${html}</div>`
      : html.replace('<div class="field"', `<div class="field" ${attributes}`);
  }
  function input(id, initial = '', attributes = '') {
    return A.input(`commerce-${id}`, initial, attributes);
  }
  function select(id, choices, selected = '') {
    return A.select(`commerce-${id}`, choices, selected);
  }
  function searchableSelect(id, label, choices, selected = '', actions = '', editable = '') {
    const value = choices.find(([value]) => String(value) === String(selected))?.[1] || choices[0]?.[1] || '请选择';
    const prefix = `commerce-${id}`;
    const control = select(id, choices, selected).replace('<select ', '<select hidden aria-hidden="true" tabindex="-1" ');
    return `<div class="commerce-search-picker field-row${editable ? ' commerce-email-history' : ''}">
      ${editable}
      <button type="button" id="${prefix}-picker" class="button commerce-picker-trigger"
        role="combobox" aria-label="${E(label)}" aria-expanded="false" aria-haspopup="listbox"
        aria-controls="${prefix}-options" aria-describedby="${editable ? 'commerce-email' : prefix}-error"
        popovertarget="${prefix}-popover" title="${E(value)}">
        <span class="commerce-picker-label">${editable ? '历史邮箱' : E(value)}</span>${A.icon('down')}
      </button>
      ${editable ? control.replace(` name="${prefix}"`, '') : control}${actions}
      <div class="commerce-picker-popover" id="${prefix}-popover" popover="auto">
        <input type="search" data-commerce-picker="${id}" aria-label="搜索${E(label)}"
          placeholder="搜索${E(label)}" aria-controls="${prefix}-options" autocomplete="off" />
        <div id="${prefix}-options" class="commerce-picker-options" role="listbox" aria-label="${E(label)}"></div>
        <p class="commerce-picker-empty" role="status" hidden>没有匹配的${E(label)}</p>
      </div>
    </div>`;
  }
  function filterPicker(search) {
    const picker = search.closest('.commerce-search-picker');
    const select = picker?.querySelector('select');
    if (!select) return;
    const trigger = picker.querySelector('.commerce-picker-trigger');
    const label = select.selectedOptions[0]?.text || select.options[0]?.text || '请选择';
    if (!picker.classList.contains('commerce-email-history')) {
      trigger.querySelector('.commerce-picker-label').textContent = label;
      trigger.title = label;
    } else trigger.title = select.disabled ? '该客户暂无可选历史邮箱' : '选择历史邮箱，或直接在输入框填写新邮箱';
    trigger.disabled = select.disabled;
    const popup = picker.querySelector('.commerce-picker-popover');
    if (!popup.matches(':popover-open')) return;
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const options = [...select.options].filter(option => !option.disabled &&
      (option.value ? terms.every(term => option.text.toLowerCase().includes(term)) : terms.length === 0));
    picker.querySelector('.commerce-picker-options').innerHTML = options.map(option =>
      `<button type="button" class="commerce-picker-option" role="option" aria-selected="${option.selected}" tabindex="-1" data-action="commerce-picker-select" data-value="${E(option.value)}">${E(option.text)}</button>`).join('');
    picker.querySelector('.commerce-picker-empty').hidden = options.some(option => option.value);
  }
  function positionPicker(popup) {
    const trigger = popup.closest('.commerce-search-picker').querySelector('.commerce-picker-trigger');
    const anchor = trigger.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight) {
      popup.hidePopover();
      return;
    }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;
    const below = top + height - anchor.bottom - 8;
    const above = anchor.top - top - 8;
    const openBelow = below >= Math.min(280, above);
    popup.style.width = `${Math.min(Math.max(anchor.width, 240), width - 16)}px`;
    popup.style.maxHeight = `${Math.max(80, Math.min(320, height - 16, openBelow ? below : above))}px`;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(left + 8, Math.min(anchor.left, left + width - bounds.width - 8))}px`;
    popup.style.top = `${Math.max(top + 8, Math.min(openBelow ? anchor.bottom + 4 : anchor.top - bounds.height - 4, top + height - bounds.height - 8))}px`;
  }
  function section(number, title, body, description = '', hidden = false, idPrefix = 'commerce-section', actions = '') {
    return `<section class="form-section" data-commerce-section="${number}"${hidden ? ' hidden' : ''}><div class="section-heading${actions ? ' section-heading--actions' : ''}"><span class="section-number">${number}</span><div class="section-title-row"><h2>${E(title)}</h2>${A.titleInfo(title, description, `${idPrefix}-${number}`)}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div><div class="commerce-field-grid">${body}</div></section>`;
  }
  function panelTitle(title, description = '', actions = '', actionAttributes = '') {
    return `<div class="panel-heading"><div class="section-title-row"><h2>${E(title)}</h2>${A.titleInfo(title, description, `commerce-panel-${title.replace(/\s/g, '')}`)}</div><div class="toolbar-right"${actionAttributes ? ` ${actionAttributes}` : ''}>${actions}</div></div>`;
  }
  function routeButton(label, route, kind = '', icon = '') {
    return A.button(label, 'commerce-go', kind, icon, `data-route="${E(route)}"`);
  }
  function tabs(choices, active, action, attributes = '') {
    return `<div class="tabs" role="tablist"${attributes ? ` ${attributes}` : ''}>${choices.map(([id, name]) => `<button class="tab ${id === active ? 'active' : ''}" role="tab" aria-selected="${id === active}" data-action="${action}" data-tab="${id}">${E(name)}</button>`).join('')}</div>`;
  }
  function toolbar(placeholder, actions = '', actionAttributes = '') {
    return `<div class="toolbar"><div class="toolbar-left"><div class="search-field">${A.icon('search')}<input id="commerce-search" aria-label="搜索当前列表" placeholder="${E(placeholder)}" value="${E(S.query || '')}" /></div></div><div class="toolbar-right"${actionAttributes ? ` ${actionAttributes}` : ''}>${actions}</div></div>`;
  }
  function property(label, content, raw = false) {
    return `<div class="property-row"><span>${E(label)}</span><strong>${raw ? content : E(content || '—')}</strong></div>`;
  }
  function timeline(entityId) {
    const rows = logs.filter((row) => row.entityId === entityId);
    return rows.length
      ? `<ul class="timeline">${rows.map((row) => `<li><div><strong>${E(row.type)}</strong><p>${E(row.at)} · ${E(localData?.operatorLabel?.(row.actorId, row.actor) || row.actor)} · ${E(row.detail)}</p></div></li>`).join('')}</ul>`
      : A.empty('暂无操作记录', '新的修改、退款、续费和付款登记会显示在这里。');
  }
  function costsFor(order) {
    const rules = order.costSettings || costSettings,
      rates = order.rates || fxRates;
    if (!amountValid(order.paidAmount || ''))
      return { total: null, items: [], label: '代付金额未确认' };
    let base = cny(order.paidAmount, order.paidCurrency, rates);
    const items = [{ label: order.payment === '苹果内购' ? '订阅面额' : '代付金额', amount: base }];
    if (order.product.startsWith('Claude')) {
      if (order.payment === '苹果内购') {
        base = M.multiply(base, rules.appleDiscount);
        items[0] = { label: `苹果内购折扣后成本（${rules.appleDiscount}）`, amount: base };
      } else {
        items.push({ label: '代付服务费', amount: cny(rules.claudeBankFeeMyr, 'MYR', rates) });
        items.push({
          label: 'KYC 认证成本',
          amount: cny(rules.claudeAccountCostMyr, 'MYR', rates)
        });
      }
    } else if (order.payment === '银行卡') {
      const issue = order.issueFeeSnapshot || issueFeeSnapshot(order, rules);
      if (issue.applied)
        items.push({
          label: `本卡首次开卡费（${issue.cardId}）`,
          amount: cny(issue.amountUsd, 'USD', rates)
        });
      items.push({ label: '支付比例手续费', amount: M.multiply(base, rules.cardPercent) });
      items.push({ label: '每笔固定手续费', amount: cny(rules.cardPerPaymentUsd, 'USD', rates) });
    }
    const returned =
      order.payment === '苹果内购'
        ? A.modules.appleBalance?.getOrderLedger?.(order.id)?.returned || '0'
        : '0';
    let appleReturnCost = '0';
    if (M.compare(returned, '0') > 0) {
      appleReturnCost = cny(returned, order.paidCurrency, rates);
      if (isClaude(order)) appleReturnCost = M.multiply(appleReturnCost, rules.appleDiscount);
      items.push({ label: 'Apple 余额已退回成本', amount: M.subtract('0', appleReturnCost) });
    }
    if (
      amountValid(order.emailCostAmount || '0') &&
      M.compare(order.emailCostAmount || '0', '0') > 0
    )
      items.push({
        label: '补充邮箱成本',
        amount: cny(order.emailCostAmount, order.emailCostCurrency || 'CNY', rates)
      });
    const standard = sum(items, (row) => row.amount);
    const actual =
      order.costBasis === 'actual' && amountValid(order.actualCostAmount || '')
        ? M.subtract(cny(order.actualCostAmount, order.actualCostCurrency, rates), appleReturnCost)
        : null;
    return {
      total: actual ?? standard,
      standard,
      actual,
      appleReturnCost,
      items,
      label: actual !== null ? '实际净成本（已减到账退回）' : '标准净成本'
    };
  }
  function cards() {
    return localData ? orderCards : A.modules.operations?.getResources?.('cards') || [];
  }
  const cardTail = (card) => card?.last4 || card?.last6 || '';
  const cardLabel = (id) => cards().find((row) => row.id === id)?.name || '原付款银行卡';
  function poolUsage(id) {
    const card = cards().find((row) => row.id === id);
    if (!card || !localData) return '';
    return [
      card.lastUsedAt ? `最近使用 ${dateInput(card.lastUsedAt).replace('T', ' ')}` : '',
      Array.isArray(card.sources) && card.sources.length ? `来源 ${card.sources.join('、')}` : ''
    ].filter(Boolean).join(' · ');
  }
  function refreshPoolUsage(form) {
    const row = form.querySelector('[data-commerce-pool-usage]');
    if (row) {
      row.textContent = poolUsage(form.elements['commerce-cardId']?.value);
      row.hidden = !row.textContent;
    }
  }
  function cardChoices(product, tenantId, selected, savedTail = '') {
    const gpt = product === 'GPT';
    const items = gpt ? cards() : (tenantCards.get(tenantId)?.items || []);
    const options = items.filter((row) => (gpt ? row.status !== '停用' && row.active !== false : row.active) || row.id === selected)
      .map((row) => [row.id, [row.label || row.name, `尾号 ${cardTail(row)}`, gpt && Number.isInteger(row.usageCount) ? `已用 ${row.usageCount} 次` : ''].filter(Boolean).join(' · ')]);
    if (selected && !options.some(([id]) => id === selected)) options.unshift([selected, savedTail ? `已选银行卡 · 尾号 ${savedTail}` : '已选银行卡']);
    return [['', gpt ? '选择银行卡' : '选择租户银行卡'], ...options];
  }
  async function loadOrderCards(form, force = false) {
    if (!localData || form.elements['commerce-payment']?.value !== '银行卡') return;
    const product = form.elements['commerce-product'].value;
    const tenantId = form.elements['commerce-tenantId']?.value || '';
    const select = form.elements['commerce-cardId'];
    if (!select || select.tagName !== 'SELECT') return;
    const loadKey = product === 'GPT' ? 'gpt' : tenantId;
    if (!loadKey || (!force && cardLoads.get(form)?.key === loadKey)) return;
    const request = { key: loadKey };
    cardLoads.set(form, request);
    try {
      const snapshot = product === 'GPT' ? await localData.orderCards() : await localData.tenantCards(tenantId);
      if (cardLoads.get(form) !== request) return;
      if (product === 'GPT') orderCards = snapshot.items || [];
      else tenantCards.set(tenantId, snapshot);
      if (form.isConnected && (product === 'GPT' || form.elements['commerce-tenantId'].value === tenantId)) {
        select.innerHTML = A.options(cardChoices(product, tenantId, select.value, form.elements['commerce-paymentId'].value), select.value);
        const search = select.closest('.commerce-search-picker')?.querySelector('input[type="search"]');
        if (search) filterPicker(search);
        if (product === 'GPT') refreshPoolUsage(form);
        A.setError('commerce-cardId', '');
      }
    } catch (error) {
      if (cardLoads.get(form) !== request) return;
      cardLoads.delete(form);
      if (form.isConnected) A.setError('commerce-cardId', error.message || '未能读取银行卡，请重试');
    }
  }
  function cardIssueRecorded(cardId, excludeId = '') {
    return (
      Boolean(cardId) &&
      orders.some(
        (row) =>
          row.id !== excludeId &&
          row.issueFeeSnapshot?.applied &&
          row.issueFeeSnapshot.cardId === cardId
      )
    );
  }
  function issueFeeSnapshot(order, settings = costSettings) {
    const existing = orders.find((row) => row.id === order.id);
    if (existing?.issueFeeSnapshot && existing.cardId === order.cardId)
      return safeClone(existing.issueFeeSnapshot);
    return {
      cardId: order.cardId || '',
      applied:
        order.product === 'GPT' &&
        order.payment === '银行卡' &&
        Boolean(order.cardId) &&
        Boolean(order.includeIssueFee) &&
        !cardIssueRecorded(order.cardId, order.id),
      amountUsd: settings.cardIssueUsd,
      at: now()
    };
  }
  function completenessReasons(order) {
    const reasons = [];
    if (!order.customerId) reasons.push('客户待补充');
    if (!order.email && (order.product !== 'GPT' || order.businessType === '成品交付')) reasons.push('账号待补充');
    if (!amountValid(order.saleAmount || '')) reasons.push('售卖金额待补充');
    if (!amountValid(order.paidAmount || '') || !order.paidCurrency) reasons.push('代付金额或币种待核对');
    if (!order.start || !order.expiry) reasons.push('订阅周期待补充');
    if (!order.paymentId) reasons.push('支付资料待补充');
    if (order.payment === '银行卡' && order.product === 'GPT' && !order.cardId && !order.taskId) reasons.push('银行卡待确认');

    return reasons;
  }
  function localAccounting(order, currency = costSettings.currency) {
    return finance?.calculateOrder(order, {
      currency,
      appleLedger: order.payment === '苹果内购'
        ? A.modules.appleBalance?.getOrderLedger?.(order.id)
        : undefined
    }) || { status: 'pending', reason: '汇率核算模块尚未接入' };
  }
  function pendingReasons(order, accounting) {
    const reasons = completenessReasons(order);
    if (!order.receiptConfirmed) reasons.push('实收待确认');
    if (!order.paidConfirmed) reasons.push('代付结果待确认');
    if (!order.costConfirmed) reasons.push('成本口径待确认');
    if (order.issueFeeSnapshot?.pending) reasons.push('首次开卡费待核对');
    if (localData) {
      const result = accounting || localAccounting(order);
      if (result.status !== 'ready') reasons.push(result.reason);
    }
    return reasons;
  }
  function paymentStatus(order) {
    return order.paidConfirmed || hasPaymentHistory(order)
      ? '已付款'
      : amountValid(order.paidAmount || '')
        ? '付款待核对'
        : '未登记付款';
  }
  function subscriptionStatus(order) {
    if (order.subscriptionEnded) return '已终止';
    if (!order.expiry || !order.start) return '待确认';
    if (parseDate(order.start) > parseDate(now())) return '未开始';
    return parseDate(order.expiry) > parseDate(now()) ? '有效' : '已过期';
  }
  function refundStatus(order) {
    const total = sum(order.refunds || [], (row) => row.amount);
    return M.compare(total, '0') <= 0
      ? '未退款'
      : M.compare(total, order.saleAmount || '0') >= 0
        ? '全额退款'
        : '部分退款';
  }
  function accountStatus(order) {
    return { active: '使用中', frozen: '冻结', abandoned: '弃用' }[
      operating.get(String(order.email).toLowerCase())?.status || 'active'
    ];
  }
  function independentStatuses(order) {
    return {
      payment: paymentStatus(order),
      completeness: orderStatus(order),
      subscription: subscriptionStatus(order),
      refund: refundStatus(order),
      account: accountStatus(order),
      business: order.cancelled ? '已撤单' : '正常'
    };
  }
  function isClaude(order) {
    return String(order?.product || '').startsWith('Claude');
  }
  function availableStock(product) {
    return A.modules.inventory?.listDeliverableAccounts?.(product) ||
      A.modules.inventory?.listAvailableAccounts?.(product) || [];
  }
  function appleAccounts() {
    return A.modules.appleBalance?.list?.() || [];
  }
  function appleMatch(plan, min, max) {
    const band = appleMatchDefaults[normalizedPlan(plan)] || ['', ''];
    return [min || band[0], max ?? band[1]];
  }
  function previousAppleOrder(order) {
    return orders.filter((row) => row.id !== order.id && row.product === order.product &&
      order.email && row.email?.toLowerCase() === order.email.toLowerCase() && row.appleIdId &&
      row.payment === '苹果内购' && row.paidConfirmed && !row.cancelled)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)))[0];
  }
  function appleEligible(wallet, order) {
    if (localData && (wallet.status !== '正常' || (wallet.health && wallet.health !== 'normal'))) return false;
    if (wallet.currency !== 'USD' || !amountValid(wallet.balance || '') ||
        (amountValid(order.paidAmount || '') && M.compare(wallet.balance, order.paidAmount) < 0)) return false;
    if (order.businessType === '续费') return previousAppleOrder(order)?.appleIdId === wallet.id;
    const [min, max] = appleMatch(order.plan, order.appleMatchMin, order.appleMatchMax);
    return amountValid(min) && (!max || amountValid(max)) && M.compare(wallet.balance, min) >= 0 &&
      (!max || M.compare(wallet.balance, max) <= 0) &&
      !orders.some((row) => row.id !== order.id && row.appleIdId === wallet.id && row.paidConfirmed) &&
      !A.modules.appleBalance?.entries?.(wallet.id).some((row) => row.orderId);
  }
  function appleOptions(selectedId, order) {
    const wallets = appleAccounts();
    const choices = wallets.filter((wallet) => wallet.id === selectedId || appleEligible(wallet, order))
      .map((wallet) => [wallet.id, appleLabel(wallet.id)]);
    if (selectedId && !choices.some(([id]) => id === selectedId)) choices.unshift([selectedId, '已选苹果 ID']);
    return [['', '请选择用于订阅的苹果 ID'], ...choices];
  }
  const appleForms = new WeakSet();
  function loadAppleOptions(form, retry = false) {
    const select = form.querySelector('#commerce-appleIdId');
    if (!localData || !select || (appleForms.has(form) && !retry)) return;
    appleForms.add(form);
    const selectionRendered = Boolean(select.value);
    const previousSelection = select.value || select.parentElement.dataset.selected || '';
    void Promise.all([
      A.modules.appleBalance?.ensureReady?.(),
      A.modules.inventory?.refreshLocalInventory?.()
    ]).then(
      ([ready]) => {
        if (!form.isConnected || !ready) return;
        const selected = select.value || (selectionRendered ? '' : previousSelection);
        select.parentElement.dataset.selected = '';
        select.innerHTML = A.options(appleOptions(selected, orderFromForm(form)), selected);
        const search = select.closest('.commerce-search-picker')?.querySelector('input[type="search"]');
        if (search) filterPicker(search);
      },
      () => appleForms.delete(form)
    );
  }
  function refreshAppleOptions(form) {
    const select = form.elements['commerce-appleIdId'];
    if (!select || form.elements['commerce-payment']?.value !== '苹果内购') return;
    const order = orderFromForm(form);
    select.innerHTML = A.options(appleOptions(select.value, order), select.value);
    const search = select.closest('.commerce-search-picker')?.querySelector('input[type="search"]');
    if (search) filterPicker(search);
  }
  function appleLabel(id) {
    const wallet = A.modules.appleBalance?.get?.(id);
    return wallet
      ? `${wallet.email} · 余额 ${display(wallet.balance)} ${currencyLabel(wallet.currency)}`
      : '请选择苹果 ID';
  }
  function stockChoices(product) {
    return [['', '选择本产品的可用账号'], ...availableStock(product).map(row =>
      [row.email, `${row.email} · ${row.inventoryState === 'claimed' ? '本人已提取' : '库存可用'}`])];
  }
  function refundable(order) {
    return M.subtract(
      order.saleAmount || '0',
      sum(order.refunds || [], (row) => row.amount)
    );
  }
  function bankReturned(order) {
    return sum(order.bankReturns || [], (row) => row.amount);
  }
  function bankReturnLimit(order) {
    return order.payment === '银行卡' && order.paidConfirmed && order.cardId && !order.cancelled
      ? M.subtract(order.paidAmount || '0', bankReturned(order))
      : '0';
  }
  function profit(order, accounting = localData ? localAccounting(order) : null) {
    if (order.cancelled || pendingReasons(order, accounting).length) return null;
    if (localData) return accounting.profit;
    const cost = costsFor(order);
    if (cost.total === null) return null;
    return M.subtract(cny(refundable(order), order.saleCurrency, order.rates), cost.total);
  }
  function shownProfit(order) {
    const amount = profit(order);
    return amount === null || localData ? amount : shownCurrency(amount, costSettings.currency, order.rates);
  }
  function orderStatus(order) {
    return completenessReasons(order).length ? '待补全' : '资料完整';
  }
  function orderNumber() {
    const maximum = localData ? orders.reduce((current, row) =>
      Math.max(current, Number(/^OD-LOCAL-(\d{1,12})$/.exec(row.orderNo)?.[1] || 0)), 0) : orders.length;
    return `OD-${localData ? 'LOCAL' : 'DEMO'}-${String(maximum + 1).padStart(4, '0')}`;
  }
  function seedOrder(index, product, plan, email) {
    return {
      id: `commerce-order-${index}`,
      orderNo: `OD-DEMO-${String(index).padStart(4, '0')}`,
      product,
      plan,
      email,
      customerId: index === 10 ? '' : customers[(index - 1) % customers.length].id,
      accountSource: '客户自有',
      accountId: '',
      businessType: '续费',
      payment: index % 2 ? '银行卡' : '苹果内购',
      paymentId: index % 2 ? '062847' : 'apple.demo@example.test',
      cardId: index % 2 ? (index === 1 ? 'card-demo-1' : 'card-demo-2') : '',
      issueFeeSnapshot: {
        cardId: index === 1 ? 'card-demo-1' : 'card-demo-2',
        applied: index === 1,
        amountUsd: costSettings.cardIssueUsd,
        at: '2026-10-08 14:30'
      },
      paidAmount: index % 2 ? (product === 'GPT' ? '1100' : '100') : '20',
      appleIdId: index % 2 ? '' : 'apple-funding-demo-1',
      paidCurrency: index % 2 ? (product === 'GPT' ? 'PHP' : 'MYR') : 'USD',
      emailCostAmount: '0',
      emailCostCurrency: 'CNY',
      saleAmount: product === 'GPT' ? '180' : '600',
      saleCurrency: 'CNY',
      paidConfirmed: true,
      receiptConfirmed: true,
      costConfirmed: index % 4 !== 0,
      costBasis: 'standard',
      actualCostAmount: '',
      actualCostCurrency: 'CNY',
      start: '2026-10-08T14:30',
      expiry:
        index === 11 ? '2026-10-30T14:30' : index < 4 ? '2026-11-05T14:30' : '2026-11-07T14:30',
      tenantId: product.startsWith('Claude') ? tenants[(index - 1) % tenants.length].id : '',
      owner: '林负责人',
      verifier: index % 3 ? '何认证人' : '',
      verifierPhone: index % 3 ? '演示认证电话 01' : '',
      kyc: index % 3 ? 'KYC 认证' : '未认证',
      phone: '演示订阅电话 01',
      notes: '虚构演示订单，使用演示汇率',
      wechat: customers[(index - 1) % customers.length].wechat,
      customerPhone: customers[(index - 1) % customers.length].phone,
      whatsapp: customers[(index - 1) % customers.length].whatsapp,
      telegram: customers[(index - 1) % customers.length].telegram,
      createdAt: '2026-10-08 14:30',
      createdBy: '林管理员',
      rates: safeClone(fxRates),
      costSettings: safeClone(costSettings),
      rateAt: '演示汇率 · 2026-11-03 09:00 UTC+8',
      refunds:
        index === 10
          ? [
              {
                id: 'refund-demo-partial',
                amount: '30',
                currency: 'CNY',
                at: '2026-11-02 10:30',
                reason: '演示部分退款，订阅仍有效',
                actor: '林管理员'
              }
            ]
          : [],
      corrections: [],
      version: 1,
      source: '管理员手工',
      includeIssueFee: index === 1,
      previousOrderId: '',
      cancelled: false,
      cancellationEvents: [],
      compensations: []
    };
  }
  if (localData) applyCommerceSnapshot(null);
  if (!localData && !orders.some((row) => row.orderNo)) {
    orders.length = 0;
    orders.push(
      seedOrder(1, 'GPT', 'Plus', 'gpt.01@example.test'),
      seedOrder(2, 'GPT', 'Pro 5x', 'gpt.02@example.test')
    );
    for (let index = 0; index < 9; index++) {
      const product = index % 3 === 2 ? 'Claude Pro' : 'Claude Max';
      orders.push(
        seedOrder(
          index + 3,
          product,
          product === 'Claude Pro' ? 'Pro' : index % 2 ? 'Max 20x' : 'Max 5x',
          `claude.${String(index + 1).padStart(2, '0')}@example.test`
        )
      );
    }
  }
  for (const order of orders.filter((row) => row.payment === '苹果内购' && row.appleIdId))
    A.modules.appleBalance?.registerOpeningOrder?.(order);
  for (const order of orders.filter((row) => row.product?.startsWith('Claude'))) {
    operating.set(order.email.toLowerCase(), {
      status: order.email.includes('.08@')
        ? 'frozen'
        : order.email.includes('.09@')
          ? 'abandoned'
          : 'active',
      at: '2026-11-03 09:30',
      reason: ''
    });
  }

  function currentSubscriptions() {
    const current = new Map();
    for (const order of orders.filter(
      (row) =>
        row.product?.startsWith('Claude') &&
        !row.cancelled &&
        row.customerId &&
        !row.subscriptionEnded && !endedInventoryOrder(row)
    )) {
      const prior = current.get(order.email.toLowerCase());
      if (
        !prior ||
        String(order.expiry) > String(prior.expiry) ||
        order.claudeRenewalId === prior.id
      )
        current.set(order.email.toLowerCase(), order);
    }
    return [...current.values()].map((order) => ({
      ...order,
      operation: operating.get(order.email.toLowerCase()) || {
        status: 'active',
        at: order.createdAt,
        reason: ''
      }
    }));
  }
  function orderContactKeys(record, order = true) {
    return orderContactFields.flatMap(([orderField, customerField]) => {
      const contact = contactKey(record[order ? orderField : customerField], customerField);
      return contact ? [`${customerField}:${contact}`] : [];
    });
  }
  function subscriptionFamily(order) {
    return isClaude(order) ? 'Claude' : order.product;
  }
  function subscriptionEmail(order) {
    return String(order.email || '').trim().toLowerCase();
  }
  function sameSubscriptionAccount(a, b) {
    return Boolean(subscriptionEmail(a)) && subscriptionEmail(a) === subscriptionEmail(b) &&
      subscriptionFamily(a) === subscriptionFamily(b);
  }
  function identifyOrderCustomers() {
    const byContact = new Map();
    const index = (keys, id) => {
      for (const key of keys) {
        if (!byContact.has(key)) byContact.set(key, new Set());
        byContact.get(key).add(id);
      }
    };
    for (const row of customers) index(orderContactKeys(row, false), row.id);
    for (const row of orders) if (row.customerId) index(orderContactKeys(row), row.customerId);

    const identities = new Map(), uncertain = new Map(), anonymous = new Map();
    for (const row of orders) {
      if (row.customerId) {
        identities.set(row.id, row.customerId);
        continue;
      }
      const keys = orderContactKeys(row);
      const matches = new Set(keys.flatMap((key) => [...(byContact.get(key) || [])]));
      if (matches.size === 1) {
        identities.set(row.id, [...matches][0]);
      } else if (matches.size || !keys.length) {
        uncertain.set(row.id, matches);
      } else {
        const groups = new Set(keys.map((key) => anonymous.get(key)).filter(Boolean));
        const group = groups.values().next().value || { id: `contact:${row.id}`, keys: new Set(), orders: [] };
        for (const other of groups) {
          if (other === group) continue;
          for (const key of other.keys) group.keys.add(key);
          group.orders.push(...other.orders);
        }
        for (const key of keys) group.keys.add(key);
        group.orders.push(row.id);
        for (const key of group.keys) anonymous.set(key, group);
      }
    }
    for (const group of new Set(anonymous.values()))
      for (const id of group.orders) identities.set(id, group.id);
    return { identities, uncertain };
  }
  function renewalProjection() {
    const { identities, uncertain } = identifyOrderCustomers();
    const evaluatedAt = parseDate(now());
    const deadline = evaluatedAt + renewalWarningHours * 3_600_000;
    const rows = orders.flatMap((order) => {
      const start = parseDate(order.start), expiry = parseDate(order.expiry);
      const subscriptionConfirmed = automaticOrder(order) && Number.isFinite(parseDate(order.rechargeCompletedAt));
      if (!Object.hasOwn(productPlans, order.product) || !Number.isFinite(start) || !(expiry > start) ||
          (!subscriptionConfirmed && paymentStatus(order) !== '已付款')) return [];
      const identity = identities.get(order.id);
      const family = subscriptionFamily(order);
      const email = subscriptionEmail(order);
      const subscription = identity && email ? JSON.stringify([identity, family, email]) : order.id;
      return [{ order, identity, subscription, start, expiry }];
    });
    const latest = new Map(), histories = new Map(), active = new Set(), ambiguous = new Set();
    for (const row of rows) {
      if (row.start <= evaluatedAt && row.identity) {
        const history = histories.get(row.identity) || [];
        history.push(row);
        histories.set(row.identity, history);
      }
      if (row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order)) continue;
      const prior = latest.get(row.subscription);
      if (!prior || row.expiry > prior.expiry || (row.expiry === prior.expiry && row.start > prior.start))
        latest.set(row.subscription, row);
      if (row.start <= evaluatedAt && row.expiry > evaluatedAt) {
        if (row.identity) active.add(row.identity);
        else for (const id of uncertain.get(row.order.id) || []) ambiguous.add(id);
      }
    }
    const decisions = new Map(), links = new Map();
    for (const entry of logs) {
      if (['拒续费', '恢复续费提醒'].includes(entry.type) && !decisions.has(entry.entityId))
        decisions.set(entry.entityId, entry);
      if (entry.type === '关联续费订单') {
        if (!links.has(entry.entityId)) links.set(entry.entityId, []);
        links.get(entry.entityId).push(entry.relatedOrderId);
      }
    }
    const byId = new Map(rows.map((row) => [row.order.id, row]));
    const reminders = [];
    for (const row of rows) {
      if (row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order) || row.start > evaluatedAt) continue;
      const isSuccessor = (candidate) => candidate && candidate !== row && !candidate.order.cancelled &&
        !candidate.order.subscriptionEnded && candidate.expiry > row.expiry && candidate.start >= row.start;
      const automatic = latest.get(row.subscription);
      const successor = isSuccessor(automatic) ? automatic : links.get(row.order.id)?.map((id) => byId.get(id))
        .find((candidate) => isSuccessor(candidate) && sameSubscriptionAccount(candidate.order, row.order) &&
          (!row.identity || row.identity === candidate.identity));
      const decision = decisions.get(row.order.id);
      const refused = decision?.type === '拒续费';
      const state = successor || refused ? 'processed' :
        row.expiry <= evaluatedAt ? 'expired' : row.expiry <= deadline ? 'upcoming' : '';
      if (state) reminders.push({ ...row, state, refused: !successor && refused,
        completed: successor?.order || null, decision });
    }
    return { reminders, histories, active, ambiguous, unresolved: rows.filter((row) =>
      !row.identity && row.start <= evaluatedAt) };
  }
  function customerForOrder(row, identity) {
    const customer = customers.find((item) => item.id === identity);
    return {
      name: customer?.name || row.customerName || row.customer || '待补充客户',
      ...Object.fromEntries(orderContactFields.map(([key, field]) => [key, customer?.[field] || row[key] || '']))
    };
  }
  function renewalContactColumns() {
    return [
      { id: 'name', label: '客户' },
      { id: 'wechat', label: '微信' },
      { id: 'whatsapp', label: 'WhatsApp' },
      { id: 'customerPhone', label: '联系电话' }
    ];
  }
  function renderRenewals() {
    const { reminders } = renewalProjection();
    const states = [['upcoming', '即将到期'], ['expired', '已到期'], ['processed', '已处理']];
    const tabsWithCounts = states.map(([key, title]) =>
      [key, `${title} ${reminders.filter((row) => row.state === key).length}`]);
    const products = [['', '全部产品'], ...Object.keys(productPlans),
      ...pendingRenewalProducts.map((product) => [product, `${product}（待接入）`])];
    const rows = reminders.filter(({ order, state }) =>
      state === moduleState.renewalTab && (!S.status || order.product === S.status)
    ).map((row) => ({ ...row.order, ...row, ...customerForOrder(row.order, row.identity) }))
      .filter((row) => matchesRenewalSearch(row, row.order))
      .sort((left, right) => left.expiry - right.expiry);
    const columns = [
      ...renewalContactColumns(),
      { id: 'product', label: '产品' },
      { id: 'plan', label: '套餐' },
      { id: 'email', label: '账号' },
      { id: 'orderNo', label: '订单编号' },
      { id: 'due', label: '到期时间', render: (row) => E(dateInput(row.order.expiry).replace('T', ' ')) },
      ...(moduleState.renewalTab === 'processed' ? [
        { id: 'result', label: '处理结果', render: (row) => A.tag(row.refused ? '已拒续' : '已续费') },
        { id: 'processedBy', label: '操作人', render: (row) => E(row.refused ? row.decision.actor : traceName(row.completed, 'createdBy')) },
        { id: 'processedAt', label: '处理时间', render: (row) => E(row.refused ? row.decision.at : row.completed.createdAt || '历史未记录') }
      ] : []),
      { id: 'actions', label: '操作', action: true, render: (row) =>
        `<div class="action-links">${A.textAction('订单', 'commerce-order-detail', `data-id="${E(row.id)}"`)}${
          row.refused ? A.textAction('恢复提醒', 'commerce-renewal-restore', `data-id="${E(row.id)}"`) :
          row.completed ? A.textAction('新订单', 'commerce-order-detail', `data-id="${E(row.completed.id)}"`) :
          A.textAction('续费', 'commerce-renewal-open', `data-id="${E(row.id)}"`) +
          A.textAction('拒续费', 'commerce-renewal-refuse', `data-id="${E(row.id)}"`)
        }</div>` }
    ];
    return A.header('续费管理', '到期提醒使用北京时间。续费通过提交订单登记，拒续只停止该单提醒。',
      A.button('提醒设置', 'commerce-renewal-settings', '', 'settings')) +
      `<section class="panel">${tabs(tabsWithCounts, moduleState.renewalTab, 'commerce-renewal-tab', 'aria-label="续费状态"')}
      ${toolbar('搜索客户、联系方式、账号或订单编号', `<label for="commerce-renewal-product">产品</label>${select('renewal-product', products, S.status)}<span class="footnote">提前 ${formatRenewalWarning(renewalWarningHours)}提醒</span>`)}
      ${pendingRenewalProducts.includes(S.status) ? A.empty('订单待接入', '对应订单模块启用后，将自动纳入续费提醒。') :
        tableList(columns, rows, 'commerce-renewals')}</section>`;
  }
  function matchesRenewalSearch(contact, order) {
    const query = String(S.query || '').trim().toLowerCase();
    return !query || [contact.name, ...orderContactFields.map(([key]) => contact[key]),
      order.email, order.orderNo, order.product, order.plan].join(' ').toLowerCase().includes(query);
  }
  function renderCustomerLoss() {
    const { histories, active, ambiguous, unresolved } = renewalProjection();
    const rows = [];
    for (const [id, history] of histories) {
      if (active.has(id)) continue;
      const last = history.reduce((a, b) => a.expiry >= b.expiry ? a : b);
      const contact = customerForOrder(last.order, id);
      rows.push({ id, ...contact, ...last, review: ambiguous.has(id) });
    }
    for (const row of unresolved)
      rows.push({ ...row, ...customerForOrder(row.order), id: row.order.id, review: true });
    const review = S.status === 'review';
    const selected = rows.filter((row) => row.review === review && matchesRenewalSearch(row, row.order))
      .sort((a, b) => b.expiry - a.expiry);
    const columns = [
      ...renewalContactColumns(),
      { id: 'qq', label: 'QQ' },
      { id: 'telegram', label: 'Telegram' },
      { id: 'lastProduct', label: '最近业务', render: ({ order }) => E(`${order.product} · ${order.plan}`) },
      { id: 'lastExpiry', label: '最后到期', render: ({ order }) => E(dateInput(order.expiry).replace('T', ' ')) },
      { id: 'actions', label: '操作', action: true, render: (row) =>
        row.identity
          ? A.textAction('历史订单', 'commerce-loss-history', `data-id="${E(row.identity)}"`)
          : A.textAction('查看订单', 'commerce-order-detail', `data-id="${E(row.order.id)}"`) }
    ];
    return A.header('客户流失', '曾确认开通且当前没有有效订阅的客户。换账号或换产品开通后会自动退出。') +
      `<section class="panel">${tabs([['', `客户流失 ${rows.filter((row) => !row.review).length}`],
        ['review', `待核对 ${rows.filter((row) => row.review).length}`]], S.status, 'commerce-loss-tab', 'aria-label="客户流失状态"')}
      ${toolbar('搜索客户、联系方式或最近业务')}${tableList(columns, selected, 'commerce-customer-loss')}</section>`;
  }
  function showCustomerLossHistory(id) {
    const { identities } = identifyOrderCustomers();
    const history = orders.filter((row) => identities.get(row.id) === id)
      .sort((a, b) => (parseDate(b.start) || 0) - (parseDate(a.start) || 0));
    if (!history.length) return;
    const columns = [
      { id: 'orderNo', label: '订单编号' },
      { id: 'product', label: '产品' },
      { id: 'plan', label: '套餐' },
      { id: 'email', label: '账号' },
      { id: 'expiry', label: '到期时间', render: (row) => E(dateInput(row.expiry).replace('T', ' ')) },
      { id: 'actions', label: '操作', action: true, render: (row) =>
        A.textAction('详情', 'commerce-order-detail', `data-id="${E(row.id)}"`) }
    ];
    A.openDrawer('历史订单', '', A.table(columns, history, '', 'commerce-loss-history'),
      A.button('关闭', 'drawer-close'));
  }
  function formatRenewalWarning(totalHours) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return [days && `${days} 天`, hours && `${hours} 小时`].filter(Boolean).join(' ');
  }
  function openRenewalSettings() {
    const key = 'commerce-renewal-settings';
    const draft = S.drafts.get(key);
    const days = draft?.['commerce-renewal-days'] ?? Math.floor(renewalWarningHours / 24);
    const hours = draft?.['commerce-renewal-hours'] ?? renewalWarningHours % 24;
    A.openDrawer('提醒设置', '全站共用这项设置，保存后立即更新提醒列表。',
      `<form id="commerce-renewal-settings" data-commerce-draft="${key}" novalidate><div class="commerce-field-grid">${
        field('提前天数', 'renewal-days',
          input('renewal-days', days, `type="number" min="0" max="${maxWarningHours / 24}" step="1"`))
      }${
        field('提前小时数', 'renewal-hours',
          input('renewal-hours', hours, 'type="number" min="0" max="23" step="1"'))
      }</div><p class="footnote">少于 1 天时只填小时。两项合计最短 1 小时，最长 365 天。</p></form>`, A.button('取消', 'drawer-close') +
      '<button type="submit" form="commerce-renewal-settings" class="button primary">保存设置</button>', key);
  }
  function saveRenewalSettings(form) {
    const data = A.readForm(form);
    const days = Number(value(data, 'renewal-days'));
    const hours = Number(value(data, 'renewal-hours'));
    const totalHours = days * 24 + hours;
    const dayError = Number.isInteger(days) && days >= 0 && days <= maxWarningHours / 24
      ? '' : '请填写 0 至 365 的整数';
    const hourError = !Number.isInteger(hours) || hours < 0 || hours > 23
      ? '请填写 0 至 23 的整数'
      : !dayError && (totalHours < 1 || totalHours > maxWarningHours)
        ? '合计须在 1 小时至 365 天之间'
        : '';
    A.setError('commerce-renewal-days', dayError);
    A.setError('commerce-renewal-hours', hourError);
    if (dayError || hourError) return;
    const duration = formatRenewalWarning(totalHours);
    persistCommerce('更新续费提醒设置', () => {
      renewalWarningHours = totalHours;
      log('更新续费提醒设置', 'renewal-settings', `提前 ${duration}`);
    }, () => {
      cleanClose(form.dataset.commerceDraft);
      A.render();
      A.notify(`已设为提前 ${duration}提醒`);
    });
  }
  function changeRenewalDecision(id, restore) {
    const canChange = () => renewalProjection().reminders.some((row) =>
      row.order.id === id && (restore ? row.refused : row.state !== 'processed'));
    if (!canChange()) return;
    const order = orders.find((row) => row.id === id);
    const action = restore ? '恢复续费提醒' : '拒续费';
    A.confirmAction(action,
      `${order.orderNo} · ${order.email}。${
        restore ? '恢复后按当前到期时间计算提醒。' : '确认客户不续这笔订单，停止该单提醒。'
      }`, () => {
        if (S.route !== renewalRoute || !canChange()) return;
        persistCommerce(action, () => log(action, id, order.orderNo), () => {
          A.render();
          A.notify(restore ? '已恢复提醒' : '已登记拒续费');
        });
      }, '确认');
  }
  function readCommerceDraft(form) {
    const draft = A.readDraft(form);
    const owner = form.querySelector?.('select#commerce-ownerId');
    if (owner) draft['commerce-ownerId'] = owner.value;
    delete draft['commerce-balanceReversalConfirmed'];
    return draft;
  }
  function recordForDraft(data, formId, values) {
    const id = values['commerce-id'];
    if (!id) return null;
    if (formId === 'commerce-contact-form')
      return data?.[values['commerce-kind'] === 'tenant' ? 'tenants' : 'customers']?.find(row => row.id === id);
    if (formId === 'commerce-rent-payment-form')
      return data?.rentBatches?.find(row => row.id === values['commerce-batchId'])?.items?.find(row => row.id === id);
    return data?.orders?.find(row => row.id === id);
  }
  function saveDrafts() {
    for (const form of document.querySelectorAll(
      '#main form[data-commerce-draft], #drawer[open] form[data-commerce-draft]'
    )) {
      const draft = readCommerceDraft(form);
      S.drafts.set(form.dataset.commerceDraft, draft);
    }
  }
  function tableList(columns, rows, tableId, scope = '') {
    return A.table(columns, A.pageRows(rows), scope, tableId) + A.pagination(rows.length);
  }
  function columnSettingsButton(tableId) {
    return A.button('列设置', 'column-settings', '', 'columns', `data-table-id="${E(tableId)}"`);
  }
  function currentOperator() {
    return localData
      ? (localData.actor?.() || (localData.authRequired ? {} : { id: 'local-operator', name: '本机操作员' }))
      : { id: S.actor?.id || '', name: S.actor?.name || '' };
  }
  function canManageOrders() {
    return !localData?.authRequired || ['admin', 'super'].includes(currentOperator().role);
  }
  function orderOwnerName(row) {
    const id = row.ownerId || row.rechargeOwnerId || row.createdById;
    const fallback = row.ownerId ? row.owner || '历史未记录' : traceName(row, 'createdBy');
    return localData?.operatorLabel?.(id, fallback) || fallback;
  }
  let orderOwners = [];
  const orderOwnerLoads = new WeakMap();
  function orderOwnerChoices(selected) {
    const rows = new Map([currentOperator(), ...orderOwners].filter(row => row.id).map(row => [row.id, row]));
    const choices = [...rows.values()].map(row => [row.id,
      `${row.name} · ${{ super: '超级管理员', admin: '管理员', employee: '员工' }[row.role] || '当前账号'}`]);
    if (selected && !rows.has(selected)) choices.push([selected, '已选归属人（待核对）']);
    return choices;
  }
  function orderOwnerField(v, existing) {
    if (existing || !canManageOrders())
      return field('归属人', 'ownerId', `<input id="commerce-ownerId" value="${E(orderOwnerName(existing || {
        ownerId: currentOperator().id, owner: currentOperator().name
      }))}" readonly />`, false, existing ? '保留原单归属；录入人与操作记录分别保留。' : '订单归属当前登录账号。');
    const selected = v('ownerId') || currentOperator().id || '';
    return field('归属人', 'ownerId', searchableSelect('ownerId', '归属人', orderOwnerChoices(selected), selected,
      A.button('刷新', 'commerce-order-owner-refresh')), true, '可代员工录单，录入人仍记录当前登录账号。');
  }
  async function loadOrderOwners(form, retry = false) {
    const select = form?.querySelector('select#commerce-ownerId');
    if (!select || !localData?.authRequired || !localData.orderOwners ||
        (orderOwnerLoads.has(form) && !retry)) return;
    const request = {};
    orderOwnerLoads.set(form, request);
    const trigger = form.querySelector('#commerce-ownerId-picker');
    trigger.setAttribute('aria-busy', 'true');
    try {
      const { items } = await localData.orderOwners();
      if (!Array.isArray(items) || items.some(row => typeof row.id !== 'string' || !row.name ||
          !['admin', 'super', 'employee'].includes(row.role))) throw new Error('人员列表格式不正确');
      if (!form.isConnected || orderOwnerLoads.get(form) !== request) return;
      orderOwners = items;
      const selected = select.value;
      select.innerHTML = A.options(orderOwnerChoices(selected), selected);
      const valid = selected === currentOperator().id || items.some(row => row.id === selected);
      if (!valid) select.selectedOptions[0].disabled = true;
      filterPicker(select.closest('.commerce-search-picker').querySelector('[data-commerce-picker]'));
      A.setError('commerce-ownerId', valid ? '' : '所选归属人已停用或不存在，请重新选择');
    } catch (error) {
      if (form.isConnected && orderOwnerLoads.get(form) === request) {
        orderOwnerLoads.delete(form);
        A.setError('commerce-ownerId', '人员读取失败，请点击右侧刷新重试；仍可归属当前账号。');
      }
    } finally {
      if (orderOwnerLoads.get(form) === request || !orderOwnerLoads.has(form)) trigger.removeAttribute('aria-busy');
    }
  }
  function traceName(row, key) {
    const fallback = typeof row[key] === 'string' && row[key].trim() ? row[key] : '历史未记录';
    const id = key === 'createdBy' && row.taskId ? row.rechargeOwnerId || row.createdById : row[key + 'Id'];
    const name = localData?.operatorLabel?.(id, fallback) || fallback;
    if (key === 'createdBy' && row.taskId && /^自动充值/.test(fallback))
      return name === fallback ? fallback : `自动充值/${name}`;
    return name;
  }
  function traceColumns() {
    return [
      { id: 'createdBy', label: '录入人', render: (row) => E(traceName(row, 'createdBy')) },
      { id: 'createdAt', label: '录入时间', render: (row) => E(row.createdAt || '历史未记录') },
      { id: 'updatedBy', label: '最近修改人', render: (row) => E(traceName(row, 'updatedBy')) },
      { id: 'updatedAt', label: '最近修改时间', render: (row) => E(row.updatedAt || '历史未记录') }
    ];
  }
  function traceProperties(row) {
    return (
      property('录入人', traceName(row, 'createdBy')) +
      property('录入人编号', row.createdById || '历史未记录') +
      property('录入时间', row.createdAt || '历史未记录') +
      property('最近修改人', traceName(row, 'updatedBy')) +
      property('最近修改人编号', row.updatedById || '历史未记录') +
      property('最近修改时间', row.updatedAt || '历史未记录')
    );
  }
  function customerServices(customerId) {
    const services = new Map();
    for (const order of orders) {
      if (
        order.customerId !== customerId ||
        (!order.paidConfirmed && !hasPaymentHistory(order)) ||
        !order.start
      )
        continue;
      const openedAt = parseDate(order.start);
      if (!Number.isFinite(openedAt) || openedAt > parseDate(now())) continue;
      const name = `${order.product} · ${order.plan}`;
      const service = services.get(name) || {
        id: `${customerId}:${order.product}:${order.plan}`,
        name,
        count: 0,
        firstOpenedAt: order.start,
        lastOpenedAt: order.start,
        orderNos: []
      };
      service.count++;
      if (openedAt < parseDate(service.firstOpenedAt)) service.firstOpenedAt = order.start;
      if (openedAt > parseDate(service.lastOpenedAt)) service.lastOpenedAt = order.start;
      service.orderNos.push(order.orderNo);
      services.set(name, service);
    }
    return [...services.values()];
  }
  function serviceSummary(customerId) {
    return customerServices(customerId)
      .map((service) => `${service.name}（${service.count} 次）`)
      .join('、');
  }
  function renderContacts(tenant = false) {
    const data = tenant ? tenants : customers,
      noun = tenant ? '租户' : '客户';
    const query = String(S.query || '')
      .trim()
      .toLocaleLowerCase();
    const mode = tenant ? moduleState.tenantMode : moduleState.customerMode;
    const rows = data.filter(
      (row) =>
        row.active === (mode === 'active') &&
        (!query ||
          [
            row.name,
            row.phone,
            row.wechat,
            row.qq,
            row.whatsapp,
            row.telegram,
            row.owner,
            row.source,
            row.notes,
            ...(row.tags || []),
            tenant ? '' : serviceSummary(row.id),
            traceName(row, 'createdBy'),
            traceName(row, 'updatedBy')
          ]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query))
    );
    const displayRows = rows.map((row) => ({
      ...row,
      services: tenant ? '' : serviceSummary(row.id)
    }));
    const columns = [
      { id: 'name', label: `${noun}姓名` },
      { id: 'phone', label: '联系电话' },
      ...(tenant
        ? [
            { id: 'owner', label: '归属人' },
            {
              id: 'accounts',
              label: '关联账号',
              render: (row) =>
                String(currentSubscriptions().filter((order) => order.tenantId === row.id).length)
            }
          ]
        : [
            { id: 'wechat', label: '客户微信' },
            { id: 'qq', label: 'QQ' },
            { id: 'whatsapp', label: 'WhatsApp' },
            { id: 'telegram', label: 'Telegram' },
            { id: 'source', label: '来源渠道' },
            {
              id: 'tags',
              label: '客户标签',
              long: true,
              render: (row) => E((row.tags || []).join('、') || '—')
            },
            {
              id: 'services',
              label: '历史开通业务',
              long: true,
              render: (row) => E(serviceSummary(row.id) || '—')
            }
          ]),
      ...traceColumns(),
      { id: 'notes', label: '备注', long: true },
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          `<div class="action-links">${A.textAction('详情', 'commerce-contact-detail', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`)}${A.textAction('编辑', 'commerce-contact-edit', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`)}${A.textAction(row.active ? '停用' : '恢复', 'commerce-contact-disable', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`, 'secondary')}</div>`
      }
    ];
    return (
      A.header(
        `${noun}数据`,
        tenant
          ? '查看租户关联账号、开通周期与逐项付租记录；归属人与资料录入人分别记录。'
          : '客户标签独立维护；历史业务按客户编号关联订单汇总，录入人与最近修改人自动记录。',
        (tenant ? '' : customerSettingsButtons()) + A.button(
          `新增${noun}`,
          'commerce-contact-add',
          'primary',
          'plus',
          `data-kind="${tenant ? 'tenant' : 'customer'}"`
        )
      ) +
      `<section class="panel">${tabs(
        [
          ['active', '使用中'],
          ['inactive', '已停用']
        ],
        mode,
        'commerce-contact-tab'
      )}${toolbar(`搜索${noun}、联系方式、标签、历史业务或录入人`, columnSettingsButton(`commerce-${tenant ? 'tenants' : 'customers'}`), 'data-page-actions')}${tableList(columns, displayRows, `commerce-${tenant ? 'tenants' : 'customers'}`)}</section>`
    );
  }
  function customerSettingsButtons() {
    if (A.modules.operations?.canManageCustomerOptions?.() === false) return '';
    return A.button('来源设置', 'commerce-customer-settings', '', 'settings', 'data-kind="sources"') +
      A.button('标签设置', 'commerce-customer-settings', '', 'settings', 'data-kind="tags"');
  }
  function customerSourceChoices(selected = '') {
    const configured = A.modules.operations?.getCustomerSources?.() ||
      ['微信', 'WhatsApp', 'Telegram', '网站', '客户推荐', '其他'];
    return [['', '请选择来源'], ...configured, ...(selected && !configured.includes(selected)
      ? [[selected, `${selected}（已移出选项）`]] : [])];
  }
  function customerTagPicker(selected, previous, open = false) {
    const configured = A.modules.operations?.getCustomerTags?.() || [];
    const options = [...new Set([...configured, ...previous, ...selected])];
    const choices = options.map((tag) =>
      `<label class="customer-tag-choice"><input type="checkbox" value="${E(tag)}" data-customer-tag${selected.includes(tag) ? ' checked' : ''} /><span>${E(tag)}</span>${configured.includes(tag) ? '' : '<small>历史标签</small>'}</label>`
    ).join('');
    return `<details class="customer-tag-picker" data-customer-tag-picker data-dismiss-outside${open ? ' open' : ''}>
      <summary id="commerce-tags" aria-label="客户标签"><span data-customer-tag-summary>${E(selected.join('、') || '请选择标签（可多选）')}</span>${A.icon('chevron')}</summary>
      <div class="customer-tag-options" role="group" aria-label="客户标签选项">
        ${choices || '<p>暂无可选标签，请点击本页的“标签设置”添加。</p>'}
      </div>
      <input type="hidden" name="commerce-tags" value="${E(JSON.stringify(selected))}" />
    </details>`;
  }
  function refreshCustomerTagOptions() {
    const source = $('#commerce-contact-source');
    if (source) source.innerHTML = A.options(customerSourceChoices(source.value), source.value);
    const picker = $('#commerce-contact-form [data-customer-tag-picker]');
    if (!picker) return;
    const form = picker.closest('form');
    const previous = customers.find((row) => row.id === form.elements['commerce-id'].value)?.tags || [];
    const selected = A.readOptionList(form.elements['commerce-tags'].value);
    const focused = picker.contains(document.activeElement);
    picker.outerHTML = customerTagPicker(selected, previous, picker.open)
      .replace('id="commerce-tags"', 'id="commerce-contact-tags"');
    if (focused) form.querySelector('#commerce-contact-tags')?.focus();
  }
  function contactForm(tenant = false, id = '', quick = false, standalone = false) {
    const data = tenant ? tenants : customers,
      row = data.find((entry) => entry.id === id);
    const key =
      quick && !tenant
        ? `commerce-contact:customer:new:${quickReturn.key}`
        : `commerce-contact:${tenant ? 'tenant' : 'customer'}:${id || 'new'}`;
    const draft = S.drafts.get(key) || {},
      v = (name) => draft[`commerce-${name}`] ?? row?.[name] ?? '';
    // An order and its quick-add drawer coexist; only the submitted field names may match.
    const contactField = (label, name, control, required = false, help = '', span = '') =>
      field(
        label,
        `contact-${name}`,
        control.replace(`id="commerce-${name}"`, `id="commerce-contact-${name}"`),
        required,
        help,
        span
      );
    const contactInput = (name, attrs = '') => input(name, v(name), attrs);
    const channels = customerChannels
      .slice(1)
      .map(([name, label]) => contactField(label, name, contactInput(name, 'maxlength="60"')))
      .join('');
    const phone = contactField(
      '联系电话',
      'phone',
      contactInput('phone', tenant ? 'maxlength="60" required' : 'maxlength="60"'),
      tenant
    );
    const source = tenant
      ? contactField('归属人', 'owner', contactInput('owner', 'placeholder="业务归属人员"'))
      : contactField(
          '来源渠道',
          'source',
          select('source', customerSourceChoices(v('source')), v('source'))
        );
    const notes = contactField(
      '备注',
      'notes',
      `<textarea id="commerce-notes" name="commerce-notes" rows="2">${E(v('notes'))}</textarea>`,
      false,
      '',
      'commerce-span-all'
    );
    const name = contactField(
      `${tenant ? '租户' : '客户'}姓名`, 'name', contactInput('name', 'maxlength="80" required'), true
    );
    const details = tenant
      ? `<div class="commerce-field-grid">${name}${phone}${source}${notes}</div><p class="footnote">录入人和修改人自动记录。</p>`
      : [
          section('01', '基本资料', name + source + contactField('客户标签', 'tags',
            customerTagPicker(A.readOptionList(draft['commerce-tags'] ?? row?.tags ?? []), row?.tags || [])
          ), '', false, 'commerce-section', customerSettingsButtons()),
          section('02', '联系方式', phone + channels + notes,
            '电话、微信、QQ、WhatsApp、Telegram 至少填写一项。', false, 'commerce-customer-section')
        ].join('');
    const body = `<form id="commerce-contact-form" data-commerce-draft="${E(key)}" novalidate><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-kind" value="${tenant ? 'tenant' : 'customer'}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || row?.version || '')}" /><input type="hidden" name="commerce-quick" value="${quick ? 'yes' : ''}" />${details}</form>`;
    const cancel = standalone
      ? tenant
        ? routeButton('返回租户数据', 'customers/tenants')
        : routeButton('返回客户数据', 'customers/list')
      : A.button('取消', 'drawer-close');
    const footer = `${cancel}<button type="submit" form="commerce-contact-form" class="button primary">核对并保存</button>`;
    if (standalone) {
      const entryTabs = tabs(
        [['customer', '客户录入'], ['tenant', '租户录入']],
        tenant ? 'tenant' : 'customer',
        'commerce-contact-entry-tab',
        'aria-label="录入类型"'
      );
      return `<section class="panel form-panel">${entryTabs}${body}<div class="form-footer">${footer}</div></section>`;
    }
    A.openDrawer(
      `${row ? '编辑' : '新增'}${tenant ? '租户' : '客户'}`,
      tenant
        ? '保存前确认资料。关闭保留当前草稿，关联记录使用稳定编号。'
        : '关闭保留当前草稿。录入人和修改人自动记录，历史开通业务可在客户详情查看。',
      body,
      footer,
      key
    );
    return '';
  }
  function contactDetail(id, tenant) {
    const row = (tenant ? tenants : customers).find((entry) => entry.id === id);
    if (!row) return;
    const linked = orders.filter((order) =>
      tenant ? order.tenantId === id : order.customerId === id
    );
    const rent = rentBatches
      .flatMap((batch) => batch.items.map((item) => ({ ...item, batchNo: batch.id })))
      .filter((item) => item.tenantId === id);
    A.openDrawer(
      `${tenant ? '租户' : '客户'}详情`,
      '',
      `<div class="property-list">${property('姓名', row.name)}${property('联系电话', row.phone)}${tenant ? property('归属人', row.owner) : property('微信', row.wechat) + property('QQ', row.qq) + property('WhatsApp', row.whatsapp) + property('Telegram', row.telegram) + property('来源渠道', row.source) + property('客户标签', (row.tags || []).join('、'))}${traceProperties(row)}${property('备注', row.notes)}</div>${
        tenant
          ? ''
          : panelTitle(
              '历史开通业务',
              '按客户编号汇总已登记开通时间且确认代付的订单；退款、撤单不会抹去开通过的历史。'
            ) +
            A.table(
              [
                { id: 'name', label: '开通业务' },
                { id: 'count', label: '开通次数' },
                {
                  id: 'firstOpenedAt',
                  label: '首次开通',
                  render: (entry) => E(entry.firstOpenedAt.replace('T', ' '))
                },
                {
                  id: 'lastOpenedAt',
                  label: '最近开通',
                  render: (entry) => E(entry.lastOpenedAt.replace('T', ' '))
                },
                {
                  id: 'orderNos',
                  label: '来源订单',
                  long: true,
                  render: (entry) => E(entry.orderNos.join('、'))
                }
              ],
              customerServices(id),
              '',
              'commerce-contact-services'
            )
      }${panelTitle('关联订单')}${A.table(
        [
          { id: 'orderNo', label: '订单编号' },
          { id: 'email', label: '邮箱账号' },
          { id: 'plan', label: '套餐' },
          { id: 'businessType', label: '业务类型' },
          { id: 'start', label: '开通时间' },
          { id: 'expiry', label: '到期时间' },
          {
            id: 'accountStatus',
            label: '当前账号运营',
            render: (order) => E(accountStatus(order))
          },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (order) =>
              A.textAction('查看订单', 'commerce-order-detail', `data-id="${order.id}"`)
          }
        ],
        linked,
        '',
        'commerce-contact-orders'
      )}${
        tenant
          ? panelTitle('付租记录') +
            (rent.length
              ? A.table(
                  [
                    { id: 'batchNo', label: '付租批次' },
                    { id: 'email', label: '账号' },
                    { id: 'period', label: '租赁期间' },
                    { id: 'status', label: '状态' }
                  ],
                  rent,
                  '',
                  'commerce-contact-rents'
                )
              : A.empty('暂无付租记录', '可从 Claude 专属选择账号生成待付租批次。'))
          : ''
      }${panelTitle('操作记录')}${timeline(row.id)}`,
      (tenant && localData ? A.button('银行卡管理', 'commerce-tenant-cards', '', '', `data-id="${E(row.id)}"`) : '') + A.button('关闭', 'drawer-close')
    );
  }

  function orderDefault(product = 'Claude Max') {
    const start = dateInput(now());
    return {
      product,
      plan: productPlans[product]?.[0] || 'Plus',
      customerId: '',
      email: '',
      accountId: '',
      accountSource: '客户自有',
      businessType: '续费',
      payment: '银行卡',
      paymentId: '',
      cardId: '',
      appleIdId: '',
      paidAmount: '',
      paidCurrency: product === 'GPT' ? 'PHP' : 'MYR',
      saleAmount: '',
      saleCurrency: 'CNY',
      start,
      expiry: A.addCalendarMonth(start),
      tenantId: '',
      owner: '',
      ownerPhone: '',
      verifier: '',
      verifierPhone: '',
      kyc: '未认证',
      phone: '',
      notes: '',
      costBasis: 'standard',
      actualCostAmount: '',
      actualCostCurrency: 'CNY',
      emailCostAmount: '0',
      emailCostCurrency: 'CNY',
      claudeRenewalId: '',
      paidConfirmed: false,
      receiptConfirmed: false,
      costConfirmed: false,
      includeIssueFee: false,
      balanceReversalConfirmed: false,
      version: 1
    };
  }
  function inventoryRenewalIssue(email, customerId, product) {
    const summary = A.modules.inventory?.accountSummaryForEmail?.(email, product);
    if (!summary?.systemOwned) return '';
    if (summary.disposition === 'retired') return '账号已停止复用，不能直接续费';
    if (['recovered', 'new'].includes(summary.disposition)) return '账号已回收或尚未分配，请通过成品交付重新分配后再续费';
    if (summary.currentCustomers.length !== 1 || !summary.customerId) return '账号当前客户归属待核对';
    return summary.customerId !== customerId ? '账号当前由其他客户使用，请选择正确账号' : '';
  }
  function endedInventoryOrder(order) {
    const summary = A.modules.inventory?.accountSummaryForEmail?.(order.email, order.product);
    return summary?.orders?.some(row => row.id === order.id && row.released) || false;
  }
  function customerEmailChoices(customerId, product) {
    if (!customerId) return [['', '直接填写新邮箱']];
    const usedAt = row => parseDate(row.start) || parseDate(row.createdAt) || 0;
    const history = orders.filter(row => row.customerId === customerId && !row.cancelled &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.email || '').trim()))
      .sort((a, b) => usedAt(b) - usedAt(a));
    const unique = new Map();
    for (const row of history) {
      const email = row.email.trim();
      const key = email.toLowerCase();
      if (!unique.has(key)) unique.set(key, [email,
        [email, row.product, (dateInput(row.start) || dateInput(row.createdAt)).slice(0, 10), inventoryRenewalIssue(email, customerId, product || row.product)].filter(Boolean).join(' · ')]);
    }
    return [['', '直接填写新邮箱'], ...unique.values()];
  }
  function orderIdentityFields(v, contact, existing, products) {
    const auto = automaticOrder(existing);
    const product = v('product'),
      customerId = v('customerId'),
      stock = v('businessType') === '成品交付';
    return (
      `<div class="commerce-span-all order-choice-grid">` +
      (products.length === 1 ? `<input type="hidden" id="commerce-product" name="commerce-product" value="${E(product)}" />` : field('产品类型', 'product', select('product', products, product), true)) +
      field('开通套餐', 'plan', auto ? input('plan', v('plan'), 'readonly') : select('plan', orderPlanChoices(product, v('plan'), existing), v('plan')), true) +
      field(
        '业务类型',
        'businessType',
        auto ? input('businessType', v('businessType'), 'readonly') : select('businessType', ['续费', '成品交付'], v('businessType')),
        true
      ) +
      `</div>` +
      field(
        '客户资料',
        'customerId',
        searchableSelect('customerId', '客户', [['', '选择客户'], ...customers.filter((row) => row.active || row.id === customerId).map((row) => [row.id, [row.name, ...customerChannels.map(([key]) => row[key]).filter(Boolean)].join(' · ')])], customerId, A.button('新增', 'commerce-quick-customer', '', 'plus')),
        true,
        '',
        ''
      ) +
      `<input type="hidden" id="commerce-accountId" name="commerce-accountId" value="${E(v('accountId'))}" />` +
      field(
        '邮箱账号',
        'email',
        searchableSelect('emailHistory', '客户历史邮箱', customerEmailChoices(customerId, product), v('email'), '', input(
          'email',
          v('email'),
          `placeholder="${stock ? '搜索并选择本产品的可用账号' : '选择客户匹配历史邮箱，也可直接填写新邮箱'}" aria-required="${stock || product !== 'GPT'}" autocomplete="off" ${existing?.accountId || auto ? 'readonly' : ''}`
        )),
        true,
        stock
          ? existing
            ? '已保存的交付快照保留，不再次占用库存。'
            : '按邮箱搜索未使用账号，保存成功后标记为已使用。'
          : auto ? '' : '优先匹配所选客户最近使用的邮箱，也可直接填写新邮箱。',
        ''
      ).replace('<span class="required">*', `<span class="required"${!stock && product === 'GPT' ? ' hidden' : ''}>*`) +
      orderOwnerField(v, existing) +
      `<details class="commerce-span-all"><summary>联系方式（自动回填，可展开修改）</summary><div class="commerce-field-grid">${field('客户微信', 'wechat', input('wechat', contact('wechat')))}${field('客户电话', 'customerPhone', input('customerPhone', contact('customerPhone')))}${field('QQ', 'qq', input('qq', contact('qq')))}${field('WhatsApp', 'whatsapp', input('whatsapp', contact('whatsapp')))}${field('Telegram', 'telegram', input('telegram', contact('telegram')))}</div></details>`
    );
  }
  function orderPlanChoices(product, selected, existing) {
    const choices = productPlans[product] || [];
    return existing?.plan === selected && !choices.includes(selected) ? [...choices, selected] : choices;
  }
  function orderPrice(product, plan, currency) {
    return orderPrices[product]?.[plan]?.[currency] || '';
  }
  function applyOrderPrice(form) {
    if (form.elements['commerce-id'].value || form.elements['commerce-saleManual'].value) return;
    form.elements['commerce-saleAmount'].value = orderPrice(form.elements['commerce-product'].value,
      form.elements['commerce-plan'].value, form.elements['commerce-saleCurrency'].value);
  }
  async function loadPrices(form) {
    if (!localData) return;
    priceLoad ||= localData.load('settings').then((snapshot) => {
      orderPrices = snapshot.data?.orderPrices || {};
      return snapshot;
    }).catch(() => {
      priceLoad = null;
      return null;
    });
    const snapshot = await priceLoad;
    if (snapshot && form?.isConnected && !form.elements['commerce-saleAmount'].value) applyOrderPrice(form);
  }
  async function openPrices(product) {
    if (!canManageOrders()) return;
    const route = S.route;
    const context = S.drawerContext;
    const choices = product === 'GPT' ? ['GPT'] : ['Claude Pro', 'Claude Max'];
    let snapshot;
    try {
      snapshot = localData ? await localData.load('settings') : { version: 0, data: { orderPrices } };
    } catch (error) {
      A.notify(error.message || '未能读取套餐售价，请重试');
      return;
    }
    if (S.route !== route || S.drawerContext !== context) return;
    if (localData) orderPrices = snapshot.data?.orderPrices || {};
    const key = `commerce-prices:${product === 'GPT' ? 'gpt' : 'claude'}`;
    const draft = S.drafts.get(key) || {};
    const rows = choices.flatMap((kind) => productPlans[kind].map((plan, index) => {
      const priceFields = ['CNY', 'MYR'].map((currency) => {
        const fieldId = `price-${kind === 'Claude Max' ? 'max' : 'base'}-${index}-${currency}`;
        const current = draft[`commerce-${fieldId}`] ?? orderPrice(kind, plan, currency);
        return field(`${plan} ${currencyLabel(currency)}`, fieldId, input(fieldId, current,
          `data-price-product="${E(kind)}" data-price-plan="${E(plan)}" data-price-currency="${currency}" inputmode="decimal"`));
      });
      return priceFields.join('');
    })).join('');
    A.openDrawer('套餐售价设置', '选择套餐和币种时自动带入售价，实际到账后再确认实收。',
      `<form id="commerce-prices-form" data-commerce-draft="${key}" novalidate>${input('price-version', draft['commerce-price-version'] ?? snapshot.version, 'type="hidden"')}<div class="commerce-field-grid">${rows}</div></form>`,
      A.button('关闭', 'drawer-close') + '<button type="submit" form="commerce-prices-form" class="button primary">保存套餐售价</button>', key);
  }
  async function savePrices(form, confirmed = '') {
    if (!canManageOrders() || form.getAttribute('aria-busy') === 'true') return;
    const values = [...form.querySelectorAll('[data-price-currency]')];
    const invalid = values.find((node) => !amountValid(node.value.trim(), true));
    if (invalid) {
      A.setError(invalid.id, '请输入非负金额，最多四位小数');
      invalid.focus();
      return;
    }
    const draft = JSON.stringify(readCommerceDraft(form));
    if (!confirmed) {
      A.confirmAction('确认更新套餐售价', '新订单会按套餐和币种带入新价格，已保存订单保留原金额。', () => {
        if (form.isConnected && JSON.stringify(readCommerceDraft(form)) === draft) void savePrices(form, draft);
        else A.notify('售价输入已变化，请重新核对后保存');
      });
      return;
    }
    form.setAttribute('aria-busy', 'true');
    const key = form.dataset.commerceDraft;
    const submitted = values.map((node) => ({ ...node.dataset, amount: node.value.trim() }));
    try {
      const version = Number(form.elements['commerce-price-version'].value);
      const snapshot = localData ? await localData.load('settings') : { version, data: {} };
      if (snapshot.version !== version) {
        form.elements['commerce-price-version'].value = snapshot.version;
        orderPrices = snapshot.data?.orderPrices || {};
        throw new Error('套餐售价已变化，请核对当前输入后重新保存');
      }
      const next = safeClone(snapshot.data?.orderPrices || orderPrices);
      for (const { priceProduct, pricePlan, priceCurrency, amount } of submitted) {
        ((next[priceProduct] ||= {})[pricePlan] ||= {})[priceCurrency] = amount;
      }
      let savedVersion = version;
      if (localData) {
        const data = snapshot.data || {
          mailboxTypes: A.modules.operations?.getMailboxTypes?.() || [],
          costSettings: safeClone(costSettings)
        };
        const saved = await localData.save('settings', version, { ...data, orderPrices: next }, { action: 'order_prices_save' });
        savedVersion = saved.version;
      }
      orderPrices = next;
      priceLoad = null;
      if (form.isConnected) {
        if (JSON.stringify(readCommerceDraft(form)) === confirmed) cleanClose(key);
        else {
          form.elements['commerce-price-version'].value = savedVersion;
          saveDrafts();
        }
        const order = $('#commerce-order-form');
        if (order) {
          applyOrderPrice(order);
          saveDrafts();
        }
        A.notify('套餐售价已保存');
      }
    } catch (error) {
      A.notify(error.message || '套餐售价未保存，请重试');
    } finally {
      form.removeAttribute('aria-busy');
    }
  }
  function orderCardPicker(v, hidden) {
    const gpt = v('product') === 'GPT';
    const choices = cardChoices(v('product'), v('tenantId'), v('cardId'), v('paymentId'));
    const actions = !localData ? '' : gpt
      ? A.button('刷新', 'commerce-order-card-retry', 'compact', '', 'aria-label="刷新银行卡"')
      : A.button('读取', 'commerce-tenant-card-reveal', 'compact', '', 'aria-label="读取完整卡号"');
    const full = !gpt && localData ? `<div class="field-row" data-commerce-card-revealed hidden><input type="text" readonly autocomplete="off" aria-label="完整银行卡号" data-commerce-card-number /><div>${A.button('复制', 'commerce-tenant-card-copy', '', '', 'aria-label="复制完整卡号"')}</div></div>` : '';
    const metadata = poolUsage(v('cardId'));
    const usage = gpt && localData ? `<p class="footnote" data-commerce-pool-usage${metadata ? '' : ' hidden'}>${E(metadata)}</p>` : '';
    return field('银行卡', 'cardId', searchableSelect('cardId', '银行卡', choices, v('cardId'), actions) + full + usage,
      true, !gpt ? '选择租户后可搜索该租户的银行卡。' : '', '', hidden);
  }
  function clearRevealedCard(form) {
    const row = form.querySelector('[data-commerce-card-revealed]');
    if (!row) return;
    row.hidden = true;
    row.querySelector('[data-commerce-card-number]').value = '';
  }
  async function useTenantCard(form, action) {
    if (!canManageOrders()) return;
    const tenantId = form.elements['commerce-tenantId'].value;
    const id = form.elements['commerce-cardId'].value;
    if (!tenantId || !id) {
      A.setError('commerce-cardId', '请先选择租户银行卡');
      return;
    }
    try {
      const response = await localData.tenantCardAction({ action, tenantId, id });
      if (!form.isConnected || form.elements['commerce-tenantId'].value !== tenantId ||
          form.elements['commerce-cardId'].value !== id || form.elements['commerce-payment'].value !== '银行卡') return;
      if (action === 'copy') await A.copyText(response.number, '银行卡号已复制');
      else {
        const row = form.querySelector('[data-commerce-card-revealed]');
        row.querySelector('[data-commerce-card-number]').value = response.number;
        row.hidden = false;
      }
      A.setError('commerce-cardId', '');
    } catch (error) {
      if (form.isConnected) A.setError('commerce-cardId', error.message || '无法读取银行卡，请重试');
    }
  }
  async function openTenantCards(tenantId) {
    if (!canManageOrders()) return;
    const route = S.route;
    const context = S.drawerContext;
    try {
      const snapshot = await localData.tenantCards(tenantId);
      if (S.route !== route || S.drawerContext !== context) return;
      tenantCards.set(tenantId, snapshot);
      const row = tenants.find((tenant) => tenant.id === tenantId);
      const items = snapshot.items || [];
      const list = items.length ? A.table([
        { id: 'label', label: '银行卡名称', render: (card) => E(card.label || '银行卡') },
        { id: 'last4', label: '卡尾号' },
        { id: 'active', label: '状态', render: (card) => card.active ? '启用' : '停用' },
        { id: 'actions', label: '操作', action: true, render: (card) => card.active
          ? A.textAction('停用', 'commerce-tenant-card-deactivate', `data-id="${E(card.id)}" data-tenant="${E(tenantId)}"`)
          : '—' }
      ], items, '', 'commerce-tenant-cards') : A.empty('暂无银行卡', '登记后可在 Claude 提交订单选择。');
      A.openDrawer('租户银行卡', `${row?.name || '租户'} · 已登记 ${items.length} 张，最多 999 张。`,
        `<form id="commerce-tenant-cards-form" novalidate><input type="hidden" name="tenant-id" value="${E(tenantId)}" /><div class="commerce-field-grid">${field('银行卡名称', 'tenant-card-label', input('tenant-card-label', '', 'maxlength="80" placeholder="如银行卡 1"'))}${field('银行卡号', 'tenant-card-number', input('tenant-card-number', '', 'inputmode="numeric" maxlength="32" autocomplete="off" data-no-draft'), true)}</div></form>${list}`,
        A.button('返回租户资料', 'commerce-contact-detail', '', 'return', `data-kind="tenant" data-id="${E(tenantId)}"`) +
          '<button type="submit" form="commerce-tenant-cards-form" class="button primary">添加银行卡</button>', 'commerce-tenant-cards');
    } catch (error) {
      A.notify(error.message || '无法读取租户银行卡，请重试');
    }
  }
  async function changeTenantCard(form, tenantId, id = '') {
    if (!canManageOrders()) return;
    const version = tenantCards.get(tenantId)?.version;
    if (form?.getAttribute('aria-busy') === 'true') return;
    const body = { action: id ? 'deactivate' : 'add', tenantId, version };
    if (id) body.id = id;
    else {
      body.number = form.elements['commerce-tenant-card-number'].value.replace(/[ -]/g, '');
      body.label = form.elements['commerce-tenant-card-label'].value.trim();
      if (!/^\d{12,19}$/.test(body.number)) {
        A.setError('commerce-tenant-card-number', '请输入有效的银行卡号');
        return;
      }
    }
    const context = S.drawerContext;
    form?.setAttribute('aria-busy', 'true');
    try {
      await localData.tenantCardAction(body);
      if (context === S.drawerContext) await openTenantCards(tenantId);
    } catch (error) {
      A.notify(error.message || '银行卡未保存，请重新核对');
    } finally {
      form?.removeAttribute('aria-busy');
    }
  }
  function orderPaymentFields(v, existing) {
    const auto = automaticOrder(existing);
    const apple = v('payment') === '苹果内购';
    const match = appleMatch(v('plan'), v('appleMatchMin'), v('appleMatchMax'));
    const appleSelection = {
      id: existing?.id, product: v('product'), plan: v('plan'), businessType: v('businessType'),
      email: v('email'), paidAmount: v('paidAmount'), appleMatchMin: match[0], appleMatchMax: match[1]
    };
    return (
      `<div class="commerce-span-all order-payment-options">` +
      field('支付方式', 'payment', auto ? input('payment', v('payment'), 'readonly') : select('payment', ['银行卡', '苹果内购'], v('payment')), true) +
      (v('product') === 'GPT' && !auto ? orderCardPicker(v, apple) : '') +
      field('卡尾号', 'paymentId', input('paymentId', v('paymentId'), 'readonly'), false, '', '', apple || v('product') !== 'GPT') +
      field(
        '苹果 ID',
        'appleIdId',
        searchableSelect('appleIdId', '苹果 ID', appleOptions(v('appleIdId'), appleSelection), v('appleIdId')),
        true,
        v('businessType') === '续费' ? '续费选择原订阅使用的苹果 ID。' : '仅显示符合余额条件且未用于订阅的苹果 ID。',
        '',
        !apple
      ) +
      field('余额下限（USD）', 'appleMatchMin', input('appleMatchMin', match[0], 'inputmode="decimal"'),
        false, '', '', !apple || v('businessType') === '续费') +
      field('余额上限（USD）', 'appleMatchMax', input('appleMatchMax', match[1], 'inputmode="decimal" placeholder="留空不限"'),
        false, '', '', !apple || v('businessType') === '续费') +
      `</div>` +
      `<div class="order-financial-groups commerce-span-all"><div class="order-financial-group"><h3>代付</h3>${field('代付币种', 'paidCurrency', auto ? input('paidCurrency', v('paidCurrency') ? currencyLabel(v('paidCurrency')) : '', 'readonly placeholder="待核对"') : select('paidCurrency', currencyChoices(apple ? ['USD'] : currencies), apple ? 'USD' : v('paidCurrency')), true)}${field('代付金额', 'paidAmount', input('paidAmount', v('paidAmount'), auto ? 'readonly placeholder="待核对"' : 'inputmode="decimal" placeholder="实际代付金额"'), true)}</div><div class="order-financial-group"><h3>售卖</h3>${field('售卖币种', 'saleCurrency', select('saleCurrency', currencyChoices(), v('saleCurrency')), true)}${field('售卖金额', 'saleAmount', input('saleAmount', v('saleAmount'), 'inputmode="decimal" placeholder="实际收到金额"'), true)}</div><div class="order-financial-group"><h3>订阅周期</h3>${field('订阅时间', 'start', input('start', dateInput(v('start')), auto ? 'type="datetime-local" readonly' : 'type="datetime-local"'), true, '本次实际开通时间，只登记一次。')}${field('到期时间', 'expiry', input('expiry', dateInput(v('expiry')), auto ? 'type="datetime-local" readonly' : 'type="datetime-local"'), true)}</div></div>` +
      (v('claudeRenewalId')
        ? `<div class="commerce-cost-strip commerce-span-all">Claude 专属续费：当前订阅到期 ${E(orders.find((row) => row.id === v('claudeRenewalId'))?.expiry || '')}，本次新单到期 ${E(v('expiry'))}。原单保持独立可见。</div>`
        : '') +
      field(
        '确认项目',
        'confirmations',
        `<div class="inline-checks"><label class="checkbox-label"><input name="commerce-paidConfirmed" type="checkbox" ${v('paidConfirmed') ? 'checked' : ''} ${auto ? 'disabled' : ''} />代付已确认</label><label class="checkbox-label"><input name="commerce-receiptConfirmed" type="checkbox" ${v('receiptConfirmed') ? 'checked' : ''} />实收已确认</label><label class="checkbox-label"><input name="commerce-costConfirmed" type="checkbox" ${v('costConfirmed') ? 'checked' : ''} />成本口径已核对</label></div>`,
        false,
        apple ? '确认实际代付后才扣减所选 ID 余额；客户退款不会自动增加余额。' : '',
        'commerce-span-all'
      ) +
      (existing && (apple || A.modules.appleBalance?.getOrderLedger?.(existing.id))
        ? field(
            '余额冲正确认',
            'balanceReversalConfirmed',
            `<label class="checkbox-label"><input name="commerce-balanceReversalConfirmed" type="checkbox" data-no-draft ${v('balanceReversalConfirmed') ? 'checked' : ''} />已核实 Apple 退回，允许本次更正产生余额冲正</label>`,
            false,
            '减少已扣金额、换 ID 或付款方式时使用；必须填写更正原因。',
            'commerce-span-all'
          )
        : '')
    );
  }
  function orderCostFields(v, existing) {
    return (
      `<details class="commerce-span-all"><summary>高级费用调整（通常使用标准规则）</summary><div class="commerce-field-grid">` +
      (existing ? field(
        '成本依据',
        'costBasis',
        select('costBasis', [
          ['standard', '按标准规则核算'],
          ['actual', '按实际总成本核算']
        ], v('costBasis')),
        true, '实际总成本请在更正原因中注明核对依据。'
      ) : input('costBasis', 'standard', 'type="hidden"')) +
      field(
        '实际总成本（退回前）',
        'actualCostAmount',
        input('actualCostAmount', v('actualCostAmount'), 'inputmode="decimal"'),
        false,
        '填写退回前成本；Apple 已到账退回另行抵减，请勿填净额后重复扣除。',
        '',
        v('costBasis') !== 'actual'
      ) +
      field(
        '成本币种',
        'actualCostCurrency',
        select('actualCostCurrency', currencyChoices(), v('actualCostCurrency')),
        false,
        '',
        '',
        v('costBasis') !== 'actual'
      ) +
      (localData ? field(
        'Apple 可收回成本',
        'appleRecoverableCostAmount',
        input('appleRecoverableCostAmount', v('appleRecoverableCostAmount'), 'inputmode="decimal"'),
        false,
        '以实际总成本的币种填写，其中仅包含对应 Apple 扣款的成本，不含不可退费用。实际到账后按退回面额比例抵减。',
        '',
        v('costBasis') !== 'actual' || v('payment') !== '苹果内购'
      ) : '') +
      field(
        '补充邮箱成本',
        'emailCostAmount',
        input('emailCostAmount', v('emailCostAmount') || '0', 'inputmode="decimal"'),
        false,
        '成品按已选库存账号的邮箱类型带入设置费用；其它费用可按本单实际情况补充。'
      ) +
      field(
        '邮箱成本币种',
        'emailCostCurrency',
        select('emailCostCurrency', currencyChoices(), v('emailCostCurrency') || 'CNY')
      ) +
      (v('product') === 'GPT' && v('payment') === '银行卡'
        ? '<p class="footnote commerce-span-all">首次确认用卡时按费用规则记录开卡费。</p>' : '') +
      '</div></details>'
    );
  }
  function orderEditor(orderId = '', renewalId = '', main = false, workbenchSource = null, pageProduct = '') {
    const existing = orders.find((row) => row.id === orderId);
    const candidate = workbenchSource?.order || orders.find((row) => row.id === renewalId);
    const previous = workbenchSource?.order || (isClaude(candidate) ? candidate : null);
    if (renewalId && !previous) {
      A.notify('快捷续费仅支持 Claude；其他产品请直接提交独立新订单。');
      return '';
    }
    const key = workbenchSource ? `commerce-order:workbench:${previous.id}` :
      main ? entryDraft(pageProduct) : `commerce-order:${orderId || `renew:${renewalId}`}`;
    const legacyDraft = S.drafts.get('commerce-order:new');
    const draft = S.drafts.get(key) || (main && !previous && legacyDraft &&
      entryRoute(legacyDraft['commerce-product']) === entryRoute(pageProduct) ? legacyDraft : {});
    const products = existing || previous ? [existing?.product || previous.product] :
      pageProduct === 'GPT' ? ['GPT'] : ['Claude Pro', 'Claude Max'];
    const initialProduct = products.includes(draft['commerce-product']) ? draft['commerce-product'] :
      existing?.product || previous?.product || pageProduct || 'Claude Max';
    const base =
      existing || orderDefault(initialProduct);
    if (!existing && previous) {
      for (const name of [
        'product',
        'plan',
        'customerId',
        'email',
        'wechat',
        'customerPhone',
        'qq',
        'whatsapp',
        'telegram',
        'tenantId',
        'owner',
        'ownerPhone',
        'verifier',
        'verifierPhone',
        'phone',
        'kyc',
        'payment',
        'paidAmount',
        'paidCurrency',
        'emailCostAmount',
        'emailCostCurrency'
      ])
        base[name] = previous[name] ?? base[name];
      base.businessType = '续费';
      base.claudeRenewalId = isClaude(previous) ? previous.id : '';
      base.start = dateInput(now());
      base.expiry =
        isClaude(previous) && parseDate(previous.expiry) > parseDate(base.start)
          ? A.addCalendarMonth(dateInput(previous.expiry))
          : A.addCalendarMonth(base.start);
      base.appleIdId = previous.payment === '苹果内购' ? previous.appleIdId || '' : '';
      base.paymentId = previous.payment === '苹果内购' ? previous.paymentId : '';
      base.cardId = '';
      base.saleCurrency = previous.payment === '苹果内购' ? 'USD' : previous.saleCurrency;
      base.saleAmount =
        previous.payment !== '苹果内购' || previous.saleCurrency === 'USD'
          ? previous.saleAmount
          : '';
      if (workbenchSource) {
        base.customerId = customers.some((row) => row.id === workbenchSource.identity)
          ? workbenchSource.identity : '';
        const contact = customerForOrder(previous, workbenchSource.identity);
        for (const [key] of orderContactFields) base[key] = previous[key] || contact[key];
        base.paidAmount = '';
        base.saleAmount = '';
        base.emailCostAmount = '0';
        base.emailCostCurrency = 'CNY';
      }
    }
    const booleanFields = [
      'paidConfirmed',
      'receiptConfirmed',
      'costConfirmed',
      'includeIssueFee',
      'balanceReversalConfirmed'
    ];
    const originalPlan = draft['commerce-plan'] ?? base.plan;
    const nextPlan = existing ? originalPlan : normalizedPlan(originalPlan);
    const plan = orderPlanChoices(initialProduct, nextPlan, existing).includes(nextPlan) ? nextPlan : productPlans[initialProduct][0];
    const v = (name) =>
      name === 'product' ? initialProduct : name === 'plan' ? plan :
      name === 'appleMatchMax' || name === 'appleMatchMin' ? draft[`commerce-${name}`] ?? base[name] :
      name === 'saleAmount' && !existing && !draft['commerce-saleManual'] ?
        orderPrice(initialProduct, plan, draft['commerce-saleCurrency'] || base.saleCurrency) || (draft['commerce-saleAmount'] ?? base.saleAmount) :
      name === 'balanceReversalConfirmed'
        ? false
        : booleanFields.includes(name)
          ? S.drafts.has(key)
            ? draft[`commerce-${name}`] === 'on'
            : Boolean(base[name])
          : (draft[`commerce-${name}`] ?? base[name] ?? '');
    const product = v('product'),
      customer = customers.find((row) => row.id === v('customerId'));
    const contact = (name) =>
      draft[`commerce-${name}`] ??
      existing?.[name] ??
      base[name] ??
      customer?.[name === 'customerPhone' ? 'phone' : name] ??
      '';
    const selectedTenant = tenants.find((row) => row.id === v('tenantId'));
    const personnel =
      field(
        '认证人',
        'tenantId',
        searchableSelect('tenantId', '租户', [['', '未关联租户'], ...tenants.filter((row) => row.active || row.id === v('tenantId')).map((row) => [row.id, `${row.name} · ${row.phone}`])], v('tenantId'), A.button('新增', 'commerce-quick-tenant', '', 'plus'))
      ) +
      (product !== 'GPT' ? orderCardPicker(v, v('payment') !== '银行卡') : '') +
      field('认证电话', 'verifierPhone', input('verifierPhone', selectedTenant?.phone || existing?.verifierPhone || '', 'readonly')) +
      field('认证状态', 'kyc', select('kyc', ['未认证', 'KYC 认证'], v('kyc'))) +
      field('订阅电话', 'phone', input('phone', v('phone'), 'type="tel" maxlength="60"'));
    const saleCurrencyChosen = existing || draft['commerce-saleCurrencyChosen'] === 'yes';
    const html = `<form id="commerce-order-form" data-commerce-draft="${key}" novalidate><input type="hidden" id="commerce-id" name="commerce-id" value="${E(existing?.id || '')}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || existing?.version || '')}" /><input type="hidden" name="commerce-source" value="${E(existing?.source || '管理员手工')}" /><input type="hidden" name="commerce-emailCostManual" value="${E(draft['commerce-emailCostManual'] || '')}" /><input type="hidden" name="commerce-saleManual" value="${E(draft['commerce-saleManual'] || '')}" /><input type="hidden" name="commerce-saleCurrencyChosen" value="${saleCurrencyChosen ? 'yes' : ''}" /><input type="hidden" id="commerce-claudeRenewalId" name="commerce-claudeRenewalId" value="${E(v('claudeRenewalId'))}" />${section('01', '客户与账号', orderIdentityFields(v, contact, existing, products), '订单邮箱独立记录；客户自有账号不要求存在库存，成品交付才选择可用账号。')}${section('02', '金额与订阅周期', orderPaymentFields(v, existing) + orderCostFields(v, existing))}${section('03', 'Claude 人员与补充资料', personnel, '认证电话由所选租户带出，订阅电话按实际开通填写。', product === 'GPT')}<div class="commerce-field-grid">${existing ? field('更正原因', 'correctionReason', input('correctionReason', v('correctionReason')), true, '', 'commerce-span-all') : ''}${field('备注', 'notes', `<textarea id="commerce-notes" name="commerce-notes" rows="2">${E(v('notes'))}</textarea>`, false, '', 'commerce-span-all')}</div><div class="form-section"><div class="section-title-row"><h2>费用核对</h2>${A.titleInfo('费用核对', localData ? '保存时记录原币金额与费用规则版本。在订单详情的「成本与汇率」登记有效快照后核算。' : '成本、币种与演示汇率在保存时冻结为订单快照；苹果余额只按已确认实际支出记账。', 'commerce-cost-explanation')}</div><div id="commerce-cost-preview">${costPreview(base)}</div></div></form>`;
    const footer = `<span class="footnote">${localData ? '订单保存到本机数据库。' : '订单独立保存；确认代付才记苹果余额支出。'}</span>${A.button('保留待补全', 'commerce-order-pending')}<button form="commerce-order-form" type="submit" class="button primary">核对并保存</button>`;
    if (main)
      return `<section class="panel form-panel">${html}<div class="form-footer">${footer}</div></section>`;
    A.openDrawer(
      previous ? 'Claude 续费新订单' : '修改订单资料',
      previous
        ? '沿用账号与客户资料，生成独立新单；银行卡请重新选择，苹果 ID 可保留。'
        : '更正保留版本、费用和余额台账，不删除真实财务记录。',
      html,
      footer,
      key
    );
    const form = $('#commerce-order-form', $('#drawer') || document);
    if (form) updateCustomerEmailHistory(form);
    if (form) void loadOrderOwners(form);
    if (form && v('payment') === '苹果内购') loadAppleOptions(form);
    if (form && v('payment') === '银行卡') void loadOrderCards(form);
    if (form) void loadPrices(form);
    return '';
  }
  function costPreview(order) {
    if (localData) {
      const snapshot = order.fxSnapshot || orders.find((row) => row.id === order.id)?.fxSnapshot;
      const guidance = snapshot ? '已冻结，核算结果见订单详情' :
        finance?.requestAutomaticSnapshot && !order.id
          ? '新单保存后自动获取，结果见订单详情'
          : '保存后可在订单详情登记汇率';
      return `<div class="commerce-cost-strip"><span>规则版本 <strong>V${order.costSettings?.version || costSettings.version}</strong></span><span>汇率 <strong>${guidance}</strong></span></div>`;
    }
    const detail = costsFor({
      ...order,
      costSettings: order.costSettings || costSettings,
      rates: order.rates || fxRates
    });
    return `<div class="commerce-cost-strip"><span>标准净成本 <strong>${detail.standard === undefined ? '待输入' : `${display(detail.standard)} ${currencyLabel('CNY')}`}</strong></span><span>实际净成本 <strong>${detail.actual === null || detail.actual === undefined ? '未录入' : `${display(detail.actual)} ${currencyLabel('CNY')}`}</strong></span><span>规则版本 <strong>V${order.costSettings?.version || costSettings.version}</strong></span><span>汇率 <strong>演示快照</strong></span></div>`;
  }
  function orderFromForm(form) {
    const raw = A.readForm(form),
      order = {};
    for (const [key, inputValue] of Object.entries(raw))
      if (key.startsWith('commerce-') && !['commerce-saleCurrencyChosen', 'commerce-saleManual', 'commerce-emailCostManual'].includes(key))
        order[key.slice(9)] = String(inputValue).trim();
    for (const key of [
      'paidConfirmed',
      'receiptConfirmed',
      'costConfirmed',
      'includeIssueFee',
      'balanceReversalConfirmed'
    ])
      order[key] = raw[`commerce-${key}`] === 'on';
    order.accountSource = order.businessType === '成品交付' ? '库存' : '客户自有';
    if (order.businessType !== '成品交付') {
      const existingAccount = orders.find(row => row.id === order.id);
      const summary = A.modules.inventory?.accountSummaryForEmail?.(order.email, order.product);
      order.accountId = existingAccount?.accountId || (summary?.systemOwned &&
        !inventoryRenewalIssue(order.email, order.customerId, order.product) ? summary.assetId : '');
      if (order.accountId) order.accountSource = '库存';
    }
    order.emailCostAmount ||= '0';
    order.emailCostCurrency ||= 'CNY';
    if (localData && (order.costBasis !== 'actual' || order.payment !== '苹果内购'))
      order.appleRecoverableCostAmount = '';
    if (order.payment === '苹果内购') {
      order.cardId = '';
      order.paidCurrency = 'USD';
      order.paymentId = A.modules.appleBalance?.get?.(order.appleIdId)?.email || '';
    } else order.appleIdId = '';
    if (order.product === 'GPT') {
      order.tenantId = '';
      order.ownerPhone = '';
      order.verifier = '';
      order.verifierPhone = '';
      order.phone = '';
      order.kyc = '未认证';
    }
    if (order.product !== 'GPT') {
      const existing = orders.find((row) => row.id === order.id);
      const tenant = tenants.find((row) => row.id === order.tenantId);
      order.verifier = tenant?.name || existing?.verifier || '';
      order.verifierPhone = tenant?.phone || existing?.verifierPhone || '';
      order.ownerPhone = existing?.ownerPhone || '';
    }
    const existingOrder = orders.find((row) => row.id === order.id);
    if (existingOrder) {
      order.owner = existingOrder.owner || '';
      if (Object.hasOwn(existingOrder, 'ownerId')) order.ownerId = existingOrder.ownerId;
      else delete order.ownerId;
    } else {
      const operator = currentOperator();
      order.ownerId = form.querySelector?.('select#commerce-ownerId')?.value || order.ownerId || operator.id;
      order.owner = order.ownerId === operator.id ? operator.name :
        orderOwners.find(row => row.id === order.ownerId)?.name || '';
    }
    if (automaticOrder(existingOrder)) {
      for (const key of ['source', 'product', 'businessType', 'email', 'plan', 'payment', 'paymentId', 'cardId',
        'paidAmount', 'paidCurrency', 'start', 'expiry', 'paidConfirmed'])
        order[key] = existingOrder[key];
    }
    order.includeIssueFee = Boolean(order.product === 'GPT' && order.payment === '银行卡' &&
      order.cardId && order.paidConfirmed && order.costBasis === 'standard' &&
      !cardIssueRecorded(order.cardId, order.id) && (cards().find((card) => card.id === order.cardId)?.usageCount || 0) === 0);
    return order;
  }
  function workbenchOrderSource(route) {
    const id = route.slice(renewalOrderPrefix.length);
    return renewalProjection().reminders.find((row) =>
      encodeURIComponent(row.order.id) === id && row.state !== 'processed');
  }
  function renderOrderPage() {
    const renewal = S.route.startsWith(renewalOrderPrefix);
    const source = renewal ? workbenchOrderSource(S.route) : null;
    const product = source?.order.product || (S.route === claudeOrderRoute ? 'Claude Pro' : 'GPT');
    return (
      A.header(
        product === 'GPT' ? 'GPT 提交订单' : 'Claude 提交订单',
        '客户、账号、金额和周期分组录入；短字段同排，保存前核对成本与来源。',
        (renewal ? routeButton('返回续费管理', renewalRoute, '', 'return') : '') +
          (canManageOrders()
            ? A.button('套餐售价设置', 'commerce-price-settings', '', 'settings', `data-product="${E(product)}"`) : ''),
        renewal ? '续费录单' : '订单工作台'
      ) + (renewal && !source
        ? `<section class="panel">${A.empty('续费提醒已变化', '请返回续费管理查看最新状态。')}</section>`
        : orderEditor('', '', true, source, product))
    );
  }
  function orderColumns(product = '') {
    return [
      { id: 'orderNo', label: '订单编号' },
      { id: 'owner', label: '归属人', render: (row) => E(orderOwnerName(row)) },
      { id: 'customerId', label: '客户', render: (row) => E(customerLabel(row.customerId)) },
      { id: 'email', label: '邮箱账号', class: 'email-cell' },
      { id: 'plan', label: '套餐' },
      { id: 'businessType', label: '业务类型' },
      { id: 'payment', label: '支付方式' },
      { id: 'paymentId', label: '卡尾号 / ID' },
      {
        id: 'paidAmount',
        label: '代付金额',
        render: (row) => E(`${display(row.paidAmount)} ${currencyLabel(row.paidCurrency)}`)
      },
      {
        id: 'saleAmount',
        label: '售卖金额',
        render: (row) =>
          row.saleAmount === ''
            ? A.tag('待补全', 'warning')
            : E(`${display(row.saleAmount)} ${currencyLabel(row.saleCurrency)}`)
      },
      {
        id: 'profit',
        label: `核算收益（${currencyLabel(costSettings.currency)}）`,
        render: (row) => {
          const p = shownProfit(row);
          return p === null ? A.tag('待核算', 'warning') : E(display(p));
        }
      },
      { id: 'start', label: '订阅时间' },
      { id: 'expiry', label: '到期时间' },
      { id: 'expiryReminder', label: '到期提醒', render: expiryTag },
      {
        id: 'paymentStatus',
        label: '付款状态',
        render: (row) => A.tag(paymentStatus(row), row.paidConfirmed ? 'success' : 'warning')
      },
      {
        id: 'expiryStatus',
        label: '订阅状态',
        render: (row) =>
          A.tag(subscriptionStatus(row), subscriptionStatus(row) === '有效' ? 'success' : 'warning')
      },
      {
        id: 'refundStatus',
        label: '退款状态',
        render: (row) => A.tag(refundStatus(row), row.refunds.length ? 'warning' : '')
      },
      {
        id: 'accountStatus',
        label: '账号运营',
        render: (row) =>
          A.tag(accountStatus(row), accountStatus(row) === '使用中' ? 'success' : 'warning')
      },
      {
        id: 'businessStatus',
        label: '订单业务状态',
        render: (row) => A.tag(row.cancelled ? '已撤单' : '正常')
      },
      {
        id: 'status',
        label: '资料完整性',
        render: (row) =>
          A.tag(orderStatus(row), completenessReasons(row).length ? 'warning' : 'success')
      },
      { id: 'wechat', label: '客户微信' },
      { id: 'customerPhone', label: '客户电话' },
      { id: 'whatsapp', label: 'WhatsApp' },
      { id: 'telegram', label: 'Telegram' },
      ...(product.startsWith('Claude')
        ? [
            { id: 'phone', label: '订阅电话', render: (row) => E(row.phone || '未记录') },
            { id: 'kyc', label: '验证状态', render: (row) => E(row.kyc || '未记录') },
            { id: 'verifier', label: '认证人', render: (row) => E(row.verifier || '未记录') },
            {
              id: 'verifierPhone',
              label: '认证电话',
              render: (row) => E(row.verifierPhone || '未记录')
            },
            {
              id: 'tenantId',
              label: '租户',
              render: (row) => E(row.tenantId ? tenantLabel(row.tenantId) : '未记录')
            }
          ]
        : []),
      ...traceColumns(),
      { id: 'notes', label: '备注', long: true, render: (row) => E(row.notes || '未记录') },
      { id: 'source', label: '来源入口' },
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          `<div class="action-links">${A.textAction('详情', 'commerce-order-detail', `data-id="${E(row.id)}"`)}${canManageOrders() ? A.textAction('编辑', 'commerce-order-edit', `data-id="${E(row.id)}" ${row.cancelled ? 'disabled' : ''}`) + A.textAction('退款', 'commerce-order-refund', `data-id="${E(row.id)}" ${row.cancelled || !row.receiptConfirmed ? 'disabled' : ''}`) + A.textAction('更多', 'commerce-order-more', `data-id="${E(row.id)}" aria-haspopup="menu" aria-expanded="false"`, 'secondary', 'down') : ''}</div>`
      }
    ];
  }
  function expiryTag(order) {
    if (order.subscriptionEnded) return A.tag('已终止');
    const expiry = parseDate(order.expiry);
    if (!Number.isFinite(expiry)) return A.tag('到期待核对', 'warning');
    const remaining = Math.ceil((expiry - parseDate(now())) / 86400000);
    return A.tag(
      remaining >= 0 ? `${remaining} 天后到期` : `已过期 ${-remaining} 天`,
      remaining < 3 ? 'warning' : 'success'
    );
  }
  function renderOrders(product) {
    const filtered = orders.filter(
      (row) =>
        row.product === product &&
        (moduleState.orderTab === 'pending'
          ? pendingReasons(row).length && !row.cancelled
          : moduleState.orderTab === 'cancelled'
            ? row.cancelled
            : moduleState.orderTab === 'refunded'
              ? row.refunds.length > 0
              : !row.cancelled) &&
        (!S.query ||
          `${row.email} ${row.orderNo} ${customerLabel(row.customerId)} ${orderOwnerName(row)}`.includes(S.query))
    );
    return (
      A.header(
        `${product} 订单`,
        '查看订单、费用、到期及退款记录，待补全资料在原单上继续处理。',
        canManageOrders() ? A.button(
          product === 'GPT' ? 'GPT 提交订单' : 'Claude 提交订单',
          'commerce-new-product-order',
          'primary',
          'plus',
          `data-product="${product}"`
        ) : ''
      ) +
      `<section class="panel">${tabs(
        [
          ['all', '当前订单'],
          ['pending', '待补全'],
          ['refunded', '有退款记录'],
          ['cancelled', '已撤单']
        ],
        moduleState.orderTab,
        'commerce-order-tab'
      )}${toolbar('搜索订单编号、邮箱或客户', columnSettingsButton(`commerce-orders-${product}`) + routeButton('数据统计', 'orders/statistics'), 'data-page-actions')}${tableList(orderColumns(product), filtered, `commerce-orders-${product}`)}${quoteAttribution(filtered)}</section>`
    );
  }
  function orderDetail(id, activeTab = 'details', asPage = false) {
    const order = orders.find((row) => row.id === id);
    if (!isClaude(order) && activeTab === 'renewals') activeTab = 'details';
    if (!order)
      return asPage ? A.header('订单详情') + A.empty('订单不存在', '请返回订单列表选择资料。') : '';
    const content =
      activeTab === 'costs'
        ? costDetail(order)
        : activeTab === 'refunds'
          ? refundRecords(order)
          : activeTab === 'history'
            ? timeline(order.id)
            : activeTab === 'renewals'
              ? renewalChain(order)
              : `<div class="property-list">${property('订单编号', order.orderNo)}${property('来源入口', order.source)}${property('来源任务', order.taskId)}${property('产品 / 套餐', `${order.product} / ${order.plan}`)}${property('业务类型', order.businessType)}${property('邮箱账号', order.email)}${property('客户', customerLabel(order.customerId))}${property('微信', order.wechat)}${property('客户电话', order.customerPhone)}${property('QQ', order.qq)}${property('WhatsApp', order.whatsapp)}${property('Telegram', order.telegram)}${property('支付方式', order.payment)}${property('卡尾号 / ID', order.paymentId)}${property('订阅时间', order.start)}${property('到期时间', order.expiry)}${property('租户', tenantLabel(order.tenantId))}${property('归属人', orderOwnerName(order))}${property('认证人', order.verifier)}${property('认证电话', order.verifierPhone)}${property('验证状态', order.kyc)}${property('付款状态', paymentStatus(order))}${property('历史付款证据', hasPaymentHistory(order) ? '已保留实际付款记录，更正复选框不会删除' : '未登记实际付款')}${property('资料完整性', orderStatus(order))}${property('订阅状态', subscriptionStatus(order))}${property('退款状态', refundStatus(order))}${property('账号运营状态', accountStatus(order))}${property('订单业务状态', order.cancelled ? '已撤单' : '正常')}${property('待核对', pendingReasons(order).join('、') || '资料已核对')}${traceProperties(order)}${property('备注', order.notes)}</div>`;
    const detailBody = `<div class="tabs" role="tablist"${asPage ? ' data-page-actions="tabs"' : ''}>${[
      ['details', '资料'],
      ['costs', '成本与汇率'],
      ['refunds', '退款记录'],
      ...(isClaude(order) ? [['renewals', '同账号订单']] : []),
      ['history', '操作记录']
    ]
      .map(
        ([tab, title]) =>
          `<button role="tab" aria-selected="${tab === activeTab}" class="tab ${tab === activeTab ? 'active' : ''}" data-action="commerce-order-detail-tab" data-id="${id}" data-tab="${tab}">${title}</button>`
      )
      .join('')}</div><div class="form-section">${content}</div>`;
    const actions = canManageOrders() ? A.button(
      '编辑资料',
      'commerce-order-edit',
      'primary',
      '',
      `data-id="${id}" ${order.cancelled ? 'disabled' : ''}`
    ) : '';
    if (asPage)
      return (
        A.header(
          '订单详情',
          `${order.orderNo} · 业务记录、费用和历史互相追溯。`,
          routeButton(
            '返回订单列表',
            order.product === 'GPT'
              ? 'orders/gpt'
              : order.product === 'Claude Pro'
                ? 'orders/pro'
                : 'orders/max'
          ) + actions
        ) + `<section class="panel">${detailBody}</section>`
      );
    A.openDrawer(
      '订单详情',
      `${order.orderNo} · 业务记录、费用和历史互相追溯。`,
      detailBody,
      A.button('关闭', 'drawer-close') + actions
    );
  }

  function quoteTime(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms)
      ? new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
      : '待核对';
  }
  function quoteAttribution(rows) {
    if (!localData || !finance?.automaticProvider ||
        !rows.some((row) => row.fxSnapshot?.provider === finance.automaticProvider.id)) return '';
    return `<p class="footnote panel-body"><a href="${E(finance.automaticProvider.attributionUrl)}" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a></p>`;
  }
  function localCostDetail(order) {
    const result = localAccounting(order);
    const pending = pendingReasons(order, result);
    const amount = (value) => `${display(value)} ${currencyLabel(result.currency)}`;
    const snapshot = order.fxSnapshot;
    const output = result.status === 'ready'
      ? result.items.map((row) => property(row.label, amount(row.amount))).join('') +
        property('退款后净收款', amount(result.revenue)) +
        property('原成本合计', amount(result.originalCost)) +
        property('实际收回成本', amount(result.recoveredCost)) +
        property('回款后净成本', amount(result.netCost))
      : '';
    return `<div class="property-list">${property('代付金额', `${display(order.paidAmount)} ${currencyLabel(order.paidCurrency)}`)}${property('售卖金额', `${display(order.saleAmount)} ${currencyLabel(order.saleCurrency)}`)}${property('核算依据', order.costBasis === 'actual' ? '实际总成本' : '标准费用规则')}${property('费用规则版本', order.costSettings?.version ? `V${order.costSettings.version}` : '待核对')}${property('客户累计退款', `${display(sum(order.refunds || [], (row) => row.amount))} ${currencyLabel(order.saleCurrency)}`)}${output}${property('本单核算收益', pending.length || order.cancelled ? '待核算' : amount(result.profit))}${property('核算缺口', pending.join('、') || '已确认')}</div>${
      panelTitle('订单汇率快照', '每 1 单位外币对应的人民币金额。仅使用本订单记录的汇率。', finance && !snapshot && !order.cancelled
        ? A.button('登记汇率快照', 'commerce-order-fx', 'primary', '', `data-id="${E(order.id)}"`) +
          (finance.requestAutomaticSnapshot && S.actor?.role !== 'employee'
            ? A.button('获取并冻结自动报价', 'commerce-order-auto-fx', '', '', `data-id="${E(order.id)}"`)
            : '')
        : '')
    }${snapshot ? `<div class="property-list">${property(snapshot.kind === 'automatic' ? '自动报价来源' : '手工登记来源', snapshot.source)}${snapshot.fetchedAt ? property('采集时间（北京时间）', quoteTime(snapshot.fetchedAt)) : ''}${property('报价时点（北京时间）', quoteTime(snapshot.at))}${property('有效截止（北京时间）', quoteTime(snapshot.expiresAt))}${property('核算时点（北京时间）', quoteTime(snapshot.basisAt))}${Object.entries(snapshot.rates).map(([code, rate]) => property(currencyLabel(code), rate)).join('')}</div>`
      : A.empty('尚无订单汇率快照', finance?.requestAutomaticSnapshot
        ? '可获取覆盖本次订阅时点的有效报价，或根据原订单的凭据手工登记。'
        : '核对原订单的真实报价凭据后登记。当前使用手工来源。')}${quoteAttribution([order])}`;
  }
  async function freezeAutomaticSnapshot(id, trigger) {
    const order = orders.find((row) => row.id === id);
    if (!localData || !finance?.requestAutomaticSnapshot || !order || order.cancelled ||
        order.fxSnapshot || automaticSnapshotRequests.has(id)) return;
    const actorId = S.actor?.id;
    automaticSnapshotRequests.add(id);
    if (trigger) trigger.disabled = true;
    try {
      const result = await finance.requestAutomaticSnapshot(id, order.version);
      if (S.actor?.id !== actorId) return;
      acceptLocalCommerce(result);
      if (trigger?.isConnected && trigger.closest('#drawer')?.open) orderDetail(id, 'costs');
      if (S.route.startsWith('orders/')) A.render();
      if (trigger) A.notify('自动汇率快照已冻结');
    } catch (error) {
      if (trigger && S.actor?.id === actorId) A.notify(error.message || '暂时无法冻结自动报价');
    } finally {
      automaticSnapshotRequests.delete(id);
      if (trigger?.isConnected) trigger.disabled = false;
    }
  }
  function openFxSnapshot(id) {
    const order = orders.find((row) => row.id === id);
    if (!localData || !finance || !order || order.fxSnapshot || order.cancelled) return;
    const key = `commerce-fx:${id}`;
    const draft = S.drafts.get(key) || {};
    const v = (name) => value(draft, name);
    const required = finance.requiredQuoteCurrencies(order);
    const rateInputs = currencies.filter((code) => code !== 'CNY').map((code) => {
      const fieldId = `fx-${code}`;
      return field(currencyLabel(code), fieldId, input(fieldId, v(fieldId), 'inputmode="decimal"'), required.includes(code));
    }).join('');
    A.openDrawer(
      '登记订单汇率快照',
      `${order.orderNo} · 订阅时点 ${order.start || '待补充'}（北京时间）。保存后冻结。`,
      `<form id="commerce-fx-form" data-commerce-draft="${E(key)}" novalidate><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-version" value="${E(v('version') || order.version)}" /><div class="commerce-field-grid">${field('报价来源与凭据', 'fx-source', input('fx-source', v('fx-source'), 'maxlength="160"'), true, '填写可核对的真实来源与报价凭据编号。', 'commerce-span-all')}${field('报价时点', 'fx-at', input('fx-at', v('fx-at'), 'type="datetime-local"'), true)}${field('有效截止', 'fx-expiresAt', input('fx-expiresAt', v('fx-expiresAt'), 'type="datetime-local"'), true, '报价在该时刻起失效；时间均为北京时间。')}</div><section class="form-section"><h3>每 1 单位外币折合人民币</h3><p class="footnote">人民币基准固定为 1，马币用于统计切换。汇率最多八位小数。</p><div class="commerce-field-grid">${rateInputs}</div></section></form>`,
      A.button('取消', 'drawer-close') + '<button type="submit" form="commerce-fx-form" class="button primary">核对快照</button>',
      key
    );
  }
  function saveFxSnapshot(form) {
    if (!localData || !finance || saving) return;
    saveDrafts();
    const raw = A.readForm(form);
    const order = orders.find((row) => row.id === value(raw, 'id'));
    const version = value(raw, 'version');
    if (!order || order.cancelled || order.fxSnapshot || String(order.version) !== version) {
      A.notify('订单版本已变化或已有快照，请重新核对');
      return;
    }
    let snapshot;
    try {
      snapshot = finance.createOrderSnapshot({
        source: value(raw, 'fx-source'),
        at: value(raw, 'fx-at'),
        expiresAt: value(raw, 'fx-expiresAt'),
        rates: Object.fromEntries(currencies.filter((code) => code !== 'CNY').map((code) => [code, value(raw, `fx-${code}`)]))
      }, order);
    } catch (error) {
      A.notify(error.message);
      return;
    }
    const key = form.dataset.commerceDraft;
    A.confirmAction('确认冻结订单汇率',
      `${order.orderNo} · ${snapshot.source} · ${quoteTime(snapshot.at)} 至 ${quoteTime(snapshot.expiresAt)}（北京时间）。`,
      () => persistCommerce(finance.snapshotAction, () => {
        const current = orders.find((row) => row.id === order.id);
        if (!current || current.cancelled || current.fxSnapshot || String(current.version) !== version) {
          A.notify('订单版本已变化或已有快照，请重新核对');
          return false;
        }
        const operator = currentOperator();
        Object.assign(current, {
          fxSnapshot: snapshot, version: current.version + 1,
          updatedAt: now(), updatedBy: operator.name, updatedById: operator.id
        });
        log(finance.snapshotAction, current.id, current.orderNo);
      }, () => {
        cleanClose(key);
        if (S.route.startsWith('orders/detail/')) A.render();
        else orderDetail(order.id, 'costs');
        A.notify('订单汇率快照已冻结');
      }),
      '确认冻结'
    );
  }
  function renderLocalFxSources(orders) {
    const rows = orders.filter((order) => order.fxSnapshot);
    const description = panelTitle('订单汇率来源', finance?.requestAutomaticSnapshot
      ? '自动与手工报价分别记录。每笔订单保留自己的报价与有效期。'
      : '当前使用手工报价。每笔订单保留自己的报价与有效期。');
    if (!rows.length) return description + A.empty('暂无订单汇率快照', '可从订单详情的「成本与汇率」登记。');
    return description + tableList([
      { id: 'orderNo', label: '订单编号' },
      { id: 'source', label: '报价来源', render: (row) => E(row.fxSnapshot.source) },
      { id: 'at', label: '报价时点', render: (row) => E(quoteTime(row.fxSnapshot.at)) },
      { id: 'expiresAt', label: '有效截止', render: (row) => E(quoteTime(row.fxSnapshot.expiresAt)) },
      { id: 'actions', label: '操作', action: true, render: (row) =>
        A.textAction('查看快照', 'commerce-order-fx-detail', `data-id="${E(row.id)}"`) }
    ], rows, 'commerce-stat-snapshots');
  }

  function costDetail(order) {
    if (localData) return localCostDetail(order);
    const cost = costsFor(order),
      pending = pendingReasons(order);
    return `<div class="property-list">${property('代付金额', `${display(order.paidAmount)} ${currencyLabel(order.paidCurrency)}`)}${property('售卖金额', `${display(order.saleAmount)} ${currencyLabel(order.saleCurrency)}`)}${property('核算依据', order.costBasis === 'actual' ? '实际总成本' : '标准费用规则')}${property('开卡费快照', order.issueFeeSnapshot?.applied ? `${order.issueFeeSnapshot.amountUsd} ${currencyLabel('USD')} · 已在本单一次计入` : '本单未计入开卡费')}${property('规则版本', `V${order.costSettings.version}`)}${property('汇率快照', order.rateAt)}${cost.items.map((row) => property(row.label, `${display(row.amount)} ${currencyLabel('CNY')}`)).join('')}${property('标准净成本合计', `${display(cost.standard)} ${currencyLabel('CNY')}`)}${property('实际净成本（已减 Apple 到账退回）', cost.actual === null ? '未录入' : `${display(cost.actual)} ${currencyLabel('CNY')}`)}${property('累计退款', `${display(sum(order.refunds, (row) => row.amount))} ${currencyLabel(order.saleCurrency)}`)}${property('本单核算收益', profit(order) === null ? '待核算' : `${display(shownCurrency(profit(order), costSettings.currency, order.rates))} ${currencyLabel(costSettings.currency)}`)}${property('核算缺口', pending.join('、') || '已确认')}${property('租金发放', '仅记发放状态，实际租金已计成本，不再次扣除')}</div>${panelTitle('订单采用的演示汇率')}${A.table(
      [
        { id: 'currency', label: '币种', render: (row) => E(currencyLabel(row.currency)) },
        { id: 'rate', label: '兑人民币' }
      ],
      Object.entries(order.rates).map(([currency, rate]) => ({ id: currency, currency, rate })),
      '',
      'commerce-order-rates'
    )}`;
  }
  function refundRecords(order) {
    const returns = A.modules.appleBalance?.listRefunds?.(order.id) || [];
    const appleColumns =
      localData && (order.payment === '苹果内购' || returns.length)
        ? [
            { id: 'appleId', label: '原付款苹果 ID', render: (row) => E(row.appleId || '—') },
            {
              id: 'appleAmount',
              label: 'ID 回款金额',
              render: (row) =>
                row.appleAmount ? E(`${display(row.appleAmount)} ${currencyLabel('USD')}`) : '—'
            },
            { id: 'appleStatus', label: 'ID 回款状态', render: (row) => E(row.appleStatus || '—') }
          ]
        : [];
    const rows = order.refunds.map((refund) => {
      const returned = returns.find((row) => row.id === refund.id);
      return {
        ...refund,
        appleId:
          returned &&
          (returned.appleEmail ||
            A.modules.appleBalance.get?.(returned.appleIdId)?.email ||
            order.paymentId),
        appleAmount: returned?.amount,
        appleStatus: { pending: '待回款', received: '已回款', none: '无需回款' }[returned?.status]
      };
    });
    const bankSection =
      localData && order.payment === '银行卡'
        ? `<section class="form-section">${panelTitle('银行卡实际回款', '', A.button('登记银行卡实际回款', 'commerce-bank-return', '', 'return', `data-id="${E(order.id)}" ${M.compare(bankReturnLimit(order), '0') > 0 ? '' : 'disabled'}`))}<div class="commerce-cost-strip"><span>已实际回款 <strong>${display(bankReturned(order))} ${currencyLabel(order.paidCurrency)}</strong></span></div>${A.table(
            [
              { id: 'amount', label: '实际回款金额' },
              { id: 'currency', label: '币种', render: (row) => E(currencyLabel(row.currency)) },
              { id: 'at', label: '实际到账时间' },
              { id: 'reason', label: '到账依据' },
              { id: 'actor', label: '登记人' }
            ],
            order.bankReturns || [],
            '',
            'commerce-bank-returns'
          )}</section>`
        : '';
    return `<div class="commerce-cost-strip"><span>原实收 <strong>${display(order.saleAmount)} ${currencyLabel(order.saleCurrency)}</strong></span><span>可继续退款 <strong>${display(refundable(order))} ${currencyLabel(order.saleCurrency)}</strong></span></div>${
      returns.some((row) => row.status === 'pending')
        ? `<div class="toolbar">${A.button('处理 Apple ID 回款', 'commerce-apple-refund', '', 'return', `data-id="${E(order.id)}"`)}</div>`
        : ''
    }${
      order.refunds.length
        ? A.table(
            [
              { id: 'amount', label: '退款金额' },
              { id: 'currency', label: '币种', render: (row) => E(currencyLabel(row.currency)) },
              { id: 'at', label: '退款时间' },
              { id: 'reason', label: '原因' },
              { id: 'actor', label: '登记人' },
              ...appleColumns
            ],
            rows,
            '',
            'commerce-refunds'
          )
        : A.empty('暂无退款记录', '登记实际退款后保留金额、时间、原因与操作人。')
    }${bankSection}`;
  }
  function renewalChain(order) {
    const rows = orders
      .filter((row) => isClaude(row) && row.email.toLowerCase() === order.email.toLowerCase())
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return A.table(
      [
        { id: 'orderNo', label: '独立订单' },
        { id: 'businessType', label: '业务类型' },
        { id: 'start', label: '订阅时间' },
        { id: 'expiry', label: '到期时间' }
      ],
      rows,
      '',
      'commerce-claude-history'
    );
  }

  function renderClaude() {
    if (S.route.includes('/rentals/')) return renderRentBatch(S.route.split('/').at(-1));
    if (S.route.endsWith('/rentals')) moduleState.claudeTab = 'rentals';
    const all = currentSubscriptions();
    const rows = all.filter(
      (row) =>
        row.operation.status === moduleState.claudeTab &&
        (!S.query ||
          `${row.email} ${customerLabel(row.customerId)} ${tenantLabel(row.tenantId)} ${orderOwnerName(row)}`.includes(
            S.query
          ))
    );
    const columns = [
      { id: 'email', label: '邮箱账号', class: 'email-cell' },
      { id: 'plan', label: '套餐' },
      { id: 'customer', label: '客户', render: (row) => E(customerLabel(row.customerId)) },
      {
        id: 'contact',
        label: '联系方式',
        render: (row) =>
          A.textAction(
            '查看资料',
            'commerce-contact-detail',
            `data-id="${row.customerId}" data-kind="customer"`
          )
      },
      { id: 'payment', label: '支付方式' },
      { id: 'paymentId', label: '卡尾号 / ID' },
      { id: 'start', label: '订阅时间' },
      { id: 'expiry', label: '到期时间' },
      { id: 'expiryStatus', label: '订单状态', render: expiryTag },
      { id: 'phone', label: '订阅电话' },
      { id: 'kyc', label: '验证状态' },
      { id: 'verifier', label: '认证人' },
      {
        id: 'verifierPhone',
        label: '认证电话',
        render: (row) => E(row.verifierPhone || '未记录')
      },
      { id: 'tenant', label: '租户', render: (row) => E(tenantLabel(row.tenantId)) },
      { id: 'owner', label: '归属人', render: (row) => E(orderOwnerName(row)) },
      { id: 'createdAt', label: '录入时间', render: (row) => E(row.createdAt || '未记录') },
      { id: 'notes', label: '备注', long: true, render: (row) => E(row.notes || '未记录') },
      ...(moduleState.claudeTab !== 'active'
        ? [
            {
              id: 'statusAt',
              label: moduleState.claudeTab === 'frozen' ? '冻结时间' : '弃用时间',
              render: (row) => E(row.operation.at)
            }
          ]
        : []),
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          `<div class="action-links">${A.textAction('续费', 'commerce-order-renew', `data-id="${row.id}"`)}${A.textAction('记录', 'commerce-order-detail', `data-id="${row.id}"`)}${A.textAction('更多', 'commerce-subscription-more', `data-id="${row.id}" aria-haspopup="menu" aria-expanded="false"`, 'secondary', 'down')}</div>`
      }
    ];
    return (
      A.header(
        'Claude 专属',
        '当前订阅关联唯一客户，冻结、弃用、续费及付租保留完整历史。',
        A.button(
          '录入 Claude 订单',
          'commerce-new-product-order',
          'primary',
          'plus',
          'data-product="Claude Max"'
        )
      ) +
      A.summary([
        ['管理中', all.filter((row) => row.operation.status === 'active').length, '个账号', true],
        [
          '即将到期',
          all.filter(
            (row) => parseDate(row.expiry) - Date.parse('2026-11-03T10:30:00+08:00') < 7 * 86400000
          ).length,
          '个账号'
        ],
        [
          '待付租批次',
          rentBatches.filter((batch) =>
            batch.items.some((item) => item.status !== '已发放' && item.status !== '已取消')
          ).length,
          '个批次'
        ],
        ['待核算订单', all.filter((row) => pendingReasons(row).length).length, '条']
      ]) +
      `<section class="panel">${tabs(
        [
          ['active', '使用中'],
          ['frozen', '冻结'],
          ['abandoned', '弃用'],
          ['rentals', '付租批次']
        ],
        moduleState.claudeTab,
        'commerce-claude-tab',
        'data-page-actions="tabs"'
      )}${moduleState.claudeTab === 'rentals' ? renderRentList() : `${toolbar('搜索邮箱、客户、租户或归属人', columnSettingsButton('commerce-current-subscriptions') + A.button('生成付租批次', 'commerce-rent-create', '', 'orders', A.getSelection('commerce-subscriptions').size ? '' : 'disabled'))}${tableList(columns, rows, 'commerce-current-subscriptions', 'commerce-subscriptions')}`}</section>`
    );
  }
  function rentBatchStatus(batch) {
    const sent = batch.items.filter((row) => row.status === '已发放').length;
    return sent === batch.items.length
      ? '发放完毕'
      : sent > 0
        ? '部分完成'
        : batch.items.every((row) => row.status === '已取消')
          ? '已取消'
          : '待发放';
  }
  function renderRentList() {
    const rows = rentBatches.filter(
      (row) => !S.query || `${row.id} ${row.notes}`.includes(S.query)
    );
    return (
      toolbar('搜索批次或备注') +
      (rows.length
        ? A.table(
            [
              { id: 'id', label: '付租批次' },
              { id: 'count', label: '明细数量', render: (row) => String(row.items.length) },
              {
                id: 'status',
                label: '发放状态',
                render: (row) =>
                  A.tag(
                    rentBatchStatus(row),
                    rentBatchStatus(row) === '发放完毕' ? 'success' : 'warning'
                  )
              },
              { id: 'at', label: '创建时间' },
              { id: 'notes', label: '备注', long: true },
              {
                id: 'actions',
                label: '操作',
                action: true,
                render: (row) =>
                  `<div class="action-links">${A.textAction('逐项处理', 'commerce-rent-detail', `data-id="${row.id}"`)}${A.textAction('复制明细', 'commerce-rent-copy', `data-id="${row.id}"`)}</div>`
              }
            ],
            rows,
            '',
            'commerce-rent-batches'
          )
        : A.empty('还没有付租批次', '选择账号和租赁期间后生成待发放批次，逐项登记是否发放。'))
    );
  }
  function rentCreate() {
    const ids = [...A.getSelection('commerce-subscriptions')],
      rows = currentSubscriptions().filter((row) => ids.includes(row.id));
    if (!rows.length) {
      A.notify('请先选择 Claude 账号');
      return;
    }
    const key = 'commerce-rent:new',
      draft = S.drafts.get(key) || {};
    const fields = rows
      .map(
        (row) =>
          `<div class="guide-item"><h3>${E(row.email)}</h3><div class="commerce-field-grid">${field('发放对象', `rent-tenant-${row.id}`, select(`rent-tenant-${row.id}`, [['', '请选择发放对象'], ...tenants.filter((tenant) => tenant.active).map((tenant) => [tenant.id, tenant.name])], draft[`commerce-rent-tenant-${row.id}`] || row.tenantId), true, '', 'commerce-span-2')}</div></div>`
      )
      .join('');
    A.openDrawer(
      '生成租金发放批次',
      '实际租金已计入成本；这里只记录是否发放，不登记金额、币种或新增费用。',
      `<form id="commerce-rent-create-form" data-commerce-draft="${key}" novalidate><input name="commerce-ids" type="hidden" value="${E(ids.join(','))}" /><div class="commerce-field-grid">${field('期间开始', 'rent-start', input('rent-start', draft['commerce-rent-start'] ?? '2026-11-03', 'type="date"'), true)}${field('期间结束', 'rent-end', input('rent-end', draft['commerce-rent-end'] ?? '2026-12-02', 'type="date"'), true)}${field('批次备注', 'rent-notes', input('rent-notes', draft['commerce-rent-notes'] || ''), false, '', 'commerce-span-all')}</div><div class="guide-list form-section">${fields}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" form="commerce-rent-create-form" class="button primary">核对批次</button>',
      key
    );
  }
  function renderRentBatch(id) {
    const batch = rentBatches.find((row) => row.id === id);
    if (!batch)
      return A.header('付租批次') + A.empty('批次不存在', '请返回 Claude 专属查看现有批次。');
    return (
      A.header(
        '租金发放批次详情',
        `${batch.id} · 逐项登记发放状态，不重复扣除订单成本。`,
        routeButton('返回批次列表', 'orders/exclusive/rentals') +
          A.button('复制明细', 'commerce-rent-copy', '', 'copy', `data-id="${batch.id}"`)
      ) +
      `<section class="panel">${panelTitle(batch.id, batch.notes, '', 'data-page-actions')}${A.table(
        [
          { id: 'email', label: '账号邮箱' },
          { id: 'tenantId', label: '发放对象', render: (row) => E(tenantLabel(row.tenantId)) },
          { id: 'period', label: '租赁期间' },
          {
            id: 'status',
            label: '发放状态',
            render: (row) =>
              A.tag(
                row.status,
                row.status === '已发放'
                  ? 'success'
                  : row.status === '发放失败'
                    ? 'danger'
                    : 'warning'
              )
          },
          { id: 'paidAt', label: '发放时间' },
          { id: 'notes', label: '备注', long: true },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (row) =>
              `<div class="action-links">${row.status !== '已发放' && row.status !== '已取消' ? A.textAction('登记发放', 'commerce-rent-item', `data-batch="${batch.id}" data-id="${row.id}"`) : ''}${A.textAction('记录', 'commerce-rent-item-log', `data-batch="${batch.id}" data-id="${row.id}"`)}</div>`
          }
        ],
        batch.items,
        '',
        'commerce-rent-items'
      )}${panelTitle('批次记录')}${timeline(batch.id)}</section>`
    );
  }

  function renderStatistics() {
    const active = orders.filter((row) => !row.cancelled);
    const amounts = new Map(active.map((row) => {
      const accounting = localData ? localAccounting(row) : null;
      const gain = profit(row, accounting);
      return [row.id, {
        profit: gain === null || localData ? gain : shownCurrency(gain, costSettings.currency, row.rates),
        revenue: gain === null ? null : localData
          ? accounting.revenue
          : shownCurrency(cny(refundable(row), row.saleCurrency, row.rates), costSettings.currency, row.rates),
        reasons: pendingReasons(row, accounting)
      }];
    }));
    const complete = active.filter((row) => amounts.get(row.id).profit !== null);
    const pending = active.filter((row) => amounts.get(row.id).profit === null);
    const reported = (rows, field) => rows.length ? display(sum(rows, (row) => amounts.get(row.id)[field])) : '—';
    const selected = moduleState.statsTab === 'pending' ? pending : complete;
    return (
      A.header(
        '订单数据统计',
        '按已确认订单快照统计，可钻取原单；缺失资料不按零成本计核算收益。',
        `<select id="commerce-stat-currency" aria-label="统计币种">${A.options(
          [
            ['CNY', '人民币 CNY'],
            ['MYR', '马币 MYR']
          ],
          costSettings.currency
        )}</select>${routeButton('费用规则', 'settings/costs', '', 'settings')}`
      ) +
      A.summary([
        ['已核算订单', complete.length, '条', true],
        [`确认净收款（${currencyLabel(costSettings.currency)}）`, reported(complete, 'revenue'), costSettings.currency],
        [`确认核算收益（${currencyLabel(costSettings.currency)}）`, reported(complete, 'profit'), costSettings.currency],
        ['待核算', pending.length, '条']
      ]) +
      quoteAttribution(active) +
      `<section class="panel">${tabs(
        [
          ['overview', '统计概览'],
          ['details', '来源订单'],
          ['pending', '待核算'],
          ['rates', localData ? '汇率来源' : '演示汇率记录']
        ],
        moduleState.statsTab,
        'commerce-stats-tab',
        'data-page-actions="tabs"'
      )}${
        moduleState.statsTab === 'rates'
          ? localData
            ? renderLocalFxSources(active)
            : `${panelTitle('本次演示汇率', '以下为固定演示值，不代表实时汇率。正式订单需要有效来源和采集时间。')}${A.table(
                [
                  {
                    id: 'currency',
                    label: '币种',
                    render: (row) => E(currencyLabel(row.currency))
                  },
                  { id: 'rate', label: '兑人民币' },
                  { id: 'source', label: '来源' },
                  { id: 'at', label: '采集时间' }
                ],
                Object.entries(fxRates).map(([currency, rate]) => ({
                  id: currency,
                  currency,
                  rate,
                  source: '固定演示值',
                  at: '2026-11-03 09:00 UTC+8'
                })),
                '',
                'commerce-stat-rates'
              )}`
          : moduleState.statsTab === 'overview'
            ? `${panelTitle('按产品汇总', '每个汇总可进入来源订单核对。统计切换只改变显示，不改原币金额和历史成本。')}${A.table(
                [
                  { id: 'product', label: '产品' },
                  { id: 'count', label: '已核算订单' },
                  { id: 'revenue', label: `净收款（${currencyLabel(costSettings.currency)}）` },
                  { id: 'profit', label: `核算收益（${currencyLabel(costSettings.currency)}）` },
                  { id: 'pending', label: '待核算' },
                  {
                    id: 'actions',
                    label: '操作',
                    action: true,
                    render: (row) =>
                      routeButton(
                        '查看来源',
                        row.product === 'GPT'
                          ? 'orders/gpt'
                          : row.product === 'Claude Pro'
                            ? 'orders/pro'
                            : 'orders/max',
                        'compact'
                      )
                  }
                ],
                Object.keys(productPlans).map((product) => {
                  const rows = complete.filter((row) => row.product === product);
                  return {
                    id: product,
                    product,
                    count: String(rows.length),
                    revenue: reported(rows, 'revenue'),
                    profit: reported(rows, 'profit'),
                    pending: String(pending.filter((row) => row.product === product).length)
                  };
                }),
                '',
                'commerce-product-statistics'
              )}`
            : `${toolbar('搜索订单、客户或邮箱')}${tableList(
                [
                  { id: 'orderNo', label: '来源订单' },
                  { id: 'email', label: '账号' },
                  { id: 'product', label: '产品' },
                  {
                    id: 'reason',
                    label: moduleState.statsTab === 'pending' ? '待核算原因' : '核算状态',
                    render: (row) => E(amounts.get(row.id).reasons.join('、') || '已确认')
                  },
                  {
                    id: 'amount',
                    label: `核算收益（${currencyLabel(costSettings.currency)}）`,
                    render: (row) => {
                      const amount = amounts.get(row.id).profit;
                      return amount === null ? A.tag('待核算', 'warning') : E(display(amount));
                    }
                  },
                  {
                    id: 'actions',
                    label: '操作',
                    action: true,
                    render: (row) =>
                      A.textAction('查看原单', 'commerce-order-detail', `data-id="${row.id}"`)
                  }
                ],
                selected.filter(
                  (row) =>
                    !S.query ||
                    `${row.orderNo} ${row.email} ${customerLabel(row.customerId)}`.includes(S.query)
                ),
                'commerce-stat-detail'
              )}`
      }</section>`
    );
  }

  function contactKey(text, channel) {
    const normalized = String(text || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase();
    if (channel === 'telegram') return normalized.replace(/^@/, '');
    if ((channel === 'phone' || channel === 'whatsapp') && /^\+?[\d\s().-]+$/.test(normalized))
      return normalized.replace(/[\s().-]/g, '');
    return normalized;
  }
  function customerDuplicates(id, name, contacts) {
    const matches = [];
    for (const row of customers) {
      if (row.id === id) continue;
      const channel = customerChannels.find(([key]) => {
        const normalized = contactKey(contacts[key], key);
        return normalized && normalized === contactKey(row[key], key);
      });
      if (channel) matches.push({ row, channel });
    }
    return {
      duplicate: matches.find(({ row }) => contactKey(row.name) === contactKey(name)),
      sharedContact: matches[0]?.channel[1] || ''
    };
  }
  function showDuplicate({ row, channel: [key, label] }) {
    const fieldId = `commerce-contact-${key}`;
    A.setError(
      fieldId,
      row.active
        ? `已有同名客户使用此${label}，请在客户数据中查找或在订单中选择该客户。`
        : `已有同名客户使用此${label}，请在客户数据的“已停用”中核对并恢复。`
    );
    document.getElementById(fieldId)?.focus();
  }
  function showNewContactInList(tenant) {
    const list = tenant ? 'customers/tenants' : 'customers/list';
    moduleState[tenant ? 'tenantMode' : 'customerMode'] = 'active';
    if (S.route === list) {
      S.query = '';
      S.page = 1;
      A.render();
    } else {
      const view = S.viewDrafts?.get(list);
      S.viewDrafts?.set(list, { ...view, query: '', page: 1 });
      A.go(list);
    }
  }
  function saveContact(form) {
    const raw = A.readForm(form),
      kind = value(raw, 'kind'),
      data = kind === 'tenant' ? tenants : customers;
    const id = value(raw, 'id'),
      existing = data.find((row) => row.id === id);
    const name = value(raw, 'name'),
      phone = value(raw, 'phone');
    const operator = currentOperator();
    if (!operator.id || !operator.name) {
      A.notify('当前登录身份不可用，请重新登录后保存');
      return;
    }
    let tags = [];
    if (kind !== 'tenant') {
      try {
        tags = JSON.parse(raw['commerce-tags'] || '[]');
        if (
          !Array.isArray(tags) ||
          tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag !== tag.trim() || tag.length > 40) ||
          new Set(tags).size !== tags.length
        ) throw new Error('无效的客户标签');
      } catch {
        A.setError('commerce-contact-tags', '客户标签格式无效，请重新选择。');
        return;
      }
      const previous = existing?.tags || [];
      const allowed = new Set([...(A.modules.operations?.getCustomerTags?.() || []), ...previous]);
      let error = '';
      if (tags.some((tag) => !allowed.has(tag))) {
        error = '可选标签已变化，请取消已停用的新选项。';
      } else if (tags.length > 20 && tags.some((tag) => !previous.includes(tag))) {
        error = '每位客户最多选择 20 个标签。';
      }
      A.setError('commerce-contact-tags', error);
      if (error) {
        form.querySelector('#commerce-contact-tags')?.focus();
        return;
      }
    }
    const tenant = kind === 'tenant';
    const contacts = Object.fromEntries(customerChannels.map(([key]) => [key, value(raw, key)]));
    const contactError = tenant ? !phone : !Object.values(contacts).some(Boolean);
    for (const [key] of customerChannels)
      A.setError(
        `commerce-contact-${key}`,
        key === 'phone' && contactError
          ? tenant
            ? '请填写租户联系电话'
            : '请至少填写一种联系方式'
          : ''
      );
    A.setError('commerce-contact-name', name ? '' : '请填写姓名');
    if (!name || contactError) {
      document.getElementById(name ? 'commerce-contact-phone' : 'commerce-contact-name')?.focus();
      return;
    }
    if (existing && String(existing.version) !== value(raw, 'version')) {
      A.notify('资料已发生变化，请核对原版本再保存');
      return;
    }
    const match = tenant ? null : customerDuplicates(id, name, contacts);
    if (match?.duplicate) {
      showDuplicate(match.duplicate);
      return;
    }
    const tenantDuplicate =
      tenant &&
      data.some((row) => row.id !== id && row.active && row.name === name && row.phone === phone);
    const message = tenantDuplicate
      ? '存在同名同电话资料，请确认是否确实需要分别保存。'
      : match?.sharedContact
        ? `其他客户已使用此${match.sharedContact}。请核对是否为不同客户，分别保存不会合并资料。`
        : localData
          ? '将保存到本机数据库。'
          : '将保存本次演示资料。';
    const back = value(raw, 'quick') === 'yes' ? quickReturn : null;
    const route = S.route;
    const key = form.dataset.commerceDraft;
    A.confirmAction(
      existing ? '确认修改资料' : '确认新增资料',
      `${name}：${message}历史订单联系方式不会被改写。`,
      () => {
        if (currentOperator().id !== operator.id) {
          A.notify('登录身份已变化，请重新核对后保存');
          return;
        }
        if (form.isConnected === false || S.route !== route || (back && quickReturn !== back))
          return;
        if (match) {
          const latest = customerDuplicates(id, name, contacts);
          if (latest.duplicate) {
            showDuplicate(latest.duplicate);
            return;
          }
          if (latest.sharedContact && latest.sharedContact !== match.sharedContact) {
            A.notify('发现客户联系方式可能重复，请重新核对后保存');
            return;
          }
        }
        const editedAt = now();
        const snapshot = {
          name,
          ...contacts,
          notes: value(raw, 'notes'),
          owner: value(raw, 'owner'),
          ...(tenant ? {} : { tags }),
          updatedById: operator.id,
          updatedBy: operator.name,
          updatedAt: editedAt,
          source: value(raw, 'source')
        };
        if (existing && String(existing.version) !== value(raw, 'version')) {
          A.notify('资料版本已变化，保存已停止');
          return;
        }
        let saved;
        persistCommerce(
          existing ? '修改资料' : '新增资料',
          () => {
            if (existing) {
              Object.assign(existing, snapshot, { version: existing.version + 1 });
              saved = existing;
            } else {
              saved = {
                ...snapshot,
                id: uid(`commerce-${kind}`),
                version: 1,
                active: true,
                createdById: operator.id,
                createdBy: operator.name,
                createdAt: editedAt
              };
              data.unshift(saved);
            }
            log(
              existing ? '修改资料' : '新增资料',
              saved.id,
              `${kind === 'tenant' ? '租户' : '客户'} ${name}`
            );
          },
          () => {
            if (back) quickReturn = null;
            cleanClose(key);
            if (back) {
              const draft = S.drafts.get(back.key) || {};
              draft[`commerce-${tenant ? 'tenantId' : 'customerId'}`] = saved.id;
              if (!tenant)
                for (const [orderField, customerField] of orderContactFields)
                  draft[`commerce-${orderField}`] = saved[customerField];
              S.drafts.set(back.key, draft);
              if (back.main) A.render();
              else orderEditor(back.orderId, back.renewalId, false);
            } else if (
              !existing &&
              (tenant ? route === 'customers/new/tenant' : ['customers/new', 'customers/list'].includes(route))
            ) {
              showNewContactInList(tenant);
            } else A.render();
            A.notify(localData ? '资料已保存到本机' : '演示资料已保存');
          }
        );
      },
      '确认保存'
    );
  }
  function validateOrder(form, allowPending) {
    const order = orderFromForm(form),
      existing = orders.find((row) => row.id === order.id);
    if (localData && !existing && allowPending && order.payment === '苹果内购')
      order.paidConfirmed = false;
    let first = '';
    const error = (name, message) => {
      A.setError(`commerce-${name}`, message);
      if (message) first ||= `commerce-${name}`;
    };
    const auto = automaticOrder(existing);
    if (!existing) error('ownerId', order.ownerId && (order.ownerId === currentOperator().id ||
      orderOwners.some(row => row.id === order.ownerId)) ? '' : '请选择可用的订单归属人');
    const optionalEmail = order.product === 'GPT' && order.businessType === '续费';
    error('email', (optionalEmail && !order.email) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email) ? '' : '请填写有效邮箱');
    error(
      'businessType',
      ['续费', '成品交付'].includes(order.businessType) ? '' : '请选择续费或成品交付'
    );
    error('plan', orderPlanChoices(order.product, order.plan, existing).includes(order.plan) ? '' : '套餐与产品不匹配');
    error(
      'customerId',
      allowPending || (auto && !order.customerId) || customers.some((row) => row.id === order.customerId) ? '' : '请选择客户'
    );
    error('paidAmount', amountValid(order.paidAmount, allowPending || auto) ? '' : '请输入非负金额，最多四位小数');
    error('saleAmount', amountValid(order.saleAmount, !order.receiptConfirmed && (allowPending || auto)) ? '' : '请输入非负金额，最多四位小数');
    for (const name of ['paidCurrency', 'saleCurrency', 'emailCostCurrency', 'actualCostCurrency'])
      error(name, (auto && name === 'paidCurrency' && !order[name]) || currencies.includes(order[name]) ? '' : '请选择有效币种');
    error(
      'emailCostAmount',
      amountValid(order.emailCostAmount || '0') ? '' : '补充成本应为非负金额'
    );
    if (order.payment === '苹果内购' && order.businessType === '成品交付') {
      const [min, max] = appleMatch(order.plan, order.appleMatchMin, order.appleMatchMax);
      error('appleMatchMin', amountValid(min) ? '' : '请输入有效的美元余额下限');
      error('appleMatchMax', !max || (amountValid(max) && amountValid(min) && M.compare(max, min) >= 0)
        ? '' : '余额上限不能低于下限');
    }
    error('start', (auto && !order.start) || (order.start && Number.isFinite(parseDate(order.start))) ? '' : '请填写订阅时间');
    error(
      'expiry',
      (auto && !order.expiry) || (Number.isFinite(parseDate(order.expiry)) && parseDate(order.expiry) > parseDate(order.start))
        ? ''
        : '到期时间必须晚于订阅时间'
    );
    if (order.costBasis === 'actual')
      error('actualCostAmount', amountValid(order.actualCostAmount) ? '' : '请填写实际总成本');
    if (localData && order.appleRecoverableCostAmount) {
      const recoverable = order.appleRecoverableCostAmount;
      error(
        'appleRecoverableCostAmount',
        amountValid(recoverable) && amountValid(order.actualCostAmount) &&
          M.compare(recoverable, order.actualCostAmount) <= 0
          ? ''
          : '请输入不超过实际总成本的非负金额'
      );
    }
    if (order.payment === '银行卡') {
      const selected = (order.product === 'GPT' ? cards() : (tenantCards.get(order.tenantId)?.items || []))
        .find((row) => row.id === order.cardId);
      const historic = existing?.payment === order.payment && existing.cardId === order.cardId &&
        existing.paymentId === order.paymentId && existing.tenantId === order.tenantId;
      error('cardId', auto || historic ? '' : !selected && (!allowPending || order.cardId)
        ? '请选择本次使用的银行卡' : selected && cardTail(selected) !== order.paymentId
          ? '尾号与所选银行卡不符，请重新选择' : '');
    } else if (order.payment === '苹果内购') {
      error(
        'appleIdId',
        (allowPending && !order.paidConfirmed && !order.appleIdId) ||
          A.modules.appleBalance?.get?.(order.appleIdId)
          ? ''
          : '请选择用于本次订阅的苹果 ID'
      );
    } else error('payment', '请选择有效支付方式');
    if (!existing && order.businessType === '成品交付') {
      const selected = availableStock(order.product).find(
        (row) => row.email.toLowerCase() === order.email.toLowerCase()
      );
      error('email', selected ? '' : '请搜索并选择本产品可用、未使用的账号');
      if (selected) {
        order.accountId = selected.id;
        order.accountVersion = selected.version;
        order.email = selected.email;
        if (!form.elements['commerce-emailCostManual']?.value && emailCostRule[selected.emailType]) {
          order.emailCostAmount = costSettings[emailCostRule[selected.emailType]];
          order.emailCostCurrency = 'CNY';
        }
      }
    }
    if (!existing && order.businessType === '续费') {
      const issue = inventoryRenewalIssue(order.email, order.customerId, order.product);
      if (issue) error('email', issue);
    }
    if (isExternal(order.source) && order.businessType === '成品交付')
      error('businessType', '外部充值只处理客户自有账号');
    if (existing) {
      error('correctionReason', order.correctionReason ? '' : '更正订单必须填写原因');
      if (existing.businessType !== order.businessType)
        error('businessType', '已保存的业务类型不直接切换，请登记独立新订单');
      if (
        existing.accountId &&
        (existing.accountId !== order.accountId ||
          existing.email !== order.email ||
          existing.product !== order.product ||
          existing.businessType !== order.businessType)
      )
        error('email', '已交付账号的快照不可换成其他库存；请另建独立订单');
      if (
        existing.taskId &&
        (existing.email !== order.email ||
          existing.plan !== order.plan ||
          existing.payment !== order.payment ||
          existing.cardId !== order.cardId)
      )
        error('payment', '任务已确认的账号、套餐及支付资料不可直接更换');
      if (
        existing.payment === '银行卡' &&
        hasPaymentHistory(existing) &&
        (existing.payment !== order.payment || existing.cardId !== order.cardId)
      )
        error('cardId', '已确认银行卡付款的旧单不可换卡；本次续费请新建订单并选择新卡');
      if (existing.bankReturns?.length) {
        if (order.paidCurrency !== existing.paidCurrency)
          error('paidCurrency', '已有银行卡实际回款，需保留原代付币种');
        if (
          !order.paidConfirmed ||
          !amountValid(order.paidAmount) ||
          M.compare(order.paidAmount, bankReturned(existing)) < 0
        )
          error('paidAmount', '已确认代付金额不能低于已登记的银行卡实际回款');
      }
      if (existing.refunds?.length && order.saleCurrency !== existing.saleCurrency)
        error('saleCurrency', '已有客户退款，需保留原实收币种');
      if (
        amountValid(order.saleAmount || '0') &&
        M.compare(
          order.saleAmount || '0',
          sum(existing.refunds || [], (row) => row.amount)
        ) < 0
      )
        error('saleAmount', '更正实收不能低于已登记退款');
    }
    if (isClaude(order) && order.kyc === 'KYC 认证' && (!order.tenantId || !order.verifierPhone) && !existing?.verifier) {
      error('tenantId', order.tenantId ? '' : '请选择作为认证人的租户');
      error('verifierPhone', order.verifierPhone ? '' : '所选认证人缺少认证电话');
    }
    const current =
      isClaude(order) &&
      currentSubscriptions().find(
        (row) =>
          row.email.toLowerCase() === order.email.toLowerCase() &&
          row.id !== order.id &&
          subscriptionStatus(row) === '有效'
      );
    if (current && order.customerId && current.customerId !== order.customerId)
      error('customerId', 'Claude 账号在同一有效期间只属于一个客户');
    if (first) {
      document.getElementById(first)?.focus();
      return null;
    }
    return order;
  }
  function saveOrder(form, allowPending = false, settingsReady = false) {
    if (!canManageOrders()) return;
    if (localData && !settingsReady) {
      const submitted = JSON.stringify(A.readForm(form));
      const ready = A.modules.operations?.loadSettings?.();
      if (!ready) {
        A.notify('费用规则尚未加载，请稍候');
        return;
      }
      const raw = A.readForm(form);
      const existing = orders.find((row) => row.id === value(raw, 'id'));
      const needsBalance = value(raw, 'payment') === '苹果内购' || existing?.payment === '苹果内购';
      const balanceReady = needsBalance ? A.modules.appleBalance?.ensureReady?.() : true;
      void Promise.all([ready, balanceReady])
        .then(([ok, ledgerReady]) => {
          if (!ledgerReady) {
            A.notify('未能读取苹果 ID 余额，本次未保存');
            return;
          }
          if (ok && form.isConnected !== false && JSON.stringify(A.readForm(form)) === submitted) saveOrder(form, allowPending, true);
          else if (ok && form.isConnected !== false) A.notify('订单输入已变化，请重新核对后保存');
          else if (!ok) A.notify('未能读取本机费用规则，本次未保存');
        })
        .catch(() => A.notify('未能读取本机费用规则，本次未保存'));
      return;
    }
    const operator = currentOperator();
    if (!operator.id || !operator.name) {
      A.notify('当前登录身份不可用，请重新登录后保存');
      return;
    }
    saveDrafts();
    const inputOrder = validateOrder(form, allowPending);
    if (!inputOrder) return;
    const renewalEntry = S.route.startsWith(renewalOrderPrefix) ? S.route : '';
    const renewalSource = renewalEntry ? workbenchOrderSource(renewalEntry) : null;
    if (renewalEntry && !renewalSource) {
      A.notify('这笔续费提醒已处理，请返回续费管理核对。');
      return;
    }
    const reversalControl = form.elements.namedItem('commerce-balanceReversalConfirmed');
    if (reversalControl) reversalControl.checked = false;
    const existing = orders.find((row) => row.id === inputOrder.id);
    if (existing && String(existing.version) !== inputOrder.version) {
      A.notify('订单版本已变化，请重新核对');
      return;
    }
    const expectedVersion = existing?.version,
      key = form.dataset.commerceDraft;
    const id = existing?.id || uid('commerce-order');
    const settings = existing?.costSettings || safeClone(costSettings),
      rates = existing?.rates || (localData ? {} : safeClone(fxRates));
    const saved = {
      ...orderDefault(inputOrder.product),
      ...(existing || {}),
      ...inputOrder,
      id,
      orderNo: existing?.orderNo || orderNumber(),
      version: (existing?.version || 0) + 1,
      costSettings: settings,
      rates,
      rateAt:
        existing?.rateAt || (localData ? '汇率来源尚未接入' : '演示汇率 · 2026-11-03 09:00 UTC+8'),
      createdAt: existing ? existing.createdAt || '' : now(),
      createdBy: existing ? existing.createdBy || '' : operator.name,
      createdById: existing ? existing.createdById || '' : operator.id,
      updatedBy: operator.name,
      updatedById: operator.id,
      updatedAt: now(),
      refunds: existing?.refunds || [],
      bankReturns: existing?.bankReturns || [],
      corrections: existing?.corrections || [],
      cancelled: existing?.cancelled || false,
      issueFeeSnapshot: issueFeeSnapshot({ ...inputOrder, id }, settings),
      cancellationEvents: existing?.cancellationEvents || [],
      compensations: existing?.compensations || [],
      taskId: existing?.taskId || '',
      taskEvidenceId: existing?.taskEvidenceId || '',
      previousOrderId: '',
      balanceReversalConfirmed: false
    };
    const stock = !existing && saved.businessType === '成品交付';
    const stockCheck = () =>
      stock
        ? A.modules.inventory?.canCommitAccountSale?.(saved.accountId, {
            orderId: id,
            expectedVersion: inputOrder.accountVersion
          }) || { ok: false, error: '库存模块未就绪' }
        : { ok: true };
    const balanceOptions = {
      allowReversal: inputOrder.balanceReversalConfirmed === true,
      reason: inputOrder.correctionReason || '订单代付已确认'
    };
    const balanceService =
      saved.payment === '苹果内购' || existing?.payment === '苹果内购'
        ? A.modules.appleBalance
        : null;
    const balanceCheck = () =>
      balanceService?.previewOrder?.(saved, balanceOptions) ||
      (saved.payment === '苹果内购' && saved.paidConfirmed
        ? { ok: false, error: '苹果余额模块未就绪' }
        : { ok: true, changes: [] });
    const initialStock = stockCheck(),
      initialBalance = balanceCheck();
    if (!initialStock.ok || !initialBalance.ok) {
      A.notify(initialStock.error || initialStock.message || initialBalance.error);
      return;
    }
    const balanceText = !balanceService
      ? ''
      : initialBalance.changes?.length
        ? `苹果 ID 余额 ${display(initialBalance.balanceBefore)} → ${display(initialBalance.balanceAfter)} ${currencyLabel('USD')}。`
        : '本次不新增苹果余额扣款。';
    let committed = false;
    const submittedRoute = S.route;
    const submittedContext = S.drawerContext;
    const submitted = JSON.stringify(A.readForm(form));
    A.confirmAction(
      existing ? '确认更正独立订单' : '确认登记新订单',
      `${saved.email} · ${saved.plan}，归属人 ${orderOwnerName(saved)}，订阅 ${saved.start.replace('T', ' ')}，到期 ${saved.expiry.replace('T', ' ')}。${balanceText}${stock ? '保存后所选成品账号标记已使用。' : '保存时核对订单邮箱的提取记录。'}不会执行真实支付。`,
      () => {
        if (committed || !canManageOrders() || form.isConnected === false || S.route !== submittedRoute ||
            S.drawerContext !== submittedContext || JSON.stringify(A.readForm(form)) !== submitted) return;
        if (renewalEntry && (S.route !== renewalEntry || !workbenchOrderSource(renewalEntry))) {
          A.notify('这笔续费提醒已变化，请返回续费管理核对。');
          return;
        }
        if (currentOperator().id !== operator.id) {
          A.notify('登录身份已变化，请重新核对后保存');
          return;
        }
        if (
          existing &&
          (orders.find((row) => row.id === id) !== existing || existing.version !== expectedVersion)
        ) {
          A.notify('订单版本冲突，已停止保存');
          return;
        }
        if (!existing && inputOrder.includeIssueFee && cardIssueRecorded(inputOrder.cardId)) {
          A.notify('该卡开卡成本已被其他订单确认，草稿保留');
          return;
        }
        const freshStock = stockCheck(),
          freshBalance = balanceCheck();
        if (
          !freshStock.ok ||
          !freshBalance.ok ||
          (initialBalance.key && freshBalance.key !== initialBalance.key)
        ) {
          A.notify(
            freshStock.error ||
              freshStock.message ||
              freshBalance.error ||
              '余额版本已变化，请重新核对'
          );
          return;
        }
        const stockSale =
          localData && stock
            ? A.modules.inventory?.prepareAccountSale?.(saved.accountId, {
                orderId: id,
                expectedVersion: inputOrder.accountVersion
              })
            : null;
        if (localData && stock && (!stockSale?.ok || !localData.saveBatch)) {
          A.notify(stockSale?.error || stockSale?.message || '库存交付服务尚未就绪');
          return;
        }
        if (!existing) saved.orderNo = orderNumber();
        const preparedBalance =
          localData && balanceService
            ? balanceService.prepareOrder(saved, {
                ...balanceOptions,
                expectedPreview: initialBalance
              })
            : null;
        if (preparedBalance && !preparedBalance.ok) {
          A.notify(preparedBalance.error);
          return;
        }
        const inventory = A.modules.inventory;
        persistCommerce(
          existing ? '更正订单' : '新增独立订单',
          () => {
            const balanceResult = localData
              ? { ok: true }
              : balanceService?.commitOrder?.(saved, {
                  ...balanceOptions,
                  expectedPreview: initialBalance
                }) || { ok: true };
            if (!balanceResult.ok) {
              A.notify(balanceResult.error);
              return false;
            }
            if (stock && !localData) {
              const committed = A.modules.inventory.commitAccountSale(saved.accountId, {
                orderId: id,
                expectedVersion: inputOrder.accountVersion
              });
              if (!committed.ok) {
                A.notify(
                  committed.error || committed.message || '库存状态异常，请核对余额流水与原提交'
                );
                return false;
              }
            }
            saved.financialEvidence = mergeFinancialEvidence(existing, saved);
            if (existing) {
              const previousValues = safeClone(existing);
              delete previousValues.corrections;
              delete previousValues.refunds;
              delete previousValues.bankReturns;
              saved.corrections.push({
                id: uid('commerce-correction'),
                at: now(),
                reason: inputOrder.correctionReason,
                actor: operator.name,
                actorId: operator.id,
                previous: previousValues,
                versionAfter: saved.version,
                appleLedgerAfter: safeClone(
                  preparedBalance
                    ? preparedBalance.allocation
                    : balanceService?.getOrderLedger?.(saved.id) || null
                ),
                appleWalletVersionAfter: preparedBalance
                  ? preparedBalance.walletVersion
                  : balanceService?.get?.(saved.appleIdId)?.version || null
              });
              Object.assign(existing, saved);
            } else orders.unshift(saved);
            if (renewalSource && !existing && saved.businessType === '续费' &&
                sameSubscriptionAccount(saved, renewalSource.order))
              log('关联续费订单', renewalSource.order.id, saved.orderNo, saved.id);
            if (isClaude(saved) && !operating.has(saved.email.toLowerCase()))
              operating.set(saved.email.toLowerCase(), { status: 'active', at: now(), reason: '' });
            log(
              existing ? '更正订单' : '新增独立订单',
              saved.id,
              `${saved.orderNo} · ${saved.email} · ${saved.plan} · 归属人 ${orderOwnerName(saved)}${existing ? ` · 原因：${inputOrder.correctionReason}` : ''}`
            );
          },
          () => {
            committed = true;
            cleanClose(key);
            A.go(
              renewalEntry ? renewalRoute : saved.product === 'GPT'
                ? 'orders/gpt'
                : saved.product === 'Claude Pro'
                  ? 'orders/pro'
                  : 'orders/max'
            );
            A.notify(
              completenessReasons(orders.find((row) => row.id === id) || saved).length
                ? '已保存独立订单，仍有资料待补全'
                : '独立订单已保存'
            );
          },
          [
            preparedBalance,
            stockSale && {
              entry: {
                domain: 'inventory',
                version: stockSale.version,
                data: stockSale.data,
                action: stockSale.action
              },
              apply: (result) => inventory.applyCommittedInventory(result),
              reload: () => inventory.refreshLocalInventory?.()
            }
          ],
          !existing && saved.start ? () => { void freezeAutomaticSnapshot(id); } : undefined
        );
      },
      '确认保存'
    );
  }
  function refundEditor(id) {
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    if (order.cancelled || !order.receiptConfirmed || M.compare(refundable(order), '0') <= 0) {
      A.notify('当前订单没有可登记退款的已确认实收');
      return;
    }
    const key = `commerce-refund:${id}`,
      draft = S.drafts.get(key) || {};
    const apple = localData && order.payment === '苹果内购';
    const appleFields = apple
      ? `${field('原付款苹果 ID', 'refundAppleId', input('refundAppleId', order.paymentId, 'readonly'))}${field('本次 ID 回款金额', 'refundAppleAmount', input('refundAppleAmount', draft['commerce-refundAppleAmount'] ?? '', 'inputmode="decimal" placeholder="填写美元金额，0 表示无需回款"'), true, '单位为美元 USD。确认到账后才增加余额。')}`
      : '';
    A.openDrawer(
      '登记实际退款',
      `原实收 ${display(order.saleAmount)} ${currencyLabel(order.saleCurrency)}，累计退款不得超过原实收。`,
      `<form id="commerce-refund-form" data-commerce-draft="${key}" novalidate><input type="hidden" name="commerce-id" value="${id}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || order.version)}" /><div class="commerce-field-grid">${field('客户退款金额', 'refundAmount', input('refundAmount', draft['commerce-refundAmount'] || '', 'inputmode="decimal"'), true, `当前最多 ${display(refundable(order))} ${currencyLabel(order.saleCurrency)}`)}${appleFields}${field('退款时间', 'refundAt', input('refundAt', draft['commerce-refundAt'] ?? dateInput(now()), 'type="datetime-local"'), true)}${field('退款原因', 'refundReason', input('refundReason', draft['commerce-refundReason'] || ''), true, '', 'commerce-span-all')}${field('订阅标记', 'endSubscription', `<div class="inline-checks"><label class="checkbox-label"><input type="checkbox" name="commerce-endSubscription" ${draft['commerce-endSubscription'] ? 'checked' : ''} />同时标记本单订阅已终止</label></div>`, false, '只登记内部状态，不请求外部退款或更改真实订阅。', 'commerce-span-all')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" form="commerce-refund-form" class="button primary">核对退款</button>',
      key
    );
  }
  function saveRefund(form, ledgerReady = false) {
    const raw = A.readForm(form),
      order = orders.find((row) => row.id === value(raw, 'id'));
    if (!order) return;
    if (order.cancelled || !order.receiptConfirmed) {
      A.notify('当前订单没有可登记退款的已确认实收');
      return;
    }
    const amount = value(raw, 'refundAmount'),
      reason = value(raw, 'refundReason'),
      refundAt = value(raw, 'refundAt');
    const apple = localData && order.payment === '苹果内购' ? A.modules.appleBalance : null;
    const appleAmount = value(raw, 'refundAppleAmount');
    const badAppleAmount = apple && !amountValid(appleAmount);
    const validTime = Number.isFinite(parseDate(refundAt));
    const badAmount =
      !amountValid(amount) ||
      M.compare(amount || '0', '0') <= 0 ||
      M.compare(amount || '0', refundable(order)) > 0;
    A.setError('commerce-refundAmount', badAmount ? '退款必须大于零且不超过剩余可退金额' : '');
    A.setError(
      'commerce-refundAppleAmount',
      badAppleAmount ? '请明确填写美元金额，0 表示无需回款' : ''
    );
    A.setError('commerce-refundReason', reason ? '' : '请填写退款原因');
    A.setError('commerce-refundAt', validTime ? '' : '请填写实际退款时间');
    if (badAmount || badAppleAmount || !reason || !validTime) {
      const invalid = badAmount
        ? 'refundAmount'
        : badAppleAmount
          ? 'refundAppleAmount'
          : !reason
            ? 'refundReason'
            : 'refundAt';
      document.getElementById(`commerce-${invalid}`)?.focus();
      return;
    }
    if (String(order.version) !== value(raw, 'version')) {
      A.notify('订单已变化，请重新核对可退款金额');
      return;
    }
    if (localData && order.payment === '苹果内购' && !ledgerReady) {
      void Promise.resolve(apple?.ensureReady?.()).then((ok) => {
        if (ok && form.isConnected !== false) saveRefund(form, true);
        else if (!ok) A.notify('未能读取苹果 ID 余额，本次退款未登记');
      });
      return;
    }
    const refundId = uid('commerce-refund');
    const prepareApple = () => apple?.prepareRefund(order, { refundId, amount: appleAmount });
    const preview = prepareApple();
    if (preview && !preview.ok) {
      A.setError('commerce-refundAppleAmount', preview.error);
      document.getElementById('commerce-refundAppleAmount')?.focus();
      return;
    }
    const expectedVersion = order.version;
    let committed = false;
    A.confirmAction(
      '确认登记退款',
      `${order.orderNo}：客户实际退款 ${display(amount)} ${currencyLabel(order.saleCurrency)}。${apple ? `本次 ID 回款 ${display(appleAmount)} ${currencyLabel('USD')}，确认到账后增加余额。` : ''}`,
      () => {
        if (committed) return;
        if (
          orders.find((row) => row.id === order.id) !== order ||
          order.version !== expectedVersion ||
          order.cancelled ||
          !order.receiptConfirmed ||
          M.compare(amount, refundable(order)) > 0
        ) {
          A.notify('可退款金额已变化，停止登记');
          return;
        }
        const prepared = prepareApple();
        if (prepared && !prepared.ok) {
          A.notify(prepared.error);
          return;
        }
        persistCommerce(
          '退款登记',
          () => {
            order.refunds.push({
              id: refundId,
              amount: normalized(amount),
              currency: order.saleCurrency,
              payment: order.payment,
              reason,
              at: refundAt,
              actor: currentOperator().name || '历史未记录',
              actorId: currentOperator().id
            });
            if (raw['commerce-endSubscription'] === 'on') order.subscriptionEnded = true;
            order.version++;
            log(
              '退款登记',
              order.id,
              `${display(amount)} ${currencyLabel(order.saleCurrency)} · ${reason}`
            );
          },
          () => {
            committed = true;
            cleanClose(form.dataset.commerceDraft);
            A.render();
            orderDetail(order.id, 'refunds');
          },
          [prepared]
        );
      },
      '确认登记'
    );
  }
  function bankReturnEditor(id) {
    const order = orders.find((row) => row.id === id);
    if (!order || M.compare(bankReturnLimit(order), '0') <= 0) {
      A.notify('当前订单没有可登记回款的已确认银行卡代付');
      return;
    }
    const key = `commerce-bank-return:${id}`;
    const draft = S.drafts.get(key) || {};
    A.openDrawer(
      '登记银行卡实际回款',
      '按原代付币种登记实际到账，客户退款单独记录。',
      `<div class="property-list">${property('订单编号', order.orderNo)}${property('原付款银行卡', `${cardLabel(order.cardId)} · ${order.paymentId}`)}</div><form id="commerce-bank-return-form" data-commerce-draft="${key}" novalidate><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || order.version)}" /><div class="commerce-field-grid">${field('实际回款金额', 'bankReturnAmount', input('bankReturnAmount', draft['commerce-bankReturnAmount'] || '', 'inputmode="decimal"'), true, `当前最多 ${display(bankReturnLimit(order))} ${currencyLabel(order.paidCurrency)}`)}${field('到账时间', 'bankReturnAt', input('bankReturnAt', draft['commerce-bankReturnAt'] ?? dateInput(now()), 'type="datetime-local"'), true)}${field('到账依据', 'bankReturnReason', input('bankReturnReason', draft['commerce-bankReturnReason'] || ''), true, '', 'commerce-span-all')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" form="commerce-bank-return-form" class="button primary">核对回款</button>',
      key
    );
  }
  function saveBankReturn(form) {
    if (!localData) return;
    const raw = A.readForm(form);
    const order = orders.find((row) => row.id === value(raw, 'id'));
    if (!order || String(order.version) !== value(raw, 'version')) {
      A.notify('订单版本已变化，请重新核对回款');
      return;
    }
    const amount = value(raw, 'bankReturnAmount');
    const at = value(raw, 'bankReturnAt');
    const reason = value(raw, 'bankReturnReason');
    const validAmount =
      amountValid(amount) &&
      M.compare(amount, '0') > 0 &&
      M.compare(amount, bankReturnLimit(order)) <= 0;
    const validTime = Number.isFinite(parseDate(at));
    A.setError(
      'commerce-bankReturnAmount',
      validAmount ? '' : '回款金额必须大于零且不超过剩余可回款金额'
    );
    A.setError('commerce-bankReturnAt', validTime ? '' : '请填写实际到账时间');
    A.setError('commerce-bankReturnReason', reason ? '' : '请填写到账依据');
    if (!validAmount || !validTime || !reason) return;
    A.confirmAction(
      '确认银行卡实际回款',
      `${order.orderNo} · ${display(amount)} ${currencyLabel(order.paidCurrency)} · 原付款银行卡 ${cardLabel(order.cardId)}`,
      () => {
        if (
          orders.find((row) => row.id === order.id) !== order ||
          String(order.version) !== value(raw, 'version')
        ) {
          A.notify('订单已变化，请重新核对回款');
          return;
        }
        persistCommerce(
          '银行卡回款登记',
          () => {
            const operator = currentOperator();
            (order.bankReturns ||= []).push({
              id: uid('commerce-bank-return'),
              cardId: order.cardId,
              amount: normalized(amount),
              currency: order.paidCurrency,
              at,
              reason,
              actor: operator.name,
              actorId: operator.id
            });
            order.version++;
            log(
              '银行卡回款登记',
              order.id,
              `${display(amount)} ${currencyLabel(order.paidCurrency)} · ${reason}`
            );
          },
          () => {
            cleanClose(form.dataset.commerceDraft);
            A.render();
            orderDetail(order.id, 'refunds');
          }
        );
      }
    );
  }
  function hasDownstream(order) {
    return isClaude(order) && orders.some((row) => row.claudeRenewalId === order.id);
  }
  function currentFinancialEvidence(order) {
    const records = [];
    if (
      order.paidConfirmed &&
      amountValid(order.paidAmount || '') &&
      M.compare(order.paidAmount, '0') > 0
    )
      records.push({
        kind: 'payment',
        amount: order.paidAmount,
        currency: order.paidCurrency,
        payment: order.payment,
        cardId: order.cardId || '',
        at: now()
      });
    if (
      order.receiptConfirmed &&
      amountValid(order.saleAmount || '') &&
      M.compare(order.saleAmount, '0') > 0
    )
      records.push({
        kind: 'receipt',
        amount: order.saleAmount,
        currency: order.saleCurrency,
        at: now()
      });
    return records;
  }
  function financialEvidence(order) {
    return [
      ...(order.financialEvidence || []),
      ...currentFinancialEvidence(order),
      ...(order.corrections || []).flatMap((change) => currentFinancialEvidence(change.previous))
    ];
  }
  function hasPaymentHistory(order) {
    return financialEvidence(order).some((record) => record.kind === 'payment');
  }
  function hasReceiptHistory(order) {
    return financialEvidence(order).some((record) => record.kind === 'receipt');
  }
  function mergeFinancialEvidence(...ordersToRead) {
    const records = new Map();
    for (const order of ordersToRead.filter(Boolean))
      for (const record of financialEvidence(order)) {
        const key = [
          record.kind,
          record.amount,
          record.currency,
          record.payment || '',
          record.cardId || ''
        ].join('|');
        if (!records.has(key)) records.set(key, safeClone(record));
      }
    return [...records.values()];
  }
  function cancellationBlock(order) {
    if (order.taskId || order.taskEvidenceId)
      return '已有充值任务引用，不能直接业务撤单；任务付款与结果需先独立核对';
    if (hasDownstream(order)) return '存在 Claude 后续订阅记录，不能业务撤单覆盖历史';
    if (order.refunds.length) return '已有实际退款记录，不能通过业务撤单隐藏退款';
    if (hasPaymentHistory(order) || hasReceiptHistory(order))
      return '已有实际付款或实收，不能通过业务撤单移除财务记录；请分别处理更正、退款和订阅状态';
    return '';
  }
  function correctionBalanceConflict(order, change) {
    if (!change) return '';
    const previous = change.previous;
    const changesBalance = ['payment', 'appleIdId', 'paidAmount', 'paidConfirmed'].some(
      (name) => previous[name] !== order[name]
    );
    if (!changesBalance) return '';
    const current = A.modules.appleBalance?.getOrderLedger?.(order.id) || null;
    const expected = change.appleLedgerAfter || null;
    const fingerprint = (row) =>
      row ? JSON.stringify([row.appleIdId, row.amount, row.returned, row.version]) : '';
    return fingerprint(current) !== fingerprint(expected)
      ? '本单 Apple 余额台账在更正后已有退回或调整，不能按旧快照撤回；请登记独立更正并保留后续流水。'
      : '';
  }
  function reversalEditor(id, mode) {
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    const change = order.corrections.at(-1);
    if (
      mode === 'undo' &&
      (!change || order.version !== change.versionAfter || hasDownstream(order))
    ) {
      A.notify('已有后续版本或续费引用，不能补偿撤销最近更正');
      return;
    }
    const blocked =
      mode === 'cancel'
        ? cancellationBlock(order)
        : mode === 'undo'
          ? localData && !A.modules.appleBalance?.ready?.()
            ? ''
            : correctionBalanceConflict(order, change)
          : '';
    if (blocked) {
      A.notify(blocked);
      return;
    }
    const title =
      mode === 'undo' ? '补偿撤销最近更正' : mode === 'restore' ? '恢复已撤业务订单' : '业务撤单';
    const key = `commerce-reversal:${mode}:${id}`,
      draft = S.drafts.get(key) || {};
    A.openDrawer(
      title,
      '操作分别记账，保留付款、退款、原更正和资源引用，不自动归还库存。',
      `<div class="property-list">${property('订单编号', order.orderNo)}</div><form id="commerce-reversal-form" data-commerce-draft="${key}" novalidate><input name="commerce-id" type="hidden" value="${E(id)}" /><input name="commerce-version" type="hidden" value="${E(draft['commerce-version'] ?? order.version)}" /><input name="commerce-reversalMode" type="hidden" value="${mode}" /><div class="commerce-field-grid">${field('独立操作原因', 'reversalReason', `<textarea id="commerce-reversalReason" name="commerce-reversalReason" rows="2">${E(draft['commerce-reversalReason'] || '')}</textarea>`, true, '', 'commerce-span-all')}${mode === 'undo' && (order.payment === '苹果内购' || change?.previous.payment === '苹果内购') ? field('余额补偿确认', 'balanceReversalConfirmed', `<label class="checkbox-label"><input type="checkbox" name="commerce-balanceReversalConfirmed" data-no-draft  />已核实允许本次撤回产生 Apple 余额补偿</label>`, false, '涉及余额退回的补偿需明确确认；不会删除原流水。', 'commerce-span-all') : ''}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button form="commerce-reversal-form" type="submit" class="button danger">核对并记录</button>',
      key
    );
  }
  function saveReversal(form, ledgerReady = false) {
    const raw = A.readForm(form),
      order = orders.find((row) => row.id === value(raw, 'id'));
    const mode = value(raw, 'reversalMode'),
      reason = value(raw, 'reversalReason');
    if (!order || !['undo', 'cancel', 'restore'].includes(mode)) return;
    A.setError('commerce-reversalReason', reason ? '' : '请填写本次操作的独立原因');
    if (!reason) return;
    const needsBalance =
      mode === 'undo' &&
      (order.payment === '苹果内购' || order.corrections.at(-1)?.previous?.payment === '苹果内购');
    const balance = needsBalance ? A.modules.appleBalance : null;
    if (localData && needsBalance && !ledgerReady) {
      void Promise.resolve(balance?.ensureReady?.()).then((ok) => {
        if (ok && form.isConnected !== false) saveReversal(form, true);
        else if (!ok) A.notify('未能读取苹果 ID 余额，本次未登记');
      });
      return;
    }
    const check = () => {
      if (
        orders.find((row) => row.id === order.id) !== order ||
        String(order.version) !== value(raw, 'version')
      )
        return '订单版本已变化，请重新核对';
      if (
        mode === 'undo' &&
        (!order.corrections.length ||
          order.version !== order.corrections.at(-1).versionAfter ||
          hasDownstream(order))
      )
        return '存在后续变更或 Claude 续费记录，不能撤回';
      return mode === 'cancel'
        ? cancellationBlock(order)
        : mode === 'undo'
          ? correctionBalanceConflict(order, order.corrections.at(-1))
          : '';
    };
    const targetFor = () =>
      mode === 'undo'
        ? {
            ...order.corrections.at(-1).previous,
            id: order.id,
            orderNo: order.orderNo,
            refunds: order.refunds
          }
        : { ...order, cancelled: mode === 'cancel' };
    const options = { allowReversal: raw['commerce-balanceReversalConfirmed'] === 'on', reason };
    const balancePlan = () =>
      balance?.previewOrder?.(targetFor(), options) || { ok: true, changes: [] };
    const blocked = check(),
      initial = blocked ? null : balancePlan();
    const reversalControl = form.elements.namedItem('commerce-balanceReversalConfirmed');
    if (reversalControl) reversalControl.checked = false;
    if (blocked || !initial.ok) {
      A.notify(blocked || initial.error);
      return;
    }
    A.confirmAction(
      mode === 'undo'
        ? '确认补偿撤回更正'
        : mode === 'cancel'
          ? '确认业务撤单'
          : '确认恢复业务订单',
      `${order.orderNo} · 原因：${reason}。${initial.changes?.length ? `Apple 余额补偿 ${display(initial.balanceBefore)} → ${display(initial.balanceAfter)} ${currencyLabel('USD')}。` : '不自动退回余额或库存。'}原付款、客户退款和全部流水保留。`,
      () => {
        const conflict = check();
        if (conflict) {
          A.notify(conflict);
          return;
        }
        const fresh = balancePlan();
        if (!fresh.ok || (initial.key && initial.key !== fresh.key)) {
          A.notify(fresh.error || '余额台账已变化，请重新核对');
          return;
        }
        const result = balance
          ? (localData ? balance.prepareOrder : balance.commitOrder)(targetFor(), {
              ...options,
              expectedPreview: initial
            })
          : { ok: true };
        if (!result.ok) {
          A.notify(result.error);
          return;
        }
        persistCommerce(
          mode === 'undo' ? '补偿撤回更正' : mode === 'cancel' ? '业务撤单' : '恢复业务订单',
          () => {
            if (mode === 'undo') {
              const change = order.corrections.at(-1);
              const preserved = {
                id: order.id,
                orderNo: order.orderNo,
                refunds: order.refunds,
                bankReturns: order.bankReturns || [],
                corrections: order.corrections,
                cancellationEvents: order.cancellationEvents || [],
                compensations: order.compensations || [],
                issueFeeSnapshot: order.issueFeeSnapshot,
                fxSnapshot: order.fxSnapshot,
                financialEvidence: mergeFinancialEvidence(order),
                version: order.version + 1
              };
              preserved.compensations.push({
                id: uid('commerce-compensation'),
                correctionId: change.id,
                reason,
                actor: currentOperator().name || '林管理员',
                at: now(),
                fromVersion: order.version,
                toVersion: preserved.version
              });
              Object.assign(order, change.previous, preserved, { balanceReversalConfirmed: false });
            } else {
              order.cancelled = mode === 'cancel';
              order.version++;
              (order.cancellationEvents ||= []).push({
                id: uid('commerce-cancel'),
                action: mode === 'cancel' ? '业务撤单' : '恢复业务订单',
                reason,
                actor: currentOperator().name || '林管理员',
                at: now()
              });
            }
            log(
              mode === 'undo' ? '补偿撤回更正' : mode === 'cancel' ? '业务撤单' : '恢复业务订单',
              order.id,
              `${order.orderNo} · ${reason}`
            );
          },
          () => {
            cleanClose(form.dataset.commerceDraft);
            A.render();
          },
          localData ? [result] : []
        );
      }
    );
  }
  function moreOrder(id, node) {
    const order = orders.find((row) => row.id === id);
    if (!order) return;
    const ledger = A.modules.appleBalance?.getOrderLedger?.(id);
    const claude = isClaude(order)
      ? `<div class="guide-item"><div class="section-title-row"><h3>Claude 续费</h3>${A.titleInfo('Claude 续费', '预填相同账号资料并生成独立新订单；未过期可续接当前到期，银行卡重新选择。', 'commerce-more-renew')}</div><div class="toolbar">${A.button('新增 Claude 续费订单', 'commerce-order-renew', '', 'return', `data-id="${id}" ${order.cancelled ? 'disabled' : ''}`)}</div></div>`
      : '';
    const apple = localData
      ? order.payment === '苹果内购'
        ? `<div class="guide-item"><h3>Apple ID 回款</h3><div class="toolbar">${A.button('处理 Apple ID 回款', 'commerce-apple-refund', '', 'return', `data-id="${E(id)}"`)}</div></div>`
        : ''
      : ledger
        ? `<div class="guide-item"><h3>Apple 余额退回</h3><p>本单可确认退回 ${display(ledger.netAmount)} ${currencyLabel('USD')}，仅在 Apple 已实际返还时登记。</p><div class="toolbar">${A.button('确认 Apple 余额退回', 'commerce-apple-refund', '', 'return', `data-id="${id}" ${M.compare(ledger.netAmount, '0') <= 0 ? 'disabled' : ''}`)}</div></div>`
        : '';
    A.openActionMenu(node, `<div class="property-list">${property('订单编号', order.orderNo)}</div><div class="guide-list">${claude}<div class="guide-item"><h3>更正与补偿</h3><div class="toolbar">${A.button('更正订单资料', 'commerce-order-edit', '', '', `data-id="${id}" ${order.cancelled ? 'disabled' : ''}`)}${A.button('补偿撤回最近更正', 'commerce-order-undo', '', 'return', `data-id="${id}" ${order.corrections.length ? '' : 'disabled'}`)}</div></div><div class="guide-item"><h3>客户退款</h3><div class="toolbar">${A.button('登记客户实际退款', 'commerce-order-refund', '', '', `data-id="${id}" ${!order.receiptConfirmed ? 'disabled' : ''}`)}</div></div>${apple}<div class="guide-item"><div class="section-title-row"><h3>业务撤单</h3>${A.titleInfo('业务撤单', '已有实付、实收、退款或任务时不能通过撤单抹账；不自动归还库存或苹果余额。', 'commerce-more-cancel')}</div><div class="toolbar">${A.button(order.cancelled ? '恢复业务订单' : '业务撤单', 'commerce-order-cancel', order.cancelled ? '' : 'danger', '', `data-id="${id}"`)}</div></div></div>`);
  }
  function subscriptionMore(id, node) {
    const row = currentSubscriptions().find((order) => order.id === id);
    if (!row) return;
    A.openActionMenu(node, `<div class="property-list">${property('邮箱账号', row.email)}${property('当前客户', customerLabel(row.customerId))}${property('租户', tenantLabel(row.tenantId))}${property('归属人', orderOwnerName(row))}${property('认证人', row.verifier)}${property('验证状态', row.kyc)}${property('当前状态', { active: '使用中', frozen: '冻结', abandoned: '弃用' }[row.operation.status])}${property('状态时间', row.operation.at)}</div><div class="toolbar">${row.operation.status === 'active' ? A.button('冻结', 'commerce-subscription-state', '', '', `data-id="${id}" data-status="frozen"`) + A.button('弃用', 'commerce-subscription-state', 'danger', '', `data-id="${id}" data-status="abandoned"`) : A.button('恢复使用', 'commerce-subscription-state', '', '', `data-id="${id}" data-status="active"`)}${A.button('创建付租批次', 'commerce-rent-one', '', 'orders', `data-id="${id}"`)}</div>`);
  }
  function saveRentBatch(form) {
    const raw = A.readForm(form),
      start = value(raw, 'rent-start'),
      end = value(raw, 'rent-end');
    let invalid = '';
    A.setError('commerce-rent-start', start ? '' : '请选择租赁期间');
    A.setError('commerce-rent-end', !end || end < start ? '结束日期不得早于开始日期' : '');
    if (!start || !end || end < start)
      invalid = !start ? 'commerce-rent-start' : 'commerce-rent-end';
    const rows = value(raw, 'ids')
      .split(',')
      .map((id) => orders.find((row) => row.id === id))
      .filter(Boolean);
    const items = rows.map((row) => {
      const tenantId = value(raw, `rent-tenant-${row.id}`);
      A.setError(
        `commerce-rent-tenant-${row.id}`,
        tenants.some((tenant) => tenant.id === tenantId) ? '' : '请选择租金发放对象'
      );
      if (!tenants.some((tenant) => tenant.id === tenantId))
        invalid ||= `commerce-rent-tenant-${row.id}`;
      return {
        id: uid('commerce-rent-item'),
        orderId: row.id,
        email: row.email,
        tenantId,
        start,
        end,
        period: `${start} 至 ${end}`,
        status: '待发放',
        notes: '',
        paidAt: '',
        payments: [],
        version: 1
      };
    });
    if (!items.length) {
      A.notify('没有有效的租金发放账号');
      return;
    }
    if (invalid) {
      document.getElementById(invalid)?.focus();
      return;
    }
    const overlaps = () =>
      rentBatches
        .flatMap((batch) => batch.items)
        .some(
          (prior) =>
            prior.status !== '已取消' &&
            items.some(
              (item) =>
                item.email === prior.email && item.start <= prior.end && item.end >= prior.start
            )
        );
    if (overlaps()) {
      A.notify('同一账号存在重叠租赁期间，请先核对已有批次，避免重复发放');
      return;
    }
    A.confirmAction(
      '确认建立租金发放批次',
      `${items.length} 个账号，期间 ${start} 至 ${end}。仅建立待发放记录，不表示已发放，也不新增成本。`,
      () => {
        if (overlaps()) {
          A.notify('已有相同期间批次，停止重复创建');
          return;
        }
        const batch = {
          id: `RENT-${localData ? 'LOCAL' : 'DEMO'}-${String(rentBatches.length + 1).padStart(3, '0')}`,
          items,
          at: now(),
          notes: value(raw, 'rent-notes')
        };
        persistCommerce(
          '建立租金发放批次',
          () => {
            rentBatches.unshift(batch);
            log('建立租金发放批次', batch.id, `${items.length} 项 · ${start} 至 ${end}`);
          },
          () => {
            cleanClose(form.dataset.commerceDraft);
            A.getSelection('commerce-subscriptions').clear();
            A.go(`orders/exclusive/rentals/${batch.id}`);
          }
        );
      },
      '确认建立'
    );
  }
  function rentItemEditor(batchId, id) {
    const batch = rentBatches.find((row) => row.id === batchId),
      item = batch?.items.find((row) => row.id === id);
    if (!item || ['已发放', '已取消'].includes(item.status)) return;
    const key = `commerce-rent-payment:${id}`,
      draft = S.drafts.get(key) || {};
    A.openDrawer(
      '逐项登记租金发放',
      '',
      `<div class="property-list">${property('邮箱账号', item.email)}${property('发放对象', tenantLabel(item.tenantId))}${property('租赁期间', item.period)}</div><form id="commerce-rent-payment-form" data-commerce-draft="${key}" novalidate><input type="hidden" name="commerce-batchId" value="${E(batchId)}" /><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] ?? item.version)}" /><div class="commerce-field-grid">${field('发放结果', 'rent-status', select('rent-status', ['已发放', '发放失败', '待发放', '已取消'], draft['commerce-rent-status'] || '已发放'), true)}${field('记录时间', 'rent-at', input('rent-at', draft['commerce-rent-at'] ?? dateInput(now()), 'type="datetime-local"'), true)}${field('备注', 'rent-result-notes', `<textarea id="commerce-rent-result-notes" name="commerce-rent-result-notes" rows="2">${E(draft['commerce-rent-result-notes'] || '')}</textarea>`, true, '', 'commerce-span-all')}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" form="commerce-rent-payment-form" class="button primary">核对并登记</button>',
      key
    );
  }
  function saveRentPayment(form) {
    const raw = A.readForm(form),
      batch = rentBatches.find((row) => row.id === value(raw, 'batchId')),
      item = batch?.items.find((row) => row.id === value(raw, 'id'));
    if (!item) return;
    const result = value(raw, 'rent-status'),
      notes = value(raw, 'rent-result-notes'),
      at = value(raw, 'rent-at');
    A.setError('commerce-rent-result-notes', notes ? '' : '请填写本次发放记录备注');
    A.setError('commerce-rent-at', at ? '' : '请填写记录时间');
    if (!notes || !at || !['已发放', '发放失败', '待发放', '已取消'].includes(result)) return;
    const valid = () =>
      String(item.version) === value(raw, 'version') && !['已发放', '已取消'].includes(item.status);
    if (!valid()) {
      A.notify('发放状态已变化，请重新核对');
      return;
    }
    A.confirmAction(
      '确认租金发放记录',
      `${item.email}：${result}。仅登记实际状态，不执行转账，不新增或重复扣除成本。`,
      () => {
        if (!valid()) {
          A.notify('发放状态已变化，停止重复登记');
          return;
        }
        persistCommerce(
          '租金发放登记',
          () => {
            item.status = result;
            item.version++;
            item.notes = notes;
            item.paidAt = result === '已发放' ? at : '';
            item.payments.push({
              status: result,
              at,
              actor: currentOperator().name || '历史未记录',
              actorId: currentOperator().id,
              notes
            });
            log('租金发放登记', batch.id, `${item.email} · ${result} · ${notes}`);
          },
          () => {
            cleanClose(form.dataset.commerceDraft);
            A.render();
          }
        );
      },
      '确认登记'
    );
  }
  function addRechargeOrder(task) {
    if (localData) return { ok: false, message: '充值订单自动入库尚未接入' };
    if (!task || !task.id || !task.email || !task.plan)
      return { ok: false, message: '任务编号、充值账号和套餐不可缺少' };
    const plan = normalizedPlan(task.plan);
    if (!productPlans.GPT.includes(plan))
      return { ok: false, message: '此任务套餐不属于当前 GPT 订单范围，保留任务待核对' };
    const existing = orders.find((row) => row.taskId === String(task.id));
    const source = String(task.source || '比特管理员');
    const customerOwned =
      isExternal(source) ||
      task.isCustomerOwned === true ||
      ['客户自有', 'customer'].includes(task.accountSource);
    if (
      existing &&
      (existing.email.toLowerCase() !== String(task.email).toLowerCase() || existing.plan !== plan)
    )
      return { ok: false, message: '同一任务的账号或套餐与原单不一致，未新建重复订单' };
    const paidAmount = amountValid(String(task.paidAmount ?? ''), true)
      ? String(task.paidAmount ?? '')
      : '';
    if (existing) {
      if (task.cardId && existing.cardId && String(task.cardId) !== existing.cardId)
        return { ok: false, message: '同一任务银行卡稳定编号不一致，请单独核对' };
      const oldEvidence = mergeFinancialEvidence(existing);
      if (paidAmount !== '') existing.paidAmount = paidAmount;
      if (currencies.includes(task.paidCurrency)) existing.paidCurrency = task.paidCurrency;
      if (task.paidConfirmed === true) existing.paidConfirmed = true;
      if (task.evidenceId) existing.taskEvidenceId = String(task.evidenceId);
      if (task.cardId && !existing.cardId) {
        existing.cardId = String(task.cardId);
        const card = cards().find((row) => row.id === existing.cardId);
        if (card) existing.paymentId = card.last6;
        existing.issueFeeSnapshot = {
          cardId: existing.cardId,
          applied:
            task.includeIssueFee === true && !cardIssueRecorded(existing.cardId, existing.id),
          amountUsd: existing.costSettings.cardIssueUsd,
          at: now()
        };
      }
      existing.financialEvidence = mergeFinancialEvidence({
        ...existing,
        financialEvidence: oldEvidence
      });
      return {
        ok: true,
        orderId: existing.id,
        orderNo: existing.orderNo,
        order: safeClone(existing),
        reused: true
      };
    }
    const order = {
      ...orderDefault('GPT'),
      id: uid('commerce-order'),
      orderNo: orderNumber(),
      taskId: String(task.id),
      taskEvidenceId: String(task.evidenceId || ''),
      email: String(task.email).trim(),
      plan,
      source,
      accountSource: customerOwned ? '客户自有' : '库存',
      accountId: customerOwned ? '' : String(task.accountId || ''),
      businessType: customerOwned ? '续费' : '成品交付',
      customerId: customers.some((row) => row.id === task.customerId) ? task.customerId : '',
      paidAmount,
      paidCurrency: currencies.includes(task.paidCurrency) ? task.paidCurrency : 'PHP',
      paidConfirmed: task.paidConfirmed === true,
      paymentId: String(
        task.cardTail || cards().find((row) => row.id === task.cardId)?.last6 || ''
      ),
      cardId: String(task.cardId || ''),
      includeIssueFee: task.includeIssueFee === true,
      previousOrderId: '',
      claudeRenewalId: '',
      payment: '银行卡',
      saleAmount: '',
      receiptConfirmed: false,
      costConfirmed: false,
      start: dateInput(task.createdAt || now()),
      expiry: dateInput(
        task.expiry || A.addCalendarMonth(dateInput(task.createdAt || now()))
      ),
      version: 1,
      rates: safeClone(fxRates),
      costSettings: safeClone(costSettings),
      rateAt: '演示汇率 · 2026-11-03 09:00 UTC+8',
      createdAt: String(task.createdAt || now()),
      createdBy: '比特任务',
      refunds: [],
      corrections: [],
      cancelled: false,
      notes: '付款成功后生成的原单，客户和售价待补全；不重复领取库存。'
    };
    order.issueFeeSnapshot = issueFeeSnapshot(order);
    order.financialEvidence = mergeFinancialEvidence(order);
    order.cancellationEvents = [];
    order.compensations = [];
    orders.unshift(order);
    log('充值生成待补全订单', order.id, `${order.orderNo} · 来源任务 ${task.id}`);
    return {
      ok: true,
      orderId: order.id,
      orderNo: order.orderNo,
      order: safeClone(order),
      reused: false
    };
  }
  function updateCostSettings(next) {
    if (!next || !['CNY', 'MYR'].includes(next.currency ?? costSettings.currency))
      return { ok: false, message: '统计币种只能选择人民币 CNY 或马币 MYR' };
    const known = [
      'claudeBankFeeMyr',
      'claudeAccountCostMyr',
      'gmailCostCny',
      'appleCostCny',
      'microsoftCostCny',
      'appleDiscount',
      'cardIssueUsd',
      'cardPercent',
      'cardPerPaymentUsd'
    ];
    for (const key of known)
      if (next[key] !== undefined && !amountValid(String(next[key])))
        return { ok: false, message: '费用金额必须为非负十进制，最多四位小数' };
    const discount = String(next.appleDiscount ?? costSettings.appleDiscount),
      percent = String(next.cardPercent ?? costSettings.cardPercent);
    if (
      M.compare(discount, '0') <= 0 ||
      M.compare(discount, '1') > 0 ||
      M.compare(percent, '1') > 0
    )
      return { ok: false, message: '折扣需大于零且不超过一，手续费比例不超过一' };
    if (next.currency) costSettings.currency = next.currency;
    for (const key of known) if (next[key] !== undefined) costSettings[key] = String(next[key]);
    costSettings.version++;
    log(
      '更新费用规则',
      'commerce-cost-settings',
      `规则版本 V${costSettings.version}，历史订单快照不变`
    );
    return { ok: true, settings: safeClone(costSettings) };
  }
  function quickCreate(tenant, node) {
    const form = node.closest('#commerce-order-form');
    if (!form) return;
    saveDrafts();
    quickReturn = {
      tenant,
      route: S.route,
      key: form.dataset.commerceDraft,
      main: !form.closest('#drawer'),
      orderId: form.elements['commerce-id']?.value || '',
      renewalId: form.elements['commerce-claudeRenewalId']?.value || ''
    };
    contactForm(tenant, '', true);
  }
  function onClick(action, node) {
    if (!action.startsWith('commerce-')) return false;
    if (action === 'commerce-order-owner-refresh') {
      if (canManageOrders()) void loadOrderOwners(node.closest('#commerce-order-form'), true);
      return true;
    }
    if (action === 'commerce-picker-select') {
      const picker = node.closest('.commerce-search-picker');
      const select = picker.querySelector('select');
      if (select.disabled || ![...select.options].some(option => option.value === node.dataset.value && !option.disabled)) return true;
      select.value = node.dataset.value;
      const email = picker.querySelector('#commerce-email');
      if (email) email.value = select.value;
      filterPicker(picker.querySelector('[data-commerce-picker]'));
      picker.querySelector('.commerce-picker-popover').hidePopover();
      (email && !email.hidden ? email : picker.querySelector('.commerce-picker-trigger')).focus({ preventScroll: true });
      (email || select).dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (!canManageOrders() && /^commerce-(?:new-product-order|order-(?:edit|refund|more|pending|auto-fx|fx)|tenant-card)/.test(action)) return true;
    if (action === 'commerce-order-card-retry') {
      const form = node.closest('#commerce-order-form');
      if (form) void loadOrderCards(form, true);
      return true;
    }
    if (action === 'commerce-tenant-cards') {
      void openTenantCards(node.dataset.id);
      return true;
    }
    if (action === 'commerce-tenant-card-reveal' || action === 'commerce-tenant-card-copy') {
      const form = node.closest('#commerce-order-form');
      if (form) void useTenantCard(form, action.endsWith('copy') ? 'copy' : 'reveal');
      return true;
    }
    if (action === 'commerce-tenant-card-deactivate') {
      A.confirmAction('停用租户银行卡', '停用后停止用于新单，历史订单仍可核对。', () => {
        void changeTenantCard(null, node.dataset.tenant, node.dataset.id);
      });
      return true;
    }
    if (action === 'commerce-price-settings') {
      saveDrafts();
      void openPrices(node.dataset.product);
      return true;
    }
    if (action === 'commerce-customer-settings') {
      const operations = A.modules.operations;
      if (!operations?.openCustomerOptionSettings || operations.canManageCustomerOptions() === false) {
        A.notify('当前无法修改客户选项');
        return true;
      }
      saveDrafts();
      const form = node.closest('#commerce-contact-form');
      customerSettingsReturn = form?.closest('#drawer') ? {
        route: S.route,
        id: form.elements['commerce-id'].value,
        quick: form.elements['commerce-quick'].value === 'yes'
      } : null;
      operations.openCustomerOptionSettings(node.dataset.kind);
      return true;
    }
    if (action === 'commerce-local-retry') {
      loadLocalCommerce(true);
      A.render();
      return true;
    }
    const id = node.dataset.id;
    if (action === 'commerce-renewal-tab' || action === 'commerce-loss-tab') {
      if (action === 'commerce-renewal-tab') moduleState.renewalTab = node.dataset.tab;
      else S.status = node.dataset.tab;
      S.page = 1;
      A.render();
      return true;
    }
    if (action === 'commerce-renewal-settings') {
      openRenewalSettings();
      return true;
    }
    if (action === 'commerce-renewal-open') {
      if (id) A.go(renewalOrderPrefix + encodeURIComponent(id));
      return true;
    }
    if (action === 'commerce-loss-history') {
      showCustomerLossHistory(id);
      return true;
    }
    if (action === 'commerce-renewal-refuse' || action === 'commerce-renewal-restore') {
      changeRenewalDecision(id, action === 'commerce-renewal-restore');
      return true;
    }
    if (action === 'commerce-bank-return') {
      bankReturnEditor(id);
      return true;
    }
    if (action === 'commerce-go') {
      A.go(node.dataset.route);
      return true;
    }
    if (action === 'commerce-contact-entry-tab') {
      A.go(node.dataset.tab === 'tenant' ? 'customers/new/tenant' : 'customers/new');
      return true;
    }
    if (action === 'commerce-contact-add') {
      contactForm(node.dataset.kind === 'tenant');
      return true;
    }
    if (action === 'commerce-contact-edit') {
      contactForm(node.dataset.kind === 'tenant', id);
      return true;
    }
    if (action === 'commerce-contact-detail') {
      contactDetail(id, node.dataset.kind === 'tenant');
      return true;
    }
    if (action === 'commerce-contact-tab') {
      const key = S.route === 'customers/tenants' ? 'tenantMode' : 'customerMode';
      moduleState[key] = node.dataset.tab;
      S.page = 1;
      A.render();
      return true;
    }
    if (action === 'commerce-contact-disable') {
      const data = node.dataset.kind === 'tenant' ? tenants : customers,
        row = data.find((entry) => entry.id === id);
      if (!row) return true;
      const expectedVersion = row.version,
        operator = currentOperator();
      if (!operator.id || !operator.name) {
        A.notify('当前登录身份不可用');
        return true;
      }
      A.confirmAction(
        row.active ? '停用资料' : '恢复资料',
        `${row.name}：仅改变后续选择可用性，历史订单与付租记录保持。`,
        () => {
          if (row.version !== expectedVersion || currentOperator().id !== operator.id) {
            A.notify('资料版本或登录身份已变化，请重新核对');
            return;
          }
          persistCommerce(
            row.active ? '停用资料' : '恢复资料',
            () => {
              row.active = !row.active;
              row.updatedById = operator.id;
              row.updatedBy = operator.name;
              row.updatedAt = now();
              row.version++;
              log(row.active ? '恢复资料' : '停用资料', row.id, row.name);
            },
            A.render
          );
        }
      );
      return true;
    }
    if (action === 'commerce-quick-customer' || action === 'commerce-quick-tenant') {
      quickCreate(action.endsWith('tenant'), node);
      return true;
    }
    if (action === 'commerce-new-product-order') {
      const product = node.dataset.product;
      const key = entryDraft(product);
      if (!S.drafts.has(key)) S.drafts.set(key, {
        'commerce-product': product,
        'commerce-plan': productPlans[product][0]
      });
      A.go(entryRoute(product));
      return true;
    }
    if (action === 'commerce-use-historical-apple') {
      const form = $('#commerce-order-form');
      if (!form) return true;
      const email = form.querySelector('#commerce-email').value.trim().toLowerCase();
      const history = orders
        .filter((row) => row.payment === '苹果内购' && row.email.toLowerCase() === email)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const wallet = history
        .map(
          (row) =>
            A.modules.appleBalance?.get?.(row.appleIdId) ||
            appleAccounts().find(
              (item) => item.email.toLowerCase() === String(row.paymentId).toLowerCase()
            )
        )
        .find(
          (candidate) =>
            candidate &&
            (!localData || (candidate.status === '正常' && candidate.health === 'normal'))
        );
      if (!wallet) {
        A.notify('本邮箱暂无已记录的苹果 ID，请自行选择正确 ID；无需关联原订单。');
        return true;
      }
      form.querySelector('#commerce-appleIdId').value = wallet.id;
      saveDrafts();
      A.notify(`已选择历史使用 ID：${wallet.email}`);
      return true;
    }
    if (action === 'commerce-apple-refund') {
      const apple = A.modules.appleBalance;
      if (localData && !apple?.ready?.()) {
        const route = S.route,
          drawerContext = S.drawerContext;
        void Promise.resolve(apple?.ensureReady?.()).then((ok) => {
          if (ok && S.route === route && S.drawerContext === drawerContext)
            apple.openOrderRefund(id);
          else if (!ok) A.notify('未能读取苹果 ID 回款记录，请重试');
        });
      } else apple?.openOrderRefund?.(id);
      return true;
    }
    if (action === 'commerce-order-fx-detail') {
      orderDetail(id, 'costs');
      return true;
    }
    if (action === 'commerce-order-auto-fx') {
      void freezeAutomaticSnapshot(id, node);
      return true;
    }
    if (action === 'commerce-order-fx') {
      openFxSnapshot(id);
      return true;
    }
    if (action === 'commerce-order-detail') {
      orderDetail(id);
      return true;
    }
    if (action === 'commerce-order-detail-tab') {
      if (S.route.startsWith('orders/detail/')) {
        moduleState.detailTab = node.dataset.tab;
        A.render();
      } else orderDetail(id, node.dataset.tab);
      return true;
    }
    if (action === 'commerce-order-edit') {
      orderEditor(id);
      return true;
    }
    if (action === 'commerce-order-refund') {
      refundEditor(id);
      return true;
    }
    if (action === 'commerce-order-more') {
      moreOrder(id, node);
      return true;
    }
    if (action === 'commerce-order-renew') {
      const order = orders.find((row) => row.id === id);
      if (!isClaude(order)) {
        A.notify('快捷续费仅适用于 Claude，其他产品请提交独立新订单。');
        return true;
      }
      orderEditor('', id);
      return true;
    }
    if (action === 'commerce-order-pending') {
      const form = $('#commerce-order-form');
      if (form) saveOrder(form, true);
      return true;
    }
    if (action === 'commerce-order-tab') {
      moduleState.orderTab = node.dataset.tab;
      S.page = 1;
      A.render();
      return true;
    }
    if (action === 'commerce-order-undo') {
      reversalEditor(id, 'undo');
      return true;
    }
    if (action === 'commerce-order-cancel') {
      const order = orders.find((row) => row.id === id);
      if (order) reversalEditor(id, order.cancelled ? 'restore' : 'cancel');
      return true;
    }
    if (action === 'commerce-claude-tab') {
      moduleState.claudeTab = node.dataset.tab;
      S.page = 1;
      A.getSelection('commerce-subscriptions').clear();
      if (node.dataset.tab === 'rentals') A.go('orders/exclusive/rentals');
      else {
        if (S.route.includes('/rentals')) A.go('orders/exclusive');
        else A.render();
      }
      return true;
    }
    if (action === 'commerce-subscription-more') {
      subscriptionMore(id, node);
      return true;
    }
    if (action === 'commerce-subscription-state') {
      const row = currentSubscriptions().find((order) => order.id === id);
      if (!row) return true;
      const label = { active: '恢复使用', frozen: '冻结', abandoned: '弃用' }[node.dataset.status];
      A.confirmAction(
        `确认${label}`,
        `${row.email}：保留订单、金额与历史，${label}不自动退款或更改外部订阅。`,
        () => {
          persistCommerce(
            label,
            () => {
              operating.set(row.email.toLowerCase(), {
                status: node.dataset.status,
                at: now(),
                reason: label
              });
              log(label, row.id, row.email);
            },
            () => {
              cleanClose();
              A.render();
            }
          );
        }
      );
      return true;
    }
    if (action === 'commerce-rent-one') {
      A.getSelection('commerce-subscriptions').clear();
      A.getSelection('commerce-subscriptions').add(id);
      rentCreate();
      return true;
    }
    if (action === 'commerce-rent-create') {
      rentCreate();
      return true;
    }
    if (action === 'commerce-rent-detail') {
      A.go(`orders/exclusive/rentals/${id}`);
      return true;
    }
    if (action === 'commerce-rent-copy') {
      const batch = rentBatches.find((row) => row.id === id);
      if (batch)
        A.copyText(
          `${batch.id}\n发放对象\t账号\t期间\t状态\n${batch.items.map((item) => `${tenantLabel(item.tenantId)}\t${item.email}\t${item.period}\t${item.status}`).join('\n')}`
        );
      return true;
    }
    if (action === 'commerce-rent-item') {
      rentItemEditor(node.dataset.batch, id);
      return true;
    }
    if (action === 'commerce-rent-item-log') {
      const batch = rentBatches.find((row) => row.id === node.dataset.batch),
        item = batch?.items.find((row) => row.id === id);
      if (item)
        A.openDrawer(
          '逐项付租记录',
          '',
          `<div class="property-list">${property('邮箱账号', item.email)}${property('发放对象', tenantLabel(item.tenantId))}${property('租赁期间', item.period)}${property('发放时间', item.paidAt)}${property('状态', item.status)}${property('备注', item.notes)}</div>${
            item.payments.length
              ? A.table(
                  [
                    { id: 'status', label: '发放状态' },
                    { id: 'at', label: '时间' },
                    { id: 'actor', label: '登记人' },
                    { id: 'notes', label: '备注', long: true }
                  ],
                  item.payments.map((row, index) => ({ ...row, id: String(index) })),
                  '',
                  'commerce-rent-payments'
                )
              : A.empty('暂无发放记录', '待发放和发放失败不记为已经发放。')
          }`,
          A.button('关闭', 'drawer-close')
        );
      return true;
    }
    if (action === 'commerce-stats-tab') {
      moduleState.statsTab = node.dataset.tab;
      S.page = 1;
      A.render();
      return true;
    }
    return false;
  }
  function onSubmit(form) {
    if (form.id === 'commerce-renewal-settings') {
      saveRenewalSettings(form);
      return true;
    }
    if (form.id === 'commerce-fx-form') {
      saveFxSnapshot(form);
      return true;
    }
    if (form.id === 'commerce-reversal-form') {
      saveReversal(form);
      return true;
    }
    if (form.id === 'commerce-contact-form') {
      saveContact(form);
      return true;
    }
    if (form.id === 'commerce-order-form') {
      saveOrder(form);
      return true;
    }
    if (form.id === 'commerce-refund-form') {
      saveRefund(form);
      return true;
    }
    if (form.id === 'commerce-bank-return-form') {
      saveBankReturn(form);
      return true;
    }
    if (form.id === 'commerce-tenant-cards-form') {
      void changeTenantCard(form, form.elements['tenant-id'].value);
      return true;
    }
    if (form.id === 'commerce-prices-form') {
      void savePrices(form);
      return true;
    }
    if (form.id === 'commerce-rent-create-form') {
      saveRentBatch(form);
      return true;
    }
    if (form.id === 'commerce-rent-payment-form') {
      saveRentPayment(form);
      return true;
    }
    return false;
  }
  const emailCostRule = {
    google: 'gmailCostCny', '谷歌邮箱': 'gmailCostCny',
    apple: 'appleCostCny', relay: 'appleCostCny', '苹果邮箱': 'appleCostCny', '苹果隐藏邮箱': 'appleCostCny',
    microsoft: 'microsoftCostCny', '微软邮箱': 'microsoftCostCny'
  };
  const stockForms = new WeakSet();
  function updateCustomerEmailHistory(form, match = false) {
    const email = form.querySelector('#commerce-email');
    const select = form.querySelector('#commerce-emailHistory');
    if (!email || !select) return;
    const picker = select.closest('.commerce-search-picker');
    const trigger = picker.querySelector('.commerce-picker-trigger');
    const stock = form.elements['commerce-businessType'].value === '成品交付';
    const choices = stock ? stockChoices(form.elements['commerce-product'].value)
      : customerEmailChoices(form.elements['commerce-customerId'].value, form.elements['commerce-product'].value);
    const current = email.value.trim().toLowerCase();
    const wasHistory = [...select.options].some(option => option.value && option.value.toLowerCase() === current);
    if (match && !form.elements['commerce-id'].value && !stock && !email.readOnly && (!current || wasHistory))
      email.value = choices.slice(1).find(([value]) => !inventoryRenewalIssue(value, form.elements['commerce-customerId'].value, form.elements['commerce-product'].value))?.[0] || '';
    const selected = choices.find(([value]) => value.toLowerCase() === email.value.trim().toLowerCase())?.[0] || '';
    select.innerHTML = A.options(choices, selected);
    select.disabled = email.readOnly || (!stock && choices.length === 1);
    trigger.hidden = email.readOnly;
    email.hidden = stock && !email.readOnly;
    picker.classList.toggle('commerce-email-history', !stock);
    const search = picker.querySelector('[data-commerce-picker]');
    const label = stock ? '可用账号' : '客户历史邮箱';
    trigger.setAttribute('aria-label', label);
    search.setAttribute('aria-label', `搜索${label}`);
    search.placeholder = `搜索${label}`;
    picker.querySelector('[role="listbox"]').setAttribute('aria-label', label);
    picker.querySelector('.commerce-picker-empty').textContent = `没有匹配的${label}`;
    if (!stock) trigger.querySelector('.commerce-picker-label').textContent = '历史邮箱';
    form.querySelector('[data-commerce-field="email"] label')?.setAttribute('for', stock && !email.readOnly ? trigger.id : email.id);
    const help = form.querySelector('[data-commerce-field="email"] .field-title-help .title-description');
    if (help) {
      help.textContent = stock
        ? form.elements['commerce-id'].value ? '已保存的交付快照保留，不再次占用库存。' : '按邮箱搜索可用库存账号，保存成功后标记为已使用。'
        : '优先匹配所选客户最近使用的邮箱，也可直接填写新邮箱。';
      const helpTrigger = help.closest('.field-title-help');
      helpTrigger.hidden = email.readOnly && !stock;
      if (helpTrigger.hidden) helpTrigger.open = false;
    }
    if (select.disabled && picker.querySelector('.commerce-picker-popover').matches(':popover-open'))
      picker.querySelector('.commerce-picker-popover').hidePopover();
    filterPicker(search);
  }
  function updateStockSearch(form) {
    const email = form.querySelector('#commerce-email');
    if (!email) return;
    const stock = form.elements['commerce-businessType'].value === '成品交付';
    const required = stock || form.elements['commerce-product'].value !== 'GPT';
    email.setAttribute('aria-required', String(required));
    const label = form.querySelector('[data-commerce-field="email"] label');
    label?.querySelector('.required')?.toggleAttribute('hidden', !required);
    const existing = orders.find((row) => row.id === form.elements['commerce-id'].value);
    if (stock && !existing) {
      if (localData && !stockForms.has(form)) {
        stockForms.add(form);
        void A.modules.inventory?.refreshLocalInventory?.().then((ready) => {
          if (!ready) stockForms.delete(form);
          else if (form.isConnected) updateStockSearch(form);
        });
      }
      email.placeholder = '搜索并选择本产品的可用账号';
      const selected = availableStock(form.elements['commerce-product'].value).find(
        (row) => row.email.toLowerCase() === email.value.trim().toLowerCase()
      );
      form.elements['commerce-accountId'].value = selected?.id || '';
      const cost = form.elements['commerce-emailCostAmount'];
      if (selected && !form.elements['commerce-emailCostManual']?.value && cost) {
        const key = emailCostRule[selected.emailType];
        cost.value = (key && costSettings[key]) || '0';
        form.elements['commerce-emailCostCurrency'].value = 'CNY';
      }
    } else {
      email.removeAttribute('list');
      email.placeholder = '选择客户匹配历史邮箱，也可直接填写新邮箱';
      if (!existing?.accountId) form.elements['commerce-accountId'].value = '';
    }
    updateCustomerEmailHistory(form);
  }
  function updateOrderVisibility(form) {
    const order = orderFromForm(form),
      actual = order.costBasis === 'actual';
    const toggle = (name, show) => {
      const node = form.querySelector(`[data-commerce-field="${name}"]`);
      if (node) node.hidden = !show;
    };
    toggle('actualCostAmount', actual);
    toggle('actualCostCurrency', actual);
    toggle('appleRecoverableCostAmount', actual && order.payment === '苹果内购');
    toggle('cardId', order.payment === '银行卡');
    toggle('paymentId', order.payment === '银行卡' && order.product === 'GPT');
    toggle('appleIdId', order.payment === '苹果内购');
    toggle('appleMatchMin', order.payment === '苹果内购' && order.businessType === '成品交付');
    toggle('appleMatchMax', order.payment === '苹果内购' && order.businessType === '成品交付');
    refreshAppleOptions(form);
    const personnel = form.querySelector('[data-commerce-section="03"]');
    if (personnel) personnel.hidden = order.product === 'GPT';
    updateStockSearch(form);
  }
  function updateOrderPeriod(form) {
    const start = form.querySelector('#commerce-start').value;
    if (!start) return;
    const previous = orders.find(
      (row) => row.id === form.querySelector('#commerce-claudeRenewalId').value
    );
    form.querySelector('#commerce-expiry').value =
      previous && isClaude(previous) && parseDate(previous.expiry) > parseDate(start)
        ? A.addCalendarMonth(dateInput(previous.expiry))
        : A.addCalendarMonth(start);
  }
  function onChange(node) {
    if (node.dataset?.commercePicker) return true;
    if (node.id === 'commerce-renewal-product') {
      S.status = node.value;
      S.page = 1;
      A.render();
      return true;
    }
    if (node.dataset?.customerTag !== undefined) {
      const picker = node.closest('[data-customer-tag-picker]');
      const tags = [...picker.querySelectorAll('[data-customer-tag]:checked')].map((input) => input.value);
      picker.querySelector('[name="commerce-tags"]').value = JSON.stringify(tags);
      picker.querySelector('[data-customer-tag-summary]').textContent = tags.join('、') || '请选择标签（可多选）';
      A.setError('commerce-contact-tags', '');
      return true;
    }
    if (node.id === 'commerce-stat-currency') {
      if (localData) void A.modules.operations?.updateStatisticsCurrency?.(node.value);
      else {
        costSettings.currency = node.value;
        A.render();
      }
      return true;
    }
    const form = node.closest('#commerce-order-form');
    if (form) {
      if (node.id === 'commerce-ownerId') A.setError('commerce-ownerId', '');
      if (node.id === 'commerce-product') {
        form.querySelector('#commerce-plan').innerHTML = A.options(
          productPlans[node.value],
          productPlans[node.value][0]
        );
        form.querySelector('#commerce-claudeRenewalId').value = '';
        if (form.querySelector('#commerce-payment').value !== '苹果内购')
          form.querySelector('#commerce-paidCurrency').value = node.value === 'GPT' ? 'PHP' : 'MYR';
        if (
          form.querySelector('#commerce-businessType').value === '成品交付' &&
          !form.querySelector('#commerce-id').value
        ) {
          form.querySelector('#commerce-email').value = '';
          form.querySelector('#commerce-accountId').value = '';
        }
        updateOrderPeriod(form);
      }
      if (node.id === 'commerce-businessType') {
        form.querySelector('#commerce-claudeRenewalId').value = '';
        form.querySelector('#commerce-accountId').value = '';
        if (node.value === '成品交付' && !form.querySelector('#commerce-id').value)
          form.querySelector('#commerce-email').value = '';
        updateOrderPeriod(form);
      }
      if (node.id === 'commerce-plan' || node.id === 'commerce-product') {
        const [min, max] = appleMatch(form.elements['commerce-plan'].value);
        form.elements['commerce-appleMatchMin'].value = min;
        form.elements['commerce-appleMatchMax'].value = max;
        form.elements['commerce-appleIdId'].value = '';
        form.elements['commerce-saleManual'].value = '';
        applyOrderPrice(form);
      }
      if (node.id === 'commerce-customerId') {
        const customer = customers.find((row) => row.id === node.value);
        for (const [orderField, customerField] of orderContactFields)
          form.querySelector(`#commerce-${orderField}`).value = customer?.[customerField] || '';
        updateCustomerEmailHistory(form, true);
      }
      if (node.id === 'commerce-businessType') updateCustomerEmailHistory(form, true);
      if (node.id === 'commerce-payment') {
        const paid = form.querySelector('#commerce-paidCurrency'),
          amount = form.querySelector('#commerce-paidAmount');
        const nextCurrency =
          node.value === '苹果内购'
            ? 'USD'
            : form.querySelector('#commerce-product').value === 'GPT'
              ? 'PHP'
              : 'MYR';
        if (paid.value !== nextCurrency) amount.value = '';
        paid.innerHTML = A.options(
          currencyChoices(node.value === '苹果内购' ? ['USD'] : currencies),
          nextCurrency
        );
        if (node.value === '苹果内购') {
          if (
            !form.elements['commerce-saleCurrencyChosen'].value &&
            !form.querySelector('#commerce-saleAmount').value
          )
            form.querySelector('#commerce-saleCurrency').value = 'USD';
          clearRevealedCard(form);
          loadAppleOptions(form, true);
        } else void loadOrderCards(form, true);
      }
      if (node.id === 'commerce-saleCurrency') {
        form.elements['commerce-saleCurrencyChosen'].value = 'yes';
        form.elements['commerce-saleManual'].value = '';
        applyOrderPrice(form);
      }
      if (node.id === 'commerce-cardId') {
        const tenantId = form.elements['commerce-tenantId']?.value;
        const product = form.elements['commerce-product'].value;
        const options = product === 'GPT' ? cards() : tenantCards.get(tenantId)?.items || [];
        form.elements['commerce-paymentId'].value = cardTail(options.find((row) => row.id === node.value));
        clearRevealedCard(form);
        if (product === 'GPT') refreshPoolUsage(form);
        else if (node.value) void useTenantCard(form, 'reveal');
      }
      if (node.id === 'commerce-tenantId') {
        const tenant = tenants.find((row) => row.id === node.value);
        if (form.elements['commerce-verifierPhone']) form.elements['commerce-verifierPhone'].value = tenant?.phone || '';
        const card = form.elements['commerce-cardId'];
        if (card?.tagName === 'SELECT') card.innerHTML = A.options(cardChoices('Claude', node.value, ''), '');
        form.elements['commerce-paymentId'].value = '';
        clearRevealedCard(form);
        void loadOrderCards(form, true);
      }
      if (node.id === 'commerce-start') updateOrderPeriod(form);
      updateOrderVisibility(form);
      for (const search of form.querySelectorAll('[data-commerce-picker]')) filterPicker(search);
      const preview = form.querySelector('#commerce-cost-preview');
      if (preview) {
        if (['commerce-email', 'commerce-paidAmount', 'commerce-appleMatchMin', 'commerce-appleMatchMax'].includes(node.id))
          refreshAppleOptions(form);
        try {
          preview.innerHTML = costPreview(orderFromForm(form));
        } catch {
          preview.innerHTML = A.tag('金额格式待核对', 'warning');
        }
      }
      saveDrafts();
      return true;
    }
    if (node.closest('form[data-commerce-draft]')) {
      saveDrafts();
      return true;
    }
    return false;
  }
  function onInput(node) {
    if (node.dataset?.commercePicker) {
      filterPicker(node);
      return true;
    }
    if (node.id === 'commerce-search') {
      const cursor = node.selectionStart;
      S.query = node.value;
      S.page = 1;
      A.render();
      const search = $('#commerce-search');
      search?.focus();
      search?.setSelectionRange(cursor, cursor);
      return true;
    }
    if (node.closest('form[data-commerce-draft]')) {
      if (node.id === 'commerce-email') updateStockSearch(node.closest('#commerce-order-form'));
      if (node.id === 'commerce-saleAmount') node.form.elements['commerce-saleManual'].value = 'yes';
      if (['commerce-emailCostAmount', 'commerce-emailCostCurrency'].includes(node.id) && node.form.elements['commerce-emailCostManual'])
        node.form.elements['commerce-emailCostManual'].value = 'yes';
      saveDrafts();
      const form = node.closest('#commerce-order-form'),
        preview = $('#commerce-cost-preview');
      if (form && preview) {
        if (['commerce-email', 'commerce-paidAmount', 'commerce-appleMatchMin', 'commerce-appleMatchMax'].includes(node.id))
          refreshAppleOptions(form);
        try {
          preview.innerHTML = costPreview(orderFromForm(form));
        } catch {
          preview.innerHTML = A.tag('金额格式待核对', 'warning');
        }
      }
      return true;
    }
    return false;
  }
  function matches(route) {
    return (
      [
        'customers/new',
        'customers/new/tenant',
        'customers/list',
        'customers/tenants',
        'workspace/order', gptOrderRoute, claudeOrderRoute,
        renewalRoute,
        customerLossRoute,
        'orders/gpt',
        'orders/pro',
        'orders/max',
        'orders/exclusive',
        'orders/statistics'
      ].includes(route) ||
      route.startsWith(renewalOrderPrefix) ||
      route.startsWith('orders/exclusive/rentals') ||
      route.startsWith('orders/detail/')
    );
  }
  function render() {
    if (localData && localPhase !== 'ready') {
      return (
        A.header('本机业务资料', '') +
        `<section class="panel">${
          localPhase === 'error'
            ? A.empty('无法读取本机业务资料', '请确认本机服务后重试。') +
              A.button('重试', 'commerce-local-retry', 'primary')
            : A.empty('正在读取本机业务资料', '请稍候。')
        }</section>`
      );
    }
    if (S.route === 'customers/new' || S.route === 'customers/new/tenant') {
      const tenant = S.route === 'customers/new/tenant';
      return (
        A.header(
          tenant ? '租户录入' : '客户录入',
          tenant
            ? '保存后进入租户数据。录入人和修改人自动记录。'
            : '保存后进入客户数据。录入人和修改人自动记录，历史开通业务可在客户详情查看。'
        ) + contactForm(tenant, '', false, true)
      );
    }
    if (S.route === 'customers/list') return renderContacts(false);
    if (S.route === 'customers/tenants') return renderContacts(true);
    if (isOrderEntry(S.route) || S.route.startsWith(renewalOrderPrefix)) return renderOrderPage();
    if (S.route === renewalRoute) return renderRenewals();
    if (S.route === customerLossRoute) return renderCustomerLoss();
    if (S.route.startsWith('orders/detail/'))
      return orderDetail(S.route.split('/').at(-1), moduleState.detailTab, true);
    if (S.route === 'orders/statistics') return renderStatistics();
    if (S.route.startsWith('orders/exclusive')) return renderClaude();
    return renderOrders(
      S.route === 'orders/pro' ? 'Claude Pro' : S.route === 'orders/max' ? 'Claude Max' : 'GPT'
    );
  }
  function overviewSummary(dates) {
    if (localPhase !== 'ready' || !localData || !A.canVisit('orders/statistics')) return null;
    const daily = new Map(dates.map(date => [date, {
      date, orders: 0, cancelled: 0, customers: 0, receipts: {}, refunds: {},
      profit: '0', accounted: 0, pending: 0
    }]));
    const bucket = value => {
      const timestamp = parseDate(value);
      return Number.isFinite(timestamp) ? daily.get(beijingClock.format(timestamp).slice(0, 10)) : null;
    };
    const addOriginal = (amounts, currency, amount) => {
      if (!/^[A-Z]{3}$/.test(currency) || !amountValid(amount)) return;
      amounts[currency] = M.add(amounts[currency] || '0', amount);
    };
    let incomplete = 0;
    for (const order of orders) {
      const day = bucket(order.createdAt);
      for (const refund of order.refunds || []) {
        const refundDay = bucket(refund.at);
        if (refundDay) addOriginal(refundDay.refunds, order.saleCurrency, refund.amount);
      }
      if (order.cancelled) {
        if (day) day.cancelled++;
        continue;
      }
      if (orderStatus(order) === '待补全') incomplete++;
      if (!day) continue;
      day.orders++;
      if (order.receiptConfirmed) addOriginal(day.receipts, order.saleCurrency, order.saleAmount);
      const accounting = order.payment === '苹果内购' && !A.modules.appleBalance?.ready()
        ? { status: 'pending', reason: '苹果 ID 余额尚未就绪' }
        : localAccounting(order, 'CNY');
      const gain = profit(order, accounting);
      if (gain === null) day.pending++;
      else {
        day.accounted++;
        day.profit = M.add(day.profit, gain);
      }
    }
    for (const customer of customers) {
      const day = bucket(customer.createdAt);
      if (day) day.customers++;
    }
    const { reminders, histories, active, ambiguous } = renewalProjection();
    const pending = reminders.filter(row => row.state !== 'processed');
    return {
      daily: [...daily.values()], incomplete, renewals: pending.length, active: active.size,
      followUp: new Set(pending.map(row => row.identity).filter(Boolean)).size,
      lost: [...histories.keys()].filter(id => !active.has(id) && !ambiguous.has(id)).length
    };
  }
  let requestedAccountLifecycle = false;
  A.modules.commerce = {
    refreshCustomerTagOptions,
    refreshOverview: () => loadLocalCommerce(true, true),
    overviewSummary,
    addRechargeOrder,
    getCostSettings: () => safeClone(costSettings),
    updateCostSettings,
    replaceCostSettings(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      for (const key of Object.keys(costSettings))
        if (Object.hasOwn(snapshot, key)) costSettings[key] = snapshot[key];
    },
    getFxRates: () => (localData ? {} : safeClone(fxRates)),
    installFinance(module) {
      finance = module;
      if (localData && localPhase === 'ready' && matches(S.route)) A.render();
    },
    getCustomers: () => safeClone(customers),
    getTenants: () => safeClone(tenants),
    getOrder: (id) => safeClone(orders.find((row) => row.id === id) || null),
    renewalReminderCount: () =>
      localPhase === 'ready' ? renewalProjection().reminders.filter((row) => row.state !== 'processed').length : 0,
    getOrderStatuses: (id) => {
      const order = orders.find((row) => row.id === id);
      return order ? independentStatuses(order) : null;
    },
    listOrders: () => safeClone(orders),
    getRentalBatches: () =>
      safeClone(rentBatches.map((batch) => ({ ...batch, status: rentBatchStatus(batch) }))),
    getCurrentSubscription: (email) =>
      safeClone(
        currentSubscriptions().find(
          (row) => row.email.toLowerCase() === String(email).toLowerCase()
        ) || null
      )
  };
  function updateRenewalReminder() {
    const badge = $('#renewal-reminder-count');
    const count = A.modules.commerce.renewalReminderCount();
    if (badge && badge.textContent !== String(count)) badge.textContent = String(count);
    if (badge) badge.hidden = count === 0;
  }
  window.addEventListener?.('DOMContentLoaded', () => {
    if (localData?.authRequired && S.actor?.role === 'employee') return;
    loadLocalCommerce();
    updateRenewalReminder();
    if (localData) window.setInterval(() => {
      updateRenewalReminder();
      if ((S.route === renewalRoute || S.route === customerLossRoute) &&
          localPhase === 'ready' && !$('#drawer')?.open && !$('#confirm-dialog')?.open &&
          !document.activeElement?.closest('input, select, textarea, button'))
        A.render();
    }, 60_000);
  }, { once: true });
  document.addEventListener?.('toggle', (event) => {
    const popup = event.target;
    if (!popup.matches?.('.commerce-picker-popover')) return;
    const picker = popup.closest('.commerce-search-picker');
    const open = event.newState === 'open';
    picker.querySelector('.commerce-picker-trigger').setAttribute('aria-expanded', String(open));
    if (!open) return;
    const search = picker.querySelector('[data-commerce-picker]');
    if (picker.querySelector('#commerce-email')) search.value = '';
    filterPicker(search);
    positionPicker(popup);
    search.focus({ preventScroll: true });
  }, true);
  document.addEventListener?.('keydown', (event) => {
    const popup = event.target.closest('.commerce-picker-popover');
    if (!popup || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      popup.hidePopover();
      popup.closest('.commerce-search-picker').querySelector('.commerce-picker-trigger').focus({ preventScroll: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
    const search = popup.querySelector('[data-commerce-picker]');
    if (event.target === search && !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    if (event.key === 'Enter' && event.target !== search) return;
    event.preventDefault();
    const options = [...popup.querySelectorAll('[role="option"]')];
    if (event.key === 'Enter') {
      const option = event.target === search ? options.find(option => option.dataset.value) : event.target;
      option?.click();
      return;
    }
    const index = options.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
      event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) :
        index < 0 ? options.length - 1 : Math.max(0, index - 1);
    options[next]?.focus({ preventScroll: true });
    options[next]?.scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener?.('focusin', (event) => {
    for (const popup of document.querySelectorAll('.commerce-picker-popover:popover-open'))
      if (!popup.closest('.commerce-search-picker').contains(event.target)) popup.hidePopover();
  });
  const positionOpenPickers = () => {
    for (const popup of document.querySelectorAll('.commerce-picker-popover:popover-open')) positionPicker(popup);
  };
  window.addEventListener?.('resize', positionOpenPickers);
  window.addEventListener?.('scroll', positionOpenPickers, { capture: true, passive: true });
  window.visualViewport?.addEventListener('resize', positionOpenPickers);
  window.visualViewport?.addEventListener('scroll', positionOpenPickers, { passive: true });
  const drawer = $('#drawer');
  drawer?.addEventListener('close', () => {
    if (drawer.open) return;
    const closedOrder = drawer.querySelector('#commerce-order-form');
    if (closedOrder) clearRevealedCard(closedOrder);
    const cardInput = drawer.querySelector('#commerce-tenant-card-number');
    if (cardInput) cardInput.value = '';
    if (customerSettingsReturn) {
      const back = customerSettingsReturn;
      customerSettingsReturn = null;
      if (back.route === S.route) {
        contactForm(false, back.id, back.quick);
        return;
      }
    }
    if (!quickReturn || quickReturn.tenant) return;
    const back = quickReturn;
    quickReturn = null;
    if (!back.main && back.route === S.route) orderEditor(back.orderId, back.renewalId, false);
  });
  window.IDDesignModules.push({
    id: 'commerce',
    matches,
    render,
    onClick,
    onSubmit,
    onChange,
    onInput,
    preserveDraft: saveDrafts,
    refreshCustomerTagOptions,
    afterRender() {
      for (const form of document.querySelectorAll('#commerce-order-form')) updateCustomerEmailHistory(form);
      for (const search of document.querySelectorAll('[data-commerce-picker]')) filterPicker(search);
      loadLocalCommerce();
      if (localData && !requestedAccountLifecycle && !A.modules.inventory?.accountLifecycleReady?.()) {
        requestedAccountLifecycle = true;
        const route = S.route;
        void A.modules.inventory?.refreshLocalInventory?.({ keepContent: true }).then(ready => {
          if (!ready || route !== S.route) return;
          const form = $('#commerce-order-form');
          if (form) updateCustomerEmailHistory(form);
          else A.render();
        });
      }
      updateRenewalReminder();
      if (!localData || localPhase !== 'ready') return;
      if (isOrderEntry(S.route) || S.route.startsWith(renewalOrderPrefix)) {
        const form = $('#commerce-order-form');
        if (form) void loadOrderOwners(form);
        if (form?.elements['commerce-payment']?.value === '苹果内购') loadAppleOptions(form);
        else if (form) void loadOrderCards(form);
        if (form) void loadPrices(form);
      } else if (S.route.startsWith('orders/')) {
        const apple = A.modules.appleBalance;
        if (!apple?.ready?.()) {
          const route = S.route;
          void apple?.ensureReady?.().then((ok) => {
            if (ok && S.route === route) A.render();
          });
        }
      }
    }
  });
})();
