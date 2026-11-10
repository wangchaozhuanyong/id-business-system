(() => {
  'use strict';

  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const { $, esc, button, textAction } = A;
  const title = '员工数据统计';
  const route = 'data-management/employee-statistics';
  const draftKey = 'employee-statistics:filters';
  const detailPager = 'employee-statistics-detail';
  const scopes = ['commerce', 'inventory', 'recharge-codes', 'operators'];
  const categoryLabels = { order: '订单', customer: '客户', code: '充值码', mail: '邮箱', account: '账号' };
  const workMetrics = [
    ['orders', '提交订单', 'order'], ['cancelledOrders', '其中已撤单', 'order'],
    ['syncedOrders', '自动同步订单', 'order'], ['issuedCodes', '领取充值码', 'code'],
    ['extractedAccounts', '提取账号', 'account'], ['extractedMail', '提取邮箱', 'mail'],
    ['customers', '客户录入', 'customer'], ['submittedMail', '邮箱提交', 'mail'],
    ['submittedAccounts', '账号提交', 'account'], ['used', '已使用', 'assets'],
    ['returned', '已归还', 'assets'], ['undated', '时间待核对']
  ];
  const pendingMetrics = [
    ['unusedCodes', '未用未还充值码', 'code'], ['deliveredCodes', '已交付待兑换', 'code'],
    ['processingCodes', '充值码使用中', 'code'], ['returningCodes', '归还待核对', 'code'],
    ['pendingCodeRequests', '申领待完成', 'code'], ['openMail', '未结邮箱', 'mail'],
    ['openAccounts', '未结账号', 'account'], ['overdue', '超 24 小时未处理'],
    ['review', '状态待核对']
  ];
  const detailColumns = [
    { id: 'kind', label: '类型', render: row => esc(categoryLabels[row.kind] || '资料') },
    { id: 'reference', label: '编号' }, { id: 'subject', label: '脱敏标识' },
    { id: 'batch', label: '批次' }, { id: 'related', label: '关联订单或任务' },
    { id: 'purpose', label: '用途或套餐' },
    { id: 'at', label: '记录时间', render: row => esc(displayTime(row.at)) },
    { id: 'status', label: '状态' }
  ];
  const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const timeFormat = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'
  });
  let report, failure, detail, latestLoad;
  const active = () => A.state.route === route && D?.authRequired &&
    ['admin', 'super'].includes(D.actor()?.role);
  const exceptions = row => (row.counts.overdue || 0) + (row.counts.review || 0) + (row.counts.returningCodes || 0);
  const displayTime = value => value && Number.isFinite(Date.parse(value)) ? timeFormat.format(Date.parse(value)) : '待核对';

  function filters() {
    if (!A.state.drafts.has(draftKey))
      A.state.drafts.set(draftKey, { tab: 'work', date: '', employee: '', work: 'all', pending: 'all', exceptions: false });
    return A.state.drafts.get(draftKey);
  }

  function parameters() {
    const { tab, date, ...values } = filters();
    return { kind: values[tab], ...(tab === 'work' && date ? { date } : {}) };
  }

  function viewKey() {
    return JSON.stringify(parameters());
  }

  function visibleMetrics() {
    const filter = filters();
    const kind = filter[filter.tab];
    return (filter.tab === 'work' ? workMetrics : pendingMetrics).filter(([, , group]) =>
      !group || kind === 'all' || group === kind || (group === 'assets' && ['code', 'mail', 'account'].includes(kind)));
  }

  function metricCell(row, metric, label) {
    const count = row.counts[metric] || 0;
    const incomplete = metric === 'used' ? row.unverifiedCodes || row.useTimeUnverified
      : ['unusedCodes', 'deliveredCodes', 'processingCodes'].includes(metric) && row.unverifiedCodes;
    if (!count) return incomplete ? A.tag('待核对', 'warning') : '0';
    return textAction(incomplete ? count + ' 已确认' : String(count), 'employee-statistics-detail',
      `data-employee="${esc(row.id)}" data-metric="${metric}" aria-label="查看${esc(row.name)}的${label}明细"`);
  }

  function renderReport(snapshot) {
    const filter = filters();
    const metrics = visibleMetrics();
    const pending = filter.tab === 'pending';
    const rows = snapshot.items.filter(row => (!filter.employee || filter.employee === row.id) &&
      (!pending || (metrics.some(([metric]) => row.counts[metric]) && (!filter.exceptions || exceptions(row)))));
    if (pending) rows.sort((a, b) => exceptions(b) - exceptions(a));
    const columns = [
      { id: 'name', label: '员工', render: row => esc(row.name) +
        (row.active === null && !['system', 'unattributed'].includes(row.id) ? '<br><span class="footnote">历史员工</span>' : '') },
      ...metrics.map(([id, label]) => ({ id, label, render: row => metricCell(row, id, label) }))
    ];
    const scope = pending ? '当前资产截至 ' + displayTime(snapshot.asOf)
      : snapshot.date + ' · 北京时间 · 数据截至 ' + displayTime(snapshot.asOf);
    const warning = !snapshot.codeSourceAvailable
      ? '<p class="inline-notice warning">代充码池暂不可读，涉及的使用和未归还状态待核对。</p>' : '';
    const pageRows = A.pageRows(rows);
    const chartMetric = metrics[0];
    const chart = chartMetric && pageRows.length ? `<div class="statistics-visual"><div class="section-title-row"><h2>${esc(chartMetric[1])}</h2>${A.titleInfo(chartMetric[1], '按当前页员工与筛选条件展示，详细数据在下方表格。来源待核验的数量不绘制为零。', 'employee-statistics-chart-help')}</div>${window.IDCharts.bars({
      title: chartMetric[1], unit: '条', details: false,
      rows: pageRows.map(row => ({ label: row.name, shortLabel: row.name.length > 4 ? row.name.slice(0, 3) + '…' : row.name,
        value: ['unusedCodes', 'deliveredCodes', 'processingCodes'].includes(chartMetric[0]) && row.unverifiedCodes
          ? null : row.counts[chartMetric[0]] ?? null })),
      series: [{ key: 'value', label: chartMetric[1], tone: pending ? 'amber' : 'blue' }]
    })}</div>` : '';
    return `<div class="panel-body"><p class="footnote">${esc(scope)}</p>${warning}</div>` + chart +
      A.table(columns, pageRows, '', pending ? '员工待处理资产' : '员工工作量', {
        title: pending ? '暂无符合条件的待处理资产' : '暂无符合条件的员工记录',
        description: '可以调整员工或业务类型筛选。'
      }) + A.pagination(rows.length);
  }

  function render() {
    const heading = A.header(title,
      '工作量按北京时间的发生日统计。待处理资产按当前状态汇总，超 24 小时未处理只提示跟进。',
      active() ? button('刷新', 'employee-statistics-refresh') : '');
    if (!active()) return heading +
      `<section class="panel">${A.empty('登录管理员后查看员工数据', '统计来自业务记录。')}</section>`;
    const filter = filters();
    const key = viewKey();
    const snapshot = report?.key === key ? report.data : null;
    const error = failure?.key === key;
    const today = report?.data.today || dayFormat.format(new Date());
    const employees = (report?.data.items || []).map(({ id, name }) => [id, name]);
    if (filter.employee && !employees.some(([id]) => id === filter.employee))
      employees.push([filter.employee, '当前选择的员工']);
    const options = [['all', '全部业务'], ...Object.entries(categoryLabels).filter(([kind]) =>
      filter.tab === 'work' || !['order', 'customer'].includes(kind))];
    const tabs = [['work', '工作量'], ['pending', '待处理资产']].map(([key, name]) =>
      `<button type="button" class="tab ${filter.tab === key ? 'active' : ''}"
        data-action="employee-statistics-tab" data-tab="${key}" aria-pressed="${filter.tab === key}">${name}</button>`).join('');
    return heading + `<section class="panel" id="employee-statistics">
      <div class="tabs" role="group" aria-label="员工统计视图">${tabs}</div>
      <div class="toolbar" role="group" aria-label="员工统计筛选">
        <div class="toolbar-left">
          ${filter.tab === 'work' ? A.input('employee-statistics-date', filter.date || today,
            `type="date" max="${esc(today)}" aria-label="统计日期"`) + button('今天', 'employee-statistics-today') : ''}
          ${A.select('employee-statistics-person', [['', '全部员工'], ...employees], filter.employee).replace('<select', '<select aria-label="员工"')}
          ${A.select('employee-statistics-kind', options, filter[filter.tab]).replace('<select', '<select aria-label="业务类型"')}
          ${filter.tab === 'pending' ? `<label class="checkbox-label">
            <input type="checkbox" id="employee-statistics-exceptions" ${filter.exceptions ? 'checked' : ''} />
            <span>只看异常</span></label>` : ''}
        </div>
        <div class="toolbar-right" data-page-actions></div>
      </div>
      <div class="design-async-region" data-statistics-region>
        <div data-statistics-progress role="status" hidden></div>
        ${error ? `<div class="panel-body"><p class="inline-notice warning" role="status">${snapshot
          ? '刷新失败，已保留上次统计。' : '暂时无法读取员工统计，请刷新重试。'}</p></div>` : ''}
        ${snapshot ? renderReport(snapshot) : ''}
      </div>
    </section>`;
  }

  async function load() {
    const panel = $('#employee-statistics');
    if (!active() || !panel) return;
    const params = parameters();
    const key = JSON.stringify(params);
    const request = latestLoad = Symbol();
    const read = A.beginRegionRead($('[data-statistics-region]', panel), $('[data-statistics-progress]', panel), {
      loadingText: '正在读取员工统计…', refreshButton: $('[data-action="employee-statistics-refresh"]', panel)
    });
    const current = () => request === latestLoad && active() && viewKey() === key;
    try {
      const data = await D.queries.read('employee-statistics', params, () => D.employeeStatistics(params), { refresh: true });
      if (!current()) return;
      if (!Array.isArray(data?.items) || !data.date || !data.asOf) throw new Error('统计响应格式无效');
      report = { key, data };
      failure = undefined;
      A.render();
      return true;
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401 || error?.status === 403) report = undefined;
      failure = { key };
      A.render();
      return false;
    } finally {
      read.finish();
    }
  }

  function openDetail(node) {
    const snapshot = report?.key === viewKey() ? report.data : null;
    const row = snapshot?.items.find(item => item.id === node.dataset.employee);
    const metric = visibleMetrics().find(([key]) => key === node.dataset.metric);
    if (!row || !metric) return;
    const params = { ...parameters(), date: snapshot.date, employee: row.id, metric: metric[0] };
    detail = { params, page: 1, pageSize: window.IDPagination.defaultPageSize };
    A.openDrawer(row.name + ' · ' + metric[1], '记录编号可用于回查原业务。待处理资产以读取时的状态为准。',
      '<section class="panel design-async-region" id="employee-statistics-detail"><div role="status" data-detail-progress hidden></div><div data-detail-result></div></section>',
      button('关闭', 'drawer-close'), detailPager);
    void loadDetail(detail.page, detail.pageSize);
  }

  async function loadDetail(page, pageSize) {
    const region = $('#employee-statistics-detail');
    if (!detail || !region || !active() || !$('#drawer').open) return;
    const selected = detail;
    Object.assign(selected, { page, pageSize });
    const result = $('[data-detail-result]', region);
    const read = A.beginRegionRead(region, $('[data-detail-progress]', region), { loadingText: '正在读取统计明细…' });
    const current = () => read.current() && selected === detail && active();
    try {
      const data = await D.employeeStatistics({ ...selected.params, page, pageSize });
      if (!current()) return;
      if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total)) throw new Error('统计明细响应格式无效');
      Object.assign(selected, { page: data.page, pageSize: data.pageSize });
      result.innerHTML = `<div class="panel-body"><p class="footnote">数据截至 ${esc(displayTime(data.asOf))}</p></div>` +
        A.table(detailColumns, data.items.map(item => ({ ...item, id: esc(item.id) })), '', '员工统计明细') +
        window.IDPagination.render({ id: detailPager, page: data.page, pageSize: data.pageSize, total: data.total });
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401 || error?.status === 403) {
        report = undefined;
        failure = { key: viewKey() };
        A.closeDrawer();
        A.render();
        return;
      }
      $('[data-detail-error]', region)?.remove();
      result.insertAdjacentHTML('afterbegin', `<div class="panel-body" data-detail-error>
        <p class="inline-notice warning" role="status">统计明细读取失败，请重试。</p>
        ${button('重试', 'employee-statistics-detail-retry')}</div>`);
    } finally {
      read.finish();
    }
  }

  document.addEventListener('id-pagination-change', event => {
    const { id, page, pageSize } = event.detail;
    if (id === detailPager) void loadDetail(page, pageSize);
  });

  window.IDDesignModules.push({
    id: 'employee-statistics', matches: value => value === route, render,
    afterRender({ routeChanged }) {
      if (active() && (routeChanged || (report?.key !== viewKey() && failure?.key !== viewKey()))) void load();
    },
    clearPageState() {
      report = failure = detail = latestLoad = undefined;
      A.state.drafts.delete(draftKey);
    },
    onDataChanges(changes) {
      if (active() && changes.some(scope => scopes.includes(scope))) return load();
    },
    onClick(action, node) {
      if (!active() || !action.startsWith('employee-statistics-')) return false;
      if (action === 'employee-statistics-refresh') void load();
      else if (action === 'employee-statistics-detail') openDetail(node);
      else if (action === 'employee-statistics-detail-retry') void loadDetail(detail?.page, detail?.pageSize);
      else if (action === 'employee-statistics-tab' || action === 'employee-statistics-today') {
        if (action === 'employee-statistics-tab') filters().tab = node.dataset.tab;
        else filters().date = '';
        A.state.page = 1;
        A.render();
      } else return false;
      return true;
    },
    onChange(node) {
      if (!active()) return false;
      const filter = filters();
      switch (node.id) {
        case 'employee-statistics-date': filter.date = node.value; break;
        case 'employee-statistics-person': filter.employee = node.value; break;
        case 'employee-statistics-kind': filter[filter.tab] = node.value; break;
        case 'employee-statistics-exceptions': filter.exceptions = node.checked; break;
        default: return false;
      }
      A.state.page = 1;
      A.render();
      return true;
    }
  });
})();
