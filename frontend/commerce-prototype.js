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
  let finance, cardIssueContext;
  let orderPrices = {};
  let priceLoad;
  let orderPriceReferenceReturn = null;
  let orderCards = [];
  const tenantCards = new Map();
  const cardLoads = new WeakMap();
  let bankCardTypes = { version: 0, items: [], assignments: {} };
  let bankCardTypesLoaded = false;
  let bankCardTypesRequest;
  let bankCardTypeReturn;
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
  const currencies = ['CNY', 'MYR', 'USD', 'PHP', 'CLP', 'IDR', 'EGP'];
  const currencyNames = {
    CNY: '人民币',
    MYR: '马币',
    USD: '美元',
    PHP: '菲律宾比索',
    CLP: '智利比索',
    IDR: '印尼盾',
    EGP: '埃及镑'
  };
  const currencyLabel = (code) => currencyNames[code] ? `${currencyNames[code]} ${code}` : code;
  let currencySettings = {};
  let currencySettingsRevision = 0;
  const paymentSettingsRoute = 'settings/payment-countries';
  const paymentCountries = {
    PHP: '菲律宾', CLP: '智利', USD: '美国', IDR: '印尼', MYR: '马来西亚', EGP: '埃及'
  };
  const personalPlans = {
    Gemini: ['Google AI Plus', 'Google AI Pro', 'Google AI Ultra 5x', 'Google AI Ultra 20x'],
    Grok: ['The X Subscription Plus', 'The X Subscription Premium', 'The X Subscription Super',
      'The X Subscription Ultra', 'SuperGrok Lite', 'SuperGrok', 'SuperGrok Plus', 'SuperGrok Heavy', 'X Premium', 'X Premium+']
  };
  const personalProduct = product => Object.hasOwn(personalPlans, product);
  const cardPoolProduct = product => product === 'GPT' || personalProduct(product);
  const personalSeries = (product, plan) => product === 'Gemini' ? 'google_ai'
    : plan?.startsWith('The X Subscription ') ? 'x_subscription'
      : plan?.startsWith('SuperGrok') ? 'supergrok' : 'x_premium';
  const personalTarget = order => order?.loginMethod === 'x' && order.xHandle ? order.xHandle : order?.email || order?.xHandle || '';
  const orderIdentity = order => personalProduct(order?.product) ? personalTarget(order) : order?.email || '';
  const orderListRoute = product => ({
    GPT: 'orders/gpt', 'Claude Pro': 'orders/pro', 'Claude Max': 'orders/max',
    Gemini: 'orders/gemini', Grok: 'orders/grok'
  })[product] || 'orders/gpt';
  const billingChannels = [['web', '平台网页 · 银行卡'], ['web_apple_pay', '平台网页 · Apple Pay'],
    ['google_play', 'Google Play · 银行卡'], ['app_store', 'App Store 内购']];
  const personalSeriesLabels = { google_ai: 'Google AI', x_subscription: 'The X Subscription',
    supergrok: 'SuperGrok', x_premium: 'X Premium' };
  const autoRenewChoices = [['unknown', '未核验'], ['on', '开启'], ['off', '关闭']];
  const openingChoices = [['pending', '待核对'], ['active', '已确认开通'], ['failed', '开通失败']];
  const personalLoginChoices = [['email', '邮箱登录'], ['google', 'Google 登录'], ['apple', 'Apple 登录'], ['x', 'X 登录']];
  const linkChoices = [['unknown', '未核验'], ['linked', '已绑定'], ['unlinked', '未绑定']];
  const labelOf = (choices, id) => choices.find(([value]) => value === id)?.[1] || '—';
  const currencyFamily = product => personalProduct(product) || product === 'GPT' ? product : 'Claude';
  const orderSettingsFamilies = ['GPT', 'Claude', ...Object.keys(personalPlans)];
  function orderCurrencyRows(product) {
    return currencySettings.orderCurrenciesByProduct?.[currencyFamily(product)] || currencySettings.orderCurrencies ||
      currencies.map(code => ({ code, name: currencyNames[code] }));
  }
  const orderCurrencyCodes = product => orderCurrencyRows(product).map(row => row.code);
  const currencyChoices = (codes = currencies, selected = '', product = '') =>
    [...new Set([...codes, ...(selected ? [selected] : [])])].map(code => {
      const name = orderCurrencyRows(product).find(row => row.code === code)?.name || currencyNames[code];
      return [code, `${name ? name + ' ' : ''}${code}` + (codes.includes(code) ? '' : '（已移出选项）')];
    });
  const gptCardPayment = (product, payment) => product === 'GPT' && payment === '银行卡';
  function paidCurrencyChoices(product, payment, selected) {
    if (payment === '苹果内购') return currencyChoices(['USD'], selected, product);
    const codes = orderCurrencyCodes(product), countries = Object.keys(paymentCountries);
    if (gptCardPayment(product, payment))
      return currencyChoices([...countries, ...codes], selected, product)
        .map(([code, label]) => [code, paymentCountries[code] ? paymentCountryLabel(code) : `其他 · ${label}`]);
    const prices = payment === '银行卡' ? Object.values(orderPaidPrices(product)) : [];
    const configured = countries.filter(code => prices.some(amounts => amounts[code]));
    return currencyChoices([...codes, ...configured], selected, product)
      .map(([code, label]) => [code, configured.includes(code) ? paymentCountryLabel(code, label) : label]);
  }
  function refreshCurrencyFields(form, preserve = true) {
    if (!form?.isConnected) return;
    const product = form.elements['commerce-product'].value;
    const payment = form.elements['commerce-payment'].value;
    for (const key of ['paidCurrency', 'saleCurrency']) {
      const select = form.querySelector(`select#commerce-${key}`);
      if (!select) continue;
      const paid = key === 'paidCurrency';
      const preferred = paid && gptCardPayment(product, payment) ? 'PHP' : select.value;
      const choices = paid ? paidCurrencyChoices(product, payment, preserve ? select.value : '')
        : currencyChoices(orderCurrencyCodes(product), preserve ? select.value : '', product);
      const selected = preserve ? select.value : choices.some(([code]) => code === preferred) ? preferred : choices[0]?.[0];
      select.innerHTML = A.options(choices, selected);
      updateOrderValueReadout(select);
    }
    if ($('select#commerce-paidCurrency', form)) {
      const label = $('label[for="commerce-paidCurrency"]', form);
      const name = gptCardPayment(product, payment) ? '国家／地区' : '代付币种';
      label.firstChild.textContent = name.slice(0, -1);
      label.querySelector('.field-label-end').firstChild.textContent = name.slice(-1);
    }
  }
  function captureOrderSettingsReturn() {
    const form = $('#main #commerce-order-form') || $('#drawer[open] #commerce-order-form');
    return form ? { route: S.route, actorId: currentOperator().id, main: Boolean(form.closest('#main')),
      id: form.elements['commerce-id'].value, renewalId: form.elements['commerce-claudeRenewalId'].value } : null;
  }
  const demoBankCardTypes = [
    ['card-type-vccwc999', 'vccwc999'], ['card-type-wise-pan', 'wise潘'],
    ['card-type-wise-jia', 'wise佳'], ['card-type-xiaohong-feng', '小红卡峰']
  ].map(([id, name]) => ({ id, name, active: true }));
  function bankCardTypeName(id) {
    return (localData ? bankCardTypes.items : demoBankCardTypes).find(row => row.id === id)?.name || '';
  }
  function bankCardTypeChoices(selected = '', savedName = '') {
    const rows = localData ? bankCardTypes.items : demoBankCardTypes;
    const options = rows.filter(row => row.active).map(row => [row.id, row.name]);
    if (selected && !options.some(([id]) => id === selected))
      options.unshift([selected, `${savedName || bankCardTypeName(selected) || '原银行卡类型'}（历史）`]);
    return [['', '未填写'], ...options];
  }
  async function readBankCardTypes(force = false) {
    if (!localData) return { ...bankCardTypes, items: demoBankCardTypes };
    if (bankCardTypesLoaded && !force) return bankCardTypes;
    if (!bankCardTypesRequest) bankCardTypesRequest = localData.cardTypes().then(snapshot => {
      updateBankCardTypes(snapshot);
      bankCardTypesLoaded = true;
      return bankCardTypes;
    }).finally(() => { bankCardTypesRequest = null; });
    return bankCardTypesRequest;
  }
  function updateBankCardTypes(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) throw new Error('银行卡类型返回格式无效');
    const { items, assignments } = snapshot;
    const version = Number.isSafeInteger(snapshot.version) ? snapshot.version : 0;
    if (version < bankCardTypes.version) return;
    bankCardTypes = {
      version,
      items: items.filter(row => typeof row?.id === 'string' && typeof row.name === 'string'),
      assignments: assignments && typeof assignments === 'object' && !Array.isArray(assignments) ? assignments : {}
    };
  }
  function refreshOrderCardType(form) {
    if (!form?.isConnected) return;
    const select = form.elements['commerce-cardTypeId'];
    if (!select) return;
    const source = orderCardSource(form);
    const cardId = source ? form.elements[`commerce-${source.field}`]?.value || '' : '';
    const touched = form.elements['commerce-card-type-touched']?.value === 'yes';
    const assigned = bankCardTypes.assignments[cardId];
    const selected = touched ? select.value : cardId !== select.dataset.originalCard
      ? (bankCardTypes.items.some(row => row.id === assigned && row.active) ? assigned : '') : select.dataset.savedType;
    select.innerHTML = A.options(bankCardTypeChoices(selected, select.dataset.savedName), selected);
    updateOrderValueReadout(select);
    const assignment = form.querySelector('[data-commerce-card-type-assign]');
    if (assignment) {
      assignment.dataset.id = cardId;
      assignment.hidden = !/^(?:recharge:|tenant:).+/.test(cardId);
    }
  }
  async function loadOrderCardType(form, force = false) {
    if (!form?.isConnected || form.elements['commerce-payment']?.value !== '银行卡') return;
    try {
      await readBankCardTypes(force);
      refreshOrderCardType(form);
      if (form.isConnected) A.setError('commerce-cardTypeId', '');
    } catch {
      if (form.isConnected && form.elements['commerce-payment']?.value === '银行卡')
        A.setError('commerce-cardTypeId', '银行卡类型读取失败，可点管理类型重试');
    }
  }
  function orderCardTypeField(v, existing) {
    return field('银行卡类型', 'cardTypeId', `<div class="field-row">${select('cardTypeId',
      bankCardTypeChoices(v('cardTypeId'), v('cardTypeName')), v('cardTypeId'),
      `data-saved-name="${E(v('cardTypeName'))}" data-saved-type="${E(v('cardTypeId'))}" data-original-card="${E(existing?.cardId || '')}"`)}${
      input('card-type-touched', v('card-type-touched'), 'type="hidden"')}${canManageOrders() ?
      A.button('管理类型', 'commerce-card-types', 'compact', '', 'aria-label="管理银行卡类型"') +
      A.button('设置所选卡类型', 'commerce-card-type-assign', 'compact', '', 'data-commerce-card-type-assign hidden') : ''}</div>`,
      false, '可留空。订单所选类型独立保存，修改卡片分类请使用设置所选卡类型。', '', v('payment') !== '银行卡');
  }
  function cardTypeDrawerReturn(onClose) {
    if (bankCardTypeReturn) return;
    const order = captureOrderSettingsReturn();
    bankCardTypeReturn = { route: S.route, actorId: currentOperator().id, order, onClose };
  }
  async function openBankCardTypeEditor(id = '', refreshVersion = false) {
    if (!localData || !canManageOrders()) return;
    saveDrafts();
    const route = S.route, actorId = currentOperator().id, context = S.drawerContext;
    try {
      const snapshot = bankCardTypesLoaded && !refreshVersion && context.startsWith('commerce-card-type:')
        ? bankCardTypes : await readBankCardTypes(true);
      if (route !== S.route || actorId !== currentOperator().id || context !== S.drawerContext) return;
      const item = id ? snapshot.items.find(row => row.id === id && row.active) : null;
      if (id && !item) throw new Error('银行卡类型已停用，请选择其他类型');
      const key = `commerce-card-type:${id || 'new'}`;
      const draft = S.drafts.get(key) || {};
      const columns = [
        { id: 'name', label: '银行卡类型' },
        { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${
          A.textAction('修改', 'commerce-card-type-edit', `data-id="${E(row.id)}"`)}${
          A.textAction('移除', 'commerce-card-type-remove', `data-id="${E(row.id)}"`, 'danger')}</div>` }
      ];
      const active = snapshot.items.filter(row => row.active);
      const list = active.length ? A.table(columns, active, '', 'commerce-card-types') : A.empty('暂无类型', '可在下方新增银行卡类型。');
      cardTypeDrawerReturn();
      A.openDrawer('银行卡类型管理', '全站共用类型。移除后不再用于新单，历史订单保留原类型。',
        `${list}<form id="commerce-card-type-form" data-commerce-draft="${E(key)}" novalidate>${
          input('card-type-id', id, 'type="hidden"')}${input('card-type-version',
          refreshVersion ? snapshot.version : draft['commerce-card-type-version'] ?? snapshot.version, 'type="hidden"')}${field(item ? '修改名称' : '新增名称',
          'card-type-name', input('card-type-name', draft['commerce-card-type-name'] ?? item?.name ?? '', 'maxlength="40"'), true)}</form>`,
        A.button('关闭', 'drawer-close') + A.button('读取最新', 'commerce-card-type-reload', '', '', `data-id="${E(id)}"`) +
          (item ? A.button('返回新增', 'commerce-card-types') : '') +
          `<button type="submit" class="button primary" form="commerce-card-type-form">${item ? '保存修改' : '新增类型'}</button>`, key);
    } catch (error) { A.notify(error.message || '银行卡类型读取失败，请重试'); }
  }
  async function openBankCardTypeAssignment(cardId, onClose, refreshVersion = false) {
    if (!localData || !canManageOrders() || !/^(?:recharge:|tenant:).+/.test(cardId)) return;
    saveDrafts();
    const route = S.route, actorId = currentOperator().id, context = S.drawerContext;
    try {
      const snapshot = await readBankCardTypes(true);
      if (route !== S.route || actorId !== currentOperator().id || context !== S.drawerContext) return;
      const key = `commerce-card-type-assignment:${cardId}`;
      const draft = S.drafts.get(key) || {};
      const selected = draft['commerce-assignment-type'] ?? snapshot.assignments[cardId] ?? '';
      cardTypeDrawerReturn(onClose);
      A.openDrawer('设置银行卡类型', '应用到此卡的共享类型。订单已经保存的类型按原记录显示。',
        `<form id="commerce-card-type-assignment-form" data-commerce-draft="${E(key)}" novalidate>${
          input('assignment-card', cardId, 'type="hidden"')}${input('assignment-version',
          refreshVersion ? snapshot.version : draft['commerce-assignment-version'] ?? snapshot.version, 'type="hidden"')}${field('银行卡类型',
          'assignment-type', select('assignment-type', bankCardTypeChoices(selected), selected))}</form>`,
        A.button('取消', 'drawer-close') + A.button('读取最新', 'commerce-card-type-assignment-reload', '', '', `data-id="${E(cardId)}"`) +
          '<button type="submit" class="button primary" form="commerce-card-type-assignment-form">保存类型</button>', key);
    } catch (error) { A.notify(error.message || '银行卡类型读取失败，请重试'); }
  }
  async function saveBankCardType(form) {
    if (!canManageOrders() || form.getAttribute('aria-busy') === 'true') return;
    const raw = A.readForm(form);
    const assignment = form.id === 'commerce-card-type-assignment-form';
    const id = value(raw, 'card-type-id'), name = value(raw, 'card-type-name');
    if (!assignment && (!name || name.length > 40 || /[\p{Cc}\p{Cf}/]/u.test(name))) {
      A.setError('commerce-card-type-name', '请输入 1 至 40 字的银行卡类型名称，名称不能含斜杠');
      return;
    }
    const command = assignment
      ? { action: 'assign', version: Number(value(raw, 'assignment-version')),
          cardId: value(raw, 'assignment-card'), typeId: value(raw, 'assignment-type') }
      : { action: id ? 'rename' : 'add', version: Number(value(raw, 'card-type-version')), id, name };
    const submitted = JSON.stringify(raw), actorId = currentOperator().id;
    form.setAttribute('aria-busy', 'true');
    try {
      const snapshot = await localData.cardTypeAction(command);
      if (actorId !== currentOperator().id) return;
      updateBankCardTypes(snapshot);
      bankCardTypesLoaded = true;
      if (form.isConnected && submitted === JSON.stringify(A.readForm(form))) {
        S.drafts.delete(form.dataset.commerceDraft);
        form.removeAttribute('data-commerce-draft');
        if (assignment) cleanClose();
        else void openBankCardTypeEditor();
      }
      A.notify('银行卡类型已保存');
    } catch (error) { A.notify(error.message || '银行卡类型保存失败，输入已保留'); }
    finally { form.removeAttribute('aria-busy'); }
  }
  function removeBankCardType(id) {
    const item = bankCardTypes.items.find(row => row.id === id && row.active);
    if (!item || !canManageOrders()) return;
    const version = bankCardTypes.version, route = S.route, actorId = currentOperator().id;
    const context = S.drawerContext;
    A.confirmAction('移除银行卡类型', `${item.name} 停止用于新单，历史订单保留原名称。`, async () => {
      if (route !== S.route || actorId !== currentOperator().id || context !== S.drawerContext) return;
      try {
        const snapshot = await localData.cardTypeAction({ action: 'remove', version, id });
        if (actorId !== currentOperator().id) return;
        updateBankCardTypes(snapshot);
        A.notify('银行卡类型已移除');
        if (route === S.route && context === S.drawerContext) void openBankCardTypeEditor();
      } catch (error) { A.notify(error.message || '银行卡类型移除失败，请重试'); }
    });
  }
  async function openCurrencySettings(product, reset = false) {
    if (!paymentSettingsActive()) return;
    saveDrafts();
    const family = currencyFamily(product), key = `commerce-order-currencies:${family}`;
    if (reset) S.drafts.delete(key);
    const route = S.route, actorId = currentOperator().id, context = S.drawerContext;
    try {
      const snapshot = localData ? await localData.load('settings') : { version: 0, data: currencySettings };
      if (S.route !== route || currentOperator().id !== actorId || S.drawerContext !== context) return;
      currencySettings = snapshot.data || {};
      const draft = S.drafts.get(key) || {};
      A.openDrawer(`${family} 币种设置`, family === 'GPT'
        ? '维护 GPT 售卖币种及其他银行卡代付币种。固定的代付国家继续可选，苹果内购代付为美元。'
        : `维护 ${family} 的售卖与手工代付币种。已配置代付价的国家也可选，苹果内购代付为美元。`,
        `<form id="commerce-currencies-form" data-commerce-draft="${key}" novalidate>${input('currency-product', family, 'type="hidden"')}${input('currency-version', draft['commerce-currency-version'] ?? snapshot.version, 'type="hidden"')}${A.optionListEditor({ id: 'commerce-currency-options', label: '可选币种', itemLabel: '币种', values: orderCurrencyRows(product).map(row => `${row.name} ${row.code}`), minItems: 1, draft })}<p class="footnote">填写币种名称和三位代码，例如：欧元 EUR。没有有效汇率的新增币种保持待核算。</p></form>`,
        A.button('关闭', 'drawer-close') + A.button('读取最新', 'commerce-currency-reload', '', '', `data-product="${E(product)}"`) +
        '<button type="submit" form="commerce-currencies-form" class="button primary">保存币种设置</button>', key);
    } catch (error) { A.notify(error.message || '币种设置读取失败，请重试'); }
  }
  async function saveCurrencySettings(form, confirmed = '') {
    if (!paymentSettingsActive() || form.getAttribute('aria-busy') === 'true') return;
    if (A.optionListPending(form)) { A.setError('commerce-currency-options', '请先添加或保存正在编辑的币种'); return; }
    const raw = A.readForm(form), family = value(raw, 'currency-product');
    if (!orderSettingsFamilies.includes(family)) return;
    const rows = A.readOptionList(raw['commerce-currency-options']).map(text => {
      const match = /^(.{1,40}?)\s+([a-zA-Z]{3})$/.exec(text);
      return match ? { name: match[1].trim(), code: match[2].toUpperCase() } : null;
    });
    if (!rows.length || rows.length > 100 || rows.some(row => !row || /[\r\n\t]/.test(row.name)) ||
        new Set(rows.map(row => row?.code)).size !== rows.length) {
      A.setError('commerce-currency-options', '请填写名称和三位代码，代码不可重复，至少保留一种币种'); return;
    }
    A.setError('commerce-currency-options', '');
    const submitted = JSON.stringify(readCommerceDraft(form)), actorId = currentOperator().id;
    if (!confirmed) {
      A.confirmAction('确认保存币种设置', `仅更新 ${family}，历史订单和另一产品设置保持原值。`, () => {
        if (currentOperator().id === actorId && form.isConnected && JSON.stringify(readCommerceDraft(form)) === submitted)
          void saveCurrencySettings(form, submitted);
        else A.notify('输入或登录身份已变化，请重新核对后保存');
      });
      return;
    }
    form.setAttribute('aria-busy', 'true');
    try {
      const version = Number(raw['commerce-currency-version']);
      const snapshot = localData ? await localData.load('settings') : { version, data: currencySettings };
      if (currentOperator().id !== actorId || !form.isConnected) return;
      if (snapshot.version !== version) throw new Error('币种设置已变化，输入已保留；请读取最新清单后重新编辑');
      const data = snapshot.data || { costSettings: safeClone(costSettings), mailboxTypes: A.modules.operations?.getMailboxTypes?.() || [] };
      const next = { ...data, orderCurrenciesByProduct: { ...data.orderCurrenciesByProduct, [family]: rows } };
      let savedVersion = version;
      if (localData) {
        const result = await localData.save('settings', version, next, { action: 'order_currencies_save' });
        if (!Number.isInteger(result?.version) || result.version <= version ||
            JSON.stringify(result.data?.orderCurrenciesByProduct?.[family]) !== JSON.stringify(rows))
          throw new Error('尚未确认币种保存成功，请重新读取核对');
        savedVersion = result.version;
      }
      if (currentOperator().id !== actorId) return;
      currencySettingsRevision++;
      currencySettings = next;
      priceLoad = null;
      paymentSettingsVersion = savedVersion;
      if (form.isConnected) {
        if (JSON.stringify(readCommerceDraft(form)) === confirmed) cleanClose(form.dataset.commerceDraft);
        else { form.elements['commerce-currency-version'].value = savedVersion; saveDrafts(); }
      }
      refreshCurrencyFields($('#commerce-order-form'));
      A.notify(`${family} 币种设置已保存`);
    } catch (error) { A.notify(error.message || '币种设置保存失败，输入已保留'); }
    finally { form.removeAttribute('aria-busy'); }
  }
  const productPlans = {
    GPT: ['Plus', 'Pro 100', 'Pro 200', 'Pro 500'],
    'Claude Pro': ['Pro'],
    'Claude Max': ['Max 5x', 'Max 20x'],
    ...personalPlans
  };
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
  const subscriptionCardsRoute = 'data-management/bank-cards';
  const customerLossRoute = 'workspace/customer-loss';
  const renewalOrderPrefix = 'workspace/order/renew/';
  const gptOrderRoute = 'workspace/order/gpt';
  const claudeOrderRoute = 'workspace/order/claude';
  const personalEntries = { 'workspace/order/gemini': 'Gemini', 'workspace/order/grok': 'Grok' };
  const isOrderEntry = route => ['workspace/order', gptOrderRoute, claudeOrderRoute].includes(route) || Object.hasOwn(personalEntries, route);
  const entryRoute = product => personalProduct(product) ? 'workspace/order/' + product.toLowerCase()
    : product === 'GPT' ? gptOrderRoute : claudeOrderRoute;
  const automaticOrder = (row) => row?.source === '线上代充' && Boolean(row.taskId);
  const entryDraft = product => `commerce-order:new:${currencyFamily(product).toLowerCase()}`;
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
    cardIssueContext = undefined;
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
    updateEntryRecords();
  }
  let commerceLoad, orderSyncRead;
  function loadLocalCommerce(retry = false, refresh = false) {
    if (commerceLoad) return commerceLoad;
    if (!localData || (!refresh && localPhase !== 'initial' && !(retry && localPhase === 'error')))
      return Promise.resolve(localPhase === 'ready');
    const hadData = localPhase === 'ready';
    const syncRead = orderSyncRead;
    if (!hadData) localPhase = 'loading';
    commerceLoad = localData
      .load('commerce')
      .then(
        (result) => {
          acceptLocalCommerce(result);
          if (orderSyncRead === syncRead) orderSyncRead = undefined;
          for (const form of document.querySelectorAll('#main #commerce-order-form, #drawer[open] #commerce-order-form'))
            updateCustomerEmailHistory(form);
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
        if (matches(S.route) && !(S.route === customerLossRoute && retentionRefresh) &&
            (!hadData || !$('#main form[data-commerce-draft]'))) A.render();
      });
    return commerceLoad;
  }
  async function refreshAfterOrderSync() {
    orderSyncRead = Symbol();
    await commerceLoad;
    return !orderSyncRead || loadLocalCommerce(true, true);
  }
  function syncedOrderId(jobKey, orderNo) {
    const matches = orders.filter(order => order.product === 'GPT' && automaticOrder(order) && order.taskId === jobKey);
    return matches.length === 1 && matches[0].orderNo === orderNo ? matches[0].id : '';
  }
  function syncedOrderReadNotice() {
    if (!orderSyncRead || commerceLoad) return '';
    return `<p class="panel-body inline-notice warning" role="status">同步批次已处理，业务订单暂未刷新。${
      A.textAction('重读订单', 'commerce-sync-orders-refresh')}</p>`;
  }
  function persistCommerce(action, mutate, completed, dependencies = [], afterCommit) {
    if (!localData) {
      if (mutate() !== false) A.completeAction ? A.completeAction(completed) : completed();
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
    const feedback = A.beginActionFeedback?.(null, '正在保存记录…');
    void commit
      .then(
        (result) => {
          if (result.inventory) A.modules.inventory?.applyCommittedInventory?.(result.inventory);
          acceptLocalCommerce(result);
          afterCommit?.();
          const unchanged = !submittedForm || (submittedForm.isConnected &&
            JSON.stringify(readCommerceDraft(submittedForm)) === submittedDraft);
          if (S.route === route && S.drawerContext === drawerContext && unchanged)
            A.completeAction ? A.completeAction(completed, '记录已保存') : completed();
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
            A.notify(unchanged ? '记录已保存到服务器数据库' : '记录已保存，后续输入已保留');
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
            A.notify('服务器保存失败，未登记本次操作，请重新核对');
          } else {
            localPhase = 'error';
            A.notify('暂时无法确认服务器保存结果，请刷新页面核对记录后再提交');
          }
        }
      )
      .finally(() => {
        feedback?.finish();
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
  function select(id, choices, selected = '', attributes = '') {
    const html = A.select(`commerce-${id}`, choices, selected);
    return attributes ? html.replace('<select ', `<select ${attributes} `) : html;
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
    const gpt = cardPoolProduct(product);
    const items = gpt ? cards() : (tenantCards.get(tenantId)?.items || []);
    const options = items.filter((row) => (gpt ? row.status !== '停用' && row.active !== false : row.active) || row.id === selected)
      .map((row) => [row.id, [row.label || row.name, `尾号 ${cardTail(row)}`, bankCardTypeName(bankCardTypes.assignments[row.id]), gpt && Number.isInteger(row.usageCount) ? `已用 ${row.usageCount} 次` : ''].filter(Boolean).join(' · ')]);
    if (selected && !options.some(([id]) => id === selected)) options.unshift([selected, savedTail ? `已选银行卡 · 尾号 ${savedTail}` : '已选银行卡']);
    return [['', gpt ? '选择银行卡' : '选择租户银行卡'], ...options];
  }
  function orderCardSource(form) {
    const product = form.elements['commerce-product']?.value;
    const mode = form.elements['commerce-proMaterialMode']?.value;
    if (form.elements['commerce-payment']?.value !== '银行卡') return null;
    if (cardPoolProduct(product)) return { field: 'cardId', pool: true };
    if (product === 'Claude Pro' && mode === 'pool_card') return { field: 'proPoolCardId', pool: true };
    if (product === 'Claude Max' || (product === 'Claude Pro' && (!mode || mode === 'tenant_card')))
      return { field: 'cardId', pool: false };
    return null;
  }
  async function loadOrderCards(form, force = false) {
    const source = orderCardSource(form);
    if (!localData || !source) return;
    const tenantId = form.elements['commerce-tenantId']?.value || '';
    const select = form.elements[`commerce-${source.field}`];
    if (!select || select.tagName !== 'SELECT') return;
    const loadKey = source.pool ? `pool:${source.field}` : tenantId;
    if (!loadKey || (!force && cardLoads.get(form)?.key === loadKey)) return;
    const request = { key: loadKey };
    cardLoads.set(form, request);
    try {
      const snapshot = source.pool ? await localData.orderCards() : await localData.tenantCards(tenantId);
      if (cardLoads.get(form) !== request) return;
      if (source.pool) orderCards = snapshot.items || [];
      else tenantCards.set(tenantId, snapshot);
      const current = orderCardSource(form);
      if (form.isConnected && current?.field === source.field && current.pool === source.pool &&
          (source.pool || form.elements['commerce-tenantId'].value === tenantId)) {
        select.innerHTML = A.options(cardChoices(source.pool ? 'GPT' : 'Claude', tenantId, select.value,
          form.elements['commerce-paymentId'].value), select.value);
        const search = select.closest('.commerce-search-picker')?.querySelector('input[type="search"]');
        if (search) filterPicker(search);
        if (source.pool && source.field === 'cardId') refreshPoolUsage(form);
        A.setError(`commerce-${source.field}`, '');
        return true;
      }
    } catch (error) {
      if (cardLoads.get(form) !== request) return;
      cardLoads.delete(form);
      if (form.isConnected && orderCardSource(form)?.field === source.field)
        A.setError(`commerce-${source.field}`, error.message || '未能读取银行卡，请重试');
      return false;
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
      ...(order.product === 'GPT' && order.payment === '银行卡' && order.paidConfirmed && !order.cardId
        ? { pending: true } : {}),
      applied:
        cardPoolProduct(order.product) &&
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
    if (!orderIdentity(order) && !optionalOrderEmail(order.product, order.businessType)) reasons.push('账号待补充');
    if (!amountValid(order.saleAmount || '')) reasons.push('售卖金额待补充');
    if (!amountValid(order.paidAmount || '') || !order.paidCurrency) reasons.push('代付金额或币种待核对');
    if (!order.start || !order.expiry) reasons.push('订阅周期待补充');
    if (!proMaterialMode(order) && !order.paymentId && !(order.product === 'GPT' && order.payment === '银行卡' && !order.cardId))
      reasons.push('支付资料待补充');
    if (proMaterialMode(order) === 'manual_card' &&
        (!order.proCardNumber || (canManageOrders() && !order.proCardSerial)))
      reasons.push('银行卡资料待补充');
    if (proMaterialMode(order) === 'people' && !hasProPeople(order)) reasons.push('人员资料待补充');

    return reasons;
  }
  function localAccounting(order, currency = costSettings.currency) {
    if (!finance) return { status: 'pending', reason: '汇率核算模块尚未接入' };
    const clock = Date.now(), minute = Math.floor(clock / 60_000);
    if (cardIssueContext?.minute !== minute)
      cardIssueContext = { minute, allocations: finance.buildCardIssueAllocations(orders, { clock }) };
    return finance.calculateOrder(order, {
      currency, clock, cardIssueAllocations: cardIssueContext.allocations,
      appleLedger: order.payment === '苹果内购' ? A.modules.appleBalance?.getOrderLedger?.(order.id) : undefined
    });
  }
  function pendingReasons(order, accounting) {
    const reasons = completenessReasons(order);
    if (personalProduct(order.product) && order.entitlementStatus !== 'active')
      reasons.push(order.entitlementStatus === 'failed' ? '开通失败' : '权益待核对');
    if (!order.receiptConfirmed) reasons.push('实收待确认');
    if (!order.paidConfirmed) reasons.push('代付结果待确认');
    if (!order.costConfirmed) reasons.push('成本口径待确认');
    if (!localData && order.issueFeeSnapshot?.pending) reasons.push('首次开卡费待核对');
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
  function hasOpeningEvidence(order, start, expiry, at) {
    if (personalProduct(order.product)) return order.entitlementStatus === 'active' && expiry > start && start <= at;
    if (!automaticOrder(order)) return paymentStatus(order) === '已付款';
    const completed = parseDate(order.rechargeCompletedAt);
    return Number.isFinite(completed) && completed <= at &&
      (!Number.isFinite(start) || completed >= start) &&
      (!Number.isFinite(expiry) || completed < expiry);
  }
  const orderEvaluationTime = () => localData ? Date.now() : parseDate(now());
  function subscriptionStatus(order) {
    if (order.subscriptionEnded) return '已终止';
    if (personalProduct(order.product) && order.entitlementStatus !== 'active')
      return labelOf(openingChoices, order.entitlementStatus);
    if (!order.expiry || !order.start) return '待确认';
    const start = parseDate(order.start), expiry = parseDate(order.expiry), at = orderEvaluationTime();
    if (automaticOrder(order) && (!(expiry > start) || !hasOpeningEvidence(order, start, expiry, at))) return '待确认';
    if (start > at) return '未开始';
    return expiry > at ? '有效' : '已过期';
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
    if (personalProduct(order.product)) {
      const summary = order.accountId && A.modules.inventory?.accountSummary?.(order.accountId);
      return summary?.label || labelOf(openingChoices, order.entitlementStatus);
    }
    if (isClaude(order) && !claudeAccountTracked(order)) return '—';
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
  function optionalOrderEmail(product, businessType, renewalId) {
    return !renewalId && businessType === '续费' && ['GPT', 'Claude Pro', 'Claude Max'].includes(product);
  }
  function claudeAccountTracked(order) {
    return isClaude(order) && Boolean(subscriptionEmail(order));
  }
  function isProBankOrder(order) {
    return order?.product === 'Claude Pro' && order.payment === '银行卡';
  }
  const proMaterialLabels = {
    manual_card: '银行卡资料', pool_card: 'GPT 订阅卡池', tenant_card: '认证人银行卡',
    people: 'Claude 人员与补充资料', none: '暂不登记银行卡资料'
  };
  function showProPeople(mode) {
    return !mode || mode === 'people' || mode === 'tenant_card';
  }
  function proMaterialMode(order) {
    return isProBankOrder(order) && Object.hasOwn(proMaterialLabels, order.proMaterialMode)
      ? order.proMaterialMode : '';
  }
  function hasProPeople(order) {
    return Boolean(order.tenantId || order.phone);
  }
  function proMaterialLabel(order) {
    const mode = proMaterialMode(order);
    return mode ? proMaterialLabels[mode] : isProBankOrder(order) ? '原订单资料' : '不适用';
  }
  function proPaymentSourceLocked(order) {
    return isProBankOrder(order) && hasPaymentHistory(order) &&
      Boolean(order.cardId || proMaterialMode(order) === 'manual_card');
  }
  function pruneProMaterialFields(order) {
    const mode = proMaterialMode(order);
    if (!mode) delete order.proMaterialMode;
    if (mode !== 'manual_card') {
      delete order.proCardNumber;
      delete order.proCardSerial;
    }
  }
  function availableStock(product, currentOrderId = '') {
    const available = A.modules.inventory?.listDeliverableAccounts?.(product) ||
      A.modules.inventory?.listAvailableAccounts?.(product) || [];
    return personalProduct(product) ? available.filter(account => !orders.some(order =>
      order.id !== currentOrderId && order.accountId === account.id && !order.cancelled &&
      order.businessType === '成品交付' && order.entitlementStatus !== 'active')) : available;
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
      (personalProduct(order.product) ? row.customerId === order.customerId && sameSubscriptionAccount(row, order)
        : order.email && row.email?.toLowerCase() === order.email.toLowerCase()) && row.appleIdId &&
      row.payment === '苹果内购' && row.paidConfirmed && !row.cancelled)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)))[0];
  }
  function appleEligible(wallet, order) {
    if (localData && (wallet.status !== '正常' || (wallet.health && wallet.health !== 'normal'))) return false;
    if (wallet.currency !== 'USD' || !amountValid(wallet.balance || '') ||
        (amountValid(order.paidAmount || '') && M.compare(wallet.balance, order.paidAmount) < 0)) return false;
    if (order.businessType === '续费') {
      const previous = previousAppleOrder(order);
      if (previous || !personalProduct(order.product)) return previous?.appleIdId === wallet.id;
    }
    if (personalProduct(order.product)) return !orders.some(row =>
      row.id !== order.id && row.appleIdId === wallet.id && row.paidConfirmed) &&
      !A.modules.appleBalance?.entries?.(wallet.id).some(row => row.orderId);
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
        select.parentElement.dataset.selected = '';
        const selected = select.value || (selectionRendered ? '' : previousSelection);
        select.innerHTML = A.options(appleOptions(selected, orderFromForm(form)), selected);
        refreshAppleOptions(form);
      },
      () => appleForms.delete(form)
    );
  }
  function refreshAppleOptions(form) {
    const select = form.elements['commerce-appleIdId'];
    if (!select || form.elements['commerce-payment']?.value !== '苹果内购') return;
    const order = orderFromForm(form);
    const original = personalProduct(order.product) && order.businessType === '续费' && !order.id ? previousAppleOrder(order) : null;
    const selected = original?.appleIdId || select.value;
    select.innerHTML = A.options(appleOptions(selected, order), selected);
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
    return order.payment === '银行卡' && order.paidConfirmed &&
      (order.cardId || proMaterialMode(order)) && !order.cancelled
      ? M.subtract(order.paidAmount || '0', bankReturned(order))
      : '0';
  }
  function bankReturnSource(order) {
    const mode = proMaterialMode(order);
    if (mode === 'manual_card') return `尾号 ${order.paymentId || String(order.proCardNumber || '').slice(-4)} · 卡序列号 ${order.proCardSerial || '未记录'}`;
    if (mode === 'people') return proMaterialLabels.people;
    return `${cardLabel(order.cardId)} · ${order.paymentId}`;
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
        claudeAccountTracked(row) &&
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
    if (personalProduct(order.product)) return order.product + ':' + personalSeries(order.product, order.plan);
    return isClaude(order) ? 'Claude' : order.product;
  }
  function subscriptionEmail(order) {
    return orderIdentity(order).trim().toLowerCase();
  }
  function sameSubscriptionAccount(a, b, requireFamily = true) {
    return Boolean(subscriptionEmail(a)) && subscriptionEmail(a) === subscriptionEmail(b) &&
      (requireFamily ? subscriptionFamily(a) === subscriptionFamily(b) : a.product === b.product) &&
      (!personalProduct(a.product) || !a.platformAccountId || !b.platformAccountId || a.platformAccountId === b.platformAccountId);
  }
  function orderCustomerContacts(knownCustomers) {
    const byContact = new Map();
    const index = (keys, id) => {
      for (const key of keys) {
        if (!byContact.has(key)) byContact.set(key, new Set());
        byContact.get(key).add(id);
      }
    };
    for (const row of customers) index(orderContactKeys(row, false), row.id);
    for (const row of orders)
      if (row.customerId && (!knownCustomers || knownCustomers.has(row.customerId)))
        index(orderContactKeys(row), row.customerId);
    return byContact;
  }
  function customersMatchingContacts(order, byContact) {
    return new Set(orderContactKeys(order).flatMap(key => [...(byContact.get(key) || [])]));
  }
  function identifyOrderCustomers() {
    const byContact = orderCustomerContacts();

    const identities = new Map(), anonymous = new Map();
    for (const row of orders) {
      if (row.customerId) {
        identities.set(row.id, row.customerId);
        continue;
      }
      const keys = orderContactKeys(row);
      const matches = customersMatchingContacts(row, byContact);
      if (matches.size === 1) {
        identities.set(row.id, [...matches][0]);
      } else if (!matches.size && keys.length) {
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
    return identities;
  }
  function renewalProjection() {
    const identities = identifyOrderCustomers();
    const evaluatedAt = orderEvaluationTime();
    const deadline = evaluatedAt + renewalWarningHours * 3_600_000;
    const rows = orders.flatMap((order) => {
      if (isClaude(order) && !claudeAccountTracked(order)) return [];
      const start = parseDate(order.start), expiry = parseDate(order.expiry);
      if (!Object.hasOwn(productPlans, order.product) || !Number.isFinite(start) || !(expiry > start) ||
          !hasOpeningEvidence(order, start, expiry, evaluatedAt)) return [];
      const identity = identities.get(order.id);
      const subscription = renewalSubscriptionKey(order, identity);
      return [{ order, identity, subscription, start, expiry }];
    });
    const latest = new Map();
    for (const row of rows) {
      if (row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order)) continue;
      const prior = latest.get(row.subscription);
      if (!prior || row.expiry > prior.expiry || (row.expiry === prior.expiry && row.start > prior.start))
        latest.set(row.subscription, row);
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
    return { reminders, rows, identities, evaluatedAt, deadline };
  }
  function renewalSubscriptionKey(order, identity) {
    const email = subscriptionEmail(order);
    return identity && email ? JSON.stringify([identity, subscriptionFamily(order), email]) : order.id;
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
    const products = [['', '全部产品'], ...Object.keys(productPlans)];
    const rows = reminders.filter(({ order, state }) =>
      state === moduleState.renewalTab && (!S.status || order.product === S.status)
    ).map((row) => ({ ...row.order, ...row, ...customerForOrder(row.order, row.identity) }))
      .filter((row) => matchesRenewalSearch(row, row.order))
      .sort((left, right) => left.expiry - right.expiry);
    const columns = [
      ...renewalContactColumns(),
      { id: 'product', label: '产品' },
      { id: 'plan', label: '套餐' },
      { id: 'email', label: '账号', render: row => E(orderIdentity(row.order)) },
      { id: 'orderNo', label: '订单编号' },
      { id: 'due', label: '到期时间', render: (row) => E(dateInput(row.order.expiry).replace('T', ' ')) },
      ...(moduleState.renewalTab === 'processed' ? [
        { id: 'result', label: '处理结果', render: (row) => A.tag(row.refused ? '已拒续' : '已续费') },
        { id: 'processedBy', label: '操作人', render: (row) => E(row.refused ? row.decision.actor : traceName(row.completed, 'createdBy')) },
        { id: 'processedAt', label: '处理时间', render: (row) => E(row.refused ? row.decision.at : row.completed.createdAt || '历史未记录') }
      ] : []),
      { id: 'actions', label: '操作', action: true, render: (row) =>
        `<div class="action-links">${A.textAction('订单', 'commerce-order-detail', `data-id="${E(row.id)}"`)}${
          row.order.payment === '银行卡' && canManageOrders()
            ? A.textAction('银行卡', 'commerce-renewal-card-open', `data-id="${E(row.id)}"`) : ''}${
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
      ${tableList(columns, rows, 'commerce-renewals')}</section>`;
  }
  function matchesRenewalSearch(contact, order) {
    const query = String(S.query || '').trim().toLowerCase();
    return !query || [contact.name, ...orderContactFields.map(([key]) => contact[key]),
      orderIdentity(order), order.orderNo, order.product, order.plan].join(' ').toLowerCase().includes(query);
  }
  const renewalCardDrawers = new WeakMap();
  function renewalCardDrawerCurrent(panel) {
    const binding = renewalCardDrawers.get(panel);
    return Boolean(binding && S.route === renewalRoute && panel.isConnected && panel.closest('dialog')?.open &&
      binding.actorId === currentOperator().id && canManageOrders());
  }
  function renewalCardActionCurrent(panel, node) {
    return node.isConnected && renewalCardDrawerCurrent(panel) &&
      $('[data-renewal-card-region]', panel).getAttribute('aria-busy') !== 'true';
  }
  function renewalCardCanRenew(id) {
    const reminder = renewalProjection().reminders.find(row => row.order.id === id);
    return reminder?.state === 'upcoming' || reminder?.state === 'expired';
  }
  function clearRenewalCardNumbers(root) {
    if (!root) return;
    for (const input of root.querySelectorAll('[data-renewal-card-number]')) {
      input.value = '';
      input.closest('[data-renewal-card-full]').hidden = true;
    }
    for (const button of root.querySelectorAll('[data-action="commerce-renewal-card-reveal"]')) {
      button.textContent = '显示完整卡号';
      button.setAttribute('aria-expanded', 'false');
    }
  }
  function renewalCardAmount(amount, currency, fallback) {
    return amount !== null && amount !== undefined && amount !== '' && currency ? `${amount} ${currency}` : fallback;
  }
  function renderRenewalCardOrder(detail, kind, actionable) {
    const original = kind === 'order';
    const preparing = original && actionable;
    const order = orders.find(row => row.id === detail.id);
    const account = detail.account || {};
    const card = detail.card || {};
    const estimate = card.estimate;
    const paid = Object.hasOwn(card, 'paid') ? card.paid : estimate;
    const balance = card.balance;
    const bank = detail.payment === '银行卡';
    const funding = renewalCardAmount(estimate?.usd, 'USD', '待核算');
    const last4 = /^\d{4}$/.test(card.last4) ? card.last4 : '';
    const accountItems = [
      ['订单编号', detail.orderNo], ['订阅账号', account.email], ['账号来源', account.source], ['账号状态', account.status],
      ['产品 / 套餐', [order?.product, order?.plan].filter(Boolean).join(' / ')], ['付款方式', detail.payment],
      ['订阅时间', order?.start], ['到期时间', order?.expiry]
    ];
    const cardItems = [
      ['银行卡来源', card.source], ['银行卡类型', card.typeName],
      ['银行卡尾号', last4 ? `•••• ${last4}` : '未登记'], ['用卡状态', card.status],
      ['实际代付', renewalCardAmount(paid?.amount, paid?.currency, '待核对')],
      ...(!preparing ? [['备款参考金额', funding]] : []),
      [balance ? '最近同步余额' : '卡余额', renewalCardAmount(balance?.amount, balance?.currency, '暂无余额记录')],
      ...(balance?.updatedAt ? [['余额记录时间', dateInput(balance.updatedAt).replace('T', ' ')]] : [])
    ];
    const attrs = `data-id="${E(detail.id)}"`;
    const numberId = `commerce-renewal-card-number-${kind}`;
    return `<section class="form-section" data-renewal-card-kind="${kind}" data-renewal-card-last4="${last4}">
      <div class="section-heading section-heading--actions"><h3>${original ? '原单' : '续费单'}</h3>
        ${account.email ? A.button('复制账号', 'commerce-renewal-card-copy-account', '', 'copy') : ''}</div>
      <div class="property-list">${accountItems.map(([label, value]) => property(label, value)).join('')}</div>
      <div class="section-title-row"><h4>${preparing ? '续费用卡' : original ? '原单用卡' : '新单用卡'}</h4></div>
      ${bank ? (preparing ? `<div class="commerce-cost-strip"><span>预计续费需备款 <strong>${E(funding)}</strong></span></div>` : '') +
        `<div class="property-list">${cardItems.map(([label, value]) => property(label, value)).join('')}</div>` +
        (card.canReveal ? `<div class="drawer-action-bar">
          ${A.button('显示完整卡号', 'commerce-renewal-card-reveal', '', '',
            `${attrs} aria-expanded="false" aria-controls="${numberId}-field"`)}
          ${A.button('复制银行卡资料', 'commerce-copy-subscription-card', '', 'copy', attrs)}
          </div><div id="${numberId}-field" data-renewal-card-full hidden>${A.field('完整银行卡号', numberId,
            A.input(numberId, '', 'readonly autocomplete="off" data-no-draft data-renewal-card-number'))}</div>` : '') :
        '<p class="footnote">此单使用其他付款方式。</p>'}
    </section>`;
  }
  async function loadRenewalCardDetails(panel) {
    if (!renewalCardDrawerCurrent(panel)) return;
    const binding = renewalCardDrawers.get(panel);
    const region = $('[data-renewal-card-region]', panel);
    const status = $('[data-renewal-card-status]', panel);
    const content = $('[data-renewal-card-content]', panel);
    const error = $('[data-renewal-card-error]', panel);
    const refresh = $('[data-action="commerce-renewal-card-refresh"]', panel);
    const renew = $('[data-renewal-card-renew]', panel.closest('dialog'));
    const renewStatus = $('[data-renewal-card-renew-status]', panel);
    if (renew) renew.disabled = true;
    renewStatus.hidden = true;
    clearRenewalCardNumbers(content);
    error.hidden = true;
    const read = A.beginRegionRead(region, status, { loadingText: '正在读取银行卡资料…', refreshButton: refresh });
    const current = () => read.current() && renewalCardDrawerCurrent(panel);
    for (const button of content.querySelectorAll('button')) button.disabled = true;
    try {
      const data = await localData.subscriptionCardDetails({ orderId: binding.orderId,
        ...(binding.renewalOrderId ? { renewalOrderId: binding.renewalOrderId } : {}) });
      if (!current()) return;
      if (data?.order?.id !== binding.orderId || (data.renewal && data.renewal.id !== binding.renewalOrderId))
        throw new Error('银行卡资料与当前订单不符');
      clearRenewalCardNumbers(content);
      const actionable = Boolean(renew && data.order.account?.canRenew !== false && renewalCardCanRenew(binding.orderId));
      binding.details = data;
      if (renew) {
        renew.disabled = !actionable;
        renewStatus.hidden = actionable;
      }
      content.innerHTML = renderRenewalCardOrder(data.order, 'order', actionable) + (data.renewal
        ? renderRenewalCardOrder(data.renewal, 'renewal', false) : binding.renewalOrderId
          ? `<p class="footnote">${E(data.renewalStatus || '暂未读取到续费单资料，请刷新后重试。')}</p>` : '');
      return true;
    } catch (failure) {
      if (!current()) return;
      if ([401, 403].includes(failure?.status)) {
        content.replaceChildren();
        binding.details = undefined;
      }
      error.textContent = content.childElementCount ? '银行卡资料暂未更新，已保留上次的摘要。请刷新重试。' :
        '无法读取银行卡资料，请刷新重试。';
      error.hidden = false;
      return false;
    } finally {
      if (current()) for (const button of content.querySelectorAll('button')) button.disabled = false;
      read.finish();
    }
  }
  function openRenewalCardDrawer(id) {
    if (S.route !== renewalRoute || !canManageOrders()) return;
    const reminder = renewalProjection().reminders.find(row => row.order.id === id);
    if (reminder?.order.payment !== '银行卡') return;
    const { order, identity, completed, refused } = reminder;
    const contact = customerForOrder(order, identity);
    const linkedCustomer = order.customerId && customers.some(customer => customer.id === order.customerId);
    const contacts = [['客户姓名', contact.name], ...orderContactFields.map(([key, field]) =>
      [customerChannels.find(([name]) => name === field)[1], contact[key]])];
    A.openDrawer('续费银行卡资料', '', `<div id="commerce-renewal-card-panel">
      <section class="form-section">
        <div class="section-heading section-heading--actions"><h3>客户资料</h3>
          ${A.button('刷新', 'commerce-renewal-card-refresh')}</div>
        ${linkedCustomer ? '' : '<p class="footnote">客户关联待核对。以下联系方式来自历史订单或已匹配资料。</p>'}
        <div class="property-list">${contacts.map(([label, value]) => property(label, value)).join('')}</div>
      </section>
      <div class="design-async-region" data-renewal-card-region>
        <div role="status" data-renewal-card-status hidden></div>
        <p class="inline-notice warning" role="status" data-renewal-card-error hidden></p>
        <div data-renewal-card-content></div>
        <p class="footnote" data-renewal-card-renew-status hidden>原单账号或提醒状态暂不支持续费。</p>
      </div>
    </div>`, A.button('关闭', 'drawer-close') + (completed || refused ? '' :
      A.button('续费', 'commerce-renewal-open', 'primary', '', `data-id="${E(id)}" data-renewal-card-renew disabled`)),
    `renewal-bank-card:${id}`);
    const panel = $('#commerce-renewal-card-panel');
    renewalCardDrawers.set(panel, { orderId: id, renewalOrderId: completed?.id, actorId: currentOperator().id });
    const drawer = panel.closest('dialog');
    const cleanup = new AbortController();
    const dispose = () => {
      clearRenewalCardNumbers(panel);
      A.finishRegionRead($('[data-renewal-card-region]', panel));
      renewalCardDrawers.delete(panel);
      cleanup.abort();
    };
    drawer.addEventListener('id-view-deactivate', dispose, { signal: cleanup.signal });
    drawer.addEventListener('close', () => { if (!drawer.open) dispose(); }, { signal: cleanup.signal });
    void loadRenewalCardDetails(panel);
  }
  async function revealRenewalCard(node) {
    const panel = node.closest('#commerce-renewal-card-panel');
    const section = node.closest('[data-renewal-card-kind]');
    const current = () => renewalCardActionCurrent(panel, node);
    if (!current() || !section) return;
    const input = $('[data-renewal-card-number]', section);
    if (!input) return;
    if (input.value) return clearRenewalCardNumbers(section);
    const binding = renewalCardDrawers.get(panel);
    const id = node.dataset.id;
    const detail = binding.details?.[section.dataset.renewalCardKind];
    if (id !== detail?.id || !detail.card?.canReveal) return;
    await A.withActionFeedback(node, async () => {
      let result;
      try { result = await localData.revealSubscriptionCard(id, detail.version); }
      catch (failure) { if (current()) throw failure; return; }
      if (!current()) return;
      const last4 = section.dataset.renewalCardLast4;
      if (!/^\d{12,19}$/.test(result?.number) || (last4 && !result.number.endsWith(last4)))
        throw new Error('完整卡号无法核对，请刷新后重试');
      input.value = result.number;
      input.closest('[data-renewal-card-full]').hidden = false;
      node.textContent = '隐藏完整卡号';
      node.setAttribute('aria-expanded', 'true');
    }, { pending: '正在读取完整卡号…', failure: '无法读取完整卡号，请重试' });
  }
  function copyRenewalCardAccount(node) {
    const panel = node.closest('#commerce-renewal-card-panel');
    const current = () => renewalCardActionCurrent(panel, node);
    if (!current()) return;
    const kind = node.closest('[data-renewal-card-kind]')?.dataset.renewalCardKind;
    const email = renewalCardDrawers.get(panel).details?.[kind]?.account?.email;
    if (email) void A.copyText(email, '订阅账号已复制', { current });
  }
  const subscriptionCardStates = [
    ['active', '使用中'], ['upcoming', '即将到期'], ['expired', '已过期'],
    ['pending', '待确认'], ['replaced', '历史用卡']
  ];
  const subscriptionCardFilters = { state: '', type: '', plan: '', purpose: '' };
  const stableSubscriptionCard = id => typeof id === 'string' &&
    /^(?:recharge:[1-9]\d*|tenant:[a-zA-Z0-9-]{1,120}|orbitcard:[1-9]\d*)$/.test(id);
  function subscriptionCardReference(order) {
    if (order.payment !== '银行卡') return '';
    if (stableSubscriptionCard(order.cardId)) return order.cardId;
    const refs = [...new Set((order.financialEvidence || []).filter(row =>
      row.kind === 'payment' && row.payment === '银行卡' && stableSubscriptionCard(row.cardId)).map(row => row.cardId))];
    return refs.length === 1 ? refs[0] : '';
  }
  function subscriptionCardRows() {
    const { rows, identities, evaluatedAt, deadline } = renewalProjection();
    const periods = new Map(rows.map(row => [row.order.id, row]));
    const latest = new Map();
    const later = (a, b) => a.expiry > b.expiry || (a.expiry === b.expiry && a.start > b.start);
    for (const row of rows) {
      if (row.start > evaluatedAt || row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order)) continue;
      const prior = latest.get(row.subscription);
      if (!prior || later(row, prior)) latest.set(row.subscription, row);
    }
    const bindings = new Map();
    for (const order of orders) {
      const cardId = subscriptionCardReference(order);
      if (!cardId) continue;
      const identity = identities.get(order.id);
      const period = periods.get(order.id);
      const subscription = period?.subscription ?? renewalSubscriptionKey(order, identity);
      const start = parseDate(order.start), expiry = parseDate(order.expiry);
      const key = JSON.stringify([cardId, subscription]);
      const history = bindings.get(key) || [];
      history.push({ order, identity, subscription, cardId, start, expiry, period });
      bindings.set(key, history);
    }
    return [...bindings.values()].map(history => {
      history.sort((a, b) => (b.expiry || 0) - (a.expiry || 0) || (b.start || 0) - (a.start || 0));
      const current = latest.get(history[0].subscription);
      const matching = history.find(row => row.order.id === current?.order.id);
      const row = matching || history.find(row => row.period && row.start <= evaluatedAt) || history[0];
      const state = matching ? row.expiry <= evaluatedAt ? 'expired' : row.expiry <= deadline ? 'upcoming' : 'active'
        : row.order.cancelled || row.order.subscriptionEnded || endedInventoryOrder(row.order) ||
          (row.period && row.start <= evaluatedAt && current) ? 'replaced' : 'pending';
      const snapshot = bankCardTypes.items.find(type => type.id === bankCardTypes.assignments[row.cardId]);
      const typeId = (snapshot?.active && snapshot.id) || row.order.cardTypeId || snapshot?.id || '';
      const typeName = (snapshot?.active && snapshot.name) || row.order.cardTypeName || snapshot?.name || '未设置';
      return { ...row, id: row.order.id, history, state, typeId, typeName, ...customerForOrder(row.order, row.identity), evaluatedAt,
        source: row.cardId.startsWith('tenant:') ? '认证人银行卡' :
          row.cardId.startsWith('recharge:') ? '充值卡池' : '线上代充用卡',
        tail: /^\d{4}$/.test(row.order.paymentId) ? row.order.paymentId : '',
        plan: [row.order.product, row.order.plan].filter(Boolean).join(' ') };
    });
  }
  let subscriptionEstimates = new Map();
  let subscriptionEstimateRequest, subscriptionEstimateKey, subscriptionEstimateError;
  function loadSubscriptionCardEstimates(force = false) {
    if (!localData?.subscriptionCardEstimates || S.route !== subscriptionCardsRoute) return;
    const actorId = currentOperator().id;
    const key = [actorId, localVersion, Math.floor(Date.now() / 60_000)].join(':');
    if (subscriptionEstimateRequest)
      return force ? subscriptionEstimateRequest.then(() => loadSubscriptionCardEstimates(true)) : subscriptionEstimateRequest;
    if (!force && subscriptionEstimateKey === key) return;
    subscriptionEstimateKey = key;
    subscriptionEstimateError = '';
    subscriptionEstimateRequest = Promise.allSettled([
      localData.subscriptionCardEstimates(), readBankCardTypes(force)
    ]).then(([estimate, types]) => {
      if (actorId !== currentOperator().id) return;
      const ready = estimate.status === 'fulfilled' && Array.isArray(estimate.value.items);
      if (ready) subscriptionEstimates = new Map(estimate.value.items.map(row => [row.id, row]));
      else subscriptionEstimates = new Map();
      if (!ready || types.status === 'rejected')
        subscriptionEstimateError = '部分银行卡类型或预计金额暂时无法读取';
      return !subscriptionEstimateError;
    }).finally(() => {
      subscriptionEstimateRequest = undefined;
      if (S.route === subscriptionCardsRoute) A.render();
    });
    return subscriptionEstimateRequest;
  }
  function estimateForBankOrder(order) {
    const estimate = subscriptionEstimates.get(order.id);
    if (estimate?.version !== order.version || (estimate?.expiresAt && Date.parse(estimate.expiresAt) <= Date.now())) return null;
    return estimate;
  }
  function subscriptionCardDuration(row) {
    if (row.state === 'pending' || row.state === 'replaced') return '—';
    const elapsed = row.expiry <= row.evaluatedAt;
    const hours = Math.floor(Math.abs(row.expiry - row.evaluatedAt) / 3_600_000);
    return `${elapsed ? '已过期 ' : '剩余 '}${formatRenewalWarning(hours) || '不足 1 小时'}`;
  }
  function renderSubscriptionCards() {
    const all = subscriptionCardRows();
    const typeOptions = new Map(all.filter(row => row.typeId).map(row => [row.typeId, row.typeName]));
    const plans = [...new Set(all.map(row => row.plan).filter(Boolean))];
    const query = String(S.query || '').trim().toLowerCase();
    const rows = all.filter(row =>
      (!subscriptionCardFilters.state || row.state === subscriptionCardFilters.state) &&
      (!subscriptionCardFilters.type || row.typeId === subscriptionCardFilters.type) &&
      (!subscriptionCardFilters.plan || row.plan === subscriptionCardFilters.plan) &&
      (!subscriptionCardFilters.purpose || row.order.businessType === subscriptionCardFilters.purpose) &&
      (!query || [row.name, row.tail, row.order.email, row.order.orderNo, row.typeName, row.plan,
        ...orderContactFields.map(([key]) => row[key])].some(value => String(value || '').toLowerCase().includes(query))))
      .sort((a, b) => (a.expiry || Infinity) - (b.expiry || Infinity));
    const filters = [
      ['state', '使用状态', [['', '全部状态'], ...subscriptionCardStates]],
      ['purpose', '业务类型', [['', '全部业务'], '续费', '成品交付']],
      ['type', '银行卡类型', [['', '全部卡类型'], ...typeOptions]],
      ['plan', '订阅套餐', [['', '全部套餐'], ...plans]]
    ].map(([key, label, choices]) => select('subscription-card-' + key, choices, subscriptionCardFilters[key],
      `aria-label="${label}"`)).join('');
    const columns = [
      { id: 'name', label: '客户姓名' },
      { id: 'contact', label: '联系方式', render: row => E(orderContactFields.map(([key]) => row[key]).filter(Boolean).join(' · ') || '待补充') },
      { id: 'email', label: '订阅账号', render: row => E(row.order.email || '待补充') },
      { id: 'source', label: '银行卡来源' },
      { id: 'typeName', label: '银行卡类型' },
      { id: 'tail', label: '银行卡号', render: row => E(row.tail ? '•••• ' + row.tail : '历史未登记尾号') },
      { id: 'plan', label: '订阅套餐' },
      { id: 'state', label: '使用状态', render: row => A.tag(subscriptionCardStates.find(([id]) => id === row.state)?.[1]) },
      { id: 'expiry', label: '到期时间', render: row => E(dateInput(row.order.expiry).replace('T', ' ') || '待确认') },
      { id: 'duration', label: '到期时长', render: row => E(subscriptionCardDuration(row)) },
      { id: 'funding', label: '预计金额',
        headerHelp: '预计金额 = 原订单代付金额（折合美元） + 通用付款固定费用 + 2 美元备用金。' +
          '非美元金额按当前有效国际汇率换算，合计向上取整到美分。缺少可核算的代付金额或所需汇率时显示「待核算」。',
        render: row => {
          const usd = estimateForBankOrder(row.order)?.usd;
          return E(usd ? usd + ' USD' : '待核算');
        }
      },
      { id: 'actions', label: '操作', action: true, render: row => {
        const id = `data-id="${E(row.order.id)}"`;
        return `<div class="action-links">${A.textAction('复制', 'commerce-copy-subscription-card', id)}${
          A.textAction('修改', 'commerce-subscription-card-edit', id)}${
          A.textAction('详情', 'commerce-subscription-card-detail', id)}</div>`;
      } }
    ];
    return A.header('银行卡管理', '按订单的用卡记录管理订阅。预计金额用于准备续费余额，卡号可通过复制操作读取。',
      A.button('提醒设置', 'commerce-renewal-settings', '', 'settings') +
      columnSettingsButton('commerce-subscription-cards')) + `<section class="panel">${toolbar(
      '搜索客户、联系方式、账号、订单或卡号尾四位', filters)}${
      subscriptionEstimateError ? `<p class="footnote" role="status">${E(subscriptionEstimateError)} ${
        A.textAction('重试', 'commerce-subscription-card-refresh')}</p>` :
        localData?.subscriptionCardEstimates && (!subscriptionEstimateKey || subscriptionEstimateRequest)
          ? '<p class="footnote" role="status">正在核对预计金额…</p>' : ''}${
      tableList(columns, rows, 'commerce-subscription-cards')}</section>`;
  }
  function showSubscriptionCardHistory(id) {
    const row = subscriptionCardRows().find(item => item.order.id === id);
    if (!row) return;
    const estimate = estimateForBankOrder(row.order);
    const cost = estimate?.usd ? `${estimate.usd} USD` : '待核算';
    const amount = estimate?.amount && estimate.currency ? `${estimate.amount} ${estimate.currency}` : '待核对';
    const quote = estimate?.quotedAt ? `${estimate.source} · ${dateInput(estimate.quotedAt).replace('T', ' ')}`
      : estimate?.currency === 'USD' ? '原代付为美元' : '暂无有效报价';
    const rates = estimate?.originalRateToCny && estimate?.usdRateToCny
      ? `1 ${estimate.currency} = ${estimate.originalRateToCny} CNY · 1 USD = ${estimate.usdRateToCny} CNY` : '';
    const columns = [
      { id: 'orderNo', label: '订单编号' }, { id: 'businessType', label: '业务类型' },
      { id: 'plan', label: '订阅套餐' }, { id: 'start', label: '订阅时间' }, { id: 'expiry', label: '到期时间' },
      { id: 'paid', label: '付款状态', render: order => A.tag(paymentStatus(order)) },
      { id: 'actions', label: '操作', action: true, render: order =>
        A.textAction('查看订单', 'commerce-order-detail', `data-id="${E(order.id)}"`) }
    ];
    const details = [
      ['客户姓名', row.name], ['订阅账号', row.order.email], ['银行卡来源', row.source],
      ['银行卡类型', row.typeName], ['银行卡号', row.tail ? '•••• ' + row.tail : '历史未登记尾号'],
      ['预计金额', cost], ['原单代付', amount], ['报价来源', quote],
      ...(rates ? [['国际汇率', rates]] : []),
      ['费用与预留', estimate ? `${estimate.fixedFee} USD + ${estimate.bufferUsd} USD` : '待核算']
    ].map(([label, value]) => property(label, value)).join('');
    A.openDrawer('银行卡详情', '', `<div class="property-list">${details}</div>${
      A.table(columns, row.history.map(item => item.order), '', 'commerce-subscription-card-history')}`,
    A.button('关闭', 'drawer-close') + A.button('复制银行卡资料', 'commerce-copy-subscription-card', '', 'copy',
      `data-id="${E(row.order.id)}"`));
  }
  function editSubscriptionCard(id, node) {
    const row = subscriptionCardRows().find(item => item.order.id === id);
    if (!row) return;
    const orderAttr = `data-id="${E(row.order.id)}"`;
    const customer = customers.find(item => item.id === (row.order.customerId || row.identity));
    A.openActionMenu(node, (!row.cardId.startsWith('orbitcard:') ?
      A.button('修改卡类型', 'commerce-subscription-card-type', '', '', orderAttr) : '') +
      (customer ? A.button('修改客户资料', 'commerce-contact-edit', '', '', `data-id="${E(customer.id)}" data-kind="customer"`) : '') +
      A.button('更正订单资料', 'commerce-order-edit', '', '', `${orderAttr} ${row.order.cancelled ? 'disabled' : ''}`));
  }
  let clearSubscriptionCardCopyFallback;
  async function copySubscriptionBankCard(orderId, node) {
    if (!canManageOrders() || !localData?.copySubscriptionCard) return;
    const order = orders.find(row => row.id === orderId);
    if (!order) return;
    const route = S.route, actorId = currentOperator().id, context = S.drawerContext;
    const panel = node.closest('#commerce-renewal-card-panel');
    const kind = node.closest('[data-renewal-card-kind]')?.dataset.renewalCardKind;
    const detail = renewalCardDrawers.get(panel)?.details?.[kind];
    const current = () => node.isConnected && route === S.route && actorId === currentOperator().id &&
      context === S.drawerContext && canManageOrders() && (!panel || renewalCardActionCurrent(panel, node));
    if (!current()) return;
    if (panel && (detail?.id !== orderId || !detail.card?.canReveal)) return;
    await A.withActionFeedback(node, async () => {
      let result;
      try {
        result = await localData.copySubscriptionCard(order.id, subscriptionCardReference(order) || undefined,
          panel ? { context: 'renewal', version: detail.version } : undefined);
      } catch (failure) { if (current()) throw failure; return; }
      if (!current() || await A.copyText(result.text, '银行卡资料已复制', { current })) return;
      const drawer = $('#drawer[open]');
      const fallback = drawer && $('textarea.copy-block', drawer);
      if (!fallback || fallback.value !== result.text) return;
      clearSubscriptionCardCopyFallback?.();
      const cleanup = new AbortController();
      clearSubscriptionCardCopyFallback = () => {
        fallback.value = '';
        fallback.textContent = '';
        cleanup.abort();
        clearSubscriptionCardCopyFallback = undefined;
      };
      drawer.addEventListener('id-view-deactivate', clearSubscriptionCardCopyFallback, { signal: cleanup.signal });
      drawer.addEventListener('close', () => { if (!drawer.open) clearSubscriptionCardCopyFallback?.(); },
        { signal: cleanup.signal });
    }, { pending: '正在读取银行卡…', failure: '银行卡资料复制失败，请重试' });
  }
  const retentionFiltersKey = 'customer-retention:filters';
  const retentionFilterDefaults = { plan: '', age: '', count: '', sort: 'recent' };
  const retentionPlans = { ...productPlans, GPT: ['Go', ...productPlans.GPT] };
  const retentionPlanKey = (product, plan = '') => JSON.stringify([product, plan]);
  const retentionDate = timestamp => Number.isFinite(timestamp) ? beijingClock.format(timestamp) : '—';
  const retentionDay = timestamp => Math.floor((timestamp + 8 * 3_600_000) / 86_400_000);
  const retentionTimeOrder = (a, b) => (b.start || 0) - (a.start || 0) ||
    String(a.order.id).localeCompare(String(b.order.id));
  let retentionRefresh, retentionRefreshFailed = false;

  function refreshCustomerRetention(node) {
    if (!localData || retentionRefresh) return;
    const region = node.closest('.retention-overview');
    const status = region.querySelector('[data-retention-progress]');
    const read = A.beginRegionRead(region, status, { refreshButton: node });
    retentionRefresh = Promise.allSettled([
      loadLocalCommerce(true, true), A.modules.inventory?.refreshLocalInventory?.({ keepContent: true })
    ]).then(results => {
      retentionRefreshFailed = results.some(result => result.status !== 'fulfilled' || !result.value);
      if (results.some(result => result.status === 'fulfilled' && result.value))
        localData.queries?.invalidate(['overview']);
    }).finally(() => {
      read.finish();
      retentionRefresh = undefined;
      if (S.route === customerLossRoute) A.render();
    });
  }

  function retentionPlan(order) {
    const recorded = String(order.plan || '').trim();
    if (!recorded) return '';
    const value = order.product === 'GPT' || /^max(5|20)$/.test(recorded)
      ? normalizedPlan(recorded) : recorded;
    return retentionPlans[order.product].find(plan => plan.toLowerCase() === String(value).toLowerCase()) || '';
  }

  function retentionStockOrder(order) {
    return order.businessType === '成品交付' ||
      Boolean(order.accountId && !['客户自有', 'customer'].includes(order.accountSource));
  }

  function retentionInventoryEnd(order) {
    const inventory = A.modules.inventory;
    const summary = (order.accountId && inventory?.accountSummary?.(order.accountId)) ||
      inventory?.accountSummaryForEmail?.(order.email, order.product);
    const relation = summary?.orders?.find(row => row.id === order.id);
    if (localData && retentionStockOrder(order) &&
        (!inventory?.accountLifecycleReady?.() || !relation))
      return { issue: '库存使用关系待核对' };
    if (!relation?.released) return {};
    const times = (summary.events || [])
      .filter(event => ['release', 'retire'].includes(event.action) && event.orderIds?.includes(order.id))
      .map(event => parseDate(event.time)).filter(Number.isFinite);
    return times.length ? { end: Math.min(...times) } : { issue: '回收时间待核对' };
  }

  function retentionOrderFact(order, profiles, contacts, at) {
    const explicit = profiles.has(order.customerId) ? order.customerId : '';
    const candidates = explicit ? new Set([explicit]) : customersMatchingContacts(order, contacts);
    const customerId = explicit || (!order.customerId && candidates.size === 1 ? candidates.values().next().value : '');
    const start = parseDate(order.start), expiry = parseDate(order.expiry), plan = retentionPlan(order);
    const automatic = automaticOrder(order);
    const paid = paymentStatus(order);
    const evidence = hasOpeningEvidence(order, start, expiry, at);
    const hasSignal = evidence || automatic || paid === '付款待核对' || paid === '已付款';
    const periodValid = Number.isFinite(start) && expiry > start;
    const cancelled = order.cancelled || ['cancelled', '已撤单'].includes(order.status);
    const draft = order.draft || ['draft', 'failed', '草稿', '失败'].includes(order.status);
    const inventory = hasSignal && !cancelled && !draft ? retentionInventoryEnd(order) : {};
    const end = Math.min(expiry, inventory.end ?? Infinity);
    let stateIssue = '';
    if (hasSignal) {
      if (cancelled || draft) stateIssue = '订单状态与开通证据待核对';
      else if (!periodValid) stateIssue = '订阅周期缺失或无效';
      else if (!evidence) stateIssue = automatic ? '代充开通证据待核对' : '开通凭据待核对';
      else if (inventory.issue) stateIssue = inventory.issue;
      else if (order.subscriptionEnded) stateIssue = '实际终止时间待核对';
      else if (end <= start) stateIssue = '使用结束时间与开通时间冲突';
    }
    const reasons = [
      hasSignal && !customerId && (order.customerId ? '客户编号无对应资料'
        : candidates.size > 1 ? '联系方式匹配多个客户' : '客户归属待核对'),
      stateIssue,
      hasSignal && !plan && '套餐待核对'
    ].filter(Boolean);
    const confirmed = evidence && periodValid && !cancelled && !draft && end > start;
    const status = stateIssue ? '待核对' : !confirmed ? cancelled ? '已撤单' : '开通待确认'
      : start > at ? '待生效' : end > at ? '有效' : '已结束';
    return { order, customerId, candidates, start, expiry, end, plan, confirmed,
      status, reasons, blocksLoss: Boolean(stateIssue || hasSignal && !customerId) };
  }

  function customerRetentionProjection() {
    const at = orderEvaluationTime();
    const profiles = new Map(customers.map(customer => [customer.id, { id: customer.id, customer, history: [] }]));
    const contacts = orderCustomerContacts(profiles);
    const groups = new Map();
    for (const order of orders) {
      if (!order.id || !Object.hasOwn(retentionPlans, order.product)) continue;
      const key = automaticOrder(order) ? `任务:${order.taskId}` : `订单:${order.id}`;
      const rows = groups.get(key) || [];
      rows.push(order);
      groups.set(key, rows);
    }
    const review = new Map(), blocked = new Set();
    function record(fact) {
      if (fact.customerId) profiles.get(fact.customerId).history.push(fact);
      if (fact.reasons.length) review.set(fact.order.id, fact);
      if (fact.blocksLoss)
        for (const id of fact.candidates) blocked.add(id);
    }
    for (const group of groups.values()) {
      const facts = group.map(order => retentionOrderFact(order, profiles, contacts, at));
      const first = facts[0];
      const signature = fact => JSON.stringify([fact.customerId, fact.order.customerId || '',
        fact.order.product, fact.plan || fact.order.plan, subscriptionEmail(fact.order),
        fact.order.accountId || '', fact.start, fact.expiry, fact.end, fact.confirmed,
        fact.status, fact.reasons]);
      if (facts.some(fact => signature(fact) !== signature(first))) {
        const uniqueOrders = new Map(facts.map(fact => [fact.order.id, fact]));
        for (const fact of uniqueOrders.values()) record({
          ...fact, confirmed: false, status: '待核对', blocksLoss: true,
          candidates: new Set(facts.flatMap(row => [...row.candidates])),
          reasons: [...fact.reasons, '重复订单或代充任务资料冲突']
        });
      } else record(first);
    }
    const lost = [], scheduled = [];
    let active = 0;
    for (const profile of profiles.values()) {
      profile.history.sort(retentionTimeOrder);
      profile.confirmed = profile.history.filter(fact => fact.confirmed && fact.start <= at);
      profile.pending = profile.history.filter(fact => fact.status === '待生效');
      profile.activeCount = profile.confirmed.filter(fact => fact.status === '有效').length;
      profile.latest = profile.confirmed[0];
      profile.first = profile.confirmed.at(-1);
      profile.next = profile.pending.at(-1);
      profile.lastEnd = profile.confirmed.reduce((last, fact) =>
        fact.status === '已结束' ? Math.max(last, fact.end) : last, -Infinity);
      profile.days = Number.isFinite(profile.lastEnd) ? retentionDay(at) - retentionDay(profile.lastEnd) : null;
      const plans = new Map();
      for (const fact of profile.confirmed) {
        const key = retentionPlanKey(fact.order.product, fact.plan);
        const plan = plans.get(key) || { product: fact.order.product, plan: fact.plan, count: 0 };
        plan.count++;
        plans.set(key, plan);
      }
      profile.plans = [...plans.values()].sort((a, b) => b.count - a.count ||
        (a.product + a.plan).localeCompare(b.product + b.plan));
      if (profile.activeCount) active++;
      else if (profile.confirmed.length && !blocked.has(profile.id)) {
        if (profile.next) scheduled.push(profile);
        else if (profile.days !== null) lost.push(profile);
      }
    }
    return { at, profiles, lost, scheduled, review: [...review.values()], active };
  }

  function retentionPlanLabel(product, plan) {
    return `${product} · ${plan || '套餐待核对'}`;
  }
  function retentionPlanSummary(profile, limit = Infinity) {
    const labels = profile.plans.slice(0, limit).map(({ product, plan, count }) =>
      `${retentionPlanLabel(product, plan)} ${count} 次`);
    if (profile.plans.length > limit) labels.push(`另有 ${profile.plans.length - limit} 种`);
    return labels.join('、') || '—';
  }
  function retentionContact(customer) {
    const channel = customerChannels.find(([key]) => customer[key]);
    return channel ? `${channel[1].replace('客户', '')} ${customer[channel[0]]}` : '';
  }
  function retentionView() {
    return { ...retentionFilterDefaults, ...S.drafts.get(retentionFiltersKey) };
  }
  function retentionToolbar(view, tab) {
    const choices = [['', '全部产品'], ...Object.entries(retentionPlans).flatMap(([product, plans]) => [
      [retentionPlanKey(product), `${product} · 全部`],
      ...plans.map(plan => [retentionPlanKey(product, plan), retentionPlanLabel(product, plan)])
    ])];
    const filter = (name, label, values) =>
      select(`loss-${name}`, values, view[name], `aria-label="${label}"`);
    return toolbar('搜索客户、联系方式、历史账号或订单号',
      filter('plan', '产品和套餐', choices) + (tab ? '' :
        filter('age', '停用时长', [['', '全部停用时长'], ['recent', '近 7 天'], ['month', '7–29 天'], ['older', '30 天及以上']]) +
        filter('count', '订阅次数', [['', '全部订阅次数'], ['one', '1 次'], ['few', '2–3 次'], ['many', '4 次及以上']]) +
        filter('sort', '排序方式', [['recent', '最近停止优先'], ['count', '订阅次数优先']])));
  }
  function retentionRecordMatches(fact, key) {
    return !key || retentionPlanKey(fact.order.product) === key ||
      retentionPlanKey(fact.order.product, fact.plan) === key;
  }
  function retentionSearch(query, customer, history) {
    if (!query) return true;
    return [customer.name, ...customerChannels.map(([key]) => customer[key]), ...history.flatMap(({ order, plan }) =>
      [order.orderNo, orderIdentity(order), order.product, order.plan, plan, ...orderContactFields.map(([key]) => order[key])]
    )].join(' ').toLowerCase().includes(query);
  }
  function retentionReviewRows(projection, plan, query) {
    return projection.review
      .filter(fact => {
        const customer = projection.profiles.get(fact.customerId)?.customer ||
          { name: fact.order.customerName || fact.order.customer || '待确认客户' };
        return retentionRecordMatches(fact, plan) && retentionSearch(query, customer, [fact]);
      })
      .sort(retentionTimeOrder)
      .map(fact => ({
        id: fact.order.id,
        name: projection.profiles.get(fact.customerId)?.customer.name || fact.order.customerName ||
          fact.order.customer || '待确认客户',
        orderNo: fact.order.orderNo || '—',
        email: orderIdentity(fact.order) || '—',
        plans: retentionPlanLabel(fact.order.product, fact.plan),
        reason: fact.reasons.join('、')
      }));
  }
  function retentionCustomerRows(projection, view, tab, query) {
    const profiles = tab === 'scheduled' ? projection.scheduled : projection.lost;
    return profiles.filter(profile => {
      if (!retentionSearch(query, profile.customer, profile.history)) return false;
      if (![...profile.confirmed, ...profile.pending].some(fact => retentionRecordMatches(fact, view.plan)))
        return false;
      if (tab) return true;
      const countBand = profile.confirmed.length === 1 ? 'one' : profile.confirmed.length <= 3 ? 'few' : 'many';
      const ageBand = profile.days < 7 ? 'recent' : profile.days < 30 ? 'month' : 'older';
      return (!view.count || view.count === countBand) && (!view.age || view.age === ageBand);
    }).sort((a, b) => (tab ? a.next.start - b.next.start :
      (view.sort === 'count' ? b.confirmed.length - a.confirmed.length : 0) || b.lastEnd - a.lastEnd) ||
      String(a.customer.name || '').localeCompare(String(b.customer.name || '')))
      .map(profile => ({
        id: profile.id, name: profile.customer.name, contact: retentionContact(profile.customer),
        count: `${profile.confirmed.length} 次`, plans: retentionPlanSummary(profile, 2),
        latest: retentionDate(profile.latest.start).slice(0, 10),
        end: tab ? retentionDate(profile.next.start) : retentionDate(profile.lastEnd),
        days: profile.days === null ? '—' : `${profile.days} 天`
      }));
  }
  function renderCustomerLoss() {
    const projection = customerRetentionProjection();
    const tab = ['review', 'scheduled'].includes(S.status) ? S.status : '';
    const review = tab === 'review', scheduled = tab === 'scheduled';
    const view = retentionView(), query = String(S.query || '').trim().toLowerCase();
    const rows = review ? retentionReviewRows(projection, view.plan, query) :
      retentionCustomerRows(projection, view, tab, query);
    const action = review ? 'commerce-order-detail' : 'commerce-loss-history';
    const label = review ? '查看订单' : '订阅历史';
    const columns = [{ id: 'name', label: '客户' }, ...(review ? [
      { id: 'orderNo', label: '订单编号' }, { id: 'plans', label: '产品与套餐' },
      { id: 'email', label: '订阅账号' }, { id: 'reason', label: '待核对原因', long: true }
    ] : [
      { id: 'count', label: '确认订阅' }, { id: 'plans', label: '套餐分布' },
      { id: 'end', label: scheduled ? '预计生效' : '最后结束' },
      ...(!scheduled ? [{ id: 'days', label: '停用天数' }] : []),
      { id: 'latest', label: '最近开通' },
      { id: 'contact', label: '联系方式', long: true, render: row => E(row.contact || '—') }
    ]), {
      id: 'actions', label: '操作', action: true,
      render: row => A.textAction(label, action, `data-id="${E(row.id)}"${!review ? ' aria-haspopup="dialog"' : ''}`)
    }];
    const hasFilters = query || view.plan || !tab && (view.age || view.count);
    const guidance = hasFilters ? { title: '暂无符合条件的记录', description: '可调整搜索或筛选条件。' } :
      { title: review ? '暂无待核对订单' : scheduled ? '暂无待生效客户' : '暂无已确认流失客户',
        description: review ? '订阅归属或开通资料需要核对时，会显示在这里。' :
          '根据本系统已确认的订阅记录统计。' };
    const page = A.pageRows(rows);
    const cards = `<div class="customer-retention-mobile panel-body" data-pagination-rows tabindex="0" role="region" aria-label="客户记录">${page.length
      ? `<div class="guide-list">${page.map(row => `<article class="guide-item" data-retention-card="${E(row.id)}">
        <h3>${E(row.name)}</h3>
        <p>${E(review ? row.plans : `${row.count} · ${row.plans}`)}</p>
        <p>${E(review ? `${row.orderNo} · ${row.reason}` : scheduled ? `预计生效 ${row.end}` : `已停用 ${row.days} · ${row.end}`)}</p>
        ${!review && row.contact ? `<p>${E(row.contact)}</p>` : ''}
        <div class="retention-card-action">${A.button(label, action, '', '', `data-id="${E(row.id)}"`)}</div>
      </article>`).join('')}</div>`
      : A.empty(guidance.title, guidance.description)}</div>`;
    return A.header('客户流失', '按本系统已确认的订阅记录归集。同一客户仍有任何有效订阅时，不判为流失。待生效和待核对单独展示。') +
      `<section class="retention-overview design-async-region" aria-label="客户流失概览">${A.summary([
        ['已确认流失', projection.lost.length, '位客户', true],
        ['近 7 天停止服务', projection.lost.filter(profile => profile.days < 7).length, '位客户'],
        ['待核对订单', projection.review.length, '笔'],
        ['待生效', projection.scheduled.length, '位客户']
      ])}<div class="retention-report-meta"><p class="footnote">北京时间 ${E(retentionDate(projection.at))} · GPT、Claude Pro、Claude Max 及已同步的代充记录</p>
        ${localData ? A.button(retentionRefreshFailed ? '重试' : '刷新', 'commerce-loss-refresh', '', 'return', retentionRefresh ? 'disabled' : '') : ''}</div>
        <div data-retention-progress role="status" hidden></div>
        ${retentionRefreshFailed ? '<p class="inline-notice warning" role="status">部分资料读取失败，保留已读取的资料，可重试。</p>' : ''}</section>
      <section class="panel customer-retention-list">${tabs([
        ['', `已流失 ${projection.lost.length}`],
        ['review', `待核对 ${projection.review.length}`],
        ['scheduled', `待生效 ${projection.scheduled.length}`]
      ], tab, 'commerce-loss-tab', 'aria-label="客户流失状态"')}
      ${retentionToolbar(view, tab)}${A.table(columns, page, '', 'commerce-customer-loss', guidance)}
      ${cards}${A.pagination(rows.length)}</section>`;
  }

  function showCustomerLossHistory(id) {
    if (!canManageOrders()) return;
    const profile = customerRetentionProjection().profiles.get(id);
    if (!profile) return;
    const accountId = order => retentionPlanKey(subscriptionFamily(order), order.accountId);
    const accountEmail = order => retentionPlanKey(subscriptionFamily(order), subscriptionEmail(order));
    const linkedEmails = new Set(profile.confirmed.filter(({ order }) => order.accountId).map(({ order }) => accountEmail(order)));
    const accounts = new Set(profile.confirmed.map(({ order }) => order.accountId ? `编号:${accountId(order)}`
      : subscriptionEmail(order) && !linkedEmails.has(accountEmail(order)) ? `邮箱:${accountEmail(order)}` : '').filter(Boolean));
    const confirmedOrders = new Map(profile.confirmed.map(fact => [fact.order.id, fact]));
    const renewals = new Set(logs.filter(entry => {
      if (entry.type !== '关联续费订单' || entry.entityId === entry.relatedOrderId) return false;
      const original = confirmedOrders.get(entry.entityId), successor = confirmedOrders.get(entry.relatedOrderId);
      return original && successor && successor.start >= original.start && successor.expiry > original.expiry &&
        sameSubscriptionAccount(original.order, successor.order);
    }).map(entry => entry.relatedOrderId));
    const records = profile.history.map(({ order, start, expiry, end, plan, status, reasons }) => ({
      id: order.id, orderNo: order.orderNo || '—', plan: retentionPlanLabel(order.product, plan),
      recordedPlan: order.plan, email: orderIdentity(order) || '—', source: order.source || '历史订单',
      start: retentionDate(start), expiry: retentionDate(expiry), end: end < expiry ? retentionDate(end) : '',
      status, reason: reasons.join('、')
    }));
    const columns = [
      { id: 'orderNo', label: '订单编号', render: row => A.textAction(row.orderNo,
        'commerce-order-detail', `data-id="${E(row.id)}" aria-label="查看订单 ${E(row.orderNo)}"`) },
      { id: 'plan', label: '产品与套餐', render: row => `<span title="${E(row.recordedPlan || '')}">${E(row.plan)}</span>` },
      { id: 'status', label: '订阅状态', render: row => A.tag(row.status, row.reason ? 'warning' : row.status === '有效' ? 'success' : '') },
      { id: 'start', label: '开通时间' }, { id: 'expiry', label: '登记到期' },
      { id: 'end', label: '提前结束' }, { id: 'email', label: '账号' },
      { id: 'source', label: '来源' }, { id: 'reason', label: '核对说明', long: true }
    ];
    const contacts = customerChannels.filter(([key]) => profile.customer[key])
      .map(([key, label]) => property(label, profile.customer[key])).join('');
    const historyViewKey = `customer-retention:history:${id}`;
    A.openDrawer('客户订阅历史', '按本系统可查资料统计。相同订单或代充任务只记一次，开通证据待核对的记录单独标记。',
      `<section class="form-section retention-profile"><h3>${E(profile.customer.name)}</h3>${A.summary([
        ['确认订阅', profile.confirmed.length, '次', true], ['有效服务', profile.activeCount, '项'],
        ['可识别账号', accounts.size, '个'], ['待核对记录', records.filter(row => row.reason).length, '笔']
      ])}<div class="property-list">
        ${property('最早可查开通', retentionDate(profile.first?.start))}
        ${property('最近开通', retentionDate(profile.latest?.start))}
        ${property('已关联原单的续费', `${renewals.size} 次`)}
        ${property('套餐分布', retentionPlanSummary(profile))}
        ${contacts}</div></section>
      <section class="form-section"><h3>订单记录</h3>
        ${records.length ? '<p class="footnote">左右滑动可查看订阅周期、账号和来源。点击订单编号可查看原单。</p>' : ''}
        <div data-retention-history></div></section>`,
      A.button('关闭', 'drawer-close'));
    const region = $('#drawer [data-retention-history]');
    if (!region) return;
    const pagination = window.IDPagination;
    const renderHistory = ({ page = 1, pageSize = pagination.defaultPageSize } = {}) => {
      page = Math.min(page, Math.max(1, Math.ceil(records.length / pageSize)));
      region.innerHTML = A.table(columns, records.slice((page - 1) * pageSize, page * pageSize),
        '', 'commerce-loss-history', { title: '暂无关联订单', description: '已归属的订单会在这里显示。' }) +
        pagination.render({ id: 'customer-retention-history', page, pageSize, total: records.length });
    };
    renderHistory(S.drafts.get(historyViewKey));
    region.addEventListener('id-pagination-change', ({ detail }) => {
      if (detail.id !== 'customer-retention-history') return;
      S.drafts.set(historyViewKey, { page: detail.page, pageSize: detail.pageSize });
      renderHistory(detail);
    });
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
    const owner = form.querySelector?.('select#commerce-ownerId, select#commerce-contact-ownerId');
    if (owner) draft['commerce-ownerId'] = owner.value;
    const login = form.elements?.['commerce-loginMethod'];
    if (login) draft['commerce-loginMethod'] = login.value;
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
      if (form.id === 'commerce-paid-prices-form' && form.dataset.paidPriceDirty !== 'yes') continue;
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
  function orderOwnerField(v, existing, tenant = false, label = '归属人') {
    const id = tenant ? 'contact-ownerId' : 'ownerId';
    const noun = tenant ? '租户' : '订单';
    if (existing || !canManageOrders()) {
      const name = existing ? tenant ? existing.owner || '历史未记录' : orderOwnerName(existing) : currentOperator().name;
      return field(label, id, `<input id="commerce-${id}" value="${E(name)}" readonly />`, false,
        existing ? `保留原${noun}归属；录入人与操作记录分别保留。` : `${noun}归属当前登录账号。`);
    }
    const selected = v('ownerId') || currentOperator().id || '';
    return field(label, id, searchableSelect(id, label, orderOwnerChoices(selected), selected,
      A.button('刷新', 'commerce-order-owner-refresh')).replace(`name="commerce-${id}"`, 'name="commerce-ownerId"'),
      true, tenant ? '可选择启用的系统员工；录入人仍记录当前登录账号。' : '可代员工录单，录入人仍记录当前登录账号。');
  }
  async function loadOrderOwners(form, retry = false) {
    const select = form?.querySelector('select#commerce-ownerId, select#commerce-contact-ownerId');
    if (!select || !localData?.authRequired || !localData.orderOwners ||
        (orderOwnerLoads.has(form) && !retry)) return;
    const request = {};
    orderOwnerLoads.set(form, request);
    const trigger = form.querySelector(`#${select.id}-picker`);
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
      A.setError(select.id, valid ? '' : '所选归属人已停用或不存在，请重新选择');
      return true;
    } catch (error) {
      if (form.isConnected && orderOwnerLoads.get(form) === request) {
        orderOwnerLoads.delete(form);
        A.setError(select.id, '人员读取失败，请点击右侧刷新重试；仍可归属当前账号。');
        return false;
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
    const at = orderEvaluationTime();
    for (const order of orders) {
      if (order.customerId !== customerId) continue;
      const openedAt = parseDate(order.start), expiry = parseDate(order.expiry);
      if (!Number.isFinite(openedAt) || openedAt > at ||
          (automaticOrder(order) && !(expiry > openedAt)) ||
          !hasOpeningEvidence(order, openedAt, expiry, at)) continue;
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
            {
              id: 'wechat',
              label: '客户微信',
              render: (row) => {
                const wechat = String(row.wechat ?? '');
                if (!wechat.trim()) return E(row.wechat ?? '—');
                const value = E(wechat);
                const copy = A.button('复制', 'copy-value', 'compact', '',
                  `data-value="${value}" aria-label="复制微信号"`);
                return `<div class="action-links"><span>${value}</span>${copy}</div>`;
              }
            },
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
              render: row => A.textAction('查看历史业务', 'commerce-contact-services', `data-id="${E(row.id)}"`)
            }
          ]),
      { id: 'linkedOrders', label: '关联订单', render: row => A.textAction('查看关联订单',
        'commerce-contact-orders', `data-id="${E(row.id)}" data-kind="${tenant ? 'tenant' : 'customer'}"`) },
      ...traceColumns(),
      { id: 'notes', label: '备注', long: true },
      {
        id: 'actions',
        label: '操作',
        action: true,
        render: (row) =>
          `<div class="action-links">${A.textAction('详情', 'commerce-contact-detail', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`)}${A.textAction('编辑', 'commerce-contact-edit', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`)}${tenant && localData && canManageOrders()
            ? A.textAction('更多操作', 'commerce-tenant-more', `data-id="${E(row.id)}"`)
            : A.textAction(row.active ? '停用' : '恢复', 'commerce-contact-disable', `data-id="${row.id}" data-kind="${tenant ? 'tenant' : 'customer'}"`, 'secondary')}</div>`
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
      ? orderOwnerField(v, row, true)
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
    const initialCardCount = Math.min(99, Math.max(0, Number(draft['commerce-initial-card-count']) || 0));
    const cardFields = tenant && !row ? `<section class="form-section"><div class="panel-heading"><div class="section-title-row"><h3>银行卡</h3>${A.titleInfo('银行卡', '可随租户一起登记，最多 99 张；保存后在租户银行卡管理中维护。', 'tenant-initial-card-help')}</div>${A.button('新增银行卡', 'commerce-initial-card-add', '', 'plus', initialCardCount >= 99 ? 'disabled' : '')}</div><input type="hidden" name="commerce-initial-card-count" value="${initialCardCount}" />${Array.from({ length: initialCardCount }, (_, i) => `<div class="guide-item"><div class="commerce-field-grid">${field(`银行卡 ${i + 1} 名称`, `initial-card-${i}-label`, input(`initial-card-${i}-label`, draft[`commerce-initial-card-${i}-label`] || '', 'maxlength="80"'))}${field('银行卡号', `initial-card-${i}-number`, input(`initial-card-${i}-number`, draft[`commerce-initial-card-${i}-number`] || '', 'inputmode="numeric" maxlength="32" autocomplete="off"'), true)}</div>${A.textAction('移除这张银行卡', 'commerce-initial-card-remove', `data-index="${i}"`, 'danger')}</div>`).join('')}</section>` : '';
    const details = tenant
      ? `<div class="commerce-field-grid">${name}${phone}${source}${notes}</div>${cardFields}<p class="footnote">录入人和修改人自动记录。</p>`
      : [
          section('01', '基本资料', name + source + contactField('客户标签', 'tags',
            customerTagPicker(A.readOptionList(draft['commerce-tags'] ?? row?.tags ?? []), row?.tags || [])
          ), '', false, 'commerce-section', customerSettingsButtons()),
          section('02', '联系方式', phone + channels + notes,
            '联系方式选填，可先登记直接在网站下单的客户。', false, 'commerce-customer-section')
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
      return entryWorkspace(`<section class="panel">${entryTabs}<div class="form-panel">${body}<div class="form-footer">${footer}</div></div></section>`, tenant ? 'tenant' : 'customer');
    }
    A.openDrawer(
      `${row ? '编辑' : '新增'}${tenant ? '租户' : '客户'}`,
      tenant
        ? '保存前确认资料。关闭保留当前草稿，关联记录使用稳定编号。'
        : '关闭保留当前草稿。录入人和修改人自动记录，关联订单和历史开通业务可从列表直接打开。',
      body,
      footer,
      key
    );
    if (tenant) void loadOrderOwners($('#commerce-contact-form', $('#drawer') || document));
    return '';
  }
  function contactRecordActions(id, tenant = false) {
    return A.textAction('关联订单', 'commerce-contact-orders', `data-id="${E(id)}" data-kind="${tenant ? 'tenant' : 'customer'}"`) +
      (tenant ? '' : A.textAction('历史开通业务', 'commerce-contact-services', `data-id="${E(id)}"`));
  }
  function contactRecords(id, tenant, services = false) {
    const contact = (tenant ? tenants : customers).find(row => row.id === id);
    if (!contact || (tenant && services)) return;
    const title = services ? '历史开通业务' : '关联订单';
    const rows = services ? customerServices(id) : orders.filter(row => tenant ? row.tenantId === id : row.customerId === id)
      .sort((a, b) => (parseDate(b.createdAt) || 0) - (parseDate(a.createdAt) || 0) || String(b.id).localeCompare(String(a.id)));
    const columns = services ? [
      { id: 'name', label: '开通业务', long: true },
      { id: 'count', label: '开通次数' },
      { id: 'firstOpenedAt', label: '首次开通', render: row => E(row.firstOpenedAt.replace('T', ' ')) },
      { id: 'lastOpenedAt', label: '最近开通', render: row => E(row.lastOpenedAt.replace('T', ' ')) },
      { id: 'orderNos', label: '来源订单', long: true, render: row => E(row.orderNos.join('、')) }
    ] : [
      { id: 'orderNo', label: '订单编号' },
      { id: 'email', label: '订阅账号', long: true, render: row => E(orderIdentity(row) || '—') },
      { id: 'plan', label: '订阅套餐', render: row => E([row.product, row.plan].filter(Boolean).join(' · ')) },
      { id: 'businessType', label: '业务类型' },
      { id: 'start', label: '开通时间' },
      { id: 'expiry', label: '到期时间' },
      { id: 'accountStatus', label: '账号状态', render: row => E(accountStatus(row)) },
      { id: 'notes', label: '备注', long: true },
      { id: 'actions', label: '操作', action: true, render: row => A.textAction('查看订单',
        'commerce-order-detail', `data-id="${E(row.id)}"`) }
    ];
    const key = `commerce-contact-records:${tenant ? 'tenant' : 'customer'}:${id}:${services ? 'services' : 'orders'}`;
    const pagination = window.IDPagination;
    const view = S.drafts.get(key) || { page: 1, pageSize: pagination.defaultPageSize };
    S.drafts.set(key, view);
    const content = () => {
      view.page = Math.min(view.page, Math.max(1, Math.ceil(rows.length / view.pageSize)));
      return A.table(columns, rows.slice((view.page - 1) * view.pageSize, view.page * view.pageSize), '',
        services ? 'commerce-contact-services' : 'commerce-contact-orders', {
          title: services ? '暂无已核实开通的业务' : '暂无关联订单',
          description: services ? '仅统计有实际开通证据的关联订单，待核对记录可在关联订单中查看。' : '订单按客户或租户编号关联。'
        }) + pagination.render({ id: 'commerce-contact-records', ...view, total: rows.length });
    };
    A.openDrawer(`${contact.name} · ${title}`, services
      ? '按客户编号汇总有实际开通证据的订单；开通次数与首末时间来自原始记录。'
      : '按资料编号查看当前权限内的关联订单，点击查看订单可打开完整资料。',
      `<section class="panel contact-record-table" data-contact-records>${content()}</section>`,
      A.button('关闭', 'drawer-close'), '', { kind: 'commerce-contact-records' });
    const region = $('#drawer [data-contact-records]');
    region?.addEventListener('id-pagination-change', event => {
      if (event.detail.id !== 'commerce-contact-records') return;
      event.stopPropagation();
      Object.assign(view, { page: event.detail.page, pageSize: event.detail.pageSize });
      region.innerHTML = content();
    });
  }
  function contactDetail(id, tenant) {
    const row = (tenant ? tenants : customers).find((entry) => entry.id === id);
    if (!row) return;
    const rent = rentBatches
      .flatMap((batch) => batch.items.map((item) => ({ ...item, batchNo: batch.id })))
      .filter((item) => item.tenantId === id);
    A.openDrawer(
      `${tenant ? '租户' : '客户'}详情`,
      '',
      `<div class="property-list">${property('姓名', row.name)}${property('联系电话', row.phone)}${tenant ? property('归属人', row.owner) : property('微信', row.wechat) + property('QQ', row.qq) + property('WhatsApp', row.whatsapp) + property('Telegram', row.telegram) + property('来源渠道', row.source) + property('客户标签', (row.tags || []).join('、'))}${traceProperties(row)}${property('备注', row.notes)}</div>${
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
      }${tenant ? tenantTransferHistory(row.ownerTransfers || []) : ''}${panelTitle('操作记录')}${timeline(row.id)}`,
      (tenant && localData ? A.button('银行卡管理', 'commerce-tenant-cards', '', '', `data-id="${E(row.id)}"`) +
        (canManageOrders() ? A.button('转交归属', 'commerce-tenant-owner-transfer', '', '', `data-id="${E(row.id)}"`) : '') : '') +
        (!tenant && canManageOrders() ? A.button('订阅历史', 'commerce-loss-history', '', '', `data-id="${E(row.id)}"`) : '') +
        A.button('关闭', 'drawer-close')
    );
  }

  function tenantTransferHistory(history) {
    return panelTitle('归属转交记录', '按转交时的人员姓名保存历史快照，历史订单归属保持原值。') +
      (history.length ? A.table([
        { id: 'at', label: '转交时间', render: row => E(dateInput(row.at).replace('T', ' ')) },
        { id: 'fromOwner', label: '原归属人', render: row => E(row.fromOwner || '历史未记录') },
        { id: 'toOwner', label: '新归属人' }, { id: 'actor', label: '操作人' },
        { id: 'reason', label: '转交原因', long: true }
      ], [...history].reverse(), '', 'commerce-tenant-owner-history') : A.empty('暂无归属转交记录', '历史姓名不会自动匹配员工编号。'));
  }
  let tenantTransferLoad;
  async function openTenantOwnerTransfer(id, reload = false) {
    if (!localData || !canManageOrders()) return;
    const active = $('#drawer[open] #commerce-tenant-owner-form');
    if (active?.elements['commerce-transfer-attempt']?.value) {
      A.notify('请先核对上次转交结果，再读取最新资料'); return;
    }
    saveDrafts();
    const route = S.route, context = S.drawerContext, actorId = currentOperator().id;
    const request = {}; tenantTransferLoad = request;
    try {
      const snapshot = await localData.tenantOwnerTransfer(id);
      if (tenantTransferLoad !== request || S.route !== route || S.drawerContext !== context || currentOperator().id !== actorId) return;
      const key = `commerce-tenant-transfer:${id}`, draft = { ...S.drafts.get(key) };
      if (reload || !draft['commerce-transfer-operation']) {
        Object.assign(draft, { 'commerce-transfer-operation': uid('tenant-transfer'),
          'commerce-transfer-version': String(snapshot.version),
          'commerce-transfer-base': JSON.stringify(snapshot.tenant), 'commerce-transfer-attempt': '' });
        S.drafts.set(key, draft);
      }
      const base = JSON.parse(draft['commerce-transfer-base']);
      const stale = Number(draft['commerce-transfer-version']) !== snapshot.version || base.version !== snapshot.tenant.version;
      const hidden = input('transfer-id', id, 'type="hidden"') +
        ['operation', 'version', 'base', 'attempt'].map(name => input('transfer-' + name, draft['commerce-transfer-' + name] || '', 'type="hidden"')).join('');
      A.openDrawer('转交租户归属', '仅调整租户资料负责人，历史订单、银行卡及付租对象保持原值。',
        `<form id="commerce-tenant-owner-form" data-commerce-draft="${E(key)}" novalidate>${hidden}<div class="commerce-field-grid">${
          field('租户姓名', 'transfer-name', `<input id="commerce-transfer-name" value="${E(snapshot.tenant.name)}" readonly />`)}${
          field('当前归属', 'transfer-current', `<input id="commerce-transfer-current" value="${E(base.owner || '历史未记录')}" readonly />`)}${
          orderOwnerField(name => draft['commerce-' + name] || '', null, true, '新归属人')}${
          field('转交原因', 'transfer-reason', `<textarea id="commerce-transfer-reason" name="commerce-transfer-reason" rows="3" maxlength="500">${E(draft['commerce-transfer-reason'] || '')}</textarea>`, true, '', 'commerce-span-all')
        }</div><p id="commerce-transfer-status" class="footnote" role="status">${draft['commerce-transfer-attempt']
          ? '上次转交结果待核对，继续将核对原操作，不会重复转交。' : stale ? '资料已变化，输入已保留；请读取最新归属后再确认。' : '新归属人须为启用的系统员工，录入人和历史订单归属保持。'}</p></form>${tenantTransferHistory(snapshot.history)}`,
        A.button('取消', 'drawer-close') + A.button('读取最新', 'commerce-tenant-owner-reload', '', '', `data-id="${E(id)}"`) +
        `<button type="submit" form="commerce-tenant-owner-form" class="button primary">${draft['commerce-transfer-attempt'] ? '核对上次转交' : '确认转交'}</button>`, key);
      const form = $('#commerce-tenant-owner-form');
      if (draft['commerce-transfer-attempt']) lockTenantTransfer(form, true);
      else void loadOrderOwners(form);
      S.drafts.set(key, readCommerceDraft(form));
    } catch (error) {
      if (tenantTransferLoad === request && S.route === route && S.drawerContext === context && currentOperator().id === actorId)
        A.notify(error.message || '无法读取租户归属，请重试');
    }
  }
  function lockTenantTransfer(form, locked) {
    const select = form.querySelector('#commerce-contact-ownerId');
    select.disabled = locked;
    form.querySelector('#commerce-contact-ownerId-picker').disabled = locked;
    form.querySelector('#commerce-transfer-reason').readOnly = locked;
    let mirror = form.querySelector('[data-transfer-owner-mirror]');
    if (locked) {
      if (!mirror) {
        mirror = document.createElement('input'); mirror.type = 'hidden';
        mirror.name = 'commerce-ownerId'; mirror.dataset.transferOwnerMirror = ''; form.append(mirror);
      }
      mirror.value = select.value;
    } else mirror?.remove();
  }
  async function saveTenantOwnerTransfer(form, confirmed = '') {
    if (!canManageOrders() || form.getAttribute('aria-busy') === 'true' || saving) return;
    const raw = readCommerceDraft(form), key = form.dataset.commerceDraft;
    const actorId = currentOperator().id, route = S.route, context = S.drawerContext;
    let command;
    if (raw['commerce-transfer-attempt']) command = JSON.parse(raw['commerce-transfer-attempt']);
    else {
      const base = JSON.parse(raw['commerce-transfer-base']);
      const ownerId = value(raw, 'ownerId'), reason = value(raw, 'transfer-reason');
      const ownerError = !ownerId || !orderOwners.some(row => row.id === ownerId) ? '请选择启用的系统员工'
        : ownerId === base.ownerId ? '新归属人与当前相同，无需转交' : '';
      A.setError('commerce-contact-ownerId', ownerError);
      A.setError('commerce-transfer-reason', !reason || reason.length > 500 ? '请填写转交原因，最多 500 字' : '');
      if (ownerError || !reason || reason.length > 500) return;
      command = { tenantId: value(raw, 'transfer-id'), ownerId, reason,
        operationId: value(raw, 'transfer-operation'), version: Number(raw['commerce-transfer-version']), tenantVersion: base.version };
    }
    const submitted = JSON.stringify(raw);
    if (!confirmed) {
      const label = orderOwners.find(row => row.id === command.ownerId)?.name || '原操作所选员工';
      A.confirmAction(raw['commerce-transfer-attempt'] ? '核对上次转交' : '确认转交租户归属',
        `新归属人：${label}。历史订单归属保持原值；实际操作人单独记录。`, () => {
          if (form.isConnected && S.route === route && S.drawerContext === context && currentOperator().id === actorId &&
              JSON.stringify(readCommerceDraft(form)) === submitted) void saveTenantOwnerTransfer(form, submitted);
          else A.notify('输入或登录身份已变化，请重新核对');
        });
      return;
    }
    const attempt = JSON.stringify(command);
    form.elements['commerce-transfer-attempt'].value = attempt;
    saveDrafts(); lockTenantTransfer(form, true);
    form.setAttribute('aria-busy', 'true'); saving = true;
    const feedback = A.beginActionFeedback?.(document.querySelector('button[form="commerce-tenant-owner-form"][type="submit"]'), '正在核对并保存转交…');
    try {
      const result = await localData.transferTenantOwner(command);
      if (result.receipt?.id !== command.operationId || !result.data?.tenants || !Number.isInteger(result.version))
        throw new Error('尚未确认转交结果，请核对原操作');
      if (currentOperator().id !== actorId) return;
      acceptLocalCommerce(result);
      const unchanged = form.isConnected && S.route === route && S.drawerContext === context && form.elements['commerce-transfer-attempt'].value === attempt;
      if (unchanged) { cleanClose(key); A.render(); }
      else {
        saveDrafts();
        if (S.drafts.get(key)?.['commerce-transfer-attempt'] === attempt) S.drafts.delete(key);
        if (matches(S.route) && !$('#main form[data-commerce-draft]')) A.render();
      }
      A.notify(result.replayed ? '上次转交结果已核对，请以当前租户归属为准' : '租户归属已转交，历史订单归属保持');
    } catch (error) {
      if (currentOperator().id !== actorId) return;
      if (form.isConnected) {
        if ([400, 403, 404, 409].includes(error.status)) {
          form.elements['commerce-transfer-attempt'].value = ''; lockTenantTransfer(form, false);
          $('#commerce-transfer-status', form).textContent = error.message + '。输入已保留，请读取最新资料后核对。';
        } else $('#commerce-transfer-status', form).textContent = '转交结果待核对，请继续核对原操作；不会重复转交。';
        const button = document.querySelector('button[form="commerce-tenant-owner-form"][type="submit"]');
        if (button) button.textContent = form.elements['commerce-transfer-attempt'].value ? '核对上次转交' : '确认转交';
        saveDrafts();
      }
      A.notify(error.message || '转交尚未确认，输入已保留');
    } finally { form.removeAttribute('aria-busy'); saving = false; feedback?.finish(); }
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
      version: 1,
      ...(personalProduct(product) && {
        businessType: '首次开通', start: '', expiry: '', billingChannel: 'web',
        billingCycle: 'month', billingCountry: '', billingReceipt: '', autoRenew: 'unknown',
        entitlementStatus: 'pending', loginMethod: product === 'Gemini' ? 'google' : 'email',
        xHandle: '', xLinkState: 'unknown', platformAccountId: '', previousAutoRenew: 'unknown'
      })
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
    const inventory = A.modules.inventory;
    const summary = personalProduct(order.product) ? inventory?.accountSummary?.(order.accountId)
      : inventory?.accountSummaryForEmail?.(order.email, order.product);
    return summary?.orders?.some(row => row.id === order.id && row.released) || false;
  }
  function customerEmailChoices(customerId, product) {
    if (!customerId) return [['', '直接填写新邮箱']];
    const products = product === 'GPT' ? ['GPT']
      : ['Claude Pro', 'Claude Max'].includes(product) ? ['Claude Pro', 'Claude Max'] : [];
    const usedAt = row => parseDate(row.start) || parseDate(row.createdAt) || 0;
    const history = orders.filter(row => row.customerId === customerId && products.includes(row.product) && !row.cancelled &&
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
  function personalHistoryChoices(customerId, product) {
    return [['', '直接填写账号'], ...orders.filter(row => customerId && row.customerId === customerId &&
      row.product === product && !row.cancelled && !row.subscriptionEnded &&
      row.entitlementStatus === 'active' && orderIdentity(row))
      .sort((a, b) => String(b.start).localeCompare(String(a.start)))
      .map(row => [row.id, [orderIdentity(row), row.plan, row.orderNo].filter(Boolean).join(' · ')])];
  }
  function personalStockChoices(product, existing, selected = '') {
    const choices = [['', '选择本产品的可用账号'], ...availableStock(product, existing?.id)
      .map(row => [row.id, `${personalTarget(row)} · ${row.inventoryState === 'claimed' ? '本人已提取' : '库存可用'} · ${row.id}`])];
    if (selected && !choices.some(([id]) => id === selected))
      choices.push([selected, existing?.accountId === selected ? orderIdentity(existing) : '原所选账号待核对']);
    return choices;
  }
  // Customer account fields must not suggest the operator's saved browser identity.
  // Chromium can ignore autocomplete="off" for email/address fields.
  const orderAccountAutocomplete = 'autocomplete="new-password"';
  function personalIdentityFields(v, existing, stock) {
    const grok = v('product') === 'Grok';
    const selected = v('accountId');
    return field('客户历史账号', 'personalHistoryId', searchableSelect('personalHistoryId', '客户历史账号',
      personalHistoryChoices(v('customerId'), v('product')), v('personalHistoryId')), false, '', '', stock) +
      field('可交付账号', 'accountId', searchableSelect('accountId', '可交付账号',
        personalStockChoices(v('product'), existing, selected), selected), true,
        '按库存编号选择，确认开通和交付时登记使用。', '', !stock) +
      field(grok ? '订阅账号' : 'Google 账号邮箱', 'email',
        input('email', v('email') || v('xHandle'), `${orderAccountAutocomplete} ${stock || existing?.accountId ? 'readonly' :
          grok ? 'placeholder="实际邮箱或 X @账号"' : 'placeholder="name@example.test"'}`), true) +
      (grok ? field('登录方式', 'loginMethod', select('loginMethod', personalLoginChoices, v('loginMethod')), true) +
        field('关联 X @账号', 'xHandle', input('xHandle', v('xHandle'), 'maxlength="16" placeholder="@username"')) +
        field('X 绑定状态', 'xLinkState', select('xLinkState', linkChoices, v('xLinkState')))
        : input('loginMethod', 'google', 'type="hidden"')) +
      field('平台账号编号', 'platformAccountId', input('platformAccountId', v('platformAccountId'), 'maxlength="120"'));
  }
  function orderIdentityFields(v, contact, existing, products) {
    const auto = automaticOrder(existing);
    const product = v('product'),
      customerId = v('customerId'),
      stock = v('businessType') === '成品交付';
    const emailOptional = optionalOrderEmail(product, v('businessType'), v('claudeRenewalId'));
    return (
      `<div class="commerce-span-all order-choice-grid">` +
      (products.length === 1 ? `<input type="hidden" id="commerce-product" name="commerce-product" value="${E(product)}" />` : field('产品类型', 'product', select('product', products, product), true)) +
      field('开通套餐', 'plan', auto ? input('plan', v('plan'), 'readonly') : select('plan', orderPlanChoices(product, v('plan'), existing), v('plan')), true) +
      field(
        '业务类型',
        'businessType',
        auto ? input('businessType', v('businessType'), 'readonly') : select('businessType',
          personalProduct(product) ? ['首次开通', '续费', '成品交付'] : ['续费', '成品交付'], v('businessType')),
        true
      ) +
      `</div><div class="commerce-span-all order-wide-fields">` +
      field(
        '客户资料',
        'customerId',
        searchableSelect('customerId', '客户', [['', '选择客户'], ...customers.filter((row) => row.active || row.id === customerId).map((row) => [row.id, [row.name, ...customerChannels.map(([key]) => row[key]).filter(Boolean)].join(' · ')])], customerId, A.button('新增', 'commerce-quick-customer', '', 'plus')),
        true,
        '',
        ''
      ) +
      (personalProduct(product) ? personalIdentityFields(v, existing, stock) :
      `<input type="hidden" id="commerce-accountId" name="commerce-accountId" value="${E(v('accountId'))}" />` +
      field(
        '邮箱账号',
        'email',
        searchableSelect('emailHistory', '客户历史邮箱', customerEmailChoices(customerId, product), v('email'), '', input(
          'email',
          v('email'),
          `placeholder="${stock ? '搜索并选择本产品的可用账号' : emailOptional ? '选填，可选择历史邮箱或手动填写' : '填写订单邮箱'}" aria-required="${!emailOptional}" ${orderAccountAutocomplete} ${existing?.accountId || auto ? 'readonly' : ''}`
        )),
        true,
        stock
          ? existing
            ? '已保存的交付快照保留，不再次占用库存。'
            : '按邮箱搜索未使用账号，保存成功后标记为已使用。'
          : auto ? '' : '优先匹配所选客户在当前产品最近使用的邮箱，也可直接填写新邮箱。',
        ''
      ).replace('<span class="required">*', `<span class="required"${emailOptional ? ' hidden' : ''}>*`)) +
      orderOwnerField(v, existing) +
      '</div>' +
      `<details class="commerce-span-all"><summary>联系方式（自动回填，可展开修改）</summary><div class="commerce-field-grid">${field('客户微信', 'wechat', input('wechat', contact('wechat')))}${field('客户电话', 'customerPhone', input('customerPhone', contact('customerPhone')))}${field('QQ', 'qq', input('qq', contact('qq')))}${field('WhatsApp', 'whatsapp', input('whatsapp', contact('whatsapp')))}${field('Telegram', 'telegram', input('telegram', contact('telegram')))}</div></details>`
    );
  }
  function orderPlanChoices(product, selected, existing) {
    const choices = productPlans[product] || [];
    return existing?.plan === selected && !choices.includes(selected) ? [...choices, selected] : choices;
  }
  function orderSalePrices(product, businessType) {
    return (businessType === '成品交付' ? currencySettings.stockOrderPrices : orderPrices)?.[product] || {};
  }
  function orderPrice(product, plan, currency, businessType) {
    return orderSalePrices(product, businessType)[plan]?.[currency] || '';
  }
  const paidPriceSetting = product => product === 'GPT' ? ['gptPaidPrices', 'gpt_paid_prices_save']
    : personalProduct(product) ? ['personalPaidPrices', 'personal_paid_prices_save']
      : ['claudePaidPrices', 'claude_paid_prices_save'];
  function orderPaidPrices(product, settings = currencySettings) {
    const [key] = paidPriceSetting(product);
    const prices = settings?.[key];
    return (product === 'GPT' ? prices : prices?.[product]) || {};
  }
  function orderAmountReference(v, paid, status) {
    if (paid && v('payment') === '苹果内购') return '苹果内购按实际美元金额填写。';
    if (status === 'loading') return '<span role="status">正在读取金额设置…</span>';
    if (status === 'error') return '<span role="status">金额设置暂时无法读取。</span> ' +
      A.textAction('重试', 'commerce-order-prices-retry');
    const product = v('product'), plan = v('plan');
    const current = v(paid ? 'paidCurrency' : 'saleCurrency');
    const prices = (paid ? orderPaidPrices(product)[plan] : orderSalePrices(product, v('businessType'))[plan]) || {};
    const configured = Object.keys(prices).filter(code => prices[code]);
    const codes = [...new Set([current, ...configured])].filter(Boolean);
    const saleLabel = v('businessType') === '成品交付' ? '成品号售价' : v('businessType') === '续费' ? '续费售价' : '套餐售价';
    const title = `<strong>${E(product)} · ${E(plan)} · ${paid ? '银行卡代付价' : saleLabel}</strong>`;
    if (!codes.length) return title + '<div>暂无已配置金额</div>';
    const rows = codes.map(code => {
      const currency = orderCurrencyRows(product).find(row => row.code === code)?.name || currencyNames[code] || code;
      const label = (paid && paymentCountries[code]) || currency;
      const amount = prices[code] ? `${prices[code]} ${code}` : `未配置（${code}）`;
      return `<div${code === current ? ' aria-current="true"' : ''}><dt>${E(label)}</dt><dd>${E(amount)}</dd></div>`;
    });
    return title + `<dl class="order-price-reference-list">${rows.join('')}</dl>`;
  }
  function orderAmountHeading(label, paid, v) {
    const content = orderAmountReference(v, paid, localData ? 'loading' : 'ready');
    const id = paid ? 'commerce-paid-price-reference' : 'commerce-sale-price-reference';
    return `<div class="order-financial-heading"><div class="title-with-help"><h3>${label}</h3>${A.titleInfo(label + '金额', content, id, true)}</div><div class="order-financial-actions">${A.button(paid ? '查看代付价' : '查看售价', 'commerce-order-price-reference', '', '', `data-kind="${paid ? 'paid' : 'sale'}"`)}</div></div>`;
  }
  function orderAmountInput(v, name, readOnly = false) {
    if (readOnly) return input(name, v(name), 'readonly placeholder="待核对"');
    const paid = name === 'paidAmount';
    const label = paid ? '选择代付金额' : '选择售卖金额';
    return `<div class="order-amount-picker">
      ${input(name, v(name), `inputmode="decimal" placeholder="${paid ? '实际代付金额' : '实际收到金额'}"`)}
      ${A.button('', 'commerce-order-amount-options', '', 'down',
        `data-field="${name}" aria-label="${label}" title="${label}" aria-haspopup="menu" aria-expanded="false"`)}
    </div>`;
  }
  function orderPresetAmount(form, name) {
    const fields = form.elements;
    const paid = name === 'paidAmount';
    const code = fields[paid ? 'commerce-paidCurrency' : 'commerce-saleCurrency'].value;
    const product = fields['commerce-product'].value, plan = fields['commerce-plan'].value;
    const ready = !localData || form.dataset.priceReferenceStatus === 'ready';
    if (!ready || !code || (paid && fields['commerce-payment'].value !== '银行卡')) return { code, amount: '' };
    const amount = paid ? orderPaidPrices(product)[plan]?.[code] :
      orderPrice(product, plan, code, fields['commerce-businessType'].value);
    return { code, amount: typeof amount === 'string' && amountValid(amount) ? amount : '' };
  }
  function openOrderAmountOptions(trigger) {
    const form = trigger.closest('#commerce-order-form');
    const name = trigger.dataset.field;
    const control = form?.elements[`commerce-${name}`];
    if (!control || control.readOnly) return;
    const preset = orderPresetAmount(form, name);
    const status = form.dataset.priceReferenceStatus;
    const unavailable = status === 'error' ? '暂时无法读取预设金额'
      : localData && status !== 'ready' ? '正在读取预设金额…' : '当前币种暂无预设金额';
    const options = A.button(preset.amount ? `使用预设 ${preset.amount} ${preset.code}` : unavailable,
      'commerce-order-amount-preset', '', '', preset.amount ? '' : 'disabled') +
      A.button('手动填写', 'commerce-order-amount-manual');
    A.openActionMenu(trigger, options, {
      label: trigger.getAttribute('aria-label'),
      onSelect(choice) {
        if (!control.isConnected || control.readOnly) return;
        control.focus({ preventScroll: true });
        if (choice.dataset.action === 'commerce-order-amount-manual') {
          control.select();
          return;
        }
        const current = orderPresetAmount(form, name);
        if (current.amount !== preset.amount || current.code !== preset.code) {
          A.notify('预设金额或币种已变化，请重新选择');
          return;
        }
        control.value = preset.amount;
        A.setError(control.id, '', form);
        control.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
  function refreshOrderAmountReferences(form, status = form.dataset.priceReferenceStatus || (localData ? 'loading' : 'ready')) {
    form.dataset.priceReferenceStatus = status;
    const v = name => {
      const control = form.elements['commerce-' + name];
      return control?.dataset?.currencyCode ?? control?.value ?? '';
    };
    $('#commerce-paid-price-reference', form).innerHTML = orderAmountReference(v, true, status);
    $('#commerce-sale-price-reference', form).innerHTML = orderAmountReference(v, false, status);
    window.IDTitleHelp?.reposition?.();
  }
  function applyOrderPrice(form, selectionChanged = false) {
    if (form.elements['commerce-id'].value || form.elements['commerce-saleManual'].value) return;
    if (selectionChanged) form.elements['commerce-receiptConfirmed'].checked = false;
    else if (form.elements['commerce-receiptConfirmed'].checked) return;
    form.elements['commerce-saleAmount'].value = orderPrice(form.elements['commerce-product'].value,
      form.elements['commerce-plan'].value, form.elements['commerce-saleCurrency'].value,
      form.elements['commerce-businessType'].value);
  }
  function applyGptPaidPrice(form, selectionChanged = false) {
    const fields = form.elements;
    if (fields['commerce-id'].value ||
        !gptCardPayment(fields['commerce-product'].value, fields['commerce-payment'].value)) return;
    const manual = fields['commerce-paidManual'];
    const confirmed = fields['commerce-paidConfirmed'];
    if (selectionChanged) {
      manual.value = '';
      confirmed.checked = false;
    } else if (manual.value || confirmed.checked) return;
    fields['commerce-paidAmount'].value =
      orderPaidPrices('GPT')[fields['commerce-plan'].value]?.[fields['commerce-paidCurrency'].value] ?? '';
  }
  async function loadPrices(form) {
    if (!localData) return;
    const revision = currencySettingsRevision;
    priceLoad ||= localData.load('settings').catch(() => {
      priceLoad = null;
      return null;
    });
    const snapshot = await priceLoad;
    if (revision !== currencySettingsRevision) return null;
    if (!snapshot) {
      if (form?.isConnected) refreshOrderAmountReferences(form, 'error');
      return null;
    }
    orderPrices = snapshot.data?.orderPrices || {};
    currencySettings = snapshot.data || {};
    if (form?.isConnected) {
      const preserve = form.dataset.currencyInitialized === 'yes' || S.drafts.has(form.dataset.commerceDraft) || Boolean(form.elements['commerce-id'].value);
      refreshCurrencyFields(form, preserve);
      form.dataset.currencyInitialized = 'yes';
      applyOrderPrice(form);
      applyGptPaidPrice(form);
      refreshOrderAmountReferences(form, 'ready');
    }
    return snapshot;
  }
  function paymentCountryLabel(code, name = currencyLabel(code)) {
    return paymentCountries[code] ? `${paymentCountries[code]} · ${name}` : name;
  }
  function priceCurrencyGroup(code, label, content, hidden = false) {
    return `<section class="order-price-currency" data-price-group="${E(code)}" aria-label="${E(label)}"${hidden ? ' hidden' : ''}>
      <h3>${E(label)}</h3>${content}</section>`;
  }
  function orderPriceReferenceBody(view) {
    const paid = view.kind === 'paid';
    const label = paid ? '银行卡代付金额' : view.businessType === '成品交付' ? '成品号售价'
      : personalProduct(view.product) ? '开通／续费售价' : '续费售价';
    const prices = paid ? orderPaidPrices(view.product) : orderSalePrices(view.product, view.businessType);
    const rowsByCurrency = new Map();
    for (const [plan, amounts] of Object.entries(prices)) {
      for (const [code, amount] of Object.entries(amounts)) {
        if (amount === '' || amount == null) continue;
        if (!rowsByCurrency.has(code)) rowsByCurrency.set(code, []);
        rowsByCurrency.get(code).push({ id: `${plan}:${code}`, plan, amount });
      }
    }
    const columns = [
      { id: 'plan', label: '套餐' },
      { id: 'amount', label: paid ? '原币代付金额' : '售卖价格' }
    ];
    const currencyOrder = paid ? Object.keys(paymentCountries) : orderCurrencyCodes(view.product);
    const codes = [...new Set([...currencyOrder, ...rowsByCurrency.keys()])].filter(code => rowsByCurrency.has(code));
    const groups = currencyChoices(codes, '', view.product).map(([code, name]) =>
      priceCurrencyGroup(code, paid ? paymentCountryLabel(code, name) : name,
        A.table(columns, rowsByCurrency.get(code), '', `订单金额参考 ${code}`))).join('');
    return `<section class="form-section order-price-groups"><div class="section-title-row"><h3>${label}</h3></div>${groups ||
      A.empty(`尚未配置${label}`, '请先在系统设置的「代付国家」中维护对应价格。')}</section>`;
  }
  async function loadOrderPriceReference(panel, view) {
    const actorId = currentOperator().id, route = S.route;
    panel.setAttribute('aria-busy', 'true');
    panel.innerHTML = '<p role="status">正在读取已设置的价格…</p>';
    priceLoad = null;
    const snapshot = await loadPrices();
    if (!panel.isConnected || !$('#drawer')?.open || S.route !== route || currentOperator().id !== actorId) return;
    panel.setAttribute('aria-busy', 'false');
    panel.innerHTML = localData && !snapshot
      ? '<p role="status">价格读取失败，请重试。</p>' + A.button('重试', 'commerce-order-price-reference-retry')
      : orderPriceReferenceBody(view);
  }
  function openOrderPriceReference(form, kind) {
    if (!form || !['paid', 'sale'].includes(kind)) return;
    saveDrafts();
    const view = { kind, product: form.elements['commerce-product'].value,
      businessType: form.elements['commerce-businessType'].value };
    orderPriceReferenceReturn = { view, route: S.route, actorId: currentOperator().id,
      main: !form.closest('#drawer'), orderId: form.elements['commerce-id'].value,
      renewalId: form.elements['commerce-claudeRenewalId'].value };
    A.openDrawer(`${view.product} ${kind === 'paid' ? '代付金额' : '售卖价格'}`,
      kind === 'paid' ? '查看系统设置中保存的银行卡原币代付金额，不包含人民币折算预算；实际支付以本笔账单为准。'
        : '查看系统设置中与当前业务类型对应的售价；续费与成品号分别定价。',
      '<div id="commerce-order-price-reference-panel"></div>', A.button('返回订单', 'drawer-close'), 'commerce-order-price-reference');
    void loadOrderPriceReference($('#commerce-order-price-reference-panel'), view);
  }
  const paymentSettingsTabs = [['paid', '代付价格'], ['sale', '套餐售价'], ['currency', '订单币种']];
  let paymentSettingsVersion = localData ? null : 0;
  let paymentSettingsLoad, paymentSettingsError = '';
  let paymentRates, paymentRateLoad, paymentRateError = '', paymentExpiryTimer;
  let paymentRatesStale = true;
  let paymentRateNotice;
  function paymentSettingsActive() {
    return S.route === paymentSettingsRoute && canManageOrders();
  }
  function paymentSettingsView() {
    const key = 'commerce-payment-settings-view';
    if (!S.drafts.has(key)) S.drafts.set(key, { tab: 'paid', currency: 'PHP', product: 'GPT' });
    return S.drafts.get(key);
  }
  const paidPricesDraft = (product, code) => product === 'GPT' ? 'commerce-gpt-paid-prices:' + code
    : `commerce-paid-prices:${product}:${code}`;
  const countryChoices = () => Object.keys(paymentCountries).map(code => [code, paymentCountryLabel(code)]);

  function renderPaymentSettings() {
    if (!paymentSettingsActive()) return A.header('代付国家', '') + A.empty('当前账号无权管理订单设置', '');
    const { tab, currency, product = 'GPT' } = paymentSettingsView();
    const navigation = `<div class="tabs" role="tablist" aria-label="订单设置">${paymentSettingsTabs.map(([id, label]) =>
      `<button type="button" class="tab${tab === id ? ' active' : ''}" role="tab" aria-selected="${tab === id}" data-action="commerce-payment-settings-tab" data-tab="${id}">${label}</button>`
    ).join('')}</div>`;
    let body;
    if (tab !== 'paid') {
      const action = tab === 'sale' ? 'commerce-price-settings' : 'commerce-currency-settings';
      const label = tab === 'sale' ? '套餐售价' : '币种';
      body = `<div class="panel-body"><div class="toolbar-right">${orderSettingsFamilies.map(family =>
        A.button(`${family} ${label}设置`, action, '', 'settings', `data-product="${family}"`)
      ).join('')}</div></div>`;
    } else if (paymentSettingsVersion === null) {
      body = `<div class="panel-body" role="status">${paymentSettingsError
        ? E(paymentSettingsError) + A.button('重试', 'commerce-paid-settings-retry')
        : '正在读取代付价格…'}</div>`;
    } else {
      const key = paidPricesDraft(product, currency), draft = S.drafts.get(key) || {};
      const prices = orderPaidPrices(product);
      const fields = productPlans[product].map((plan, index) => {
        const id = `paid-price-${index}`;
        const amount = input(id, draft[`commerce-${id}`] ?? prices[plan]?.[currency] ?? '',
          `data-paid-price inputmode="decimal" maxlength="21" aria-label="${E(plan)} 原币代付金额" placeholder="未配置"`);
        const budget = `<p class="footnote paid-price-budget"><span>人民币预算</span>
          <output data-paid-budget for="commerce-${id}">—</output></p>`;
        return field(plan, id, amount + budget);
      }).join('');
      const rates = `<div class="toolbar-left"><p class="footnote" id="commerce-paid-quote" role="status"></p>
        ${localData ? A.button('刷新汇率', 'commerce-paid-rates-retry') : ''}</div>`;
      body = `<div class="panel-body order-price-groups">
        <div class="commerce-field-grid">
          ${field('国家／地区', 'paid-country', select('paid-country', countryChoices(), currency))}
          ${field('产品', 'paid-product', select('paid-product', Object.keys(productPlans), product))}
        </div>
        ${paymentSettingsError ? `<p class="footnote" role="status">${E(paymentSettingsError)}</p>` : ''}
        <form id="commerce-paid-prices-form" data-commerce-draft="${key}"${S.drafts.has(key) ? ' data-paid-price-dirty="yes"' : ''} novalidate>
          ${input('paid-price-product', product, 'type="hidden"')}
          ${input('paid-price-currency', currency, 'type="hidden"')}
          ${input('paid-price-version', draft['commerce-paid-price-version'] ?? paymentSettingsVersion, 'type="hidden"')}
          ${priceCurrencyGroup(currency, paymentCountryLabel(currency), rates + `<div class="commerce-field-grid paid-price-fields">${fields}</div>`)}
          <div class="form-footer">${A.button('读取最新', 'commerce-paid-settings-reload')}<button type="submit" class="button primary">保存代付价格</button></div>
        </form></div>`;
    }
    return A.header('代付国家', '维护各产品的银行卡代付价格、套餐售价及订单币种。折合人民币仅用于预算。') +
      `<section class="panel">${navigation}${body}</section>`;
  }

  function loadPaymentSettings(resetDraft) {
    if (!localData || paymentSettingsLoad) return paymentSettingsLoad;
    paymentSettingsLoad = loadPrices().then(snapshot => {
      if (snapshot) {
        paymentSettingsVersion = snapshot.version;
        paymentSettingsError = '';
        if (resetDraft) {
          const { key, submitted } = resetDraft;
          const form = $('#commerce-paid-prices-form');
          const currentForm = form?.dataset.commerceDraft === key ? form : null;
          const current = currentForm ? readCommerceDraft(currentForm) : S.drafts.get(key);
          if (!current || JSON.stringify(current) === submitted) {
            currentForm?.removeAttribute('data-commerce-draft');
            S.drafts.delete(key);
          }
        }
      } else paymentSettingsError = '代付价格读取失败，请重试。';
      if (paymentSettingsActive() && paymentSettingsView().tab === 'paid' && !$('#drawer')?.open) {
        saveDrafts();
        A.render();
      }
    }).finally(() => { paymentSettingsLoad = null; });
    return paymentSettingsLoad;
  }

  function updatePaymentBudgets() {
    clearTimeout(paymentExpiryTimer);
    if (!paymentSettingsActive()) return;
    const form = $('#commerce-paid-prices-form'), status = $('#commerce-paid-quote');
    if (!form || !status) return;
    const code = form.elements['commerce-paid-price-currency'].value;
    const row = paymentRates?.rows.find(quote => quote.currency === code);
    const now = paymentRates ? paymentRates.at + performance.now() - paymentRates.received : 0;
    const expiry = Date.parse(row?.expiresAt);
    const valid = row?.status === 'valid' && expiry > now && Number.isFinite(Date.parse(row.at)) &&
      /^\d{1,20}(?:\.\d{1,8})?$/.test(row.rate) && M.units(row.rate, 8) > 0n;
    status.textContent = valid
      ? `每 1 ${code} 折合 ${row.rate} CNY · ${row.source} · ${beijingClock.format(new Date(row.at))}${paymentRateError ? '。' + paymentRateError : ''}`
      : paymentRateError || (
        row?.rate ? '汇率已过期，等待汇率采集更新。' :
          paymentRateLoad ? '正在读取系统汇率…' : '暂无有效汇率，请在汇率采集中核对。');
    const rateUnits = valid ? M.units(row.rate, 8) : 0n;
    const centDivisor = 10n ** 10n; // Four amount decimals and eight rate decimals, rounded once to cents.
    for (const output of form.querySelectorAll('[data-paid-budget]')) {
      const amount = form.elements[output.getAttribute('for')].value.trim();
      output.textContent = valid && amount && amountValid(amount)
        ? `¥ ${M.formatUnits((M.units(amount) * rateUnits + centDivisor / 2n) / centDivisor, 2)}`
        : '—';
    }
    if (valid)
      paymentExpiryTimer = setTimeout(updatePaymentBudgets, Math.min(2_147_000_000, expiry - now + 10));
  }
  function loadPaymentRates() {
    if (!localData || !paymentRatesStale || paymentRateLoad) return paymentRateLoad;
    paymentRatesStale = false;
    paymentRateError = '';
    paymentRateLoad = localData.financeCollection({ tab: 'rates', page: '1', pageSize: '8' }).then(result => {
      if (!Array.isArray(result?.rows) || !Number.isFinite(Date.parse(result.now))) throw new Error();
      paymentRates = { rows: result.rows, at: Date.parse(result.now), received: performance.now() };
    }).catch(() => {
      paymentRateError = '系统汇率读取失败，可点击「刷新汇率」重试。';
    }).finally(() => {
      paymentRateLoad = null;
      updatePaymentBudgets();
      if (paymentRatesStale && paymentSettingsActive()) void loadPaymentRates();
    });
    updatePaymentBudgets();
    return paymentRateLoad;
  }
  async function savePaidPrices(form, confirmed = '') {
    if (!paymentSettingsActive() || form.getAttribute('aria-busy') === 'true') return;
    const raw = readCommerceDraft(form), submitted = JSON.stringify(raw), actor = currentOperator().id;
    const code = raw['commerce-paid-price-currency'], product = raw['commerce-paid-price-product'];
    if (!Object.hasOwn(paymentCountries, code) || !Object.hasOwn(productPlans, product)) return;
    const plans = productPlans[product];
    const amounts = [...form.querySelectorAll('[data-paid-price]')].map(control => {
      const amount = control.value.trim();
      A.setError(control.id, amountValid(amount, true) ? '' : '请输入非负金额，最多四位小数');
      return amount;
    });
    if (amounts.length !== plans.length || amounts.some(amount => !amountValid(amount, true))) return;
    if (!confirmed) {
      A.confirmAction('确认保存代付价格', `更新 ${product} 在${paymentCountries[code]}的银行卡代付参考价。`, () => {
        if (form.isConnected && currentOperator().id === actor && JSON.stringify(readCommerceDraft(form)) === submitted)
          void savePaidPrices(form, submitted);
        else A.notify('输入或登录身份已变化，请重新核对后保存');
      });
      return;
    }
    form.setAttribute('aria-busy', 'true');
    const feedback = A.beginActionFeedback(form.querySelector('button[type="submit"]'), '正在保存…');
    try {
      const snapshot = localData ? await localData.load('settings') : { version: paymentSettingsVersion, data: currencySettings };
      if (!form.isConnected || currentOperator().id !== actor || !paymentSettingsActive()) return;
      if (snapshot.version !== Number(raw['commerce-paid-price-version']))
        throw new Error('代付价格已在其他页面更新，草稿已保留。请读取最新设置后核对。');
      const next = safeClone(orderPaidPrices(product, snapshot.data ?? null));
      plans.forEach((plan, index) => { (next[plan] ||= {})[code] = amounts[index]; });
      const data = { ...(snapshot.data || { costSettings: safeClone(costSettings), mailboxTypes: A.modules.operations?.getMailboxTypes?.() || [] }) };
      const [priceKey, action] = paidPriceSetting(product);
      data[priceKey] = product === 'GPT' ? next : { ...data[priceKey], [product]: next };
      const result = localData ? await localData.save('settings', snapshot.version, data, { action })
        : { version: snapshot.version + 1, data };
      const savedPrices = orderPaidPrices(product, result.data ?? null);
      if (result.version <= snapshot.version || plans.some((plan, index) => savedPrices[plan]?.[code] !== amounts[index]))
        throw new Error('尚未确认代付价格保存成功，请重新读取核对。');
      if (currentOperator().id !== actor) return;
      currencySettingsRevision++;
      priceLoad = null;
      currencySettings = result.data;
      paymentSettingsVersion = result.version;
      const key = form.dataset.commerceDraft;
      const current = form.isConnected ? readCommerceDraft(form) : S.drafts.get(key);
      if (JSON.stringify(current) === confirmed) S.drafts.delete(key);
      else if (current) S.drafts.set(key, { ...current, 'commerce-paid-price-version': String(result.version) });
      if (form.isConnected) {
        form.removeAttribute('data-commerce-draft');
        A.render();
      }
      A.notify(`${product} 代付价格已保存`);
    } catch (error) { A.notify(error.message || '代付价格未保存，输入已保留'); }
    finally { form.removeAttribute('aria-busy'); feedback?.finish(); }
  }
  const salePriceTypes = [['orderPrices', '续费售价'], ['stockOrderPrices', '成品号售价']];
  function selectSalePriceGroup(form, type, currency = form.elements['commerce-price-currency'].value) {
    if (!salePriceTypes.some(([key]) => key === type)) return;
    form.elements['commerce-price-type'].value = type;
    form.elements['commerce-price-currency'].value = currency;
    for (const panel of form.querySelectorAll('[data-price-panel]')) panel.hidden = panel.dataset.pricePanel !== type;
    for (const group of form.querySelectorAll('[data-price-group]')) group.hidden = group.dataset.priceGroup !== currency;
    for (const tab of form.parentElement.querySelectorAll('[data-action="commerce-price-type"]')) {
      const selected = tab.dataset.tab === type;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }
  }
  async function openPrices(product) {
    if (!paymentSettingsActive()) return;
    const route = S.route;
    const context = S.drawerContext;
    const actorId = currentOperator().id;
    const choices = cardPoolProduct(product) ? [product] : ['Claude Pro', 'Claude Max'];
    let snapshot;
    try {
      snapshot = localData ? await localData.load('settings') : { version: 0, data: { ...currencySettings, orderPrices } };
    } catch (error) {
      A.notify(error.message || '未能读取套餐售价，请重试');
      return;
    }
    if (S.route !== route || S.drawerContext !== context || currentOperator().id !== actorId) return;
    currencySettings = snapshot.data || {};
    if (localData) orderPrices = snapshot.data?.orderPrices || {};
    const key = `commerce-prices:${currencyFamily(product).toLowerCase()}`;
    const draft = S.drafts.get(key) || {};
    const activeType = draft['commerce-price-type'] === 'stockOrderPrices' ? 'stockOrderPrices' : 'orderPrices';
    const currencyOptions = currencyChoices(orderCurrencyCodes(product), '', product);
    const savedCurrency = draft['commerce-price-currency'];
    const activeCurrency = currencyOptions.some(([code]) => code === savedCurrency) ? savedCurrency : currencyOptions[0]?.[0];
    const renewalLabel = personalProduct(product) ? '开通／续费' : '续费';
    const types = salePriceTypes.map(([type, label]) => [type,
      type === 'orderPrices' ? `${renewalLabel}售价` : label]);
    const panels = types.map(([type, label]) => {
      const stock = type === 'stockOrderPrices';
      const groups = currencyOptions.map(([currency, name]) => {
        const rows = choices.flatMap(kind => productPlans[kind].map((plan, index) => {
          const fieldId = `${stock ? 'stock-' : ''}price-${kind === 'Claude Max' ? 'max' : 'base'}-${index}-${currency}`;
          const current = draft[`commerce-${fieldId}`] ?? orderPrice(kind, plan, currency, stock ? '成品交付' : '续费');
          return field(plan, fieldId, input(fieldId, current,
            `data-price-type="${type}" data-price-product="${E(kind)}" data-price-plan="${E(plan)}" data-price-currency="${E(currency)}" inputmode="decimal"`));
        })).join('');
        return priceCurrencyGroup(currency, name, `<div class="commerce-field-grid">${rows}</div>`, currency !== activeCurrency);
      }).join('');
      return `<div role="tabpanel" aria-label="${label}" data-price-panel="${type}"${type === activeType ? '' : ' hidden'}>${groups}</div>`;
    }).join('');
    A.openDrawer(`${currencyFamily(product)} 套餐售价设置`, `按币种分别维护${renewalLabel}与成品号售价。切换币种或售价类型会保留输入。录单按业务类型、套餐和币种带入，实际到账后再确认实收。`,
      tabs(types, activeType, 'commerce-price-type', 'aria-label="售价类型"') +
      `<form id="commerce-prices-form" class="form-section order-price-groups" data-commerce-draft="${key}" novalidate>
        ${input('price-version', draft['commerce-price-version'] ?? snapshot.version, 'type="hidden"')}
        ${input('price-type', activeType, 'type="hidden"')}
        <div class="commerce-field-grid">${field('币种', 'price-currency', select('price-currency', currencyOptions, activeCurrency))}</div>
        ${panels}</form>`,
      A.button('关闭', 'drawer-close') + '<button type="submit" form="commerce-prices-form" class="button primary">保存套餐售价</button>', key);
  }
  async function savePrices(form, confirmed = '') {
    if (!paymentSettingsActive() || form.getAttribute('aria-busy') === 'true') return;
    const values = [...form.querySelectorAll('[data-price-currency]')];
    const invalid = values.find((node) => !amountValid(node.value.trim(), true));
    if (invalid) {
      selectSalePriceGroup(form, invalid.dataset.priceType, invalid.dataset.priceCurrency);
      A.setError(invalid.id, '请输入非负金额，最多四位小数');
      invalid.focus();
      return;
    }
    const draft = JSON.stringify(readCommerceDraft(form));
    if (!confirmed) {
      A.confirmAction('确认更新套餐售价', '本次保存包含当前产品各币种的套餐售价。新订单会按业务类型、套餐和币种带入对应售价。', () => {
        if (form.isConnected && JSON.stringify(readCommerceDraft(form)) === draft) void savePrices(form, draft);
        else A.notify('售价输入已变化，请重新核对后保存');
      });
      return;
    }
    form.setAttribute('aria-busy', 'true');
    const key = form.dataset.commerceDraft;
    const actorId = currentOperator().id;
    const submitted = values.map((node) => ({ ...node.dataset, amount: node.value.trim() }));
    try {
      const version = Number(form.elements['commerce-price-version'].value);
      const snapshot = localData ? await localData.load('settings') : { version, data: { ...currencySettings, orderPrices } };
      if (!form.isConnected || currentOperator().id !== actorId || !paymentSettingsActive()) return;
      if (snapshot.version !== version) {
        form.elements['commerce-price-version'].value = snapshot.version;
        orderPrices = snapshot.data?.orderPrices || {};
        throw new Error('套餐售价已变化，请核对当前输入后重新保存');
      }
      const next = {
        orderPrices: safeClone(snapshot.data?.orderPrices || orderPrices),
        stockOrderPrices: safeClone(snapshot.data?.stockOrderPrices || {})
      };
      for (const { priceType, priceProduct, pricePlan, priceCurrency, amount } of submitted) {
        ((next[priceType][priceProduct] ||= {})[pricePlan] ||= {})[priceCurrency] = amount;
      }
      let savedVersion = version;
      if (localData) {
        const data = snapshot.data || {
          mailboxTypes: A.modules.operations?.getMailboxTypes?.() || [],
          costSettings: safeClone(costSettings)
        };
        const saved = await localData.save('settings', version, { ...data, ...next }, { action: 'order_prices_save' });
        if (saved.version <= version || submitted.some(({ priceType, priceProduct, pricePlan, priceCurrency, amount }) =>
          saved.data?.[priceType]?.[priceProduct]?.[pricePlan]?.[priceCurrency] !== amount))
          throw new Error('尚未确认套餐售价保存成功，请重新读取核对');
        savedVersion = saved.version;
      }
      if (currentOperator().id !== actorId) return;
      currencySettingsRevision++;
      currencySettings = { ...snapshot.data, ...next };
      orderPrices = next.orderPrices;
      paymentSettingsVersion = savedVersion;
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
  function orderCardPicker(v, hidden, { id = 'cardId', pool = v('product') === 'GPT', optional = false } = {}) {
    const selected = v(id);
    const choices = cardChoices(pool ? 'GPT' : 'Claude', v('tenantId'), selected, v('paymentId'));
    const actions = !localData ? '' : pool
      ? A.button('刷新', 'commerce-order-card-retry', 'compact', '', 'aria-label="刷新银行卡"')
      : A.button('读取', 'commerce-tenant-card-reveal', 'compact', '', 'aria-label="读取完整卡号"');
    const full = !pool && localData ? `<div class="field-row" data-commerce-card-revealed hidden><input type="text" readonly autocomplete="off" aria-label="完整银行卡号" data-commerce-card-number /><div>${A.button('复制', 'commerce-tenant-card-copy', '', '', 'aria-label="复制完整卡号"')}</div></div>` : '';
    const metadata = poolUsage(selected);
    const usage = pool && id === 'cardId' && localData ? `<p class="footnote" data-commerce-pool-usage${metadata ? '' : ' hidden'}>${E(metadata)}</p>` : '';
    const label = id === 'proPoolCardId' ? 'GPT 订阅卡池' : '银行卡';
    return field(label, id, searchableSelect(id, label, choices, selected, actions) + full + usage,
      !optional, !pool ? '选择租户后可搜索该租户的银行卡。' : '', '', hidden);
  }
  function clearRevealedCard(form) {
    const row = form.querySelector('[data-commerce-card-revealed]');
    if (!row) return;
    row.hidden = true;
    row.querySelector('[data-commerce-card-number]').value = '';
  }
  async function useTenantCard(form, action) {
    if (!canManageOrders()) return;
    if (orderCardSource(form)?.pool !== false) return;
    const tenantId = form.elements['commerce-tenantId'].value;
    const id = form.elements['commerce-cardId'].value;
    if (!tenantId || !id) {
      A.setError('commerce-cardId', '请先选择租户银行卡');
      return false;
    }
    try {
      const response = await localData.tenantCardAction({ action, tenantId, id });
      if (!form.isConnected || form.elements['commerce-tenantId'].value !== tenantId ||
          form.elements['commerce-cardId'].value !== id || orderCardSource(form)?.pool !== false) return;
      if (action === 'copy') await A.copyText(response.number, '银行卡号已复制');
      else {
        const row = form.querySelector('[data-commerce-card-revealed]');
        row.querySelector('[data-commerce-card-number]').value = response.number;
        row.hidden = false;
      }
      A.setError('commerce-cardId', '');
      return true;
    } catch (error) {
      if (form.isConnected) A.setError('commerce-cardId', error.message || '无法读取银行卡，请重试');
      return false;
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
      A.openDrawer('租户银行卡', `${row?.name || '租户'} · 已登记 ${items.length} 张，最多 99 张。`,
        `<form id="commerce-tenant-cards-form" novalidate><input type="hidden" name="tenant-id" value="${E(tenantId)}" /><div class="commerce-field-grid">${field('银行卡名称', 'tenant-card-label', input('tenant-card-label', '', 'maxlength="80" placeholder="如银行卡 1"'))}${field('银行卡号', 'tenant-card-number', input('tenant-card-number', '', 'inputmode="numeric" maxlength="32" autocomplete="off" data-no-draft'), true)}</div></form>${list}`,
        A.button('返回租户资料', 'commerce-contact-detail', '', 'return', `data-kind="tenant" data-id="${E(tenantId)}"`) +
          `<button type="submit" form="commerce-tenant-cards-form" class="button primary" ${items.length >= 99 ? 'disabled' : ''}>添加银行卡</button>`, 'commerce-tenant-cards');
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
  function personalBillingChannels(product, plan) {
    return personalSeries(product, plan) === 'x_subscription' ? billingChannels.slice(0, 2) : billingChannels;
  }
  function priorGrokChoices(customerId) {
    return [['', '独立订阅，无原单'], ...orders.filter(row => row.product === 'Grok' &&
      row.customerId === customerId && !row.cancelled && personalSeries(row.product, row.plan) !== 'x_subscription')
      .map(row => [row.id, `${row.orderNo} · ${orderIdentity(row)} · ${row.plan}`])];
  }
  function personalBillingFields(v) {
    return field('购买渠道', 'billingChannel', select('billingChannel',
      personalBillingChannels(v('product'), v('plan')), v('billingChannel')), true) +
      field('账单地区', 'billingCountry', input('billingCountry', v('billingCountry'), 'maxlength="100"')) +
      field('账单交易编号', 'billingReceipt', input('billingReceipt', v('billingReceipt'), 'maxlength="160"'),
        false, '实际付款确认时填写本笔交易编号。账单有多笔交易时可填写账单号和明细编号。') +
      field('计费周期', 'billingCycle', select('billingCycle',
        [['month', '月付'], ['year', '年付'], ['other', '按实际账期']], v('billingCycle')), true) +
      field('自动续费', 'autoRenew', select('autoRenew', autoRenewChoices, v('autoRenew'))) +
      field('下次扣款时间', 'nextChargeAt', input('nextChargeAt', dateInput(v('nextChargeAt')), 'type="datetime-local"')) +
      field('权益核对', 'entitlementStatus', select('entitlementStatus', openingChoices, v('entitlementStatus')), true) +
      (v('product') === 'Grok' ? field('切换前订单', 'previousSubscriptionOrderId',
        select('previousSubscriptionOrderId', priorGrokChoices(v('customerId')), v('previousSubscriptionOrderId'))) +
        field('原订阅自动续费', 'previousAutoRenew', select('previousAutoRenew', autoRenewChoices, v('previousAutoRenew'))) : '');
  }
  function orderPaymentFields(v, existing) {
    const auto = automaticOrder(existing);
    const apple = v('payment') === '苹果内购';
    const product = v('product'), codes = orderCurrencyCodes(product);
    const personal = personalProduct(product);
    const proBank = isProBankOrder({ product, payment: v('payment') });
    const proMode = v('proMaterialMode');
    const proLocked = proPaymentSourceLocked(existing);
    const proChoices = [
      ...(isProBankOrder(existing) && !proMaterialMode(existing) ? [['', '沿用原订单资料']] : []),
      ...Object.entries(proMaterialLabels)
    ].filter(([mode]) => !proLocked || mode === proMaterialMode(existing));
    const match = appleMatch(v('plan'), v('appleMatchMin'), v('appleMatchMax'));
    const appleSelection = {
      id: existing?.id, product: v('product'), plan: v('plan'), businessType: v('businessType'),
      email: v('email'), paidAmount: v('paidAmount'), appleMatchMin: match[0], appleMatchMax: match[1],
      ...(personal && { xHandle: v('xHandle'), loginMethod: v('loginMethod'), platformAccountId: v('platformAccountId') })
    };
    return (
      `<div class="commerce-span-all order-payment-options">` +
      (personal ? input('payment', v('payment'), 'type="hidden"') + personalBillingFields(v)
        : field('支付方式', 'payment', auto ? input('payment', v('payment'), 'readonly') : select('payment', ['银行卡', '苹果内购'], v('payment')), true)) +
      field('卡尾号', 'paymentId', input('paymentId', v('paymentId'), 'readonly'), false, '', '', apple || !cardPoolProduct(product)) +
      (cardPoolProduct(product) ? '' :
        field('填写方式', 'proMaterialMode', select('proMaterialMode', proChoices, proMode), true, '', '', !proBank) +
        field('银行卡号', 'proCardNumber', input('proCardNumber', v('proCardNumber'),
          `inputmode="numeric" maxlength="32" autocomplete="off"${proLocked && proMode === 'manual_card' ? ' readonly' : ''}`),
          true, '', '', !proBank || proMode !== 'manual_card') +
        field('卡序列号', 'proCardSerial', input('proCardSerial', v('proCardSerial'), 'maxlength="120" autocomplete="off"'),
          true, '业务登记编号，可保留前导零。', '', !proBank || proMode !== 'manual_card')) +
      (cardPoolProduct(product) && !auto ? orderCardPicker(v, apple, { pool: true, optional: !personal }) : '') +
      (!cardPoolProduct(product) ? orderCardPicker(v, !proBank || proMode !== 'pool_card', { id: 'proPoolCardId', pool: true }) : '') +
      field(
        '苹果 ID',
        'appleIdId',
        searchableSelect('appleIdId', '苹果 ID', appleOptions(v('appleIdId'), appleSelection), v('appleIdId')),
        true,
        v('businessType') === '续费' ? '续费选择原订阅使用的苹果 ID。' : '仅显示符合余额条件且未用于订阅的苹果 ID。',
        '',
        !apple
      ) +
      (personal ? field('旧订阅核对', 'appleOriginalVerified',
        `<label class="checkbox-label"><input id="commerce-appleOriginalVerified" name="commerce-appleOriginalVerified" type="checkbox" ${v('appleOriginalVerified') ? 'checked' : ''} />已凭原 App Store 账单核对该付款 ID</label>`, false, '', '', !apple || v('businessType') !== '续费') +
        field('旧订阅交易编号', 'appleOriginalReceipt', input('appleOriginalReceipt', v('appleOriginalReceipt'), 'maxlength="160"'),
          false, '', '', !apple || v('businessType') !== '续费') +
        (product === 'Gemini' ? field('Google 账号核对', 'appleGoogleVerified',
          `<label class="checkbox-label"><input id="commerce-appleGoogleVerified" name="commerce-appleGoogleVerified" type="checkbox" ${v('appleGoogleVerified') ? 'checked' : ''} />已核对付款 Apple ID 对应上方 Google 账号</label>`,
          false, '', '', !apple) : '')
        : field('余额下限（USD）', 'appleMatchMin', input('appleMatchMin', match[0], 'inputmode="decimal"'),
        false, '', '', !apple || v('businessType') === '续费') +
      field('余额上限（USD）', 'appleMatchMax', input('appleMatchMax', match[1], 'inputmode="decimal" placeholder="留空不限"'),
        false, '', '', !apple || v('businessType') === '续费')) +
      orderCardTypeField(v, existing) +
      `</div>` +
      `<div class="order-financial-groups commerce-span-all">
        <div class="order-financial-group">
          ${orderAmountHeading('代付', true, v)}
          ${field(!auto && gptCardPayment(product, v('payment')) ? '国家／地区' : '代付币种', 'paidCurrency',
            auto ? input('paidCurrency', v('paidCurrency') ? currencyLabel(v('paidCurrency')) : '',
              `readonly placeholder="待核对" data-currency-code="${E(v('paidCurrency'))}"`)
              : select('paidCurrency', paidCurrencyChoices(product, v('payment'), apple ? 'USD' : v('paidCurrency')),
                apple ? 'USD' : v('paidCurrency')), true)}
          ${field('代付金额', 'paidAmount', orderAmountInput(v, 'paidAmount', auto), true)}
        </div>
        <div class="order-financial-group">
          ${orderAmountHeading('售卖', false, v)}
          ${field('售卖币种', 'saleCurrency', select('saleCurrency', currencyChoices(codes, v('saleCurrency'), product), v('saleCurrency')), true)}
          ${field('售卖金额', 'saleAmount', orderAmountInput(v, 'saleAmount'), true)}
        </div>
        <div class="order-financial-group">
          <div class="order-financial-heading"><h3>订阅周期</h3>${auto ? '' : `<div class="order-financial-actions">${[[15, '15分钟前'], [60, '1小时前'], [120, '2小时前']].map(([minutes, label]) => A.button(label, 'commerce-order-start-shortcut', '', '', `data-minutes="${minutes}"`)).join('')}</div>`}</div>
          ${field('订阅时间', 'start', input('start', dateInput(v('start')), auto ? 'type="datetime-local" readonly' : 'type="datetime-local"'),
            true, '本次实际开通时间，只登记一次。')}
          ${field('到期时间', 'expiry', input('expiry', dateInput(v('expiry')), auto ? 'type="datetime-local" readonly' : 'type="datetime-local"'), true)}
        </div>
      </div>` +
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
        select('actualCostCurrency', currencyChoices(currencies, v('actualCostCurrency'), v('product')), v('actualCostCurrency')),
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
        select('emailCostCurrency', currencyChoices(currencies, v('emailCostCurrency'), v('product')), v('emailCostCurrency') || 'CNY')
      ) +
      (v('product') === 'GPT' && v('payment') === '银行卡'
        ? '<p class="footnote commerce-span-all">开卡费按卡记录，并按该卡已确认开通的订单分摊。</p>' : '') +
      '</div></details>'
    );
  }
  function orderEditor(orderId = '', renewalId = '', main = false, workbenchSource = null, pageProduct = '') {
    const existing = orders.find((row) => row.id === orderId);
    const candidate = workbenchSource?.order || orders.find((row) => row.id === renewalId);
    const previous = workbenchSource?.order || (claudeAccountTracked(candidate) ? candidate : null);
    if (renewalId && !previous) {
      A.notify('快捷续费需要已记录邮箱的 Claude 订单，请直接提交独立新订单。');
      return '';
    }
    const key = workbenchSource ? `commerce-order:workbench:${previous.id}` :
      main ? entryDraft(pageProduct) : `commerce-order:${orderId || `renew:${renewalId}`}`;
    const legacyDraft = S.drafts.get('commerce-order:new');
    const draft = S.drafts.get(key) || (main && !previous && legacyDraft &&
      entryRoute(legacyDraft['commerce-product']) === entryRoute(pageProduct) ? legacyDraft : {});
    const products = existing || previous ? [existing?.product || previous.product] :
      pageProduct === 'GPT' || personalProduct(pageProduct) ? [pageProduct] : ['Claude Pro', 'Claude Max'];
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
        'cardTypeId',
        'cardTypeName',
        'paidAmount',
        'paidCurrency',
        'emailCostAmount',
        'emailCostCurrency'
      ])
        base[name] = previous[name] ?? base[name];
      base.businessType = '续费';
      base.claudeRenewalId = isClaude(previous) ? previous.id : '';
      if (previous.product === 'Claude Pro') base.proRenewalSourceVersion = previous.version;
      base.start = dateInput(now());
      base.expiry =
        isClaude(previous) && parseDate(previous.expiry) > parseDate(base.start)
          ? A.addCalendarMonth(dateInput(previous.expiry))
          : A.addCalendarMonth(base.start);
      base.appleIdId = previous.payment === '苹果内购' ? previous.appleIdId || '' : '';
      base.paymentId = previous.payment === '苹果内购' ? previous.paymentId : '';
      base.cardId = '';
      if (isProBankOrder(previous) && proMaterialMode(previous))
        base.proMaterialMode = proMaterialMode(previous);
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
      if (personalProduct(previous.product)) {
        for (const key of ['accountId', 'xHandle', 'xLinkState', 'loginMethod', 'platformAccountId',
          'billingChannel', 'billingCountry', 'billingCycle', 'autoRenew']) base[key] = previous[key] || base[key];
        base.personalHistoryId = previous.id;
        base.start = '';
        base.expiry = '';
        base.paidAmount = '';
      }
    }
    const booleanFields = [
      'paidConfirmed',
      'receiptConfirmed',
      'costConfirmed',
      'includeIssueFee',
      'balanceReversalConfirmed',
      'appleOriginalVerified',
      'appleGoogleVerified'
    ];
    const originalPlan = draft['commerce-plan'] ?? base.plan;
    const nextPlan = existing || personalProduct(initialProduct) ? originalPlan : normalizedPlan(originalPlan);
    const plan = orderPlanChoices(initialProduct, nextPlan, existing).includes(nextPlan) ? nextPlan : productPlans[initialProduct][0];
    const v = (name) =>
      name === 'product' ? initialProduct : name === 'plan' ? plan :
      name === 'proMaterialMode' ? (draft['commerce-proMaterialMode'] ??
        (isProBankOrder(existing) ? proMaterialMode(existing) : base.proMaterialMode || 'manual_card')) :
      name === 'proPoolCardId' ? (draft['commerce-proPoolCardId'] ??
        (proMaterialMode(existing) === 'pool_card' ? existing.cardId : '')) :
      name === 'cardId' && proMaterialMode(existing) === 'pool_card' ? (draft['commerce-cardId'] ?? '') :
      name === 'appleMatchMax' || name === 'appleMatchMin' ? draft[`commerce-${name}`] ?? base[name] :
      name === 'saleAmount' && !existing && !draft['commerce-saleManual'] && draft['commerce-receiptConfirmed'] !== 'on' ?
        orderPrice(initialProduct, plan, draft['commerce-saleCurrency'] || base.saleCurrency,
          draft['commerce-businessType'] ?? base.businessType) :
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
    const activeProMode = proMaterialMode({ product, payment: v('payment'), proMaterialMode: v('proMaterialMode') });
    const personnel =
      '<div class="commerce-span-all order-wide-fields">' +
      field(
        '认证人',
        'tenantId',
        searchableSelect('tenantId', '租户', [['', '未关联租户'], ...tenants.filter((row) => row.active || row.id === v('tenantId')).map((row) => [row.id, `${row.name} · ${row.phone}`])], v('tenantId'), A.button('新增', 'commerce-quick-tenant', '', 'plus'))
      ) +
      (product !== 'GPT' ? orderCardPicker(v, v('payment') !== '银行卡' || (activeProMode && activeProMode !== 'tenant_card')) : '') +
      '</div>' +
      field('认证电话', 'verifierPhone', input('verifierPhone', selectedTenant?.phone || existing?.verifierPhone || '', 'readonly')) +
      field('认证状态', 'kyc', select('kyc', ['未认证', 'KYC 认证'], v('kyc'))) +
      field('订阅电话', 'phone', input('phone', v('phone'), 'type="tel" maxlength="60"'));
    const saleCurrencyChosen = existing || draft['commerce-saleCurrencyChosen'] === 'yes';
    const html = `<form id="commerce-order-form" data-commerce-draft="${key}" novalidate><input type="hidden" id="commerce-id" name="commerce-id" value="${E(existing?.id || '')}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || existing?.version || '')}" /><input type="hidden" name="commerce-source" value="${E(existing?.source || '管理员手工')}" /><input type="hidden" name="commerce-emailCostManual" value="${E(draft['commerce-emailCostManual'] || '')}" /><input type="hidden" name="commerce-paidManual" value="${E(draft['commerce-paidManual'] ?? (draft['commerce-paidAmount'] ? 'yes' : ''))}" /><input type="hidden" name="commerce-saleManual" value="${E(draft['commerce-saleManual'] || '')}" /><input type="hidden" name="commerce-saleCurrencyChosen" value="${saleCurrencyChosen ? 'yes' : ''}" /><input type="hidden" id="commerce-claudeRenewalId" name="commerce-claudeRenewalId" value="${E(v('claudeRenewalId'))}" />${previous?.product === 'Claude Pro' ? input('proRenewalSourceVersion', v('proRenewalSourceVersion'), 'type="hidden"') : ''}${section('01', '客户与账号', orderIdentityFields(v, contact, existing, products), '订单邮箱独立记录；客户自有账号不要求存在库存，成品交付才选择可用账号。')}${section('02', '金额与订阅周期', orderPaymentFields(v, existing) + orderCostFields(v, existing))}${personalProduct(product) ? '' : section('03', 'Claude 人员与补充资料', personnel, '认证电话由所选租户带出，订阅电话按实际开通填写。', product === 'GPT' || !showProPeople(activeProMode))}<div class="commerce-field-grid">${existing ? field('更正原因', 'correctionReason', input('correctionReason', draft['commerce-correctionReason'] ?? '修改错误'), true, '', 'commerce-span-all') : ''}${field('备注', 'notes', `<textarea id="commerce-notes" name="commerce-notes" rows="2">${E(v('notes'))}</textarea>`, false, '', 'commerce-span-all')}</div></form>`;
    const footer = `<span class="footnote">${personalProduct(product) ? '可分别确认实际代付、实收和开通。' : localData ? '订单保存到数据库。' : '订单独立保存；确认代付才记苹果余额支出。'}</span>${A.button(personalProduct(product) ? '保存待核对' : '保留待补全', 'commerce-order-pending')}<button form="commerce-order-form" type="submit" class="button primary">核对并保存</button>`;
    if (main)
      return entryWorkspace(`<section class="panel form-panel">${html}<div class="form-footer">${footer}</div></section>`, 'order', product);
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
    if (form) {
      if (personalProduct(product)) updateOrderVisibility(form);
      else updateCustomerEmailHistory(form);
    }
    if (form) void loadOrderOwners(form);
    if (form && v('payment') === '苹果内购') loadAppleOptions(form);
    if (form && v('payment') === '银行卡') void loadOrderCards(form);
    if (form && v('payment') === '银行卡') void loadOrderCardType(form);
    if (form) void loadPrices(form);
    return '';
  }
  function orderFromForm(form) {
    const raw = A.readForm(form),
      order = {};
    for (const [key, inputValue] of Object.entries(raw))
      if (key.startsWith('commerce-') && !['commerce-saleCurrencyChosen', 'commerce-saleManual', 'commerce-emailCostManual', 'commerce-proPoolCardId', 'commerce-card-type-touched', 'commerce-personalHistoryId'].includes(key))
        order[key.slice(9)] = String(inputValue).trim();
    for (const key of [
      'paidConfirmed',
      'receiptConfirmed',
      'costConfirmed',
      'includeIssueFee',
      'balanceReversalConfirmed'
    ])
      order[key] = raw[`commerce-${key}`] === 'on';
    const personal = personalProduct(order.product);
    order.accountSource = order.businessType === '成品交付' ? '库存' : '客户自有';
    if (personal) {
      order.loginMethod = form.elements['commerce-loginMethod']?.value || order.loginMethod;
      if (order.product === 'Grok' && order.email?.startsWith('@')) {
        order.loginMethod = 'x';
        order.xHandle = order.email;
        order.email = '';
      }
      order.subscriptionSeries = personalSeries(order.product, order.plan);
      order.payment = order.billingChannel === 'app_store' ? '苹果内购' : '银行卡';
      const appStore = order.payment === '苹果内购';
      const original = appStore && order.businessType === '续费' ? previousAppleOrder(order) : null;
      order.appleOriginalVerified = appStore && order.businessType === '续费' &&
        raw['commerce-appleOriginalVerified'] === 'on';
      if (!order.appleOriginalVerified) order.appleOriginalReceipt = '';
      order.appleGoogleVerified = appStore && order.product === 'Gemini' &&
        (raw['commerce-appleGoogleVerified'] === 'on' || Boolean(original?.appleGoogleVerified && order.appleIdId === original.appleIdId));
      if (order.businessType !== '成品交付' && order.businessType !== '续费') order.accountId = '';
      const past = orders.find(row => row.id === value(raw, 'personalHistoryId'));
      const prior = orders.find(row => row.id === order.id);
      order.previousOrderId = prior?.previousOrderId || (order.businessType === '续费' && past &&
        past.customerId === order.customerId && sameSubscriptionAccount(past, order) ? past.id : '');
      if (order.accountId) order.accountSource = '库存';
    } else if (order.businessType !== '成品交付') {
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
    if (cardPoolProduct(order.product)) {
      order.tenantId = '';
      order.ownerPhone = '';
      order.verifier = '';
      order.verifierPhone = '';
      order.phone = '';
      order.kyc = personal ? '' : '未认证';
    }
    if (isClaude(order)) {
      const existing = orders.find((row) => row.id === order.id);
      const tenant = tenants.find((row) => row.id === order.tenantId);
      const fallback = proMaterialMode(order) !== 'people' || order.tenantId === existing?.tenantId;
      order.verifier = tenant?.name || (fallback && existing?.verifier) || '';
      order.verifierPhone = tenant?.phone || (fallback && existing?.verifierPhone) || '';
      order.ownerPhone = existing?.ownerPhone || '';
    }
    const existingOrder = orders.find((row) => row.id === order.id);
    const mode = proMaterialMode(order);
    if (mode) {
      if (mode === 'pool_card') {
        order.cardId = value(raw, 'proPoolCardId');
        order.paymentId = cardTail(cards().find(row => row.id === order.cardId)) ||
          (existingOrder?.cardId === order.cardId ? existingOrder.paymentId : '');
      } else if (mode !== 'tenant_card') {
        order.cardId = '';
        order.paymentId = '';
      }
      if (mode === 'manual_card') {
        order.proCardNumber = String(order.proCardNumber || '').replace(/[\s-]/g, '');
      }
      if (!showProPeople(mode)) for (const name of ['tenantId', 'verifier', 'verifierPhone', 'phone', 'kyc']) order[name] = '';
    }
    pruneProMaterialFields(order);
    if (order.payment !== '银行卡') order.cardTypeId = '';
    else if (value(raw, 'card-type-touched') !== 'yes' && (existingOrder?.cardId || '') !== (order.cardId || ''))
      delete order.cardTypeId;
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
    if (!existingOrder && proMaterialMode(order) && order.businessType === '续费' && order.claudeRenewalId) {
      order.proRenewalSourceId = order.claudeRenewalId;
      order.proRenewalSourceVersion = Number(order.proRenewalSourceVersion);
    } else {
      delete order.proRenewalSourceVersion;
    }
    order.includeIssueFee = Boolean(cardPoolProduct(order.product) && order.payment === '银行卡' &&
      order.cardId && order.paidConfirmed && order.costBasis === 'standard' &&
      !cardIssueRecorded(order.cardId, order.id) && (cards().find((card) => card.id === order.cardId)?.usageCount || 0) === 0);
    return order;
  }
  function workbenchOrderSource(route) {
    const id = route.slice(renewalOrderPrefix.length);
    return renewalProjection().reminders.find((row) =>
      encodeURIComponent(row.order.id) === id && row.state !== 'processed');
  }
  const entryViewKey = (kind, product) => `commerce-entry-records:${kind}:${currencyFamily(product)}`;
  function entryView(kind, product) {
    const key = entryViewKey(kind, product);
    if (!S.drafts.has(key)) S.drafts.set(key, {
      period: 'all', from: '', to: '', page: 1, pageSize: window.IDPagination.defaultPageSize
    });
    return S.drafts.get(key);
  }
  function entryRecordRows(kind, product, view) {
    const rows = kind === 'order' ? orders.filter(row => currencyFamily(row.product) === currencyFamily(product))
      : kind === 'tenant' ? tenants : customers;
    const today = now().slice(0, 10);
    const yesterday = beijingClock.format(parseDate(today + ' 12:00') - 86_400_000).slice(0, 10);
    return rows.filter(row => {
      if (view.period === 'all') return true;
      const timestamp = parseDate(row.createdAt);
      if (!Number.isFinite(timestamp)) return false;
      const day = beijingClock.format(timestamp).slice(0, 10);
      if (view.period === 'today') return day === today;
      if (view.period === 'yesterday') return day === yesterday;
      return (!view.from || day >= view.from) && (!view.to || day <= view.to);
    }).sort((a, b) =>
      (parseDate(b.createdAt) || 0) - (parseDate(a.createdAt) || 0) || String(b.id).localeCompare(String(a.id))
    );
  }
  function entryRecordList(kind, product) {
    const view = entryView(kind, product);
    const rows = entryRecordRows(kind, product, view);
    const contacts = new Map(customers.map(row => [row.id, row]));
    const plans = new Map();
    if (kind !== 'order') for (const order of orders) {
      const id = kind === 'tenant' ? order.tenantId : order.customerId;
      if (!id || !order.plan) continue;
      if (!plans.has(id)) plans.set(id, new Set());
      plans.get(id).add([order.product, order.plan].filter(Boolean).join(' · '));
    }
    const records = rows.map(row => {
      const contact = kind === 'order' ? contacts.get(row.customerId) : row;
      const timestamp = parseDate(row.createdAt);
      return {
        id: row.id,
        name: contact?.name || (kind === 'order' ? '待补充客户' : '未命名资料'),
        ...Object.fromEntries(customerChannels.map(([key]) => [key, String(kind === 'order'
          ? row[key === 'phone' ? 'customerPhone' : key] || contact?.[key] || '' : row[key] || '').trim()])),
        plan: kind === 'order' ? [row.product, row.plan].filter(Boolean).join(' · ') : [...(plans.get(row.id) || [])].join('、'),
        ...(kind === 'order' ? { payment: row.payment || '' } : {}),
        notes: row.notes || '',
        submittedAt: Number.isFinite(timestamp) ? beijingClock.format(timestamp) : '时间未记录'
      };
    });
    const channels = customerChannels.filter(([key]) => records.some(row => row[key]));
    for (const row of records) row.contact = channels.filter(([key]) => row[key])
      .map(([key, label]) => `${key === 'wechat' ? '微信' : label}：${row[key]}`).join('；');
    const columns = [
      { id: 'name', label: kind === 'tenant' ? '租户' : '客户', long: true },
      ...(channels.length ? [{ id: 'contact', label: '联系方式', long: true, render: row => E(row.contact || '—') }] : []),
      { id: 'plan', label: '订阅套餐', long: true, render: row => E(row.plan || '—'),
        headerHelp: kind === 'order' ? '本条订单登记的产品与套餐。' : '按已关联订单展示登记的产品与套餐，不代表当前订阅仍然有效；开通证据在历史开通业务中查看。' },
      ...(kind === 'order' ? [{ id: 'payment', label: '支付方式', render: row => E(row.payment || '—') }] : []),
      { id: 'notes', label: '备注', long: true, render: row => E(row.notes || '—') },
      { id: 'submittedAt', label: '提交时间' },
      { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${
        A.textAction('详情', kind === 'order' ? 'commerce-order-detail' : 'commerce-contact-detail',
          `data-id="${E(row.id)}" data-kind="${kind}" aria-label="查看${E(row.name)}的录入记录"`)
      }${kind === 'order' ? '' : contactRecordActions(row.id, kind === 'tenant')}</div>` }
    ];
    view.page = Math.min(view.page, Math.max(1, Math.ceil(records.length / view.pageSize)));
    return A.table(columns, records.slice((view.page - 1) * view.pageSize, view.page * view.pageSize),
      '', `commerce-entry-${kind}-${currencyFamily(product)}`, {
        title: view.period === 'all' ? '暂无录入记录' : '所选时间暂无录入记录',
        description: view.period === 'all' ? '保存资料后可在这里查看。' : '可切换全部或调整日期范围。'
      }) + window.IDPagination.render({ id: 'commerce-entry-records', ...view, total: records.length });
  }
  function entryRecordFilters(kind, product) {
    const view = entryView(kind, product);
    return `<div class="entry-record-filters entry-periods" role="group" aria-label="录入时间">${[
        ['all', '全部'], ['today', '今日'], ['yesterday', '昨日'], ['custom', '选择日期']
      ].map(([id, label]) => A.button(label, 'commerce-entry-period', view.period === id ? 'primary' : '', '',
        `data-period="${id}" aria-pressed="${view.period === id}"${id === 'custom' ? ` aria-expanded="${Boolean(view.dateOpen || view.period === 'custom')}"` : ''}`)).join('')}</div>`;
  }
  function entryRecordDateRange(kind, product) {
    const view = entryView(kind, product);
    return `<div class="entry-date-range content-toolbar" ${view.dateOpen || view.period === 'custom' ? '' : 'hidden'}>
        <label>开始日期<input type="date" data-entry-date="from" aria-label="开始日期" value="${E(view.fromDraft ?? view.from)}" /></label>
        <label>结束日期<input type="date" data-entry-date="to" aria-label="结束日期" value="${E(view.toDraft ?? view.to)}" /></label>
        ${A.button('查询', 'commerce-entry-query', 'primary')}
        <p class="field-error" data-entry-date-error role="alert" hidden></p>
      </div>`;
  }
  function entryWorkspace(form, kind, product = '') {
    const title = kind === 'order' ? '最近订单' : kind === 'tenant' ? '最近租户' : '最近客户';
    const description = `按北京时间筛选提交时间，默认按最新录入排序。显示当前权限内${kind === 'order' ? currencyFamily(product) + ' 的' : ''}记录，支持分页。联系方式列只显示所选范围内已填写的渠道；长内容点击查看完整值。刷新和翻页不会清空左侧输入。`;
    return `<div class="commerce-entry-layout"><div class="commerce-entry-columns">${form}
      <aside class="panel entry-records" id="commerce-entry-records" data-kind="${kind}" data-product="${E(product)}" aria-labelledby="entry-records-title">
        <div class="panel-heading"><div class="section-title-row"><h2 id="entry-records-title">${title}</h2>${A.titleInfo(title, description, 'entry-records-help')}</div>
          <div class="entry-record-actions">${entryRecordFilters(kind, product)}
            ${localData ? A.button('刷新', 'commerce-entry-refresh', 'compact', '', 'aria-label="刷新最近录入记录"') : ''}</div></div>
        ${entryRecordDateRange(kind, product)}
        <div class="entry-record-region design-async-region"><div data-entry-progress role="status" hidden></div><div class="entry-record-list">${entryRecordList(kind, product)}</div></div>
        <p class="entry-record-error" data-entry-error role="status" hidden></p>
      </aside></div></div>`;
  }
  function updateEntryRecords() {
    const panel = $('#commerce-entry-records');
    if (!panel) return;
    const list = panel.querySelector('.entry-record-list');
    const content = entryRecordList(panel.dataset.kind, panel.dataset.product);
    if (list.innerHTML !== content) list.innerHTML = content;
  }
  function bindEntryRecords() {
    const panel = $('#commerce-entry-records');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = 'true';
    panel.addEventListener('id-pagination-change', event => {
      if (event.detail.id !== 'commerce-entry-records') return;
      event.stopPropagation();
      const view = entryView(panel.dataset.kind, panel.dataset.product);
      view.page = event.detail.page;
      view.pageSize = event.detail.pageSize;
      updateEntryRecords();
    });
  }
  function applyEntryPeriod(button) {
    const panel = button.closest('#commerce-entry-records');
    if (!panel) return;
    const view = entryView(panel.dataset.kind, panel.dataset.product);
    if (button.dataset.period === 'custom') {
      view.dateOpen = true;
      button.setAttribute('aria-expanded', 'true');
      panel.querySelector('.entry-date-range').hidden = false;
      panel.querySelector('[data-entry-date="from"]').focus();
      return;
    }
    if (button.dataset.period) {
      view.period = button.dataset.period;
      view.dateOpen = false;
    }
    else {
      const from = panel.querySelector('[data-entry-date="from"]');
      const to = panel.querySelector('[data-entry-date="to"]');
      const error = panel.querySelector('[data-entry-date-error]');
      const invalid = !from.value || !to.value || !from.validity.valid || !to.validity.valid || from.value > to.value;
      error.hidden = !invalid;
      if (invalid) {
        error.textContent = '请选择完整日期范围，结束日期不能早于开始日期。';
        (!from.value ? from : to).focus();
        return;
      }
      view.period = 'custom';
      view.from = from.value;
      view.to = to.value;
    }
    view.page = 1;
    panel.querySelector('.entry-record-filters').outerHTML = entryRecordFilters(panel.dataset.kind, panel.dataset.product);
    panel.querySelector('.entry-date-range').outerHTML = entryRecordDateRange(panel.dataset.kind, panel.dataset.product);
    updateEntryRecords();
    panel.querySelector(`[data-period="${view.period}"]`)?.focus({ preventScroll: true });
  }
  async function refreshEntryRecords(button) {
    const panel = button.closest('#commerce-entry-records');
    if (!panel || !localData) return;
    const error = panel.querySelector('[data-entry-error]');
    error.hidden = true;
    const read = A.beginRegionRead(panel.querySelector('.entry-record-region'), panel.querySelector('[data-entry-progress]'), { refreshButton: button });
    const ok = await loadLocalCommerce(true, true);
    if (read.current() && !ok) {
      error.textContent = '刷新失败，已保留上次记录。请重试。';
      error.hidden = false;
    }
    read.finish();
  }
  function renderOrderPage() {
    const renewal = S.route.startsWith(renewalOrderPrefix);
    const source = renewal ? workbenchOrderSource(S.route) : null;
    const product = source?.order.product || personalEntries[S.route] || (S.route === claudeOrderRoute ? 'Claude Pro' : 'GPT');
    return (
      A.header(
        isClaude({ product }) ? 'Claude 提交订单' : product + ' 提交订单',
        '客户、账号、金额和周期分组录入；短字段同排，保存前核对成本与来源。',
        renewal ? routeButton('返回续费管理', renewalRoute, '', 'return') : '',
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
      { id: 'email', label: personalProduct(product) ? '订阅账号' : '邮箱账号', class: 'email-cell', render: row => E(orderIdentity(row)) },
      { id: 'plan', label: '套餐' },
      ...(personalProduct(product) ? [
        { id: 'billingChannel', label: '购买渠道', render: row => E(labelOf(billingChannels, row.billingChannel)) },
        { id: 'entitlementStatus', label: '权益核对', render: row => E(labelOf(openingChoices, row.entitlementStatus)) }
      ] : []),
      { id: 'businessType', label: '业务类型' },
      { id: 'payment', label: '支付方式' },
      { id: 'cardTypeName', label: '银行卡类型', render: row => E(row.cardTypeName || '—') },
      { id: 'paymentId', label: '卡尾号 / ID' },
      ...(product === 'Claude Pro' ? [
        { id: 'proMaterialMode', label: '填写方式', render: (row) => E(proMaterialLabel(row)) },
        { id: 'proCardNumber', label: '银行卡号', render: (row) => E(row.proCardNumber || '—') },
        { id: 'proCardSerial', label: '卡序列号', render: (row) => E(proCardSerialLabel(row)) }
      ] : []),
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
  function personalOrderFilters(product) {
    return S.drafts.get('commerce-order-filters:' + product) || {};
  }
  function renderOrders(product) {
    const personal = personalProduct(product);
    const filters = personalOrderFilters(product);
    const filterControls = personal ? [
      ['plan', '套餐', productPlans[product]],
      ['payment', '付款', ['已付款', '付款待核对', '未登记付款']],
      ['expiry', '到期状态', ['有效', '已过期', '未开始', '待核对', '开通失败', '已终止']]
    ].map(([key, label, choices]) => `<label for="commerce-order-filter-${key}">${label}</label>${select('order-filter-' + key, [['', '全部' + label], ...choices], filters[key])}`).join('') : '';
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
        (!S.query || orderMatchesSearch(row, S.query)) &&
        (!filters.plan || row.plan === filters.plan) &&
        (!filters.payment || paymentStatus(row) === filters.payment) &&
        (!filters.expiry || subscriptionStatus(row) === filters.expiry)
    );
    return (
      A.header(
        `${product} 订单`,
        '查看订单、费用、到期及退款记录，待补全资料在原单上继续处理。',
        canManageOrders() ? A.button(
          isClaude({ product }) ? 'Claude 提交订单' : product + ' 提交订单',
          'commerce-new-product-order',
          'primary',
          'plus',
          `data-product="${product}"`
        ) : ''
      ) +
      `<section class="panel">${product === 'GPT' ? A.gptOrderTabs?.() || '' : ''}${tabs(
        [
          ['all', '当前订单'],
          ['pending', '待补全'],
          ['refunded', '有退款记录'],
          ['cancelled', '已撤单']
        ],
        moduleState.orderTab,
        'commerce-order-tab'
      )}${toolbar(product === 'Claude Pro' ? '搜索订单编号、邮箱、客户、卡号或序列号' : personal ? '搜索订单编号、账号、客户或账单' : '搜索订单编号、邮箱或客户', filterControls + columnSettingsButton(`commerce-orders-${product}`) + routeButton('订单统计', 'orders/statistics'), 'data-page-actions')}${product === 'GPT' ? syncedOrderReadNotice() : ''}${tableList(orderColumns(product), filtered, `commerce-orders-${product}`)}${quoteAttribution(filtered)}</section>`
    );
  }

  function orderMatchesSearch(row, query) {
    const base = `${row.email} ${row.orderNo} ${customerLabel(row.customerId)} ${orderOwnerName(row)} ${row.cardTypeName || ''}`;
    if (personalProduct(row.product)) return [base, orderIdentity(row), row.xHandle, row.plan, row.billingReceipt]
      .join(' ').toLowerCase().includes(query.toLowerCase());
    if (row.product !== 'Claude Pro') return base.includes(query);
    const fields = [base, row.paymentId, row.proCardNumber, row.proCardSerial, row.verifier,
      row.verifierPhone, row.phone, row.tenantId ? tenantLabel(row.tenantId) : ''];
    if (fields.some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase()))) return true;
    const digits = query.replace(/[\s-]/g, '');
    return /^\d+$/.test(digits) && String(row.proCardNumber || '').includes(digits);
  }

  function proCardSerialLabel(order) {
    return order.proCardSerial ||
      (proMaterialMode(order) === 'manual_card' && !canManageOrders() ? '仅管理员可查看' : '—');
  }

  function proOrderProperties(order) {
    if (!isProBankOrder(order)) return '';
    const mode = proMaterialMode(order);
    return property('填写方式', proMaterialLabel(order)) + (mode === 'manual_card'
      ? property('银行卡号', order.proCardNumber) + property('卡序列号', proCardSerialLabel(order)) : '') +
      (mode === 'people' ? property('订阅电话', order.phone) : '');
  }
  function personalOrderProperties(order) {
    const grok = order.product === 'Grok';
    const from = order.previousOrderId || order.previousSubscriptionOrderId;
    const prior = orders.find(row => row.id === from);
    const linked = (label, action, id) => A.textAction(label, action, 'data-id="' + E(id) + '"');
    const stockRoute = 'accounts/' + order.product.toLowerCase();
    return property('登录方式', labelOf(personalLoginChoices, order.loginMethod)) +
      (grok ? property('X @账号', order.xHandle) + property('X 绑定状态', labelOf(linkChoices, order.xLinkState)) : '') +
      property('平台账号编号', order.platformAccountId) +
      (order.accountId && A.canVisit(stockRoute)
        ? property('库存账号', linked('查看交付账号', 'inventory-detail', order.accountId), true) : '') +
      property('订阅系列', personalSeriesLabels[order.subscriptionSeries]) +
      property('购买渠道', labelOf(billingChannels, order.billingChannel)) +
      property('账单地区', order.billingCountry) + property('账单交易编号', order.billingReceipt) +
      (order.appleOriginalReceipt ? property('旧订阅交易编号', order.appleOriginalReceipt) : '') +
      (order.appleGoogleVerified ? property('Google 账号核对', '已核对付款 Apple ID 与订阅账号') : '') +
      property('计费周期', { month: '月付', year: '年付', other: '按实际账期' }[order.billingCycle]) +
      property('自动续费', labelOf(autoRenewChoices, order.autoRenew)) +
      property('下次扣款时间', order.nextChargeAt) +
      property('权益核对', labelOf(openingChoices, order.entitlementStatus)) +
      property('客户实收', order.receiptConfirmed ? '已确认' : '待核对') +
      (prior ? property(order.previousSubscriptionOrderId ? '切换前订单及回款' : '原续费订单',
        linked(prior.orderNo, 'commerce-order-detail', prior.id), true) : '') +
      (order.previousSubscriptionOrderId ? property('原订阅自动续费', labelOf(autoRenewChoices, order.previousAutoRenew)) : '') +
      (order.appleIdId && A.canVisit('accounts/apple-balances')
        ? property('苹果 ID 流水', linked('查看余额变动', 'apple-ledger', order.appleIdId), true) : '');
  }
  function orderDetail(id, activeTab = 'details', asPage = false) {
    const order = orders.find((row) => row.id === id);
    const personal = personalProduct(order?.product);
    const tracksAccount = personal || claudeAccountTracked(order);
    if (!tracksAccount && activeTab === 'renewals') activeTab = 'details';
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
              : `<div class="property-list">${property('订单编号', order.orderNo)}${property('来源入口', order.source)}${property('来源任务', order.taskId)}${property('产品 / 套餐', `${order.product} / ${order.plan}`)}${property('业务类型', order.businessType)}${property(personal ? '订阅账号' : '邮箱账号', orderIdentity(order))}${personal ? personalOrderProperties(order) : ''}${property('客户', customerLabel(order.customerId))}${automaticOrder(order) ? property('客户来源', order.customerSource || customers.find(row => row.id === order.customerId)?.source) : ''}${property('微信', order.wechat)}${property('客户电话', order.customerPhone)}${property('QQ', order.qq)}${property('WhatsApp', order.whatsapp)}${property('Telegram', order.telegram)}${property('支付方式', order.payment)}${order.payment === '银行卡' ? property('银行卡类型', order.cardTypeName) : ''}${property('卡尾号 / ID', order.paymentId)}${proOrderProperties(order)}${property('订阅时间', order.start)}${property('到期时间', order.expiry)}${property('归属人', orderOwnerName(order))}${personal ? '' : property('租户', tenantLabel(order.tenantId)) + property('认证人', order.verifier) + property('认证电话', order.verifierPhone) + property('验证状态', order.kyc)}${property('付款状态', paymentStatus(order))}${property('历史付款证据', hasPaymentHistory(order) ? '已保留实际付款记录，更正复选框不会删除' : '未登记实际付款')}${property('资料完整性', orderStatus(order))}${property('订阅状态', subscriptionStatus(order))}${property('退款状态', refundStatus(order))}${property('账号运营状态', accountStatus(order))}${property('订单业务状态', order.cancelled ? '已撤单' : '正常')}${property('待核对', pendingReasons(order).join('、') || '资料已核对')}${traceProperties(order)}${property('备注', order.notes)}</div>`;
    const detailBody = `<div class="tabs" role="tablist"${asPage ? ' data-page-actions="tabs"' : ''}>${[
      ['details', '资料'],
      ['costs', '成本与汇率'],
      ['refunds', '退款记录'],
      ...(tracksAccount ? [['renewals', '同账号订单']] : []),
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
            orderListRoute(order.product)
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
    const ms = parseDate(iso);
    return Number.isFinite(ms)
      ? new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
      : '待核对';
  }
  function quoteAttribution(rows) {
    if (!localData || !finance?.automaticProvider ||
        !rows.some((row) => row.fxSnapshot?.provider === finance.automaticProvider.id)) return '';
    return `<p class="footnote panel-body"><a href="${E(finance.automaticProvider.attributionUrl)}" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a></p>`;
  }
  const accountingLabel = (basis) => basis === 'actual' ? '实账核算' : '参考核算';
  const quoteBasisLabel = (snapshot) => snapshot?.kind === 'automatic' || snapshot?.basis === 'reference'
    ? '历史市场参考报价' : snapshot?.basis === 'settlement' ? '实际结算凭据' : '历史登记报价';

  function localCostDetail(order) {
    const result = localAccounting(order);
    const pending = pendingReasons(order, result);
    const amount = (value) => `${display(value)} ${currencyLabel(result.currency)}`;
    const snapshot = order.fxSnapshot;
    const issue = result.cardIssue;
    const allocation = issue ? property('开卡成本分摊依据',
      `同卡已确认开通 ${issue.count} 单 · 原卡费用 ${issue.totalUsd} USD · 本单份额 ${issue.amountUsd} USD · 截至 ${quoteTime(issue.asOf)}`) : '';
    const output = result.status === 'ready'
      ? result.items.map((row) => property(row.label, row.originalCurrency === result.currency ? amount(row.amount) :
          `${row.originalAmount} ${row.originalCurrency} · 折合 ${amount(row.amount)}`)).join('') + allocation +
        property('退款后净收款', amount(result.revenue)) +
        property('原成本合计', amount(result.originalCost)) +
        property('实际收回成本', amount(result.recoveredCost)) +
        property('回款后净成本', amount(result.netCost))
      : '';
    return `<div class="property-list">${property('代付金额', `${display(order.paidAmount)} ${currencyLabel(order.paidCurrency)}`)}${property('售卖金额', `${display(order.saleAmount)} ${currencyLabel(order.saleCurrency)}`)}${property('成本依据', order.costBasis === 'actual' ? '实际总成本' : '订单冻结的费用规则')}${property('核算类别', pending.length || order.cancelled ? '待核算' : accountingLabel(result.basis))}${property('费用规则版本', order.costSettings?.version ? `V${order.costSettings.version}` : '待核对')}${property('客户累计退款', `${display(sum(order.refunds || [], (row) => row.amount))} ${currencyLabel(order.saleCurrency)}`)}${output}${property('本单核算收益', pending.length || order.cancelled ? '待核算' : amount(result.profit))}${property('核算缺口', pending.join('、') || '已确认')}</div>${
      panelTitle('订单汇率快照', '每 1 单位外币对应的人民币金额。仅使用本订单记录的汇率。', finance && !snapshot && !order.cancelled
        ? A.button('登记汇率快照', 'commerce-order-fx', 'primary', '', `data-id="${E(order.id)}"`) +
          (finance.requestAutomaticSnapshot && S.actor?.role !== 'employee'
            ? A.button('获取并冻结自动报价', 'commerce-order-auto-fx', '', '', `data-id="${E(order.id)}"`)
            : '')
        : '')
    }${snapshot ? `<div class="property-list">${property(snapshot.kind === 'automatic' ? '自动报价来源' : '手工登记来源', snapshot.source)}${property('汇率依据', quoteBasisLabel(snapshot))}${snapshot.fetchedAt ? property('采集时间（北京时间）', quoteTime(snapshot.fetchedAt)) : ''}${property('报价时点（北京时间）', quoteTime(snapshot.at))}${property('有效截止（北京时间）', quoteTime(snapshot.expiresAt))}${property('核算时点（北京时间）', quoteTime(snapshot.basisAt))}${Object.entries(snapshot.rates).map(([code, rate]) => property(currencyLabel(code), rate)).join('')}</div>`
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
    const rateInputs = [...new Set([...currencies, ...required])].filter((code) => code !== 'CNY').map((code) => {
      const fieldId = `fx-${code}`;
      return field(currencyLabel(code), fieldId, input(fieldId, v(fieldId), 'inputmode="decimal"'), required.includes(code));
    }).join('');
    A.openDrawer(
      '登记订单汇率快照',
      `${order.orderNo} · 开通时点 ${quoteTime(finance.orderAccountingAt(order))}（北京时间）。保存后冻结。`,
      `<form id="commerce-fx-form" data-commerce-draft="${E(key)}" novalidate><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-version" value="${E(v('version') || order.version)}" /><div class="commerce-field-grid">${field('汇率依据', 'fx-basis', select('fx-basis', [['reference', '历史参考报价'], ['settlement', '实际结算凭据']], v('fx-basis') || 'reference'), true)}${field('报价来源与凭据', 'fx-source', input('fx-source', v('fx-source'), 'maxlength="160"'), true, '填写可核对的真实来源与报价凭据编号。', 'commerce-span-all')}${field('报价时点', 'fx-at', input('fx-at', v('fx-at'), 'type="datetime-local"'), true)}${field('有效截止', 'fx-expiresAt', input('fx-expiresAt', v('fx-expiresAt'), 'type="datetime-local"'), true, '报价在该时刻起失效；时间均为北京时间。')}</div><section class="form-section"><h3>每 1 单位外币折合人民币</h3><p class="footnote">人民币基准固定为 1，马币用于统计切换。汇率最多八位小数。</p><div class="commerce-field-grid">${rateInputs}</div></section></form>`,
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
        basis: value(raw, 'fx-basis') || 'reference',
        at: value(raw, 'fx-at'),
        expiresAt: value(raw, 'fx-expiresAt'),
        rates: Object.fromEntries([...new Set([...currencies, ...finance.requiredQuoteCurrencies(order)])].filter(code => code !== 'CNY').map(code => [code, value(raw, `fx-${code}`)]))
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
      .filter(row => personalProduct(order.product) ? row.customerId === order.customerId &&
        (sameSubscriptionAccount(row, order, false) || order.previousSubscriptionOrderId === row.id ||
          row.previousSubscriptionOrderId === order.id) : isClaude(row) && sameSubscriptionAccount(row, order))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return A.table(
      [
        { id: 'orderNo', label: '独立订单', render: row => A.textAction(row.orderNo,
          'commerce-order-detail', 'data-id="' + E(row.id) + '"') },
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
        basis: accounting?.basis || 'reference',
        reasons: pendingReasons(row, accounting)
      }];
    }));
    const complete = active.filter((row) => amounts.get(row.id).profit !== null);
    const pending = active.filter((row) => amounts.get(row.id).profit === null);
    const reported = (rows, field) => rows.length ? display(sum(rows, (row) => amounts.get(row.id)[field])) : '—';
    const byBasis = (rows, basis) => rows.filter((row) => amounts.get(row.id).basis === basis);
    const selected = moduleState.statsTab === 'pending' ? pending : complete;
    const productRows = Object.keys(productPlans).map((product) => {
      const rows = complete.filter((row) => row.product === product);
      return {
        id: product,
        product,
        count: String(rows.length),
        revenue: reported(rows, 'revenue'),
        actual: reported(byBasis(rows, 'actual'), 'profit'),
        reference: reported(byBasis(rows, 'reference'), 'profit'),
        pending: String(pending.filter((row) => row.product === product).length)
      };
    });
    return (
      A.header(
        '订单统计',
        '按开通时的汇率与订单费用规则核算。实账与参考结果分别列示，证据缺失的订单进入待核算。',
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
        [`核算利润合计（${currencyLabel(costSettings.currency)}）`, reported(complete, 'profit'), costSettings.currency],
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
            ? `<div class="statistics-visual">${window.IDCharts.bars({ title: '各产品订单核算进度', unit: '笔', rows: productRows.map(row => ({ ...row, label: row.product })), series: [{ key: 'count', label: '已核算', tone: 'teal' }, { key: 'pending', label: '待核算', tone: 'amber' }] })}</div>${panelTitle('按产品汇总', '利润合计包含实账和参考核算。参考核算使用订单费用规则或历史报价，开卡成本按同卡已确认开通订单分摊。')}${A.table(
                [
                  { id: 'product', label: '产品' },
                  { id: 'count', label: '已核算订单' },
                  { id: 'revenue', label: `净收款（${currencyLabel(costSettings.currency)}）` },
                  { id: 'actual', label: `实账利润（${currencyLabel(costSettings.currency)}）` },
                  { id: 'reference', label: `参考利润（${currencyLabel(costSettings.currency)}）` },
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
                productRows,
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
                    render: (row) => E(amounts.get(row.id).reasons.join('、') || accountingLabel(amounts.get(row.id).basis))
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
    const initialCards = [];
    if (tenant && !existing) {
      const count = Number(raw['commerce-initial-card-count'] || 0), seen = new Set();
      if (!Number.isInteger(count) || count < 0 || count > 99) return A.notify('每位租户最多登记 99 张银行卡');
      for (let i = 0; i < count; i++) {
        const number = String(raw[`commerce-initial-card-${i}-number`] || '').replace(/[ -]/g, '');
        const label = String(raw[`commerce-initial-card-${i}-label`] || '').trim();
        const error = !/^\d{12,19}$/.test(number) ? '请输入有效银行卡号' : seen.has(number) ? '银行卡号重复' : label.length > 80 ? '名称最多 80 个字' : '';
        A.setError(`commerce-initial-card-${i}-number`, error);
        if (error) return;
        seen.add(number); initialCards.push({ number, label });
      }
    }
    const ownerId = tenant && !existing
      ? form.querySelector?.('select#commerce-contact-ownerId')?.value || value(raw, 'ownerId') || operator.id
      : '';
    if (tenant && !existing) {
      const valid = ownerId === operator.id || (canManageOrders() && orderOwners.some(row => row.id === ownerId));
      A.setError('commerce-contact-ownerId', valid ? '' : '请选择可用的租户归属人');
      if (!valid) return;
    }
    const contacts = Object.fromEntries(customerChannels.map(([key]) => [key, value(raw, key)]));
    const contactError = tenant && !phone;
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
          ? '将保存到服务器数据库。'
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
        if (JSON.stringify(A.readForm(form)) !== JSON.stringify(raw)) {
          A.notify('确认期间资料已变化，请重新核对后保存');
          return;
        }
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
          ...(tenant ? existing
            ? Object.fromEntries(['ownerId', 'owner'].filter(key => Object.hasOwn(existing, key)).map(key => [key, existing[key]]))
            : { ownerId, owner: ownerId === operator.id ? operator.name : orderOwners.find(row => row.id === ownerId)?.name || '' }
            : { owner: value(raw, 'owner') }),
          ...(tenant ? {} : { tags }),
          ...(tenant && !existing && initialCards.length ? { initialCards } : {}),
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
            A.notify(localData ? '资料已保存到服务器数据库' : '演示资料已保存');
          }
        );
      },
      '确认保存'
    );
  }
  function validateOrder(form, allowPending) {
    const order = orderFromForm(form),
      existing = orders.find((row) => row.id === order.id);
    const personal = personalProduct(order.product);
    if (allowPending && personal) {
      if (!existing?.paidConfirmed) order.paidConfirmed = false;
      if (existing?.entitlementStatus !== 'active') order.entitlementStatus = 'pending';
    } else if (localData && !existing && allowPending && order.payment === '苹果内购') {
      order.paidConfirmed = false;
    }
    const pendingOpening = personal && order.entitlementStatus !== 'active';
    const optionalAmount = personal ? !order.paidConfirmed : allowPending || automaticOrder(existing);
    let first = '';
    const error = (name, message) => {
      A.setError(`commerce-${name}`, message);
      if (message) first ||= `commerce-${name}`;
    };
    const auto = automaticOrder(existing);
    if (!existing) error('ownerId', order.ownerId && (order.ownerId === currentOperator().id ||
      orderOwners.some(row => row.id === order.ownerId)) ? '' : '请选择可用的订单归属人');
    const optionalEmail = optionalOrderEmail(order.product, order.businessType, order.claudeRenewalId);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email);
    const validHandle = /^@[a-zA-Z0-9_]{1,15}$/.test(order.xHandle || '');
    const xLogin = order.product === 'Grok' && order.loginMethod === 'x';
    error('email', (optionalEmail && !order.email) || emailValid || (xLogin && !order.email && validHandle)
      ? '' : xLogin ? '请填写实际 X @账号' : '请填写有效邮箱');
    if (order.product === 'Grok')
      error('xHandle', validHandle || (!order.xHandle && !xLogin && order.xLinkState !== 'linked' &&
        order.subscriptionSeries !== 'x_premium') ? '' : '请填写有效的 X @账号');
    error('businessType', (personal ? ['首次开通', '续费', '成品交付'] : ['续费', '成品交付'])
      .includes(order.businessType) ? '' : '请选择业务类型');
    error('plan', orderPlanChoices(order.product, order.plan, existing).includes(order.plan) ? '' : '套餐与产品不匹配');
    error(
      'customerId',
      (!personal && (allowPending || (auto && !order.customerId))) ||
        customers.some((row) => row.id === order.customerId) ? '' : '请选择客户'
    );
    error('paidAmount', amountValid(order.paidAmount, optionalAmount) ? '' : '请输入非负金额，最多四位小数');
    error('saleAmount', amountValid(order.saleAmount, !order.receiptConfirmed && (personal || allowPending || auto)) ? '' : '请输入非负金额，最多四位小数');
    if (personal) {
      error('billingChannel', personalBillingChannels(order.product, order.plan).some(([id]) => id === order.billingChannel)
        ? '' : '请选择与套餐相符的购买渠道');
      error('billingCountry', !order.paidConfirmed || order.billingCountry ? '' : '请填写实际账单地区');
      error('billingReceipt', !order.paidConfirmed || order.billingReceipt ? '' : '请填写本次交易编号');
      if (order.payment === '苹果内购' && order.paidConfirmed) {
        if (order.product === 'Gemini') error('appleGoogleVerified', order.appleGoogleVerified ? '' : '请核对实际对应的 Google 账号');
        error('paidAmount', amountValid(order.paidAmount) && M.compare(order.paidAmount, '0') > 0
          ? '' : '请填写大于零的实际内购扣款金额');
        if (order.businessType === '续费') {
          const original = previousAppleOrder(order);
          if (original) error('appleIdId', original.appleIdId === order.appleIdId ? '' : '续费请使用原 Apple ID');
          else {
            error('appleOriginalVerified', order.appleOriginalVerified ? '' : '请先凭原账单核对付款 Apple ID');
            error('appleOriginalReceipt', order.appleOriginalReceipt ? '' : '请填写旧订阅交易编号');
          }
        }
      }
    }
    for (const name of ['paidCurrency', 'saleCurrency', 'emailCostCurrency', 'actualCostCurrency']) {
      const allowed = name === 'paidCurrency' ? paidCurrencyChoices(order.product, order.payment).map(([code]) => code)
        : name === 'saleCurrency' ? orderCurrencyCodes(order.product) : currencies;
      error(name, (auto && name === 'paidCurrency' && !order[name]) || existing?.[name] === order[name] ||
        allowed.includes(order[name]) ? '' : '请选择有效币种');
    }
    error(
      'emailCostAmount',
      amountValid(order.emailCostAmount || '0') ? '' : '补充成本应为非负金额'
    );
    if (!personal && order.payment === '苹果内购' && order.businessType === '成品交付') {
      const [min, max] = appleMatch(order.plan, order.appleMatchMin, order.appleMatchMax);
      error('appleMatchMin', amountValid(min) ? '' : '请输入有效的美元余额下限');
      error('appleMatchMax', !max || (amountValid(max) && amountValid(min) && M.compare(max, min) >= 0)
        ? '' : '余额上限不能低于下限');
    }
    error('start', ((auto || pendingOpening) && !order.start) ||
      (order.start && Number.isFinite(parseDate(order.start))) ? '' : '请填写实际订阅时间');
    error(
      'expiry',
      ((auto || pendingOpening) && !order.expiry) ||
        (Number.isFinite(parseDate(order.expiry)) && parseDate(order.expiry) > parseDate(order.start))
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
    const mode = proMaterialMode(order);
    if (mode === 'manual_card') {
      error('proCardNumber', /^\d{12,19}$/.test(order.proCardNumber) ? '' : '请填写 12 至 19 位银行卡号');
      error('proCardSerial', order.proCardSerial && order.proCardSerial.length <= 120 &&
        !/[\p{Cc}\p{Cf}]/u.test(order.proCardSerial) ? '' : '请填写有效的卡序列号');
    } else if (mode === 'people') {
      error('proMaterialMode', hasProPeople(order) ? '' : '请选择认证人或填写订阅电话');
      const digits = order.phone.replace(/\D/g, '');
      error('phone', !order.phone || (/^\+?[0-9][0-9 ()-]{4,31}$/.test(order.phone) &&
        digits.length >= 5 && digits.length <= 20) ? '' : '请填写有效的订阅电话');
    } else if (!mode && isProBankOrder(order) && (!isProBankOrder(existing) || proMaterialMode(existing))) {
      error('proMaterialMode', '请选择填写方式');
    } else if (order.payment === '银行卡' && mode !== 'none') {
      const usePool = cardPoolProduct(order.product) || mode === 'pool_card';
      const selected = (usePool ? cards() : (tenantCards.get(order.tenantId)?.items || []))
        .find((row) => row.id === order.cardId);
      const historic = existing?.payment === order.payment && existing.cardId === order.cardId &&
        existing.paymentId === order.paymentId && existing.tenantId === order.tenantId;
      const optional = personal ? !order.paidConfirmed : order.product === 'GPT' || (!mode && allowPending);
      if (mode === 'tenant_card') error('tenantId', order.tenantId ? '' : '请先选择认证人');
      error(mode === 'pool_card' ? 'proPoolCardId' : 'cardId', auto || historic ? '' : !selected && (!optional || order.cardId)
        ? '请选择本次使用的银行卡' : selected && cardTail(selected) !== order.paymentId
          ? '尾号与所选银行卡不符，请重新选择' : '');
    } else if (order.payment === '苹果内购') {
      error(
        'appleIdId',
        ((allowPending || personal) && !order.paidConfirmed && !order.appleIdId) ||
          (personal && !order.paidConfirmed && A.modules.inventory?.getAsset?.(order.appleIdId)?.type === 'apple') ||
          A.modules.appleBalance?.get?.(order.appleIdId)
          ? ''
          : '请选择用于本次订阅的苹果 ID'
      );
    } else if (mode !== 'none') error('payment', '请选择有效支付方式');
    if (order.payment === '银行卡' && order.cardTypeId && order.cardTypeId !== existing?.cardTypeId && bankCardTypesLoaded)
      error('cardTypeId', bankCardTypes.items.some(row => row.id === order.cardTypeId && row.active) ? '' : '请选择当前启用的银行卡类型');
    if (order.businessType === '成品交付' && (!existing || (personal && existing.entitlementStatus !== 'active'))) {
      const selected = availableStock(order.product, existing?.id).find(row => personal ? row.id === order.accountId :
        row.email.toLowerCase() === order.email.toLowerCase());
      error(personal ? 'accountId' : 'email', selected && (!personal ||
        personalTarget(selected).toLowerCase() === personalTarget(order).toLowerCase())
        ? '' : '请搜索并选择本产品可用、未使用的账号');
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
    if (!personal && !existing && order.businessType === '续费') {
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
          (personal ? !sameSubscriptionAccount(existing, order, false) : existing.email !== order.email) ||
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
        error(existing.payment !== order.payment ? 'payment' : mode ? 'proMaterialMode' : 'cardId',
          '已确认付款的订单须保留原付款来源；请通过独立续费登记新的付款资料');
      if (proPaymentSourceLocked(existing) &&
          (mode !== proMaterialMode(existing) ||
            (mode === 'manual_card' && order.proCardNumber !== existing.proCardNumber)))
        error('proMaterialMode', '已确认付款的订单须保留原付款来源');
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
      claudeAccountTracked(order) &&
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
      const existingApple = existing?.payment === '苹果内购';
      const newApple = value(raw, 'payment') === '苹果内购';
      const needsBalance = personalProduct(value(raw, 'product'))
        ? (existingApple && existing.paidConfirmed) || (newApple && !allowPending && raw['commerce-paidConfirmed'] === 'on')
        : newApple || existingApple;
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
      previousOrderId: personalProduct(inputOrder.product) ? inputOrder.previousOrderId || '' : '',
      balanceReversalConfirmed: false
    };
    pruneProMaterialFields(saved);
    if (!Object.hasOwn(inputOrder, 'cardTypeId')) delete saved.cardTypeId;
    if (saved.cardTypeId !== existing?.cardTypeId) delete saved.cardTypeName;
    const personal = personalProduct(saved.product);
    const stock = saved.businessType === '成品交付' && (personal
      ? saved.entitlementStatus === 'active' && existing?.entitlementStatus !== 'active' : !existing);
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
    const usesBalance = (saved.payment === '苹果内购' && (!personal || saved.paidConfirmed)) ||
      (existing?.payment === '苹果内购' && (!personal || existing.paidConfirmed));
    const balanceService = usesBalance ? A.modules.appleBalance : null;
    const balanceCheck = () =>
      balanceService?.previewOrder?.(saved, balanceOptions) ||
      (saved.payment === '苹果内购' && saved.paidConfirmed
        ? { ok: false, error: '苹果余额模块未就绪' }
        : { ok: true, changes: [] });
    const initialStock = stockCheck(),
      initialBalance = balanceCheck();
    if (!initialStock.ok || !initialBalance.ok) {
      A.notify((initialStock.error || initialStock.message || initialBalance.error) +
        (personal && !existing?.paidConfirmed && !initialBalance.ok ? '。可保存待核对并保留原账单。' : ''));
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
      `${orderIdentity(saved)} · ${saved.plan}，归属人 ${orderOwnerName(saved)}，订阅 ${saved.start?.replace('T', ' ') || '待核对'}，到期 ${saved.expiry?.replace('T', ' ') || '待核对'}。${balanceText}${stock ? '保存后所选成品账号标记已使用。' : personal && saved.accountId && saved.businessType === '成品交付' ? '保存后保留所选账号，确认交付时登记使用。' : ''}`,
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
              pruneProMaterialFields(existing);
            } else orders.unshift(saved);
            const renewalFrom = saved.previousOrderId || (renewalSource && !existing && saved.businessType === '续费' &&
                sameSubscriptionAccount(saved, renewalSource.order) ? renewalSource.order.id : '');
            if (renewalFrom && !existing) log('关联续费订单', renewalFrom, saved.orderNo, saved.id);
            if (claudeAccountTracked(saved) && !operating.has(saved.email.toLowerCase()))
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
              renewalEntry ? renewalRoute : orderListRoute(saved.product)
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
          saved.start && (personal ? saved.paidConfirmed && saved.entitlementStatus === 'active' : !existing)
            ? () => { void freezeAutomaticSnapshot(id); } : undefined
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
      `<div class="property-list">${property('订单编号', order.orderNo)}${property(proMaterialMode(order) ? '原付款来源' : '原付款银行卡', bankReturnSource(order))}</div><form id="commerce-bank-return-form" data-commerce-draft="${key}" novalidate><input type="hidden" name="commerce-id" value="${E(id)}" /><input type="hidden" name="commerce-version" value="${E(draft['commerce-version'] || order.version)}" /><div class="commerce-field-grid">${field('实际回款金额', 'bankReturnAmount', input('bankReturnAmount', draft['commerce-bankReturnAmount'] || '', 'inputmode="decimal"'), true, `当前最多 ${display(bankReturnLimit(order))} ${currencyLabel(order.paidCurrency)}`)}${field('到账时间', 'bankReturnAt', input('bankReturnAt', draft['commerce-bankReturnAt'] ?? dateInput(now()), 'type="datetime-local"'), true)}${field('到账依据', 'bankReturnReason', input('bankReturnReason', draft['commerce-bankReturnReason'] || ''), true, '', 'commerce-span-all')}</div></form>`,
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
      `${order.orderNo} · ${display(amount)} ${currencyLabel(order.paidCurrency)} · ${proMaterialMode(order) ? `原付款来源 ${bankReturnSource(order)}` : `原付款银行卡 ${cardLabel(order.cardId)}`}`,
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
              if (order.product === 'Claude Pro') {
                delete order.proMaterialMode;
                delete order.proCardNumber;
                delete order.proCardSerial;
              }
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
    const claude = claudeAccountTracked(order)
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
    if (action === 'commerce-order-amount-options') {
      openOrderAmountOptions(node);
      return true;
    }
    if (action === 'commerce-order-price-reference') {
      openOrderPriceReference(node.closest('#commerce-order-form'), node.dataset.kind);
      return true;
    }
    if (action === 'commerce-order-price-reference-retry') {
      const panel = node.closest('#commerce-order-price-reference-panel');
      if (panel && orderPriceReferenceReturn) void loadOrderPriceReference(panel, orderPriceReferenceReturn.view);
      return true;
    }
    if (action === 'commerce-order-start-shortcut') {
      const start = node.closest('#commerce-order-form')?.elements['commerce-start'];
      const minutes = Number(node.dataset.minutes);
      if (start && !start.readOnly && [15, 60, 120].includes(minutes)) {
        start.value = dateInput(new Date(Date.now() - minutes * 60_000).toISOString());
        A.setError('commerce-start', '');
        start.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    if (action === 'commerce-entry-refresh') {
      void refreshEntryRecords(node);
      return true;
    }
    if (action === 'commerce-entry-period' || action === 'commerce-entry-query') {
      applyEntryPeriod(node);
      return true;
    }
    if (action === 'commerce-order-prices-retry') {
      const form = node.closest('#commerce-order-form');
      if (form?.dataset.priceReferenceStatus === 'error') {
        node.closest('.title-help').querySelector('summary').focus({ preventScroll: true });
        refreshOrderAmountReferences(form, 'loading');
        void loadPrices(form);
      }
      return true;
    }
    if (action === 'commerce-payment-settings-tab') {
      if (paymentSettingsActive() && paymentSettingsTabs.some(([id]) => id === node.dataset.tab)) {
        saveDrafts();
        paymentSettingsView().tab = node.dataset.tab;
        A.render();
        $(`[data-action="commerce-payment-settings-tab"][data-tab="${node.dataset.tab}"]`)?.focus();
      }
      return true;
    }
    if (action === 'commerce-paid-settings-retry' || action === 'commerce-paid-settings-reload') {
      if (!paymentSettingsActive() || paymentSettingsLoad) return true;
      const reload = resetDraft => {
        currencySettingsRevision++;
        priceLoad = null;
        void loadPaymentSettings(resetDraft);
      };
      if (action === 'commerce-paid-settings-retry') reload();
      else {
        const form = $('#commerce-paid-prices-form');
        A.confirmAction('读取最新代付价格', '放弃当前产品和国家／地区未保存的草稿，重新读取设置。', () => {
          if (paymentSettingsActive() && form?.isConnected)
            reload({ key: form.dataset.commerceDraft, submitted: JSON.stringify(readCommerceDraft(form)) });
        });
      }
      return true;
    }
    if (action === 'commerce-paid-rates-retry') {
      if (paymentSettingsActive()) {
        paymentRatesStale = true;
        void loadPaymentRates();
      }
      return true;
    }
    if (action === 'commerce-renewal-card-open') {
      openRenewalCardDrawer(node.dataset.id);
      return true;
    }
    if (action === 'commerce-renewal-card-refresh') {
      void loadRenewalCardDetails(node.closest('#commerce-renewal-card-panel'));
      return true;
    }
    if (action === 'commerce-renewal-card-reveal') {
      void revealRenewalCard(node);
      return true;
    }
    if (action === 'commerce-renewal-card-copy-account') {
      copyRenewalCardAccount(node);
      return true;
    }
    if (action === 'commerce-copy-subscription-card') {
      void copySubscriptionBankCard(node.dataset.id, node);
      return true;
    }
    if (action === 'commerce-subscription-card-refresh') {
      loadSubscriptionCardEstimates(true);
      return true;
    }
    if (action === 'commerce-subscription-card-edit') {
      editSubscriptionCard(node.dataset.id, node);
      return true;
    }
    if (action === 'commerce-subscription-card-detail') {
      showSubscriptionCardHistory(node.dataset.id);
      return true;
    }
    if (action === 'commerce-subscription-card-type') {
      const row = subscriptionCardRows().find(item => item.order.id === node.dataset.id);
      if (row) void openBankCardTypeAssignment(row.cardId, () => A.render());
      return true;
    }
    if (action === 'commerce-card-types' || action === 'commerce-card-type-edit') {
      void openBankCardTypeEditor(action === 'commerce-card-type-edit' ? node.dataset.id : '');
      return true;
    }
    if (action === 'commerce-card-type-remove') { removeBankCardType(node.dataset.id); return true; }
    if (action === 'commerce-card-type-assign') { void openBankCardTypeAssignment(node.dataset.id); return true; }
    if (action === 'commerce-card-type-reload') { void openBankCardTypeEditor(node.dataset.id, true); return true; }
    if (action === 'commerce-card-type-assignment-reload') {
      void openBankCardTypeAssignment(node.dataset.id, bankCardTypeReturn?.onClose, true);
      return true;
    }
    if (action === 'commerce-tenant-more') {
      if (canManageOrders()) {
        const tenant = tenants.find(row => row.id === node.dataset.id);
        if (tenant) A.openActionMenu(node, A.button('转交归属', 'commerce-tenant-owner-transfer', '', '', `data-id="${E(tenant.id)}"`) +
          A.button(tenant.active ? '停用' : '恢复', 'commerce-contact-disable', '', '', `data-id="${E(tenant.id)}" data-kind="tenant"`));
      }
      return true;
    }
    if (action === 'commerce-tenant-owner-transfer' || action === 'commerce-tenant-owner-reload') {
      if (canManageOrders()) void openTenantOwnerTransfer(node.dataset.id, action.endsWith('-reload'));
      return true;
    }
    if (action === 'commerce-order-owner-refresh') {
      if (canManageOrders()) void A.withActionFeedback(node,
        () => loadOrderOwners(node.closest('form'), true),
        { pending: '正在刷新归属人…', success: '归属人列表已刷新', failure: '人员读取失败，请重试' });
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
      if (form) void A.withActionFeedback(node, () => loadOrderCards(form, true),
        { pending: '正在刷新银行卡…', success: '银行卡列表已刷新', failure: '银行卡读取失败，请重试' });
      return true;
    }
    if (action === 'commerce-tenant-cards') {
      void openTenantCards(node.dataset.id);
      return true;
    }
    if (action === 'commerce-tenant-card-reveal' || action === 'commerce-tenant-card-copy') {
      const form = node.closest('#commerce-order-form');
      if (form) {
        if (action.endsWith('copy')) void useTenantCard(form, 'copy');
        else void A.withActionFeedback(node, () => useTenantCard(form, 'reveal'),
          { pending: '正在读取银行卡…', success: '完整银行卡号已显示', failure: '银行卡未读取，请检查所选资料' });
      }
      return true;
    }
    if (action === 'commerce-tenant-card-deactivate') {
      A.confirmAction('停用租户银行卡', '停用后停止用于新单，历史订单仍可核对。', () => {
        void changeTenantCard(null, node.dataset.tenant, node.dataset.id);
      });
      return true;
    }
    if (action === 'commerce-currency-settings') { void openCurrencySettings(node.dataset.product); return true; }
    if (action === 'commerce-currency-reload') {
      if (canManageOrders()) A.confirmAction('读取最新币种', '替换当前币种设置草稿，订单输入会保留。', () => {
        void openCurrencySettings(node.dataset.product, true);
      });
      return true;
    }
    if (action === 'commerce-price-settings') {
      saveDrafts();
      void openPrices(node.dataset.product);
      return true;
    }
    if (action === 'commerce-price-type') {
      const form = $('#drawer[open] #commerce-prices-form');
      if (form) {
        selectSalePriceGroup(form, node.dataset.tab);
        saveDrafts();
      }
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
      void A.withActionFeedback(node, () => loadLocalCommerce(true),
        { pending: '正在读取业务资料…', success: '业务资料已重新读取', failure: '业务资料读取失败，请重试' });
      A.render();
      return true;
    }
    if (action === 'commerce-sync-orders-refresh') {
      void A.withActionFeedback(node, async () => {
        const ready = await loadLocalCommerce(true, true);
        if (S.route === A.gptOrderSyncRoute) A.render();
        return ready;
      }, { pending: '正在读取订单…', success: '订单已刷新', failure: '订单暂时无法读取，请重试' });
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
      if (node.hasAttribute('data-renewal-card-renew')) {
        const panel = $('#commerce-renewal-card-panel');
        if (!renewalCardActionCurrent(panel, node) || !renewalCardCanRenew(id) ||
            renewalCardDrawers.get(panel)?.details?.order?.account?.canRenew === false) return true;
      }
      if (id) A.go(renewalOrderPrefix + encodeURIComponent(id));
      return true;
    }
    if (action === 'commerce-loss-history') {
      showCustomerLossHistory(id);
      return true;
    }
    if (action === 'commerce-loss-refresh') {
      refreshCustomerRetention(node);
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
    if (action === 'commerce-initial-card-add' || action === 'commerce-initial-card-remove') {
      const form = document.getElementById('commerce-contact-form');
      if (!form) return true;
      const raw = A.readForm(form);
      if (value(raw, 'kind') !== 'tenant' || value(raw, 'id')) return true;
      const count = Number(raw['commerce-initial-card-count'] || 0);
      if (!Number.isInteger(count) || count < 0 || count > 99) return true;
      const cards = Array.from({ length: count }, (_, i) => ({ number: raw[`commerce-initial-card-${i}-number`] || '', label: raw[`commerce-initial-card-${i}-label`] || '' }));
      if (action === 'commerce-initial-card-add') {
        if (count >= 99) { A.notify('每位租户最多登记 99 张银行卡'); return true; }
        cards.push({ number: '', label: '' });
      } else {
        const index = Number(node.dataset.index);
        if (!Number.isInteger(index) || index < 0 || index >= count) return true;
        cards.splice(index, 1);
      }
      for (const name of Object.keys(raw)) if (name.startsWith('commerce-initial-card-')) delete raw[name];
      raw['commerce-initial-card-count'] = String(cards.length);
      cards.forEach((card, i) => { raw[`commerce-initial-card-${i}-number`] = card.number; raw[`commerce-initial-card-${i}-label`] = card.label; });
      const key = form.dataset.commerceDraft, standalone = !form.closest('dialog');
      form.removeAttribute('data-commerce-draft');
      S.drafts.set(key, raw);
      if (standalone) A.render();
      else contactForm(true, '', value(raw, 'quick') === 'yes');
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
    if (action === 'commerce-contact-orders' || action === 'commerce-contact-services') {
      contactRecords(id, node.dataset.kind === 'tenant', action === 'commerce-contact-services');
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
      if (!claudeAccountTracked(order)) {
        A.notify('快捷续费需要已记录邮箱的 Claude 订单，请提交独立新订单。');
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
    if (form.id === 'commerce-paid-prices-form') { void savePaidPrices(form); return true; }
    if (['commerce-card-type-form', 'commerce-card-type-assignment-form'].includes(form.id)) {
      void saveBankCardType(form);
      return true;
    }
    if (form.id === 'commerce-tenant-owner-form') { void saveTenantOwnerTransfer(form); return true; }
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
    if (form.id === 'commerce-currencies-form') { void saveCurrencySettings(form); return true; }
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
  const orderValueObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (target.isConnected) updateOrderValueReadout(target);
      else orderValueObserver.unobserve(target);
    }
  }) : null;
  let orderValueMeasure;
  function updateOrderValueReadout(control) {
    const fieldControl = control.closest('.field-control');
    const current = fieldControl?.querySelector('.order-value-readout');
    let value = '';
    if (control.clientWidth && control.tagName === 'SELECT') {
      const label = control.selectedOptions[0]?.textContent || '';
      const style = getComputedStyle(control);
      orderValueMeasure ??= document.createElement('canvas').getContext('2d');
      orderValueMeasure.font = style.font;
      const reserved = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.fontSize);
      if (orderValueMeasure.measureText(label).width > control.clientWidth - reserved)
        value = label;
    } else if (control.clientWidth && control.scrollWidth > control.clientWidth + 1) {
      value = control.value;
    }
    if (!value || !fieldControl) {
      current?.remove();
      return;
    }
    const readout = current || document.createElement('p');
    if (readout.textContent !== value) readout.textContent = value;
    if (!current) {
      readout.className = 'footnote order-value-readout';
      readout.setAttribute('aria-hidden', 'true');
      fieldControl.querySelector('.field-error').before(readout);
    }
  }
  const stockForms = new WeakSet();
  function updateCustomerEmailHistory(form, match = false) {
    if (personalProduct(form.elements['commerce-product'].value)) return refreshPersonalAccounts(form);
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
        : '优先匹配所选客户在当前产品最近使用的邮箱，也可直接填写新邮箱。';
      const helpTrigger = help.closest('.field-title-help');
      helpTrigger.hidden = email.readOnly && !stock;
      if (helpTrigger.hidden) helpTrigger.open = false;
    }
    if (select.disabled && picker.querySelector('.commerce-picker-popover').matches(':popover-open'))
      picker.querySelector('.commerce-picker-popover').hidePopover();
    filterPicker(search);
    for (const control of form.querySelectorAll('#commerce-email, #commerce-ownerId[readonly], #commerce-paidCurrency, #commerce-saleCurrency, #commerce-cardTypeId')) {
      orderValueObserver?.observe(control);
      updateOrderValueReadout(control);
    }
  }
  function refreshPersonalAccounts(form) {
    const controls = form.elements;
    const product = controls['commerce-product'].value;
    const existing = orders.find(row => row.id === controls['commerce-id'].value);
    const stock = controls['commerce-businessType'].value === '成品交付';
    const account = controls['commerce-accountId'];
    const history = controls['commerce-personalHistoryId'];
    const email = controls['commerce-email'];
    const customer = controls['commerce-customerId'].value;
    const past = controls['commerce-previousSubscriptionOrderId'];
    const displayField = (name, show) => {
      const field = form.querySelector('[data-commerce-field="' + name + '"]');
      if (field) field.hidden = !show;
    };
    displayField('accountId', stock && existing?.entitlementStatus !== 'active');
    displayField('personalHistoryId', !stock && !existing);
    email.readOnly = stock || Boolean(existing?.accountId || account.value);
    if (product === 'Grok') {
      const identityLocked = email.readOnly;
      controls['commerce-loginMethod'].disabled = identityLocked;
      controls['commerce-xHandle'].readOnly = identityLocked;
      controls['commerce-platformAccountId'].readOnly = identityLocked;
    }
    const selected = account.value;
    account.innerHTML = A.options(personalStockChoices(product, existing, selected), selected);
    history.innerHTML = A.options(personalHistoryChoices(customer, product), history.value);
    if (past) {
      const migration = personalSeries(product, controls['commerce-plan'].value) === 'x_subscription';
      past.innerHTML = A.options(priorGrokChoices(customer), migration ? past.value : '');
      displayField('previousSubscriptionOrderId', migration);
      displayField('previousAutoRenew', migration && Boolean(past.value));
      if (!past.value) controls['commerce-previousAutoRenew'].value = 'unknown';
    }
    for (const name of ['accountId', 'personalHistoryId']) {
      const search = controls['commerce-' + name].closest('.commerce-search-picker').querySelector('[data-commerce-picker]');
      filterPicker(search);
    }
    if (localData && stock && !stockForms.has(form)) {
      stockForms.add(form);
      void A.modules.inventory?.refreshLocalInventory?.().then((ready) => {
        if (!ready) stockForms.delete(form);
        else if (form.isConnected) refreshPersonalAccounts(form);
      });
    }
  }
  function fillPersonalAccount(form, record, accountId = '') {
    const controls = form.elements;
    const account = controls['commerce-accountId'];
    if (accountId && ![...account.options].some(option => option.value === accountId))
      account.add(new Option(personalTarget(record), accountId));
    account.value = accountId;
    controls['commerce-email'].value = record?.email || record?.xHandle || '';
    controls['commerce-platformAccountId'].value = record?.platformAccountId || '';
    if (controls['commerce-xHandle']) {
      controls['commerce-xHandle'].value = record?.xHandle || '';
      controls['commerce-loginMethod'].value = record?.loginMethod || 'email';
      controls['commerce-xLinkState'].value = record?.xLinkState || 'unknown';
    }
  }
  function updateStockSearch(form) {
    if (personalProduct(form.elements['commerce-product'].value)) return refreshPersonalAccounts(form);
    const email = form.querySelector('#commerce-email');
    if (!email) return;
    const stock = form.elements['commerce-businessType'].value === '成品交付';
    const required = !optionalOrderEmail(form.elements['commerce-product'].value, form.elements['commerce-businessType'].value,
      form.elements['commerce-claudeRenewalId']?.value);
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
      email.placeholder = required ? '填写订单邮箱' : '选填，可选择历史邮箱或手动填写';
      if (!existing?.accountId) form.elements['commerce-accountId'].value = '';
    }
    updateCustomerEmailHistory(form);
  }
  function updateOrderVisibility(form) {
    const order = orderFromForm(form),
      actual = order.costBasis === 'actual',
      proBank = isProBankOrder(order), mode = proMaterialMode(order);
    const toggle = (name, show) => {
      const node = form.querySelector(`[data-commerce-field="${name}"]`);
      if (node) node.hidden = !show;
    };
    toggle('actualCostAmount', actual);
    toggle('actualCostCurrency', actual);
    toggle('appleRecoverableCostAmount', actual && order.payment === '苹果内购');
    toggle('cardId', order.payment === '银行卡' && (!mode || mode === 'tenant_card'));
    toggle('proPoolCardId', mode === 'pool_card');
    toggle('cardTypeId', order.payment === '银行卡');
    toggle('proMaterialMode', proBank);
    toggle('proCardNumber', mode === 'manual_card');
    toggle('proCardSerial', mode === 'manual_card');
    toggle('paymentId', order.payment === '银行卡' && cardPoolProduct(order.product));
    toggle('appleIdId', order.payment === '苹果内购');
    const appStore = order.payment === '苹果内购';
    const priorApple = appStore && order.businessType === '续费' ? previousAppleOrder(order) : null;
    toggle('appleOriginalVerified', appStore && order.businessType === '续费' && !priorApple);
    toggle('appleOriginalReceipt', appStore && order.businessType === '续费' && !priorApple);
    toggle('appleGoogleVerified', appStore && order.product === 'Gemini' && !priorApple?.appleGoogleVerified);
    toggle('appleMatchMin', order.payment === '苹果内购' && order.businessType === '成品交付');
    toggle('appleMatchMax', order.payment === '苹果内购' && order.businessType === '成品交付');
    refreshAppleOptions(form);
    const personnel = form.querySelector('[data-commerce-section="03"]');
    if (personnel) personnel.hidden = order.product === 'GPT' || !showProPeople(mode);
    refreshOrderCardType(form);
    updateStockSearch(form);
  }
  function updateOrderPeriod(form) {
    if (personalProduct(form.elements['commerce-product'].value)) return;
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
    if (node.matches('[data-entry-date]')) {
      const panel = node.closest('#commerce-entry-records');
      entryView(panel.dataset.kind, panel.dataset.product)[node.dataset.entryDate + 'Draft'] = node.value;
      return true;
    }
    if (node.closest('.commerce-entry-layout') && node.matches('input:not([type="hidden"]), select'))
      updateOrderValueReadout(node);
    const orderFilter = node.id?.match(/^commerce-order-filter-(plan|payment|expiry)$/)?.[1];
    if (orderFilter) {
      const product = S.route.endsWith('/gemini') ? 'Gemini' : 'Grok';
      S.drafts.set('commerce-order-filters:' + product, { ...personalOrderFilters(product), [orderFilter]: node.value });
      S.page = 1;
      A.render();
      document.getElementById(node.id)?.focus({ preventScroll: true });
      return true;
    }
    if (S.route === customerLossRoute) {
      const filter = node.id?.match(/^commerce-loss-(plan|age|count|sort)$/)?.[1];
      if (filter) {
        S.drafts.set(retentionFiltersKey, { ...retentionView(), [filter]: node.value });
        S.page = 1;
        A.render();
        $(`#commerce-loss-${filter}`)?.focus({ preventScroll: true });
        return true;
      }
    }
    if (node.id === 'commerce-price-currency' && node.form?.id === 'commerce-prices-form') {
      selectSalePriceGroup(node.form, node.form.elements['commerce-price-type'].value);
      saveDrafts();
      return true;
    }
    const paidSetting = node.id === 'commerce-paid-country' ? 'currency' : node.id === 'commerce-paid-product' ? 'product' : '';
    if (paidSetting && paymentSettingsActive() && Object.hasOwn(paidSetting === 'currency' ? paymentCountries : productPlans, node.value)) {
      saveDrafts();
      paymentSettingsView()[paidSetting] = node.value;
      A.render();
      $(`#${node.id}`)?.focus();
      return true;
    }
    const cardFilter = node.id?.match(/^commerce-subscription-card-(state|purpose|type|plan)$/)?.[1];
    if (cardFilter) {
      subscriptionCardFilters[cardFilter] = node.value;
      S.page = 1;
      A.render();
      return true;
    }
    if (node.dataset?.commercePicker) return true;
    if (node.id === 'commerce-contact-ownerId') A.setError(node.id, '');
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
      const controls = form.elements;
      const product = controls['commerce-product'].value;
      const personal = personalProduct(product);
      if (personal) {
        if (node.id === 'commerce-accountId') {
          const selected = availableStock(product, controls['commerce-id'].value).find(row => row.id === node.value);
          fillPersonalAccount(form, selected, selected?.id);
        }
        if (node.id === 'commerce-personalHistoryId') {
          const past = orders.find(row => row.id === node.value);
          const renew = controls['commerce-businessType'].value === '续费';
          fillPersonalAccount(form, past, renew ? past?.accountId || '' : '');
          if (renew && past) {
            controls['commerce-plan'].value = past.plan;
            controls['commerce-billingChannel'].innerHTML = A.options(personalBillingChannels(product, past.plan), past.billingChannel);
            controls['commerce-billingCountry'].value = past.billingCountry || '';
            controls['commerce-billingCycle'].value = past.billingCycle || 'month';
            controls['commerce-autoRenew'].value = past.autoRenew || 'unknown';
            controls['commerce-appleIdId'].value = '';
            controls['commerce-appleOriginalVerified'].checked = false;
          }
        }
        if (node.id === 'commerce-customerId' && !controls['commerce-id'].value && controls['commerce-personalHistoryId'].value) {
          controls['commerce-personalHistoryId'].value = '';
          fillPersonalAccount(form, null);
        }
        if (['commerce-email', 'commerce-appleIdId', 'commerce-customerId', 'commerce-accountId'].includes(node.id) &&
            controls['commerce-appleGoogleVerified'] && !controls['commerce-id'].value)
          controls['commerce-appleGoogleVerified'].checked = false;
        if (node.id === 'commerce-email' && product === 'Grok' && node.value.trim().startsWith('@')) {
          controls['commerce-loginMethod'].value = 'x';
          controls['commerce-xHandle'].value = node.value.trim();
        }
        if (node.id === 'commerce-plan') {
          const channel = controls['commerce-billingChannel'];
          channel.innerHTML = A.options(personalBillingChannels(product, node.value), channel.value);
        }
      }
      const payment = controls['commerce-payment'];
      const nextPayment = personal ? controls['commerce-billingChannel'].value === 'app_store' ? '苹果内购' : '银行卡' : node.value;
      const paymentChanged = node.id === 'commerce-payment' || (personal && nextPayment !== payment.value);
      if (personal) payment.value = nextPayment;
      if (node.id === 'commerce-cardTypeId') form.elements['commerce-card-type-touched'].value = 'yes';
      if (node.id === 'commerce-ownerId') A.setError('commerce-ownerId', '');
      if (node.id === 'commerce-product') {
        form.querySelector('#commerce-plan').innerHTML = A.options(
          productPlans[node.value],
          productPlans[node.value][0]
        );
        form.querySelector('#commerce-claudeRenewalId').value = '';
        if (form.querySelector('#commerce-payment').value !== '苹果内购')
          form.querySelector('#commerce-paidCurrency').value = orderCurrencyCodes(node.value).includes(node.value === 'GPT' ? 'PHP' : 'MYR')
            ? node.value === 'GPT' ? 'PHP' : 'MYR' : orderCurrencyCodes(node.value)[0];
        refreshCurrencyFields(form, false);
        if (
          form.querySelector('#commerce-businessType').value === '成品交付' &&
          !form.querySelector('#commerce-id').value
        ) {
          form.querySelector('#commerce-email').value = '';
          form.querySelector('#commerce-accountId').value = '';
        }
        updateOrderPeriod(form);
        void loadOrderCards(form, true);
      }
      if (node.id === 'commerce-businessType') {
        form.querySelector('#commerce-claudeRenewalId').value = '';
        form.querySelector('#commerce-accountId').value = '';
        if (personal) {
          const history = controls['commerce-personalHistoryId'];
          const previous = orders.find(row => row.id === history.value);
          if (node.value === '成品交付') {
            history.value = '';
            fillPersonalAccount(form, null);
          } else if (previous) fillPersonalAccount(form, previous, node.value === '续费' ? previous.accountId || '' : '');
        } else if (node.value === '成品交付' && !form.querySelector('#commerce-id').value)
          form.querySelector('#commerce-email').value = '';
        updateOrderPeriod(form);
        controls['commerce-saleManual'].value = '';
        applyOrderPrice(form, true);
      }
      if (node.id === 'commerce-plan' || node.id === 'commerce-product') {
        if (!personal) {
          const [min, max] = appleMatch(form.elements['commerce-plan'].value);
          form.elements['commerce-appleMatchMin'].value = min;
          form.elements['commerce-appleMatchMax'].value = max;
          form.elements['commerce-appleIdId'].value = '';
        }
        form.elements['commerce-saleManual'].value = '';
        applyOrderPrice(form, true);
      }
      if (node.id === 'commerce-customerId') {
        const customer = customers.find((row) => row.id === node.value);
        for (const [orderField, customerField] of orderContactFields)
          form.querySelector(`#commerce-${orderField}`).value = customer?.[customerField] || '';
        updateCustomerEmailHistory(form, true);
      }
      if (node.id === 'commerce-businessType') updateCustomerEmailHistory(form, true);
      if (paymentChanged) {
        const paid = form.querySelector('#commerce-paidCurrency'),
          amount = form.querySelector('#commerce-paidAmount');
        const nextCurrency =
          nextPayment === '苹果内购'
            ? 'USD'
            : form.querySelector('#commerce-product').value === 'GPT'
              ? 'PHP'
              : 'MYR';
        if (paid.value !== nextCurrency || (!form.elements['commerce-id'].value &&
            form.elements['commerce-product'].value === 'GPT')) {
          amount.value = '';
          if (personal && !controls['commerce-id'].value) controls['commerce-paidConfirmed'].checked = false;
          if (!form.elements['commerce-id'].value && form.elements['commerce-product'].value === 'GPT')
            form.elements['commerce-paidConfirmed'].checked = false;
        }
        paid.innerHTML = A.options(
          paidCurrencyChoices(form.elements['commerce-product'].value, nextPayment, nextCurrency),
          nextCurrency
        );
        refreshCurrencyFields(form);
        if (nextPayment === '苹果内购') {
          if (
            !form.elements['commerce-saleCurrencyChosen'].value &&
            !form.querySelector('#commerce-saleAmount').value
          )
            form.querySelector('#commerce-saleCurrency').value = 'USD';
          clearRevealedCard(form);
          loadAppleOptions(form, true);
        } else {
          void loadOrderCards(form, true);
          void loadOrderCardType(form);
        }
      }
      if (node.id === 'commerce-proMaterialMode') {
        clearRevealedCard(form);
        for (const name of ['proMaterialMode', 'proCardNumber', 'proCardSerial', 'proPoolCardId', 'tenantId', 'phone', 'verifierPhone', 'cardId'])
          A.setError(`commerce-${name}`, '');
        resetProPaymentChecks(form);
        void loadOrderCards(form, true);
      }
      if (['commerce-plan', 'commerce-product', 'commerce-payment', 'commerce-paidCurrency'].includes(node.id))
        applyGptPaidPrice(form, true);
      if (node.id === 'commerce-saleCurrency') {
        form.elements['commerce-saleCurrencyChosen'].value = 'yes';
        form.elements['commerce-saleManual'].value = '';
        applyOrderPrice(form, true);
      }
      if (['commerce-cardId', 'commerce-proPoolCardId'].includes(node.id)) {
        const tenantId = form.elements['commerce-tenantId']?.value;
        const product = form.elements['commerce-product'].value;
        const pool = cardPoolProduct(product) || node.id === 'commerce-proPoolCardId';
        const options = pool ? cards() : tenantCards.get(tenantId)?.items || [];
        if (node.id === 'commerce-cardId')
          form.elements['commerce-paymentId'].value = cardTail(options.find((row) => row.id === node.value));
        clearRevealedCard(form);
        if (cardPoolProduct(product)) refreshPoolUsage(form);
        else if (!pool && node.value) void useTenantCard(form, 'reveal');
        if (product === 'Claude Pro') resetProPaymentChecks(form);
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
      if (['commerce-product', 'commerce-plan', 'commerce-businessType', 'commerce-payment', 'commerce-paidCurrency', 'commerce-saleCurrency'].includes(node.id))
        refreshOrderAmountReferences(form);
      for (const search of form.querySelectorAll('[data-commerce-picker]')) filterPicker(search);
      if (['commerce-email', 'commerce-paidAmount', 'commerce-appleMatchMin', 'commerce-appleMatchMax'].includes(node.id))
        refreshAppleOptions(form);
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
    if (node.closest('.commerce-entry-layout') && node.matches('input:not([type="hidden"])'))
      updateOrderValueReadout(node);
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
      if (node.id === 'commerce-proCardNumber') resetProPaymentChecks(node.form);
      if (node.id === 'commerce-email') updateStockSearch(node.closest('#commerce-order-form'));
      if (node.id === 'commerce-saleAmount') node.form.elements['commerce-saleManual'].value = 'yes';
      if (node.id === 'commerce-paidAmount') node.form.elements['commerce-paidManual'].value = 'yes';
      if (node.hasAttribute?.('data-paid-price')) node.form.dataset.paidPriceDirty = 'yes';
      if (['commerce-emailCostAmount', 'commerce-emailCostCurrency'].includes(node.id) && node.form.elements['commerce-emailCostManual'])
        node.form.elements['commerce-emailCostManual'].value = 'yes';
      saveDrafts();
      if (node.hasAttribute?.('data-paid-price')) updatePaymentBudgets();
      const form = node.closest('#commerce-order-form');
      if (form && ['commerce-email', 'commerce-paidAmount', 'commerce-appleMatchMin', 'commerce-appleMatchMax'].includes(node.id))
        refreshAppleOptions(form);
      return true;
    }
    return false;
  }
  function resetProPaymentChecks(form) {
    const existing = orders.find((row) => row.id === form.elements['commerce-id'].value);
    if (existing && hasPaymentHistory(existing)) return;
    for (const key of ['paidConfirmed', 'costConfirmed']) {
      const control = form.elements[`commerce-${key}`];
      if (control) control.checked = false;
    }
  }
  function matches(route) {
    return (
      [
        'customers/new',
        'customers/new/tenant',
        'customers/list',
        'customers/tenants',
        'workspace/order', gptOrderRoute, claudeOrderRoute, ...Object.keys(personalEntries),
        renewalRoute,
        customerLossRoute,
        subscriptionCardsRoute,
        'orders/gpt',
        'orders/pro',
        'orders/max',
        'orders/gemini',
        'orders/grok',
        'orders/exclusive',
        'orders/statistics',
        paymentSettingsRoute
      ].includes(route) ||
      route.startsWith(renewalOrderPrefix) ||
      route.startsWith('orders/exclusive/rentals') ||
      route.startsWith('orders/detail/')
    );
  }
  function render() {
    if (S.route === paymentSettingsRoute) return renderPaymentSettings();
    const lossPage = S.route === customerLossRoute;
    if (localData && localPhase !== 'ready') {
      const gptOrdersPage = S.route === 'orders/gpt';
      return (
        A.header(gptOrdersPage ? 'GPT 订单' : lossPage ? '客户流失' : '本机业务资料', '') +
        `<section class="panel">${gptOrdersPage ? A.gptOrderTabs?.() || '' : ''}${
          localPhase === 'error'
            ? A.empty(lossPage ? '无法读取业务资料' : '无法读取本机业务资料',
              lossPage ? '请重试读取客户与订单资料。' : '请确认本机服务后重试。') +
              A.button('重试', 'commerce-local-retry', 'primary')
            : A.empty(lossPage ? '正在读取客户与订单资料' : '正在读取本机业务资料', '请稍候。')
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
            : '保存后进入客户数据。录入人和修改人自动记录，关联订单和历史开通业务可从列表直接打开。'
        ) + contactForm(tenant, '', false, true)
      );
    }
    if (S.route === 'customers/list') return renderContacts(false);
    if (S.route === 'customers/tenants') return renderContacts(true);
    if (isOrderEntry(S.route) || S.route.startsWith(renewalOrderPrefix)) return renderOrderPage();
    if (S.route === renewalRoute) return renderRenewals();
    if (S.route === subscriptionCardsRoute) return renderSubscriptionCards();
    if (lossPage) {
      if (localData && (!requestedAccountLifecycle || accountLifecycleReading) &&
          !A.modules.inventory?.accountLifecycleReady?.() && orders.some(retentionStockOrder))
        return A.header('客户流失', '') +
          `<section class="panel">${A.empty('正在核对库存使用关系', '请稍候。')}</section>`;
      return renderCustomerLoss();
    }
    if (S.route.startsWith('orders/detail/'))
      return orderDetail(S.route.split('/').at(-1), moduleState.detailTab, true);
    if (S.route === 'orders/statistics') return renderStatistics();
    if (S.route.startsWith('orders/exclusive')) return renderClaude();
    return renderOrders(
      ({ 'orders/pro': 'Claude Pro', 'orders/max': 'Claude Max', 'orders/gemini': 'Gemini', 'orders/grok': 'Grok' })[S.route] || 'GPT'
    );
  }
  function overviewSummary(dates) {
    if (localPhase !== 'ready' || !localData || !A.canVisit('orders/statistics')) return null;
    const products = Object.keys(productPlans);
    const totals = () => ({ orders: 0, cancelled: 0, receipts: {}, refunds: {},
      profit: '0', accounted: 0, pending: 0 });
    const daily = new Map(dates.map(date => [date, {
      date, customers: 0, ...totals(),
      products: Object.fromEntries(products.map(product => [product, totals()]))
    }]));
    const bucket = value => {
      const timestamp = parseDate(value);
      return Number.isFinite(timestamp) ? daily.get(beijingClock.format(timestamp).slice(0, 10)) : null;
    };
    const addOriginal = (amounts, currency, amount) => {
      if (!/^[A-Z]{3}$/.test(currency) || !amountValid(amount)) return;
      amounts[currency] = M.add(amounts[currency] || '0', amount);
    };
    const buckets = (day, product) => day
      ? [day, Object.hasOwn(day.products, product) ? day.products[product] : null].filter(Boolean) : [];
    let incomplete = 0;
    for (const order of orders) {
      const targets = buckets(bucket(order.createdAt), order.product);
      for (const refund of order.refunds || [])
        for (const target of buckets(bucket(refund.at), order.product))
          addOriginal(target.refunds, order.saleCurrency, refund.amount);
      if (order.cancelled) {
        for (const target of targets) target.cancelled++;
        continue;
      }
      if (orderStatus(order) === '待补全') incomplete++;
      if (!targets.length) continue;
      const accounting = order.payment === '苹果内购' && !A.modules.appleBalance?.ready()
        ? { status: 'pending', reason: '苹果 ID 余额尚未就绪' }
        : localAccounting(order, 'CNY');
      const gain = profit(order, accounting);
      for (const target of targets) {
        target.orders++;
        if (order.receiptConfirmed) addOriginal(target.receipts, order.saleCurrency, order.saleAmount);
        if (gain === null) target.pending++;
        else {
          target.accounted++;
          target.profit = M.add(target.profit, gain);
        }
      }
    }
    for (const customer of customers) {
      const day = bucket(customer.createdAt);
      if (day) day.customers++;
    }
    const { reminders } = renewalProjection();
    const retention = customerRetentionProjection();
    const pending = reminders.filter(row => row.state !== 'processed');
    const renewalsByProduct = Object.fromEntries(products.map(product => [product, 0]));
    for (const { order } of pending)
      if (Object.hasOwn(renewalsByProduct, order.product)) renewalsByProduct[order.product]++;
    return {
      daily: [...daily.values()], incomplete, renewals: pending.length, renewalsByProduct, active: retention.active,
      followUp: new Set(pending.map(row => row.identity).filter(Boolean)).size,
      lost: retention.lost.length
    };
  }
  let requestedAccountLifecycle = false, accountLifecycleReading = false;
  A.modules.commerce = {
    refreshCustomerTagOptions,
    refreshOverview: () => loadLocalCommerce(true, true),
    refreshAfterOrderSync,
    syncedOrderId,
    syncedOrderReadNotice,
    overviewSummary,
    hasPendingPersonalDelivery: accountId => orders.some(order => personalProduct(order.product) &&
      order.accountId === accountId && order.businessType === '成品交付' && !order.cancelled &&
      order.entitlementStatus !== 'active'),
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
      cardIssueContext = undefined;
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
      if ([renewalRoute, customerLossRoute, subscriptionCardsRoute].includes(S.route) &&
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
  function clearRenewalCardSecrets() {
    const panel = $('#commerce-renewal-card-panel');
    clearRenewalCardNumbers(panel);
    if (panel) renewalCardDrawers.delete(panel);
    clearSubscriptionCardCopyFallback?.();
  }
  window.addEventListener?.('pagehide', () => {
    const openSensitiveDrawer = $('#drawer[open] #commerce-renewal-card-panel') || clearSubscriptionCardCopyFallback;
    clearRenewalCardSecrets();
    if (openSensitiveDrawer && drawer.open) A.closeDrawer();
  });
  drawer?.addEventListener('close', () => {
    if (drawer.open) return;
    if (orderPriceReferenceReturn) {
      const back = orderPriceReferenceReturn;
      orderPriceReferenceReturn = null;
      if (S.route === back.route && currentOperator().id === back.actorId) {
        if (!back.main) orderEditor(back.orderId, back.renewalId, false);
        const form = $(`${back.main ? '#main' : '#drawer[open]'} #commerce-order-form`);
        form?.querySelector(`[data-action="commerce-order-price-reference"][data-kind="${back.view.kind}"]`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (bankCardTypeReturn) {
      const back = bankCardTypeReturn;
      bankCardTypeReturn = null;
      if (S.route === back.route && currentOperator().id === back.actorId) {
        if (back.onClose) back.onClose();
        else if (!back.order) A.render();
        else if (back.order.main) refreshOrderCardType($('#main #commerce-order-form'));
        else orderEditor(back.order.id, back.order.renewalId, false);
      }
      return;
    }
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
    onDataChanges(scopes) {
      if (scopes.includes('card-types')) bankCardTypesLoaded = false;
      if (S.route === subscriptionCardsRoute && ['card-types', 'finance-rates', 'settings'].some(scope => scopes.includes(scope)))
        return loadSubscriptionCardEstimates(true);
      const panel = $('#commerce-renewal-card-panel');
      if (renewalCardDrawerCurrent(panel) && ['commerce', 'inventory', 'card-types', 'finance-rates', 'settings', 'order-cards']
        .some(scope => scopes.includes(scope))) return loadRenewalCardDetails(panel);
    },
    clearPageState() {
      clearRenewalCardSecrets();
      retentionRefreshFailed = false;
    },
    render,
    onClick,
    onSubmit,
    onChange,
    onInput,
    preserveDraft: saveDrafts,
    refreshCustomerTagOptions,
    afterRender({ routeChanged } = {}) {
      bindEntryRecords();
      if (paymentSettingsActive()) {
        if (routeChanged) {
          paymentRatesStale = true;
          if (localData) {
            currencySettingsRevision++;
            priceLoad = null;
            void loadPaymentSettings();
          }
        }
        if (paymentSettingsView().tab === 'paid') {
          if (paymentSettingsVersion === null && !paymentSettingsError) void loadPaymentSettings();
          updatePaymentBudgets();
          void loadPaymentRates();
        }
        return;
      }
      for (const form of document.querySelectorAll('#commerce-order-form')) {
        if (personalProduct(form.elements['commerce-product'].value)) updateOrderVisibility(form);
        else updateCustomerEmailHistory(form);
      }
      for (const search of document.querySelectorAll('[data-commerce-picker]')) filterPicker(search);
      for (const control of document.querySelectorAll('.commerce-entry-layout input:not([type="hidden"]):not([type="checkbox"]), .commerce-entry-layout select:not([hidden])')) {
        orderValueObserver?.observe(control);
        updateOrderValueReadout(control);
      }
      loadLocalCommerce(false, routeChanged && Boolean(orderSyncRead));
      if (localData && !requestedAccountLifecycle && !A.modules.inventory?.accountLifecycleReady?.()) {
        requestedAccountLifecycle = true;
        accountLifecycleReading = true;
        const route = S.route;
        void A.modules.inventory?.refreshLocalInventory?.({ keepContent: true }).then(ready => {
          accountLifecycleReading = false;
          if (S.route === customerLossRoute) {
            if (!retentionRefresh) A.render();
            return;
          }
          if (!ready || route !== S.route) return;
          const form = $('#commerce-order-form');
          if (form) updateCustomerEmailHistory(form);
          else A.render();
        });
      }
      updateRenewalReminder();
      if (!localData || localPhase !== 'ready') return;
      if (S.route === subscriptionCardsRoute) loadSubscriptionCardEstimates();
      for (const form of document.querySelectorAll('#main #commerce-contact-form, #drawer[open] #commerce-contact-form')) void loadOrderOwners(form);
      if (isOrderEntry(S.route) || S.route.startsWith(renewalOrderPrefix)) {
        const form = $('#commerce-order-form');
        if (routeChanged) {
          currencySettingsRevision++;
          priceLoad = null;
        }
        if (form) void loadOrderOwners(form);
        if (form?.elements['commerce-payment']?.value === '苹果内购') loadAppleOptions(form);
        else if (form) {
          void loadOrderCards(form);
          void loadOrderCardType(form);
        }
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
    },
    async onDataChanges(scopes) {
      if (S.route === customerLossRoute && (scopes.includes('commerce') || scopes.includes('inventory'))) {
        if (scopes.includes('commerce') && !scopes.includes('inventory') && orders.some(retentionStockOrder))
          await A.modules.inventory?.refreshLocalInventory?.({ keepContent: true });
        if (S.route === customerLossRoute && !retentionRefresh) A.render();
      }
      if (scopes.includes('settings')) {
        currencySettingsRevision++;
        priceLoad = null;
        if (paymentSettingsActive()) await loadPaymentSettings();
        else if (canManageOrders()) {
          const form = $('#commerce-order-form');
          if (form) await loadPrices(form);
        }
      }
    }
  });
  // Quote updates change only the displayed estimate, including while an amount is being edited.
  localData?.subscribeChanges?.(scopes => {
    if (!scopes.includes('finance-rates')) return;
    const notice = localData.pendingChangeVersions?.(['finance-rates'])['finance-rates'];
    if (notice && notice === paymentRateNotice) return;
    paymentRateNotice = notice;
    paymentRatesStale = true;
    if (paymentSettingsActive() && paymentSettingsView().tab === 'paid') void loadPaymentRates();
  });
})();
