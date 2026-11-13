/* 网站总览复用各业务模块的只读汇总。 */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const E = A.esc;
  const M = A.money;
  const business = window.IDLocalData;
  const draftKey = 'overview:filters';
  const rechargeRequestsRoute = 'workspace/recharge-codes';
  const ranges = [['today', '今日'], ['week', '近 7 天'], ['month', '近 30 天']];
  const chartModes = [['orders', '订单量'], ['profit', '自动计算利润']];
  const dateBases = [['created', '订单录入日'], ['opened', '实际开通日']];
  const currencies = [['CNY', '人民币 CNY'], ['MYR', '马币 MYR']];
  const products = [
    ['GPT', 'orders/gpt'], ['Claude Pro', 'orders/claude'], ['Claude Max', 'orders/claude'],
    ['Gemini', 'orders/gemini'], ['Grok', 'orders/grok'], ['其他业务', '']
  ];
  const inventories = [
    ['google', '谷歌邮箱', 'mailboxes/google'],
    ['microsoft', '微软邮箱', 'mailboxes/microsoft'],
    ['relay', '苹果隐藏邮箱', 'mailboxes/relay'],
    ['gpt', 'GPT 账号', 'accounts/gpt'],
    ['claude', 'Claude 账号', 'accounts/claude'],
    ['gemini', 'Gemini 账号', 'accounts/gemini'],
    ['grok', 'Grok 账号', 'accounts/grok']
  ];
  const metrics = [
    ['orders', '订单数', '按所选北京时间日期口径统计。已撤单另列，续费新单计入订单量。'],
    ['receipts', '订单实收', '已录入的实收按所选订单日期归集，按原币分列，无需再次确认。客户退款按登记时间另列。'],
    ['profit', '自动计算利润', '与订单统计使用相同日期口径、费用和历史汇率。逐单计算净收款减已知净成本。开卡费未分摊时，仍计入已知部分。'],
    ['customers', '新增客户', '按客户创建时间和客户编号去重统计。']
  ];
  const timezone = 'Asia/Shanghai';
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: '2-digit', day: '2-digit'
  });
  const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const count = new Intl.NumberFormat('zh-CN');
  const axis = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
  const ratio = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
  const allowed = route => A.canVisit(route);
  const link = (label, route, permission = route) => route && allowed(permission)
    ? `<a class="overview-link" href="#/${E(route)}">${E(label)}${A.icon('chevron')}</a>` : '';
  function statisticsRoute(period, currency, dateBasis, options = {}) {
    if (!period) return 'orders/statistics';
    return 'orders/statistics?' + new URLSearchParams({
      from: dayFormatter.format(period.start), to: dayFormatter.format(period.end),
      until: period.end, asOf: period.asOf, dateBasis, currency, ...options
    });
  }

  let refreshing;
  let regionRead;

  function bindOverviewRead() {
    const region = A.$('#main .website-overview');
    if (!region || regionRead?.region === region) return;
    regionRead?.finish();
    regionRead = A.beginRegionRead(region, region.querySelector('[data-overview-progress]'), {
      refreshButton: region.querySelector('[data-action="overview-refresh"]')
    });
  }

  function overviewKey() {
    const actor = A.state.actor;
    const finance = allowed('orders/statistics');
    const draft = A.state.drafts.get(draftKey);
    return {
      actor: actor?.id || '', role: actor?.role || '', finance,
      apple: finance && allowed('accounts/apple-balances'),
      ...(finance ? { dateBasis: draft?.dateBasis || 'created', currency: draft?.currency || 'CNY' } : {}),
      rechargeRequests: finance && Boolean(business?.canApproveRechargeCodes) && allowed(rechargeRequestsRoute),
      ...(finance && draft?.range === 'custom' ? { custom: draft.custom } : {})
    };
  }

  async function readSource(load) {
    try { return await load(); }
    catch { return false; }
  }

  async function loadOverview(key) {
    const previous = business.queries.peek('overview', key)?.data || {};
    const { commerce, inventory, appleBalance } = A.modules;
    const [inventoryReady, commerceReady, appleReady, rechargeSummary] = await Promise.all([
      readSource(() => inventory.refreshOverview()),
      key.finance && readSource(() => commerce.refreshOverview()),
      key.apple && readSource(() => appleBalance.refreshLocalBalance()),
      key.rechargeRequests && readSource(() => business.rechargeCodePendingSummary())
    ]);
    const asOf = Date.now();
    const section = (name, data) => data === false || data == null
      ? { ...previous[name], phase: 'error' }
      : { data, updated: asOf, phase: 'ready' };
    const stock = await readSource(() => inventoryReady && inventory.overviewSummary());
    const snapshot = { inventory: section('inventory', stock) };
    if (key.finance) {
      const [summary, customers] = await Promise.all([
        readSource(() => commerceReady && commerce.overviewSummary(asOf, key)),
        readSource(() => commerceReady && inventoryReady && commerce.overviewCustomerSummary(asOf))
      ]);
      snapshot.commerce = section('commerce', summary?.commerce);
      snapshot.customers = section('customers', customers);
      for (const range of [...ranges.map(([id]) => id), ...(key.custom ? ['custom'] : [])])
        snapshot['profit:' + range] = section('profit:' + range, summary?.profit?.[range]);
    }
    if (key.apple) snapshot.apple = section('apple', await readSource(() =>
      appleReady && appleBalance.listRefunds().filter(row => row.status === 'pending').length));
    if (key.rechargeRequests) {
      const pending = rechargeSummary?.pending;
      snapshot.rechargeRequests = section('rechargeRequests', Number.isSafeInteger(pending) && pending >= 0 ? pending : null);
    }
    return snapshot;
  }

  function refreshOverview({ refresh = false } = {}) {
    if (!business) return;
    const key = overviewKey();
    const id = JSON.stringify(key);
    if (refreshing?.id === id) return refreshing.promise;
    const cached = business.queries.peek('overview', key);
    const last = cached?.data?.inventory?.updated;
    if (!refresh && !cached?.stale && last != null &&
        dayFormatter.format(last) === dayFormatter.format(Date.now())) return;
    const ready = snapshot => Object.values(snapshot).every(section => section.phase === 'ready');
    const read = () => business.queries.read('overview', key, () => loadOverview(key), {
      refresh: true, isFresh: ready
    });
    const current = () => A.state.route === 'overview' && JSON.stringify(overviewKey()) === id;
    const request = { id };
    request.promise = read().catch(error => {
      // A change notification can invalidate an in-flight read. An expired session clears the entry.
      if (error?.name === 'AbortError' && current() &&
          business.queries.peek('overview', key)?.stale) return read();
      throw error;
    }).then(ready).catch(error =>
      error?.name === 'AbortError' && !business.queries.peek('overview', key)?.stale ? undefined : false
    ).finally(() => {
      if (refreshing !== request) return;
      regionRead?.finish();
      regionRead = undefined;
      refreshing = undefined;
      if (current()) A.render();
    });
    refreshing = request;
    bindOverviewRead();
    return request.promise;
  }

  function sectionStatus(section) {
    if (!business) return '设计预览 · 业务数据未连接';
    if (section?.phase === 'error') return section.updated != null
      ? `读取失败 · 保留 ${timeFormatter.format(section.updated)} 的数据` : '读取失败 · 可重试';
    return section?.updated != null ? `更新于 ${timeFormatter.format(section.updated)}` : '等待读取';
  }

  function amountText(value) {
    const [whole, fraction = ''] = String(value).split('.');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
      '.' + fraction.replace(/0+$/, '').padEnd(2, '0');
  }
  const countText = value => value == null ? '—' : count.format(value);
  const moneyText = value => value == null ? '—' : amountText(value);
  const profitValue = total => total && (total.accounted || !total.pending) ? total.amount : null;
  const changeText = (difference, unit, money = false) => {
    const sign = money ? M.compare(difference, '0') : Math.sign(difference);
    if (!sign) return '持平';
    const value = money ? amountText(String(difference).replace(/^-/, '')) : countText(Math.abs(difference));
    return `${sign > 0 ? '增加' : '减少'} ${value} ${unit}`;
  };
  const windowText = period => period
    ? `${timeFormatter.format(period.start)} 至 ${timeFormatter.format(period.end)}` : '';

  function heading(id, title, note, action = '') {
    return `<div class="overview-heading"><div class="section-title-row"><h2 id="overview-${id}">${title}</h2>${A.titleInfo(title, note, `overview-${id}-note`)}</div>${action}</div>`;
  }

  function renderControls(items, selected, name, label, extra = '') {
    return `<div class="overview-controls" role="group" aria-label="${label}">${items.map(([id, title]) =>
      A.button(title, 'overview-' + name, id === selected ? 'primary' : '', '',
        `data-value="${id}" aria-pressed="${id === selected}"`)).join('')}${extra}</div>`;
  }

  function metricCard(id, value, note, extra = '') {
    const [, title, help] = metrics.find(metric => metric[0] === id);
    return `<article class="panel overview-metric" data-overview-metric="${id}"><div class="panel-body">
      <div class="section-title-row"><h2>${title}</h2>${A.titleInfo(title, help, `overview-metric-${id}`)}</div>
      ${value}<div class="overview-metric-footer">${note ? `<span>${E(note)}</span>` : ''}${extra}</div>
      </div></article>`;
  }

  const metricValue = (value, unit = '') => `<div class="overview-metric-value"><strong>${E(value)}</strong>${unit ? `<span>${E(unit)}</span>` : ''}</div>`;

  function renderMetrics(activity, earnings, commerce, profit, currency, apple) {
    const current = activity?.current;
    const previous = activity?.previous;
    const currentProfit = earnings?.current;
    const previousProfit = earnings?.previous;
    const status = sectionStatus(commerce);
    const currencyKeys = current ? [...new Set([
      ...Object.keys(current.receipts), ...Object.keys(previous.receipts)
    ])].sort() : [];
    const receipts = currencyKeys.length
      ? `<dl class="overview-receipts">${currencyKeys.map(currency =>
        `<div class="overview-metric-value"><dt>${E(currency)}</dt><dd><strong>${moneyText(current.receipts[currency] || '0')}</strong></dd></div>`).join('')}</dl>`
      : metricValue(current ? '0' : '—', current ? '按原币' : '');
    const receiptChanges = currencyKeys.map(currency => {
      const difference = M.subtract(current.receipts[currency] || '0', previous.receipts[currency] || '0');
      const comparison = '较上期' + changeText(difference, currency, true);
      return `<span>${E(comparison + (M.compare(difference, '0') === 0 ? ` ${currency}` : ''))}</span>`;
    }).join('');
    const refunds = current ? Object.entries(current.refunds).sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => `${moneyText(amount)} ${currency}`) : [];
    const appleReadFailed = apple?.phase === 'error';
    const profitChange = !earnings ? sectionStatus(profit)
      : appleReadFailed ? 'Apple 回款读取失败，利润按现有资料计算。'
      : currentProfit.pending || previousProfit.pending
        ? `环比资料不足${previousProfit.pending ? ` · 上期计算缺项 ${countText(previousProfit.pending)} 笔` : ''}`
        : '较上期' + changeText(M.subtract(currentProfit.amount, previousProfit.amount), currency, true);

    return `<section class="overview-metrics" aria-label="经营概况">
      ${metricCard('orders', metricValue(countText(current?.orders), current ? '笔' : ''),
        current ? '较上期' + changeText(current.orders - previous.orders, '笔') : status,
        current ? `<span>撤单 ${countText(current.cancelled)} 笔</span>` : '')}
      ${metricCard('receipts', receipts, !current ? status : !currencyKeys.length ? '较上期持平' : '',
        current ? `${receiptChanges}<span>退款 ${E(refunds.join(' · ') || '0')}</span>` : '')}
      ${metricCard('profit', metricValue(moneyText(profitValue(currentProfit)), currency), profitChange,
        currentProfit ? `<span class="${currentProfit.pending ? 'overview-warning' : ''}">已计算 ${countText(currentProfit.accounted)} 笔 · 计算缺项 ${countText(currentProfit.pending)} 笔</span>
          ${currentProfit.reference ? `<span>含参考核算 ${countText(currentProfit.reference)} 笔</span>` : ''}
          ${currentProfit.unallocatedCardFees ? `<span>${countText(currentProfit.unallocatedCardFees)} 笔开卡费未分摊</span>` : ''}
          ${profit?.phase === 'error' ? `<span class="overview-warning">${E(sectionStatus(profit))}</span>` : ''}` : '')}
      ${metricCard('customers', metricValue(countText(current?.customers), current ? '位' : ''),
        current ? '较上期' + changeText(current.customers - previous.customers, '位') : status)}
      </section>`;
  }

  function orderInsight({ current, previous }) {
    const changes = products.map(([product]) => [
      product, (current.products[product] || 0) - (previous.products[product] || 0)
    ]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const [product, delta] = changes[0];
    return `订单较上期${changeText(current.orders - previous.orders, '笔')}${delta
      ? `，变化最大的是 ${product}（${changeText(delta, '笔')}）` : ''}。`;
  }

  function chartMarkup(series, mode, label, range, currency) {
    const isProfit = mode === 'profit';
    // Convert only the SVG coordinates to numbers. Display and totals keep the exact decimal strings.
    const values = isProfit ? series.map(row => Number(profitValue(row)))
      : series.flatMap(row => [row.orders, row.cancelled]);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values) || (min === 0 ? 1 : 0);
    const plotWidth = 600;
    const plotHeight = 168;
    const y = value => plotHeight * (max - value) / (max - min);
    const slot = plotWidth / series.length;
    const bar = Math.min(36, slot * (isProfit ? 0.6 : 0.29));
    const base = y(0);
    const rect = (x, value, color) =>
      `<rect class="${color}" x="${x}" y="${Math.min(base, y(value))}" width="${bar}" height="${Math.abs(base - y(value))}" />`;
    const groups = series.map((row, index) => {
      const center = slot * (index + 0.5);
      const amount = profitValue(row);
      const value = Number(amount);
      const date = dayFormatter.format(row.at) + (range === 'today' ? ' ' + hourFormatter.format(row.at) : '');
      const description = [date + '（北京时间）', ...(isProfit ? [
        amount == null ? '利润计算缺项' : `自动计算利润：${moneyText(amount)} ${currency}`,
        `已核算：${countText(row.accounted)} 笔`, `计算缺项：${countText(row.pending)} 笔`
      ] : [`订单量：${countText(row.orders)} 笔`, `撤单：${countText(row.cancelled)} 笔`])].join('\n');
      const marks = !isProfit
        ? rect(center - bar - 1, row.orders, 'overview-bar') + rect(center + 1, row.cancelled, 'overview-bar-cancelled')
        : (amount != null ? rect(center - bar / 2, value, value < 0 ? 'overview-bar-loss' : 'overview-bar') : '') +
          (row.pending ? `<line class="overview-bar-incomplete" x1="${center - bar / 2}" x2="${center + bar / 2}" y1="${Math.max(2, Math.min(plotHeight - 2, y(value)))}" y2="${Math.max(2, Math.min(plotHeight - 2, y(value)))}" />` : '');
      return `<g data-chart-point data-chart-label="${E(description)}" tabindex="${index ? -1 : 0}" role="img" aria-label="${E(description)}" aria-describedby="overview-trend-tooltip">
        <rect class="design-chart-hit" x="${slot * index}" y="0" width="${slot}" height="${plotHeight}" />${marks}</g>`;
    }).join('');
    const middle = (max + min) / 2;
    const ticks = isProfit || Number.isInteger(middle) ? [max, middle, min] : [max, min];
    const labels = [...new Set([0, Math.round((series.length - 1) / 3),
      Math.round((series.length - 1) * 2 / 3), series.length - 1])].map(index => label(series[index].at));
    return `<div class="overview-chart-data">
      <div class="overview-axis-y" aria-hidden="true">${ticks.map(tick => `<span>${axis.format(tick)}</span>`).join('')}</div>
      <div class="overview-plot design-chart-plot"><svg viewBox="0 0 ${plotWidth} ${plotHeight}" preserveAspectRatio="none" role="group" aria-label="${isProfit ? `自动计算利润趋势图，单位 ${currency}` : '订单与撤单数量趋势图'}">
        ${ticks.map(tick => `<line class="overview-grid-line" x1="0" x2="${plotWidth}" y1="${y(tick)}" y2="${y(tick)}" />`).join('')}
        <line class="overview-baseline" x1="0" x2="${plotWidth}" y1="${base}" y2="${base}" />${groups}
      </svg><div id="overview-trend-tooltip" class="design-chart-tooltip overview-chart-tooltip" role="tooltip" hidden></div>
      <div class="overview-axis-x" aria-hidden="true">${labels.map(text => `<span>${text}</span>`).join('')}</div></div>
    </div>`;
  }

  function renderTrend(activity, earnings, section, range, mode, detailsOpen, currency, dateBasis) {
    const isProfit = mode === 'profit';
    const period = isProfit ? earnings?.current : activity?.current;
    const series = period?.series || [];
    const daysPerPoint = period?.daysPerPoint || 1;
    const crossesYear = period && dayFormatter.format(period.start).slice(0, 4) !== dayFormatter.format(period.end).slice(0, 4);
    const dayLabel = value => crossesYear ? dayFormatter.format(value) : dateFormatter.format(value);
    const label = value => range === 'today' ? hourFormatter.format(value) : dayLabel(value);
    const detailLabel = value => daysPerPoint > 1
      ? `${dayLabel(value)} 至 ${dayLabel(Math.min(period.end, value + (daysPerPoint - 1) * 86_400_000))}`
      : label(value);
    const empty = !period ? sectionStatus(section)
      : isProfit && period.pending && !period.accounted ? '本期利润缺少计算数据'
      : !activity?.current?.orders && (isProfit || !period.cancelled) ? '该时间范围没有订单记录' : '';
    const details = series.map(row => `<li><time datetime="${new Date(row.at).toISOString()}">${detailLabel(row.at)}</time>
      <span>${isProfit
        ? `${profitValue(row) == null ? '利润计算缺项' : `${moneyText(profitValue(row))} ${currency}`}${row.pending ? ` · 计算缺项 ${row.pending} 笔` : ''}`
        : `订单 ${countText(row.orders)} 笔 · 撤单 ${countText(row.cancelled)} 笔`}</span></li>`).join('');
    return `<section class="panel overview-section" aria-labelledby="overview-trend"><div class="panel-body">
      ${heading('trend', '经营趋势', '今日按小时统计，其他范围按北京时间日期统计。长区间按多日分组，订单和撤单使用所选订单日期口径。', link('查看订单统计', statisticsRoute(activity?.current, currency, dateBasis), 'orders/statistics'))}
      <div class="overview-chart-tools">${renderControls(chartModes, mode, 'chart', '趋势指标')}
        <div class="overview-legend">${daysPerPoint > 1 ? `<span>每 ${daysPerPoint} 天汇总</span>` : ''}${isProfit
          ? `<span><i></i>自动计算利润（${currency}）</span><span><i class="overview-key-incomplete"></i>计算缺项</span>`
          : '<span><i></i>订单</span><span><i class="overview-key-cancelled"></i>撤单</span>'}</div>
      </div>
      ${empty ? `<div class="overview-chart-empty">${E(empty)}</div>` : chartMarkup(series, mode, label, range, currency)}
      ${period && section?.phase === 'error' ? `<p class="overview-section-note overview-warning">${E(sectionStatus(section))}</p>` : ''}
      ${activity?.current ? `<p class="overview-insight">${A.icon('info')}<span>${E(orderInsight(activity))}</span></p>` : ''}
      ${details ? `<details class="overview-daily" data-overview-details${detailsOpen ? ' open' : ''}>
        <summary>查看${range === 'today' ? '每小时' : daysPerPoint > 1 ? '分段' : '每日'}数据</summary><ul>${details}</ul></details>` : ''}
      </div></section>`;
  }

  function renderTasks(sections, showRechargeRequests) {
    const incomplete = sections.commerce?.data?.incomplete;
    const byProduct = products.filter(([product]) => incomplete?.[product])
      .map(([product, route]) => route && allowed(route)
        ? link(`${product} ${countText(incomplete[product])} 笔`, route)
        : `<span>${E(product)} ${countText(incomplete[product])} 笔</span>`).join('');
    const rows = [
      ['续费待处理', '沿用续费提醒范围', 'workspace/renewals', 'clock', sections.customers, sections.customers?.data?.renewals],
      ['订单待补资料', '按产品核对客户、支付或订阅资料', 'orders/statistics', 'orders', sections.commerce,
        incomplete && Object.values(incomplete).reduce((sum, value) => sum + value, 0), byProduct],
      ['已领用待处理', '核对使用结果或归还', 'workspace/extractions', 'return', sections.inventory, sections.inventory?.data?.pending],
      ['苹果待回款', '已登记，等待确认到账', 'accounts/apple-balances', 'card', sections.apple, sections.apple?.data],
      ...(showRechargeRequests ? [['充值码申请待处理', '待审核或待发码核对', rechargeRequestsRoute, 'key',
        sections.rechargeRequests, sections.rechargeRequests?.data]] : []),
      ['Claude 付租待发放', '待发放或发放失败', 'orders/claude/rentals', 'card', sections.commerce,
        sections.commerce?.data?.pendingRentItems]
    ].filter(([, , route, , section, value]) =>
      allowed(route) && (value !== 0 || section?.phase !== 'ready'));
    const markup = rows.map(([title, note, route, icon, section, value, links]) => {
      const content = `<span class="overview-task-icon">${A.icon(icon)}</span><span class="overview-task-text"><strong>${title}</strong><small>${
        E(section?.phase === 'ready' ? note : sectionStatus(section))
      }</small></span><strong class="overview-task-count">${countText(value)}</strong>`;
      return links ? `<li class="overview-task">${content}<div class="overview-task-links">${links}</div></li>`
        : `<li><a class="overview-task" href="#/${route}">${content}${A.icon('chevron')}</a></li>`;
    }).join('');
    return `<section class="panel overview-section" aria-labelledby="overview-tasks"><div class="panel-body">
      ${heading('tasks', '当前待处理', '数量取自当前业务状态。续费按提醒订单计数，充值码按申请笔数计数，Claude 付租按待发放明细计数。')}
      ${markup ? `<ul class="overview-task-list">${markup}</ul>` : '<p class="overview-section-note">当前没有待处理事项</p>'}
      </div></section>`;
  }

  function renderProducts(activity, earnings, profit, currency, dateBasis) {
    const current = activity?.current;
    const previous = activity?.previous;
    const totals = earnings?.current;
    const rows = products.filter(([product]) => product !== '其他业务' ||
      current?.products[product] || previous?.products[product] || totals?.products[product]).map(([product]) => {
      const orders = current && (current.products[product] || 0);
      const share = current?.orders ? orders / current.orders : 0;
      const total = totals?.products[product];
      return `<tr><th scope="row">${link(product, statisticsRoute(current, currency, dateBasis, { product }), 'orders/statistics') || E(product)}</th><td>${countText(orders)}</td><td>${current ? ratio.format(share) : '—'}</td>
        <td>${moneyText(total ? profitValue(total) : totals && !orders ? '0' : null)}</td><td>${countText(totals ? total?.pending || 0 : null)}</td></tr>`;
    }).join('');
    return `<section class="panel overview-section" aria-labelledby="overview-products"><div class="panel-body">
      ${heading('products', '业务构成', '占比以本期未撤单订单数为分母。利润含实账和参考核算，计算缺项笔数单列。')}
      <table class="overview-data-table overview-product-table" aria-labelledby="overview-products"><thead><tr>
        <th scope="col">业务</th><th scope="col">订单</th><th scope="col">占比</th><th scope="col">利润（${currency}）</th><th scope="col">计算缺项</th>
      </tr></thead><tbody>${rows}</tbody></table>
      ${profit?.phase === 'error' ? `<p class="overview-section-note overview-warning">利润列${E(sectionStatus(profit))}</p>` : ''}
      </div></section>`;
  }

  const stockIssueLabels = [
    ['dead', '死号', 'danger'], ['unlocking', '解封中', 'warning'],
    ['disabled', '邮箱停用', 'warning'], ['frozen', '冻结', 'warning'],
    ['restricted', '封控中', 'warning'], ['aging', '养号中', 'warning'], ['registrationTime', '缺登记时间', 'warning'], ['review', '资料异常', 'warning']
  ];
  function renderOrderProgress(activity, earnings, commerce, profit, currency, dateBasis) {
    const current = activity?.current, accounting = earnings?.current;
    const groups = [
      ['receipts', '收款登记', '已录入实收', '缺少实收资料', current?.receiptConfirmedOrders, current?.orders, commerce],
      ['accounting', '利润自动计算', '已计算', '计算缺项', accounting?.accounted,
        accounting ? current?.orders : null, profit]
    ];
    return `<section class="panel overview-section" aria-labelledby="overview-order-progress"><div class="panel-body">
      ${heading('order-progress', '收款与利润', '收款登记按本期已保存的实收金额和币种统计，无需再次确认；金额或币种缺失时单列。利润按本期同一批订单自动计算，缺少数据时显示缺项。刷新失败时显示最近一次成功读取的结果。',
        accounting?.pending ? link('查看计算缺项', statisticsRoute(current, currency, dateBasis, { view: 'gaps' }), 'orders/statistics') : '')}
      <div class="overview-progress-content">${groups.map(([id, title, doneLabel, pendingLabel, done, total, section]) => {
        const known = Number.isSafeInteger(done) && Number.isSafeInteger(total);
        const pending = known ? total - done : null;
        return `<section class="overview-progress-group" data-overview-progress-group="${id}">
          <div class="overview-progress-heading"><h3>${title}</h3><span>${known ? total ? ratio.format(done / total) : '暂无订单' : '—'}</span></div>
          <dl class="overview-progress-counts"><div><dt>${doneLabel}</dt><dd data-progress-count="done">${countText(done)}<small>笔</small></dd></div>
            <div><dt>${pendingLabel}</dt><dd data-progress-count="pending">${countText(pending)}<small>笔</small></dd></div></dl>
          ${known && total ? `<progress value="${done}" max="${total}" aria-label="${title}进度"></progress>` : ''}
          <p class="overview-section-note${section?.phase === 'error' ? ' overview-warning' : ''}">${E(sectionStatus(section))}</p>
        </section>`;
      }).join('')}</div>
      <p class="overview-section-note">已撤单 ${countText(current?.cancelled)} 笔 · 已核算中含参考核算 ${countText(accounting?.reference)} 笔</p>
    </div></section>`;
  }
  function stockCell(column, value, tone = '') {
    const text = typeof value === 'string' ? E(value) : countText(value);
    return `<td data-stock-column="${column}"${value === 0 || value == null ? ' class="overview-stock-muted"' : ''}>${
      tone && value > 0 ? A.tag(text, tone) : text}</td>`;
  }

  function renderInventory(section) {
    const stock = section?.data?.stocks;
    const rows = inventories.filter(([, , route]) => allowed(route)).map(([key, name, route]) => {
      const row = stock?.[key];
      const cells = stockCell('registered', row?.registered) +
        stockCell('available', row?.available) +
        stockCell('used', row?.used) + stockCell('claimed', row?.claimed) + stockIssueLabels.map(([column, , tone]) =>
          stockCell(column, column === 'disabled' && key !== 'relay' ? null : row?.issues?.[column], tone)).join('');
      return `<tr data-stock-type="${key}"><th scope="row">${link(name, route)}</th>${cells}</tr>`;
    }).join('');
    if (!rows) return '';
    return `<section class="panel overview-section overview-inventory-section" aria-labelledby="overview-inventory"><div class="panel-body">
      ${heading('inventory', '库存现状', '已登记为当前保存的资料总数，包含已使用资料，排除已删除的隐藏邮箱。可提取沿用资格和占用规则，Claude 按养号要求计算，隐藏邮箱显示最近成功检查的数量；微软邮箱暂未接入提取。异常状态从左到右优先归类，每条资料只计一种，与库存占用可能重叠，各列不可直接相加。0 表示已统计且没有，— 表示不适用或尚未取得数据。窄屏可横向滚动查看所有列。')}
      <div class="table-viewport overview-stock-viewport" tabindex="0" role="region" aria-label="库存状态统计，可横向滚动查看所有列">
        <table class="overview-data-table overview-stock-table" aria-labelledby="overview-inventory"><thead><tr>
          <th scope="col">类型</th><th scope="col">已登记</th><th scope="col">可提取</th><th scope="col">已使用</th><th scope="col">已领用</th>
          ${stockIssueLabels.map(([, label]) => `<th scope="col">${label}</th>`).join('')}
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
      <p class="overview-section-note${section?.phase === 'error' ? ' overview-warning' : ''}">${E(sectionStatus(section))}
        ${stock?.relay?.availabilityStale || stock?.relay?.checkedAt ? `<span${stock.relay.availabilityStale ? ' class="overview-warning"' : ''}> · ${stock.relay.availabilityStale ? '隐藏邮箱检查暂时不可用' : '隐藏邮箱已检查'}${stock.relay.checkedAt ? ` ${E(timeFormatter.format(new Date(stock.relay.checkedAt)))}` : ''}</span>` : ''}</p>
      </div></section>`;
  }

  function renderCustomers(section) {
    const data = section?.data;
    const items = [
      ['有效服务', data?.active, '客户列表', 'customers/list'],
      ['续费待跟进', data?.followUp, '续费管理', 'workspace/renewals'],
      ['已确认流失', data?.lost, '流失明细', 'workspace/customer-loss']
    ];
    const details = [
      ['renewals', '待处理续费单', data?.renewals, '笔', 'workspace/renewals'],
      ['scheduled', '待生效客户', data?.scheduled, '位', 'workspace/customer-loss'],
      ['recent', '近 7 天流失', data?.recentlyLost, '位', 'workspace/customer-loss'],
      ['review', '资料问题订单', data?.review, '笔', 'workspace/customer-loss']
    ];
    return `<section class="panel overview-section overview-customer-section" aria-labelledby="overview-customers"><div class="panel-body">
      ${heading('customers', '客户状态', '按客户编号去重。客户名下仍有有效服务时不计流失，续费待跟进可与有效服务重叠。手工及历史订单按已录入周期统计，无需再次确认开通或付款。待生效指曾开通过、当前无有效服务但已登记未来订阅的客户；近 7 天流失取已确认流失中停止服务不足 7 个北京时间自然日的客户。续费单和资料问题订单按笔数列示，不能与客户数相加。所有数据取当前快照，不随顶部经营区间切换。')}
      <div class="overview-customer-content">
        <dl class="overview-customer-summary">${items.map(([title, value, action, route]) => `<div>
          <dt>${title}</dt><dd><span class="overview-customer-count">${countText(value)}${value != null ? '<small>位</small>' : ''}</span>${link(action, route)}</dd>
          </div>`).join('')}</dl>
        <ul class="overview-customer-details" aria-label="客户跟进与数据核对">${details.map(([id, label, value, unit, route]) => {
          const content = `<span>${label}</span><span class="overview-customer-detail-count"><strong>${countText(value)}</strong><small>${unit}</small></span>`;
          const action = !allowed(route) ? `<div class="overview-customer-detail">${content}</div>`
            : id === 'renewals' ? `<a class="overview-customer-detail" href="#/${route}">${content}${A.icon('chevron')}</a>`
              : `<button class="overview-customer-detail" type="button" data-action="commerce-loss-open" data-view="${id}">${content}${A.icon('chevron')}</button>`;
          return `<li data-customer-detail="${id}">${action}</li>`;
        }).join('')}</ul>
      </div>
      <p class="overview-section-note${section?.phase === 'error' ? ' overview-warning' : ''}">${E(sectionStatus(section))}</p>
      </div></section>`;
  }

  function accountingFilters(dateBasis, currency, suffix = '') {
    return [[dateBases, dateBasis, 'dateBasis', '订单日期口径'], [currencies, currency, 'currency', '利润币种']]
      .map(([items, selected, id, label]) => `<select id="overview-${id}${suffix}" data-overview-accounting-filter="${id}" aria-label="${label}">${A.options(items, selected)}</select>`).join('');
  }

  function renderToolbar(finance, activity, section, range, dateBasis, currency) {
    const custom = range === 'custom';
    const title = activity ? windowText(activity.current) : finance ? '统计区间' : '库存快照';
    const compactTitle = activity
      ? `${dateFormatter.format(activity.current.start)}–${dateFormatter.format(activity.current.end)}` : title;
    const status = sectionStatus(section);
    const shortStatus = section?.phase === 'error' ? '读取失败' :
      section?.updated != null ? `更新于 ${hourFormatter.format(section.updated)}` : status;
    return `<div class="overview-toolbar-container"><div class="overview-toolbar">
      <div class="overview-period">
        <strong>${E(title)}</strong><span class="overview-timezone">北京时间</span>
        ${activity ? `<span class="overview-previous">对比 ${E(windowText(activity.previous))}</span>` : ''}
        ${activity ? A.textAction('上期对比', 'overview-period', 'aria-haspopup="dialog"', 'overview-previous-compact') : ''}
        ${A.textAction(compactTitle, 'overview-period', 'aria-label="查看统计区间与更新时间" aria-haspopup="dialog"', 'overview-period-compact')}
      </div>
      <div class="overview-actions">
        ${finance ? renderControls(ranges, range, 'range', '统计时间范围',
          A.button('自定义日期', 'overview-date-range', custom ? 'primary' : '', '',
            `aria-haspopup="dialog" aria-pressed="${custom}"`)) +
          `<select id="overview-range-compact" aria-label="统计时间范围">${ranges.map(([id, label]) =>
            `<option value="${id}"${id === range ? ' selected' : ''}>${label}</option>`).join('')}${
            custom ? '<option value="custom" selected>自定义区间</option>' : ''}
            <option value="choose-custom">自定义日期</option></select>` : ''}
        ${finance ? `<div class="overview-accounting-filters">${accountingFilters(dateBasis, currency)}</div>` : ''}
        ${business ? `<button type="button" class="button overview-toolbar-action${section?.phase === 'error' ? ' overview-warning' : ''}"
          data-action="overview-refresh" aria-label="刷新数据" aria-describedby="overview-toolbar-status">${A.icon('refresh')}<span>刷新数据</span></button>` : ''}
        <span class="overview-design-label${section?.phase === 'error' ? ' overview-warning' : ''}" title="${E(status)}">
          <span id="overview-toolbar-status" class="overview-status-announcement" role="status">${E(status)}</span>
          <span class="overview-status-full" aria-hidden="true">${E(status)}</span>
          <span class="overview-status-short" aria-hidden="true">${E(shortStatus)}</span>
        </span>
        <button type="button" class="button overview-toolbar-action" data-action="overview-methodology"
          aria-label="指标口径" aria-haspopup="dialog">${A.icon('info')}<span>指标口径</span></button>
      </div></div></div>`;
  }

  function render() {
    const key = overviewKey();
    const sections = business?.queries.peek('overview', key)?.data || {};
    const { range = 'week', chart = 'orders', detailsOpen } = A.state.drafts.get(draftKey) || {};
    const activity = sections.commerce?.data?.ranges?.[range];
    const profit = sections['profit:' + range];
    const earnings = profit?.data;
    const inventory = renderInventory(sections.inventory);
    return A.header('网站总览', '查看经营指标、变化来源和当前需要处理的事项。') +
      `<div class="website-overview design-async-region"><div data-overview-progress role="status" hidden></div>
        ${renderToolbar(key.finance, activity, key.finance ? sections.commerce : sections.inventory, range, key.dateBasis, key.currency)}
        ${key.finance ? `${renderMetrics(activity, earnings, sections.commerce, profit, key.currency, sections.apple)}
          <div class="overview-columns">${renderTrend(activity, earnings, chart === 'profit' ? profit : sections.commerce, range, chart, detailsOpen, key.currency, key.dateBasis)}${renderTasks(sections, key.rechargeRequests)}</div>
          <div class="overview-business"><div class="overview-business-grid">${renderProducts(activity, earnings, profit, key.currency, key.dateBasis)}${renderOrderProgress(activity, earnings, sections.commerce, profit, key.currency, key.dateBasis)}</div></div>
          <div class="overview-snapshots"><div class="overview-snapshot-grid">${inventory}${allowed('customers/list') ? renderCustomers(sections.customers) : ''}</div></div>` : inventory}
      </div>`;
  }

  function openMethodology() {
    const finance = allowed('orders/statistics');
    const items = finance ? [
      ...metrics.map(([, title, note]) => [title, note]),
      ['时间与对比', '预设区间包含今日。自定义区间包含起止日，今日截止到本次快照。比较区间向前平移相同天数。待办、库存和客户状态取当前快照。'],
      ['利润公式', '客户实际收款减客户退款得到净收款。实际总成本或适用费用合计减去渠道已到账回款得到净成本。逐单利润等于净收款减净成本。'],
      ['数据覆盖', '统计已录入的订单和已同步的代充订单。网站访问量、全量代充任务在各自模块核对。站点与执行器状态见监控中心。'],
      ['其他业务栏目', '网站访问和谷歌表格同步状态可在数据中心查看。Gemini、Grok 和 Claude 代充见各自栏目。']
    ] : [];
    items.push(['库存与数据状态', '成功读到空数据时显示 0，未取得数据时显示「—」。刷新失败保留上次成功内容与时间。']);
    A.openDrawer('指标口径', '经营数据统一使用北京时间。',
      `<div class="guide-list">${items.map(([title, note]) => `<section class="guide-item"><h3>${title}</h3><p>${note}</p></section>`).join('')}</div>`,
      A.button('关闭', 'drawer-close'));
  }

  function openPeriod() {
    const key = overviewKey();
    const sections = business?.queries.peek('overview', key)?.data || {};
    const range = A.state.drafts.get(draftKey)?.range || 'week';
    const activity = sections.commerce?.data?.ranges?.[range];
    const section = key.finance ? sections.commerce : sections.inventory;
    const items = [
      ['时区', '北京时间'],
      ...(key.finance ? [['本期', windowText(activity?.current) || '未取得'],
        ['上期', windowText(activity?.previous) || '未取得']] : []),
      ['数据状态', sectionStatus(section)]
    ];
    A.openDrawer(key.finance ? '统计区间' : '库存快照', '',
      `<div class="property-list">${items.map(([label, value]) =>
        `<div class="property-row"><span>${label}</span><strong>${E(value)}</strong></div>`).join('')}</div>${key.finance ? `<div class="toolbar">${accountingFilters(key.dateBasis, key.currency, '-drawer')}</div>` : ''}`,
      A.button('关闭', 'drawer-close'));
  }

  function updateFilter(field, value) {
    const items = { range: ranges, chart: chartModes, dateBasis: dateBases, currency: currencies }[field];
    if (!items.some(([id]) => id === value)) return;
    A.state.drafts.set(draftKey, { ...A.state.drafts.get(draftKey), [field]: value });
    A.render();
    if (field !== 'chart') void refreshOverview();
  }

  function openDateRange() {
    if (!overviewKey().finance) return;
    const today = dayFormatter.format(Date.now());
    const selected = A.state.drafts.get(draftKey)?.custom || [
      dayFormatter.format(Date.now() - 6 * 86_400_000), today
    ];
    A.openDrawer('选择统计日期', '按北京时间统计，起止日均纳入统计。',
      `<form id="overview-date-form" novalidate>
        ${A.field('开始日期', 'overview-date-from', A.input('overview-date-from', selected[0], `type="date" max="${today}" required`), true)}
        ${A.field('结束日期', 'overview-date-to', A.input('overview-date-to', selected[1], `type="date" max="${today}" required`), true)}
      </form>`, '<button type="submit" class="button primary" form="overview-date-form">应用日期</button>');
  }

  function onClick(action, node) {
    if (action === 'overview-date-range') {
      openDateRange();
      return true;
    }
    if (action === 'overview-refresh') {
      void A.withActionFeedback(node, () => refreshOverview({ refresh: true }),
        { pending: '', success: '总览数据已刷新', failure: '部分数据未能更新，请查看对应区块' });
      return true;
    }
    if (action === 'overview-range' || action === 'overview-chart') {
      const field = action === 'overview-range' ? 'range' : 'chart';
      const value = node.dataset.value;
      updateFilter(field, value);
      A.$(`[data-action="${action}"][data-value="${value}"]`)?.focus({ preventScroll: true });
      return true;
    }
    if (action === 'overview-period') {
      openPeriod();
      return true;
    }
    if (action === 'overview-methodology') {
      openMethodology();
      return true;
    }
    return false;
  }

  function onSubmit(form) {
    if (form.id !== 'overview-date-form') return false;
    if (A.state.route !== 'overview' || !overviewKey().finance) return true;
    const from = form.elements['overview-date-from'].value;
    const to = form.elements['overview-date-to'].value;
    const today = dayFormatter.format(Date.now());
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const fromError = !date.test(from) ? '请选择开始日期' : from > today ? '开始日期不能晚于今天' : '';
    const toError = !date.test(to) ? '请选择结束日期' : to > today ? '结束日期不能晚于今天' :
      from && to < from ? '结束日期不能早于开始日期' : '';
    A.setError('overview-date-from', fromError);
    A.setError('overview-date-to', toError);
    if (fromError || toError) return true;
    A.state.drafts.set(draftKey, { ...A.state.drafts.get(draftKey), range: 'custom', custom: [from, to] });
    A.closeDrawer();
    A.render();
    A.$('[data-action="overview-date-range"]')?.focus({ preventScroll: true });
    A.$('#overview-range-compact')?.focus({ preventScroll: true });
    void refreshOverview();
    return true;
  }

  A.modules.overview = { refresh: refreshOverview };
  window.IDDesignModules.push({
    id: 'overview', matches: route => route === 'overview', render, onClick, onSubmit,
    onChange(node) {
      if (node.dataset.overviewAccountingFilter) {
        updateFilter(node.dataset.overviewAccountingFilter, node.value);
        A.$('#' + node.id)?.focus({ preventScroll: true });
        return true;
      }
      if (node.id !== 'overview-range-compact') return false;
      if (node.value === 'choose-custom') {
        node.value = A.state.drafts.get(draftKey)?.range || 'week';
        openDateRange();
        return true;
      }
      updateFilter('range', node.value);
      A.$('#overview-range-compact')?.focus({ preventScroll: true });
      return true;
    },
    afterRender({ routeChanged } = {}) {
      if (refreshing?.id === JSON.stringify(overviewKey())) bindOverviewRead();
      const details = A.$('#main [data-overview-details]');
      details?.addEventListener('toggle', () => {
        if (!details.isConnected) return;
        A.state.drafts.set(draftKey, { ...A.state.drafts.get(draftKey), detailsOpen: details.open });
      });
      if (routeChanged) queueMicrotask(() => {
        if (A.state.route === 'overview') void refreshOverview();
      });
    }
  });
})();
