export function createPage(A, definition) {
  const D = window.IDLocalData;
  const tableId = '代充对账记录';
  const defaults = () => ({ page: 1, from: '', to: '', last4: '', plan: '', status: '' });
  let draft = defaults(), applied, active;

  const note = ({ from, to }) => from && to ? from + ' 至 ' + to :
    from ? from + ' 起' : to ? '截至 ' + to : '全部日期';
  const statuses = { success: '扣款成功', failed: '扣款失败', pending: '待确认' };
  const statusKinds = { success: 'success', failed: 'danger', pending: 'warning' };
  const plans = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const cardTypeStates = { unassigned: '未设置', unmatched: '未匹配', ambiguous: '分类待核对',
    unavailable: '暂未读取', 'missing-number': '卡号未留存', conflict: '卡号待核对' };
  const filters = form => ({ page: 1, from: form.elements['staff-from'].value,
    to: form.elements['staff-to'].value, last4: form.elements['billing-last4'].value.trim(),
    plan: form.elements['billing-plan'].value, status: form.elements['billing-status'].value });
  const copyValue = (value, field, index, label) => `<button type="button" class="finance-copy-value"
    data-action="billing-copy" data-field="${field}" data-index="${index}" aria-label="复制${label}"><span>${A.esc(value)}</span>${A.icon('copy')}</button>`;
  const clock = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'
  });
  const date = value => Number.isFinite(Date.parse(value)) ? clock.format(new Date(value)) : '—';
  const render = () => A.header(definition.label, definition.description) +
    '<section class="panel design-async-region finance-workspace" data-finance-reconciliation>' +
    '<form class="toolbar toolbar--inline finance-toolbar finance-date-filter" data-billing-filter><div class="toolbar-left">' +
    A.field('开始日期', 'staff-from', A.input('staff-from', draft.from, 'type="date"')) +
    A.field('结束日期', 'staff-to', A.input('staff-to', draft.to, 'type="date"')) +
    A.field('卡号后四位', 'billing-last4', A.input('billing-last4', draft.last4,
      'inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="全部银行卡"')) +
    A.field('套餐', 'billing-plan', A.select('billing-plan', [['', '全部套餐'], ...Object.entries(plans)], draft.plan)) +
    A.field('扣款状态', 'billing-status', A.select('billing-status', [['', '全部状态'], ...Object.entries(statuses)], draft.status)) +
    '</div><div class="toolbar-right"><button type="submit" class="button primary">查询账单</button>' + A.button('刷新', 'billing-refresh') +
    '<a class="button" href="#/orders/statistics">查看订单统计</a></div></form>' +
    '<p class="finance-feedback" data-billing-progress role="status" hidden></p>' +
    '<p class="finance-feedback field-error" data-billing-error role="alert" hidden></p>' +
    '<div data-billing-result></div></section>';

  function showResult(view) {
    const target = view.region.querySelector('[data-billing-result]');
    if (!applied) {
      // Drop full-content drawer records when access is lost as well as visible rows.
      A.table([], [], '', tableId);
      target.replaceChildren();
      return;
    }
    const { query, result } = applied;
    const rows = result.items.map((row, index) => ({ ...row, id: `${query.page}:${index}`, index }));
    const columns = [
      { id: 'reference', label: '账单编号' },
      { id: 'time', label: '扣款时间（北京）', render: row => A.esc(date(row.time)) },
      { id: 'cardType', label: '卡类型', long: true,
        headerHelp: '按账单完整卡号匹配当前银行卡分类；历史卡使用已有留存资料。未匹配或分类冲突会单独标注，不按尾号猜配。',
        render: row => A.esc(row.cardType || cardTypeStates[row.cardTypeState] || '未匹配') },
      { id: 'cardNumber', label: '完整卡号', mobileSummary: true, class: 'finance-card-number',
        render: row => row.cardNumber ? copyValue(row.cardNumber, 'cardNumber', row.index, '完整卡号') :
          `<span class="finance-muted">未留存${row.last4 ? '（尾号 ' + A.esc(row.last4) + '）' : '完整卡号'}</span>` },
      { id: 'email', label: '充值邮箱', long: true, render: row => A.esc(row.email || '未留存邮箱') },
      { id: 'plan', label: '套餐', render: row => A.esc(plans[row.plan] || '—') },
      { id: 'amount', label: '原币金额', mobileSummary: true, class: 'finance-amount', render: row =>
        `<span>${A.esc(row.amount === '' ? '—' : row.amount ?? '—')}</span> <span class="finance-muted">${A.esc(row.currency || '')}</span>` },
      { id: 'status', label: '扣款状态', mobileSummary: true,
        render: row => A.tag(statuses[row.status] || row.status || '—', statusKinds[row.status] || '') },
      { id: 'paymentReference', label: '支付单号', long: true,
        headerHelp: 'Stripe 支付会话编号，用于区分和定位支付尝试；不是银行流水号。',
        render: row => A.esc(row.paymentReference || '未留存') },
      { id: 'errorCode', label: '失败代码', long: true, render: row => A.esc(row.errorCode || '—') }
    ];
    target.innerHTML = (result.warning ? '<p class="finance-feedback inline-notice warning" role="status">' + A.esc(result.warning) + '</p>' : '') +
      '<div class="finance-list-meta"><span>账单日期 ' + A.esc(note(query)) + '</span>' +
      '<span class="finance-muted">北京时间</span>' +
      (query.last4 ? '<span>卡号后四位 ' + A.esc(query.last4) + '</span>' : '') +
      (query.plan ? '<span>' + A.esc(plans[query.plan]) + '</span>' : '') +
      (query.status ? '<span>' + A.esc(statuses[query.status]) + '</span>' : '') + '</div>' +
      A.table(columns, rows, '', tableId, { title: '暂无扣款记录', description: '可调整日期、卡号后四位、套餐或状态后重新查询。' }) +
      '<nav class="toolbar toolbar--inline finance-pagination" aria-label="对账记录分页" data-pagination-footer><div class="toolbar-left">' +
      '<span class="finance-muted">' + (Number.isSafeInteger(result.total) ? '共 ' + result.total + ' 笔 · ' : '') +
      '本页 ' + result.items.length + ' 笔</span></div><div class="toolbar-right">' +
      A.button('上一页', 'billing-prev', '', '', query.page <= 1 ? 'disabled' : '') +
      '<span aria-live="polite">第 ' + query.page + ' 页</span>' +
      A.button('下一页', 'billing-next', '', '', result.hasMore && query.page < 5000 ? '' : 'disabled') +
      '</div></nav>';
  }

  async function read(view, query, refresh = false) {
    const error = view.region.querySelector('[data-billing-error]');
    error.hidden = true;
    const progress = A.beginRegionRead(view.region, view.region.querySelector('[data-billing-progress]'),
      { loadingText: applied ? '' : '正在读取对账记录…', refreshButton: view.region.querySelector('[data-action="billing-refresh"]') });
    view.requested = query;
    const current = () => active === view && progress.current();
    try {
      const result = await D.queries.read(definition.scope, query,
        () => D.load(definition.resource + '?' + new URLSearchParams(query)), { refresh });
      if (!current()) return true;
      if (!Array.isArray(result?.items) || typeof result.hasMore !== 'boolean') throw new Error('暂时无法读取对账记录');
      applied = { query, result };
      view.failed = undefined;
      showResult(view);
      return true;
    } catch (failure) {
      if (!current()) return true;
      if (failure.code === 'READ_SUPERSEDED') return false;
      view.failed = query;
      if ([401, 403].includes(failure.status)) {
        applied = undefined;
        showResult(view);
      }
      error.textContent = applied ? '暂时无法读取。这里显示的是上次取得的账单。' :
        failure.message || '暂时无法读取对账记录，请刷新重试。';
      error.hidden = false;
      return false;
    } finally {
      if (current()) view.requested = undefined;
      progress.finish();
    }
  }

  return {
    render,
    afterRender() {
      const region = A.activePageRegion().querySelector('[data-finance-reconciliation]');
      if (!region) return;
      const view = { region };
      active = view;
      const form = region.querySelector('[data-billing-filter]');
      const keepFilters = () => { draft = filters(form); };
      form.addEventListener('input', keepFilters);
      form.addEventListener('change', keepFilters);
      form.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        draft = filters(form);
        if (draft.from && draft.to && draft.from > draft.to) {
          const error = region.querySelector('[data-billing-error]');
          error.textContent = '开始日期不能晚于结束日期。';
          error.hidden = false;
          return;
        }
        void read(view, draft, true);
      });
      showResult(view);
      void read(view, applied?.query || defaults());
    },
    onClick(action, node) {
      if (!active || !['billing-prev', 'billing-next', 'billing-refresh', 'billing-copy'].includes(action)) return false;
      if (!active.region.contains(node)) return false;
      if (action === 'billing-copy') {
        const value = node.dataset.field === 'cardNumber' && applied?.result.items[Number(node.dataset.index)]?.cardNumber;
        if (value) void A.copyText(value);
      } else if (action === 'billing-refresh') void read(active, active.requested || active.failed || applied?.query || defaults(), true);
      else if (applied) {
        if (action === 'billing-next' && (!applied.result.hasMore || applied.query.page >= 5000) ||
            action === 'billing-prev' && applied.query.page <= 1) return true;
        const page = applied.query.page + (action === 'billing-prev' ? -1 : 1);
        void read(active, { ...applied.query, page });
      }
      return true;
    },
    onDataChanges(scopes) {
      if (active && scopes.includes(definition.scope))
        return read(active, active.requested || applied?.query || defaults(), true);
    },
    deactivate(region) {
      if (active && region.contains(active.region)) {
        A.finishRegionRead(active.region);
        active = undefined;
      }
    },
    clearPageState() {
      active = applied = undefined;
      draft = defaults();
      A.table([], [], '', tableId);
    }
  };
}
