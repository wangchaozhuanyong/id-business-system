(() => {
  const A = window.IDDesignAPI, D = window.IDLocalData, S = A.state;
  const { $, esc, button, field, input, select } = A;
  const route = 'workspace/order-completion';
  const tabs = [['pending', '待补全'], ['complete', '已补全'], ['unassigned', '待分配'], ['manual', '手工与历史单']];
  const contacts = [['customerPhone', 'phone', '联系电话'], ['wechat', 'wechat', '微信'],
    ['qq', 'qq', 'QQ'], ['whatsapp', 'whatsapp', 'WhatsApp'], ['telegram', 'telegram', 'Telegram']];
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false
  });
  const displayTime = (value) => {
    if (!value) return '—';
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return time.format(Date.parse(value));
    return value.replace('T', ' ');
  };
  const active = () => D && S.route === route;
  const metaKey = (id) => 'completion-meta:' + id;
  const formPrefix = (id) => 'completion-form:' + id + ':';
  const find = (id) => snapshot?.items.find((row) => row.id === id);
  const open = (form) => form?.isConnected && $('#drawer').open && S.drawerContext === form.dataset.completionDraft;
  const money = (value, currency) => value && currency ? value + ' ' + currency : '待核对';
  const fieldId = (name) => 'completion-' + name;
  let snapshot, loadError, latestLoad, editor, saving, searchRequest, assigningManualOwners;
  let targetId, savedId;

  function render() {
    const title = A.header('订单提交',
      '在原单补充客户和实收。代充成功后自动入单，领码人可处理自己的订单。');
    if (!D) return title + '<section class="panel">' + A.empty('暂无可补全订单', '连接业务数据后显示已同步的代充订单。') + '</section>';
    const current = S.drafts.get(route)?.tab || 'pending';
    const available = snapshot?.canAssign ? tabs : tabs.slice(0, 2);
    const manual = current === 'manual' && snapshot?.canAssign;
    const query = S.query.trim().toLowerCase();
    const sourceRows = manual ? snapshot.manualItems || [] : (snapshot?.items || []).filter(row => row.state === current);
    const rows = sourceRows.filter(row => !query ||
      [row.orderNo, row.email, row.customerName || row.customer?.name].some(value => value?.toLowerCase().includes(query)));
    const counts = new Map();
    for (const row of snapshot?.items || []) counts.set(row.state, (counts.get(row.state) || 0) + 1);
    const tabMarkup = available.map(([id, label]) => {
      const count = snapshot ? id === 'manual' ? (snapshot.manualItems || []).length : counts.get(id) || 0 : '—';
      return '<button type="button" class="button completion-filter" data-action="completion-tab" data-id="' + id +
        '" aria-label="' + label + '" aria-pressed="' + (id === current) + '">' + label +
        '<span class="completion-count">' + count + '</span></button>';
    }).join('');
    const missingTags = row => row.missing.map(label => A.tag(label, 'warning')).join(' ');
    const columns = manual ? [
      { id: 'orderNo', label: '订单编号' }, { id: 'email', label: '邮箱账号' },
      { id: 'plan', label: '产品 / 套餐', render: row => esc([row.product, row.plan].filter(Boolean).join(' / ')) },
      { id: 'customerName', label: '客户' },
      { id: 'missing', label: '待补资料', render: missingTags },
      { id: 'owner', label: '处理人', render: row => esc(row.owner || '未设置') },
      { id: 'actions', label: '操作', action: true, render: row => A.textAction(
        '查看原单', 'completion-original', 'data-id="' + esc(row.id) + '"') }
    ] : [
      { id: 'orderNo', label: '订单编号' }, { id: 'email', label: '账号邮箱' }, { id: 'plan', label: '套餐' },
      { id: 'rechargeCompletedAt', label: '开通时间', render: (row) => esc(displayTime(row.rechargeCompletedAt || row.start)) },
      ...(snapshot?.canAssign ? [{ id: 'owner', label: '归属人', render: (row) => esc(row.owner || '—') }] : []),
      { id: 'customer', label: current === 'complete' ? '客户' : '缺少资料', render: (row) =>
        current === 'complete' ? esc(row.customer?.name || '—') : missingTags(row) },
      { id: 'finance', label: '客户实收', render: row => row.receiptRecorded
        ? esc(money(row.saleAmount, row.saleCurrency)) : A.tag('未登记', 'warning') },
      { id: 'actions', label: '操作', action: true, render: (row) => A.textAction(
        row.state === 'complete' ? '查看此订单' : '补全资料',
        'completion-open', 'data-id="' + esc(row.id) + '"') }
    ];
    const shown = A.pageRows(rows);
    const emptyTitle = query ? '未找到符合条件的订单'
      : current === 'complete' ? '暂无已补全订单' : current === 'unassigned' ? '暂无待分配订单' : '暂无待补全订单';
    const contents = snapshot ? A.table(columns, shown, '', manual ? '手工与历史单' : '订单补全', { title: emptyTitle, description: '' }) +
      A.pagination(rows.length) : '';
    const assignOwners = manual && sourceRows.some(row => row.needsOwner)
      ? button('补齐空白归属', 'completion-assign-manual') : '';
    const saved = find(savedId);
    const savedNotice = saved?.state === 'complete'
      ? '<div class="panel-body completion-saved"><span role="status">' + esc(saved.orderNo) + ' 已补全</span>' +
        A.textAction('查看此订单', 'completion-view-saved', 'data-id="' + esc(saved.id) + '"') + '</div>'
      : '';
    return title + '<section class="panel design-async-region" id="completion-list">' +
      '<div class="list-controls completion-controls"><div class="completion-status-filters" role="group" aria-label="订单补全分类">' +
      tabMarkup + '</div><div class="toolbar"><div class="toolbar-left"><div class="search-field">' + A.icon('search') +
      input('list-search', S.query, 'data-auto-search type="search" aria-label="搜索订单" placeholder="订单号、邮箱或客户"') +
      '</div>' + button('刷新', 'completion-refresh', '', 'refresh') +
      '</div>' + (assignOwners ? '<div class="toolbar-right">' + assignOwners + '</div>' : '') +
      '</div></div><div role="status" id="completion-list-progress" hidden></div>' +
      (loadError ? '<div class="panel-body"><p class="inline-notice warning" role="status">' +
        (snapshot ? '刷新失败，已保留上次订单。' : '暂时无法读取订单，请刷新重试。') + '</p></div>' : '') +
      savedNotice + contents + '</section>';
  }

  async function load() {
    const panel = $('#completion-list');
    if (!active() || !panel) return false;
    const token = latestLoad = Symbol();
    const read = A.beginRegionRead(panel, $('#completion-list-progress'), {
      loadingText: '正在读取订单…', refreshButton: $('[data-action="completion-refresh"]')
    });
    try {
      const data = await D.orderCompletion();
      if (latestLoad !== token || !active()) return false;
      if (!Array.isArray(data?.items)) throw new Error('订单响应格式无效');
      snapshot = data;
      if (!data.canAssign && ['unassigned', 'manual'].includes(S.drafts.get(route)?.tab)) S.drafts.delete(route);
      loadError = false;
      const target = targetId && find(targetId);
      if (targetId) {
        targetId = undefined;
        if (target) {
          S.drafts.set(route, { tab: target.state });
          S.page = 1;
          S.query = '';
        }
      }
      A.render();
      if (target && !saving && !$('#drawer').open) show(target, target.state === 'complete');
      return true;
    } catch (error) {
      if (latestLoad !== token || !active()) return false;
      if ([401, 403].includes(error.status)) snapshot = undefined;
      loadError = true;
      A.render();
      return false;
    } finally {
      read.finish();
    }
  }

  function confirmManualOwners() {
    if (!snapshot?.canAssign || assigningManualOwners || !snapshot.manualItems?.some(row => row.needsOwner)) return;
    A.confirmAction('补齐手工订单归属', '将当前缺少归属的手工和历史订单分配给超级管理员。', async () => {
      if (!active() || !snapshot?.canAssign || assigningManualOwners) return;
      assigningManualOwners = true;
      try {
        const { assigned } = await D.saveOrderCompletion({ action: 'assign-manual-owners' });
        if (assigned) await A.modules.commerce?.refreshAfterOrderSync?.();
        if (!active()) return;
        A.notify(assigned ? '已补齐 ' + assigned + ' 笔订单归属' : '当前订单归属已齐全');
        await load();
      } catch (error) {
        if (active()) A.notify(error.message || '暂时无法保存归属');
      } finally {
        assigningManualOwners = false;
      }
    }, '确认补齐');
  }

  function section(title, content) {
    return '<section class="form-section"><div class="section-heading"><h2>' + esc(title) +
      '</h2></div>' + content + '</section>';
  }
  function properties(rows) {
    return '<div class="property-list">' + rows.map(([label, value]) =>
      '<div class="property-row"><span>' + esc(label) + '</span><strong>' + esc(value || '—') +
      '</strong></div>').join('') + '</div>';
  }
  function evidence(row) {
    return section('原订单', properties([
      ['订单编号', row.orderNo], ['账号邮箱', row.email], ['充值套餐', row.plan], ['归属人', row.owner],
      ['开通时间', displayTime(row.rechargeCompletedAt || row.start)], ['到期时间', displayTime(row.expiry)],
      ...(row.bankPayment ? [['银行卡尾号', row.cardLast4]] : [])
    ])) + section('金额与凭据', properties([
      ['配置代付', money(row.standardPaidAmount, row.paidCurrency)],
      ['代充实扣', row.paidConfirmed ? money(row.paidAmount, row.paidCurrency) : '未取得凭据'],
      ['入库配置售价', money(row.configuredSaleAmount, row.configuredSaleCurrency)],
      ['客户实收', row.receiptRecorded ? money(row.saleAmount, row.saleCurrency) : '未登记']
    ]) + (row.financeIssues.length ? '<p class="inline-notice warning">' + esc(row.financeIssues.join('、')) + '</p>' : ''));
  }

  function getMeta(row) {
    const key = metaKey(row.id);
    if (!S.drafts.has(key)) S.drafts.set(key, { version: row.version, linkedVersion: row.customer?.version });
    return S.drafts.get(key);
  }

  function preserveDraft() {
    const form = $('#drawer[open] form[data-completion-draft]');
    if (!form || saving === form.dataset.id) return;
    S.drafts.set(form.dataset.completionDraft, A.readDraft(form));
  }
  function draftControl(name, label, value, attrs = '', required = false) {
    const id = fieldId(name);
    return field(label, id, input(id, value, attrs), required);
  }
  function draftText(name, label, value, max, required = false) {
    const id = fieldId(name);
    return field(label, id, '<textarea id="' + id + '" name="' + id + '" rows="2" maxlength="' + max +
      '"' + (required ? ' required' : '') + '>' + esc(value || '') + '</textarea>', required);
  }
  function chosenCustomer(row, meta, draft) {
    const person = row.customer || meta.customer;
    const name = person?.name || meta.newName;
    if (name) return properties([['客户', name + (!person && meta.newName ? '（待保存）' : '')]]) +
      (row.customer ? '' : button('更换客户', 'completion-unselect'));
    const id = fieldId('customer-query');
    return field('选择客户', id, '<div class="field-row">' +
      input(id, draft[id] || '', 'data-auto-search type="search" maxlength="100" placeholder="搜索姓名或联系方式"') +
      button('新增客户', 'completion-new', '', 'plus') + '</div>') +
      '<div id="completion-customer-results" class="guide-list" role="status">输入关键词搜索客户。</div>';
  }

  function customerFields(row, meta, draft) {
    const person = row.customer || meta.customer;
    const currentSource = row.customerSource || person?.source;
    const key = fieldId('source');
    const sources = snapshot?.sources || [];
    const details = [currentSource ? properties([['客户来源', currentSource]]) :
      field('客户来源', key, select(key, [['', '未登记'], ...sources.map(source => [source, source])], draft[key]))];
    for (const [name, customerField, label] of contacts) {
      const value = row[name] || person?.[customerField];
      details.push(value ? properties([[label, value]]) : draftControl(name, label, draft[fieldId(name)] || '', 'maxlength="60"'));
    }
    details.push(row.notes ? properties([['备注', row.notes]]) : draftText('notes', '补充备注', draft[fieldId('notes')], 1000));
    return details.join('');
  }

  function editorForm(row, key, content) {
    return '<form id="completion-form" data-id="' + esc(row.id) + '" data-completion-draft="' + esc(key) +
      '">' + content + '<p id="completion-form-error" class="inline-notice warning" role="alert" hidden></p>' +
      button('重新核对', 'completion-recheck', '', '', 'hidden') + '</form>';
  }
  function footer(key, label) {
    return button('关闭', 'drawer-close') + (label ?
      '<button class="button primary" type="submit" form="' + key + '">' + esc(label) + '</button>' : '');
  }
  function show(row, editing = false) {
    const meta = getMeta(row);
    editor = { row, meta, editing };
    const help = '可以先保存手头已有的资料。补齐归属、客户和实际收款后，这笔订单会显示在 GPT 当前订单。';
    if (row.state === 'complete' && !editing) {
      const customer = row.customer;
      A.openDrawer('订单详情', '查看这笔代充订单及已登记的客户资料。', evidence(row) + section('客户资料',
        properties([['客户', customer?.name], ['客户来源', row.customerSource],
          ...contacts.map(([key, master, label]) => [label, row[key] || customer?.[master]]), ['备注', row.notes]])),
        footer() + button('补充资料', 'completion-optional'));
      return;
    }
    const key = formPrefix(row.id) + 'details';
    const draft = S.drafts.get(key) || {};
    const owner = fieldId('owner');
    const assignment = row.state === 'unassigned' && snapshot?.canAssign ? section('订单归属',
      field('归属人', owner, select(owner, [['', '待分配'], ...snapshot.owners.map(({ id, name }) => [id, name])], draft[owner])) +
      draftText('reason', '归属依据', draft[fieldId('reason')], 200)) : '';
    const currency = fieldId('receipt-currency');
    const currencies = [...new Set([...(snapshot?.receiptCurrencies || ['CNY', 'MYR', 'USD']),
      ...(row.saleCurrency ? [row.saleCurrency] : [])])];
    const receipt = row.receiptRecorded ? '' : section('登记实收',
      '<div class="form-grid">' +
      field('实际收款金额', fieldId('receipt-amount'),
        input(fieldId('receipt-amount'), draft[fieldId('receipt-amount')], 'inputmode="decimal" maxlength="21"'),
        false, '填客户实际付给你的金额，可留空并稍后补录。') +
      field('收款币种', currency, select(currency, currencies, draft[currency] || row.saleCurrency || 'CNY')) + '</div>');
    const optional = [
      !window.IDOrderOpening.validOrderEmail(row.email) && draftControl('email', '账号邮箱', draft[fieldId('email')], 'type="email" maxlength="254"'),
      row.bankPayment && !row.cardLast4 && draftControl('card-last4', '银行卡尾号', draft[fieldId('card-last4')],
        'inputmode="numeric" maxlength="4" pattern="[0-9]{4}"')
    ].filter(Boolean);
    const details = assignment + section('客户资料',
      (row.customerLinkMissing ? '<p class="inline-notice warning">原客户关联缺失，可重新选择客户。</p>' : '') +
      chosenCustomer(row, meta, draft) + customerFields(row, meta, draft)) + receipt +
      (optional.length ? section('账号与用卡资料（选填）', '<div class="form-grid">' + optional.join('') + '</div>') : '');
    A.openDrawer('补全订单资料', help, evidence(row) + editorForm(row, key, details), footer('completion-form', '保存订单'), key);
    if (meta.version !== row.version || (row.customer && meta.linkedVersion !== row.customer.version))
      formError('原订单或客户资料已更新，请重新核对后保存。', true);
    if (!row.customer && !meta.customer && !meta.newName && draft[fieldId('customer-query')])
      scheduleSearch($('#' + fieldId('customer-query')));
  }

  function quickNew() {
    if (!editor) return;
    preserveDraft();
    const { row } = editor;
    const key = formPrefix(row.id) + 'quick';
    const draft = S.drafts.get(key) || {};
    const name = draftControl('name', '客户姓名', draft[fieldId('name')] || '',
      'maxlength="80" required autocomplete="off"', true);
    A.openDrawer('新增客户', '填好姓名后返回订单，随补全一起保存客户资料。',
      '<form id="completion-quick-form" data-id="' + esc(row.id) + '" data-completion-draft="' + esc(key) + '">' +
      section('基本资料', name) + '</form>', button('返回订单', 'completion-back') +
      '<button class="button primary" type="submit" form="completion-quick-form">选用此客户</button>', key);
  }

  async function scheduleSearch(node) {
    const token = searchRequest = Symbol();
    const form = node.form, query = node.value.trim();
    const result = $('#completion-customer-results');
    const selected = editor;
    if (!query) { result.textContent = '输入关键词搜索客户。'; return; }
    result.textContent = '正在搜索客户…';
    const current = () => searchRequest === token && editor === selected && open(form) && node.value.trim() === query;
    try {
      const { items } = await D.orderCompletion({ orderId: selected.row.id, q: query });
      if (!current()) return;
      selected.results = items || [];
      result.innerHTML = selected.results.length ? selected.results.map((person) => {
        const hint = [person.source, ...contacts.map(([, key]) => person[key])].filter(Boolean).join(' · ');
        return '<div class="guide-item"><strong>' + esc(person.name) + '</strong>' +
          (hint ? '<p>' + esc(hint) + '</p>' : '') + A.textAction('选择客户', 'completion-select',
            'data-id="' + esc(person.id) + '" aria-label="选择客户 ' + esc(person.name) + '"') + '</div>';
      }).join('') : '未找到客户，可以调整关键词或新增客户。';
    } catch {
      if (current()) result.textContent = '搜索失败，请修改关键词后重试。';
    }
  }

  function formError(message, canRecheck = false) {
    const error = $('#completion-form-error');
    if (!error) return;
    error.hidden = !message;
    error.textContent = message;
    $('[data-action="completion-recheck"]').hidden = !canRecheck;
    if (canRecheck) $('button[form="completion-form"][type="submit"]').disabled = true;
  }

  async function recheck() {
    const current = editor;
    const form = $('#completion-form');
    preserveDraft();
    if (!await load() || editor !== current || !open(form)) return;
    const row = find(current.row.id);
    if (!row) {
      formError('该订单已不在当前补全范围内。');
      $('button[form="completion-form"][type="submit"]').disabled = true;
      return;
    }
    current.meta.version = row.version;
    current.meta.linkedVersion = row.customer?.version;
    if (current.meta.customer) {
      const values = takeCustomerDraft(row.id);
      if (current.meta.customer.id === row.customer?.id) Object.assign(S.drafts.get(formPrefix(row.id) + 'details'), values);
      else current.meta.recheckCustomer = { id: current.meta.customer.id, values };
      current.meta.customer = undefined;
    }
    show(row, current.editing);
  }

  async function save(form) {
    const current = editor;
    const { row, meta } = current;
    if (saving || !open(form)) return;
    const raw = A.readForm(form), read = (key) => raw[fieldId(key)]?.trim();
    const customer = row.customer || meta.customer;
    const amount = read('receipt-amount');
    if (amount && !/^\d{1,16}(?:\.\d{1,4})?$/.test(amount)) {
      formError('请填写有效的实际收款金额，最多四位小数。');
      return;
    }
    const ownerId = read('owner');
    const reason = read('reason');
    if (ownerId && !reason) { formError('请填写归属依据。'); return; }
    const command = {
      action: 'complete', orderId: row.id, version: meta.version,
      customerSource: read('source'), notes: read('notes'), email: read('email'), cardLast4: read('card-last4'),
      contacts: Object.fromEntries(contacts.map(([key]) => [key, read(key)]).filter(([, value]) => value)),
      ...(amount && { receipt: { amount, currency: read('receipt-currency') } }),
      ...(ownerId && { ownerId, reason })
    };
    if (customer) {
      command.customerId = customer.id;
      command.customerVersion = row.customer ? meta.linkedVersion : customer.version;
    } else if (meta.newName) command.newCustomer = { name: meta.newName };
    preserveDraft();
    formError('');
    saving = row.id;
    const controls = [...form.elements, $('button[form="completion-form"][type="submit"]')]
      .filter((node) => node && !node.disabled);
    controls.forEach((node) => { node.disabled = true; });
    let result;
    try {
      result = await D.saveOrderCompletion(command);
    } catch (error) {
      if (open(form)) {
        controls.forEach((node) => { node.disabled = false; });
        formError(error.message || '保存失败，请重试。', error.status === 409);
      } else if (editor === current) {
        // Closing a disabled form during save cannot capture its fields.
        S.drafts.set(form.dataset.completionDraft, raw);
      }
      return;
    } finally {
      if (saving === row.id) saving = undefined;
    }
    if (editor !== current) return;
    if (open(form)) A.closeDrawer();
    for (const key of S.drafts.keys()) if (key === metaKey(row.id) || key.startsWith(formPrefix(row.id))) S.drafts.delete(key);
    editor = undefined;
    if (!active()) return;
    savedId = result.state === 'complete' ? row.id : undefined;
    A.notify(savedId ? '订单已补全' : '已保存已有资料');
    await Promise.all([load(), A.modules.commerce?.refreshAfterOrderSync?.()]);
  }

  function takeCustomerDraft(id) {
    const draft = S.drafts.get(formPrefix(id) + 'details') || {};
    const values = {};
    for (const name of ['source', ...contacts.map(([key]) => key)]) {
      const key = fieldId(name);
      if (!Object.hasOwn(draft, key)) continue;
      values[key] = draft[key];
      delete draft[key];
    }
    return values;
  }

  A.modules.orderCompletion = {
    open(id) {
      targetId = id;
      if (active()) void load();
      else A.go(route);
    }
  };

  window.IDDesignModules.push({
    id: 'order-completion',
    matches: (value) => value === route,
    render,
    afterRender({ routeChanged }) { if (active() && routeChanged) void load(); },
    async onDataChanges(scopes) {
      if (!active() || !scopes.some((scope) => ['commerce', 'settings', 'operators'].includes(scope))) return;
      await load();
      return !active() || !loadError;
    },
    clearPageState() {
      snapshot = loadError = latestLoad = editor = searchRequest = saving = targetId = savedId = undefined;
      for (const key of S.drafts.keys()) if (key === route || key.startsWith('completion-')) S.drafts.delete(key);
    },
    preserveDraft,
    onInput(node) {
      if (node.id === fieldId('customer-query')) scheduleSearch(node);
    },
    async onClick(action, node) {
      if (!active() || !action.startsWith('completion-')) return false;
      if (action === 'completion-refresh') await load();
      else if (action === 'completion-tab') {
        S.drafts.set(route, { tab: node.dataset.id });
        S.page = 1;
        A.render();
      } else if (action === 'completion-open') {
        if (saving) A.notify('订单正在保存，请稍候');
        else if (find(node.dataset.id)) show(find(node.dataset.id));
      } else if (action === 'completion-view-saved') {
        const row = find(node.dataset.id);
        if (row?.state === 'complete') {
          if (A.canVisit('orders/detail/' + encodeURIComponent(row.id))) A.go('orders/detail/' + encodeURIComponent(row.id));
          else show(row);
        }
      } else if (action === 'completion-original') {
        if (snapshot?.manualItems?.some(row => row.id === node.dataset.id))
          A.go('orders/detail/' + encodeURIComponent(node.dataset.id));
      } else if (action === 'completion-assign-manual') confirmManualOwners();
      else if (action === 'completion-new') quickNew();
      else if (action === 'completion-optional' && editor) {
        const row = find(editor.row.id);
        if (row) {
          S.drafts.delete(metaKey(row.id));
          show(row, true);
        }
      }
      else if (action === 'completion-back') { preserveDraft(); show(editor.row, editor.editing); }
      else if (action === 'completion-unselect' || action === 'completion-select') {
        preserveDraft();
        if (action === 'completion-unselect') takeCustomerDraft(editor.row.id);
        const person = action === 'completion-select' ? editor.results?.find(row => row.id === node.dataset.id) : undefined;
        const held = editor.meta.recheckCustomer;
        if (held && person?.id === held.id) Object.assign(S.drafts.get(formPrefix(editor.row.id) + 'details'), held.values);
        editor.meta.recheckCustomer = undefined;
        editor.meta.customer = person;
        editor.meta.newName = '';
        show(editor.row, editor.editing);
      } else if (action === 'completion-recheck') await recheck();
      return true;
    },
    async onSubmit(form) {
      if (!active() || !editor || !open(form)) return false;
      if (form.id === 'completion-form') await save(form);
      else if (form.id === 'completion-quick-form') {
        const name = A.readForm(form)[fieldId('name')].trim();
        if (!name) { A.setError(fieldId('name'), '请填写客户姓名'); return true; }
        editor.meta.customer = undefined;
        editor.meta.newName = name;
        show(editor.row, editor.editing);
      } else return false;
      return true;
    }
  });
})();
