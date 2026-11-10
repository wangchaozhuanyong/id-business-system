(() => {
  const A = window.IDDesignAPI, D = window.IDLocalData, S = A.state;
  const { $, esc, button, field, input, select } = A;
  const route = 'workspace/order-completion';
  const tabs = [['pending', '待补全'], ['complete', '已补全'], ['unassigned', '待归属']];
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
  let snapshot, loadError, latestLoad, editor, saving, searchTimer, searchRequest;

  function render() {
    const title = A.header('订单补全',
      '代充成功并同步后，按充值码领用人分配。补全结果保存到原订单。',
      D ? button('刷新', 'completion-refresh', '', 'refresh') : '');
    if (!D) return title + '<section class="panel">' + A.empty('暂无可补全订单', '连接业务数据后显示已同步的代充订单。') + '</section>';
    const current = S.drafts.get(route)?.tab || 'pending';
    const available = snapshot?.canAssign ? tabs : tabs.slice(0, 2);
    const query = S.query.trim().toLowerCase();
    const rows = (snapshot?.items || []).filter((row) => row.state === current && (!query ||
      [row.orderNo, row.email, row.customer?.name].some((value) => value?.toLowerCase().includes(query))));
    const tabMarkup = available.map(([id, label]) => '<button type="button" class="tab' +
      (id === current ? ' active' : '') + '" data-action="completion-tab" data-id="' + id +
      '" aria-pressed="' + (id === current) + '">' + label + '</button>').join('');
    const columns = [
      { id: 'orderNo', label: '订单编号' }, { id: 'email', label: '账号邮箱' }, { id: 'plan', label: '套餐' },
      { id: 'rechargeCompletedAt', label: '开通时间', render: (row) => esc(displayTime(row.rechargeCompletedAt || row.start)) },
      ...(snapshot?.canAssign ? [{ id: 'owner', label: '归属人', render: (row) => esc(row.owner || '—') }] : []),
      { id: 'customer', label: current === 'pending' ? '缺少资料' : '客户', render: (row) =>
        esc(current === 'pending' ? row.missing.join('、') : row.customer?.name || '—') },
      { id: 'finance', label: '金额核对', render: (row) => row.financeIssues.length ? A.tag('待核对', 'warning') : A.tag('已核对') },
      { id: 'actions', label: '操作', action: true, render: (row) => A.textAction(
        row.state === 'unassigned' ? '确认归属' : row.state === 'pending' && !row.customerLinkMissing ? '补全资料' : '查看',
        'completion-open', 'data-id="' + esc(row.id) + '"') }
    ];
    const shown = A.pageRows(rows);
    const emptyTitle = query ? '未找到符合条件的订单'
      : current === 'complete' ? '暂无已补全订单' : current === 'unassigned' ? '暂无待归属订单' : '暂无待补全订单';
    const contents = snapshot ? A.table(columns, shown, '', '订单补全', { title: emptyTitle, description: '' }) +
      A.pagination(rows.length) : '';
    return title + '<section class="panel design-async-region" id="completion-list">' +
      '<div class="list-controls"><div class="tabs" role="group" aria-label="订单补全分类">' +
      tabMarkup + '</div><div class="toolbar"><div class="toolbar-left"><div class="search-field">' + A.icon('search') +
      input('list-search', S.query, 'type="search" aria-label="搜索订单" placeholder="搜索订单编号、邮箱或客户"') +
      '</div></div><div class="toolbar-right" data-page-actions></div></div></div><div role="status" id="completion-list-progress" hidden></div>' +
      (loadError ? '<div class="panel-body"><p class="inline-notice warning" role="status">' +
        (snapshot ? '刷新失败，已保留上次订单。' : '暂时无法读取订单，请刷新重试。') + '</p></div>' : '') +
      contents + '</section>';
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
      if (!data.canAssign && S.drafts.get(route)?.tab === 'unassigned') S.drafts.delete(route);
      loadError = false;
      A.render();
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
      ['开通时间', displayTime(row.rechargeCompletedAt || row.start)], ['到期时间', displayTime(row.expiry)]
    ])) + section('金额与凭据', properties([
      ['配置代付', money(row.standardPaidAmount, row.paidCurrency)],
      ['代充实扣', row.paidConfirmed ? money(row.paidAmount, row.paidCurrency) : '待核对'],
      ['入库配置收费', money(row.configuredSaleAmount, row.configuredSaleCurrency)],
      ['原单收费', money(row.saleAmount, row.saleCurrency)],
      ['实收状态', row.receiptConfirmed ? '已确认' : '待确认']
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
    const values = A.readDraft(form);
    S.drafts.set(form.dataset.completionDraft, values);
    const meta = S.drafts.get(metaKey(form.dataset.id));
    if (meta && values[fieldId('notes')] !== undefined) meta.notes = values[fieldId('notes')];
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
      input(id, draft[id] || '', 'type="search" maxlength="100" placeholder="搜索姓名或联系方式"') +
      button('新增客户', 'completion-new', '', 'plus') + '</div>', true) +
      '<div id="completion-customer-results" class="guide-list" role="status">输入关键词搜索客户。</div>';
  }

  function customerFields(row, meta, draft) {
    const person = row.customer || meta.customer;
    const currentSource = row.customerSource || person?.source;
    const key = fieldId('source');
    const sources = snapshot?.sources || [];
    const details = [currentSource ? properties([['客户来源', currentSource]]) :
      field('客户来源', key, select(key, [['', '请选择来源'], ...sources.map((source) => [source, source])], draft[key])
        .replace('<select ', '<select required '), true)];
    if (!currentSource && !sources.length) details.push('<p class="footnote">请管理员先在系统设置中配置客户来源。</p>');
    for (const [name, customerField, label] of contacts) {
      const value = row[name] || person?.[customerField];
      details.push(value ? properties([[label, value]]) : draftControl(name, label, draft[fieldId(name)] || '', 'maxlength="60"'));
    }
    details.push(row.notes ? properties([['备注', row.notes]]) : draftText('notes', '补充备注', meta.notes, 1000));
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
  function show(row) {
    const meta = getMeta(row);
    editor = { row, meta };
    const help = '按原单核对充值结果，在客户资料区补齐信息。';
    if (row.state === 'complete' || (row.state === 'pending' && row.customerLinkMissing)) {
      const customer = row.customer;
      A.openDrawer('订单补全详情', help, evidence(row) + section('客户资料',
        row.customerLinkMissing ? '<p class="inline-notice warning">请在原订单核对现有客户关联。</p>'
          : properties([['客户', customer?.name], ['客户来源', row.customerSource],
            ...contacts.map(([key, master, label]) => [label, row[key] || customer?.[master]]), ['备注', row.notes]])),
      footer());
      return;
    }
    const assign = row.state === 'unassigned';
    const choice = row.customer || meta.customer;
    const key = formPrefix(row.id) + (assign ? 'assign' : choice?.id || (meta.newName ? 'new' : 'search'));
    const draft = S.drafts.get(key) || {};
    const owner = fieldId('owner');
    const details = assign ? section('确认归属',
      field('归属人', owner, select(owner, [['', '请选择启用人员'], ...(snapshot?.owners || []).map(({ id, name }) => [id, name])],
        draft[owner]).replace('<select ', '<select required '), true) +
      draftText('reason', '归属依据', draft[fieldId('reason')], 200, true))
      : section('客户资料', chosenCustomer(row, meta, draft) +
        (choice || meta.newName ? customerFields(row, meta, draft) : ''));
    A.openDrawer(assign ? '确认订单归属' : '补全订单资料', help, evidence(row) + editorForm(row, key, details),
      footer('completion-form', assign ? '保存归属' : '保存补全'), key);
    if (meta.version !== row.version || (row.customer && meta.linkedVersion !== row.customer.version))
      formError('原订单或客户资料已更新，请重新核对后保存。', true);
    if (!assign && !choice && !meta.newName && draft[fieldId('customer-query')]) scheduleSearch($('#' + fieldId('customer-query')));
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

  function scheduleSearch(node) {
    clearTimeout(searchTimer);
    const token = searchRequest = Symbol();
    const form = node.form, query = node.value.trim();
    const result = $('#completion-customer-results');
    const selected = editor;
    if (!query) { result.textContent = '输入关键词搜索客户。'; return; }
    result.textContent = '正在搜索客户…';
    searchTimer = setTimeout(async () => {
      try {
        const { items } = await D.orderCompletion({ orderId: selected.row.id, q: query });
        if (searchRequest !== token || editor !== selected || !open(form)) return;
        selected.results = items || [];
        result.innerHTML = selected.results.length ? selected.results.map((person) => {
          const hint = [person.source, ...contacts.map(([, key]) => person[key])].filter(Boolean).join(' · ');
          return '<div class="guide-item"><strong>' + esc(person.name) + '</strong>' +
            (hint ? '<p>' + esc(hint) + '</p>' : '') + A.textAction('选择客户', 'completion-select',
              'data-id="' + esc(person.id) + '" aria-label="选择客户 ' + esc(person.name) + '"') + '</div>';
        }).join('') : '未找到客户，可以调整关键词或新增客户。';
      } catch {
        if (searchRequest === token && editor === selected && open(form)) result.textContent = '搜索失败，请修改关键词后重试。';
      }
    }, 200);
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
    // Keep the typed draft by customer; reselect to read the latest version.
    current.meta.customer = undefined;
    show(row);
  }

  async function save(form) {
    const current = editor;
    const { row, meta } = current;
    if (saving || !open(form)) return;
    const raw = A.readForm(form), read = (key) => raw[fieldId(key)]?.trim();
    const base = { orderId: row.id, version: meta.version };
    let command;
    if (row.state === 'unassigned') {
      command = { ...base, action: 'assign', ownerId: read('owner'), reason: read('reason') };
    } else {
      const customer = row.customer || meta.customer;
      if (!customer && !meta.newName) { formError('请选择已有客户或新增客户。'); return; }
      command = { ...base, action: 'complete', customerSource: read('source'), notes: read('notes'),
        contacts: Object.fromEntries(contacts.map(([key]) => [key, read(key)]).filter(([, value]) => value)) };
      if (customer) {
        command.customerId = customer.id;
        command.customerVersion = row.customer ? meta.linkedVersion : customer.version;
      } else command.newCustomer = { name: meta.newName };
    }
    preserveDraft();
    formError('');
    saving = row.id;
    const controls = [...form.elements, $('button[form="completion-form"][type="submit"]')]
      .filter((node) => node && !node.disabled);
    controls.forEach((node) => { node.disabled = true; });
    try {
      await D.saveOrderCompletion(command);
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
    A.notify(row.state === 'unassigned' ? '已保存订单归属' : '已补全原订单');
    await Promise.all([load(), A.modules.commerce?.refreshOverview()]);
  }

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
      snapshot = loadError = latestLoad = editor = searchRequest = saving = undefined;
      clearTimeout(searchTimer);
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
      } else if (action === 'completion-new') quickNew();
      else if (action === 'completion-back') show(editor.row);
      else if (action === 'completion-unselect' || action === 'completion-select') {
        preserveDraft();
        editor.meta.customer = action === 'completion-select' ? editor.results?.find((row) => row.id === node.dataset.id) : undefined;
        editor.meta.newName = '';
        show(editor.row);
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
        show(editor.row);
      } else return false;
      return true;
    }
  });
})();
