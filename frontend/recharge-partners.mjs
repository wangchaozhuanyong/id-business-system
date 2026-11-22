export function createPage(A, definition) {
  const D = window.IDLocalData;
  const canKeepIssueReceipt = typeof D?.pendingWriteReceipt === 'function' &&
    typeof D.rememberWriteReceipt === 'function' && typeof D.forgetWriteReceipt === 'function';
  const e = A.esc;
  const pageId = definition.id;
  const planNames = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const defaults = () => ({ name: '', partnerId: '', plan: 'plus', count: '1', page: 1 });
  const operations = new Map();
  let active, data, issueReceipt, draft = defaults();
  const issueCommand = () => ({ action: 'issue', partnerId: draft.partnerId, plan: draft.plan, count: Number(draft.count) });
  const requiresNewIssue = () => issueReceipt?.protect && issueReceipt.fingerprint === JSON.stringify(issueCommand());
  const issueAttempt = ({ partnerId, plan, count }) => 'recharge-issue:' + JSON.stringify([partnerId, plan, count]);
  let busy = false, identityGeneration = 0;

  function render() {
    return `<section class="panel recharge-partner-page" data-partner-page>
      <div class="panel-heading">
        <div class="section-title-row"><h2>${e(definition.label)}</h2>${A.titleInfo(definition.label, definition.description, pageId + '-help')}</div>
        ${A.button('刷新', 'recharge-partner-refresh', '', 'return')}
      </div>
      <p class="finance-feedback" data-partner-progress role="status" hidden></p>
      <p class="finance-feedback field-error" data-partner-error role="alert" hidden></p>
      <div data-partner-content hidden>
        <div class="toolbar recharge-partner-setup">
          <div class="recharge-partner-endpoint">
            <label for="recharge-partner-endpoint">API 地址</label>
            <input id="recharge-partner-endpoint" data-partner-endpoint readonly>
            ${A.button('复制 API 地址', 'recharge-partner-endpoint')}
          </div>
          <form data-partner-form="create" class="recharge-partner-create">
            <label for="recharge-partner-name">合作方名称</label>
            <input id="recharge-partner-name" name="name" maxlength="80" required placeholder="输入合作方名称" value="${e(draft.name)}">
            <button class="button primary" type="submit">创建合作方</button>
          </form>
        </div>
        <div class="panel-body recharge-partner-secret" data-partner-secret hidden>
          <p>API 密钥仅显示一次，请复制给该合作方。</p>
          <input aria-label="API 密钥" type="password" autocomplete="off" data-no-draft readonly>
          ${A.button('复制接入资料', 'recharge-partner-secret')} ${A.button('关闭', 'recharge-partner-close')}
        </div>
        <form data-partner-form="issue" class="toolbar recharge-partner-issue">
          <div class="recharge-partner-field recharge-partner-recipient">
            <label for="recharge-partner-recipient">合作方</label>
            <select id="recharge-partner-recipient" name="partnerId" required></select>
          </div>
          <div class="recharge-partner-field">
            <label for="recharge-partner-plan">套餐</label>
            <select id="recharge-partner-plan" name="plan">${Object.entries(planNames)
              .map(([id, label]) => `<option value="${id}" ${id === draft.plan ? 'selected' : ''}>${label}</option>`).join('')}</select>
          </div>
          <div class="recharge-partner-field recharge-partner-quantity">
            <label for="recharge-partner-quantity">数量</label>
            <input id="recharge-partner-quantity" name="count" type="number" min="1" max="100" required value="${e(draft.count)}">
          </div>
          <button class="button primary" type="submit">发放兑换码</button>
        </form>
        <div class="panel-body" data-partner-issue-receipt hidden>
          <p role="status" data-partner-issue-status></p>
          ${A.button('准备发放下一批', 'recharge-partner-next-issue')}
        </div>
        <div class="recharge-partner-records">
          <section class="recharge-partner-section" aria-labelledby="recharge-partner-list-title">
            <div class="panel-heading"><h3 id="recharge-partner-list-title">合作方列表</h3></div>
            <div data-partner-list></div>
          </section>
          <section class="recharge-partner-section" aria-labelledby="recharge-partner-batches-title">
            <div class="panel-heading"><h3 id="recharge-partner-batches-title">发码批次</h3></div>
            <div data-partner-batches></div>
          </section>
        </div>
      </div>
    </section>`;
  }

  function feedback(view, message) {
    const node = view.host.querySelector('[data-partner-error]');
    node.textContent = message;
    node.hidden = !message;
  }

  function show(view) {
    const content = view.host.querySelector('[data-partner-content]');
    content.hidden = !data;
    if (!data) return;
    view.host.querySelector('[data-partner-endpoint]').value = data.apiBase;
    const select = view.host.querySelector('[name="partnerId"]');
    const enabled = data.partners.filter(row => !row.disabledAt);
    select.innerHTML = '<option value="">请选择</option>' + enabled.map(row =>
      `<option value="${e(row.id)}">${e(row.name)}</option>`).join('');
    select.value = draft.partnerId;
    if (!select.value && draft.partnerId) draft.partnerId = '';
    showIssueReceipt(view);
    view.host.querySelector('[data-partner-list]').innerHTML = A.table([
      { id: 'name', label: '合作方', class: 'recharge-partner-name-cell', mobileSummary: true, long: true },
      { id: 'id', label: '合作方编号', class: 'recharge-partner-id-cell', long: true, render: row => `<span class="mono">${e(row.id)}</span>` },
      { id: 'state', label: '凭证状态', mobileSummary: true, render: row =>
        `<span class="tag${row.disabledAt ? '' : ' success'}">${row.disabledAt ? '已停用' : '已启用'}</span>` },
      { id: 'actions', label: '操作', action: true, render: row => {
        const attrs = `data-partner-id="${e(row.id)}"`;
        return A.button(row.disabledAt ? '换钥后启用' : '更换密钥', 'recharge-partner-rotate', '', '', attrs) +
          (row.disabledAt ? '' : A.button('停用', 'recharge-partner-disable', '', '', attrs));
      } }
    ], data.partners, '', '充值 API 合作方', { title: '暂无合作方', description: '在上方填写名称，创建第一个合作方。' });
    const partnerNames = new Map(data.partners.map(row => [row.id, row.name]));
    const batches = data.batches.map(row => ({ ...row, partnerName: partnerNames.get(row.partnerId) || row.partnerId }));
    view.host.querySelector('[data-partner-batches]').innerHTML = A.table([
      { id: 'batchNo', label: '发码批次' },
      { id: 'partnerName', label: '合作方', long: true, mobileSummary: true },
      { id: 'plan', label: '套餐', render: row => e(planNames[row.plan] || row.plan) },
      { id: 'count', label: '数量', mobileSummary: true, render: row => String(row.codes.length) },
      { id: 'actions', label: '操作', action: true, render: row =>
        A.button('复制兑换码', 'recharge-partner-codes', '', '', `data-batch-id="${e(row.id)}"`) }
    ], batches, '', '合作方发码记录', { title: '暂无发码批次', description: '选择合作方、套餐和数量，发放后将在这里显示记录。' }) +
      (data.pages > 1 ? '<nav class="toolbar toolbar--inline" aria-label="发码批次分页" data-pagination-footer>' +
        '<div class="toolbar-left">第 ' + e(data.page) + ' / ' + e(data.pages) + ' 页</div><div class="toolbar-right">' +
        A.button('上一页', 'recharge-partner-previous', '', '', data.page === 1 ? 'disabled' : '') +
        A.button('下一页', 'recharge-partner-next', '', '', data.page >= data.pages ? 'disabled' : '') + '</div></nav>' : '');
  }

  async function read(view, refresh = false) {
    const page = draft.page;
    const progress = A.beginRegionRead(view.host, view.host.querySelector('[data-partner-progress]'), {
      loadingText: '正在读取合作方…', refreshButton: view.host.querySelector('[data-action="recharge-partner-refresh"]')
    });
    try {
      const value = await D.queries.read(definition.scope, { page }, () => D.load(definition.resource + '?page=' + page), { refresh });
      if (active !== view || !progress.current()) return true;
      data = value;
      draft.page = value.page;
      if (issueReceipt?.protect && value.batches.some(batch => batch.id === issueReceipt.id)) {
        D.forgetWriteReceipt(issueReceipt.attempt, issueReceipt.operationId);
        issueReceipt.protect = false;
      }
      show(view);
      return true;
    } catch (failure) {
      if (active !== view || !progress.current()) return true;
      if ([401, 403, 404].includes(failure.status)) {
        data = issueReceipt = undefined;
        clearSecret(view);
        show(view);
      }
      feedback(view, failure.message || '合作方暂时无法读取，请刷新重试。');
      return false;
    } finally {
      progress.finish();
    }
  }

  function clearSecret(view) {
    const reveal = view.host.querySelector('[data-partner-secret]');
    reveal.querySelector('input').value = '';
    reveal.hidden = true;
    view.secretPartner = undefined;
  }

  function showIssueReceipt(view) {
    const receipt = view.host.querySelector('[data-partner-issue-receipt]');
    const pending = canKeepIssueReceipt && D.pendingWriteReceipt(issueAttempt(issueCommand()));
    const awaitingReceipt = pending && pending !== issueReceipt?.operationId;
    receipt.hidden = !issueReceipt && !awaitingReceipt;
    receipt.querySelector('[data-partner-issue-status]').textContent = awaitingReceipt
      ? '上次发码结果待核对。按相同条件提交会使用原编号核对回执。'
      : !issueReceipt ? '' : issueReceipt.batchNo
      ? '已发放批次 ' + issueReceipt.batchNo + '，共 ' + issueReceipt.count + ' 个兑换码。'
      : '已发放 ' + issueReceipt.count + ' 个兑换码，批次编号待核对。';
    receipt.querySelector('[data-action="recharge-partner-next-issue"]').hidden = !requiresNewIssue();
    setBusy(view, busy);
  }

  function setBusy(view, value) {
    for (const control of view.host.querySelectorAll('form :is(input, select, button), [data-action="recharge-partner-disable"], [data-action="recharge-partner-rotate"]'))
      control.disabled = value;
    view.host.querySelector('[data-partner-form="issue"] button[type="submit"]').disabled = value || Boolean(requiresNewIssue());
    view.host.querySelector('[data-action="recharge-partner-next-issue"]').disabled = value;
  }

  async function save(view, command) {
    const issuing = command.action === 'issue';
    if (busy || issuing && requiresNewIssue()) return;
    if (issuing && !canKeepIssueReceipt) {
      feedback(view, '页面资源已更新，请整页刷新后再发码。');
      return;
    }
    const actorId = D.actor()?.id;
    if (!actorId) return;
    const generation = identityGeneration;
    const fingerprint = JSON.stringify(command);
    const attempt = issuing ? issueAttempt(command) : null;
    const previous = issuing ? D.pendingWriteReceipt(attempt) : operations.get(fingerprint);
    const operationId = previous || crypto.randomUUID();
    if (issuing) {
      if (!previous && !D.rememberWriteReceipt(attempt, operationId)) {
        feedback(view, '无法保留发码编号。请允许此站点使用会话存储后再提交。');
        return;
      }
    } else operations.set(fingerprint, operationId);
    busy = true;
    setBusy(view, true);
    feedback(view, '');
    const current = () => generation === identityGeneration && actorId === D.actor()?.id;
    try {
      const result = await D.rechargePartnerAction({ ...command, operationId });
      if (!current()) return;
      if (issuing) {
        const batch = result.batch;
        if (!batch?.id || batch.partnerId !== command.partnerId || batch.plan !== command.plan ||
            batch.codes?.length !== command.count)
          throw new Error('发码结果暂未确认。请刷新核对原批次。');
        issueReceipt = { id: batch.id, batchNo: batch.batchNo, count: batch.codes.length,
          attempt, operationId, fingerprint, protect: true };
        draft.page = 1;
        if (active) showIssueReceipt(active);
      } else operations.delete(fingerprint);
      if (active !== view) return;
      if (command.action === 'create' || command.action === 'rotate') {
        if (command.action === 'create') view.host.querySelector('[name="name"]').value = draft.name = '';
        if (result.apiKey) {
          const reveal = view.host.querySelector('[data-partner-secret]');
          reveal.querySelector('input').value = result.apiKey;
          view.secretPartner = result.partner.id;
          reveal.hidden = false;
          draft.partnerId = result.partner.id;
        } else {
          feedback(view, '操作已保存。若未收到密钥，请刷新后使用「更换密钥」。');
        }
      }
      await read(view, true);
    } catch (failure) {
      if (!current()) return;
      if (issuing && !previous && failure.status === 400) D.forgetWriteReceipt(attempt, operationId);
      if (active === view) {
        const unknown = issuing && (!failure.status || failure.status === 408 || failure.status >= 500);
        feedback(view, unknown ? '发码结果暂未确认，请按相同条件核对原批次。'
          : failure.message || '操作结果暂未确认，请刷新核对。');
      }
    } finally {
      if (current()) {
        busy = false;
        if (active) showIssueReceipt(active);
      }
    }
  }

  return {
    render,
    afterRender() {
      const host = A.activePageRegion().querySelector('[data-partner-page]');
      if (!host) return;
      const view = { host };
      active = view;
      for (const form of host.querySelectorAll('form')) {
        const preserve = () => {
          Object.assign(draft, Object.fromEntries(new FormData(form)));
          if (form.dataset.partnerForm === 'issue') showIssueReceipt(view);
        };
        form.addEventListener('input', preserve);
        form.addEventListener('change', preserve);
        form.addEventListener('submit', event => {
          event.preventDefault();
          event.stopPropagation();
          preserve();
          const action = form.dataset.partnerForm;
          void save(view, action === 'create' ? { action, name: draft.name.trim() } : issueCommand());
        });
      }
      show(view);
      setBusy(view, busy);
      void read(view);
    },
    onClick(action, node) {
      const view = active;
      if (!view?.host.contains(node) || !action.startsWith('recharge-partner-')) return false;
      if (action === 'recharge-partner-refresh') { feedback(view, ''); void read(view, true); }
      else if (action === 'recharge-partner-next-issue') {
        if (issueReceipt && !busy) {
          D.forgetWriteReceipt(issueReceipt.attempt, issueReceipt.operationId);
          issueReceipt.protect = false;
          showIssueReceipt(view);
          view.host.querySelector('[data-partner-form="issue"] button[type="submit"]').focus();
        }
      }
      else if (action === 'recharge-partner-previous' || action === 'recharge-partner-next') {
        draft.page = data.page + (action === 'recharge-partner-next' ? 1 : -1);
        void read(view);
      }
      else if (action === 'recharge-partner-close') clearSecret(view);
      else if (action === 'recharge-partner-endpoint') void A.copyText(data.apiBase);
      else if (action === 'recharge-partner-secret') {
        const apiKey = view.host.querySelector('[data-partner-secret] input').value;
        if (apiKey) void A.copyText(`API 地址 ${data.apiBase}\n合作方编号 ${view.secretPartner}\nAPI 密钥 ${apiKey}`);
      } else if (action === 'recharge-partner-codes') {
        const batch = data.batches.find(row => row.id === node.dataset.batchId);
        if (batch) void A.copyText(batch.codes.join('\n'));
      } else if (action === 'recharge-partner-rotate') {
        const partner = data.partners.find(row => row.id === node.dataset.partnerId);
        const verb = partner?.disabledAt ? '重新启用并换发' : '更换';
        if (partner && window.confirm(`确认${verb} ${partner.name} 的 API 密钥？旧密钥将失效，已发兑换码和历史任务仍归此合作方。`)) {
          clearSecret(view);
          void save(view, { action: 'rotate', partnerId: partner.id });
        }
      } else if (action === 'recharge-partner-disable') {
        const partner = data.partners.find(row => row.id === node.dataset.partnerId);
        if (partner && window.confirm(`停用 ${partner.name} 的 API 凭证？已受理的任务会继续处理。`)) {
          if (view.secretPartner === partner.id) clearSecret(view);
          void save(view, { action: 'disable', partnerId: partner.id });
        }
      }
      return true;
    },
    onDataChanges(scopes) {
      if (active && scopes.includes(definition.scope)) return read(active, true);
    },
    deactivate(region) {
      if (!active || !region.contains(active.host)) return;
      clearSecret(active);
      A.finishRegionRead(active.host);
      active = undefined;
    },
    clearPageState() {
      if (active) clearSecret(active);
      identityGeneration++;
      busy = false;
      active = data = issueReceipt = undefined;
      draft = defaults();
      operations.clear();
      A.table([], [], '', '充值 API 合作方');
      A.table([], [], '', '合作方发码记录');
    }
  };
}
