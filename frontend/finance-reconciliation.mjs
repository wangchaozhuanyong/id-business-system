export function createPage(A, definition) {
  const D = window.IDLocalData;
  const defaults = () => ({ page: 1, from: '', to: '' });
  let draft = defaults(), applied, active;

  const note = ({ from, to }) => from && to ? from + ' 至 ' + to :
    from ? from + ' 起' : to ? '截至 ' + to : '全部日期';
  const statuses = { success: '成功', failed: '失败', pending: '待确认' };
  const plans = { plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' };
  const clock = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23'
  });
  const date = value => Number.isFinite(Date.parse(value)) ? clock.format(new Date(value)) : '—';
  const render = () => A.header(definition.label, definition.description) +
    '<section class="panel design-async-region staff-workspace" data-finance-reconciliation>' +
    '<div class="toolbar"><div class="toolbar-right">' + A.button('刷新', 'billing-refresh') + '</div></div>' +
    '<div class="panel-body"><form class="form-section" data-billing-filter>' +
    '<div class="form-grid">' +
    A.field('开始日期', 'staff-from', A.input('staff-from', draft.from, 'type="date"')) +
    A.field('结束日期', 'staff-to', A.input('staff-to', draft.to, 'type="date"')) +
    '</div><div class="form-footer"><button type="submit" class="button primary">按日期查看</button></div></form>' +
    '<p data-billing-progress role="status" hidden></p><p data-billing-error role="status" hidden></p>' +
    '<div data-billing-result></div></div></section>';

  function showResult(view) {
    const target = view.region.querySelector('[data-billing-result]');
    if (!applied) {
      target.replaceChildren();
      return;
    }
    const { query, result } = applied;
    const columns = [
      { id: 'reference', label: '账单编号' },
      { id: 'time', label: '扣款时间', render: row => A.esc(date(row.time)) },
      { id: 'last4', label: '卡尾号' },
      { id: 'plan', label: '套餐', render: row => A.esc(plans[row.plan] || '—') },
      { id: 'amount', label: '原币金额' },
      { id: 'currency', label: '币种' },
      { id: 'status', label: '扣款状态', render: row => A.esc(statuses[row.status] || row.status || '—') }
    ];
    target.innerHTML = '<p class="inline-notice">账单日期 ' + A.esc(note(query)) + '</p>' +
      (result.items.length ? A.table(columns, result.items, '', '代充对账记录') : A.empty('暂无记录', '可调整日期后重新查询。')) +
      '<div class="toolbar"><div class="toolbar-left">' +
      A.button('上一页', 'billing-prev', '', '', query.page <= 1 ? 'disabled' : '') +
      '<span>第 ' + query.page + ' 页</span>' +
      A.button('下一页', 'billing-next', '', '', result.hasMore && query.page < 5000 ? '' : 'disabled') +
      '</div><div class="toolbar-right"><a class="button" href="#/orders/statistics">查看订单统计</a></div></div>';
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
      form.addEventListener('input', () => {
        draft = { page: 1, from: form.elements['staff-from'].value, to: form.elements['staff-to'].value };
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        draft = { page: 1, from: form.elements['staff-from'].value, to: form.elements['staff-to'].value };
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
      if (!active || !['billing-prev', 'billing-next', 'billing-refresh'].includes(action)) return false;
      if (!active.region.contains(node)) return false;
      if (action === 'billing-refresh') void read(active, active.requested || active.failed || applied?.query || defaults(), true);
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
    }
  };
}
