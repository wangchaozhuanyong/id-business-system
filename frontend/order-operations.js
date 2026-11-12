(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const requestRoute = 'workspace/recharge-codes';
  const codesRoute = 'workspace/my-recharge-codes';
  const routes = new Set([requestRoute, codesRoute]);
  const planNames = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const requestStates = { pending: '待审核', issuing: '待发码核对', issued: '已发码', rejected: '已驳回' };
  const requestFilters = [['all', '全部'], ['pending', '待处理'], ['processed', '已处理']];
  const requestMatches = (row, filter) => filter === 'pending' ? ['pending', 'issuing'].includes(row.status)
    : filter === 'processed' ? ['issued', 'rejected'].includes(row.status) : true;
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
  const read = (route) => route === requestRoute ? D.rechargeCodeRequests() : D.rechargeCodes();

  async function load(route, refresh = false) {
    if (!D) return;
    const current = views.get(route) || {};
    if (current.loading) {
      if (refresh) current.reload = true;
      return current.pending;
    }
    if (current.loaded && !refresh) return true;
    const actorId = D.actor()?.id;
    current.loading = true;
    current.error = '';
    views.set(route, current);
    const region = workspaceActive() ? document.getElementById(regionId(route)) : null;
    const feedback = region ? A.beginRegionRead(region, region.querySelector('[data-code-progress]'), {
      refreshButton: region.querySelector('[data-action="order-ops-refresh"]')
    }) : null;
    current.pending = (async () => { try {
      const data = await read(route);
      if (actorId !== D.actor()?.id) return false;
      if (route === codesRoute && current.data) locateNewBatch(current.data.items, data.items, actorId);
      current.data = data;
      return true;
    } catch (error) {
      current.error = error.message || '读取失败，请重试';
      return false;
    } finally {
      current.loaded = true;
      current.loading = false;
      feedback?.finish();
      if (workspaceActive()) updateWorkspaceRegion(route);
    } })();
    const result = await current.pending;
    current.pending = undefined;
    if (current.reload) { current.reload = false; return load(route, true); }
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
      A.button('驳回', 'order-code-reject', '', '', attrs + (saving ? ' disabled' : '')) +
      A.button('批准', 'order-code-approve', 'primary', '', attrs + (saving || requestAvailability(data.stock, row.plan, row.count).blocked ? ' disabled title="库存不足、暂未核对或正在保存"' : ''));
    if (data?.canApprove && row.status === 'issuing') actions +=
      A.button('驳回', 'order-code-reject', '', '', attrs + (saving ? ' disabled' : '')) +
      A.button('重新核对', 'order-code-reconcile', 'primary', '', attrs + (saving ? ' disabled' : ''));
    if (row.status === 'issued') actions += A.textAction('批次明细', 'order-code-batch-detail', attrs) +
      A.button(row.counts?.returnable ? `归还（${row.counts.returnable}）` : '无可归还项', 'order-code-batch-return', '', '', attrs + (row.counts?.returnable ? '' : ' disabled'));
    return '<div class="recharge-record-actions">' + actions + '</div>';
  }
  function requestHistory(view) {
    const canApprove = view.data?.canApprove ?? ['admin', 'super'].includes(D.actor()?.role);
    const title = canApprove ? '申请审批' : '我的申请';
    const rows = [...(view.data?.requests || [])].sort((a, b) => String(b.createdAt || b.issuedAt || '').localeCompare(String(a.createdAt || a.issuedAt || '')));
    const filter = listView(requestRoute).status || 'all';
    const header = `<div class="recharge-review-heading"><div class="section-title-row"><h3 id="code-request-history-heading">${title}</h3>${A.titleInfo(title,
      canApprove ? '管理员和超级管理员可批准、驳回或核对申请。待处理包含待审核和待发码核对；已处理包含已发码和已驳回。详情可查看使用统计、驳回原因及批次明细。'
        : '仅显示本人申请。待处理包含待审核和待发码核对；管理员审核后可查看发放结果。详情可查看驳回原因及批次明细。', 'code-request-history-help')}</div><span class="recharge-review-scope">${canApprove ? '管理员审批' : '仅本人记录'}</span></div>`;
    const filters = `<div class="tabs recharge-request-filters" role="tablist" aria-label="申请记录状态">${requestFilters.map(([key, label]) => {
      const countId = 'recharge-request-count-' + key;
      const count = Array.isArray(view.data?.requests) ? rows.filter(row => requestMatches(row, key)).length : '—';
      return `<button type="button" class="tab${key === filter ? ' active' : ''}" role="tab" aria-selected="${key === filter}" aria-label="${label}" aria-describedby="${countId}" aria-controls="recharge-request-records" data-action="order-request-filter" data-id="${key}"${!view.data || saving ? ' disabled' : ''}>${label}<span class="tab-count" id="${countId}">${count}</span></button>`;
    }).join('')}</div>`;
    if (!view.loaded && !view.data) return header + filters + A.empty('正在读取申请记录', '');
    const page = listPage(requestRoute, rows.filter(row => requestMatches(row, filter)));
    const actionsData = view.error ? { ...view.data, stock: null } : view.data;
    const emptyTitle = view.error && !view.data ? '申请记录读取失败'
      : filter === 'pending' ? '暂无待处理申请' : filter === 'processed' ? '暂无已处理申请' : '暂无申请记录';
    return header + filters + `<div id="recharge-request-records" class="recharge-list-frame" data-code-frame="requests"><div>${page.rows.length ? `<ul class="recharge-request-list" tabindex="0" aria-label="申请记录列表">${page.rows.map(row => `<li data-request-id="${e(row.id)}" data-request-status="${e(row.status)}"><div class="recharge-request-heading"><div><strong>${e(planNames[row.plan] || '待核对')}</strong><span class="recharge-request-quantity">${e(row.count)} 个</span></div>${A.tag(requestStates[row.status] || '待核对', row.status === 'issued' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning')}</div><div class="recharge-request-meta"><span>批次 <strong>${e(row.batchNo || '编号待核对')}</strong></span>${view.data?.canApprove ? `<span>申请人 <strong>${e(actorName(row))}</strong></span>` : ''}<time datetime="${e(row.createdAt || row.issuedAt || '')}">${e(displayTime(row.createdAt || row.issuedAt))}</time></div>${requestActions(row, actionsData)}</li>`).join('')}</ul>` : A.empty(emptyTitle, '')}</div></div>${page.pager}`;
  }
  function requestContent(view) {
    const draft = A.state.drafts.get('recharge-code-request') || {};
    const plan = draft['recharge-request-plan'] || 'plus', count = draft['recharge-request-count'] ?? '1';
    const availability = requestAvailability(view.error ? null : view.data?.stock, plan, Number(count));
    return '<div class="form-panel recharge-request-form"><form id="recharge-code-request"><div class="form-grid recharge-request-fields">' +
      A.field('套餐', 'recharge-request-plan', A.select('recharge-request-plan', Object.entries(planNames), plan), true) +
      A.field('数量', 'recharge-request-count', A.input('recharge-request-count', count, 'type="number" min="1" max="100" step="1" required aria-label="申请数量"'), true) +
      '</div><div class="recharge-request-submit"><p class="recharge-stock-notice" id="recharge-request-stock" role="status" data-blocked="' + availability.blocked + '">' + e(availability.message) + '</p>' +
      '<button class="button primary" type="submit" aria-describedby="recharge-request-stock"' +
      (saving || availability.blocked ? ' disabled' : '') + '>提交申请</button></div></form></div>' +
      '<section id="recharge-request-history" class="recharge-request-review" aria-labelledby="code-request-history-heading">' + requestHistory(view) + '</section>';
  }
  function filteredCodes(data) {
    const draft = listView(codesRoute);
    const query = (draft['code-list-query'] || '').trim().toLowerCase(), plan = draft['code-list-plan'] || '';
    return (data?.items || []).filter(row => (codeTab === 'returns' ? Boolean(row.returnRecord)
      : codeTab === 'other' ? ['processing', 'unavailable', 'return-pending'].includes(row.status) : row.status === codeTab) &&
      (!draft.batchId || row.requestId === draft.batchId) && (!plan || row.plan === plan) &&
      (!query || [row.code, row.last4, row.batchNo, row.itemNo, row.id, row.requestId, row.applicantName].some(value => value?.toLowerCase().includes(query))))
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
      { id: 'code', label: '充值码', class: 'recharge-code-value', render: row => `<span class="recharge-code-text">${e(row.code || '•••• ' + (row.last4 || ''))}</span><span class="recharge-item-number">领用 ${e(row.itemNo || '编号待核对')}</span>` },
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
    return '<div class="list-controls recharge-code-toolbar">' +
      '<div class="tabs recharge-code-tabs" role="tablist" aria-label="充值码状态">' + tabs + '</div>' +
      '<form class="toolbar recharge-code-filters" id="code-list-filters">' +
      '<div class="search-field">' + A.icon('search') + A.input('code-list-query', draft['code-list-query'] || '', 'data-auto-search type="search" aria-label="搜索充值码、批次或领用编号" placeholder="充值码 / 批次 / 领用号"') + '</div>' +
      A.select('code-list-plan', [['', '全部套餐'], ...Object.entries(planNames)], draft['code-list-plan'] || '').replace('<select ', '<select aria-label="筛选套餐" ') +
      A.button('归还所选', 'order-code-return-selected', '', '', 'disabled') + '</form></div>' +
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
    form.querySelector('#recharge-request-stock').dataset.blocked = String(blocked);
    form.querySelector('[type="submit"]').disabled = saving || blocked;
  }
  function updateCodeControls() {
    const region = document.getElementById(regionId(codesRoute));
    if (!region) return;
    const draft = listView(codesRoute);
    for (const name of ['code-list-query', 'code-list-plan']) {
      const control = document.getElementById(name);
      if (control && window.IDSearchInput && window.IDSearchInput.value(control) !== control.value) continue;
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
    const batch = views.get(codesRoute)?.data?.items?.find(row => row.requestId === draft.batchId);
    banner.innerHTML = draft.batchId ? '<span>已定位新发放批次 · ' + e(batch?.batchNo || '编号待核对') + '</span>' + A.textAction('查看全部', 'order-code-clear-batch') : '';
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
      const key = `${listView(route).pageSize}:${Math.round(frame.getBoundingClientRect().width)}:${route === requestRoute ? listView(route).status || 'all' : ''}`;
      view.frames ||= new Map();
      const style = getComputedStyle(frame);
      const viewport = frame.querySelector('.table-viewport');
      const naturalHeight = viewport
        ? viewport.querySelector('table').getBoundingClientRect().height + viewport.offsetHeight - viewport.clientHeight
        : frame.firstElementChild.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const height = Math.max(view.frames.get(key) || 0, naturalHeight);
      view.frames.set(key, height);
      if (viewport) viewport.style.setProperty('--pagination-content-min-height', `${height}px`);
      else frame.style.minHeight = `${height}px`;
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
    return '<div class="property-list recharge-code-details">' + property('申请批次', row.batchNo) + property('申请人', actorName(row)) +
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
      property('领用编号', row.itemNo) + property('发放批次', row.batchNo) + property('领码人', actorName(row)) +
      property('发放时间', displayTime(row.issuedAt)) + property('归还资格', row.returnReason) +
      (row.returnRecord ? property('归还时间', displayTime(row.returnRecord.returnedAt)) + property('归还操作人', row.returnRecord.actorName) + property('归还备注', row.returnRecord.note || '无') : '') + '</div>',
      A.button('关闭', 'drawer-close') + codeActions(row, false));
  }
  function returnDraft() {
    const form = document.querySelector('#code-return-form');
    if (form?.dataset.rechargeReturnDraft) A.state.drafts.set(form.dataset.rechargeReturnDraft, A.readDraft(form));
  }
  function updateReturnSelection() {
    const form = document.querySelector('#code-return-form');
    if (!form) return;
    const count = form.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)').length;
    form.querySelector('#code-return-selection').textContent = `已选 ${count} / 共 ${returnContext.rows.length} 条`;
    document.querySelector('button[form="code-return-form"][type="submit"]').disabled = Boolean(form.dataset.saving) || !count;
  }
  function drawReturn(ctx, rows) {
    ctx.rows = rows;
    const draft = A.state.drafts.get(ctx.key), selectable = row => row.eligible || (ctx.resume && row.state === 'pending');
    A.openDrawer('归还充值码', '逐项核对未使用状态，确认后永久停用原码。已使用、已交付及历史任务不会被撤销。',
      '<form id="code-return-form" data-recharge-return-draft="' + e(ctx.key) + '"><div class="recharge-return-summary"><h3 id="code-return-list-heading">核对归还项目</h3><span id="code-return-selection" role="status"></span></div>' +
      '<ul class="recharge-return-list" aria-labelledby="code-return-list-heading">' + rows.map(row => {
        const enabled = selectable(row), checked = enabled && (draft ? draft['return-code-' + row.id] : true);
        const label = row.state === 'returned' ? '已归还' : row.state === 'pending' ? '待核对' : row.eligible ? '可归还' : '不可归还';
        return '<li class="recharge-return-card" data-return-id="' + e(row.id) + '"><div class="recharge-return-heading"><label>' +
          '<input type="checkbox" name="return-code-' + e(row.id) + '" aria-label="选择领用 ' + e(row.itemNo || '未匹配记录') + '" ' + (enabled ? '' : 'disabled ') + (checked ? 'checked' : '') + '>' +
          '<strong>' + e(row.itemNo || '未匹配记录') + '</strong></label>' + A.tag(label, row.eligible ? 'success' : row.state === 'pending' ? 'warning' : '') + '</div>' +
          '<dl class="recharge-return-meta"><div><dt>发放批次</dt><dd>' + e(row.batchNo || '—') + '</dd></div><div><dt>套餐</dt><dd>' + e(planNames[row.plan] || '—') + '</dd></div><div><dt>码尾四位</dt><dd>' + e(row.last4 || '—') + '</dd></div></dl>' +
          '<div class="recharge-return-result"><p>' + e(row.reason || '状态待核对') + '</p>' + (row.state === 'pending' ? A.button('核对并继续', 'order-code-return-resume', '', '', 'data-id="' + e(row.id) + '"') : '') + '</div></li>';
      }).join('') + '</ul>' + A.field('归还备注', 'code-return-note', A.input('code-return-note', draft?.['code-return-note'] || '', 'maxlength="200"')) +
      '<div class="inline-notice" id="code-return-status" role="status">只处理勾选项；不可归还项继续保留原记录。</div></form>',
      A.button('关闭', 'drawer-close') + A.button('重新核对', 'order-code-return-refresh') +
      '<button class="button primary" form="code-return-form" type="submit"' + (rows.some(selectable) ? '' : ' disabled') + '>确认归还</button>', ctx.key);
    returnContext = ctx;
    updateReturnSelection();
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
  function preserveDraft() {
    const form = document.querySelector('#recharge-code-request');
    if (form) A.state.drafts.set('recharge-code-request', A.readDraft(form));
    returnDraft();
  }

  function render() {
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
      if (workspaceActive()) updateWorkspaceRegion(requestRoute);
    }
  }

  async function requestAction(action, id, details = {}) {
    await perform(requestRoute, async () => {
      const { request } = await D.rechargeCodeAction({ action, id, ...details });
      if (action !== 'reconcile') A.closeDrawer();
      A.notify(request.issueProblem || requestStates[request.status] || '已保存');
      await refreshWorkspace();
    });
  }

  async function onClick(action, node) {
    if (!routes.has(routeNow()) || !D?.authRequired) return false;
    if (action === 'order-ops-refresh') {
      preserveDraft();
      const target = node.dataset.route === codesRoute ? codesRoute : requestRoute;
      const actorId = D.actor()?.id, success = await load(target, true);
      if (workspaceActive() && actorId === D.actor()?.id)
        A.notify(success ? '记录已刷新' : '记录读取失败，请重试', { kind: success ? 'success' : 'error' });
    } else if (action === 'order-request-filter') {
      if (!requestFilters.some(([key]) => key === node.dataset.id)) return true;
      const status = node.dataset.id;
      setListView(requestRoute, { status, page: 1 });
      updateWorkspaceRegion(requestRoute);
      document.querySelector(`#recharge-request-history [data-action="order-request-filter"][data-id="${status}"]`)?.focus({ preventScroll: true });
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
      const view = views.get(requestRoute);
      const row = view?.data?.requests?.find(row => row.id === node.dataset.id);
      if (!view?.data?.canApprove || row?.status !== 'pending') return true;
      A.openDrawer('批准充值码申请', '从对应套餐发码并登记到申请人名下。',
        '<form id="order-code-approve" data-id="' + e(row.id) + '">' + requestDetails(row) + '</form>',
        A.button('取消', 'drawer-close') + '<button class="button primary" type="submit" form="order-code-approve">批准并发码</button>');
    } else if (action === 'order-code-reconcile') {
      await requestAction('reconcile', node.dataset.id);
    } else return false;
    return true;
  }

  async function onSubmit(form) {
    if (form.id === 'code-return-form') { await submitReturn(form); return true; }
    if (form.id === 'code-list-filters') return true;
    if (form.id === 'order-code-reject') {
      await requestAction('reject', form.dataset.id, { reason: form.elements['order-code-reason'].value.trim() });
      return true;
    }
    if (form.id === 'order-code-approve') {
      await requestAction('approve', form.dataset.id);
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
      if (listView(requestRoute).status === 'processed') setListView(requestRoute, { status: 'pending' });
      await load(requestRoute, true);
      A.notify('申请已提交，等待审核');
    });
    return true;
  }

  function onInput(node) {
    if (node.closest('#code-return-form')) {
      returnDraft();
      updateReturnSelection();
      return true;
    }
    if (workspaceActive() && (node.dataset.select === 'recharge-code-items' || node.dataset.selectAll === 'recharge-code-items')) {
      const selection = A.getSelection('recharge-code-items');
      const ids = node.dataset.select ? [node.dataset.id]
        : [...node.closest('table').querySelectorAll('tbody tr[data-row-id]')].map(row => row.dataset.rowId);
      for (const id of ids) { if (node.checked) selection.add(id); else selection.delete(id); }
      updateWorkspaceRegion(codesRoute);
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
      }
    },
    onLeave() { codeFrameObserver?.disconnect(); }
  });
})();
