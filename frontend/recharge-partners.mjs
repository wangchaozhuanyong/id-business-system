export function createPage(A, definition) {
  const D = window.IDLocalData;
  const e = A.esc;
  const pageId = definition.id;
  const planNames = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200' };
  const defaults = () => ({ name: '', partnerId: '', plan: 'plus', count: '1', page: 1 });
  const operations = new Map();
  let active, data, draft = defaults();
  let busy = false;

  function render() {
    return `<section class="panel" data-partner-page>
      <div class="panel-heading">
        <div class="section-title-row"><h2>${e(definition.label)}</h2>${A.titleInfo(definition.label, definition.description, pageId + '-help')}</div>
        ${A.button('刷新', 'recharge-partner-refresh', '', 'return')}
      </div>
      <p class="finance-feedback" data-partner-progress role="status" hidden></p>
      <p class="finance-feedback field-error" data-partner-error role="alert" hidden></p>
      <div data-partner-content hidden>
        <div class="toolbar"><span data-partner-endpoint></span> ${A.button('复制 API 地址', 'recharge-partner-endpoint')}</div>
        <form data-partner-form="create" class="toolbar toolbar--inline">
          <div class="toolbar-left"><label for="recharge-partner-name">合作方名称</label>
            <input id="recharge-partner-name" name="name" maxlength="80" required value="${e(draft.name)}"></div>
          <div class="toolbar-right"><button class="btn primary" type="submit">创建合作方</button></div>
        </form>
        <div data-partner-secret hidden>
          <p>API 密钥仅显示一次，请复制给该合作方。</p>
          <input aria-label="API 密钥" type="password" autocomplete="off" data-no-draft readonly>
          ${A.button('复制接入资料', 'recharge-partner-secret')} ${A.button('关闭', 'recharge-partner-close')}
        </div>
        <form data-partner-form="issue" class="toolbar toolbar--inline">
          <div class="toolbar-left">
            <label for="recharge-partner-recipient">合作方</label><select id="recharge-partner-recipient" name="partnerId" required></select>
            <label for="recharge-partner-plan">套餐</label><select id="recharge-partner-plan" name="plan">${Object.entries(planNames)
              .map(([id, label]) => `<option value="${id}" ${id === draft.plan ? 'selected' : ''}>${label}</option>`).join('')}</select>
            <label for="recharge-partner-quantity">数量</label><input id="recharge-partner-quantity" name="count" type="number"
              min="1" max="100" required value="${e(draft.count)}">
          </div>
          <div class="toolbar-right"><button class="btn" type="submit">发放兑换码</button></div>
        </form>
        <div data-partner-list></div>
        <h3>发码批次</h3><div data-partner-batches></div>
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
    view.host.querySelector('[data-partner-endpoint]').textContent = data.apiBase;
    const select = view.host.querySelector('[name="partnerId"]');
    const enabled = data.partners.filter(row => !row.disabledAt);
    select.innerHTML = '<option value="">请选择</option>' + enabled.map(row =>
      `<option value="${e(row.id)}">${e(row.name)}</option>`).join('');
    select.value = draft.partnerId;
    if (!select.value && draft.partnerId) draft.partnerId = '';
    view.host.querySelector('[data-partner-list]').innerHTML = A.table([
      { id: 'name', label: '合作方', mobileSummary: true, long: true },
      { id: 'id', label: '合作方编号', long: true },
      { id: 'state', label: '凭证状态', mobileSummary: true, render: row => row.disabledAt ? '已停用' : '已启用' },
      { id: 'actions', label: '操作', action: true, render: row => !row.disabledAt ?
        A.button('停用', 'recharge-partner-disable', '', '', `data-partner-id="${e(row.id)}"`) : '' }
    ], data.partners, '', '充值 API 合作方', { title: '暂无合作方' });
    view.host.querySelector('[data-partner-batches]').innerHTML = A.table([
      { id: 'batchNo', label: '发码批次', mobileSummary: true },
      { id: 'partnerId', label: '合作方', render: row =>
        e(data.partners.find(partner => partner.id === row.partnerId)?.name || row.partnerId) },
      { id: 'plan', label: '套餐', render: row => e(planNames[row.plan] || row.plan) },
      { id: 'count', label: '数量', render: row => String(row.codes.length) },
      { id: 'actions', label: '操作', action: true, render: row =>
        A.button('复制兑换码', 'recharge-partner-codes', '', '', `data-batch-id="${e(row.id)}"`) }
    ], data.batches, '', '合作方发码记录', { title: '暂无发码批次' }) +
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
      show(view);
      return true;
    } catch (failure) {
      if (active !== view || !progress.current()) return true;
      if ([401, 403, 404].includes(failure.status)) {
        data = undefined;
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

  function setBusy(view, value) {
    for (const control of view.host.querySelectorAll('form :is(input, select, button), [data-action="recharge-partner-disable"]'))
      control.disabled = value;
  }

  async function save(view, command) {
    if (busy) return;
    const fingerprint = JSON.stringify(command);
    if (!operations.has(fingerprint)) operations.set(fingerprint, crypto.randomUUID());
    busy = true;
    setBusy(view, true);
    feedback(view, '');
    try {
      const result = await D.rechargePartnerAction({ ...command, operationId: operations.get(fingerprint) });
      operations.delete(fingerprint);
      if (active !== view) return;
      if (command.action === 'create') {
        view.host.querySelector('[name="name"]').value = draft.name = '';
        if (result.apiKey) {
          const reveal = view.host.querySelector('[data-partner-secret]');
          reveal.querySelector('input').value = result.apiKey;
          view.secretPartner = result.partner.id;
          reveal.hidden = false;
          draft.partnerId = result.partner.id;
        } else {
          feedback(view, '合作方已创建。若尚未复制密钥，可停用该凭证后重新创建。');
        }
      }
      if (command.action === 'issue') draft.page = 1;
      await read(view, true);
    } catch (failure) {
      if (active === view) feedback(view, failure.message || '操作结果暂未确认，请刷新核对。');
    } finally {
      busy = false;
      if (active) setBusy(active, false);
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
        const preserve = () => Object.assign(draft, Object.fromEntries(new FormData(form)));
        form.addEventListener('input', preserve);
        form.addEventListener('change', preserve);
        form.addEventListener('submit', event => {
          event.preventDefault();
          event.stopPropagation();
          preserve();
          const action = form.dataset.partnerForm;
          const input = action === 'create' ? { name: draft.name.trim() }
            : { partnerId: draft.partnerId, plan: draft.plan, count: Number(draft.count) };
          void save(view, { action, ...input });
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
      active = data = undefined;
      draft = defaults();
      operations.clear();
      A.table([], [], '', '充值 API 合作方');
      A.table([], [], '', '合作方发码记录');
    }
  };
}
