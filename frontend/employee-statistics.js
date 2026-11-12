(() => {
  'use strict';

  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const { $, esc, button, textAction } = A;
  const title = '员工数据统计';
  const route = 'data-management/employee-statistics';
  const draftKey = 'employee-statistics:filters';
  const detailPager = 'employee-statistics-detail';
  const chartPager = 'employee-statistics-chart';
  const chartPageSize = 20;
  const scopes = ['commerce', 'inventory', 'recharge-codes', 'operators'];
  const categoryLabels = { order: '订单', customer: '客户', code: '充值码', mail: '邮箱', account: '账号' };
  const pendingKinds = ['all', 'code', 'mail', 'account'];
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
  const metricUnits = {
    orders: '笔', cancelledOrders: '笔', syncedOrders: '笔', customers: '位', issuedCodes: '枚',
    extractedMail: '个', submittedMail: '个', extractedAccounts: '个', submittedAccounts: '个',
    unusedCodes: '枚', deliveredCodes: '枚', processingCodes: '枚', returningCodes: '枚',
    pendingCodeRequests: '笔', openMail: '个', openAccounts: '个'
  };
  const shortMetricLabels = { orders: '订单', issuedCodes: '充值码', unusedCodes: '未用充值码' };
  const formatCount = new Intl.NumberFormat('zh-CN').format;
  const formatTick = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format;
  const specialEmployee = row => ['system', 'unattributed'].includes(row.id);
  const metricUnit = key => metricUnits[key] || '项';
  const metricIncomplete = (row, key) => Boolean(key === 'used' ? row.unverifiedCodes || row.useTimeUnverified
    : ['unusedCodes', 'deliveredCodes', 'processingCodes'].includes(key) && row.unverifiedCodes);
  const metricTotal = (rows, key) => rows.reduce((total, row) => total + (row.counts[key] || 0), 0);
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
  let report, failure, detail, latestLoad, headerScroll = 0, chartScroll = 0, chartScrollKey;
  const active = () => A.state.route === route && D?.authRequired &&
    ['admin', 'super'].includes(D.actor()?.role);
  const exceptions = row => (row.counts.overdue || 0) + (row.counts.review || 0) + (row.counts.returningCodes || 0);
  const displayTime = value => value && Number.isFinite(Date.parse(value)) ? timeFormat.format(Date.parse(value)) : '待核对';
  const businessToday = () => report?.data.today || dayFormat.format(new Date());
  const previousDay = (today, days) => dayFormat.format(Date.parse(today + 'T12:00:00+08:00') - days * 86_400_000);

  function filters() {
    if (!A.state.drafts.has(draftKey))
      A.state.drafts.set(draftKey, { tab: 'work', date: '', employee: '', work: 'all', pending: 'all', exceptions: false,
        comparisons: {
          work: { metric: 'orders', sort: 'quantity', page: 1, selected: '', detailsOpen: false },
          pending: { metric: 'unusedCodes', sort: 'quantity', page: 1, selected: '', detailsOpen: false }
        } });
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

  function metricCell(row, metric, label, context = '') {
    if (!row.counts[metric]) return metricIncomplete(row, metric) ? A.tag('待核对', 'warning') : '0';
    return textAction(countText(row, metric), 'employee-statistics-detail',
      `data-employee="${esc(row.id)}" data-metric="${metric}" aria-label="${context}查看${esc(row.name)}的${label}明细"`);
  }

  function comparison() {
    const filter = filters();
    return filter.comparisons[filter.tab];
  }

  function employeeNote(row) {
    if (row.id === 'system') return '系统记录';
    if (row.id === 'unattributed') return '归属待核对';
    return row.active === null ? '历史员工' : '';
  }

  function countText(row, key, unit = '') {
    const count = row.counts[key] || 0;
    const incomplete = metricIncomplete(row, key);
    if (incomplete && !count) return '待核对';
    return formatCount(count) + (unit ? ' ' + unit : '') + (incomplete ? ' 已确认' : '');
  }

  function chartScale(rows, key) {
    const max = rows.reduce((value, row) => Math.max(value, row.counts[key] || 0), 0);
    const roughStep = Math.max(1, (max + 1) / 4);
    const halfPower = 10 ** Math.floor(Math.log10(roughStep)) / 2;
    const step = Math.ceil(Math.ceil(roughStep / halfPower) * halfPower);
    return { max: step * 4, ticks: Array.from({ length: 5 }, (_, i) => i * step) };
  }

  function renderSeries(rows, metric, selected, staff, tone) {
    const [key, label] = metric, unit = metricUnit(key);
    const scale = chartScale(staff, key);
    const ticks = scale.ticks.map(value => `<span data-employee-position="${value / scale.max * 100}">${formatTick(value)}</span>`).join('');
    const lines = scale.ticks.map(value => `<span data-employee-position="${value / scale.max * 100}"></span>`).join('');
    const bars = rows.map(row => {
      const value = row.counts[key] || 0;
      const unknown = metricIncomplete(row, key) && !value;
      const chosen = row.id === selected;
      const description = row.name + '，' + label + ' ' + countText(row, key, unit);
      return `<button type="button" class="employee-statistics-column" data-action="employee-statistics-select-person"
        data-employee="${esc(row.id)}" aria-label="${esc(description)}" title="${esc(description)}"
        aria-pressed="${chosen}" tabindex="${chosen ? 0 : -1}">
        <span class="employee-statistics-column-slot${unknown ? ' is-unknown' : ''}" data-employee-position="${value / scale.max * 100}" aria-hidden="true">
          <span class="employee-statistics-column-fill"></span><span class="employee-statistics-column-value">${esc(countText(row, key))}</span>
        </span><span class="employee-statistics-column-name" aria-hidden="true">${esc(row.name)}</span></button>`;
    }).join('');
    return `<section class="employee-statistics-series" data-employee-series="${key}" data-tone="${tone}" aria-label="${esc(label)}员工柱状图">
      <div class="employee-statistics-series-heading"><h3>${esc(label)} <span>／${unit}</span></h3><span>${rows.length} / ${staff.length} 名员工</span></div>
      <div class="employee-statistics-series-plot">
        <div class="employee-statistics-axis" aria-hidden="true">${ticks}</div>
        <div class="employee-statistics-column-plot"><div class="employee-statistics-gridlines" aria-hidden="true">${lines}</div>
          <div class="employee-statistics-columns">${bars}</div></div>
      </div></section>`;
  }

  function renderQuickTable(rows, metrics, selected, paired = false) {
    if (!rows.length) return '';
    const split = paired ? Math.ceil(rows.length / 2) : rows.length;
    const metricHeader = metrics.map(([key, label]) =>
      `<th scope="col" title="${esc(label + '／' + metricUnit(key))}">${esc(shortMetricLabels[key] || label)}</th>`).join('');
    const headers = '<th scope="col">员工</th>' + metricHeader;
    const gap = '<td class="employee-statistics-quick-gap" aria-hidden="true"></td>';
    const cells = row => {
      if (!row) return `<td colspan="${metrics.length + 1}"></td>`;
      const choice = row.id === selected, id = esc(row.id);
      const note = employeeNote(row);
      const attrs = `data-employee-quick-cell="${id}"${choice ? ' data-selected' : ''}`;
      const label = `${esc(row.name)}${note ? `<small>${note}</small>` : ''}`;
      return `<td class="employee-statistics-quick-name" ${attrs}>${specialEmployee(row) ? label :
        `<button type="button" data-action="employee-statistics-select-person" data-employee="${id}" aria-pressed="${choice}"
          aria-label="选择${esc(row.name)}">${label}</button>`}</td>` +
        metrics.map(([key, name], index) => `<td${index ? ' class="employee-statistics-quick-secondary"' : ''} ${attrs}>${metricCell(row, key, name, '从速查')}</td>`).join('');
    };
    const body = rows.slice(0, split).map((row, i) => `<tr>${cells(row)}${paired ? gap + cells(rows[i + split]) : ''}</tr>`).join('');
    return `<table class="employee-statistics-quick-table"${paired ? ' data-paired' : ''} aria-label="${specialEmployee(rows[0]) ? '系统与归属待核对' : '员工数量速查'}">
      <thead><tr>${headers}${paired ? '<th class="employee-statistics-quick-gap" aria-hidden="true"></th>' + headers : ''}</tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function selectedSummary(row, key) {
    return row ? `<span>${esc(row.name)}</span> <strong>${esc(countText(row, key, metricUnit(key)))}</strong>` : '';
  }

  function renderDistribution(rows, metrics) {
    const filter = filters(), pending = filter.tab === 'pending', view = comparison();
    const primary = metrics.find(([key]) => key === view.metric) || metrics[0];
    const [key] = primary;
    const preferred = pending ? ['unusedCodes', 'openMail', 'openAccounts'] : ['orders', 'issuedCodes', 'extractedMail'];
    const second = preferred.map(id => metrics.find(([metric]) => metric === id && metric !== key)).find(Boolean) ||
      metrics.find(([metric]) => metric !== key);
    const pair = second ? [primary, second] : [primary];
    const staff = rows.filter(row => !specialEmployee(row));
    const special = rows.filter(specialEmployee);
    if (view.sort === 'quantity') staff.sort((a, b) => Number(metricIncomplete(a, key)) - Number(metricIncomplete(b, key)) ||
      (b.counts[key] || 0) - (a.counts[key] || 0) || a.name.localeCompare(b.name, 'zh-CN'));
    view.page = Math.min(view.page, Math.max(1, Math.ceil(staff.length / chartPageSize)));
    const shown = staff.slice((view.page - 1) * chartPageSize, view.page * chartPageSize);
    const selected = shown.find(row => row.id === view.selected) || shown[0];
    view.selected = selected?.id || '';
    const totals = pair.map(([metric, label]) => {
      const incomplete = rows.some(row => metricIncomplete(row, metric));
      const count = metricTotal(rows, metric);
      return `<div class="employee-statistics-quick-total" data-employee-total="${metric}">
        <span>${esc(label)}${incomplete && count ? '<small>已确认</small>' : ''}</span>
        <strong${incomplete && !count ? ' class="employee-statistics-total-unknown"' : ''}>${incomplete && !count ? '待核对' : formatCount(count)}</strong>
        ${incomplete && !count ? '' : `<small>${metricUnit(metric)}</small>`}</div>`;
    }).join('');
    const plotKey = JSON.stringify([filter.tab, viewKey(), filter.employee, filter.exceptions, view.page, key, view.sort]);
    const plot = shown.length ? `<div class="employee-statistics-chart-scroll" data-employee-chart-key="${esc(plotKey)}"
        tabindex="0" role="region" aria-label="员工柱状图，可横向滚动">
      <div class="employee-statistics-chart-track" data-employee-column-count="${shown.length}">
        ${pair.map((metric, i) => renderSeries(shown, metric, view.selected, staff, i ? 'teal' : 'blue')).join('')}
      </div></div><div class="employee-statistics-chart-selection">
        <div data-employee-selected aria-live="polite">${selectedSummary(selected, key)}</div>
        <span>点击柱子或姓名联动</span></div>`
      : `<p class="employee-statistics-chart-empty">${special.length ? '当前范围仅有系统或归属未记录的资料' : '当前条件暂无员工记录'}</p>`;
    return `<section class="employee-statistics-analysis" data-employee-primary-metric="${key}" aria-label="员工分布与数量说明">
      <div class="employee-statistics-section-heading"><div class="section-title-row">
        <h2>${pending ? '待处理资产分布' : '员工工作分布'}</h2>
        ${A.titleInfo('员工分布', '两张柱图与右侧速查共用员工顺序。合计覆盖当前筛选范围。不同指标分别统计，系统与归属未记录单列。', 'employee-statistics-chart-help')}
        </div><div class="employee-statistics-chart-controls">
        <label for="employee-statistics-metric">统计指标</label>
        ${A.select('employee-statistics-metric', metrics.map(([value, name]) => [value, name]), key).replace('<select', '<select aria-label="统计指标"')}
        ${button(view.sort === 'quantity' ? '数量降序' : '员工顺序', 'employee-statistics-sort', '', view.sort === 'quantity' ? 'down' : '', `aria-pressed="${view.sort === 'quantity'}"`)}</div></div>
      <div class="employee-statistics-distribution"${shown.length === 1 ? ' data-single' : ''}>
        <div class="employee-statistics-plot">${plot}</div>
        <section class="employee-statistics-quantities" aria-labelledby="employee-statistics-quick-title">
          <div class="employee-statistics-subheading"><div class="section-title-row"><h3 id="employee-statistics-quick-title">员工数量速查</h3>
          ${A.titleInfo('员工数量速查', '每行并排两名员工。选择姓名会联动柱图，点击非零数量可打开脱敏明细。', 'employee-statistics-quick-help')}</div>
          <span>${shown.length} 人 · ${Math.ceil(shown.length / 2)} 行</span></div>
          <div class="employee-statistics-quick-totals">${totals}</div>
          ${shown.length || special.length ? `<div class="employee-statistics-quick-scroll" tabindex="0" role="region" aria-label="员工数量表">
            ${renderQuickTable(shown, pair, view.selected, shown.length > 1)}
            ${special.length ? `<div class="employee-statistics-special">${renderQuickTable(special, pair, '')}</div>` : ''}</div>` : ''}
          <p class="employee-statistics-chart-note">${pair.map(([metric, label]) => esc(label) + '（' + metricUnit(metric) + '）').join(' · ')}</p>
        </section>
      </div>
      <div class="employee-statistics-chart-footer"><span>当前范围 ${formatCount(staff.length)} 名员工 · 合计覆盖全部筛选结果${special.length ? '，含单列记录' : ''}</span>
        ${shown.length ? '<span class="employee-statistics-chart-legend"><span>已确认数量</span><span>当前选中</span></span>' : ''}</div>
      ${staff.length > chartPageSize ? window.IDPagination.render({ id: chartPager, page: view.page,
        pageSize: chartPageSize, pageSizes: [], total: staff.length }) : ''}
    </section>`;
  }

  function prepareCharts() {
    const plot = $('#employee-statistics .employee-statistics-chart-scroll');
    if (!plot) return;
    const track = $('[data-employee-column-count]', plot);
    track.style.setProperty('--employee-column-count', track.dataset.employeeColumnCount);
    for (const node of plot.querySelectorAll('[data-employee-position]'))
      node.style.setProperty('--employee-position', node.dataset.employeePosition + '%');
    if (plot.dataset.employeeChartKey === chartScrollKey) plot.scrollLeft = chartScroll;
  }

  function selectEmployee(node) {
    const analysis = node.closest('.employee-statistics-analysis');
    const row = report?.key === viewKey() && report.data.items.find(item => item.id === node.dataset.employee);
    if (!analysis || !row || specialEmployee(row)) return;
    comparison().selected = row.id;
    for (const button of analysis.querySelectorAll('[data-action="employee-statistics-select-person"]')) {
      const selected = button.dataset.employee === row.id;
      button.setAttribute('aria-pressed', String(selected));
      if (button.classList.contains('employee-statistics-column')) button.tabIndex = selected ? 0 : -1;
    }
    for (const cell of analysis.querySelectorAll('[data-employee-quick-cell]'))
      cell.toggleAttribute('data-selected', cell.dataset.employeeQuickCell === row.id);
    $('[data-employee-selected]', analysis).innerHTML = selectedSummary(row, analysis.dataset.employeePrimaryMetric);
    const plot = $('.employee-statistics-chart-scroll', analysis);
    const column = $('.employee-statistics-column[aria-pressed="true"]', plot);
    const frame = plot.getBoundingClientRect(), bounds = column.getBoundingClientRect();
    if (bounds.left < frame.left) plot.scrollLeft -= frame.left - bounds.left;
    else if (bounds.right > frame.right) plot.scrollLeft += bounds.right - frame.right;
  }

  function renderReport(snapshot) {
    const filter = filters();
    const metrics = visibleMetrics();
    const pending = filter.tab === 'pending';
    const rows = snapshot.items.filter(row => (!filter.employee || filter.employee === row.id) &&
      (!pending || (metrics.some(([metric]) => row.counts[metric]) && (!filter.exceptions || exceptions(row)))));
    const warning = !snapshot.codeSourceAvailable
      ? '<p class="inline-notice warning">代充码池暂不可读，涉及的使用和未归还状态待核对。</p>' : '';
    const open = comparison().detailsOpen;
    const columns = [
      { id: 'name', label: '员工', render: row => esc(row.name) +
        (employeeNote(row) ? '<br><span class="footnote">' + employeeNote(row) + '</span>' : '') },
      ...metrics.map(([id, label]) => ({ id, label, render: row => metricCell(row, id, label) }))
    ];
    const detailRows = open && pending ? [...rows].sort((a, b) => exceptions(b) - exceptions(a)) : rows;
    const detailList = open ? A.table(columns, A.pageRows(detailRows), '', pending ? '员工待处理资产' : '员工工作量', {
      title: pending ? '暂无符合条件的待处理资产' : '暂无符合条件的员工记录',
      description: '可以调整员工或业务类型筛选。'
    }) + A.pagination(rows.length) : '';
    return (warning ? `<div class="panel-body">${warning}</div>` : '') +
      `<div class="employee-statistics-dashboard">${renderDistribution(rows, metrics)}</div>` +
      `<section class="employee-statistics-details"><div class="employee-statistics-section-heading"><div class="section-title-row"><h2>${pending ? '员工资产明细' : '员工工作明细'}</h2>${A.titleInfo('员工业务明细', '点击非零数量回查脱敏原始记录。撤单是提交订单的子集，使用、归还和异常分别统计。', 'employee-statistics-details-help')}</div>
      ${button(open ? '收起明细' : '展开明细', 'employee-statistics-toggle-details', '', 'down', `aria-expanded="${open}" aria-controls="employee-statistics-detail-list"`)}</div>` +
      `<div class="employee-statistics-details-content" id="employee-statistics-detail-list"${open ? '' : ' hidden'}>${detailList}</div></section>`;
  }

  function render() {
    const priorHeader = $('#employee-statistics .employee-statistics-scroll');
    if (priorHeader) headerScroll = priorHeader.scrollLeft;
    const priorChart = $('#employee-statistics .employee-statistics-chart-scroll');
    if (priorChart) {
      chartScrollKey = priorChart.dataset.employeeChartKey;
      chartScroll = priorChart.scrollLeft;
    }
    const heading = A.header(title,
      '工作量按北京时间的发生日统计。待处理资产按当前状态汇总，超 24 小时未处理只提示跟进。',
      active() ? button('刷新', 'employee-statistics-refresh') : '');
    if (!active()) return heading +
      `<section class="panel">${A.empty('登录管理员后查看员工数据', '统计来自业务记录。')}</section>`;
    const filter = filters();
    const key = viewKey();
    const snapshot = report?.key === key ? report.data : null;
    const dataTime = displayTime(snapshot?.asOf);
    const shortTime = dataTime.startsWith(snapshot?.today + ' ') ? dataTime.slice(11) : dataTime;
    const scope = snapshot ? (filter.tab === 'pending' ? '当前资产截至 ' : '北京时间 · 截至 ') + shortTime : '';
    const error = failure?.key === key;
    const today = businessToday();
    const selectedDate = filter.date || today;
    const dateShortcuts = ['今天', '昨天', '前天'].map((label, days) => {
      const selected = selectedDate === previousDay(today, days);
      return button(label, 'employee-statistics-date-preset', selected ? 'primary' : '', '',
        `data-days-ago="${days}" aria-pressed="${selected}"`);
    }).join('');
    const employees = (report?.data.items || []).map(({ id, name }) => [id, name]);
    if (filter.employee && !employees.some(([id]) => id === filter.employee))
      employees.push([filter.employee, '当前选择的员工']);
    const options = [['all', '全部业务'], ...Object.entries(categoryLabels).filter(([kind]) =>
      filter.tab === 'work' || pendingKinds.includes(kind))];
    const kindButtons = filter.tab === 'pending' ? options.map(([kind, label]) =>
      button(label, 'employee-statistics-kind', filter.pending === kind ? 'primary' : '', '',
        `data-kind="${kind}" aria-pressed="${filter.pending === kind}"`)).join('') : '';
    const tabs = [['work', '工作量'], ['pending', '待处理资产']].map(([key, name]) =>
      `<button type="button" class="tab ${filter.tab === key ? 'active' : ''}"
        data-action="employee-statistics-tab" data-tab="${key}" aria-pressed="${filter.tab === key}">${name}</button>`).join('');
    return heading + `<section class="panel" id="employee-statistics">
      <div class="content-toolbar employee-statistics-header">
      <div class="employee-statistics-scroll" tabindex="0" role="group" aria-label="员工统计视图和筛选">
      <div class="tabs" role="group" aria-label="员工统计视图">${tabs}</div>
      <div class="toolbar toolbar--inline list-filters" role="group" aria-label="员工统计筛选">
        ${filter.tab === 'work' ? `<label class="toolbar-date" for="employee-statistics-date">统计日期
          ${A.input('employee-statistics-date', selectedDate, `type="date" max="${esc(today)}" aria-label="统计日期"`)}
        </label><div class="toolbar-date-shortcuts" role="group" aria-label="快捷日期">${dateShortcuts}</div>` : ''}
        <div class="toolbar-select-filters">
          <label for="employee-statistics-person">员工</label>
          ${A.select('employee-statistics-person', [['', '全部员工'], ...employees], filter.employee).replace('<select', '<select aria-label="员工"')}
          ${filter.tab === 'work' ? A.select('employee-statistics-kind', options, filter.work).replace('<select', '<select aria-label="业务类型"') : ''}
        </div>
        ${filter.tab === 'pending' ? `<div class="toolbar-select-filters" role="group" aria-label="业务类型">${kindButtons}</div>
        <label class="checkbox-label">
          <input type="checkbox" id="employee-statistics-exceptions" ${filter.exceptions ? 'checked' : ''} />
          <span>只看异常</span></label>` : ''}
        ${scope ? `<p class="employee-statistics-scope" data-statistics-date="${esc(snapshot.date)}"
          title="北京时间 ${esc(dataTime)}">${esc(scope)}</p>` : ''}
      </div>
      </div><div class="toolbar-right" data-page-actions></div></div>
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
    if (id === chartPager && active() && event.target.closest('#employee-statistics')) {
      comparison().page = page;
      A.render();
    }
  });

  document.addEventListener('keydown', event => {
    const column = event.target.closest?.('.employee-statistics-column');
    if (!column || !active() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const columns = [...column.parentElement.children];
    const index = columns.indexOf(column);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? columns.length - 1 :
      Math.max(0, Math.min(columns.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    selectEmployee(columns[next]);
    columns[next].focus({ preventScroll: true });
  });

  window.IDDesignModules.push({
    id: 'employee-statistics', matches: value => value === route, render,
    afterRender({ routeChanged }) {
      const scroll = $('#employee-statistics .employee-statistics-scroll');
      if (scroll) scroll.scrollLeft = headerScroll;
      prepareCharts();
      if (active() && (routeChanged || (report?.key !== viewKey() && failure?.key !== viewKey()))) void load();
    },
    deactivate() {
      latestLoad = detail = undefined;
    },
    clearPageState() {
      report = failure = detail = latestLoad = undefined;
      headerScroll = chartScroll = 0;
      chartScrollKey = undefined;
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
      else if (action === 'employee-statistics-select-person') selectEmployee(node);
      else if (action === 'employee-statistics-sort' || action === 'employee-statistics-toggle-details') {
        const view = comparison();
        if (action === 'employee-statistics-sort') {
          view.sort = view.sort === 'quantity' ? 'employee' : 'quantity';
          view.page = 1;
        } else view.detailsOpen = !view.detailsOpen;
        A.render();
        $(`#employee-statistics [data-action="${action}"]`)?.focus({ preventScroll: true });
      }
      else if (action === 'employee-statistics-kind') {
        const filter = filters();
        if (filter.tab !== 'pending' || !pendingKinds.includes(node.dataset.kind)) return false;
        filter.pending = node.dataset.kind;
        comparison().page = 1;
        A.state.page = 1;
        A.render();
      }
      else if (action === 'employee-statistics-tab' || action === 'employee-statistics-date-preset') {
        if (action === 'employee-statistics-tab') filters().tab = node.dataset.tab;
        else {
          const days = Number(node.dataset.daysAgo);
          if (![0, 1, 2].includes(days)) return false;
          filters().date = days ? previousDay(businessToday(), days) : '';
          comparison().page = 1;
        }
        A.state.page = 1;
        A.render();
      } else return false;
      return true;
    },
    onChange(node) {
      if (!active()) return false;
      const filter = filters();
      if (node.id === 'employee-statistics-metric') {
        if (visibleMetrics().some(([key]) => key === node.value)) {
          const view = comparison();
          view.metric = node.value;
          view.page = 1;
          A.render();
          $('#employee-statistics-metric')?.focus({ preventScroll: true });
        }
        return true;
      }
      switch (node.id) {
        case 'employee-statistics-date': filter.date = node.value; break;
        case 'employee-statistics-person': filter.employee = node.value; break;
        case 'employee-statistics-kind': filter[filter.tab] = node.value; break;
        case 'employee-statistics-exceptions': filter.exceptions = node.checked; break;
        default: return false;
      }
      comparison().page = 1;
      A.state.page = 1;
      A.render();
      return true;
    }
  });
})();
