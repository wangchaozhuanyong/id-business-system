(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const requestRoute = 'workspace/recharge-codes';
  const codesRoute = 'workspace/my-recharge-codes';
  const syncRoute = 'orders/recharge-sync';
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

  const routeNow = () => A.state.route;
  const displayTime = (at) => {
    if (!at) return '—';
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return at;
    return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  };
  const actorName = (row) => D.operatorLabel(row.applicantId, row.applicantName || '历史员工');
  const read = (route) => route === requestRoute ? D.rechargeCodeRequests()
    : route === codesRoute ? D.rechargeCodes() : D.orderSyncStatus();

  async function load(route, refresh = false) {
    if (!D) return;
    const current = views.get(route) || {};
    if (current.loading || (current.loaded && !refresh)) return;
    current.loading = true;
    current.error = '';
    views.set(route, current);
    try {
      current.data = await read(route);
      return true;
    } catch (error) {
      current.error = error.message || '读取失败，请重试';
      return false;
    } finally {
      current.loaded = true;
      current.loading = false;
      if (routeNow() === route) A.render();
    }
  }

  function table(columns, rows, id, title) {
    return rows.length
      ? A.table(columns, A.pageRows(rows), '', id) + A.pagination(rows.length)
      : A.empty(title, '');
  }

  function requestContent(data) {
    const draft = A.state.drafts.get('recharge-code-request') || {};
    const rows = data?.requests || [];
    const fields = A.field('套餐', 'recharge-request-plan',
      A.select('recharge-request-plan', Object.entries(planNames), draft['recharge-request-plan'] || 'plus'), true) +
      A.field('申请数量', 'recharge-request-count',
        A.input('recharge-request-count', draft['recharge-request-count'] || '1', 'type="number" min="1" max="100" step="1" required'), true);
    const columns = [
      { id: 'applicantName', label: '申请人', render: (row) => e(actorName(row)) },
      { id: 'plan', label: '套餐', render: (row) => e(planNames[row.plan] || '待核对') },
      { id: 'count', label: '数量' },
      { id: 'returnable', label: '可归还', render: row => e(row.status === 'issued' ? row.counts?.returnable ?? 0 : '—') },
      { id: 'usage', label: '使用情况', render: row => e(row.status === 'issued' ? `未用 ${row.counts?.unused || 0} · 使用中 ${row.counts?.processing || 0} · 已用 ${row.counts?.used || 0} · 待核对 ${row.counts?.unavailable || 0}` : '—') },
      { id: 'returned', label: '已归还', render: row => e(row.counts?.returned ?? 0) },
      { id: 'pendingReturns', label: '归还待核对', render: row => e(row.counts?.pendingReturns ?? 0) },
      { id: 'status', label: '审核状态', render: (row) => e(requestStates[row.status] || '待核对') },
      { id: 'createdAt', label: '申请时间', render: (row) => e(displayTime(row.createdAt)) },
      { id: 'reason', label: '说明', render: (row) => e(row.issueProblem || row.reason || '—') }
    ];
    columns.push({ id: 'actions', label: '操作', action: true, render: row => {
      const attrs = 'data-id="' + e(row.id) + '"';
      if (data?.canApprove && row.status === 'pending') return '<div class="action-links">' +
        A.textAction('批准', 'order-code-approve', attrs) + A.textAction('驳回', 'order-code-reject', attrs) + '</div>';
      if (data?.canApprove && row.status === 'issuing') return A.textAction('重新核对', 'order-code-reconcile', attrs);
      return row.status === 'issued' ? '<div class="action-links">' +
        A.button(row.counts?.returnable ? '归还（' + row.counts.returnable + '）' : '无可归还项', 'order-code-batch-return', '', '', attrs + (row.counts?.returnable ? '' : ' disabled')) +
        A.textAction('明细', 'order-code-batch-detail', attrs) + '</div>' : '';
    } });
    return '<section class="panel form-panel"><form id="recharge-code-request">' +
      fields + '<div class="form-footer"><span class="footnote">管理员审核通过后发码。</span>' +
      '<button class="button primary" type="submit"' + (saving ? ' disabled' : '') +
      '>提交申请</button></div></form></section><section class="panel section-gap">' +
      '<div class="panel-heading"><h2>申请记录</h2></div>' +
      table(columns, rows, 'recharge-code-requests', '暂无申请记录') + '</section>';
  }

  function filteredCodes(data) {
    const draft = A.state.drafts.get('recharge-code-view') || {};
    const query = (draft['code-list-query'] || '').trim().toLowerCase(), plan = draft['code-list-plan'] || '';
    return (data?.items || []).filter(row => (codeTab === 'returns' ? Boolean(row.returnRecord)
      : codeTab === 'other' ? ['processing', 'unavailable', 'return-pending'].includes(row.status) : row.status === codeTab) &&
      (!plan || row.plan === plan) && (!query || [row.code, row.last4, row.id, row.requestId, row.applicantName].some(value => value?.toLowerCase().includes(query))));
  }
  function codesContent(data) {
    const rows = filteredCodes(data), draft = A.state.drafts.get('recharge-code-view') || {};
    const tabs = [['unused', '未使用'], ['used', '已使用'], ['other', '处理中与待核对'], ['returned', '已归还'], ['returns', '归还记录']]
      .map(([key, label]) => '<button type="button" class="tab ' + (key === codeTab ? 'active' : '') +
        '" role="tab" aria-selected="' + (key === codeTab) + '" data-action="order-code-tab" data-id="' + key + '">' + label + '</button>').join('');
    const columns = [
      { id: 'code', label: '充值码', render: row => e(row.code || '•••• ' + row.last4) },
      { id: 'id', label: '领用编号', long: true },
      { id: 'requestId', label: '发放批次', long: true },
      { id: 'applicantName', label: '领码人', render: row => e(actorName(row)) },
      { id: 'plan', label: '套餐', render: row => e(planNames[row.plan] || '待核对') },
      { id: 'status', label: '状态', render: row => e(codeStates[row.status] || '待核对') },
      { id: 'returnReason', label: '归还资格', long: true },
      ...(codeTab === 'returns' || codeTab === 'returned' ? [
        { id: 'returnedAt', label: '归还时间', render: row => e(displayTime(row.returnRecord?.returnedAt)) },
        { id: 'returnActor', label: '归还操作人', render: row => e(row.returnRecord?.actorName || '—') },
        { id: 'returnNote', label: '归还备注', render: row => e(row.returnRecord?.note || '—') }
      ] : [{ id: 'issuedAt', label: '发放时间', render: row => e(displayTime(row.issuedAt)) }]),
      { id: 'actions', label: '操作', action: true, render: row => '<div class="action-links">' +
        (row.status === 'unused' && row.code ? A.textAction('复制', 'order-code-copy', 'data-id="' + e(row.id) + '"') : '') +
        (row.status === 'return-pending' ? A.textAction('核对并继续', 'order-code-return-resume', 'data-id="' + e(row.id) + '"')
          : A.button(row.eligible ? '归还' : '不可归还', 'order-code-return', '', '', 'data-id="' + e(row.id) + '" title="' + e(row.returnReason) + '"' + (row.eligible ? '' : ' disabled'))) + '</div>' }
    ];
    return '<section class="panel"><div class="list-controls"><div class="tabs" role="tablist" aria-label="充值码状态">' + tabs + '</div>' +
      '<div class="toolbar"><div class="toolbar-left"><form id="code-list-filters"><div class="field-row">' +
      A.input('code-list-query', draft['code-list-query'] || '', 'type="search" aria-label="搜索充值码、领用编号或批次" placeholder="搜索充值码、编号或批次"') +
      A.select('code-list-plan', [['', '全部套餐'], ...Object.entries(planNames)], draft['code-list-plan'] || '').replace('<select ', '<select aria-label="筛选套餐" ') +
      '</div></form></div><div class="toolbar-right">' + A.button('归还所选', 'order-code-return-selected') + '</div></div></div>' +
      (rows.length ? A.table(columns, A.pageRows(rows), 'recharge-code-items', 'my-recharge-codes') + A.pagination(rows.length) : A.empty('当前分类暂无充值码', '')) + '</section>';
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
      await load(ctx.route, true);
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
      { id: 'orderNo', label: 'GPT 订单编号', render: (row) => e(row.orderNo || '—') },
      { id: 'needs', label: '待核对项', render: (row) => e((row.needs || []).join('、') || '—') }
    ];
    return '<section class="panel"><div class="toolbar"><div class="toolbar-left">' +
      '<span class="footnote">核对新任务后同步到 GPT 订单。同步与自动充值分别运行。</span></div>' +
      '<div class="toolbar-right">' + A.button('预览', 'order-sync-preview', '', '', saving ? 'disabled' : '') +
      A.button('同步入单', 'order-sync-apply', 'primary', '', saving || !view.preview?.rows?.length ? 'disabled' : '') +
      '</div></div>' + '<form class="panel-body" id="order-sync-lookup"><div class="field-row">' +
      A.input('order-sync-job', '', 'placeholder="指定代充任务编号" aria-label="指定代充任务编号" required maxlength="120"') +
      '<button class="button" type="submit">核对指定任务</button></div></form>' +
      (view.data?.lastError ? '<p class="panel-body footnote" role="status">' + e(view.data.lastError) + '</p>' : '') +
      (data?.more ? '<p class="panel-body footnote">还有记录可核对，请分批处理或按任务编号查询。</p>' : '') +
      table(columns, (data?.rows || []).map((row) => ({ ...row, id: row.jobKey })), 'recharge-order-sync', '暂无待同步记录') + '</section>';
  }

  function preserveDraft() {
    const form = document.querySelector('#recharge-code-request');
    if (form) A.state.drafts.set('recharge-code-request', A.readDraft(form));
    returnDraft();
  }

  function render() {
    const route = routeNow();
    const title = route === requestRoute ? '充值码提取' : route === codesRoute ? '我的充值码' : '代充订单同步';
    const description = route === requestRoute ? '申请经审核后生成充值码。'
      : route === codesRoute ? '查看已交付充值码和代充系统使用状态。'
        : '从代充系统读取成功记录，按任务生成 GPT 订单。';
    const head = A.header(title, description, D ? A.button('刷新', 'order-ops-refresh', '', 'refresh') : '');
    if (!D?.authRequired) return head + '<section class="panel">' + A.empty('需使用员工账号登录', '') + '</section>';
    const view = views.get(route) || {};
    if (!view.loaded) return head + '<section class="panel" aria-busy="true">' + A.empty('正在读取', '') + '</section>';
    const notice = view.error ? '<div class="panel-body inline-notice warning" role="status">' + e(view.error) + '</div>' : '';
    const content = route === requestRoute ? requestContent(view.data)
      : route === codesRoute ? codesContent(view.data) : syncContent(view);
    return head + notice + content;
  }

  async function perform(route, operation) {
    if (saving) return;
    saving = true;
    const feedback = A.beginActionFeedback?.(null, '正在处理，请稍候…');
    const view = views.get(route);
    const controls = [...document.querySelectorAll('#main button, #drawer button[type=submit]')];
    const enabled = controls.filter((node) => !node.disabled);
    enabled.forEach((node) => { node.disabled = true; });
    try {
      return await operation(view);
    } catch (error) {
      A.notify(error.message || '操作未完成，请重试');
    } finally {
      feedback?.finish();
      saving = false;
      enabled.forEach((node) => { node.disabled = false; });
      if (routeNow() === route) A.render();
    }
  }

  async function requestAction(action, id, reason) {
    await perform(requestRoute, async () => {
      const { request } = await D.rechargeCodeAction({ action, id, ...(reason && { reason }) });
      if (action === 'reject') A.closeDrawer();
      A.notify(request.issueProblem || requestStates[request.status] || '已保存');
      await load(requestRoute, true);
    });
  }

  async function onClick(action, node) {
    if (!routes.has(routeNow()) || !D?.authRequired) return false;
    const route = routeNow();
    if (action === 'order-ops-refresh') {
      preserveDraft();
      await A.withActionFeedback(node, () => load(route, true),
        { pending: '正在刷新记录…', success: '记录已刷新', failure: '记录读取失败，请重试' });
    } else if (action === 'order-code-tab') {
      codeTab = node.dataset.id;
      A.state.drafts.set('recharge-code-view', { ...A.state.drafts.get('recharge-code-view'), tab: codeTab });
      A.state.page = 1;
      A.render();
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
      const data = await D.rechargeCodes();
      if (routeNow() !== requestRoute) return true;
      await openReturn(data.items.filter(row => row.requestId === node.dataset.id).map(row => row.id));
    } else if (action === 'order-code-reject') {
      const id = node.dataset.id;
      A.openDrawer('驳回充值码申请', '',
        '<form id="order-code-reject" data-id="' + e(id) + '">' +
        A.field('驳回原因', 'order-code-reason', A.input('order-code-reason', '', 'maxlength="200" required'), true) + '</form>',
        A.button('取消', 'drawer-close') + '<button class="button danger" type="submit" form="order-code-reject">确认驳回</button>');
    } else if (action === 'order-code-approve') {
      A.confirmAction('批准充值码申请', '通过后将为申请人生成本批充值码。', () => requestAction('approve', node.dataset.id), '批准并发码');
    } else if (action === 'order-code-reconcile') {
      await requestAction('reconcile', node.dataset.id);
    } else if (action === 'order-sync-preview' || action === 'order-sync-apply') {
      const mode = action === 'order-sync-preview' ? 'preview' : 'apply';
      const run = () => perform(syncRoute, async (view) => {
        const jobKeys = mode === 'apply' ? view.preview.rows.map(({ jobKey }) => jobKey) : undefined;
        view.preview = await D.orderSync({ mode, ...(jobKeys && { jobKeys }) });
        A.state.page = 1;
        A.notify(mode === 'preview' ? '预览完成' : '同步批次已处理');
      });
      if (mode === 'apply') A.confirmAction('同步代充订单', '根据已核对的成功任务建立 GPT 订单。', run, '确认同步');
      else await run();
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
        A.state.page = 1;
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
    requestKey ??= crypto.randomUUID();
    await perform(requestRoute, async () => {
      await D.rechargeCodeAction({ action: 'request', requestKey, plan, count });
      requestKey = undefined;
      form.reset();
      A.state.drafts.delete('recharge-code-request');
      await load(requestRoute, true);
      A.notify('申请已提交，等待审核');
    });
    return true;
  }

  function onCodeFilter(node) {
    if (!['code-list-query', 'code-list-plan'].includes(node.id)) return false;
    const form = node.closest('form'), cursor = node.selectionStart;
    A.state.drafts.set('recharge-code-view', { ...A.readForm(form), tab: codeTab });
    A.state.page = 1; A.render();
    const current = document.getElementById(node.id); current?.focus();
    if (node.id === 'code-list-query') current?.setSelectionRange(cursor, cursor);
    return true;
  }
  if (D?.authRequired) {
    const labels = () => void D.refreshOperatorLabels().then((changed) => {
      if (changed && !document.querySelector('dialog[open]') &&
          (routes.has(routeNow()) || routeNow().startsWith('orders/'))) A.render();
    });
    window.addEventListener('DOMContentLoaded', labels, { once: true });
    window.addEventListener('focus', labels);
    window.addEventListener('hashchange', labels);
  }
  window.IDDesignModules.push({
    id: 'order-operations', matches: (route) => routes.has(route), render, onClick, onSubmit, preserveDraft, onInput: onCodeFilter, onChange: onCodeFilter,
    onDataChanges(scopes) {
      if (routes.has(routeNow()) && scopes.some(scope => ['commerce', 'recharge-codes', 'operators'].includes(scope)))
        return load(routeNow(), true);
    },
    afterRender({ routeChanged } = {}) {
      if (D?.authRequired) void load(routeNow(), Boolean(routeChanged));
    }
  });
})();
