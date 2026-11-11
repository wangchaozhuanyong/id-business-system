/* 网站总览复用各业务模块的只读汇总。 */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const E = A.esc;
  const M = A.money;
  const business = window.IDLocalData;
  const draftKey = 'overview:filters';
  const ranges = [['today', '今日'], ['week', '近 7 天'], ['month', '近 30 天']];
  const chartModes = [['orders', '订单量'], ['profit', '已核算利润']];
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
    ['orders', '新建订单', '按北京时间的创建时间统计。已撤单另列，续费新单计入订单量。'],
    ['receipts', '订单实收', '已确认的实收按订单创建时间归集，按原币分列。客户退款按登记时间另列。'],
    ['profit', '已核算利润', '合计包含实账与参考核算。按开通时的汇率、冻结规则及同卡开卡成本分摊计算。无原卡的 GPT 参考利润注明开卡费未分摊。'],
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
  const link = (label, route) => route && allowed(route)
    ? `<a class="overview-link" href="#/${E(route)}">${E(label)}${A.icon('chevron')}</a>` : '';
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
    return {
      actor: actor?.id || '', role: actor?.role || '', finance,
      apple: finance && allowed('accounts/apple-balances')
    };
  }

  async function readSource(load) {
    try { return await load(); }
    catch { return false; }
  }

  async function loadOverview(key) {
    const previous = business.queries.peek('overview', key)?.data || {};
    const { commerce, inventory, appleBalance } = A.modules;
    const [inventoryReady, commerceReady, appleReady] = await Promise.all([
      readSource(() => inventory.refreshOverview()),
      key.finance && readSource(() => commerce.refreshOverview()),
      key.apple && readSource(() => appleBalance.refreshLocalBalance())
    ]);
    const asOf = Date.now();
    const section = (name, data) => data === false || data == null
      ? { ...previous[name], phase: 'error' }
      : { data, updated: asOf, phase: 'ready' };
    const stock = await readSource(() => inventoryReady && inventory.overviewSummary());
    const snapshot = { inventory: section('inventory', stock) };
    if (key.finance) {
      const [summary, customers] = await Promise.all([
        readSource(() => commerceReady && commerce.overviewSummary(asOf, appleReady)),
        readSource(() => commerceReady && inventoryReady && commerce.overviewCustomerSummary(asOf))
      ]);
      snapshot.commerce = section('commerce', summary?.commerce);
      snapshot.customers = section('customers', customers);
      for (const [range] of ranges)
        snapshot['profit:' + range] = section('profit:' + range, summary?.profit?.[range]);
    }
    if (key.apple) snapshot.apple = section('apple', await readSource(() =>
      appleReady && appleBalance.listRefunds().filter(row => row.status === 'pending').length));
    return snapshot;
  }

  function refreshOverview({ refresh = false } = {}) {
    if (!business) return;
    if (refreshing) return refreshing;
    const key = overviewKey();
    const cached = business.queries.peek('overview', key);
    const last = cached?.data?.inventory?.updated;
    if (!refresh && !cached?.stale && last != null &&
        dayFormatter.format(last) === dayFormatter.format(Date.now())) return;
    const ready = snapshot => Object.values(snapshot).every(section => section.phase === 'ready');
    const read = () => business.queries.read('overview', key, () => loadOverview(key), {
      refresh: true, isFresh: ready
    });
    refreshing = read().catch(error => {
      // A change notification can invalidate an in-flight read. An expired session clears the entry.
      if (error?.name === 'AbortError' && A.state.route === 'overview' &&
          business.queries.peek('overview', key)?.stale &&
          JSON.stringify(overviewKey()) === JSON.stringify(key)) return read();
      throw error;
    }).then(ready).catch(error =>
      error?.name === 'AbortError' && !business.queries.peek('overview', key)?.stale ? undefined : false
    ).finally(() => {
      regionRead?.finish();
      regionRead = undefined;
      refreshing = undefined;
      if (A.state.route === 'overview') A.render();
    });
    bindOverviewRead();
    return refreshing;
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

  function renderControls(items, selected, name, label) {
    return `<div class="overview-controls" role="group" aria-label="${label}">${items.map(([id, title]) =>
      A.button(title, 'overview-' + name, id === selected ? 'primary' : '', '',
        `data-value="${id}" aria-pressed="${id === selected}"`)).join('')}</div>`;
  }

  function metricCard(id, value, note, extra = '') {
    const [, title, help] = metrics.find(metric => metric[0] === id);
    return `<article class="panel overview-metric" data-overview-metric="${id}"><div class="panel-body">
      <div class="section-title-row"><h2>${title}</h2>${A.titleInfo(title, help, `overview-metric-${id}`)}</div>
      ${value}<div class="overview-metric-footer">${note ? `<span>${E(note)}</span>` : ''}${extra}</div>
      </div></article>`;
  }

  const metricValue = (value, unit = '') => `<div class="overview-metric-value"><strong>${E(value)}</strong>${unit ? `<span>${unit}</span>` : ''}</div>`;

  function renderMetrics(activity, earnings, commerce, profit) {
    const current = activity?.current;
    const previous = activity?.previous;
    const currentProfit = earnings?.current;
    const previousProfit = earnings?.previous;
    const status = sectionStatus(commerce);
    const currencyKeys = current ? [...new Set([
      ...Object.keys(current.receipts), ...Object.keys(previous.receipts)
    ])].sort() : [];
    const receipts = currencyKeys.length
      ? `<dl class="overview-receipts">${currencyKeys.map(currency => {
        const value = current.receipts[currency] || '0';
        return `<div><dt>${E(currency)}</dt><dd><strong>${moneyText(value)}</strong><small>较上期${changeText(M.subtract(value, previous.receipts[currency] || '0'), currency, true)}</small></dd></div>`;
      }).join('')}</dl>`
      : metricValue(current ? '0' : '—', current ? '按原币' : '');
    const refunds = current ? Object.entries(current.refunds).sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => `${moneyText(amount)} ${currency}`) : [];
    const profitChange = !earnings ? sectionStatus(profit)
      : currentProfit.pending || previousProfit.pending
        ? `环比待核算${previousProfit.pending ? ` · 上期待核算 ${countText(previousProfit.pending)} 笔` : ''}`
        : '较上期' + changeText(M.subtract(currentProfit.amount, previousProfit.amount), 'CNY', true);

    return `<section class="overview-metrics" aria-label="经营概况">
      ${metricCard('orders', metricValue(countText(current?.orders), current ? '笔' : ''),
        current ? '较上期' + changeText(current.orders - previous.orders, '笔') : status,
        current ? `<span>撤单 ${countText(current.cancelled)} 笔</span>` : '')}
      ${metricCard('receipts', receipts, !current ? status : !currencyKeys.length ? '较上期持平' : '',
        current ? `<span>退款 ${E(refunds.join(' · ') || '0')}</span>` : '')}
      ${metricCard('profit', metricValue(moneyText(profitValue(currentProfit)), 'CNY'), profitChange,
        currentProfit ? `<span class="${currentProfit.pending ? 'overview-warning' : ''}">已核算 ${countText(currentProfit.accounted)} 笔 · 待核算 ${countText(currentProfit.pending)} 笔</span>
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

  function chartMarkup(series, mode, label) {
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
      if (!isProfit) return `<g><title>${label(row.at)} · 订单 ${row.orders} 笔 · 撤单 ${row.cancelled} 笔</title>${
        rect(center - bar - 1, row.orders, 'overview-bar') + rect(center + 1, row.cancelled, 'overview-bar-cancelled')
      }</g>`;
      const amount = profitValue(row);
      const value = Number(amount);
      return `<g><title>${label(row.at)} · ${amount == null ? '利润待核算' : `利润 ${moneyText(amount)} CNY`} · 待核算 ${row.pending} 笔</title>${
        amount != null ? rect(center - bar / 2, value, value < 0 ? 'overview-bar-loss' : 'overview-bar') : ''
      }${row.pending ? `<line class="overview-bar-incomplete" x1="${center - bar / 2}" x2="${center + bar / 2}" y1="${Math.max(2, Math.min(plotHeight - 2, y(value)))}" y2="${Math.max(2, Math.min(plotHeight - 2, y(value)))}" />` : ''}</g>`;
    }).join('');
    const middle = (max + min) / 2;
    const ticks = isProfit || Number.isInteger(middle) ? [max, middle, min] : [max, min];
    const labels = [...new Set([0, Math.round((series.length - 1) / 3),
      Math.round((series.length - 1) * 2 / 3), series.length - 1])].map(index => label(series[index].at));
    return `<div class="overview-chart-data">
      <div class="overview-axis-y" aria-hidden="true">${ticks.map(tick => `<span>${axis.format(tick)}</span>`).join('')}</div>
      <div class="overview-plot"><svg viewBox="0 0 ${plotWidth} ${plotHeight}" preserveAspectRatio="none" role="img" aria-label="${isProfit ? '已核算利润趋势图，单位人民币' : '订单与撤单数量趋势图'}">
        ${ticks.map(tick => `<line class="overview-grid-line" x1="0" x2="${plotWidth}" y1="${y(tick)}" y2="${y(tick)}" />`).join('')}
        <line class="overview-baseline" x1="0" x2="${plotWidth}" y1="${base}" y2="${base}" />${groups}
      </svg><div class="overview-axis-x" aria-hidden="true">${labels.map(text => `<span>${text}</span>`).join('')}</div></div>
    </div>`;
  }

  function renderTrend(activity, earnings, section, range, mode, detailsOpen) {
    const isProfit = mode === 'profit';
    const period = isProfit ? earnings?.current : activity?.current;
    const series = period?.series || [];
    const label = value => (range === 'today' ? hourFormatter : dateFormatter).format(value);
    const empty = !period ? sectionStatus(section)
      : isProfit && period.pending && !period.accounted ? '本期利润待核算'
      : !isProfit && !period.orders && !period.cancelled ? '该时间范围没有订单记录' : '';
    const details = series.map(row => `<li><time datetime="${new Date(row.at).toISOString()}">${label(row.at)}</time>
      <span>${isProfit
        ? `${profitValue(row) == null ? '利润待核算' : `${moneyText(profitValue(row))} CNY`}${row.pending ? ` · 待核算 ${row.pending} 笔` : ''}`
        : `订单 ${countText(row.orders)} 笔 · 撤单 ${countText(row.cancelled)} 笔`}</span></li>`).join('');
    return `<section class="panel overview-section" aria-labelledby="overview-trend"><div class="panel-body">
      ${heading('trend', '经营趋势', '今日按小时统计，其他范围按北京时间自然日统计。订单和撤单按创建时间归集。', link('查看订单统计', 'orders/statistics'))}
      <div class="overview-chart-tools">${renderControls(chartModes, mode, 'chart', '趋势指标')}
        <div class="overview-legend">${isProfit
          ? '<span><i></i>已核算利润（CNY）</span><span><i class="overview-key-incomplete"></i>有待核算</span>'
          : '<span><i></i>订单</span><span><i class="overview-key-cancelled"></i>撤单</span>'}</div>
      </div>
      ${empty ? `<div class="overview-chart-empty">${E(empty)}</div>` : chartMarkup(series, mode, label)}
      ${period && section?.phase === 'error' ? `<p class="overview-section-note overview-warning">${E(sectionStatus(section))}</p>` : ''}
      ${activity?.current ? `<p class="overview-insight">${A.icon('info')}<span>${E(orderInsight(activity))}</span></p>` : ''}
      ${details ? `<details class="overview-daily" data-overview-details${detailsOpen ? ' open' : ''}>
        <summary>查看${range === 'today' ? '每小时' : '每日'}数据</summary><ul>${details}</ul></details>` : ''}
      </div></section>`;
  }

  function renderTasks(sections) {
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
      ['苹果待回款', '已登记，等待确认到账', 'accounts/apple-balances', 'card', sections.apple, sections.apple?.data]
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
      ${heading('tasks', '当前待处理', '数量取自当前业务状态。续费按提醒订单计数，客户区按客户去重。')}
      ${markup ? `<ul class="overview-task-list">${markup}</ul>` : '<p class="overview-section-note">当前没有待处理事项</p>'}
      </div></section>`;
  }

  function renderProducts(activity, earnings, profit) {
    const current = activity?.current;
    const previous = activity?.previous;
    const totals = earnings?.current;
    const rows = products.filter(([product]) => product !== '其他业务' ||
      current?.products[product] || previous?.products[product] || totals?.products[product]).map(([product, route]) => {
      const orders = current && (current.products[product] || 0);
      const share = current?.orders ? orders / current.orders : 0;
      const total = totals?.products[product];
      return `<tr><th scope="row">${link(product, route) || E(product)}</th><td>${countText(orders)}</td><td>${current ? ratio.format(share) : '—'}</td>
        <td>${moneyText(total ? profitValue(total) : totals ? '0' : null)}</td><td>${countText(totals ? total?.pending || 0 : null)}</td></tr>`;
    }).join('');
    return `<section class="panel overview-section" aria-labelledby="overview-products"><div class="panel-body">
      ${heading('products', '业务构成', '占比以本期未撤单订单数为分母。利润含实账和参考核算，以人民币列示，待核算笔数单列。')}
      <table class="overview-data-table overview-product-table" aria-labelledby="overview-products"><thead><tr>
        <th scope="col">业务</th><th scope="col">订单</th><th scope="col">占比</th><th scope="col">利润（CNY）</th><th scope="col">待核算</th>
      </tr></thead><tbody>${rows}</tbody></table>
      ${profit?.phase === 'error' ? `<p class="overview-section-note overview-warning">利润列${E(sectionStatus(profit))}</p>` : ''}
      </div></section>`;
  }

  function renderInventory(section) {
    const stock = section?.data?.stocks;
    const rows = inventories.filter(([, , route]) => allowed(route)).map(([key, name, route]) => {
      const row = stock?.[key];
      const cells = key === 'microsoft'
        ? `<td colspan="3">已登记 ${countText(row?.registered)} 条</td>`
        : `<td>${key === 'relay' ? '需核验' : countText(row?.available)}</td>
          <td>${countText(row?.claimed)}</td><td class="${row?.abnormal ? 'overview-warning' : ''}">${countText(row?.abnormal)}</td>`;
      return `<tr><th scope="row">${link(name, route)}</th>${cells}</tr>`;
    }).join('');
    if (!rows) return '';
    return `<section class="panel overview-section" aria-labelledby="overview-inventory"><div class="panel-body">
      ${heading('inventory', '库存现状', '可用数量沿用可提取资格与占用规则。Claude 包含养号要求，苹果隐藏邮箱的提取资格需远端核验。')}
      <table class="overview-data-table overview-stock-table" aria-labelledby="overview-inventory"><thead><tr>
        <th scope="col">类型</th><th scope="col">可用</th><th scope="col">已领用</th><th scope="col">异常</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="overview-section-note${section?.phase === 'error' ? ' overview-warning' : ''}">${E(sectionStatus(section))}</p>
      </div></section>`;
  }

  function renderCustomers(section) {
    const data = section?.data;
    const items = [['有效服务', data?.active], ['续费待跟进', data?.followUp], ['已确认流失', data?.lost]];
    return `<section class="panel overview-section" aria-labelledby="overview-customers"><div class="panel-body">
      ${heading('customers', '客户状态', '按客户编号去重。客户名下仍有有效服务时不计为流失。归属和服务周期存疑的订单另列。', link('查看客户流失', 'workspace/customer-loss'))}
      <dl class="overview-customer-summary">${items.map(([title, value]) => `<div><dt>${title}</dt><dd>${countText(value)}${value != null ? '<small>位</small>' : ''}</dd></div>`).join('')}</dl>
      <p class="overview-section-note">待核对订单 ${countText(data?.review)} 笔</p>
      <p class="overview-section-note${section?.phase === 'error' ? ' overview-warning' : ''}">${E(sectionStatus(section))}</p>
      </div></section>`;
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
        <div class="overview-toolbar"><div class="overview-period">
          <strong>${activity ? E(windowText(activity.current)) : key.finance ? '统计区间' : '库存快照'}</strong>
          <span>北京时间${activity ? ` · 对比 ${E(windowText(activity.previous))}` : ''}</span>
          <span class="overview-design-label" role="status">${E(sectionStatus(key.finance ? sections.commerce : sections.inventory))}</span>
        </div><div class="toolbar-right">
          ${key.finance ? renderControls(ranges, range, 'range', '统计时间范围') : ''}
          ${business ? A.button('刷新数据', 'overview-refresh') : ''}
          ${A.button('指标口径', 'overview-methodology', '', 'info')}
        </div></div>
        ${key.finance ? `${renderMetrics(activity, earnings, sections.commerce, profit)}
          <div class="overview-columns">${renderTrend(activity, earnings, chart === 'profit' ? profit : sections.commerce, range, chart, detailsOpen)}${renderTasks(sections)}</div>
          ${renderProducts(activity, earnings, profit)}
          <div class="overview-columns">${inventory}${allowed('customers/list') ? renderCustomers(sections.customers) : ''}</div>` : inventory}
      </div>`;
  }

  function openMethodology() {
    const finance = allowed('orders/statistics');
    const items = finance ? [
      ...metrics.map(([, title, note]) => [title, note]),
      ['时间与对比', '近 7 天和近 30 天包含今日。比较区间向前平移对应天数，截止到与本期相同的北京时间。待办、库存和客户状态取当前快照。'],
      ['数据覆盖', '统计已录入的订单和已同步的代充订单。网站访问量、全量代充任务在各自模块核对。站点与执行器状态见监控中心。'],
      ['其他业务栏目', 'Gemini、Grok、Claude 代充、Google 表格同步及数据中心的规划入口见各自栏目。']
    ] : [];
    items.push(['库存与数据状态', '成功读到空数据时显示 0，未取得数据时显示「—」。刷新失败保留上次成功内容与时间。']);
    A.openDrawer('指标口径', '经营数据统一使用北京时间。',
      `<div class="guide-list">${items.map(([title, note]) => `<section class="guide-item"><h3>${title}</h3><p>${note}</p></section>`).join('')}</div>`,
      A.button('关闭', 'drawer-close'));
  }

  function onClick(action, node) {
    if (action === 'overview-refresh') {
      void A.withActionFeedback(node, () => refreshOverview({ refresh: true }),
        { pending: '', success: '总览数据已刷新', failure: '部分数据未能更新，请查看对应区块' });
      return true;
    }
    if (action === 'overview-range' || action === 'overview-chart') {
      const field = action === 'overview-range' ? 'range' : 'chart';
      const items = field === 'range' ? ranges : chartModes;
      const value = node.dataset.value;
      if (items.some(([id]) => id === value)) {
        const draft = A.state.drafts.get(draftKey);
        A.state.drafts.set(draftKey, { ...draft, [field]: value });
        A.render();
        A.$(`[data-action="${action}"][data-value="${value}"]`)?.focus({ preventScroll: true });
      }
      return true;
    }
    if (action === 'overview-methodology') {
      openMethodology();
      return true;
    }
    return false;
  }

  A.modules.overview = { refresh: refreshOverview };
  window.IDDesignModules.push({
    id: 'overview', matches: route => route === 'overview', render, onClick,
    afterRender({ routeChanged } = {}) {
      if (refreshing) bindOverviewRead();
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
