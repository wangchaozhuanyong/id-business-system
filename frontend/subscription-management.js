(() => {
  'use strict';

  const A = window.IDDesignAPI, D = window.IDLocalData;
  const { $, esc, button, textAction } = A;
  const labels = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' };
  const states = window.IDOrderOpening.subscriptionStateLabels;
  const parseTime = window.IDOrderOpening.subscriptionTime;
  const codeStates = { active: '有效', missing: '未登记', expired: '已过期', disabled: '已停用',
    auth_failed: '授权失败', conflict: '资料冲突', not_applicable: '不适用' };
  const scopes = ['inventory', 'commerce', 'tools/mailbox-pool', 'subscription-management'];
  const tableId = 'subscription-accounts';
  const scopeLabels = { customer: '客户订阅', owned: '自有账号', unlinked: '待补邮箱' };
  let snapshot, error, requestNumber = 0, clearCopy, ownerContext, expiryTimer, frameObserver;
  const frameHeights = new Map();
  const product = () => {
    const [section, name] = A.state.route.split('/');
    return section === 'subscriptions' ? labels[name] || '' : '';
  };
  const active = () => Boolean(product() && D?.subscriptions &&
    (!D.authRequired || ['admin', 'super'].includes(D.actor()?.role)));
  const filterKey = () => 'subscription-filters:' + product();
  const filters = () => {
    const key = filterKey();
    if (!A.state.drafts.has(key)) {
      A.state.drafts.set(key, { scope: 'customer', input: '', query: '', status: '', sort: 'expiry_asc', page: 1,
        pageSize: window.IDPagination.defaultPageSize });
    }
    return A.state.drafts.get(key);
  };
  const selectedScope = () => filters().scope || 'customer';
  const scopeOptions = () => product() === 'Claude' ? Object.keys(scopeLabels) : ['customer', 'unlinked'];
  const currentSnapshot = () => snapshot?.product === product() && snapshot.scope === selectedScope() ? snapshot : null;
  const currentRow = id => currentSnapshot()?.items.find(row => row.id === id);
  function requestFilters() {
    const f = filters();
    return { product: product(), scope: selectedScope(), query: f.query.trim(), status: f.status,
      sort: f.sort || 'expiry_asc', page: f.page, pageSize: f.pageSize };
  }
  const timeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
  const displayDate = value => Number.isFinite(parseTime(value)) ? timeFormatter.format(parseTime(value)) : '未登记';
  const displayDays = value => Number.isInteger(value) ? `${value} 天` : '—';
  const lineValues = (row, render) => row.series.map(series => `<div>${render(series)}</div>`).join('');
  const stateTag = status => A.tag(states[status] || '待核对', status === 'active' ? 'green' : status === 'pending' ? 'warning' : '');
  const emailAccount = row => row.registrationEmail || row.account || '未登记';
  const canCopy = row => !row.conflict && !row.missingAssociation && row.credentialStatus !== 'conflict';

  function columns() {
    const unlinked = selectedScope() === 'unlinked';
    return [
      { id: 'email', label: unlinked ? '订单编号' : '邮箱账号', class: 'email-cell',
        render: row => esc(unlinked ? row.history[0]?.orderNo || '—' : emailAccount(row)) },
      { id: 'plan', label: '订阅套餐', render: row => lineValues(row, series => esc(series.plan || '待核对')) },
      { id: 'start', label: '订阅时间', render: row => lineValues(row, series => esc(displayDate(series.start))) },
      { id: 'expiry', label: '到期时间', render: row => lineValues(row, series => esc(displayDate(series.expiry))) },
      { id: 'days', label: '订阅剩余天数', render: row => lineValues(row, series => esc(displayDays(series.remainingDays))) },
      { id: 'status', label: '订阅状态', render: row => row.conflict ? stateTag('pending') :
        lineValues(row, series => stateTag(series.status)) +
        (!unlinked && row.missingAssociation ? A.tag('客户待补', 'warning') : '') },
      { id: 'ownerName', label: unlinked ? '订单处理人' : '归属人',
        render: row => esc(row.ownerName || (row.ownerEligible ? '未设置' : '—')) },
      { id: 'operatorName', label: '操作人', render: row => esc(row.operatorName || '历史未记录') },
      ...(product() === 'Claude' ? [{ id: 'code', label: '查询码状态／剩余', render: row =>
        row.queryCode?.status === 'not_applicable' ? '不适用' :
          esc(codeStates[row.queryCode?.status] || '待核对') + ' · ' + esc(displayDays(row.queryCode?.remainingDays)) }] : []),
      { id: 'actions', label: '操作', action: true, render: row => {
        const attrs = `data-id="${esc(row.id)}"`;
        if (unlinked) return textAction('查看原单', 'subscriptions-order',
          `data-order-id="${esc(row.history[0]?.sourceId || '')}"`);
        return '<div class="action-links">' + (canCopy(row) ? textAction('复制', 'subscriptions-copy', attrs) : '') +
          textAction('详情', 'subscriptions-detail', attrs) +
          (row.ownerEligible || (row.product === 'Claude' && canCopy(row))
            ? textAction('更多操作', 'subscriptions-more', attrs, '', 'chevron') : '') + '</div>';
      } }
    ];
  }

  function listMarkup() {
    const data = currentSnapshot();
    const state = data ? { title: selectedScope() === 'unlinked' ? '暂无待补邮箱的订单' : '暂无符合条件的订阅账号',
      description: '可调整搜索或订阅状态。' }
      : error ? { title: error, description: '请点击刷新重试。' } : { title: '正在读取订阅账号', description: '' };
    return A.table(columns(), data?.items || [], '', tableId, state) + (data
      ? window.IDPagination.render({ id: tableId, page: data.page, pageSize: data.pageSize, total: data.total }) : '');
  }

  function overviewMarkup() {
    const data = currentSnapshot();
    if (selectedScope() === 'unlinked') return A.summary([['待补邮箱订单', data?.scopeCounts?.unlinked ?? '—', '笔', true]]);
    const c = data?.counts;
    return A.summary([
      ['全部账号', c ? data.accountCount ?? Object.values(c).reduce((a, b) => a + b, 0) : '—', '个', true],
      ['有效', c?.active ?? '—', '个'], ['已过期', c?.expired ?? '—', '个'],
      ['待确认', c?.pending ?? '—', '个'], ['已终止', c?.ended ?? '—', '个']
    ]);
  }

  function stabilizeListFrame() {
    const list = $('#subscription-list'), viewport = list?.querySelector('.table-viewport');
    if (!active() || !viewport) return;
    const key = `${product()}:${selectedScope()}:${filters().pageSize}:${Math.round(viewport.getBoundingClientRect().width)}`;
    let frame = frameHeights.get(key);
    if (currentSnapshot()) {
      const style = getComputedStyle(viewport);
      const contentHeight = viewport.querySelector('table').getBoundingClientRect().height +
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + viewport.offsetHeight - viewport.clientHeight;
      const table = Math.max(frame?.table || 0, contentHeight);
      const pager = Math.max(frame?.pager || 0, list.querySelector('.pagination').getBoundingClientRect().height);
      frame = { table, pager };
      frameHeights.set(key, frame);
    }
    viewport.style.setProperty('--pagination-content-min-height', frame ? `${frame.table}px` : '');
    list.style.setProperty('--pagination-frame-height', frame ? `${frame.table + frame.pager}px` : '');
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!snapshot || !Number.isFinite(snapshot.serverTime)) return;
    const now = snapshot.serverTime + performance.now() - snapshot.receivedAt;
    let next = Infinity;
    for (const row of snapshot.items) {
      for (const series of row.series) {
        const startsIn = parseTime(series.start) - now;
        if (series.status === 'scheduled' && startsIn > 0) next = Math.min(next, startsIn);
      }
      for (const value of [...row.series.map(series => series.expiry), row.queryCode?.expiresAt]) {
        const remaining = parseTime(value) - now;
        if (remaining > 0) next = Math.min(next, remaining - (Math.ceil(remaining / 86_400_000) - 1) * 86_400_000);
      }
    }
    if (Number.isFinite(next)) expiryTimer = setTimeout(() => { if (active()) void load(); },
      Math.min(2_147_000_000, Math.max(50, next + 50)));
  }

  function render() {
    const name = product();
    if (!active()) return A.header(name + ' 订阅管理', '') +
      `<section class="panel">${A.empty('当前无法读取订阅资料', '请使用有权限的账号访问。')}</section>`;
    const f = filters();
    const tabs = scopeOptions().map(scope => `<button type="button" role="tab" class="tab${scope === selectedScope() ? ' active' : ''}"
      aria-selected="${scope === selectedScope()}" data-action="subscriptions-scope" data-scope="${scope}">${scopeLabels[scope]}</button>`).join('');
    const actions = (name === 'Claude'
      ? button('订阅历史入库', 'inventory-claude-history', '', 'upload') +
        button('复制后缀设置', 'subscriptions-settings', '', 'settings') : '') +
      button('列设置', 'column-settings', '', 'columns', `data-table-id="${tableId}"`);
    return A.header(name + ' 订阅管理', '按账号查看已确认的订阅与待核对记录；同一账号的不同系列可能计入多个状态。', actions) +
      `<div id="subscription-overview">${overviewMarkup()}</div><section class="panel" id="subscriptions-panel">
        <div class="list-controls subscription-controls">
          <div class="tabs" role="tablist" aria-label="订阅来源">${tabs}</div>
          <form class="toolbar" id="subscription-filter" aria-label="筛选订阅" novalidate>
            <div class="toolbar-left"><div class="search-field">${A.icon('search')}${A.input('subscription-query', f.input,
              'maxlength="254" aria-label="搜索订单、邮箱账号或人员" placeholder="搜索订单、邮箱账号或人员"')}</div>
              <select id="subscription-status" aria-label="订阅状态">${A.options([['', '全部状态'], ...Object.entries(states)], f.status)}</select>
              <select id="subscription-sort" aria-label="排序">${A.options([['expiry_asc', '到期由近到远'], ['expiry_desc', '到期由远到近'], ['account_asc', '账号排序']], f.sort || 'expiry_asc')}</select>
              <button class="button" type="submit">搜索</button></div>
            <div class="toolbar-right" data-page-actions>${button('刷新', 'subscriptions-refresh')}</div>
          </form>
        </div><div class="design-async-region"><div id="subscription-read-status" role="status" hidden></div>
          <div id="subscription-read-error" role="status" hidden></div><div id="subscription-list" data-pagination-table>${listMarkup()}</div>
        </div></section>`;
  }

  async function load() {
    const panel = $('#subscriptions-panel');
    if (!active() || !panel) return false;
    const sequence = ++requestNumber, name = product(), actor = D.actor?.()?.id || '';
    const f = filters();
    const params = requestFilters();
    const list = $('#subscription-list', panel), status = $('#subscription-read-status', panel);
    const focused = document.activeElement;
    const focusSelector = list.contains(focused) && focused.closest('.pagination') && (
      focused.matches('[data-pagination-size]') ? '[data-pagination-size]' :
      focused.dataset.paginationNav ? `[data-pagination-nav="${focused.dataset.paginationNav}"]` : '[aria-current="page"]');
    const read = A.beginRegionRead(status.parentElement, status, {
      loadingText: snapshot ? '正在更新订阅资料…' : '正在读取订阅资料…',
      refreshButton: panel.querySelector('[data-action="subscriptions-refresh"]')
    });
    const current = () => sequence === requestNumber && read.current() && active() && product() === name &&
      selectedScope() === params.scope && (D.actor?.()?.id || '') === actor;
    try {
      const result = await D.subscriptions(params);
      if (!current()) return false;
      if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || !result.counts ||
          typeof result.revision !== 'string' || !Number.isSafeInteger(result.page) || !Number.isSafeInteger(result.pageSize))
        throw new Error('invalid subscription response');
      Object.assign(f, { page: result.page, pageSize: result.pageSize });
      snapshot = { ...result, product: name, scope: params.scope, serverTime: Date.parse(result.now), receivedAt: performance.now(),
        key: JSON.stringify({ ...params, page: result.page, pageSize: result.pageSize }) };
      error = '';
    } catch (issue) {
      if (!current()) return false;
      if ([401, 403].includes(issue?.status)) snapshot = undefined;
      error = [401, 403].includes(issue?.status) ? '当前账号无权读取订阅资料' : '读取订阅资料失败，请刷新重试';
    } finally {
      if (current()) {
        const scrollLeft = list.querySelector('.table-viewport')?.scrollLeft || 0;
        list.innerHTML = listMarkup();
        stabilizeListFrame();
        scheduleExpiry();
        const viewport = list.querySelector('.table-viewport');
        if (viewport) viewport.scrollLeft = scrollLeft;
        if (focusSelector && [document.body, focused].includes(document.activeElement)) {
          const target = list.querySelector(focusSelector);
          (target && !target.disabled ? target : list.querySelector('[data-pagination-size]'))?.focus({ preventScroll: true });
        }
        $('#subscription-overview').innerHTML = overviewMarkup();
        const notice = $('#subscription-read-error', panel);
        notice.hidden = !error || !currentSnapshot();
        notice.innerHTML = error && currentSnapshot() ? `<p class="inline-notice warning">${esc(error)}，已保留上次读取的资料。</p>` : '';
      }
      read.finish();
    }
    return !error;
  }

  async function copy(node, mode = 'full') {
    const row = currentRow(node.dataset.id), saved = snapshot;
    if (!row || !saved) return;
    await A.withActionFeedback(node, async () => {
      const result = await D.subscriptionCopy({ id: row.id, mode, revision: saved.revision });
      const current = () => active() && snapshot === saved;
      if (!current()) return;
      const missing = row.status === 'ended' ? '，已终止订阅仅提供账号标识' :
        Array.isArray(result.omitted) && result.omitted.length ? `，未登记：${result.omitted.join('、')}` : '';
      const copied = await A.copyText(result.text, '已复制现有资料' + missing, { current });
      if (!copied) {
        const area = $('#drawer[open] textarea.copy-block');
        if (!area) return;
        clearCopy?.();
        const drawer = area.closest('dialog');
        const cleanup = () => { area.value = ''; area.textContent = ''; };
        drawer.addEventListener('close', cleanup, { once: true });
        drawer.addEventListener('id-view-deactivate', cleanup, { once: true });
        clearCopy = cleanup;
      }
    }, { pending: '正在读取资料…', failure: '资料已变化或关联冲突，请刷新核对' });
  }

  function detail(row) {
    const xAccount = row.product === 'Grok' && row.registrationEmail && row.account !== row.registrationEmail ? row.account : '';
    const history = row.history.map(item => `<tr><td>${esc(item.orderNo || '历史入库')}</td><td>${esc(item.plan || '待核对')}</td>` +
      `<td>${esc(displayDate(item.start))}</td><td>${esc(displayDate(item.expiry))}</td><td>${stateTag(item.status)}${item.missingAssociation
        ? A.tag('资料待补', 'warning') : ''}</td>` +
      `<td>${item.source === 'order' ? textAction(!item.confirmed && ['Gemini', 'Grok'].includes(row.product) ? '前往订单核对' : '查看订单',
        'subscriptions-order', `data-order-id="${esc(item.sourceId)}"`) : '历史资料'}` +
      `${item.source === 'order' && !item.confirmed && !item.missingAssociation && !row.conflict && ['GPT', 'Claude'].includes(row.product) ? textAction('确认开通', 'subscriptions-confirm',
        `data-id="${esc(row.id)}" data-order-id="${esc(item.sourceId)}"`) : ''}</td></tr>`).join('');
    A.openDrawer('订阅账号详情', '每次订单独立保留，历史入库不会生成虚构订单。',
      `<div class="property-list"><div class="property-row"><span>邮箱账号</span><strong>${esc(emailAccount(row))}</strong></div>
       ${xAccount ? `<div class="property-row"><span>X 账号</span><strong>${esc(xAccount)}</strong></div>` : ''}
       <div class="property-row"><span>归属人</span><strong>${esc(row.ownerName || (row.ownerEligible ? '未设置' : '—'))}</strong></div>
       <div class="property-row"><span>操作人</span><strong>${esc(row.operatorName)}</strong></div></div>
       ${row.conflict ? '<p class="inline-notice warning">账号、客户或邮箱关联存在冲突，请先核对原资料。</p>' : ''}
       <div class="table-viewport" tabindex="0"><table><thead><tr><th>订单／来源</th><th>套餐</th><th>订阅时间</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${history}</tbody></table></div>`,
      button('关闭', 'drawer-close'));
  }

  async function ownerDrawer(row, revision = snapshot?.revision) {
    if (!row.ownerEligible) return;
    const key = 'subscription-owner:' + row.id;
    const context = ownerContext = { row, revision, route: A.state.route, actor: D.actor?.()?.id || '' };
    const current = () => ownerContext === context && A.state.route === context.route &&
      (D.actor?.()?.id || '') === context.actor;
    A.openDrawer('账号归属人', '归属人与订单录入人分别记录，历史订单保持原值。',
      `<dl class="compact-form-context">
        <div class="field"><dt class="field-label">当前账号</dt><dd class="field-label compact-form-value" id="subscription-owner-account">${esc(row.account || '未登记')}</dd></div>
        <div class="field"><dt class="field-label">当前归属</dt><dd class="field-label compact-form-value" id="subscription-current-owner">${esc(row.ownerName || (row.ownerId ? '姓名待读取' : '未设置'))}</dd></div>
       </dl><form id="subscription-owner-form" data-subscription-draft="${esc(key)}"><input type="hidden" name="commandId" value="${esc(A.state.drafts.get(key)?.commandId || crypto.randomUUID())}">${A.field('归属人',
        'subscription-owner', '<select id="subscription-owner" name="ownerId" required disabled><option value="">正在读取员工…</option></select>', true)}
        <p id="subscription-owner-error" class="inline-notice warning" role="alert" hidden></p><div class="form-footer">${button('取消', 'drawer-close')}
        <button class="button primary" type="submit" disabled>保存归属</button></div></form>`, '', key, { kind: 'compact-form' });
    const form = $('#subscription-owner-form'), select = $('#subscription-owner', form);
    try {
      const response = await D.orderOwners();
      if (!form.isConnected || !current()) return;
      const people = Array.isArray(response.items) ? response.items : [];
      const draft = A.state.drafts.get(key);
      $('#subscription-current-owner').textContent = row.ownerName || people.find(person => person.id === row.ownerId)?.name || (row.ownerId ? '未找到对应员工' : '未设置');
      select.innerHTML = A.options([['', people.length ? '请选择员工' : '暂无可选员工'], ...people.map(person => [person.id, person.name])], draft?.ownerId || row.ownerId);
      select.disabled = !people.length;
      form.querySelector('[type="submit"]').disabled = !people.length;
    } catch {
      if (form.isConnected && current()) {
        if (!row.ownerName && row.ownerId) $('#subscription-current-owner').textContent = '暂时无法读取';
        select.innerHTML = '<option value="">员工列表读取失败</option>';
        $('#subscription-owner-error', form).hidden = false;
        $('#subscription-owner-error', form).textContent = '员工列表读取失败，请关闭后重试。';
      }
    }
  }

  function confirmDrawer(row, orderId) {
    const key = `subscription-confirm:${row.id}:${orderId}`;
    const saved = A.state.drafts.get(key) || {};
    A.openDrawer('确认订阅已开通', '请先核对平台实际开通记录；仅有付款记录不能证明开通。',
      `<form id="subscription-confirm-form" data-subscription-draft="${esc(key)}" data-id="${esc(row.id)}" data-order-id="${esc(orderId)}"><input type="hidden" name="commandId" value="${esc(saved.commandId || crypto.randomUUID())}">
       <div class="form-grid">${A.field('核对依据', 'subscription-reason', `<textarea id="subscription-reason" name="reason" maxlength="300" required>${esc(saved.reason || '')}</textarea>`, true)}</div>
       <label class="checkbox-label"><input type="checkbox" name="confirmed" ${saved.confirmed ? 'checked' : ''}> <span>已核实该订单实际开通</span></label>
       <p id="subscription-confirm-error" class="inline-notice warning" hidden></p><div class="form-footer">${button('取消', 'drawer-close')}
       <button class="button primary" type="submit">确认开通</button></div></form>`, '', key);
  }

  async function settingsDrawer() {
    const key = 'subscription-claude-settings';
    A.openDrawer('复制后缀设置', '分别设置邮箱和查询码、完整资料的个人复制后缀。',
      `<form id="subscription-settings-form" data-subscription-draft="${key}"><input type="hidden" name="version" value="">
       <div id="subscription-settings-status" role="status" hidden></div>
       <div class="form-grid">${A.field('邮箱和查询码后缀', 'subscription-copy1', '<textarea id="subscription-copy1" name="copy1" maxlength="2000"></textarea>')}
       ${A.field('完整资料后缀', 'subscription-copy2', '<textarea id="subscription-copy2" name="copy2" maxlength="2000"></textarea>')}</div>
       <p id="subscription-settings-error" class="inline-notice warning" hidden></p><div class="form-footer">${button('取消', 'drawer-close')}
       <button class="button primary" type="submit" disabled>保存设置</button></div></form>`, '', key);
    const form = $('#subscription-settings-form');
    const read = A.beginRegionRead(form, $('#subscription-settings-status', form), { loadingText: '正在读取复制设置…' });
    try {
      const result = await D.claudeGoogleCopySettings();
      if (!read.current() || !active()) return;
      const draft = A.state.drafts.get(key);
      form.elements.version.value = result.version;
      form.elements.copy1.value = draft?.copy1 ?? result.copy1;
      form.elements.copy2.value = draft?.copy2 ?? result.copy2;
      form.querySelector('[type="submit"]').disabled = false;
    } catch {
      if (form.isConnected) { $('#subscription-settings-error', form).hidden = false; $('#subscription-settings-error', form).textContent = '读取设置失败，请关闭后重试。'; }
    } finally { read.finish(); }
  }

  async function submit(form) {
    const key = form.dataset.subscriptionDraft, values = A.readDraft(form), saved = snapshot;
    const submit = form.querySelector('[type="submit"]');
    const notice = form.querySelector('.inline-notice');
    if (notice) { notice.hidden = true; notice.textContent = ''; }
    try {
      await A.withActionFeedback(submit, async () => {
        let result;
        if (form.id === 'subscription-owner-form') {
          const context = ownerContext, row = context?.row;
          if (!row || context.route !== A.state.route || context.actor !== (D.actor?.()?.id || '') || !values.ownerId)
            throw new Error('请选择归属人并重新核对账号');
          result = await D.subscriptionOwner({ id: row.id, accountId: row.accountId || '', ownerId: values.ownerId,
            revision: context.revision, commandId: values.commandId });
        } else if (form.id === 'subscription-confirm-form') {
          if (!values.reason?.trim() || !values.confirmed) throw new Error('请填写核对依据并确认实际开通');
          result = await D.subscriptionConfirm({ id: form.dataset.id, orderId: form.dataset.orderId,
            reason: values.reason, confirmed: true, revision: saved.revision, commandId: values.commandId });
        } else {
          result = await D.saveClaudeGoogleCopySettings({ version: Number(values.version), copy1: values.copy1, copy2: values.copy2 });
        }
        const stillCurrent = form.id === 'subscription-owner-form'
          ? ownerContext?.route === A.state.route && ownerContext.actor === (D.actor?.()?.id || '') : active();
        if (!form.isConnected || !stillCurrent) return;
        const unchanged = JSON.stringify(A.readDraft(form)) === JSON.stringify(values);
        if (unchanged) { A.closeDrawer(); A.state.drafts.delete(key); }
        else {
          if (form.elements.commandId) form.elements.commandId.value = crypto.randomUUID();
          if (form.id === 'subscription-settings-form' && Number.isSafeInteger(result?.version))
            form.elements.version.value = result.version;
          A.state.drafts.set(key, A.readDraft(form));
        }
        A.notify(unchanged ? '已保存' : '本次已保存，后续输入已保留', { kind: 'success' });
        if (form.id !== 'subscription-settings-form' && active()) void load();
      }, { pending: '正在保存…' });
    } catch (issue) {
      if (form.isConnected && notice) { notice.hidden = false; notice.textContent = issue.message || '保存失败，请重试'; }
    }
  }

  document.addEventListener('id-pagination-change', event => {
    if (!active() || event.detail.id !== tableId || !event.target.closest('#subscription-list')) return;
    Object.assign(filters(), { page: event.detail.page, pageSize: event.detail.pageSize });
    void load();
  });

  window.IDDesignModules.push({
    id: 'subscription-management', matches: route => /^subscriptions\/(gpt|claude|gemini|grok)$/.test(route), render,
    afterRender() {
      if (!active()) return;
      frameObserver?.disconnect();
      stabilizeListFrame();
      frameObserver = new ResizeObserver(stabilizeListFrame);
      frameObserver.observe($('#subscription-list'));
      if (snapshot?.key !== JSON.stringify(requestFilters())) void load();
    },
    deactivate(region) {
      const status = $('#subscription-read-status', region);
      if (status) { A.finishRegionRead(status.parentElement); status.parentElement.replaceChildren(status); }
      requestNumber++; clearTimeout(expiryTimer); frameObserver?.disconnect(); clearCopy?.(); clearCopy = undefined; snapshot = undefined; error = '';
    },
    clearPageState() { requestNumber++; clearTimeout(expiryTimer); frameObserver?.disconnect(); frameHeights.clear(); ownerContext = undefined; clearCopy?.(); clearCopy = undefined; snapshot = undefined; error = ''; },
    onDataChanges(changed) { if (active() && changed.some(scope => scopes.includes(scope))) return load(); },
    preserveDraft() {
      const form = $('#drawer[open] form[data-subscription-draft]');
      if (form) A.state.drafts.set(form.dataset.subscriptionDraft, A.readDraft(form));
    },
    onClick(action, node) {
      if (!active()) return false;
      if (action === 'subscriptions-refresh') void load();
      else if (action === 'subscriptions-scope' && scopeOptions().includes(node.dataset.scope)) {
        if (selectedScope() !== node.dataset.scope) {
          Object.assign(filters(), { scope: node.dataset.scope, status: '', page: 1 });
          error = '';
          A.render();
        }
      }
      else if (action === 'subscriptions-copy') void copy(node);
      else if (action === 'subscriptions-copy-short') void copy(node, 'short');
      else if (action === 'subscriptions-settings') void settingsDrawer();
      else if (action === 'subscriptions-detail') { const row = currentRow(node.dataset.id); if (row) detail(row); }
      else if (action === 'subscriptions-owner') { const row = currentRow(node.dataset.id); if (row) void ownerDrawer(row); }
      else if (action === 'subscriptions-confirm') { const row = currentRow(node.dataset.id); if (row) confirmDrawer(row, node.dataset.orderId); }
      else if (action === 'subscriptions-order') { A.closeDrawer(); A.go('orders/detail/' + encodeURIComponent(node.dataset.orderId)); }
      else if (action === 'subscriptions-more') {
        const row = currentRow(node.dataset.id);
        if (row) A.openActionMenu(node,
          (row.ownerEligible ? button('设置归属人', 'subscriptions-owner', '', '', `data-id="${esc(row.id)}"`) : '') +
          (row.product === 'Claude' && canCopy(row) ? button('复制邮箱和查询码', 'subscriptions-copy-short', '', '', `data-id="${esc(row.id)}"`) : ''));
      } else return false;
      return true;
    },
    onSubmit(form) {
      if (form.id === 'subscription-owner-form' && ownerContext?.route === A.state.route) { void submit(form); return true; }
      if (!active()) return false;
      if (form.id === 'subscription-filter') { filters().query = filters().input; filters().page = 1; void load(); }
      else if (['subscription-owner-form', 'subscription-confirm-form', 'subscription-settings-form'].includes(form.id)) void submit(form);
      else return false;
      return true;
    },
    onChange(node) {
      if (!active()) return false;
      if (node.id === 'subscription-status') { filters().status = node.value; filters().page = 1; void load(); return true; }
      if (node.id === 'subscription-sort') { filters().sort = node.value; filters().page = 1; void load(); return true; }
      return false;
    },
    onInput(node) {
      if (!active()) return false;
      if (node.id === 'subscription-query') { filters().input = node.value; return true; }
      return false;
    }
  });
})();
