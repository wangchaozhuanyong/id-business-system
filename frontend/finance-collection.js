(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData, route = 'settings/exchange-rates';
  const e = A.esc, $ = selector => document.querySelector(selector);
  const labels = {
    USD: '美元 USD', MYR: '马币 MYR', PHP: '菲律宾比索 PHP',
    CLP: '智利比索 CLP', IDR: '印尼盾 IDR', EGP: '埃及镑 EGP'
  };
  const states = { running: '采集中', updated: '成功且有更新', unchanged: '成功但无变化', partial: '部分失败', failed: '失败',
    valid: '有效', expired: '已过期', missing: '缺少报价' };
  const modes = { automatic: '自动采集', manual: '手动采集', order: '订单取价' };
  const tabs = [['rates', '当前汇率'], ['runs', '采集记录'], ['settings', '采集设置'], ['status', '运行状态']];
  const viewKey = 'finance-collection-view', draftKey = 'finance-collection-settings';
  const defaultPageSize = window.IDPagination.defaultPageSize;
  let data, loading = false, saving = false, error = '', lastKey = '', sequence = 0, lifetime = 0, searchTimer, expiryTimer;
  function view() {
    if (!A.state.drafts.has(viewKey)) A.state.drafts.set(viewKey, { tab: 'rates', query: '', currency: '', status: '', mode: '', from: '', to: '', page: 1, pageSize: defaultPageSize });
    return A.state.drafts.get(viewKey);
  }
  const active = () => A.state.route === route && (!D?.authRequired || ['admin', 'super'].includes(D.actor()?.role));
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
  const source = value => value === 'disabled' ? '尚未启用' : value === 'exchange-rate-api-open' ? 'ExchangeRate-API（历史来源）' : 'Fawaz Currency API';
  const badge = value => A.tag(states[value] || '待核对', ['valid', 'updated', 'unchanged'].includes(value) ? 'success' : ['failed', 'expired'].includes(value) ? 'danger' : 'warning');
  function params() {
    const v = view();
    return { tab: v.tab, query: v.query, currency: v.currency, status: v.status, mode: v.mode, from: v.from, to: v.to,
      page: String(A.state.page), pageSize: String(A.state.pageSize) };
  }
  function preserveDraft() {
    if (!active()) return;
    Object.assign(view(), { page: A.state.page, pageSize: A.state.pageSize });
    const form = $('#fx-settings-form');
    if (form && form.dataset.fxSaved !== 'true') A.state.drafts.set(draftKey, readSettings(form));
  }
  function readSettings(form) {
    const raw = Object.fromEntries(new FormData(form));
    raw['fx-interval'] = form.querySelector('#fx-interval').value;
    raw.currencies = [...form.querySelectorAll('[name="fx-currencies"]:checked')].map(node => node.value);
    raw.enabled = form.querySelector('#fx-enabled').checked;
    return raw;
  }
  async function load(refresh = false) {
    if (!active() || !D) return false;
    const parameters = params(), key = JSON.stringify(parameters);
    if (loading && key === lastKey) return false;
    if (!refresh && error && key === lastKey) return false;
    const cached = D.queries.peek('finance-rates', parameters);
    if (!refresh && data && key === lastKey && cached && !cached.stale) return true;
    preserveDraft();
    const token = ++sequence, epoch = lifetime;
    const latest = () => token === sequence && epoch === lifetime;
    const current = () => latest() && active() && key === JSON.stringify(params());
    lastKey = key; loading = true; error = '';
    const progress = $('#fx-progress'); if (progress) { progress.hidden = false; progress.setAttribute('aria-label', '正在更新汇率资料'); }
    try {
      const result = await D.queries.read('finance-rates', parameters,
        () => D.financeCollection(parameters).then(value => ({ ...value, receivedAt: performance.now() })), { refresh });
      if (!current()) return false;
      if (!result?.settings || !result.state || !Array.isArray(result.rows) || !Array.isArray(result.metrics))
        throw new Error('汇率资料响应不完整，请重新读取');
      data = { ...result, tab: parameters.tab }; A.state.page = result.page; view().page = result.page; view().total = result.total;
      lastKey = JSON.stringify({ ...parameters, page: String(result.page) });
      return true;
    } catch (failure) {
      if (!current()) return false;
      if (failure.code === 'READ_SUPERSEDED') {
        loading = false;
        return load(refresh);
      }
      error = failure.message || '读取失败，请重试';
      return false;
    } finally {
      if (latest()) {
        loading = false;
        if (active()) A.render();
      }
    }
  }
  function overview() {
    const state = data.state, settings = data.settings;
    const status = state.active ? '采集中' : settings.provider === 'disabled' ? '来源未启用' : !settings.enabled ? '自动采集已暂停'
      : state.failures ? '采集异常，等待重试或下轮计划' : data.validCount === data.currencyCount ? '运行正常' : '等待有效报价';
    return '<section class="panel fx-overview">' + [
      ['运行状态', status], ['最近成功', time(state.lastSuccessAt)],
      ['下次采集', state.active ? '当前任务完成后安排' : time(data.scheduledAt)],
      ['有效币种', data.validCount + ' / ' + data.currencyCount]
    ].map(([label, value]) => '<div><span>' + e(label) + '</span><strong>' + e(value) + '</strong></div>').join('') + '</section>';
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!data?.nextExpiryAt || !Number.isFinite(data.receivedAt)) return;
    const remaining = Date.parse(data.nextExpiryAt) - Date.parse(data.now) - (performance.now() - data.receivedAt);
    if (!Number.isFinite(remaining)) return;
    expiryTimer = setTimeout(() => {
      D.queries.invalidate(['finance-rates']);
      // This is one known expiry boundary, never a periodic list refresh.
      // Active editing keeps the last view until the user leaves the form.
      if (active() && !document.querySelector('#fx-settings-form, #confirm-dialog[open], #drawer[open], .row-action-menu:popover-open')) void load(true);
    }, Math.max(10, Math.min(2_147_000_000, remaining)));
  }
  function toolbar() {
    const v = view(), history = v.tab === 'history' || v.tab === 'settings-history', records = v.tab === 'runs';
    let filters = A.input('fx-query', v.query, 'type="search" placeholder="搜索币种、任务编号或人员" aria-label="搜索汇率记录" maxlength="120"') +
      '<select id="fx-filter-currency" aria-label="筛选币种">' + A.options([['', '全部币种'], ...Object.entries(labels)], v.currency) + '</select>';
    if (!history) filters += '<select id="fx-filter-status" aria-label="筛选结果">' + A.options([['', '全部结果'],
      ...Object.entries(states).filter(([key]) => records ? ['running', 'updated', 'unchanged', 'partial', 'failed'].includes(key) : ['valid', 'expired', 'missing'].includes(key))], v.status) + '</select>';
    if (records) filters += '<select id="fx-filter-mode" aria-label="筛选采集方式">' + A.options([['', '全部方式'], ...Object.entries(modes)], v.mode) + '</select>';
    if (records || history) filters += '<label class="fx-date">开始日期' + A.input('fx-from', v.from, 'type="date" aria-label="开始日期"') + '</label>' +
      '<label class="fx-date">结束日期' + A.input('fx-to', v.to, 'type="date" aria-label="结束日期"') + '</label>';
    return '<div class="toolbar fx-toolbar"><div class="toolbar-left">' + filters + '</div><div class="toolbar-right" data-page-actions>' +
      A.button(history ? v.tab === 'settings-history' ? '返回采集设置' : '返回当前汇率' : '清空筛选', history ? v.tab === 'settings-history' ? 'fx-settings' : 'fx-rates' : 'fx-clear') +
      (!records && !history ? A.button('历史报价', 'fx-history') : '') +
      A.button('列设置', 'column-settings', '', 'columns', 'data-table-id="' + e('fx-' + v.tab) + '"') + '</div></div>';
  }
  function table() {
    const v = view();
    let columns;
    if (v.tab === 'settings-history') columns = [
      { id: 'at', label: '修改时间', render: row => e(time(row.at)) },
      { id: 'actorName', label: '修改人' },
      { id: 'version', label: '设置版本', render: row => e(row.before.version + ' → ' + row.after.version) },
      { id: 'actions', label: '操作', action: true, render: row => A.textAction('查看变更', 'fx-detail', 'data-id="' + e(row.id) + '"') }
    ];
    else if (v.tab === 'runs') columns = [
      { id: 'id', label: '任务编号' }, { id: 'mode', label: '采集方式', render: row => e(modes[row.mode] || '待核对') },
      { id: 'status', label: '采集结果', render: row => badge(row.status) },
      { id: 'startedAt', label: '开始时间', render: row => e(time(row.startedAt)) },
      { id: 'durationMs', label: '耗时', render: row => row.durationMs === undefined ? '—' : e(row.durationMs) + ' 毫秒' },
      { id: 'currencies', label: '采集币种', render: row => e(row.currencies.map(code => labels[code]).join('、')) },
      { id: 'updatedCount', label: '新增报价数' }, { id: 'actorName', label: '操作人' },
      { id: 'actions', label: '操作', action: true, render: row => A.textAction('详情', 'fx-detail', 'data-id="' + e(row.id) + '"') }
    ];
    else if (v.tab === 'history') columns = [
      { id: 'at', label: '报价时间', render: row => e(time(row.at)) },
      { id: 'fetchedAt', label: '首次采集', render: row => e(time(row.fetchedAt)) },
      { id: 'lastSeenAt', label: '最近确认', render: row => e(time(row.lastSeenAt)) },
      { id: 'expiresAt', label: '有效截止', render: row => e(time(row.expiresAt)) },
      { id: 'source', label: '来源' },
      { id: 'actions', label: '操作', action: true, render: row => A.textAction('查看报价', 'fx-detail', 'data-id="' + e(row.id) + '"') }
    ];
    else columns = [
      { id: 'currency', label: '币种', render: row => e(labels[row.currency]) },
      { id: 'rate', label: '每 1 原币兑人民币', render: row => e(row.rate || '—') },
      { id: 'source', label: '来源', render: row => e(row.source || '—') },
      { id: 'at', label: '报价时间', render: row => e(time(row.at)) },
      { id: 'fetchedAt', label: '采集时间', render: row => e(time(row.fetchedAt)) },
      { id: 'expiresAt', label: '有效截止', render: row => e(time(row.expiresAt)) },
      { id: 'status', label: '状态', render: row => badge(row.status) }
    ];
    const tableData = D.queries.peek('finance-rates', params())?.data ||
      (data.tab === v.tab ? data : { rows: [], total: 0, page: 1, pageSize: A.state.pageSize });
    return toolbar() + A.table(columns, tableData.rows, '', 'fx-' + v.tab, {
      title: '暂无符合条件的汇率记录', description: '可调整筛选条件，或完成首次采集。'
    }) + A.pagination(tableData.total, { page: tableData.page, pageSize: tableData.pageSize });
  }
  function settingsForm() {
    const s = data.settings;
    const d = A.state.drafts.get(draftKey) || { 'fx-version': String(s.version), 'fx-provider': s.provider,
      'fx-schedule': s.schedule, 'fx-interval': String(s.intervalMinutes), 'fx-quotes-days': String(s.quoteRetentionDays),
      'fx-runs-days': String(s.runRetentionDays), 'fx-retries': String(s.retryAttempts), enabled: s.enabled, currencies: s.currencies };
    const field = (label, id, control, help = '') => A.field(label, id, control, true, help);
    const numeric = (label, id, min, max, help = '', unit = '') => field(label, id, '<div class="fx-unit">' +
      A.input(id, d[id], 'type="number" min="' + min + '" max="' + max + '" step="1" required ' + (id === 'fx-interval' && d['fx-schedule'] === 'source' ? 'disabled' : '')) +
      (unit ? '<span>' + e(unit) + '</span>' : '') + '</div>', help);
    const picker = '<button class="button fx-currency-trigger" id="fx-currencies" type="button" data-action="fx-currencies" aria-haspopup="dialog" aria-expanded="false" aria-controls="fx-currency-popover">已选择 ' + d.currencies.length + ' 个币种</button>' +
      '<div class="fx-currency-popover" id="fx-currency-popover" popover="auto" role="dialog" aria-label="选择采集币种">' +
      '<input id="fx-currency-search" type="search" placeholder="搜索币种" aria-label="搜索采集币种" autocomplete="off" />' +
      '<div class="fx-currency-options">' + Object.entries(labels).map(([code, label]) => '<label><input type="checkbox" name="fx-currencies" value="' + code + '" ' + (d.currencies.includes(code) ? 'checked' : '') + ' />' + e(label) + '</label>').join('') + '</div><span id="fx-currency-empty" hidden>没有匹配币种</span></div>';
    return '<form id="fx-settings-form" class="form-panel" novalidate><input type="hidden" name="fx-version" value="' + e(d['fx-version']) + '" /><div class="form-grid">' +
      field('汇率来源', 'fx-provider', A.select('fx-provider', [['disabled', '暂不启用'], ['currency-api', 'Fawaz Currency API（每日报价）']], d['fx-provider']), '当前来源按天更新，采集频率不等于报价更新频率。') +
      A.field('自动采集', 'fx-enabled', '<label class="checkbox-label"><input id="fx-enabled" name="fx-enabled" type="checkbox" ' + (d.enabled ? 'checked' : '') + ' /><span>启用后台采集</span></label>', false, '服务器后台执行，关闭浏览器仍继续；暂停后保留报价与订单快照。') +
      field('采集方式', 'fx-schedule', A.select('fx-schedule', [['source', '跟随来源更新时间'], ['interval', '固定时间间隔']], d['fx-schedule'])) +
      numeric('采集间隔', 'fx-interval', 60, 10080, '固定间隔时使用；最短 60 分钟。跟随来源更新时间时此项不参与调度。', '分钟') +
      field('采集币种', 'fx-currencies', picker, '人民币基准固定为 1；取消订单或费用规则所需币种后，缺少报价的订单保留待核算。') +
      numeric('失败重试', 'fx-retries', 0, 3, '普通失败按 1、5、15 分钟退避；来源限流至少冷却 20 分钟。', '次') +
      numeric('报价保留', 'fx-quotes-days', 7, 3650, '超过期限的非引用报价进入待清理范围；已冻结的订单报价依据继续保留。', '天') +
      numeric('记录保留', 'fx-runs-days', 7, 365, '到期记录可预览并确认清理，不会删除订单、财务流水或订单快照。', '天') +
      '</div><p id="fx-settings-error" class="field-error" role="alert" hidden></p><div class="form-footer">' +
      A.button('设置变更记录', 'fx-settings-history') + A.button('核对最新设置', 'fx-rebase') + '<button type="submit" class="button primary" ' + (saving ? 'disabled' : '') + '>保存采集设置</button></div></form>' +
      '<section class="form-panel"><div class="section-title-row"><h2>过期记录清理</h2>' + A.titleInfo('过期记录清理', '只清理已超过保留期限且未被订单引用的报价与任务记录。先预览数量，再确认执行；订单快照不受影响。', 'fx-retention-help') + '</div><div class="toolbar"><span>待清理报价 ' + data.cleanup.quoteCount + ' 批，采集记录 ' + data.cleanup.runCount + ' 条</span><div class="toolbar-right">' + A.button('预览清理', 'fx-cleanup-preview', '', '', saving ? 'disabled' : '') + '</div></div></section>';
  }
  function statusContent() {
    return '<div class="form-panel"><div class="form-grid">' + data.metrics.map(metric => '<section class="guide-item"><h2>近 ' + metric.days + ' 天</h2><dl class="definition-list"><dt>已完成任务</dt><dd>' + metric.total + '</dd><dt>成功率</dt><dd>' + (metric.successPercent === null ? '暂无记录' : metric.successPercent + '%') + '</dd><dt>失败或部分失败</dt><dd>' + metric.failed + '</dd><dt>九成五任务耗时</dt><dd>' + (metric.p95Ms === null ? '—' : metric.p95Ms + ' 毫秒') + '</dd></dl></section>').join('') + '</div><dl class="definition-list section-gap"><dt>汇率来源</dt><dd>' + e(source(data.settings.provider)) + '</dd><dt>来源更新频率</dt><dd>每日更新</dd><dt>连续失败</dt><dd>' + data.state.failures + ' 次</dd><dt>下次重试</dt><dd>' + e(time(data.state.retryAt)) + '</dd><dt>限流冷却截止</dt><dd>' + e(time(data.state.cooldownUntil)) + '</dd><dt>最近结果</dt><dd>' + e(data.latest ? states[data.latest.status] : '尚未采集') + '</dd><dt>最近失败原因</dt><dd>' + e(data.latest?.error || Object.values(data.latest?.errors || {}).join('、') || '—') + '</dd></dl></div>';
  }
  function render() {
    const title = A.header('汇率采集', '管理后台采集计划、有效报价及运行记录。历史订单沿用自己的汇率快照。');
    if (!D) return title + '<section class="panel">' + A.empty('需连接业务数据服务', '此设计页没有连接真实采集服务。') + '</section>';
    if (!data) return title + '<section class="panel design-state-panel" aria-busy="' + loading + '">' + A.empty(error ? '汇率资料读取失败' : '正在读取汇率资料', error || '') + '<div class="design-state-actions">' + A.button('重新读取', 'fx-refresh') + '</div></section>';
    const tab = view().tab;
    const selectedTab = tab === 'history' ? 'rates' : tab === 'settings-history' ? 'settings' : tab;
    const nav = '<div class="tabs" role="tablist" aria-label="汇率采集栏目">' + tabs.map(([key, label]) => '<button class="tab ' + (selectedTab === key ? 'active' : '') + '" type="button" role="tab" aria-selected="' + (selectedTab === key) + '" data-action="fx-tab" data-tab="' + key + '">' + label + '</button>').join('') + '</div>';
    return title + '<div class="fx-page design-async-region"><div id="fx-progress" class="design-region-progress" role="status" ' + (loading ? '' : 'hidden') + '></div>' + overview() +
      (error ? '<div class="inline-notice warning" role="alert">' + e(error) + A.button('重新读取', 'fx-refresh') + '</div>' : '') +
      '<section class="panel">' + nav + '<div class="toolbar fx-main-actions"><span class="footnote">汇率来源：' + e(source(data.settings.provider)) + '</span><div class="toolbar-right">' + A.button('刷新记录', 'fx-refresh', '', 'refresh') +
      A.button(data.state.active ? '正在采集' : '立即采集', 'fx-collect', 'primary', '', saving || data.state.active || data.settings.provider === 'disabled' ? 'disabled' : '') + '</div></div>' +
      (tab === 'settings' ? settingsForm() : tab === 'status' ? statusContent() : table()) + '</section></div>';
  }
  function switchTab(tab) {
    preserveDraft();
    clearTimeout(searchTimer);
    const v = view(), { query, currency, status, mode, from, to, page, pageSize, total } = v;
    (v.tabs ||= {})[v.tab] = { query, currency, status, mode, from, to, page, pageSize, total };
    Object.assign(v, { query: '', currency: '', status: '', mode: '', from: '', to: '', page: 1, pageSize: defaultPageSize, total: 0 },
      v.tabs[tab], { tab });
    A.state.page = v.page; A.state.pageSize = v.pageSize; lastKey = ''; error = ''; A.render();
  }
  async function perform(command, success) {
    if (saving) return;
    const epoch = lifetime;
    saving = true;
    const feedback = A.beginActionFeedback?.(null,
      command.action === 'collect' ? '正在采集汇率…' : '正在保存采集设置…');
    for (const button of document.querySelectorAll('#main button[data-action="fx-collect"], #fx-settings-form [type="submit"]')) button.disabled = true;
    try {
      const result = await D.financeCollectionAction(command);
      if (epoch !== lifetime) return;
      await success?.(result);
      await load(true);
    } catch (failure) {
      if (epoch !== lifetime) return;
      const target = $('#fx-settings-error');
      if (target) { target.textContent = failure.message; target.hidden = false; }
      else { error = failure.message; A.render(); }
    } finally {
      feedback?.finish();
      if (epoch === lifetime) {
        saving = false;
        for (const button of document.querySelectorAll('#fx-settings-form [type="submit"]')) button.disabled = false;
        const collect = $('#main button[data-action="fx-collect"]');
        if (collect) collect.disabled = data?.settings.provider === 'disabled' || Boolean(data?.state.active);
        const cleanup = $('#main button[data-action="fx-cleanup-preview"]');
        if (cleanup) cleanup.disabled = false;
      }
    }
  }
  function details(id) {
    const row = data.rows.find(row => row.id === id);
    if (!row) return;
    const configLabels = { provider: '汇率来源', enabled: '自动采集', schedule: '采集方式', intervalMinutes: '间隔（分钟）',
      currencies: '采集币种', quoteRetentionDays: '报价保留（天）', runRetentionDays: '记录保留（天）', retryAttempts: '失败重试次数' };
    const configValue = (key, value) => key === 'provider' ? source(value) : key === 'enabled' ? value ? '启用' : '暂停'
      : key === 'schedule' ? value === 'source' ? '跟随来源更新时间' : '固定时间间隔' : key === 'currencies' ? value.map(code => labels[code]).join('、') : value;
    const pairs = row.before ? [['修改人', row.actorName], ['修改时间', time(row.at)], ...Object.entries(configLabels)
      .filter(([key]) => JSON.stringify(row.before[key]) !== JSON.stringify(row.after[key]))
      .map(([key, label]) => [label, configValue(key, row.before[key]) + ' → ' + configValue(key, row.after[key])])]
      : row.rates ? Object.entries(row.rates).map(([code, rate]) => [code === 'CNY' ? '人民币 CNY' : labels[code], rate]) : [
      ['任务编号', row.id], ['采集方式', modes[row.mode]], ['结果', states[row.status]], ['开始时间', time(row.startedAt)],
      ['完成时间', time(row.finishedAt)], ['设置版本', row.settingsVersion], ['操作人', row.actorName],
      ['失败原因', row.error || '—'], ...Object.entries(row.errors || {}).map(([code, message]) => [labels[code], message])
    ];
    A.openDrawer(row.before ? '采集设置变更' : row.rates ? '历史汇率报价' : '采集任务详情', '采集记录与订单冻结快照分别保存。',
      '<div class="property-list">' + pairs.map(([label, value]) => '<div class="property-row"><span>' + e(label) + '</span><strong>' + e(value ?? '—') + '</strong></div>').join('') + '</div>', A.button('关闭', 'drawer-close'));
  }
  async function onClick(action, node) {
    if (!active() || !action.startsWith('fx-')) return false;
    if (action === 'fx-tab') switchTab(node.dataset.tab);
    else if (['fx-rates', 'fx-history', 'fx-settings', 'fx-settings-history'].includes(action))
      switchTab({ 'fx-rates': 'rates', 'fx-history': 'history', 'fx-settings': 'settings', 'fx-settings-history': 'settings-history' }[action]);
    else if (action === 'fx-clear') {
      Object.assign(view(), { query: '', currency: '', status: '', mode: '', from: '', to: '', page: 1 });
      A.state.page = 1; error = ''; lastKey = ''; A.render();
    }
    else if (action === 'fx-refresh') {
      preserveDraft();
      await A.withActionFeedback(node, () => load(true),
        { pending: '正在刷新汇率资料…', success: '汇率资料已刷新', failure: '汇率读取失败，已保留当前内容' });
    }
    else if (action === 'fx-rebase') {
      const form = $('#fx-settings-form'), epoch = lifetime;
      try {
        const latest = await D.financeCollection({ tab: 'settings', page: '1', pageSize: '8' });
        if (epoch !== lifetime || !form?.isConnected) return true;
        const original = form.elements['fx-version'].value;
        if (original === String(latest.settings.version)) { A.notify('当前草稿已基于最新设置'); return true; }
        A.confirmAction('核对采集设置版本', '服务器版本 ' + latest.settings.version + '，草稿版本 ' + original + '。服务器当前采集间隔 ' + latest.settings.intervalMinutes + ' 分钟、选中 ' + latest.settings.currencies.length + ' 个币种。确认后保留当前输入，以最新版本校验；不会立即保存。', () => {
          if (epoch !== lifetime || !form.isConnected || form.elements['fx-version'].value !== original) return;
          form.elements['fx-version'].value = String(latest.settings.version);
          const feedback = $('#fx-settings-error'); if (feedback) feedback.hidden = true;
          preserveDraft(); A.notify('版本已核对，请检查输入后再保存');
        }, '保留输入并核对');
      } catch (failure) { if (epoch === lifetime) A.notify(failure.message); }
    }
    else if (action === 'fx-collect') await perform({ action: 'collect' }, result => A.notify(result.run?.status === 'failed' || result.run?.status === 'partial' ? '采集存在异常，请查看采集记录' : '本轮采集已完成'));
    else if (action === 'fx-detail') details(node.dataset.id);
    else if (action === 'fx-currencies') {
      const popup = $('#fx-currency-popover');
      if (popup.matches(':popover-open')) popup.hidePopover();
      else {
        popup.showPopover();
        const width = Math.min(340, innerWidth - 24), height = popup.getBoundingClientRect().height, box = node.getBoundingClientRect();
        popup.style.width = width + 'px';
        popup.style.left = Math.max(12, Math.min(box.left, innerWidth - width - 12)) + 'px';
        popup.style.top = Math.max(12, Math.min(box.bottom + 6, innerHeight - height - 12)) + 'px';
        $('#fx-currency-search').focus();
      }
      node.setAttribute('aria-expanded', String(popup.matches(':popover-open')));
    } else if (action === 'fx-cleanup-preview') {
      try {
        const preview = await D.financeCollectionAction({ action: 'cleanup-preview' });
        A.confirmAction('确认清理过期采集记录', '本次清理 ' + preview.quoteCount + ' 批非引用报价、' + preview.runCount + ' 条采集记录。不会删除订单和订单快照。范围变化后需要重新预览。',
          () => perform({ action: 'cleanup', preview, confirm: true }, () => A.notify('过期采集记录已清理')), '确认清理');
      } catch (failure) { A.notify(failure.message); }
    }
    return true;
  }
  async function onSubmit(form) {
    if (form.id !== 'fx-settings-form' || !active()) return false;
    if (saving) return true;
    preserveDraft();
    const raw = readSettings(form);
    for (const input of form.querySelectorAll('input[type="number"]')) if (!input.validity.valid) {
      A.setError(input.id, '请填写 ' + input.min + '–' + input.max + ' 范围内的整数'); input.focus(); return true;
    }
    if (!raw.currencies.length) { A.setError('fx-currencies', '至少选择一个采集币种'); return true; }
    const settings = { provider: raw['fx-provider'], enabled: raw.enabled, schedule: raw['fx-schedule'], intervalMinutes: Number(raw['fx-interval']),
      currencies: raw.currencies, quoteRetentionDays: Number(raw['fx-quotes-days']), runRetentionDays: Number(raw['fx-runs-days']), retryAttempts: Number(raw['fx-retries']) };
    const serialized = JSON.stringify(raw), epoch = lifetime;
    A.confirmAction('保存汇率采集设置', '设置只影响后续采集。未采集的订单所需币种将保留待核算；保留期限变化不会自动删除订单依据，清理需另行预览确认。',
      () => {
        if (epoch !== lifetime) return;
        return perform({ action: 'settings', version: Number(raw['fx-version']), settings }, result => {
          if (data && result.settings.version >= data.settings.version) {
            data = { ...data, settings: result.settings };
          }
          const currentForm = $('#fx-settings-form');
          const current = currentForm ? readSettings(currentForm) : A.state.drafts.get(draftKey);
          if (JSON.stringify(current) === serialized) A.state.drafts.delete(draftKey);
          else if (current?.['fx-version'] === raw['fx-version']) {
            current['fx-version'] = String(result.settings.version); A.state.drafts.set(draftKey, current);
          }
          if (currentForm) currentForm.elements['fx-version'].value = String(result.settings.version);
          // The next read must not capture the already-saved old form again.
          if (currentForm && JSON.stringify(current) === serialized) currentForm.dataset.fxSaved = 'true';
          A.notify('采集设置已保存');
        });
      }, '确认保存');
    return true;
  }
  function onChange(node) {
    if (!active()) return false;
    if (node.closest('#fx-settings-form')) {
      delete $('#fx-settings-form').dataset.fxSaved;
      if (node.id === 'fx-schedule') $('#fx-interval').disabled = node.value === 'source';
      preserveDraft();
      if (node.name === 'fx-currencies') $('#fx-currencies').textContent = '已选择 ' + readSettings($('#fx-settings-form')).currencies.length + ' 个币种';
      return true;
    }
    const key = { 'fx-filter-currency': 'currency', 'fx-filter-status': 'status', 'fx-filter-mode': 'mode', 'fx-from': 'from', 'fx-to': 'to' }[node.id];
    if (!key) return false;
    view()[key] = node.value; A.state.page = 1; view().page = 1; void load(); return true;
  }
  function onInput(node) {
    if (!active()) return false;
    if (node.id === 'fx-currency-search') {
      const terms = node.value.trim().toLocaleLowerCase().split(/\s+/);
      let visible = 0;
      for (const label of document.querySelectorAll('.fx-currency-options label')) {
        label.hidden = !terms.every(term => label.textContent.toLocaleLowerCase().includes(term));
        if (!label.hidden) visible++;
      }
      $('#fx-currency-empty').hidden = visible > 0; return true;
    }
    if (node.closest('#fx-settings-form')) { delete $('#fx-settings-form').dataset.fxSaved; preserveDraft(); return true; }
    if (node.id !== 'fx-query') return false;
    view().query = node.value; A.state.page = 1; view().page = 1;
    clearTimeout(searchTimer); searchTimer = setTimeout(() => void load(), 250); return true;
  }
  window.IDDesignModules.push({ id: 'finance-collection', matches: value => value === route, render, preserveDraft: () => {
    const form = $('#fx-settings-form'); if (form?.dataset.fxSaved === 'true') return;
    preserveDraft();
  }, onClick, onSubmit, onChange, onInput,
  afterRender({ routeChanged } = {}) {
    if (!active()) return;
    const popup = $('#fx-currency-popover');
    if (popup) popup.ontoggle = () => $('#fx-currencies')?.setAttribute('aria-expanded', String(popup.matches(':popover-open')));
    if (routeChanged) {
      A.state.page = view().page || 1;
      A.state.pageSize = view().pageSize || defaultPageSize;
    }
    scheduleExpiry();
    void load();
  },
  onDataChanges(scopes) { if (active() && scopes.includes('finance-rates')) return load(true); },
  clearPageState() { sequence++; lifetime++; data = undefined; lastKey = ''; loading = false; saving = false; error = ''; clearTimeout(searchTimer); clearTimeout(expiryTimer); }
  });
  window.addEventListener('resize', () => $('#fx-currency-popover:popover-open')?.hidePopover());
})();
