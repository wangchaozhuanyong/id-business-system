(() => {
  'use strict';
  const A = window.IDDesignAPI, D = window.IDLocalData, e = A.esc, $ = A.$;
  const { defaultPageSize, pageSizes } = window.IDPagination;
  const settingsRoute = 'settings/monitoring';
  const namespace = 'system-monitoring';
  const draftKey = namespace + ':configuration';
  const listViewKey = namespace + ':list';
  const tabKey = namespace + ':tab';
  const checksKey = namespace + ':checks';
  const viewKey = namespace + ':view';
  const monitorView = () => A.state.drafts.get(viewKey) || 'checks';
  const checks = { ok: '正常', bad: '异常', watch: '观察中', unknown: '未知', disabled: '未启用' };
  const delivery = { queued: '等待发送', sending: '正在发送', accepted: 'Telegram 已接收', failed: '投递失败',
    unknown: '结果待核对', cancelled: '配置变化，已取消' };
  const incidentDelivery = { ...delivery, partial: '部分接收', no_record: '无投递记录',
    external_unknown: '站外投递待核对', queue_full: '投递队列已满' };
  const notificationLabels = { disabled: '未启用', inactive: '无启用规则', unready: '待接通', partial: '部分接通', ready: '已就绪' };
  const sourceLinks = {
    login_abuse: ['查看登录日志', 'settings/login-logs'], sensitive_reads: ['查看操作记录', 'settings/audit'],
    recharge_runtime: ['打开代充后台', 'online-recharge/chatgpt'],
    recharge_review: ['打开代充后台', 'online-recharge/chatgpt'],
    recharge_stuck: ['打开代充后台', 'online-recharge/chatgpt'],
    recharge_burst: ['打开代充后台', 'online-recharge/chatgpt'],
    exchange_rates: ['查看汇率采集', 'settings/exchange-rates'], mailbox: ['查看邮箱查询与邮箱池', 'plugins/mailboxes']
  };
  const phases = { native: '原代充继续发送', switching: '接管结果待核对', managed: '已由系统统一发送' };
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short',
    timeStyle: 'medium', hourCycle: 'h23' });
  const time = at => at ? timeFormat.format(at) : '—';
  const settingsPage = () => A.state.route === settingsRoute;
  const local = () => D?.authRequired && ['admin', 'super'].includes(A.state.actor?.role);
  const superAdmin = () => A.state.actor?.role === 'super';
  const settingsTab = () => A.state.drafts.get(tabKey) || 'channels';
  const queryTab = () => !settingsPage() ? 'incidents' : settingsTab() === 'deliveries' ? 'deliveries' : 'config';
  const list = (tab = queryTab()) => A.state.drafts.get(listViewKey + tab) || { page: 1, pageSize: defaultPageSize, status: '', q: '', days: 0, priority: '' };
  const currentDraftKey = () => draftKey + ':' + settingsTab();
  const draft = () => A.state.drafts.get(currentDraftKey());
  const snapshots = new Map();
  const pending = new Map();
  const errors = new Map();
  const listFrames = new Map();
  let generation = 0, busy = false, frameObserver;
  const checkFilter = () => A.state.drafts.get(checksKey) || 'attention';
  const statusKind = status => status === 'bad' ? 'danger' : ['watch', 'unknown', 'disabled'].includes(status) ? 'warning' : 'success';
  const receiptLabel = row => incidentDelivery[row.deliveryStatus] ||
    (row.accepted ? delivery.accepted : row.external ? incidentDelivery.external_unknown : '暂无回执');

  function params(tab = queryTab()) {
    return tab === 'config' ? { tab } : { tab, ...list(tab) };
  }

  function bindRead(tab) {
    const region = $('[data-system-monitor-region]');
    const request = pending.get(tab);
    if (!request || !region || request.region === region || queryTab() !== tab) return;
    request.feedback?.finish();
    request.region = region;
    request.feedback = A.beginRegionRead(region, $('#system-monitor-progress', region), {
      loadingText: snapshots.has(tab) ? '' : '正在读取监控资料…',
      refreshButton: $('[data-action="system-monitor-refresh"]')
    });
  }

  async function load(force = false) {
    if (!local() || (settingsPage() && !superAdmin())) return;
    const tab = queryTab(), input = params(tab), key = JSON.stringify(input), epoch = generation;
    if (!force && pending.get(tab)?.key === key) return;
    if (!force && snapshots.get(tab)?.key === key) return;
    const request = { key };
    pending.get(tab)?.feedback?.finish();
    pending.set(tab, request);
    errors.delete(tab);
    bindRead(tab);
    const current = () => epoch === generation && pending.get(tab) === request;
    try {
      const data = await D.queries.read(namespace, input, () => D.systemMonitoring(input), { refresh: force });
      if (!current()) return;
      if (tab === 'config' ? !Array.isArray(data?.rules) || !data.channels : !Array.isArray(data?.items) || !pageSizes.includes(data.pageSize))
        throw new Error('监控资料响应不完整，请重新读取');
      if (tab === 'incidents' && (!Array.isArray(data.checks) || data.checks.some(row =>
        !row || typeof row.code !== 'string' || !Object.hasOwn(checks, row.status)) ||
        !Number.isSafeInteger(data.generatedAt) || !data.notifications ||
        !Object.hasOwn(notificationLabels, data.notifications.status)))
        throw new Error('监控状态响应不完整，请重新读取');
      snapshots.set(tab, { key, data });
      if (tab !== 'config') A.state.drafts.set(listViewKey + tab, { ...list(tab), page: data.page, pageSize: data.pageSize });
      return true;
    } catch (error) {
      if (current()) { errors.set(tab, error.message || '读取失败，请重试'); return false; }
    } finally {
      if (current()) {
        request.feedback?.finish();
        pending.delete(tab);
        if (queryTab() === tab && ['monitor', settingsRoute].includes(A.state.route)) {
          const focused = document.activeElement;
          const restore = focused?.closest('.monitor-navigation, #system-monitor-query-form');
          const id = restore ? focused.id : '';
          const searchText = id === 'system-monitor-search' ? focused.value : null;
          A.render();
          const control = id ? document.getElementById(id) : null;
          if (searchText !== null && control) control.value = searchText;
          control?.focus({ preventScroll: true });
        }
      }
    }
  }

  function details(row) {
    const fields = [['事件编号', row.id], ['级别', row.priority], ['发生时间', time(row.at)],
      ['本次观测', row.count ?? '—'], ['任务尾号', row.taskTail || '—'],
      ['投递', receiptLabel(row)],
      ['人工确认', row.ackAt ? time(row.ackAt) + ' · ' + row.ackBy : '待确认'],
      ['恢复', row.kind === 'event' ? '单次事件' : row.resolvedAt ? time(row.resolvedAt) : '尚无恢复证据']];
    if (row.summary) fields.push(['日报', '成功 ' + row.summary.success + ' · 失败 ' + row.summary.failure +
      ' · 待核实 ' + row.summary.review + ' · 未恢复 ' + row.summary.open]);
    const actions = (row.taskId ? A.button('查看原任务', 'system-monitor-task', '', '', `data-id="${e(row.id)}"`) : '') +
      (row.ackAt ? '' : A.button('确认已知悉', 'system-monitor-ack', 'primary', '', `data-id="${e(row.id)}"`));
    A.openDrawer(row.label, '确认已知悉只记录处置进度。恢复时间来自后续观测。',
      '<div class="property-list">' + fields.map(([label, value]) => `<div class="property-row"><span>${e(label)}</span><strong>${e(value)}</strong></div>`).join('') + '</div>',
      actions + A.button('关闭', 'drawer-close'));
  }

  function tableView(tab, data) {
    const isDelivery = tab === 'deliveries';
    const statuses = isDelivery ? Object.entries(delivery) : [['open', '待确认'], ['acknowledged', '已确认'], ['resolved', '已恢复']];
    const action = (row, kind = '') => A.button('查看详情', 'system-monitor-detail', kind, '', `data-id="${e(row.id)}"`);
    const columns = isDelivery ? [
      { id: 'label', label: '通知' }, { id: 'target', label: '接收人' },
      { id: 'status', label: '投递状态', render: row => A.tag(delivery[row.status] || '未知') },
      { id: 'attempts', label: '发送次数' }, { id: 'messageId', label: '消息编号' },
      { id: 'at', label: '时间（北京）', render: row => e(time(row.finishedAt || row.at)) }
    ] : [
      { id: 'label', label: '告警' }, { id: 'priority', label: '级别', render: row => A.tag(row.priority, row.priority === 'P0' ? 'danger' : 'warning') },
      { id: 'state', label: '处置状态', render: row => A.tag(row.resolvedAt ? '已恢复' : row.ackAt ? '已确认' : '待确认') },
      { id: 'receipt', label: '投递', render: row => e(receiptLabel(row)) },
      { id: 'at', label: '发生时间（北京）', render: row => e(time(row.at)) },
      { id: 'actions', label: '操作', action: true, render: row => action(row, 'compact') }
    ];
    const tableName = isDelivery ? 'Telegram 投递记录' : '监控告警记录';
    const empty = isDelivery ? '暂无投递记录' : '暂无符合条件的告警';
    const guidance = '可切换状态或刷新查看。';
    const cards = data.items.length ? '<div class="guide-list">' + data.items.map(row =>
      `<article class="guide-item" data-monitor-card="${e(row.id)}"><h3>${e(row.label)}</h3>
        <div class="property-list">${columns.filter(column => column.id !== 'label' && !column.action).map(column =>
          `<div class="property-row"><span>${e(column.label)}</span><strong>${column.render ? column.render(row) : e(row[column.id] ?? '—')}</strong></div>`).join('')}</div>
        ${isDelivery ? '' : `<div class="system-monitor-card-actions">${action(row)}</div>`}</article>`).join('') + '</div>'
      : A.empty(empty, guidance);
    const selection = list(tab);
    const help = isDelivery ? '投递记录保留 Telegram 接收结果，已接收不代表接收人已阅读。时间筛选按完成时间，未完成的记录按创建时间。'
      : '人工确认表示已知悉，恢复由后续检测确认。关键词可查告警名称、事件编号或任务尾号。时间筛选按发生时间。';
    return `<form id="system-monitor-query-form" class="toolbar system-monitor-query" role="search">
      <div class="system-monitor-query-heading"><div class="section-title-row"><h2>${isDelivery ? '投递记录' : '告警记录'}</h2>${A.titleInfo(isDelivery ? '投递记录' : '告警记录', help, 'system-monitor-list-help')}</div><div data-page-actions></div></div>
      <div class="system-monitor-filters">
        <label class="system-monitor-search"><span class="sr-only">搜索${isDelivery ? '通知' : '告警'}</span><input id="system-monitor-search" type="search" maxlength="100" placeholder="${isDelivery ? '搜索通知、接收人或编号' : '搜索告警、事件编号或任务尾号'}" value="${e(selection.q || '')}"/></label>
        <label>时间<select id="system-monitor-days">${A.options([['0', '全部时间'], ['1', '最近 24 小时'], ['7', '最近 7 天'], ['30', '最近 30 天']], String(selection.days || 0))}</select></label>
        <label>状态<select id="system-monitor-filter">${A.options([['', '全部状态'], ...statuses], selection.status)}</select></label>
        ${isDelivery ? '' : `<label>级别<select id="system-monitor-priority">${A.options([['', '全部级别'], ['P0', 'P0 · 紧急'], ['P1', 'P1 · 重要'], ['P2', 'P2 · 一般']], selection.priority || '')}</select></label>`}
        <div class="system-monitor-filter-actions"><button type="submit" class="button primary">查询</button>${A.button('重置', 'system-monitor-reset')}</div>
      </div></form>` +
      '<div data-monitor-list-frame><div class="system-monitor-list" data-pagination-table>' + A.table(columns, data.items, '', tableName, { title: empty, description: guidance }) +
      `<div class="system-monitor-mobile panel-body" data-pagination-rows tabindex="0" role="region" aria-label="${tableName}">${cards}</div></div>` +
      window.IDPagination.render({ id: namespace, page: data.page, pageSize: data.pageSize, total: data.total, disabled: pending.has(tab) }) + '</div>';

  }

  function notificationDetails() {
    const current = snapshots.get('incidents')?.data.notifications;
    if (!current) return;
    const fields = [['统一通知', notificationLabels[current.status] || '未知'],
      ['接收通道', '已配置 ' + current.configured + ' / ' + current.total + '，已验证 ' + current.verified],
      ['待接通接收方', current.missingChannels?.join('、') || '无'],
      ['代充通知归属', phases[current.legacyPhase] || '未知']];
    A.openDrawer('通知接通情况', '已就绪表示具备自动投递条件；消息是否收到，以投递记录的接收回执为准。',
      '<div class="property-list">' + fields.map(([label, value]) =>
        `<div class="property-row"><span>${e(label)}</span><strong>${e(value)}</strong></div>`).join('') + '</div>' +
      `<p class="system-monitor-guidance">${e(current.status === 'disabled'
        ? '自动发送已关闭。请超级管理员配置接收人、核对测试回执后再启用。'
        : current.missingChannels?.length ? '部分规则缺少已验证的接收方，请超级管理员在通知设置补齐。'
        : '可在投递记录核对各条通知的实际结果。原代充通知的接管需单独核对。')}</p>`,
      (superAdmin() ? A.button('打开监控通知', 'goto', 'primary', '', 'data-route="settings/monitoring"') : '') +
      A.button('关闭', 'drawer-close'));
  }

  function checkDetails(code) {
    const row = snapshots.get('incidents')?.data.checks?.find(item => item.code === code);
    if (!row) return;
    const fields = [['当前状态', checks[row.status] || '未知'], ['最近检查（北京）', time(row.at)],
      ['采集来源', row.source || '尚未说明'], ['检测依据', row.detail || '尚未取得有效检测结果。'],
      ...(row.measurement ? [['观测值', row.measurement]] : []), ['判断规则', row.threshold || '尚未说明']];
    const link = sourceLinks[code];
    A.openDrawer(row.title || row.label, '当前状态来自最近检查；告警确认、恢复与通知接收分别记录。',
      '<div class="property-list">' + fields.map(([label, value]) =>
        `<div class="property-row"><span>${e(label)}</span><strong>${e(value)}</strong></div>`).join('') + '</div>' +
      `<p class="system-monitor-guidance">${e(row.guidance || '请核对采集来源及相关运行记录。')}</p>`,
      (link ? A.button(link[0], 'goto', 'primary', '', `data-route="${e(link[1])}"`) : '') +
      (code === 'order_sync' && !['ok', 'disabled'].includes(row.status)
        ? A.button('重试入单', 'system-monitor-order-retry', 'primary') : '') +
      A.button('关闭', 'drawer-close'));
  }

  async function retryOrderReadback(node) {
    const feedback = A.beginActionFeedback(node, '正在重读代充任务…');
    const epoch = generation;
    try {
      const result = await D.orderSync({ mode: 'retry' });
      if (epoch !== generation) return;
      const checked = result.rows?.filter(row => row.orderNo).length || 0;
      const message = checked ? `已回读 ${checked} 笔 GPT 订单` : '本次没有取得新的入单回执';
      A.notify(message + (result.pending ? `，仍有 ${result.pending} 笔任务待重读` : ''));
      if (feedback.current()) A.closeDrawer();
      if (A.state.route === 'monitor') await load(true);
    } catch (error) {
      if (epoch === generation) A.notify(error.message || '暂时无法重读代充任务', { kind: 'error' });
    } finally {
      feedback.finish();
    }
  }

  function monitorOverview(data) {
    const rows = data.checks || [];
    const count = status => rows.filter(row => row.status === status).length;
    const notification = data.notifications;
    const metrics = [
      ['当前异常', count('bad'), '观察中 ' + count('watch') + ' 项'],
      ['监测正常', count('ok'), '共 ' + rows.length + ' 项监控'],
      ['未知／未接入', count('unknown') + count('disabled'), '未知 ' + count('unknown') + ' · 未启用 ' + count('disabled')],
      ['通知状态', notificationLabels[notification?.status] || '未知', notification
        ? '已验证 ' + notification.verified + ' / ' + notification.total + ' 个接收通道' : '尚未取得渠道状态']
    ];
    return '<div class="summary-strip system-monitor-summary" aria-label="监控概览">' + metrics.map(([label, value, detail], index) =>
      `<div class="summary-item" data-monitor-metric="${index}"><div class="summary-label">${e(label)}</div>
        <div class="system-monitor-number-row"><div class="summary-number" data-status="${index === 0 && value > 0 ? 'bad' : ''}">${e(value)}</div>
        ${index === 3 && notification ? A.button('详情', 'system-monitor-notifications', 'compact', '', 'aria-label="查看接通情况"') : ''}</div><div class="system-monitor-metric-detail">${e(detail)}</div></div>`).join('') + '</div>';
  }

  function monitoringChecks(data) {
    const severity = { bad: 0, watch: 1, unknown: 2, disabled: 3, ok: 4 };
    const category = A.state.drafts.get(checksKey + ':category') || '';
    const rows = (data.checks || []).filter(row => (!category || row.category === category) && (checkFilter() === 'all' ||
      (checkFilter() === 'normal' ? row.status === 'ok' : row.status !== 'ok'))).sort((a, b) => severity[a.status] - severity[b.status]);
    return `<div class="toolbar system-monitor-toolbar system-monitor-check-toolbar"><div class="toolbar-left">
      <div class="section-title-row"><h2>监控项目</h2>${A.titleInfo('监控项目', '按系统、安全、代充和后台任务分类。默认显示需关注项目，未知和未接入不会视为正常。时间均为北京时间。页面可见时每 60 秒更新。', 'system-monitor-checks-help')}</div>
      <label class="system-monitor-choice">状态<select id="system-monitor-check-filter">${A.options([
        ['attention', '需关注'], ['all', '全部状态'], ['normal', '正常项目']], checkFilter())}</select></label>
      <label class="system-monitor-choice">分类<select id="system-monitor-category">${A.options([
        ['', '全部分类'], ['运行', '系统运行'], ['安全', '访问安全'], ['代充', '代充服务'], ['后台任务', '后台任务']], category)}</select></label>
      </div><div class="toolbar-right" data-page-actions></div></div>
      <div class="system-monitor-read-time">${rows.length} 项 · 最近更新 ${e(time(data.generatedAt))}</div>
      <div class="system-monitor-check-list" data-pagination-table><div class="table-viewport" tabindex="0" role="region" aria-label="监控项目列表">
        <table class="system-monitor-check-table" data-table="system-monitor-checks"><thead><tr><th scope="col">监控项目</th><th scope="col">状态</th><th scope="col">检测结果</th><th scope="col">最近检查（北京）</th><th scope="col">操作</th></tr></thead>
        <tbody>${rows.map(row => `<tr class="system-monitor-check" data-monitor-check="${e(row.code)}" data-row-id="${e(row.code)}">
          <td><strong>${e(row.title || row.label)}</strong><span class="system-monitor-check-category">${e(row.category)}</span></td>
          <td>${A.tag(checks[row.status] || '未知', statusKind(row.status))}</td>
          <td class="system-monitor-check-result">${e(row.detail || '尚未取得有效检测结果。')}${row.measurement ? `<span class="system-monitor-measurement">${e(row.measurement)}</span>` : ''}</td>
          <td class="system-monitor-check-time">${e(time(row.at))}</td>
          <td>${A.button('查看详情', 'system-monitor-check', 'compact', '', `data-code="${e(row.code)}" aria-label="查看${e(row.title || row.label)}与处理"`)}</td>
        </tr>`).join('') || `<tr><td colspan="5">${A.empty('暂无符合条件的监控项目', '可切换状态或分类查看其他项目。')}</td></tr>`}</tbody></table>
      </div></div>`;
  }

  function channelForm(config) {
    const edited = draft();
    const fields = Object.entries(config.channels).map(([key, item]) =>
      `<div class="system-monitor-recipient">${A.field(item.label, 'system-monitor-channel-' + key,
        A.input('system-monitor-channel-' + key, '', `data-channel="${key}" data-no-draft inputmode="numeric" autocomplete="off" maxlength="20" placeholder="${item.configured ? '已配置，填写可替换' : '请输入数字 Chat ID'}"`),
        false, '留空保留当前编号。停用自动发送后可更换编号并重新测试。')}
        <span class="system-monitor-recipient-status">${A.tag(item.verified ? '已取得回执' : item.configured ? '待测试' : '未配置', item.verified ? 'success' : '')}</span>
        ${A.button('测试', 'system-monitor-test', '', '', `data-target="${key}" aria-label="测试${e(item.label)}" ${busy || !item.configured || !config.tokenConfigured ? 'disabled' : ''}`)}</div>`).join('');
    const targets = edited?.legacyRecipients || config.legacy.recipients || [];
    const migrated = config.legacy.phase !== 'managed' ? '' : A.field('代充业务接收人', 'system-monitor-legacy-admin',
      [['rechargeAdmin', 'system-monitor-legacy-admin'], ['rechargeGroup', 'system-monitor-legacy-group']].map(([key, id]) =>
        `<label class="checkbox-label"><input id="${id}" type="checkbox" data-legacy-target="${key}"
         ${targets.includes(key) ? 'checked' : ''}/>${e(config.channels[key].label)}</label>`).join(''), false,
      '适用于已接管的成功、失败和卡池告警。付款待核实发给代充管理员。');
    return `<form id="system-monitor-channel-form" class="form-panel system-monitor-channel-form" novalidate>
      <fieldset class="system-monitor-fields system-monitor-channel-layout" ${busy ? 'disabled' : ''}>
        <section class="system-monitor-connection"><div class="section-title-row"><h2>发送设置</h2>${A.titleInfo('发送设置', '先保存 Bot 和接收人，再分别测试渠道，确认回执后启用自动发送。测试操作会向已保存的接收人发出一条消息。', 'system-monitor-connection-help')}</div>
          ${A.field('自动发送', 'system-monitor-enabled', `<label class="checkbox-label"><input id="system-monitor-enabled" type="checkbox" ${(edited?.enabled ?? config.enabled) ? 'checked' : ''}/>启用 Telegram 告警</label>`)}
          ${A.field('Bot 密钥', 'system-monitor-token', A.input('system-monitor-token', '', `type="password" data-no-draft autocomplete="new-password" maxlength="128" placeholder="${config.tokenConfigured ? '已配置，填写可替换' : '请输入 Bot 密钥'}"`),
            false, '密钥只写入服务端。留空保留已保存密钥，离开页面清除未提交内容。停用自动发送后可更换密钥并重新测试。')}
          <div class="system-monitor-connection-state">Bot 状态 ${A.tag(config.tokenConfigured ? '已配置' : '未配置', config.tokenConfigured ? 'success' : '')}</div>
        </section>
        <section class="system-monitor-recipients"><div class="section-title-row"><h2>接收渠道</h2>${A.titleInfo('接收渠道', '每个接收人独立保存配置和测试回执。测试按钮使用服务端已保存的编号，新填写的编号需要先保存。', 'system-monitor-recipient-help')}</div>${fields}${migrated}</section>
      </fieldset><p class="field-error" data-system-monitor-error role="alert" hidden></p>
      <div class="form-footer"><button type="submit" class="button primary" ${busy ? 'disabled' : ''}>保存渠道</button></div></form>
      <div class="toolbar system-monitor-legacy"><div class="toolbar-left"><strong>代充通知</strong>${A.tag(phases[config.legacy.phase] || '未知')}
        ${A.titleInfo('代充通知', '原代充继续发送、接管核对中和已由系统统一发送分别记录。导入与接管沿用既有操作确认。', 'system-monitor-legacy-help')}
      </div><div class="toolbar-right">
        ${config.legacy.available && config.legacy.phase !== 'managed' ? (config.legacy.phase === 'native' ?
          A.button('原代充 Telegram 设置', 'system-monitor-legacy-settings') +
          A.button(config.legacy.imported ? '重新核对并导入' : '导入原代充订阅', 'system-monitor-import') : '') +
          (config.legacy.imported ? A.button(config.legacy.phase === 'switching' ? '继续核对接管' : '接管代充业务通知', 'system-monitor-takeover') : '') : ''}
      </div></div>`;
  }

  function ruleForm(config) {
    const edited = draft()?.rules || {};
    const groups = [...new Set(config.rules.map(rule => rule.category))];
    const selected = A.state.drafts.get(namespace + ':rule-category') || '';
    const rules = config.rules.filter(rule => !selected || rule.category === selected);
    return `<form id="system-monitor-rules-form" class="form-panel system-monitor-rule-form"><fieldset class="system-monitor-fields" ${busy ? 'disabled' : ''}>
      <div class="toolbar system-monitor-toolbar"><div class="toolbar-left"><div class="section-title-row"><label for="system-monitor-rule-category">规则分类</label>${A.titleInfo('规则分类', '按分类查找通知规则。启用只调整该规则的发送开关，自动投递还取决于渠道配置及测试回执。筛选保留尚未保存的规则改动。', 'system-monitor-rules-help')}</div>
        <select id="system-monitor-rule-category">${A.options([['', '全部分类'], ...groups.map(group => [group, group])], selected)}</select>
        <span class="system-monitor-rule-count">${rules.length} / ${config.rules.length} 项</span>
      </div></div>
      <div class="system-monitor-rules-list" data-pagination-table><div class="table-viewport" role="region" aria-label="通知规则列表" tabindex="0">
        <table class="system-monitor-rule-table" data-table="system-monitor-rules"><thead><tr><th scope="col">通知规则</th><th scope="col">分类</th><th scope="col">接收方</th><th scope="col">级别</th><th scope="col">通知开关</th></tr></thead><tbody>
        ${rules.map(rule => `<tr data-row-id="${e(rule.code)}"><td><div class="section-title-row"><label for="system-monitor-rule-${e(rule.code)}">${e(rule.label)}</label>${A.titleInfo(rule.label,
          rule.code === 'public_site' ? '由独立站外探针配置接收人和投递。' : '接收方为' + (rule.recipient || '已配置接收人') + '。', 'system-monitor-rule-help-' + rule.code)}</div></td>
          <td>${e(rule.category)}</td><td>${e(rule.code === 'public_site' ? '独立站外探针' : rule.recipient || '已配置接收人')}</td><td>${A.tag(rule.priority, rule.priority === 'P0' ? 'danger' : '')}</td>
          <td><label class="checkbox-label"><input type="checkbox" id="system-monitor-rule-${e(rule.code)}" data-rule="${e(rule.code)}"
          ${(edited[rule.code] ?? rule.enabled) ? 'checked' : ''} ${rule.code === 'public_site' ||
            (config.legacy.imported && config.legacy.phase !== 'managed' && ['recharge_success', 'recharge_failure', 'recharge_cards'].includes(rule.code)) ? 'disabled' : ''}/>启用</label></td></tr>`).join('') || `<tr><td colspan="5">${A.empty('暂无此分类规则', '请选择其他分类。')}</td></tr>`}
        </tbody></table></div></div></fieldset><p class="field-error" data-system-monitor-error role="alert" hidden></p>
      <div class="form-footer"><button type="submit" class="button primary" ${busy ? 'disabled' : ''}>保存通知规则</button></div></form>`;
  }

  function render() {
    const setting = settingsPage();
    const title = setting ? '监控通知' : '网站监控';
    const description = setting ? '设置 Telegram 接收人、通知规则并查询投递回执。测试与启用分别操作。'
      : '查看服务运行状态、告警记录与各网站访问统计。没有有效观测时显示未知。';
    if (!local() || (setting && !superAdmin()))
      return A.header(title, description) + `<section class="panel">${A.empty('监控资料不可用', D ? '请使用有权限的管理账号。' : '设计预览尚未接入实际监控。')}</section>`;
    const tab = queryTab(), snapshot = snapshots.get(tab)?.data, error = errors.get(tab);
    const refresh = A.button('刷新', 'system-monitor-refresh', '', 'refresh');
    const jump = !setting && superAdmin() ? A.button('监控通知', 'goto', '', '', 'data-route="settings/monitoring"') : '';
    const nav = setting ? `<div class="tabs monitor-navigation" role="tablist" aria-label="监控通知栏目">${[
      ['channels', 'Telegram 渠道'], ['rules', '通知规则'], ['deliveries', '投递记录']
    ].map(([key, label]) => `<button type="button" id="tab-notification-${key}" class="tab ${settingsTab() === key ? 'active' : ''}" role="tab" aria-selected="${settingsTab() === key}" tabindex="${settingsTab() === key ? 0 : -1}"${settingsTab() === key ? ' aria-controls="system-monitor-view-content"' : ''} data-action="system-monitor-tab" data-tab="${key}">${label}</button>`).join('')}</div>` : A.websiteMonitorTabs(monitorView());
    let content = '';
    if (snapshot) {
      if (tab === 'config') {
        if (draft() && draft().version !== snapshot.version) content +=
          `<div class="toolbar"><span>服务器设置已更新，草稿待核对。</span>${A.button('使用最新版本继续编辑', 'system-monitor-rebase')}</div>`;
        content += settingsTab() === 'channels' ? channelForm(snapshot) : ruleForm(snapshot);
      } else content += !setting && monitorView() === 'checks' ?
        `<div class="panel-body system-monitor-summary-wrap">${monitorOverview(snapshot)}</div>` + monitoringChecks(snapshot) : tableView(tab, snapshot);
    } else if (!error) content = '<div class="toolbar" role="status">等待读取监控资料</div>';
    if (error) content = `<div class="inline-notice warning" role="alert">${e(error)} ${snapshot ? '已保留上次读取。' : ''}</div>` + content;
    const actions = refresh + jump + (!setting && monitorView() === 'incidents' && superAdmin() ? A.button('登记已核实事件', 'system-monitor-verified') : '');
    return A.header(title, description, actions) +
      `<section class="panel system-monitor-workspace ${!setting && monitorView() === 'incidents' ? 'system-monitor-incidents' : ''}" data-system-monitor-region>
        <div class="content-toolbar">${nav}${setting && tab === 'config' ? '<div class="toolbar-right" data-page-actions></div>' : ''}</div>
        <div id="system-monitor-progress" role="status" hidden></div><div id="system-monitor-view-content" role="tabpanel" aria-labelledby="${setting ? 'tab-notification-' + settingsTab() : 'tab-' + monitorView()}">${content}</div></section>`;
  }

  async function act(command, success, form) {
    if (busy) return false;
    busy = true;
    const epoch = generation, route = A.state.route;
    const submittedKey = currentDraftKey(), submittedDraft = draft();
    const fieldset = form?.querySelector('fieldset');
    if (fieldset) fieldset.disabled = true;
    form?.setAttribute('aria-busy', 'true');
    try {
      const result = await D.systemMonitoringAction(command);
      if (generation !== epoch) return false;
      if (command.action === 'settings' && A.state.drafts.get(submittedKey) === submittedDraft)
        A.state.drafts.delete(submittedKey);
      if (result?.version !== undefined) snapshots.set('config', { key: JSON.stringify({ tab: 'config' }), data: result });
      A.notify(success);
      if (A.state.route === route) {
        if (form?.closest('#drawer')) A.closeDrawer();
        A.render();
        await load(true);
      }
      return true;
    } catch (error) {
      if (generation === epoch) {
        const message = error.message || '操作失败，请重试';
        const target = form?.querySelector('[data-system-monitor-error]');
        if (target?.isConnected) { target.textContent = message; target.hidden = false; }
        A.notify(message, { kind: 'error' });
      }
      return false;
    } finally {
      if (generation === epoch) busy = false;
      if (fieldset) fieldset.disabled = false;
      form?.removeAttribute('aria-busy');
      if (generation === epoch && A.state.route === route && !form?.isConnected && document.querySelector('[data-system-monitor-region]'))
        A.render();
    }
  }

  function onClick(action, node) {
    if (action === 'system-monitor-view') {
      const view = node.dataset.view;
      if (['checks', 'incidents'].includes(view)) {
        if (!local()) return true;
        A.state.drafts.set(viewKey, view);
        if (A.state.route === 'monitor') { A.render(); void load(); }
        else location.hash = '#/monitor';
      } else if (view === 'ops-website-analytics') {
        if (local()) location.hash = '#/data';
      } else if (['ops-website-visits', 'ops-website-check'].includes(view)) {
        if (view !== 'ops-website-check' && !local()) return true;
        A.state.drafts.set('operations:tool-section:网站监控', { panel: view });
        if (A.state.route === 'plugins/websites') A.render();
        else location.hash = '#/plugins/websites';
      }
      return true;
    }
    if (!action.startsWith('system-monitor-') || !local()) return false;
    const config = snapshots.get('config')?.data;
    const row = snapshots.get('incidents')?.data.items.find(item => item.id === node.dataset.id);
    if (action === 'system-monitor-refresh') void load(true);
    if (action === 'system-monitor-reset') {
      const tab = queryTab();
      A.state.drafts.set(listViewKey + tab, { page: 1, pageSize: list(tab).pageSize, status: '', q: '', days: 0, priority: '' });
      A.render(); void load();
    }
    if (action === 'system-monitor-check') checkDetails(node.dataset.code);
    if (action === 'system-monitor-order-retry') void retryOrderReadback(node);
    if (action === 'system-monitor-notifications') notificationDetails();
    if (action === 'system-monitor-tab' && ['channels', 'rules', 'deliveries'].includes(node.dataset.tab)) {
      A.state.drafts.set(tabKey, node.dataset.tab); A.render(); void load();
    }
    if (action === 'system-monitor-detail' && row) details(row);
    if (action === 'system-monitor-task' && row?.taskId) A.modules.operations?.openRechargeTaskLog(row.taskId);
    if (action === 'system-monitor-ack' && row) {
      A.confirmAction('确认已知悉', '保留事件和恢复状态，登记当前管理员已知悉。', async () => {
        if (await act({ action: 'acknowledge', id: row.id }, '已登记人工确认')) A.closeDrawer();
      });
    }
    if (action === 'system-monitor-verified' && superAdmin())
      A.openDrawer('登记已核实事件', '使用已核实的内部证据编号。提交会按当前规则发送紧急告警。', `<form id="system-monitor-verified-form" class="form-panel"><fieldset class="form-grid">
        ${A.field('事件', 'system-monitor-verified-code', A.select('system-monitor-verified-code', [['security_confirmed', '已核实安全事件'], ['payment_duplicate', '已核实重复扣款']]), true)}
        ${A.field('证据编号', 'system-monitor-reference', A.input('system-monitor-reference', '', 'required maxlength="36" autocomplete="off" data-no-draft'), true, '填写内部证据的 UUID。相同编号用于去重。')}
        </fieldset><p data-system-monitor-error class="field-error" role="alert" hidden></p></form>`,
        '<button class="button primary" type="submit" form="system-monitor-verified-form">登记事件</button>' + A.button('关闭', 'drawer-close'));
    if (!config || !settingsPage() || !superAdmin()) return true;
    if (action === 'system-monitor-legacy-settings' && config.legacy.available && config.legacy.phase === 'native') {
      A.openDrawer('原代充 Telegram 设置', '继续使用原代充保存的 Bot 和接收人。代充消息可能包含账号邮箱和兑换码。',
        '<iframe class="system-monitor-legacy-frame" src="/integrations/codexdaichong/admin?section=telegram" title="代充 Telegram 配置表单"></iframe>');
      const drawer = $('#drawer'), frame = $('.system-monitor-legacy-frame', drawer);
      drawer.addEventListener('close', () => frame.remove(), { once: true });
    }
    if (action === 'system-monitor-rebase' && draft()) {
      A.confirmAction('核对监控设置', '保留您已改动的选项，使用当前服务器版本作为下次保存依据。', () => {
        A.state.drafts.set(currentDraftKey(), { ...draft(), version: config.version }); A.render();
      });
    }
    if (action === 'system-monitor-test' && config.channels[node.dataset.target]) {
      const target = node.dataset.target;
      A.confirmAction('发送 Telegram 测试', '将向已保存的「' + config.channels[target].label + '」发送一条测试消息。', () =>
        act({ action: 'test', version: config.version, target }, '测试已排队，请到投递记录核对'));
    }
    if (action === 'system-monitor-import')
      A.confirmAction('导入原代充订阅', '读取原代充通知的接收人和开关。现有发送由原代充继续处理。', () =>
        act({ action: 'legacy-import', version: config.version }, '已导入订阅，请核对接收人和测试回执'));
    if (action === 'system-monitor-takeover')
      A.confirmAction('接管代充业务通知', '确认原代充已维护且无活动任务。系统将核对旧渠道停止业务发送后接管。', () =>
        act({ action: 'legacy-takeover', version: config.version, confirm: true }, '已取得原代充关闭回执并完成接管'), '确认接管');
    return true;
  }

  function onChange(node) {
    const tab = queryTab();
    if (node.id === 'system-monitor-check-filter' && ['attention', 'all', 'normal'].includes(node.value)) {
      A.state.drafts.set(checksKey, node.value); A.render(); return true;
    }
    if (node.id === 'system-monitor-rule-category') {
      A.state.drafts.set(namespace + ':rule-category', node.value); A.render(); return true;
    }
    if (node.id === 'system-monitor-category') {
      A.state.drafts.set(checksKey + ':category', node.value); A.render(); return true;
    }
    if (['system-monitor-filter', 'system-monitor-days', 'system-monitor-priority'].includes(node.id)) {
      queryList(node.form); return true;
    }
    if (settingsPage() && (node.dataset.rule || node.dataset.legacyTarget || node.id === 'system-monitor-enabled')) {
      const config = snapshots.get('config')?.data;
      if (!config) return true;
      const next = { ...(draft() || { version: config.version }), rules: { ...draft()?.rules } };
      if (node.dataset.rule) next.rules[node.dataset.rule] = node.checked;
      else if (node.dataset.legacyTarget) next.legacyRecipients = [...node.form.querySelectorAll('[data-legacy-target]:checked')]
        .map(control => control.dataset.legacyTarget);
      else next.enabled = node.checked;
      A.state.drafts.set(currentDraftKey(), next);
      return true;
    }
    return false;
  }

  function queryList(form) {
    if (!form) return;
    const tab = queryTab();
    A.state.drafts.set(listViewKey + tab, { ...list(tab), page: 1,
      q: form.querySelector('#system-monitor-search').value.trim(),
      days: Number(form.querySelector('#system-monitor-days').value),
      status: form.querySelector('#system-monitor-filter').value,
      priority: form.querySelector('#system-monitor-priority')?.value || '' });
    void load();
  }

  async function onSubmit(form) {
    if (form.id === 'system-monitor-query-form') { queryList(form); return true; }
    if (form.id === 'system-monitor-verified-form') {
      if (form.reportValidity()) await act({ action: 'verified',
        code: form.elements['system-monitor-verified-code'].value,
        reference: form.elements['system-monitor-reference'].value.trim() }, '已核对该证据编号的事件记录', form);
      return true;
    }
    if (!['system-monitor-channel-form', 'system-monitor-rules-form'].includes(form.id)) return false;
    const config = snapshots.get('config')?.data, edited = draft();
    if (!config || busy) return true;
    const channelForm = form.id === 'system-monitor-channel-form';
    const token = channelForm ? form.elements['system-monitor-token'].value.trim() : '';
    const channels = Object.fromEntries([...form.querySelectorAll('[data-channel]')].filter(node => node.value.trim())
      .map(node => [node.dataset.channel, node.value.trim()]));
    await act({ action: 'settings', version: edited?.version ?? config.version, settings: {
      enabled: channelForm ? form.querySelector('#system-monitor-enabled').checked : config.enabled,
      ...(token && { token }), channels, rules: channelForm ? {} : edited?.rules || {},
      ...(channelForm && edited?.legacyRecipients && { legacyRecipients: edited.legacyRecipients })
    } }, '已保存监控设置', form);
    return true;
  }

  document.addEventListener('id-pagination-change', event => {
    if (event.detail.id !== namespace || !event.target.closest('[data-system-monitor-region]')) return;
    const tab = queryTab();
    const { page, pageSize } = event.detail;
    A.state.drafts.set(listViewKey + tab, { ...list(tab), page, pageSize });
    void load();
  });
  document.addEventListener('keydown', event => {
    const nav = event.target.closest('.monitor-navigation');
    if (!nav || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...nav.querySelectorAll('[role="tab"]')], index = tabs.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    requestAnimationFrame(() => document.querySelector('.monitor-navigation [aria-selected="true"]')?.focus({ preventScroll: true }));
  });
  window.IDDesignModules.push({
    id: namespace, matches: route => ['monitor', settingsRoute].includes(route), render, onClick, onChange, onSubmit,
    afterRender({ routeChanged } = {}) {
      bindRead(queryTab());
      frameObserver?.disconnect();
      const frame = $('[data-monitor-list-frame]');
      if (frame) {
        const preserve = () => window.IDPagination.preserveFrame(frame, listFrames, queryTab());
        preserve();
        frameObserver = new ResizeObserver(preserve);
        frameObserver.observe(frame);
      }
      if (routeChanged) queueMicrotask(() => {
        if (['monitor', settingsRoute].includes(A.state.route)) void load(true);
      });
    },
    onDataChanges(scopes) {
      if (!scopes.includes(namespace)) return;
      // Inactive tabs must not retain clean module snapshots after a revision.
      for (const [tab, snapshot] of snapshots) snapshots.set(tab, { ...snapshot, key: '' });
      if (['monitor', settingsRoute].includes(A.state.route)) return load(true);
    },
    clearPageState() {
      generation++; busy = false; frameObserver?.disconnect(); listFrames.clear();
      snapshots.clear(); pending.clear(); errors.clear();
    }
  });
})();
