(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData, e = A.esc;
  const dateFilter = window.IDDateFilter;
  const $ = (selector, root = document) => root.querySelector(selector);
  const { defaultPageSize, render: pagination } = window.IDPagination;
  const routes = {
    'monitor/performance': 'performance',
    'data/health': 'health',
    'data/backups': 'backups',
    'data/export': 'export',
    'settings/information': 'information'
  };
  const labels = {
    performance: '性能与错误', health: '数据健康', backups: '备份与恢复', export: '导出与保留', information: '系统信息'
  };
  const scopes = {
    performance: 'site-observations', resources: 'site-resources', health: 'site-data-health',
    backups: 'site-backups', information: 'site-information', diagnostic: 'site-diagnostic'
  };
  const activities = { login: '登录', 'customer-search': '查询客户', 'order-list': '读取订单列表', 'order-save': '保存订单' };
  const sources = {
    orders: ['代充订单同步', 'orders/gpt/recharge-sync'], rates: ['汇率采集', 'settings/exchange-rates'],
    mailbox: ['邮箱查询', 'plugins/mailboxes'], sheets: ['谷歌表格同步', 'data/sheets']
  };
  const issues = {
    duplicate: '同一代充任务有多笔订单', 'deleted-source': '有同步回执，未找到对应订单',
    customer: '找不到已关联的客户', tenant: '找不到已关联的租户', inventory: '找不到已关联的库存账号'
  };
  const sourceStates = {
    ok: ['正常', 'success'], watch: ['待跟进', 'warning'], bad: ['需检查', 'danger'],
    disabled: ['未启用', ''], unknown: ['待确认', 'warning']
  };
  const databaseStates = {
    verified: ['已校验', 'success'], 'check-failed': ['校验失败', 'danger'], failed: ['本次备份失败', 'danger'],
    stale: ['备份状态超时', 'warning'], retrying: ['正在重试', 'warning'], paused: ['备份已暂停', 'warning'],
    unknown: ['待确认', 'warning']
  };
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
  const hour = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' });
  const shortDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
  const time = at => Number.isFinite(at) ? fmt.format(at) : '未取得';
  const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未取得';
  const duration = value => Number.isFinite(value) ? (value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) + ' 秒' : '样本不足';
  const currentView = () => routes[A.state.route];
  const canRead = () => D?.authRequired && ['admin', 'super'].includes(A.state.actor?.role);
  const viewKey = name => 'site-management:' + name;
  const historyView = () => A.state.drafts.get(viewKey('performance')) || { preset: 'today', channel: 'browser' };
  const historyDates = ({ preset, from, to }) => preset === 'custom' ? { from, to } : dateFilter.range(preset);
  const healthView = () => A.state.drafts.get(viewKey('health')) || { kind: '', page: 1, pageSize: defaultPageSize };
  const exportView = () => A.state.drafts.get(viewKey('export')) || { collection: 'customers', period: 'all', start: '', end: '', status: '', product: '' };
  const keyFor = view => view === 'performance' ? historyDates(historyView()) : view === 'health' ? healthView() : {};
  const link = (route, text) => '<a class="button compact" href="#/' + e(route) + '">' + e(text) + '</a>';
  function title(text, help = '', id = '') {
    return '<div class="section-title-row"><h2>' + e(text) + '</h2>' + (help ? A.titleInfo(text, help, id) : '') + '</div>';
  }
  function table(title, headers, rows) {
    if (!rows.length) return A.empty('这里还没有资料', '');
    return '<div class="table-viewport site-management-table" role="region" aria-label="' + e(title) +
      '" tabindex="0"><table><thead><tr>' + headers.map(label => '<th scope="col">' + e(label) + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map((cell, i) =>
        '<td data-label="' + e(headers[i]) + '">' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  const properties = rows => '<dl class="site-management-properties">' + rows.map(([name, value]) =>
    '<div><dt>' + e(name) + '</dt><dd>' + e(value) + '</dd></div>').join('') + '</dl>';
  const metric = (label, value) =>
    '<div class="site-management-metric"><span>' + e(label) + '</span><strong>' + e(value) + '</strong></div>';
  function badge(dictionary, value) {
    const [label, tone] = dictionary[value] || dictionary.unknown;
    return A.tag(label, tone);
  }

  function lookup() {
    const input = A.state.drafts.get(viewKey('diagnostic')) || '';
    return '<section class="panel panel-body site-management-card">' +
      title('查找报错', '请员工把报错时看到的诊断编号发给你。', 'site-diagnostic-help') +
      '<form id="site-diagnostic-form" class="site-diagnostic-form"><label for="site-diagnostic-id">诊断编号</label>' +
      '<input id="site-diagnostic-id" name="diagnostic" maxlength="36" required autocomplete="off" placeholder="粘贴完整编号" value="' + e(input) + '">' +
      '<button class="button" type="submit">查询</button></form><div data-site-diagnostic-result role="status"></div></section>';
  }

  function performanceReport(report) {
    const { channel } = historyView(), group = report.groups[channel];
    const noCoverage = report.coverage === 'unavailable';
    const rates = group.total ? (100 * group.failed / group.total).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%' : '暂无记录';
    const items = group.activities.filter(row => row.total);
    const chartRows = group.trend.map(row => ({
      label: time(row.at), shortLabel: report.hours === 24 ? hour.format(row.at) + '时' : shortDate.format(row.at),
      value: row.p95 === null ? null : row.p95 / 1000
    }));
    return '<div class="site-management-grid"><div class="site-management-metrics">' +
      metric('测得操作', noCoverage ? '未取得' : count(group.total)) + metric('失败比例', rates) + metric('近 95% 成功操作在', duration(group.p95) + (group.p95 === null ? '' : ' 内')) +
      '</div>' + (group.blocked ? '<p class="site-management-time">有 ' + e(count(group.blocked)) +
        ' 次操作未通过检查，另列于下表。' + (group.limited ? ' 其中 ' + e(count(group.limited)) + ' 次尝试过于频繁。' : '') + '</p>' : '') +
      (!report.storageAvailable ? '<p class="inline-notice warning">历史记录暂时无法保存，本次运行的数据仍可查看。</p>' : '') +
      (noCoverage ? '<p class="inline-notice warning">所选日期没有可用的性能历史。</p>' :
        report.coverage === 'partial' ? '<p class="inline-notice warning">所选日期含尚无历史采集的时段，指标仅统计已有记录。</p>' : '') +
      '<section class="panel panel-body site-management-card">' +
      title('等待时间走势', '每个时间段至少有 20 次成功操作才显示耗时。按北京时间展示。', 'site-time-chart-help') +
      (chartRows.some(row => row.value !== null) ? window.IDCharts.bars({ title: '成功操作等待时间', rows: chartRows,
        series: [{ key: 'value', label: '近 95% 成功操作用时', tone: 'blue' }], unit: '秒' }) : A.empty('还没有足够的记录', '网站使用一段时间后会显示走势。')) +
      '</section><section class="panel site-management-card site-table-panel"><div class="panel-heading">' +
      title(channel === 'browser' ? '哪些页面操作较慢' : '哪些操作在服务器处理较慢') + '</div>' +
      table('操作耗时', ['操作', '测得次数', '失败', '未通过检查', '近 95% 成功操作用时'],
        items.map(row => [e(activities[row.activity]), e(count(row.total)), e(count(row.failed)), e(count(row.blocked)), e(duration(row.p95))])) +
      '</section></div>';
  }
  function showDiagnostic(result) {
    const item = result?.item;
    if (!item) return A.empty('未找到这个编号', '请核对编号，或使用刚发生的报错编号。');
    const reasons = {
      blocked: ['本次操作未通过检查', '按原页面提示核对资料或登录状态，再试一次。'],
      failed: ['网站暂时未能完成操作', item.activity === 'order-save'
        ? '先到订单列表确认是否已有这笔订单，再决定是否提交。' : '请稍后重试，问题持续时请告知管理员。'],
      connection: ['连接中断或响应未完整收到', item.activity === 'order-save'
        ? '先到订单列表确认保存结果。' : '检查网络后再试。']
    };
    const checks = {
      identity: item.activity === 'login' ? ['登录资料未通过验证', '请核对账号和密码，或联系管理员。'] :
        ['登录状态需要重新确认', '请重新登录后再操作。'],
      access: ['当前账号没有操作权限', '请联系管理员核对权限。'],
      conflict: ['资料已变化或当前状态不能继续', '重新读取原记录，核对后再操作。'],
      limit: ['短时间尝试过多', '请稍等片刻后再试。'],
      timeout: ['网站等待其它服务超过时限', item.activity === 'order-save' ? '先到订单列表核对保存结果。' : '请稍后重试。']
    };
    const [reason, advice] = checks[item.reason] || reasons[item.result] || reasons.failed;
    const location = item.channel === 'server' ? '服务器处理' : '页面接收结果';
    return properties([['发生时间（北京）', time(item.at)], ['操作', activities[item.activity]], ['发生环节', location],
      ['当时版本', item.version ? '版本 ' + item.version.slice(0, 8) : '未取得'], ['原因', reason], ['建议', advice]]);
  }

  function sourceTable(rows) {
    return table('后台任务和同步', ['项目', '状态', '最近成功（北京）', '待处理', '说明', '查看'],
      (rows || []).filter(row => Object.hasOwn(sources, row.key)).map(row => {
        const [name, route] = sources[row.key];
        const problem = row.problem || (row.state === 'unknown' ? '尚未收到结果' : '—');
        const review = row.reviewPending > 0
          ? '<small>待人工核对 ' + e(count(row.reviewPending)) + ' 项' +
            (row.oldestReviewAt ? ' · 最早已知待处理于 ' + e(time(row.oldestReviewAt)) : '') + '</small>'
          : '';
        return [e(name), badge(sourceStates, row.state), e(time(row.lastSuccessAt)),
          e(row.pending === null || row.pending === undefined ? '未提供' : count(row.pending)),
          e(problem) + (row.oldestPendingAt && row.oldestPendingAt !== row.oldestReviewAt
            ? '<small>最早已知待处理于 ' + e(time(row.oldestPendingAt)) + '</small>' : '') + review,
          A.canVisit(route) ? link(route, '查看') : '—'];
      }));
  }
  function resourcesReport(report) {
    const latest = report.latest || {};
    const probe = report.externalProbe;
    const probeText = probe?.state === 'connected' ? '最近回报 ' + time(probe.at) :
      probe?.state === 'stale' ? '最近没有收到回报' : probe?.state === 'disabled' ? '尚未接通' : '待确认';
    const percent = value => Number.isFinite(value) ? value + '%' : '未取得';
    return '<div class="site-management-metrics site-management-resources">' + metric('服务器处理负荷', percent(latest.cpu)) +
      metric('内存使用', percent(latest.memory)) + metric('剩余存储空间', percent(latest.disk)) +
      metric('站外检测', probeText) + '</div>' + (latest.at ? '<p class="site-management-time">最近检查 ' + e(time(latest.at)) + '（北京）</p>' : '') +
      '<details class="site-management-details"><summary>查看最近 24 小时走势</summary>' +
      window.IDCharts.bars({ title: '服务器资源', rows: (report.trend || []).map(row => ({
        ...row, label: time(row.at), shortLabel: hour.format(row.at) + '时'
      })), series: [
        { key: 'cpu', label: '处理负荷', tone: 'blue' }, { key: 'memory', label: '内存使用', tone: 'violet' },
        { key: 'disk', label: '剩余存储空间', tone: 'teal' }
      ], unit: '%' }) + '</details>' +
      title('后台任务和同步') + sourceTable(report.sources);
  }
  function monitorResources() {
    if (!canRead()) return '';
    return '<div class="panel-body site-management-card" data-site-section="resources"><div data-site-progress role="status" hidden></div>' +
      title('网站运行情况') + '<p data-site-error class="inline-notice warning" role="alert" hidden></p><div data-site-content></div></div>';
  }

  function dataHealth(report) {
    const unknown = !report.coverage.inventory || !report.coverage.synchronization;
    const rows = report.items.map(row => [e(issues[row.type]), e(row.orderNo || '编号待核对'), e(row.product || '—'),
      e(time(row.at)), row.orderId ? link('orders/detail/' + encodeURIComponent(row.orderId), '查看订单') : link('orders/gpt/recharge-sync', '查看订单同步')]);
    return '<div class="site-management-grid"><section class="panel site-management-card site-table-panel"><div class="panel-heading">' +
      title('需要核对的资料', '系统检查明确关联的资料和已同步的订单。未填写的选填资料不计入。', 'site-health-help') +
      '<span class="site-management-time">检查于 ' + e(time(report.at)) + '（北京）</span></div>' +
      (unknown ? '<p class="panel-body site-management-time">部分来源还没有资料，检查范围可能不完整。</p>' : '') +
      (rows.length ? table('需要核对的资料', ['问题', '订单编号', '产品', '记录时间（北京）', '查看'], rows) :
        '<div class="panel-body">' + A.empty('当前检查范围内没有发现问题', '') + '</div>') +
      pagination({ id: 'site-health-list', total: report.total, page: report.page, pageSize: report.pageSize }) +
      '</section><section class="panel site-management-card site-table-panel"><div class="panel-heading">' +
      title('同步是否及时') + '</div>' + sourceTable(report.sources) + '</section></div>';
  }

  function backupReport(report) {
    const statuses = { connected: '已取得备份状态', stale: '最近没有收到备份状态', unknown: '尚未取得备份状态' };
    return '<div class="site-management-grid"><p class="site-management-time">' + e(statuses[report.collector]) +
      (report.sampledAt ? ' · 检查于 ' + e(time(report.sampledAt)) + '（北京）' : '') + '</p><div class="site-management-split">' +
      report.databases.map((row, i) => {
        const titleText = row.key === 'business' ? '网站业务资料' : '自动代充资料';
        return '<section class="panel panel-body site-management-card">' +
          title(titleText, '异地校验确认备份完整。恢复演练还需要读取恢复后的资料，才能确认可用。', 'site-backup-help-' + i) +
          badge(databaseStates, row.state) + properties([
            ['最近一份异地备份（北京）', time(row.capturedAt)], ['最近一次异地校验（北京）', time(row.verifiedAt)],
            ['最近一次成功恢复演练（北京）', row.exercise ? time(row.exercise.finishedAt) : '尚无通过记录'],
            ['演练恢复到（北京）', row.exercise ? time(row.exercise.capturedAt) : '未取得'],
            ['恢复用时', row.exercise ? duration(row.exercise.durationMs) : '未取得']
          ]) + '</section>';
      }).join('') + '</div></div>';
  }

  const selection = (id, label, choices, value) => '<div class="site-management-field"><label for="' + id + '">' + e(label) +
    '</label><select id="' + id + '" name="' + id + '">' + A.options(choices, value) + '</select></div>';
  function exportDates() {
    const { start, end, period } = exportView();
    return dateFilter.render({
      id: 'site-export-dates', label: '录入日期', value: period, from: start, to: end, all: true, allowOpen: true, compact: true,
      onSelect({ preset, from, to }) {
        const form = $('#site-export-form');
        if (!form) return;
        const current = captureExport(form);
        A.state.drafts.set(viewKey('export'), { ...current, period: preset, start: from, end: to });
        $('[data-site-export-dates]', form).innerHTML = exportDates();
      }
    });
  }
  function exportForm() {
    const { collection, status, product, detail } = exportView(), orders = collection === 'orders';
    const states = orders ? [['recorded', '已登记'], ['cancelled', '已撤销']] : [['active', '使用中'], ['inactive', '已停用']];
    return '<div class="site-management-grid"><section class="panel panel-body site-management-card">' +
      title('下载资料', '按北京时间的录入日期筛选。每次下载均留记录。', 'site-export-help') +
      '<form id="site-export-form"><div class="site-management-filters">' +
      selection('site-export-collection', '资料类型', [['customers', '客户'], ['orders', '订单']], collection) +
      selection('site-export-detail', '表格内容', [['masked', '简表（隐藏个人信息）'], ['business', '业务明细']], detail || 'masked') +
      '<div data-site-export-dates>' + exportDates() + '</div>' +
      selection('site-export-status', '状态', [['', '全部'], ...states], status) +
      (orders ? selection('site-export-product', '产品',
        [['', '全部'], ...['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'].map(value => [value, value])], product) : '') +
      '<button type="submit" class="button primary">下载表格</button>' +
      A.button('核对上次下载', 'site-export-recover', '', '', pendingExport() ? '' : 'hidden') +
      '</div><p data-site-export-result role="status" hidden></p></form></section>' +
      '<section class="panel panel-body site-management-card">' +
      title('资料保留期限', '此处展示现行规则和影响范围。业务记录的归档由管理员另外核对。', 'site-retention-help') +
      table('保留期限', ['资料', '保留多久', '影响范围'], [
        ['业务记录', '按现有业务规则保存', '客户和订单继续在原页面查看'],
        ['代充备份', '90 天', '定期备份，正式业务资料继续保留'],
      ].map(row => row.map(e))) + '</section></div>';
  }
  function information(report) {
    return '<section class="panel panel-body site-management-card">' + properties([
      ['站点', report.official ? '正式网站' : '测试环境'],
      ['正式访问地址', report.domain || '未取得'],
      ['业务时间', report.timeZone],
      ['当前网站版本', report.version ? '版本 ' + report.version.slice(0, 8) : '未取得'],
      ['最近更新时间（北京）', time(report.updatedAt)]
    ]) + '<div class="site-management-actions">' + link('settings/audit', '查看操作记录') +
      link('settings/login-logs', '查看登录记录') + '</div></section>';
  }
  const reports = { health: dataHealth, performance: performanceReport, backups: backupReport, information, resources: resourcesReport };

  function buttons(view) {
    if (view === 'performance') {
      const current = historyView(), { preset, channel } = current;
      return '<div class="toolbar list-filters site-management-toolbar"><div class="toolbar-left">' +
        dateFilter.render({
          id: 'site-time-range', label: '查看时段', value: preset, ...historyDates(current),
          min: dateFilter.range('month').from, max: dateFilter.range('today').to, compact: true,
          onSelect(next) {
            A.state.drafts.set(viewKey('performance'), { ...historyView(), ...next });
            A.render();
          }
        }) +
        selection('site-time-view', '查看内容', [['browser', '页面等待时间'], ['server', '服务器处理时间']], channel) +
        '</div></div>';
    }
    if (view !== 'health') return '';
    return '<div class="toolbar list-filters site-management-toolbar"><div class="toolbar-left">' +
      selection('site-health-kind', '问题类型', [['', '全部问题'], ...Object.entries(issues)], healthView().kind) +
      '</div></div>';
  }
  function render() {
    const view = currentView();
    const descriptions = {
      performance: '查看网站哪里变慢，并用诊断编号查找报错。',
      health: '核对订单之间的关联资料及同步情况。',
      backups: '查看异地备份、校验和最近的恢复演练。',
      export: '按条件下载资料，查看资料保留期限。',
      information: '查看正式网址、时间和正在运行的版本。'
    };
    const dataPage = A.state.route.startsWith('data/');
    const refresh = view === 'export' || !canRead() ? '' : A.button('刷新', 'site-refresh', '', 'refresh');
    const body = !canRead() ? '<section class="panel panel-body">' + A.empty('登录管理员账号后查看', '') + '</section>' :
      view === 'export' ? exportForm() : buttons(view) + '<div data-site-progress role="status" hidden></div>' +
        '<p class="inline-notice warning" data-site-error role="alert" hidden></p><div data-site-content></div>' +
        (view === 'performance' ? lookup() : '');
    return A.header(dataPage ? '数据中心' : labels[view], descriptions[view], refresh) +
      '<div class="site-management-grid" data-site-section="' + view + '">' +
      (dataPage ? A.modules.siteDataNavigation?.() || '' : '') + body + '</div>';
  }

  function regionFor(view) { return $('[data-site-section="' + view + '"]'); }
  const requests = new WeakMap();
  async function read(view, refresh = false) {
    const region = regionFor(view);
    if (!canRead() || !region?.isConnected) return true;
    const key = keyFor(view), scope = scopes[view], container = $('[data-site-content]', region);
    const notice = $('[data-site-error]', region), status = $('[data-site-progress]', region);
    const signature = JSON.stringify(key), request = {};
    const current = () => region.isConnected && canRead() && requests.get(region) === request &&
      signature === JSON.stringify(keyFor(view));
    requests.set(region, request);
    const previous = D.queries.peek(scope, key)?.data;
    const detailsOpen = Boolean(A.state.drafts.get(viewKey('resource-trend')));
    const update = result => {
      const focus = document.activeElement;
      const keepFocus = container.contains(focus);
      const focusId = keepFocus && focus.id;
      const detailsFocused = keepFocus && focus.tagName === 'SUMMARY';
      container.innerHTML = result ? reports[view](result) : '';
      if (view === 'resources') {
        const details = $('details', container);
        if (details) {
          details.open = detailsOpen;
          details.addEventListener('toggle', () => {
            if (details.isConnected) A.state.drafts.set(viewKey('resource-trend'), details.open);
          });
        }
        if (detailsFocused) details?.querySelector('summary')?.focus({ preventScroll: true });
      }
      if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    };
    if (container.dataset.siteKey !== signature || !container.firstElementChild) update(previous);
    else if (view === 'performance' && previous && container.dataset.channel !== historyView().channel) update(previous);
    if (view === 'performance') container.dataset.channel = historyView().channel;
    container.dataset.siteKey = signature;
    notice.hidden = true;
    const progress = A.beginRegionRead(region, status, { loadingText: previous ? '' : '正在读取…',
      refreshButton: view === 'resources' ? undefined : $('[data-action="site-refresh"]') });
    try {
      const result = await D.queries.read(scope, key, () => D.siteManagement({ view, ...key }), { refresh });
      if (current()) {
        update(result);
        if (view === 'health' && (result.page !== key.page || result.pageSize !== key.pageSize))
          A.state.drafts.set(viewKey('health'), { ...key, page: result.page, pageSize: result.pageSize });
      }
      return true;
    } catch (error) {
      if (!current()) return true;
      if (error.code === 'READ_SUPERSEDED') return false;
      const denied = [401, 403].includes(error.status);
      if (denied) update(null);
      notice.textContent = denied ? '当前账号无权查看此资料。' :
        previous ? '暂时无法更新。这里显示的是上次取得的资料。' : '暂时无法读取，请刷新重试。';
      notice.hidden = false;
      return false;
    } finally { progress.finish(); }
  }
  async function findDiagnostic(form) {
    const input = form.elements.diagnostic, id = input.value.trim().toLowerCase();
    const output = $('[data-site-diagnostic-result]', form.parentElement);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
      output.textContent = '请输入完整的诊断编号。';
      input.focus();
      return;
    }
    const button = $('button', form);
    if (button.disabled) return;
    const progress = A.beginActionFeedback(button, '正在查找…');
    try {
      const result = await D.queries.read(scopes.diagnostic, { id }, () => D.siteManagement({ view: 'diagnostic', id }), { refresh: true });
      if (form.isConnected && (input.value.trim().toLowerCase() === id)) output.innerHTML = showDiagnostic(result);
    } catch {
      if (form.isConnected) output.textContent = '暂时无法查找，请重试。';
    } finally { progress.finish(); }
  }

  const exportSource = $('meta[name="id-data-source"]')?.content || '';
  let exportPending = false;
  function exportKey() {
    if (!canRead() || !A.state.actor?.id) return '';
    return 'id-site-export:' + encodeURIComponent(exportSource) + ':' + encodeURIComponent(A.state.actor.id);
  }
  function pendingExport(key = exportKey()) {
    if (!key) return null;
    try {
      const item = JSON.parse(sessionStorage.getItem(key));
      if (/^[A-Za-z0-9_-]{16,120}$/.test(item?.id || '') &&
          ['customers', 'orders'].includes(item.filter?.collection)) return item;
    } catch {}
    return null;
  }
  function setPendingExport(key, request) {
    if (!key) return false;
    try {
      if (request) sessionStorage.setItem(key, JSON.stringify(request));
      else sessionStorage.removeItem(key);
      return true;
    } catch { return false; }
  }
  function captureExport(form) {
    const value = name => $('#site-export-' + name, form)?.value || '';
    const prior = exportView(), collection = value('collection');
    const dates = prior.period === 'custom' ? { from: prior.start, to: prior.end } : dateFilter.range(prior.period);
    const next = { collection, start: dates.from, end: dates.to,
      status: collection === prior.collection ? value('status') : '', product: collection === 'orders' ? value('product') : '',
      ...(value('detail') === 'business' && { detail: 'business' }) };
    A.state.drafts.set(viewKey('export'), { ...next, period: prior.period });
    return next;
  }
  async function exportData(form, retryButton) {
    if (exportPending) return;
    const key = exportKey(), previous = pendingExport(key);
    if (retryButton && !previous) return;
    const filter = retryButton ? previous.filter : captureExport(form);
    const target = $('[data-site-export-result]', form);
    const recover = $('[data-action="site-export-recover"]', form);
    const show = message => { target.textContent = message; target.hidden = false; };
    if (filter.start && filter.end && filter.start > filter.end) {
      show('结束日期应在开始日期当天或之后。');
      return;
    }
    if (previous && !retryButton && JSON.stringify(previous.filter) !== JSON.stringify(filter)) {
      show('有一次下载待核对，请先核对上次下载。');
      return;
    }
    const request = previous || { filter, id: crypto.randomUUID() };
    if (!previous && !setPendingExport(key, request)) {
      show('无法保留下载编号。请允许此站点使用会话存储后再下载。');
      return;
    }
    exportPending = true;
    recover.hidden = false;
    const progress = A.beginActionFeedback(retryButton || $('button[type="submit"]', form), '正在准备下载…');
    const isCurrent = () => form.isConnected && currentView() === 'export' && exportKey() === key;
    try {
      const { content, count: total } = await D.siteExport(request.filter, request.id);
      if (!isCurrent()) return;
      const url = URL.createObjectURL(content), file = document.createElement('a');
      file.href = url;
      file.download = (request.filter.collection === 'orders' ? '订单' : '客户') +
        (request.filter.detail === 'business' ? '-明细.csv' : '-脱敏.csv');
      document.body.append(file);
      file.click();
      file.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPendingExport(key, null);
      recover.hidden = true;
      show('已生成 ' + count(total) + ' 条资料。');
    } catch (error) {
      const rejected = [400, 403, 409, 410, 413].includes(error.status);
      if (rejected) setPendingExport(key, null);
      if (isCurrent()) {
        recover.hidden = rejected;
        show(rejected ? error.message : '下载结果待核对，请点击「核对上次下载」。');
      }
    } finally { exportPending = false; progress.finish(); }
  }

  A.modules.siteManagement = { monitorResources, mountResources: () => { void read('resources'); } };
  window.IDDesignModules.push({
    id: 'site-management', matches: route => Object.hasOwn(routes, route), sharedBusinessData: false, render,
    afterRender: () => { if (reports[currentView()]) void read(currentView()); },
    clearPageState() {
      for (const key of ['health', 'performance', 'diagnostic', 'export', 'resource-trend']) A.state.drafts.delete(viewKey(key));
    },
    onDataChanges(scopesChanged) {
      const changed = name => scopesChanged.includes(name);
      if (regionFor('resources') && changed('site-resources')) return read('resources', true);
      if (currentView() === 'performance' && changed('site-observations')) return read('performance', true);
      if (currentView() === 'health' && ['commerce', 'inventory', 'order-sync'].some(changed)) return read('health', true);
      if (currentView() === 'backups' && changed('site-backups')) return read('backups', true);
    },
    onClick(action, node) {
      if (action === 'site-export-recover') {
        void exportData(node.form, node);
        return true;
      }
      if (action !== 'site-refresh' || !reports[currentView()]) return false;
      void read(currentView(), true);
      return true;
    },
    onChange(node) {
      if (node.id === 'site-time-view') {
        A.state.drafts.set(viewKey('performance'), { ...historyView(), channel: node.value });
        void read('performance');
        return true;
      }
      if (node.id === 'site-health-kind') {
        A.state.drafts.set(viewKey('health'), { ...healthView(), kind: node.value, page: 1 });
        void read('health');
        return true;
      }
      const form = node.closest('#site-export-form');
      if (!form) return false;
      captureExport(form);
      if (node.id === 'site-export-collection') {
        A.render();
        $('#site-export-collection')?.focus({ preventScroll: true });
      }
      return true;
    },
    onInput(node) {
      if (node.id === 'site-diagnostic-id') {
        A.state.drafts.set(viewKey('diagnostic'), node.value);
        $('[data-site-diagnostic-result]', node.form.parentElement).replaceChildren();
        return true;
      }
      return false;
    },
    onSubmit(form) {
      if (form.id === 'site-diagnostic-form') { void findDiagnostic(form); return true; }
      if (form.id === 'site-export-form') { void exportData(form); return true; }
      return false;
    }
  });
  document.addEventListener('id-pagination-change', event => {
    const { id, page, pageSize } = event.detail;
    if (id !== 'site-health-list' || currentView() !== 'health' || !event.target.closest('[data-site-section="health"]')) return;
    A.state.drafts.set(viewKey('health'), { ...healthView(), page, pageSize });
    void read('health');
  });
})();
