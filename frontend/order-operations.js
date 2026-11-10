(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const requestRoute = 'workspace/recharge-codes';
  const codesRoute = 'workspace/my-recharge-codes';
  const syncRoute = A.gptOrderSyncRoute;
  const routes = new Set([requestRoute, codesRoute, syncRoute]);
  const planNames = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const requestStates = { pending: '待审核', issuing: '待发码核对', issued: '已发码', rejected: '已驳回' };
  const codeStates = { unused: '未使用', used: '已使用', processing: '使用处理中', unavailable: '状态待确认', returned: '已归还', 'return-pending': '归还待核对' };
  const views = new Map();
  const e = A.esc;
  let saving = false;
  let requestKey;
  let codeTab = A.state.drafts.get('recharge-code-view')?.tab || 'unused';
  let returnContext, previewGeneration = 0;
  let codeFrameObserver;

  const routeNow = () => A.state.route;
  const workspaceActive = () => [requestRoute, codesRoute].includes(routeNow());
  const draftKey = route => route === requestRoute ? 'recharge-request-view' : 'recharge-code-view';
  const regionId = route => route === requestRoute ? 'recharge-request-region' : 'recharge-codes-region';
  function listView(route) {
    return { page: 1, pageSize: window.IDPagination.defaultPageSize, ...A.state.drafts.get(draftKey(route)) };
  }
  function setListView(route, changes) {
    A.state.drafts.set(draftKey(route), { ...listView(route), ...changes });
  }
  function listPage(route, rows) {
    const view = listView(route);
    view.page = Math.min(view.page, Math.max(1, Math.ceil(rows.length / view.pageSize)));
    setListView(route, { page: view.page });
    return { rows: rows.slice((view.page - 1) * view.pageSize, view.page * view.pageSize),
      pager: window.IDPagination.render({ id: draftKey(route), ...view, total: rows.length }) };
  }
  const displayTime = (at) => {
    if (!at) return '—';
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return at;
    return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  };
  const actorName = (row) => D.operatorLabel(row.applicantId, row.applicantName || '历史员工');
  const read = (route) => route === requestRoute ? D.rechargeCodeRequests()
    : route === codesRoute ? D.rechargeCodes() : D.orderSyncStatus();

  async function load(route, refresh = false, showSaved = false) {
    if (!D) return;
    const current = views.get(route) || {};
    if (current.loading) {
      if (refresh) current.reload = true;
      return current.pending;
    }
    if (current.loaded && !refresh) return true;
    const preview = current.preview;
    const actorId = D.actor()?.id;
    current.loading = true;
    current.error = '';
    views.set(route, current);
    const region = workspaceActive() && route !== syncRoute ? document.getElementById(regionId(route)) : null;
    const feedback = region ? A.beginRegionRead(region, region.querySelector('[data-code-progress]'), {
      refreshButton: region.querySelector('[data-action="order-ops-refresh"]')
    }) : null;
    current.pending = (async () => { try {
      const data = await read(route);
      if (actorId !== D.actor()?.id) return false;
      if (route === codesRoute && current.data) locateNewBatch(current.data.items, data.items, actorId);
      current.data = data;
      if (route === syncRoute && current.preview === preview && (showSaved || !current.canApply)) {
        current.preview = undefined;
        current.canApply = false;
      }
      return true;
    } catch (error) {
      current.error = error.message || '读取失败，请重试';
      return false;
    } finally {
      current.loaded = true;
      current.loading = false;
      feedback?.finish();
      if (workspaceActive() && route !== syncRoute) updateWorkspaceRegion(route);
      else if (routeNow() === route) A.render();
    } })();
    const result = await current.pending;
    current.pending = undefined;
    if (current.reload) { current.reload = false; return load(route, true, showSaved); }
    return result;
  }

  function locateNewBatch(previous = [], incoming = [], actorId) {
    const known = new Set(previous.map(row => row.id));
    const fresh = incoming.filter(row => row.applicantId === actorId && row.code && row.status === 'unused' && !known.has(row.id))
      .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
    if (!fresh.length) return;
    codeTab = 'unused';
    setListView(codesRoute, { tab: codeTab, page: 1, 'code-list-query': '', 'code-list-plan': '', batchId: fresh[0].requestId });
    A.getSelection('recharge-code-items').clear();
  }

  function table(columns, rows, id, title) {
    return rows.length
      ? A.table(columns, A.pageRows(rows), '', id) + A.pagination(rows.length)
      : A.empty(title, '');
  }

  function requestAvailability(stock, plan, count) {
    const available = stock?.[plan];
    if (!Number.isSafeInteger(available) || available < 0)
      return { blocked: true, message: '暂时无法核对库存，请刷新后重试。' };
    if (!available) return { blocked: true, message: '该套餐剩余可提取 0 个。' };
    if (count > available) return { blocked: true, message: `该套餐剩余可提取 ${available} 个，请调整申请数量。` };
    return { blocked: false, message: `该套餐剩余可提取 ${available} 个，审核通过后发码。` };
  }

  function workspaceHeading(title, description, id, glyph, tone, route) {
    return `<div class="panel-heading"><div class="section-title-row"><span class="inventory-workspace-icon" data-tone="${tone}" aria-hidden="true">${A.icon(glyph)}</span><h2 id="${id}">${e(title)}</h2>${A.titleInfo(title, description, id + '-help')}</div>${A.button('刷新', 'order-ops-refresh', '', 'return', `data-route="${route}" aria-label="刷新${title}"`)}</div>`;
  }
  function requestActions(row, data, includeDetail = true) {
    const attrs = `data-id="${e(row.id)}"`;
    let actions = includeDetail ? A.textAction('详情', 'order-code-request-detail', attrs) : '';
    if (data?.canApprove && row.status === 'pending') actions +=
      A.textAction('批准', 'order-code-approve', attrs + (saving || requestAvailability(data.stock, row.plan, row.count).blocked ? ' disabled title="库存不足、暂未核对或正在保存"' : '')) +
      A.textAction('驳回', 'order-code-reject', attrs + (saving ? ' disabled' : ''));
    if (data?.canApprove && row.status === 'issuing') actions +=
      A.textAction('重新核对', 'order-code-reconcile', attrs + (saving ? ' disabled' : '')) + A.textAction('驳回', 'order-code-reject', attrs + (saving ? ' disabled' : ''));
    if (row.status === 'issued') actions += A.textAction('批次明细', 'order-code-batch-detail', attrs) +
      A.button(row.counts?.returnable ? `归还（${row.counts.returnable}）` : '无可归还项', 'order-code-batch-return', '', '', attrs + (row.counts?.returnable ? '' : ' disabled'));
    return '<div class="recharge-record-actions">' + actions + '</div>';
  }
  function requestHistory(view) {
    if (!view.loaded && !view.data) return A.empty('正在读取申请记录', '');
    const rows = [...(view.data?.requests || [])].sort((a, b) => String(b.createdAt || b.issuedAt || '').localeCompare(String(a.createdAt || a.issuedAt || '')));
    const page = listPage(requestRoute, rows);
    const actionsData = view.error ? { ...view.data, stock: null } : view.data;
    return `<div class="recharge-list-frame" data-code-frame="requests"><div>${page.rows.length ? `<ul class="recharge-request-list" tabindex="0" aria-label="申请记录列表">${page.rows.map(row => `<li data-request-id="${e(row.id)}"><div class="inventory-record-heading"><strong>${e(planNames[row.plan] || '待核对')} · ${e(row.count)} 个</strong>${A.tag(requestStates[row.status] || '待核对', row.status === 'issued' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning')}</div><div class="inventory-record-meta">${view.data?.canApprove ? `<span>${e(actorName(row))}</span>` : ''}<time>${e(displayTime(row.createdAt || row.issuedAt))}</time></div>${requestActions(row, actionsData)}</li>`).join('')}</ul>` : A.empty(view.error && !view.data ? '申请记录读取失败' : '暂无申请记录', '')}</div></div>${page.pager}`;
  }
  function requestContent(view) {
    const draft = A.state.drafts.get('recharge-code-request') || {};
    const plan = draft['recharge-request-plan'] || 'plus', count = draft['recharge-request-count'] ?? '1';
    const availability = requestAvailability(view.error ? null : view.data?.stock, plan, Number(count));
    return '<div class="form-panel"><form id="recharge-code-request"><div class="form-grid recharge-request-fields">' +
      A.field('套餐', 'recharge-request-plan', A.select('recharge-request-plan', Object.entries(planNames), plan), true) +
      A.field('数量', 'recharge-request-count', A.input('recharge-request-count', count, 'type="number" min="1" max="100" step="1" required aria-label="申请数量"'), true) +
      '</div><div class="recharge-stock-notice" id="recharge-request-stock" role="status">' + e(availability.message) + '</div>' +
      '<div class="form-footer"><button class="button primary" type="submit" aria-describedby="recharge-request-stock"' +
      (saving || availability.blocked ? ' disabled' : '') + '>提交申请</button></div></form></div>' +
      '<div class="panel-heading"><div class="section-title-row"><h3>最近申请</h3>' + A.titleInfo('最近申请', '按申请时间倒序展示。使用统计、驳回原因和批次明细可点击详情查看。', 'code-request-history-help') + '</div></div>' +
      '<div id="recharge-request-history">' + requestHistory(view) + '</div>';
  }
  function filteredCodes(data) {
    const draft = listView(codesRoute);
    const query = (draft['code-list-query'] || '').trim().toLowerCase(), plan = draft['code-list-plan'] || '';
    return (data?.items || []).filter(row => (codeTab === 'returns' ? Boolean(row.returnRecord)
      : codeTab === 'other' ? ['processing', 'unavailable', 'return-pending'].includes(row.status) : row.status === codeTab) &&
      (!draft.batchId || row.requestId === draft.batchId) && (!plan || row.plan === plan) &&
      (!query || [row.code, row.last4, row.id, row.requestId, row.applicantName].some(value => value?.toLowerCase().includes(query))))
      .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
  }
  function codeActions(row, includeDetail = true) {
    const attrs = `data-id="${e(row.id)}"`;
    return '<div class="recharge-record-actions">' +
      (row.status === 'unused' && row.code ? A.textAction('复制', 'order-code-copy', attrs) : '') +
      (includeDetail ? A.textAction('详情', 'order-code-item-detail', attrs) : '') +
      (row.status === 'return-pending' ? A.textAction('核对并继续', 'order-code-return-resume', attrs)
        : A.button(row.eligible ? '归还' : '不可归还', 'order-code-return', '', '', attrs + ` title="${e(row.returnReason || '查看详情核对归还资格')}"` + (row.eligible ? '' : ' disabled'))) + '</div>';
  }
  function codeColumns() {
    return [
      { id: 'code', label: '充值码', class: 'recharge-code-value', render: row => `<span class="recharge-code-text">${e(row.code || '•••• ' + (row.last4 || ''))}</span>` },
      { id: 'plan', label: '套餐', render: row => e(planNames[row.plan] || '待核对') },
      { id: 'status', label: '状态', render: row => A.tag(codeStates[row.status] || '待核对', row.status === 'unused' ? 'success' : ['processing', 'unavailable', 'return-pending'].includes(row.status) ? 'warning' : '') },
      { id: 'issuedAt', label: '发放时间', render: row => e(displayTime(row.issuedAt)) },
      { id: 'actions', label: '操作', action: true, render: codeActions }
    ];
  }
  function codesList(view) {
    if (!view.loaded && !view.data) return A.empty('正在读取充值码', '');
    const rows = filteredCodes(view.data), page = listPage(codesRoute, rows);
    return `<div class="recharge-list-frame" data-code-frame="codes"><div class="recharge-code-table" data-pagination-table>${A.table(codeColumns(), page.rows, 'recharge-code-items', 'my-recharge-codes', {
      title: view.error && !view.data ? '充值码读取失败' : '当前分类暂无充值码', description: ''
    })}</div></div>${page.pager}`;
  }
  function codesContent(view) {
    const draft = listView(codesRoute);
    const tabs = [['unused', '未使用'], ['used', '已使用'], ['other', '处理中与待核对'], ['returned', '已归还'], ['returns', '归还记录']]
      .map(([key, label]) => `<button type="button" class="tab ${key === codeTab ? 'active' : ''}" role="tab" aria-selected="${key === codeTab}" data-action="order-code-tab" data-id="${key}">${label}</button>`).join('');
    return '<div class="tabs recharge-code-tabs" role="tablist" aria-label="充值码状态">' + tabs + '</div>' +
      '<div class="toolbar recharge-code-toolbar"><form class="toolbar-left" id="code-list-filters">' +
      '<div class="search-field">' + A.icon('search') + A.input('code-list-query', draft['code-list-query'] || '', 'type="search" aria-label="搜索充值码或批次" placeholder="搜索充值码或批次"') + '</div>' +
      A.select('code-list-plan', [['', '全部套餐'], ...Object.entries(planNames)], draft['code-list-plan'] || '').replace('<select ', '<select aria-label="筛选套餐" ') +
      '</form><div class="toolbar-right">' + A.button('归还所选', 'order-code-return-selected', '', '', 'disabled') + '</div></div>' +
      '<div id="recharge-code-new-batch" class="recharge-new-batch" hidden></div><div id="recharge-code-list">' + codesList(view) + '</div>';
  }
  function workspaceRegion(route) {
    const view = views.get(route) || {}, request = route === requestRoute;
    return `<section id="${regionId(route)}" class="panel design-async-region ${request ? 'recharge-request-panel' : 'recharge-codes-panel'}" aria-labelledby="${request ? 'code-request-heading' : 'code-list-heading'}"><div data-code-progress hidden></div>` +
      workspaceHeading(request ? '提取申请' : '我的充值码', request
        ? '提交申请后等待审核，待审核申请不占库存；审核发码后才进入可用充值码。'
        : '查看已获发充值码及使用状态。复制完整值；归还前逐项核对，确认后原码永久失效。管理员可查看既有授权批次，其他员工的完整码不会显示。',
      request ? 'code-request-heading' : 'code-list-heading', request ? 'download' : 'key', request ? 'teal' : 'violet', route) +
      `<div data-code-error class="panel-body inline-notice warning" role="status"${view.error ? '' : ' hidden'}>${e(view.error || '')}</div>` +
      (request ? requestContent(view) : codesContent(view)) + '</section>';
  }
  function updateRequestForm() {
    const form = document.getElementById('recharge-code-request');
    if (!form) return;
    const view = views.get(requestRoute);
    const { message, blocked } = requestAvailability(view?.error ? null : view?.data?.stock,
      form.elements['recharge-request-plan'].value, Number(form.elements['recharge-request-count'].value));
    form.querySelector('#recharge-request-stock').textContent = message;
    form.querySelector('[type="submit"]').disabled = saving || blocked;
  }
  function updateCodeControls() {
    const region = document.getElementById(regionId(codesRoute));
    if (!region) return;
    const draft = listView(codesRoute);
    for (const name of ['code-list-query', 'code-list-plan']) {
      const control = document.getElementById(name);
      if (control && control.value !== (draft[name] || '')) control.value = draft[name] || '';
    }
    for (const tab of region.querySelectorAll('[data-action="order-code-tab"]')) {
      const becameActive = tab.dataset.id === codeTab && tab.getAttribute('aria-selected') !== 'true';
      tab.classList.toggle('active', tab.dataset.id === codeTab);
      tab.setAttribute('aria-selected', String(tab.dataset.id === codeTab));
      if (becameActive) {
        const strip = tab.parentElement, box = strip.getBoundingClientRect(), item = tab.getBoundingClientRect();
        if (item.left < box.left) strip.scrollLeft -= box.left - item.left;
        else if (item.right > box.right) strip.scrollLeft += item.right - box.right;
      }
    }
    const banner = document.getElementById('recharge-code-new-batch');
    banner.hidden = !draft.batchId;
    banner.innerHTML = draft.batchId ? '<span>已定位新发放批次 · ' + e(draft.batchId) + '</span>' + A.textAction('查看全部', 'order-code-clear-batch') : '';
    const selected = A.getSelection('recharge-code-items');
    const count = filteredCodes(views.get(codesRoute)?.data).filter(row => selected.has(row.id)).length;
    const button = region.querySelector('[data-action="order-code-return-selected"]');
    button.disabled = !count; button.textContent = count ? `归还所选（${count}）` : '归还所选';
  }
  function stabilizeCodeFrames() {
    for (const route of [requestRoute, codesRoute]) {
      const region = document.getElementById(regionId(route)), frame = region?.querySelector('[data-code-frame]');
      if (!frame?.firstElementChild) continue;
      const view = views.get(route);
      if (!view) continue;
      const key = `${listView(route).pageSize}:${Math.round(frame.getBoundingClientRect().width)}`;
      view.frames ||= new Map();
      const style = getComputedStyle(frame);
      const naturalHeight = frame.firstElementChild.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const height = Math.max(view.frames.get(key) || 0, naturalHeight);
      view.frames.set(key, height); frame.style.minHeight = `${height}px`;
    }
  }
  function updateWorkspaceRegion(route) {
    if (!workspaceActive()) return;
    const region = document.getElementById(regionId(route));
    if (!region) return;
    preserveDraft();
    const view = views.get(route) || {}, error = region.querySelector('[data-code-error]');
    error.hidden = !view.error; error.textContent = view.error || '';
    if (route === requestRoute) {
      document.getElementById('recharge-request-history').innerHTML = requestHistory(view);
      updateRequestForm();
    } else {
      document.getElementById('recharge-code-list').innerHTML = codesList(view);
      updateCodeControls();
    }
    stabilizeCodeFrames();
  }
  const property = (label, value) => `<div class="property-row"><span>${e(label)}</span><strong>${e(value ?? '—')}</strong></div>`;
  function requestDetails(row) {
    return '<div class="property-list recharge-code-details">' + property('申请批次', row.id) + property('申请人', actorName(row)) +
      property('套餐', planNames[row.plan] || '待核对') + property('申请数量', row.count) + property('审核状态', requestStates[row.status] || '待核对') +
      property('申请时间', displayTime(row.createdAt)) + property('发放时间', displayTime(row.issuedAt)) +
      property('说明', row.issueProblem || row.reason || '无') +
      Object.entries({ unused: '未使用', processing: '处理中', used: '已使用', unavailable: '待核对', returnable: '可归还', returned: '已归还', pendingReturns: '归还待核对' })
        .map(([key, label]) => property(label, row.counts?.[key])).join('') + '</div>';
  }
  function openCodeDetails(row) {
    A.openDrawer('充值码详情', '仅显示当前账号有权查看的资料。已归还的原码不再提供查看或复制。',
      '<div class="property-list recharge-code-details">' + property('充值码', row.code || '•••• ' + (row.last4 || '')) +
      property('套餐', planNames[row.plan] || '待核对') + property('状态', codeStates[row.status] || '待核对') +
      property('领用编号', row.id) + property('发放批次', row.requestId) + property('领码人', actorName(row)) +
      property('发放时间', displayTime(row.issuedAt)) + property('归还资格', row.returnReason) +
      (row.returnRecord ? property('归还时间', displayTime(row.returnRecord.returnedAt)) + property('归还操作人', row.returnRecord.actorName) + property('归还备注', row.returnRecord.note || '无') : '') + '</div>',
      A.button('关闭', 'drawer-close') + codeActions(row, false));
  }
  function returnDraft() {
    const form = document.querySelector('#code-return-form');
    if (form?.dataset.rechargeReturnDraft) A.state.drafts.set(form.dataset.rechargeReturnDraft, A.readDraft(form));
  }
  function drawReturn(ctx, rows) {
    ctx.rows = rows;
    const draft = A.state.drafts.get(ctx.key), selectable = row => row.eligible || (ctx.resume && row.state === 'pending');
    A.openDrawer('归还充值码', '逐项核对未使用状态，确认后永久停用原码。已使用、已交付及历史任务不会被撤销。',
      '<form id="code-return-form" data-recharge-return-draft="' + e(ctx.key) + '">' + A.table([
        { id: 'choice', label: '选择', render: row => '<input type="checkbox" name="return-code-' + e(row.id) + '" aria-label="选择领用 ' + e(row.id) + '" ' +
          (selectable(row) ? '' : 'disabled ') + ((draft ? draft['return-code-' + row.id] : selectable(row)) ? 'checked' : '') + '>' },
        { id: 'id', label: '领用编号', long: true },
        { id: 'requestId', label: '原发放批次', long: true },
        { id: 'last4', label: '码尾四位' },
        { id: 'plan', label: '套餐', render: row => e(planNames[row.plan] || '—') },
        { id: 'reason', label: '核对结果', long: true },
        { id: 'actions', label: '操作', action: true, render: row => row.state === 'pending' ? A.textAction('核对并继续', 'order-code-return-resume', 'data-id="' + e(row.id) + '"') : '' }
      ], rows, '', '充值码归还核对') + A.field('归还备注', 'code-return-note', A.input('code-return-note', draft?.['code-return-note'] || '', 'maxlength="200"')) +
      '<div class="inline-notice" id="code-return-status" role="status">只处理勾选项；不可归还项继续保留原记录。</div></form>',
      A.button('关闭', 'drawer-close') + A.button('重新核对', 'order-code-return-refresh') +
      '<button class="button primary" form="code-return-form" type="submit"' + (rows.some(selectable) ? '' : ' disabled') + '>确认归还</button>', ctx.key);
    returnContext = ctx;
  }
  async function openReturn(ids, resume = false) {
    if (!ids.length) return A.notify('请先选择可归还的充值码');
    returnDraft();
    const generation = ++previewGeneration, route = routeNow(), actorId = D.actor()?.id;
    try {
      const { items } = await D.rechargeCodeAction({ action: 'return-preview', itemIds: ids });
      if (generation !== previewGeneration || routeNow() !== route || D.actor()?.id !== actorId) return;
      drawReturn({ ids, route, actorId, resume, key: 'recharge-code-return:' + [...ids].sort().join(',') }, items);
    } catch (error) { if (generation === previewGeneration && routeNow() === route) A.notify(error.message); }
  }
  async function submitReturn(form) {
    const ctx = returnContext;
    if (!ctx || form.dataset.saving || ctx.route !== routeNow() || ctx.actorId !== D.actor()?.id) return;
    const raw = A.readForm(form), snapshot = JSON.stringify(raw);
    const ids = ctx.rows.filter(row => raw['return-code-' + row.id] && (row.eligible || (ctx.resume && row.state === 'pending'))).map(row => row.id);
    if (!ids.length) return A.notify('请选择本次要归还的项目');
    returnDraft(); form.dataset.saving = 'true';
    const submit = document.querySelector('button[form="code-return-form"][type="submit"]'); submit.disabled = true;
    try {
      const result = await D.rechargeCodeAction({ action: ctx.resume ? 'return-reconcile' : 'return', itemIds: ids, note: raw['code-return-note'] || '' });
      views.get(requestRoute) && (views.get(requestRoute).loaded = false);
      views.get(codesRoute) && (views.get(codesRoute).loaded = false);
      await refreshWorkspace();
      if (ctx !== returnContext || ctx.route !== routeNow() || ctx.actorId !== D.actor()?.id || !form.isConnected) return;
      if (JSON.stringify(A.readForm(form)) !== snapshot) return A.notify('本次操作已处理，后续输入已保留，请重新核对结果');
      const updates = new Map(result.items.map(row => [row.itemId || row.id, row]));
      const rows = ctx.rows.map(row => updates.has(row.id) ? { ...row, ...updates.get(row.id), id: row.id, eligible: false } : row);
      form.removeAttribute('data-recharge-return-draft');
      if (result.items.every(row => row.state === 'returned')) A.state.drafts.delete(ctx.key);
      drawReturn(ctx, rows);
      A.notify(result.items.every(row => row.state === 'returned') ? '归还完成，原码已失效' : '部分项目仍待处理，请查看逐项结果');
    } catch (error) {
      if (ctx === returnContext && form.isConnected) {
        form.querySelector('#code-return-status').textContent = error.message;
        A.notify(error.message);
        // A changed eligibility list is shown for a new explicit confirmation, never silently subsetted.
        if (error.status === 409) await openReturn(ctx.ids, ctx.resume);
      }
    } finally { delete form.dataset.saving; if (submit.isConnected) submit.disabled = false; }
  }
  function syncContent(view) {
    const data = view.preview || view.data;
    const columns = [
      { id: 'jobKey', label: '代充任务' },
      { id: 'orderNo', label: 'GPT 订单编号', render: (row) => row.orderNo
        ? A.textAction(row.orderNo, 'order-sync-open-order', `data-id="${e(row.jobKey)}" data-order-no="${e(row.orderNo)}"`)
        : '—' },
      { id: 'needs', label: '待核对项', render: (row) => e((row.needs || []).join('、') || '—') }
    ];
    const jobKey = A.state.drafts.get('order-sync-lookup') || '';
    return '<div class="toolbar"><form class="toolbar-left" id="order-sync-lookup">' +
      '<div class="search-field">' + A.icon('search') +
      A.input('order-sync-job', jobKey, 'placeholder="指定代充任务编号" aria-label="指定代充任务编号" required maxlength="120"') +
      `</div><button class="button" type="submit"${saving ? ' disabled' : ''}>核对指定任务</button></form>` +
      '<div class="toolbar-right">' + A.button('预览', 'order-sync-preview', '', '', saving ? 'disabled' : '') +
      A.button('同步入单', 'order-sync-apply', 'primary', '', saving || !view.canApply ? 'disabled' : '') +
      '</div></div>' + (A.modules.commerce?.syncedOrderReadNotice() || '') +
      (view.error ? '<p class="panel-body inline-notice warning" role="status">' + e(view.error) + '</p>' : '') +
      (view.data?.lastError ? '<p class="panel-body footnote" role="status">' + e(view.data.lastError) + '</p>' : '') +
      (data?.more ? '<p class="panel-body footnote">还有记录可核对，请分批处理或按任务编号查询。</p>' : '') +
      table(columns, (data?.rows || []).map((row) => ({ ...row, id: row.jobKey })), 'recharge-order-sync', '暂无待同步记录');
  }

  function renderSync(view) {
    const ready = D?.authRequired && view.loaded;
    const body = ready ? syncContent(view) : D?.authRequired
      ? '<div aria-busy="true">' + A.empty('正在读取同步记录', '') + '</div>'
      : A.empty('需使用员工账号登录', '');
    return A.header('GPT 订单', '预览代充成功任务，确认后写入订单列表。已入单的记录可点击订单编号查看原单。',
      ready ? A.button('刷新', 'order-ops-refresh', '', 'refresh') : '') +
      '<section class="panel">' + A.gptOrderTabs() + body + '</section>';
  }

  function preserveDraft() {
    const form = document.querySelector('#recharge-code-request');
    if (form) A.state.drafts.set('recharge-code-request', A.readDraft(form));
    returnDraft();
  }

  function render() {
    const route = routeNow();
    const view = views.get(route) || {};
    if (route === syncRoute) return renderSync(view);
    const head = A.header('充值码提取', '左侧提交提取申请，审核发码后在右侧查看、复制和归还充值码。两侧记录、筛选与分页独立保留。');
    if (!D?.authRequired) return head + '<section class="panel">' + A.empty('需使用员工账号登录', '') + '</section>';
    return head + '<div class="recharge-workspace"><div class="recharge-workspace-columns">' +
      workspaceRegion(requestRoute) + workspaceRegion(codesRoute) + '</div></div>';
  }

  async function perform(route, operation) {
    if (saving) return;
    saving = true;
    const feedback = A.beginActionFeedback?.(null, '正在处理，请稍候…');
    const view = views.get(route);
    const controls = [...document.querySelectorAll(workspaceActive()
      ? '#recharge-request-region button, #drawer button[type=submit]' : '#main button, #drawer button[type=submit]')];
    const enabled = controls.filter((node) => !node.disabled);
    enabled.forEach((node) => { node.disabled = true; });
    try {
      return await operation(view);
    } catch (error) {
      A.notify(error.message || '操作未完成，请重试');
      if (route === requestRoute && [409, 503].includes(error.status)) await load(route, true);
    } finally {
      feedback?.finish();
      saving = false;
      enabled.forEach((node) => { node.disabled = false; });
      if (workspaceActive() && route !== syncRoute) updateWorkspaceRegion(requestRoute);
      else if (routeNow() === route) A.render();
    }
  }

  async function requestAction(action, id, reason) {
    await perform(requestRoute, async () => {
      const { request } = await D.rechargeCodeAction({ action, id, ...(reason && { reason }) });
      if (action === 'reject') A.closeDrawer();
      A.notify(request.issueProblem || requestStates[request.status] || '已保存');
      await refreshWorkspace();
    });
  }

  async function onClick(action, node) {
    if (!routes.has(routeNow()) || !D?.authRequired) return false;
    const route = routeNow();
    if (action === 'order-ops-refresh') {
      preserveDraft();
      const target = workspaceActive() ? (node.dataset.route === codesRoute ? codesRoute : requestRoute) : route;
      if (workspaceActive()) {
        const actorId = D.actor()?.id, success = await load(target, true);
        if (workspaceActive() && actorId === D.actor()?.id)
          A.notify(success ? '记录已刷新' : '记录读取失败，请重试', { kind: success ? 'success' : 'error' });
      } else await A.withActionFeedback(node, () => load(target, true, target === syncRoute),
        { pending: '正在刷新记录…', success: '记录已刷新', failure: '记录读取失败，请重试' });
    } else if (action === 'order-code-tab') {
      codeTab = node.dataset.id;
      setListView(codesRoute, { tab: codeTab, page: 1, batchId: '' });
      A.getSelection('recharge-code-items').clear();
      updateWorkspaceRegion(codesRoute);
    } else if (action === 'order-code-clear-batch') {
      setListView(codesRoute, { page: 1, batchId: '' }); updateWorkspaceRegion(codesRoute);
    } else if (action === 'order-code-request-detail') {
      const view = views.get(requestRoute), row = view?.data?.requests?.find(row => row.id === node.dataset.id);
      if (row) A.openDrawer('充值码申请详情', '申请状态与发码情况以本批记录为准。', requestDetails(row),
        A.button('关闭', 'drawer-close') + requestActions(row, view.error ? { ...view.data, stock: null } : view.data, false));
    } else if (action === 'order-code-item-detail') {
      const row = views.get(codesRoute)?.data?.items?.find(row => row.id === node.dataset.id);
      if (row) openCodeDetails(row);
    } else if (action === 'order-code-copy') {
      const row = (views.get(codesRoute)?.data?.items || []).find(row => row.id === node.dataset.id);
      if (row?.code && row.status === 'unused') await A.copyText(row.code, '已复制充值码');
    } else if (action === 'order-code-return' || action === 'order-code-return-resume') {
      await openReturn([node.dataset.id], action.endsWith('-resume'));
    } else if (action === 'order-code-return-selected') {
      const selected = A.getSelection('recharge-code-items');
      await openReturn(filteredCodes(views.get(codesRoute)?.data).filter(row => selected.has(row.id)).map(row => row.id));
    } else if (action === 'order-code-return-refresh') {
      if (returnContext) await openReturn(returnContext.ids, returnContext.resume);
    } else if (action === 'order-code-batch-return' || action === 'order-code-batch-detail') {
      const actorId = D.actor()?.id;
      const ready = await load(codesRoute, true);
      if (!workspaceActive() || actorId !== D.actor()?.id) return true;
      if (!ready) { A.notify('批次读取失败，请重试'); return true; }
      const rows = (views.get(codesRoute)?.data?.items || []).filter(row => row.requestId === node.dataset.id);
      if (action === 'order-code-batch-return') await openReturn(rows.map(row => row.id));
      else A.openDrawer('充值码批次明细', '查看本次申请的发放结果与状态；其他员工的完整充值码仅由本人查看。',
        '<div class="recharge-code-table recharge-batch-detail">' + A.table(codeColumns(), rows, '', '充值码批次明细') + '</div>', A.button('关闭', 'drawer-close'));
    } else if (action === 'order-code-reject') {
      const id = node.dataset.id;
      A.openDrawer('驳回充值码申请', '',
        '<form id="order-code-reject" data-id="' + e(id) + '">' +
        A.field('驳回原因', 'order-code-reason', A.input('order-code-reason', '', 'maxlength="200" required'), true) + '</form>',
        A.button('取消', 'drawer-close') + '<button class="button danger" type="submit" form="order-code-reject">确认驳回</button>');
    } else if (action === 'order-code-approve') {
      A.confirmAction('批准充值码申请', '通过后将从对应套餐的现有库存发码，并登记到申请人名下。', () => requestAction('approve', node.dataset.id), '批准并发码');
    } else if (action === 'order-code-reconcile') {
      await requestAction('reconcile', node.dataset.id);
    } else if (action === 'order-sync-open-order') {
      const commerce = A.modules.commerce;
      const { id: jobKey, orderNo } = node.dataset;
      let id = commerce.syncedOrderId(jobKey, orderNo);
      if (!id) {
        const ready = await commerce.refreshOverview();
        if (routeNow() !== syncRoute) return true;
        if (!ready) {
          A.notify('暂时无法读取订单列表，请重试');
          return true;
        }
        id = commerce.syncedOrderId(jobKey, orderNo);
      }
      if (id) A.go('orders/detail/' + encodeURIComponent(id));
      else A.notify('未找到可核对的对应订单');
    } else if (action === 'order-sync-preview' || action === 'order-sync-apply') {
      const mode = action === 'order-sync-preview' ? 'preview' : 'apply';
      const preview = views.get(syncRoute)?.preview;
      const jobKeys = mode === 'apply' && views.get(syncRoute)?.canApply
        ? preview.rows.map(({ jobKey }) => jobKey) : undefined;
      const run = () => perform(syncRoute, async (view) => {
        view.preview = await D.orderSync({ mode, ...(jobKeys && { jobKeys }) });
        view.canApply = mode === 'preview' && Boolean(view.preview.rows?.length);
        if (routeNow() === syncRoute) A.state.page = 1;
        if (mode === 'apply') {
          const refreshed = await A.modules.commerce.refreshAfterOrderSync();
          A.notify(refreshed ? '同步批次已处理' : '同步批次已处理，订单列表刷新失败');
        } else A.notify('预览完成');
      });
      if (mode === 'preview') await run();
      else if (jobKeys?.length) A.confirmAction('同步代充订单', '根据已核对的成功任务建立 GPT 订单。', () => {
        if (routeNow() === syncRoute && views.get(syncRoute)?.preview === preview) return run();
      }, '确认同步');
    } else return false;
    return true;
  }

  async function onSubmit(form) {
    if (form.id === 'code-return-form') { await submitReturn(form); return true; }
    if (form.id === 'code-list-filters') return true;
    if (form.id === 'order-sync-lookup' && D?.authRequired) {
      const jobKey = form.elements['order-sync-job'].value.trim();
      await perform(syncRoute, async (view) => {
        view.preview = await D.orderSync({ mode: 'preview', jobKeys: [jobKey] });
        view.canApply = Boolean(view.preview.rows?.length);
        if (routeNow() === syncRoute) A.state.page = 1;
        A.notify(view.preview.rows?.length ? '指定任务已核对，结果已列出' : '核对完成，暂无可同步记录', { kind: 'success' });
      });
      return true;
    }
    if (form.id === 'order-code-reject') {
      await requestAction('reject', form.dataset.id, form.elements['order-code-reason'].value.trim());
      return true;
    }
    if (form.id !== 'recharge-code-request' || !D?.authRequired) return false;
    preserveDraft();
    const plan = form.elements['recharge-request-plan'].value;
    const count = Number(form.elements['recharge-request-count'].value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      A.setError('recharge-request-count', '请输入 1 至 100 的整数');
      return true;
    }
    const view = views.get(requestRoute);
    const availability = requestAvailability(view?.error ? null : view?.data?.stock, plan, count);
    if (availability.blocked) {
      A.setError('recharge-request-count', availability.message);
      return true;
    }
    const draft = JSON.stringify(A.readDraft(form));
    const actorId = D.actor()?.id;
    requestKey ??= crypto.randomUUID();
    await perform(requestRoute, async () => {
      await D.rechargeCodeAction({ action: 'request', requestKey, plan, count });
      requestKey = undefined;
      if (actorId !== D.actor()?.id) return;
      if (JSON.stringify(A.state.drafts.get('recharge-code-request')) === draft)
        A.state.drafts.delete('recharge-code-request');
      if (form.isConnected && JSON.stringify(A.readDraft(form)) === draft) {
        form.elements['recharge-request-plan'].value = 'plus';
        form.elements['recharge-request-count'].value = '1';
      }
      setListView(requestRoute, { page: 1 });
      await load(requestRoute, true);
      A.notify('申请已提交，等待审核');
    });
    return true;
  }

  function onInput(node) {
    if (workspaceActive() && (node.dataset.select === 'recharge-code-items' || node.dataset.selectAll === 'recharge-code-items')) {
      const selection = A.getSelection('recharge-code-items');
      const ids = node.dataset.select ? [node.dataset.id]
        : [...node.closest('table').querySelectorAll('tbody tr[data-row-id]')].map(row => row.dataset.rowId);
      for (const id of ids) { if (node.checked) selection.add(id); else selection.delete(id); }
      updateWorkspaceRegion(codesRoute);
      return true;
    }
    if (node.id === 'order-sync-job') {
      A.state.drafts.set('order-sync-lookup', node.value);
      return true;
    }
    if (['recharge-request-plan', 'recharge-request-count'].includes(node.id)) {
      const form = node.closest('form');
      const draft = A.readDraft(form);
      A.state.drafts.set('recharge-code-request', draft);
      updateRequestForm();
      return true;
    }
    if (!['code-list-query', 'code-list-plan'].includes(node.id)) return false;
    const form = node.closest('form');
    setListView(codesRoute, { ...A.readForm(form), tab: codeTab, page: 1, batchId: '' });
    A.getSelection('recharge-code-items').clear();
    updateWorkspaceRegion(codesRoute);
    return true;
  }
  if (D?.authRequired) {
    const labels = () => void D.refreshOperatorLabels().then((changed) => {
      if (changed && !document.querySelector('dialog[open]')) {
        if (workspaceActive()) updateWorkspaceRegion(requestRoute);
        else if (routes.has(routeNow()) || routeNow().startsWith('orders/')) A.render();
      }
    });
    window.addEventListener('DOMContentLoaded', labels, { once: true });
    window.addEventListener('focus', labels);
    window.addEventListener('hashchange', labels);
  }
  async function refreshWorkspace() {
    return (await Promise.all([load(requestRoute, true), load(codesRoute, true)])).every(Boolean);
  }
  document.addEventListener('id-pagination-change', event => {
    if (!workspaceActive()) return;
    const route = event.detail.id === draftKey(requestRoute) ? requestRoute : event.detail.id === draftKey(codesRoute) ? codesRoute : '';
    if (!route || !event.target.closest('#' + regionId(route))) return;
    setListView(route, { page: event.detail.page, pageSize: event.detail.pageSize });
    updateWorkspaceRegion(route);
  });
  window.IDDesignModules.push({
    id: 'order-operations', matches: (route) => routes.has(route), render, onClick, onSubmit, preserveDraft, onInput, onChange: onInput,
    onDataChanges(scopes) {
      if (routeNow() === syncRoute && scopes.some(scope => ['order-sync', 'commerce', 'recharge-codes', 'operators'].includes(scope)))
        return load(syncRoute, true);
      if (workspaceActive() && scopes.some(scope => ['commerce', 'recharge-codes', 'operators'].includes(scope)))
        return refreshWorkspace();
    },
    afterRender({ routeChanged } = {}) {
      codeFrameObserver?.disconnect();
      if (!D?.authRequired) return;
      if (workspaceActive()) {
        updateCodeControls();
        codeFrameObserver = new ResizeObserver(stabilizeCodeFrames);
        for (const region of document.querySelectorAll('#recharge-request-region, #recharge-codes-region')) codeFrameObserver.observe(region);
        stabilizeCodeFrames();
        void load(requestRoute, Boolean(routeChanged)); void load(codesRoute, Boolean(routeChanged));
      } else void load(routeNow(), Boolean(routeChanged));
    },
    onLeave() { codeFrameObserver?.disconnect(); }
  });
})();
