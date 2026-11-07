/* 网站总览复用各业务模块的只读汇总。 */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const E = A.esc;
  const draftKey = 'overview:filters';
  const ranges = [['today', '今日'], ['week', '近 7 天'], ['month', '近 30 天']];
  const business = window.IDLocalData;
  const sections = {
    commerce: { label: '订单与客户' },
    inventory: { label: '库存' },
    apple: { label: '苹果待回款' }
  };
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
  const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  let refreshing = false;
  let regionRead;
  function bindOverviewRead() {
    const region = A.$('#main .website-overview');
    if (!region || regionRead?.region === region) return;
    regionRead?.finish();
    regionRead = A.beginRegionRead(region, region.querySelector('[data-overview-progress]'), {
      refreshButton: region.querySelector('[data-action="overview-refresh"]')
    });
  }
  function recentDates() {
    const today = Date.parse(dayFormatter.format(new Date()) + 'T00:00:00Z');
    return Array.from({ length: 30 }, (_, index) =>
      new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10));
  }
  async function refreshOverview() {
    if (!business || refreshing) return;
    refreshing = true;
    bindOverviewRead();
    const admin = allowed('orders/statistics');
    const { commerce, inventory, appleBalance } = A.modules;
    const dates = recentDates();
    const appleLoad = admin && allowed('accounts/apple-balances')
      ? appleBalance.refreshLocalBalance() : Promise.resolve(false);
    const jobs = [['inventory', async () => await inventory.refreshOverview() && inventory.overviewSummary()]];
    if (admin) jobs.push(
      ['apple', async () => await appleLoad && appleBalance.listRefunds().filter(row => row.status === 'pending').length],
      ['commerce', async () => {
        const [ok] = await Promise.all([commerce.refreshOverview(), appleLoad]);
        return ok && commerce.overviewSummary(dates);
      }]
    );
    const loaded = await Promise.all(jobs.map(async ([key, load]) => {
      try {
        const data = await load();
        if (data === false || data == null) return [key, { phase: 'error' }];
        return [key, { data, updated: new Date(), phase: 'ready' }];
      } catch {
        return [key, { phase: 'error' }];
      }
    }));
    for (const [key, result] of loaded) Object.assign(sections[key], result);
    regionRead?.finish();
    regionRead = undefined;
    refreshing = false;
    if (A.state.route === 'overview') A.render();
  }
  function sectionStatus(section) {
    if (!business) return '设计预览';
    if (section.phase === 'error') return section.updated
      ? `读取失败 · 保留 ${timeFormatter.format(section.updated)} 的数据` : '读取失败 · 可重试';
    if (!section.updated) return '等待数据';
    return `更新于 ${timeFormatter.format(section.updated)}`;
  }
  const formatAmount = value => String(value).replace(/(\.\d{2})0+$/, '$1');
  function originalTotals(days, field) {
    const result = new Map();
    for (const day of days) {
      for (const [currency, value] of Object.entries(day[field]))
        result.set(currency, A.money.add(result.get(currency) || '0', value));
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, value]) => `${formatAmount(value)} ${currency}`);
  }
  function renderTrend(days) {
    if (!days?.length) return `<div class="overview-chart-empty"><div><strong>${E(allowed('orders/statistics') ? sectionStatus(sections.commerce) : '当前权限仅提供订单明细')}</strong></div></div>`;
    const max = Math.max(...days.map(day => day.orders + day.cancelled));
    if (!max) return '<div class="overview-chart-empty"><div><strong>该时间范围没有订单记录</strong></div></div>';
    const slot = 600 / days.length;
    const barWidth = Math.min(54, slot * 0.7);
    const bars = days.map((day, index) => {
      const x = index * slot + (slot - barWidth) / 2;
      const height = day.orders / max * 180;
      const cancelled = day.cancelled / max * 180;
      return `<g><title>${day.date} · 订单 ${day.orders} 笔 · 撤单 ${day.cancelled} 笔</title><rect class="overview-bar" x="${x}" y="${200 - height}" width="${barWidth}" height="${height}"/><rect class="overview-bar-cancelled" x="${x}" y="${200 - height - cancelled}" width="${barWidth}" height="${cancelled}"/></g>`;
    }).join('');
    return `<div class="overview-chart-empty overview-chart-data"><svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="每日订单和撤单数量">${bars}</svg></div><details class="overview-daily"><summary>查看每日数量</summary><ul>${days.map(day => `<li>${day.date}　订单 ${day.orders} 笔　撤单 ${day.cancelled} 笔</li>`).join('')}</ul></details>`;
  }
  const metrics = [
    ['orders', '订单数量', '笔', '按创建时间统计，撤单单独列示；续费作为新订单计入。', 'orders/gpt', '查看订单'],
    ['receipts', '订单实收', '按原币', '只汇总已确认的订单实收，按原币分别展示；退款另列，不将不同币种直接相加。', 'orders/statistics', '查看实收'],
    ['profit', '已核算利润', '人民币', '沿用订单冻结的汇率快照与费用规则。缺少或失效快照的订单列入待核算，不按零利润处理；退款与苹果待回款分别展示。', 'orders/statistics', '查看核算'],
    ['customers', '新增客户', '位', '按客户创建时间统计去重客户，不把新建订单重复计为新增客户。', 'customers/list', '查看客户']
  ];
  const tasks = [
    ['续费待处理', '沿用续费管理的提醒范围', 'workspace/renewals', 'orders'],
    ['订单待补资料', '待补客户、支付或订阅资料', 'orders/gpt', 'info'],
    ['已领用待处理', '核对使用结果或归还库存', 'workspace/extractions', 'return'],
    ['苹果待回款', '已登记退款，尚待确认到账', 'accounts/apple-balances', 'card']
  ];
  const inventories = [
    ['谷歌邮箱', 'mailboxes/google', '登记库存', 'google'],
    ['苹果隐藏邮箱', 'mailboxes/relay', '提取资格需核验', 'relay'],
    ['GPT 账号', 'accounts/gpt', '成品库存', 'gpt'],
    ['Claude 账号', 'accounts/claude', '含养号条件', 'claude']
  ];
  const future = [
    { id: 'microsoft', title: '微软邮箱', icon: 'mail', scope: '邮箱库存', route: 'mailboxes/microsoft', status: '业务占位', text: '规划库存、提取、使用和归还概况；与在线工具中的邮箱查询分开。', fields: ['库存登记数量', '已领用与待归还', '账号状态与异常'] },
    { id: 'gemini', title: 'Gemini 业务', icon: 'key', scope: '账号与订单', route: 'accounts/gemini', status: '业务占位', text: '账号库存和订单能力完善后，再接入经营指标。', fields: ['可用账号与异常', '订单与续费', '实收与已核算利润'] },
    { id: 'grok', title: 'Grok 业务', icon: 'key', scope: '账号与订单', route: 'accounts/grok', status: '业务占位', text: '保留账号和订单概况的位置，不提前展示业务数量。', fields: ['账号库存', '订单与订阅状态', '客户与续费'] },
    { id: 'claude', title: 'Claude 代充', icon: 'bolt', scope: '线上代充', route: 'online-recharge/claude', status: '业务占位', text: '待执行链路完善后展示任务进展，不影响已有 Claude 订单业务。', fields: ['排队与执行中', '成功与失败', '任务与订单对账'] },
    { id: 'sheets', title: 'Google 表格同步', icon: 'database', scope: '同步任务', route: 'data', status: '业务占位', text: '按新版需要同步的表格和字段完善，不沿用旧版同步内容。', fields: ['同步表格与范围', '最近成功时间', '失败任务与待同步记录'] },
    { id: 'data', title: '数据中心', icon: 'database', scope: '数据质量', route: 'data', status: '业务占位', text: '规划资料完整度、重复记录与跨模块对账，不复制业务列表。', fields: ['资料缺失与重复', '订单与库存对账', '核对进展'] },
    { id: 'monitor', title: '监控中心', icon: 'monitor', scope: '服务运行', route: 'monitor', status: '业务占位', text: '规划采集已确认的服务状态和异常，不以页面能打开代表服务健康。', fields: ['服务可用性', '执行器连接状态', '最近异常与恢复时间'] },
    { id: 'traffic', title: '网站访问', icon: 'monitor', scope: 'GA4 与访问采集', route: 'monitor', status: '待接入总览', text: '复用已授权的数据源接入总览；目前不推断线上是否已配置。', fields: ['访客与访问量', '流量来源', '最近采集时间与状态'] },
    { id: 'recharge', title: 'ChatGPT 代充概况', icon: 'bolt', scope: '任务进展', route: 'online-recharge/chatgpt', status: '待接入总览', text: '现有代充页面保留，后续以执行器确认的任务结果接入总览。', fields: ['等待与执行中', '成功与失败', '任务更新时间'] }
  ];
  const allowed = route => A.canVisit(route);
  const link = (label, route, className = '') => allowed(route)
    ? `<a class="${className}" href="#/${E(route)}">${E(label)}${A.icon('chevron')}</a>` : '';
  function heading(id, title, note, action = '') {
    return `<div class="overview-heading"><div class="section-title-row"><h2 id="overview-${id}">${E(title)}</h2>${A.titleInfo(title, note, `overview-${id}-note`)}</div>${action}</div>`;
  }
  function render() {
    const range = A.state.drafts.get(draftKey)?.range || 'week';
    const rangeLabel = ranges.find(([id]) => id === range)?.[1] || '近 7 天';
    const finance = allowed('orders/statistics');
    const commerce = finance ? sections.commerce.data : null;
    const inventory = sections.inventory.data;
    const days = commerce?.daily.slice(-({ today: 1, week: 7, month: 30 }[range] || 7));
    const count = field => days?.reduce((total, day) => total + day[field], 0) ?? '—';
    const receipts = days ? originalTotals(days, 'receipts') : [];
    const refunds = days ? originalTotals(days, 'refunds') : [];
    const accounted = count('accounted');
    const profit = !days || (!accounted && count('pending')) ? '—'
      : formatAmount(days.reduce((total, day) => A.money.add(total, day.profit), '0'));
    const values = {
      orders: count('orders'), customers: count('customers'), profit,
      receipts: days ? receipts.join(' / ') || '0' : '—'
    };
    const footers = {
      orders: days ? `${rangeLabel} · 撤单 ${count('cancelled')} 笔` : rangeLabel,
      customers: rangeLabel,
      profit: days ? `待核算 ${count('pending')} 笔` : rangeLabel,
      receipts: refunds.length ? `退款 ${refunds.join(' / ')}` : rangeLabel
    };
    const taskCounts = [commerce?.renewals, commerce?.incomplete, inventory?.pending, finance ? sections.apple.data : undefined];
    const overviewStatus = business
      ? Object.entries(sections).filter(([key]) => key === 'inventory' || finance)
        .map(([, section]) => `${section.label} ${sectionStatus(section)}`).join(' ｜ ')
      : '设计预览 · 业务数据未连接';
    const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
    return A.header('网站总览', '集中查看经营概况、待办、库存和客户状态。统计统一使用北京时间。读取失败时保留上次数据，未取得数据时显示破折号。') +
      `<div class="website-overview design-async-region"><div data-overview-progress role="status" hidden></div>
        <div class="overview-toolbar"><div class="overview-date"><div class="overview-date-heading"><strong>${E(date)}</strong><span>北京时间</span></div><div class="overview-design-label" role="status">${E(overviewStatus)}</div></div><div class="toolbar-right"><div class="overview-range" role="group" aria-label="统计时间范围">${ranges.map(([id, label]) => `<button class="button ${range === id ? 'primary' : ''}" data-action="overview-range" data-range="${id}" aria-pressed="${range === id}">${label}</button>`).join('')}</div>${business ? A.button('刷新数据', 'overview-refresh') : ''}${A.button('指标口径', 'overview-methodology', '', 'info')}</div></div>
        ${finance ? `<section class="overview-metrics" aria-label="经营概况">${metrics.filter(item => finance && allowed(item[4])).map(([id, label, unit, note, route, action]) => `<article class="panel overview-metric"><div class="overview-metric-label"><h2>${label}</h2>${A.titleInfo(label, note, `overview-metric-${id}`)}</div><div class="overview-metric-value"><strong class="${id === 'receipts' ? 'overview-original-amount' : ''}">${E(values[id])}</strong><span>${unit}</span></div><div class="overview-metric-footer"><span>${E(footers[id])}</span>${link(action, route)}</div></article>`).join('')}</section>` : ''}
        <nav class="panel overview-shortcuts" aria-label="常用入口"><strong>常用入口</strong><div>${[['GPT 提交订单', 'workspace/order/gpt', 'plus'], ['Claude 提交订单', 'workspace/order/claude', 'plus'], ['客户录入', 'customers/new', 'user'], ['邮箱提取', 'workspace/mail-extract', 'mail'], ['账号提取', 'workspace/account-extract', 'key'], ['比特登录', 'recharge/start', 'work'], ['ChatGPT 代充', 'online-recharge/chatgpt', 'bolt']].filter(item => allowed(item[1])).map(([label, route, icon]) => `<a href="#/${route}">${A.icon(icon)}<span>${label}</span></a>`).join('') || link('GPT 订单', 'orders/gpt')}</div></nav>
        <div class="overview-columns">
          <section class="panel overview-section" aria-labelledby="overview-trend">${heading('trend', '订单趋势', '按北京时间自然日汇总订单数量；续费计入新订单，撤单单独列示。实收与利润查看右侧入口，不混用币种或与订单数量共用坐标。', link(finance ? '数据统计' : 'GPT 订单', finance ? 'orders/statistics' : 'orders/gpt'))}<div class="overview-chart-header"><span>${rangeLabel} · 订单数量</span><span class="overview-legend"><i></i>订单 <i class="overview-cancelled-marker"></i>撤单</span></div>${renderTrend(days)}<div class="overview-chart-footer"><span>${days?.[0]?.date || '统计区间起始日'}</span><span>${days?.at(-1)?.date || '北京时间'}</span></div></section>
          <section class="panel overview-section" aria-labelledby="overview-tasks">${heading('tasks', '待办关注', '展示当前状态，不受上方订单统计时间范围影响。仅进入现有业务页处理，不在总览直接执行充值、退款或归还。')}<div class="overview-task-list">${tasks.map(([title, note, route, icon], index) => finance && allowed(route) ? `<a class="overview-task" href="#/${route}"><span class="overview-task-icon">${A.icon(icon)}</span><span><strong>${title}</strong><small>${note}</small></span><span class="overview-task-count">${taskCounts[index] ?? '—'}</span>${A.icon('chevron')}</a>` : '').join('')}</div><p class="overview-section-footnote">${finance ? '待办按当前状态统计' : '当前权限仅提供可访问模块的明细'}</p></section>
        </div>
        <div class="overview-columns">
          <section class="panel overview-section" aria-labelledby="overview-inventory">${heading('inventory', '库存概况', '显示当前状态。可用数量沿用各模块的可提取资格、领用与占用规则；Claude 包含养号要求，隐藏邮箱还需核验远端资格。领用不等于实际使用，已售出不计入可用。')}<div class="overview-stock-table"><table><thead><tr><th scope="col">资料类型</th><th scope="col">可用</th><th scope="col">已领用</th><th scope="col">异常</th></tr></thead><tbody>${inventories.filter(item => allowed(item[1])).map(([name, route, note, type]) => `<tr><th scope="row">${link(name, route)}<small>${note}</small></th><td>${type === 'relay' ? '需核验' : inventory?.stocks[type]?.available ?? '—'}</td><td>${inventory?.stocks[type]?.claimed ?? '—'}</td><td>${inventory?.stocks[type]?.abnormal ?? '—'}</td></tr>`).join('')}</tbody></table></div><p class="overview-section-footnote">${E(sectionStatus(sections.inventory))}</p></section>
          ${allowed('customers/list') ? `<section class="panel overview-section" aria-labelledby="overview-customers">${heading('customers', '客户经营', '按客户去重：名下仍有有效服务的客户不判定为流失。单笔到期或拒续只影响该订单，不代表该客户整体流失。', link('客户数据', 'customers/list'))}<div class="overview-customer-summary">${[['有效服务客户', 'customers/list'], ['续费待跟进', 'workspace/renewals'], ['流失客户', 'workspace/customer-loss']].map(([label, route], index) => `<a href="#/${route}"><span>${label}</span><strong>${[commerce?.active, commerce?.followUp, commerce?.lost][index] ?? '—'}</strong></a>`).join('')}</div><div class="overview-customer-actions">${link('查看续费提醒', 'workspace/renewals')}${link('查看流失客户', 'workspace/customer-loss')}</div><div class="overview-customer-note">${A.icon('users')}<p>从客户的全部订单判断服务状态，避免把单笔到期误算为客户流失。</p></div></section>` : `<section class="panel overview-section" aria-labelledby="overview-orders">${heading('orders', '订单入口', '按当前权限查看各产品的订单明细。')}<div class="overview-order-links">${[['GPT 订单', 'orders/gpt'], ['Claude Pro 订单', 'orders/pro'], ['Claude Max 订单', 'orders/max']].map(([label, route]) => link(label, route)).join('')}</div></section>`}
        </div>
        <section class="panel overview-section overview-future" aria-labelledby="overview-future">${heading('future', '后续接入', '保留未来需要进入总览的模块。业务占位与已具备页面但尚未接入总览的模块分开标记；中转脚本按当前安排不展示。')}<div class="overview-future-grid">${future.filter(item => allowed(item.route)).map(item => `<button class="overview-future-item" data-action="overview-plan" data-id="${item.id}"><span class="overview-future-icon">${A.icon(item.icon)}</span><span class="overview-future-copy"><strong>${item.title}</strong><small>${item.scope}</small></span><span class="tag">${item.status}</span></button>`).join('')}</div></section>
      </div>`;
  }
  function onClick(action, node) {
    if (action === 'overview-refresh') {
      void refreshOverview();
      return true;
    }
    if (action === 'overview-range') {
      if (ranges.some(([id]) => id === node.dataset.range)) {
        A.state.drafts.set(draftKey, { range: node.dataset.range });
        A.render();
        document.querySelector(`[data-action="overview-range"][data-range="${node.dataset.range}"]`)?.focus({ preventScroll: true });
      }
      return true;
    }
    if (action === 'overview-plan') {
      const item = future.find(item => item.id === node.dataset.id && allowed(item.route));
      if (item) A.openDrawer(item.title, item.text,
        `<div class="overview-plan-status">${A.tag(item.status)}</div><section class="form-section"><h3>计划展示</h3><ul class="overview-plan-list">${item.fields.map(field => `<li>${E(field)}</li>`).join('')}</ul></section><div class="side-note">${E(item.text)}</div>`,
        A.button('关闭', 'drawer-close') + (['sheets', 'traffic'].includes(item.id) ? '' : link(item.status === '业务占位' ? '查看占位页面' : '进入现有页面', item.route, 'button primary')));
      return true;
    }
    if (action === 'overview-methodology') {
      const finance = allowed('orders/statistics');
      A.openDrawer('指标口径', '统计时间统一使用北京时间。订单按创建日归集，客户退款按退款登记日期另列。',
        `<div class="guide-list">${metrics.filter(item => finance && allowed(item[4])).map(([, title,, note]) => `<section class="guide-item"><h3>${title}</h3><p>${note}</p></section>`).join('')}<section class="guide-item"><h3>时间范围与当前状态</h3><p>今日、近 7 天、近 30 天用于经营指标和趋势。待办、库存及客户服务状态显示当前情况，不随时间范围切换。</p></section><section class="guide-item"><h3>未接入与空数据</h3><p>尚未取得数据时显示“—”，读取成功且没有记录才显示 0。刷新失败时保留上次成功的数据与时间。</p></section></div>`, A.button('关闭', 'drawer-close'));
      return true;
    }
    return false;
  }
  window.IDDesignModules.push({ id: 'overview', matches: route => route === 'overview', render, onClick,
    afterRender({ routeChanged } = {}) {
      if (refreshing) bindOverviewRead();
      if (routeChanged) queueMicrotask(() => {
        if (A.state.route === 'overview') void refreshOverview();
      });
    } });
})();
