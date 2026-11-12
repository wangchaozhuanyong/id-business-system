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
  const metricLabels = Object.fromEntries([...workMetrics, ...pendingMetrics].map(([key, label]) => [key, label]));
  const specialEmployee = row => ['system', 'unattributed'].includes(row.id);
  const metricUnit = key => metricUnits[key] || '项';
  const metricIncomplete = (row, key) => Boolean(key === 'used' ? row.unverifiedCodes || row.useTimeUnverified
    : ['unusedCodes', 'deliveredCodes', 'processingCodes'].includes(key) && row.unverifiedCodes);
  const metricTotal = (rows, key) => rows.reduce((total, row) => total + (row.counts[key] || 0), 0);
  let distributionObserver, distributionFrame;
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
  let report, failure, detail, latestLoad, headerScroll = 0;
  const active = () => A.state.route === route && D?.authRequired &&
    ['admin', 'super'].includes(D.actor()?.role);
  const exceptions = row => (row.counts.overdue || 0) + (row.counts.review || 0) + (row.counts.returningCodes || 0);
  const displayTime = value => value && Number.isFinite(Date.parse(value)) ? timeFormat.format(Date.parse(value)) : '待核对';
  const businessToday = () => report?.data.today || dayFormat.format(new Date());
  const previousDay = (today, days) => dayFormat.format(Date.parse(today + 'T12:00:00+08:00') - days * 86_400_000);

  function filters() {
    if (!A.state.drafts.has(draftKey))
      A.state.drafts.set(draftKey, { tab: 'work', date: '', employee: '', work: 'all', pending: 'all', exceptions: false,
        workMetric: 'orders', pendingMetric: 'unusedCodes', workExpanded: false, pendingExpanded: false });
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
    const incomplete = metricIncomplete(row, metric);
    if (!count) return incomplete ? A.tag('待核对', 'warning') : '0';
    return textAction(incomplete ? count + ' 已确认' : String(count), 'employee-statistics-detail',
      `data-employee="${esc(row.id)}" data-metric="${metric}" aria-label="查看${esc(row.name)}的${label}明细"`);
  }

  function employeeIdentity(row) {
    const note = specialEmployee(row) ? row.id === 'system' ? '系统记录' : '归属待核对'
      : row.active === null ? '历史员工' : '';
    return `<span class="employee-statistics-identity"><span class="employee-statistics-avatar" aria-hidden="true">${A.icon(specialEmployee(row) ? 'database' : 'user')}</span><span>${esc(row.name)}${note ? `<small>${note}</small>` : ''}</span></span>`;
  }

  function renderSummary(rows, metrics) {
    const filter = filters(), pending = filter.tab === 'pending', kind = filter[filter.tab];
    const choices = pending ? {
      all: ['unusedCodes', 'openMail', 'openAccounts', 'overdue'],
      code: ['unusedCodes', 'deliveredCodes', 'processingCodes', 'returningCodes'],
      mail: ['openMail', 'overdue', 'review'], account: ['openAccounts', 'overdue', 'review']
    } : {
      all: ['orders', 'people', 'customers', 'undated'], order: ['orders', 'cancelledOrders', 'syncedOrders', 'undated'],
      customer: ['customers', 'people', 'undated'], code: ['issuedCodes', 'used', 'returned', 'undated'],
      mail: ['extractedMail', 'submittedMail', 'used', 'returned'],
      account: ['extractedAccounts', 'submittedAccounts', 'used', 'returned']
    };
    const cards = choices[kind] || choices.all;
    const people = rows.filter(row => !specialEmployee(row) && metrics.some(([key]) => key !== 'undated' && row.counts[key] > 0)).length;
    return `<section class="employee-statistics-kpis" aria-label="员工统计关键数据">${cards.map((key, index) => {
      const incomplete = rows.some(row => metricIncomplete(row, key));
      const count = key === 'people' ? people : metricTotal(rows, key);
      const icon = key === 'people' || key === 'customers' ? 'users' : /mail/i.test(key) ? 'mail'
        : /account/i.test(key) ? 'user' : /overdue|undated|review|returning/i.test(key) ? 'clock' : 'orders';
      const tone = /overdue|undated|review|returning/i.test(key) ? 'amber' : ['blue', 'teal', 'violet', 'blue'][index];
      return `<div class="employee-statistics-kpi" data-tone="${tone}" data-employee-kpi="${key}">
        <span class="employee-statistics-kpi-icon" aria-hidden="true">${A.icon(icon)}</span>
        <div><div class="employee-statistics-kpi-label">${key === 'people' ? '有记录员工' : metricLabels[key]}</div>
        <div class="employee-statistics-kpi-value"><strong>${incomplete && !count ? '待核对' : count}</strong>
        <small>${incomplete && !count ? '' : key === 'people' ? '人' : metricUnit(key)}${incomplete && count ? ' · 已确认' : ''}</small></div></div></div>`;
    }).join('')}</section>`;
  }

  function renderDistribution(rows, metrics) {
    const filter = filters(), pending = filter.tab === 'pending';
    const selected = metrics.find(([key]) => key === filter[filter.tab + 'Metric']) || metrics[0];
    if (!selected) return '';
    const [key, label] = selected, unit = metricUnit(key), expanded = filter[filter.tab + 'Expanded'];
    const ordered = [...rows].sort((a, b) => Number(specialEmployee(a)) - Number(specialEmployee(b)) ||
      Number(metricIncomplete(a, key)) - Number(metricIncomplete(b, key)) ||
      (b.counts[key] || 0) - (a.counts[key] || 0) || a.name.localeCompare(b.name, 'zh-CN'));
    const shown = expanded ? ordered : ordered.slice(0, 6), remaining = ordered.slice(shown.length);
    const total = metricTotal(rows, key), incomplete = rows.some(row => metricIncomplete(row, key));
    const maximum = Math.max(1, ...ordered.map(row => row.counts[key] || 0));
    const percent = value => !incomplete && total ? (100 * value / total).toFixed(1) + '%' : '—';
    const countText = (count, unknown) => unknown && !count ? '待核对' : `${count} ${unit}${unknown ? ' 已确认' : ''}`;
    const remainder = metricTotal(remaining, key), remainderIncomplete = remaining.some(row => metricIncomplete(row, key));
    const otherName = `其余 ${remaining.length} 项统计对象`;
    const bar = (identity, count, unknown) => `<div class="employee-statistics-bar" data-employee-chart-row>
      ${identity}<div class="employee-statistics-track" aria-hidden="true"><div data-employee-bar-percent="${100 * count / maximum}"></div></div>
      <span class="employee-statistics-bar-value">${esc(countText(count, unknown))}</span></div>`;
    return `<section class="employee-statistics-analysis" aria-label="员工分布与数量说明">
      <div class="employee-statistics-section-heading"><div class="section-title-row"><h2>${pending ? '待处理资产分布' : '员工工作分布'}</h2>${A.titleInfo('员工分布', '图表和数量说明覆盖全部筛选结果，底部表格翻页不改变合计。只比较同一指标，不将不同业务相加评估绩效。系统和归属未记录单列，未知数量不计为零。', 'employee-statistics-chart-help')}</div>
        <div class="employee-statistics-chart-controls">${rows.length > 6 ? button(expanded ? '收起' : `查看全部 ${rows.length} 项`, 'employee-statistics-expand-chart', '', '', `aria-expanded="${Boolean(expanded)}"`) : ''}
        <label for="employee-statistics-metric">统计指标</label>${A.select('employee-statistics-metric', metrics.map(([value, name]) => [value, name]), key).replace('<select', '<select aria-label="统计指标"')}</div></div>
      <div class="employee-statistics-distribution" data-expanded="${Boolean(expanded)}" data-tone="${pending ? 'amber' : 'blue'}" tabindex="0">
        <section class="employee-statistics-plot" aria-label="${esc(label)}员工对比"><div class="employee-statistics-subheading"><h3>${esc(label)} · 员工对比</h3><span>单位：${unit}</span></div>
          <div class="employee-statistics-plot-columns"><span>员工</span><span>已确认数量</span></div>
          <div class="employee-statistics-bars">${shown.length ? shown.map(row => bar(employeeIdentity(row), row.counts[key] || 0, metricIncomplete(row, key))).join('')
            : '<p class="employee-statistics-chart-empty">当前条件暂无记录</p>'}</div>
          <p class="employee-statistics-chart-note">${remaining.length ? `另有 ${esc(otherName)}，${esc(countText(remainder, remainderIncomplete))}。` : ''}${incomplete ? '部分数量待核对，条形只表示已确认数量。' : '按当前筛选范围展示已确认数量。'}</p></section>
        <section class="employee-statistics-quantities" aria-label="${esc(label)}数量说明"><div class="employee-statistics-subheading"><h3>数量与占比</h3><span>当前筛选范围</span></div>
          <table class="employee-statistics-report"><thead><tr><th scope="col">员工</th><th scope="col">数量</th><th scope="col">占比</th><th scope="col">操作</th></tr></thead>
          <tbody>${shown.length ? shown.map(row => `<tr data-employee-report-row><td>${employeeIdentity(row)}</td><td>${esc(countText(row.counts[key] || 0, metricIncomplete(row, key)))}</td><td>${percent(row.counts[key] || 0)}</td><td>${row.counts[key] ? textAction('明细', 'employee-statistics-detail', `data-employee="${esc(row.id)}" data-metric="${key}" aria-label="从分布图查看${esc(row.name)}的${label}明细"`) : '—'}</td></tr>`).join('')
            : '<tr><td colspan="4" class="employee-statistics-chart-empty">暂无员工记录</td></tr>'}
            ${remaining.length ? `<tr class="employee-statistics-other"><td>${esc(otherName)}</td><td>${esc(countText(remainder, remainderIncomplete))}</td><td>${percent(remainder)}</td><td>${textAction('展开', 'employee-statistics-expand-chart')}</td></tr>` : ''}</tbody>
          <tfoot><tr><th scope="row">${incomplete ? '已确认合计' : '合计'}</th><td data-employee-chart-total>${total} ${unit}</td><td>${!incomplete && total ? '100%' : '—'}</td><td></td></tr></tfoot></table>
          <p class="employee-statistics-chart-note">${incomplete ? '部分数量待核对，暂不计算占比。' : `${rows.filter(row => !specialEmployee(row) && row.counts[key] > 0).length} 名员工有本项记录 · 当前范围 ${rows.filter(row => !specialEmployee(row)).length} 名员工`}${rows.some(specialEmployee) ? ' · 系统及未归属记录单列' : ''}</p></section>
      </div></section>`;
  }

  function alignDistribution() {
    distributionObserver?.disconnect();
    cancelAnimationFrame(distributionFrame);
    const region = $('#employee-statistics .employee-statistics-distribution');
    if (!region) return;
    const kpis = $('#employee-statistics .employee-statistics-kpis');
    kpis.style.setProperty('--employee-kpi-count', String(kpis.children.length));
    for (const bar of region.querySelectorAll('[data-employee-bar-percent]'))
      bar.style.width = bar.dataset.employeeBarPercent + '%';
    let width = -1;
    const align = () => {
      const bars = [...region.querySelectorAll('[data-employee-chart-row]')];
      const rows = [...region.querySelectorAll('[data-employee-report-row]')];
      bars.forEach(row => row.style.removeProperty('--employee-row-height'));
      rows.forEach(row => row.style.removeProperty('--employee-row-height'));
      if (getComputedStyle(region).gridTemplateColumns.split(' ').length < 2) return;
      bars.forEach((bar, index) => {
        if (!rows[index]) return;
        const height = Math.max(bar.getBoundingClientRect().height, rows[index].getBoundingClientRect().height);
        bar.style.setProperty('--employee-row-height', height + 'px');
        rows[index].style.setProperty('--employee-row-height', height + 'px');
      });
    };
    distributionObserver = new ResizeObserver(entries => {
      const next = entries[0].contentRect.width;
      if (next === width) return;
      width = next;
      cancelAnimationFrame(distributionFrame);
      distributionFrame = requestAnimationFrame(align);
    });
    distributionObserver.observe(region);
    align();
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
    const warning = !snapshot.codeSourceAvailable
      ? '<p class="inline-notice warning">代充码池暂不可读，涉及的使用和未归还状态待核对。</p>' : '';
    const pageRows = A.pageRows(rows);
    return (warning ? `<div class="panel-body">${warning}</div>` : '') +
      `<div class="employee-statistics-dashboard">${renderSummary(rows, metrics)}${renderDistribution(rows, metrics)}</div>` +
      `<section class="employee-statistics-details"><div class="employee-statistics-section-heading"><div class="section-title-row"><h2>${pending ? '员工资产明细' : '员工工作明细'}</h2>${A.titleInfo('员工业务明细', '点击非零数量回查脱敏原始记录。撤单是提交订单的子集；使用、归还和异常分别统计，不能将不同字段相加为工作总量。', 'employee-statistics-details-help')}</div></div>` +
      A.table(columns, pageRows, '', pending ? '员工待处理资产' : '员工工作量', {
        title: pending ? '暂无符合条件的待处理资产' : '暂无符合条件的员工记录',
        description: '可以调整员工或业务类型筛选。'
      }) + A.pagination(rows.length) + '</section>';
  }

  function render() {
    headerScroll = $('#employee-statistics .employee-statistics-scroll')?.scrollLeft || 0;
    const heading = A.header(title,
      '工作量按北京时间的发生日统计。待处理资产按当前状态汇总，超 24 小时未处理只提示跟进。',
      active() ? button('刷新', 'employee-statistics-refresh') : '');
    if (!active()) return heading +
      `<section class="panel">${A.empty('登录管理员后查看员工数据', '统计来自业务记录。')}</section>`;
    const filter = filters();
    const key = viewKey();
    const snapshot = report?.key === key ? report.data : null;
    const scope = snapshot ? filter.tab === 'pending' ? '当前资产截至 ' + displayTime(snapshot.asOf)
      : snapshot.date + ' · 北京时间 · 数据截至 ' + displayTime(snapshot.asOf) : '';
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
          ${A.select('employee-statistics-person', [['', '全部员工'], ...employees], filter.employee).replace('<select', '<select aria-label="员工"')}
          ${filter.tab === 'work' ? A.select('employee-statistics-kind', options, filter.work).replace('<select', '<select aria-label="业务类型"') : ''}
        </div>
        ${filter.tab === 'pending' ? `<div class="toolbar-select-filters" role="group" aria-label="业务类型">${kindButtons}</div>
        <label class="checkbox-label">
          <input type="checkbox" id="employee-statistics-exceptions" ${filter.exceptions ? 'checked' : ''} />
          <span>只看异常</span></label>` : ''}
        ${scope ? `<p class="employee-statistics-scope">${esc(scope)}</p>` : ''}
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
  });

  window.IDDesignModules.push({
    id: 'employee-statistics', matches: value => value === route, render,
    afterRender({ routeChanged }) {
      const scroll = $('#employee-statistics .employee-statistics-scroll');
      if (scroll) scroll.scrollLeft = headerScroll;
      alignDistribution();
      if (active() && (routeChanged || (report?.key !== viewKey() && failure?.key !== viewKey()))) void load();
    },
    deactivate() {
      distributionObserver?.disconnect();
      cancelAnimationFrame(distributionFrame);
    },
    clearPageState() {
      distributionObserver?.disconnect();
      cancelAnimationFrame(distributionFrame);
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
      else if (action === 'employee-statistics-expand-chart') {
        const filter = filters(), key = filter.tab + 'Expanded';
        filter[key] = !filter[key];
        A.render();
      }
      else if (action === 'employee-statistics-kind') {
        const filter = filters();
        if (filter.tab !== 'pending' || !pendingKinds.includes(node.dataset.kind)) return false;
        filter.pending = node.dataset.kind;
        A.state.page = 1;
        A.render();
      }
      else if (action === 'employee-statistics-tab' || action === 'employee-statistics-date-preset') {
        if (action === 'employee-statistics-tab') filters().tab = node.dataset.tab;
        else {
          const days = Number(node.dataset.daysAgo);
          if (![0, 1, 2].includes(days)) return false;
          filters().date = days ? previousDay(businessToday(), days) : '';
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
          filter[filter.tab + 'Metric'] = node.value;
          A.render();
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
      A.state.page = 1;
      A.render();
      return true;
    }
  });
})();
