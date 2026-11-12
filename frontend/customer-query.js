(() => {
  'use strict';
  const A = window.IDDesignAPI, S = A.state, data = window.IDLocalData;
  const { esc: E, button, textAction, tag } = A;
  const route = 'workspace/customer-query';
  const tabs = { accounts: '账号与订阅', orders: '订单历史', records: '关联记录' };
  const products = ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok'];
  const page = () => ({ page: 1, pageSize: 20 });
  const status = { active: '有效', expired: '已过期', opened: '已开通', scheduled: '未开始',
    ended: '已终止', pending: '待核对', failed: '开通失败' };
  const appleStates = { normal: '正常', dead: '死号', unlocking: '解封中', unavailable: '不可用', unknown: '待核对' };
  let snapshot, snapshotTab, sequence = 0, expiryTimer;

  function view() {
    if (!S.drafts.has(route)) S.drafts.set(route, { input: '', query: '', customerId: '', tab: 'accounts',
      pages: { search: page(), accounts: page(), orders: page(), records: page() } });
    return S.drafts.get(route);
  }
  const active = () => S.route === route;
  const date = value => {
    const time = window.IDOrderOpening?.subscriptionTime(value);
    return Number.isFinite(time) ? new Date(time + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '待核对';
  };
  const attr = id => `data-id="${E(id)}"`;
  const danger = label => `<span class="customer-query-risk">${A.icon('alert')}${E(label)}</span>`;
  function bankBadge(bank) {
    if (!bank) return '';
    if (bank.private) return bank.state === 'unlocking' ? tag('关联付款资料解封中', 'warning') : danger('关联付款资料异常');
    if (bank.state === 'dead') return danger('死卡');
    if (bank.state === 'unlocking') return tag('解封中', 'warning');
    if (bank.state === 'frozen') return tag('已冻结', 'danger');
    return tag(bank.state === 'normal' ? '正常' : '待核对', bank.state === 'normal' ? 'success' : '');
  }
  function appleBadge(apple) {
    const label = apple.historical ? '原绑定 Apple ID' : apple.bound ? '绑定 Apple ID' : '待付款 Apple ID';
    return `${label}：${E(apple.account || '待核对')} ${
      apple.state === 'dead' ? danger('死号') : tag(appleStates[apple.state] || '待核对',
        apple.state === 'normal' ? 'success' : apple.state === 'unlocking' ? 'warning' : '')}`;
  }
  function duration(row) {
    const dates = window.IDOrderOpening;
    const until = dates?.subscriptionTime(row.expiry), now = Date.now();
    if (!Number.isFinite(until) || !['active', 'expired', 'scheduled'].includes(row.status)) return '待核对';
    return row.status !== 'scheduled' && dates.expiredDuration(until, now) || `剩余 ${Math.ceil((until - now) / 86_400_000)} 天`;
  }
  function assetMarkup(row) {
    const bank = row.bank;
    const apples = row.appleBindings || (row.apple ? [row.apple] : []);
    return [bank && `<div>${!bank.private && bank.last4 ? `尾号 ${E(bank.last4)} · ` : ''}${bankBadge(bank)}</div>`,
      ...apples.map(apple => `<div>${appleBadge(apple)}</div>`)].filter(Boolean).join('') || '—';
  }
  function results(result, state, loading = false) {
    if (!result) return A.empty('查询客户', '输入客户姓名或微信，查看账号、订阅和订单。');
    const pager = id => window.IDPagination.render({ id: 'customer-query-' + id, page: result.page,
      pageSize: result.pageSize, total: result.total });
    if (!result.customer) {
      const columns = [{ id: 'name', label: '客户姓名' }, { id: 'wechat', label: '微信' }, { id: 'id', label: '客户编号' },
        { id: 'status', label: '状态', render: row => row.active ? '使用中' : '已停用' },
        { id: 'actions', label: '操作', action: true, render: row => textAction('查看客户', 'customer-query-select', attr(row.id)) }];
      return A.table(columns, result.items, '', 'customer-query-search', { title: '未找到匹配客户', description: '请检查姓名或微信。' }) + pager('search');
    }
    const c = result.customer;
    const properties = [['微信', c.wechat], ['客户电话', c.phone], ['QQ', c.qq], ['WhatsApp', c.whatsapp], ['Telegram', c.telegram],
      ['来源', c.source], ['标签', c.tags?.join('、')]].filter(([, value]) => value);
    const warnings = (result.warnings || []).map(row => `<li><strong>${E(row.account || '账号待核对')}</strong> ${
      row.kind === 'bank' ? bankBadge(row) : appleBadge({ ...row, account: row.apple })}${row.kind === 'apple' && row.state === 'dead'
      ? row.bound ? '<p>此绑定 ID 已死号。此订阅账号不可继续绑定其他 Apple ID，建议更换订阅账号或改用银行卡订阅。</p>'
        : '<p>待付款 Apple ID 已死号，请核对原订单及付款资料。</p>' : ''}</li>`);
    const profile = `<div class="toolbar"><div class="toolbar-left"><strong>${E(c.name)}</strong><span class="footnote">${E(c.id)}</span>${
      c.active ? '' : tag('已停用', 'warning')}</div><div class="toolbar-right">${button('返回匹配客户', 'customer-query-back')}${
      c.active ? button('仅采用客户资料', 'customer-query-product', 'primary') : ''}</div></div>${properties.length
      ? `<dl class="customer-query-profile">${properties.map(([label, value]) => `<div><dt>${label}</dt><dd>${E(value)}</dd></div>`).join('')}</dl>` : ''}${
      warnings.length ? `<ul class="customer-query-warnings" aria-label="付款资料异常">${warnings.join('')}</ul>` : ''}${
      result.unresolved ? `<p class="inline-notice warning">有 ${result.unresolved} 笔历史订单的客户关联待核对。</p>` : ''}${
      c.notes ? `<details class="customer-query-notes"><summary>备注</summary><p>${E(c.notes)}</p></details>` : ''}`;
    const tabMarkup = `<div class="tabs" role="tablist" aria-label="客户查询内容">${Object.entries(tabs).map(([id, name]) =>
      `<button class="tab" role="tab" type="button" data-action="customer-query-tab" data-tab="${id}" aria-selected="${id === state.tab}">${name}</button>`).join('')}</div>`;
    const shared = [
      { id: 'account', label: '订阅账号', render: row => E(row.account || '待核对') +
        (row.email && row.email !== row.account ? `<div>${E(row.email)}</div>` : '') },
      { id: 'product', label: '产品／套餐', render: row => E([row.product, row.plan].filter(Boolean).join(' · ')) },
      { id: 'start', label: '开通日期', render: row => date(row.start) },
      { id: 'expiry', label: '到期时间', render: row => date(row.expiry) },
      { id: 'duration', label: '剩余／过期时长', render: row => `<span data-customer-duration="${E(row.id)}">${E(duration(row))}</span>` },
      { id: 'status', label: '订阅状态', render: row => row.cancelled ? tag('已撤单') :
        tag(status[row.status] || '待核对', row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : '') },
      { id: 'assets', label: '付款资料', render: assetMarkup },
      { id: 'tenant', label: '租户', render: row => row.tenant ? `${E(row.tenant.name)} ${row.tenant.active ? tag('正常', 'success') : tag('已停用', 'warning')}`
        : row.tenantConflict ? '关联待核对' : Object.hasOwn(row, 'tenant') ? '未关联' : '—' },
    ];
    const submit = row => row.canPrefill ? textAction('采用此单提交订单', 'customer-query-prefill', attr(row.id)) : '';
    const columns = state.tab === 'records' ? [{ id: 'type', label: '记录' }, { id: 'at', label: '时间' }, { id: 'actor', label: '操作人' }]
      : state.tab === 'orders' ? [{ id: 'orderNo', label: '订单编号' }, ...shared, { id: 'businessType', label: '业务类型' },
        { id: 'refunds', label: '退款', render: row => row.refunds?.map(refund =>
          `<div>${E(`${refund.amount} ${refund.currency}`)} · ${date(refund.at)}</div>`).join('') || '—' },
        { id: 'actions', label: '操作', action: true, render: submit }]
      : [...shared, { id: 'actions', label: '操作', action: true, render: row => `<div class="action-links">${
        row.copyClaude ? textAction('复制 Claude 资料', 'customer-query-copy', attr(row.id)) : ''}${submit(row)}</div>` }];
    return profile + tabMarkup + (loading ? '<div class="panel-body" role="status">正在读取…</div>'
      : A.table(columns, result.items, '', `customer-query-${state.tab}`,
        { title: `暂无${tabs[state.tab]}`, description: '没有已核实关联到此客户的记录。' }) + pager(state.tab));
  }

  function render() {
    const state = view();
    return A.header('客户查询', '按姓名或微信查找客户，核对订阅及付款资料，也可带入新订单。') +
      `<section class="panel"><form id="customer-query-search" class="toolbar"><div class="toolbar-left"><div class="search-field">${A.icon('search')}
      <input id="customer-query-input" type="search" aria-label="客户姓名或微信" maxlength="160" placeholder="输入客户姓名或微信" value="${E(state.input)}"></div>
      <button class="button primary" type="submit">查询</button></div></form><div data-customer-query-region><div data-customer-query-progress role="status" hidden></div>
      <p data-customer-query-error class="inline-notice warning" role="status" hidden></p><div data-customer-query-content>${results(snapshot, state, snapshot?.customer && snapshotTab !== state.tab)}</div></div></section>`;
  }

  function renderResult(region, result, state) {
    region.querySelector('[data-customer-query-content]').innerHTML = results(result, state);
    scheduleDuration(region, result);
  }
  function scheduleDuration(region, result) {
    window.clearTimeout(expiryTimer);
    const now = Date.now(), records = new Map((result?.items || []).map(row => [row.id, row]));
    const dates = window.IDOrderOpening;
    const deadlines = [...records.values()].flatMap(row => {
      if (!['active', 'expired', 'scheduled'].includes(row.status) || row.cancelled || row.ended) return [];
      const end = dates?.subscriptionTime(row.expiry);
      if (!Number.isFinite(end)) return [];
      return [end > now ? end - (Math.ceil((end - now) / 86_400_000) - 1) * 86_400_000 : end +
        (Math.floor((now - end) / 3_600_000) + 1) * 3_600_000,
      row.status === 'scheduled' ? dates?.subscriptionTime(row.start) : 0];
    }).filter(at => at > now);
    if (deadlines.length) expiryTimer = window.setTimeout(() => {
      if (!active() || !region.isConnected || snapshot !== result) return;
      const at = Date.now();
      if ([...records.values()].some(row => row.status === 'active' && dates.subscriptionTime(row.expiry) <= at ||
          row.status === 'scheduled' && dates.subscriptionTime(row.start) <= at)) { void read(true); return; }
      for (const item of region.querySelectorAll('[data-customer-duration]')) {
        const row = records.get(item.dataset.customerDuration);
        if (row) item.textContent = duration(row);
      }
      scheduleDuration(region, result);
    }, Math.min(2_147_000_000, Math.min(...deadlines) - now + 25));
  }

  async function read(refresh = false) {
    const state = view(), region = document.querySelector('[data-customer-query-region]');
    if (!active() || !region || !state.query) return true;
    const token = ++sequence;
    const tab = state.customerId ? state.tab : 'search';
    const command = state.customerId ? { customerId: state.customerId, tab, ...state.pages[tab] }
      : { query: state.query, ...state.pages.search };
    const action = state.customerId ? 'detail' : 'search';
    const current = () => active() && region.isConnected && token === sequence;
    const progress = A.beginRegionRead(region, region.querySelector('[data-customer-query-progress]'), { loadingText: '正在查询客户资料…' });
    const errorBox = region.querySelector('[data-customer-query-error]');
    errorBox.hidden = true;
    try {
      if (!data?.customerQuery) throw new Error('客户查询服务尚未连接');
      const load = () => data.customerQuery(action, command);
      const result = await (data.queries?.read('customer-query', JSON.stringify([action, command]), load, { refresh }) || load());
      if (!current()) return true;
      if (!Array.isArray(result?.items) || (action === 'detail' && result.customer?.id !== command.customerId))
        throw new Error('客户资料与本次查询不符');
      state.pages[tab] = { page: result.page, pageSize: result.pageSize };
      snapshot = result;
      snapshotTab = tab;
      renderResult(region, snapshot, state);
      return true;
    } catch (error) {
      if (!current() || error?.code === 'READ_SUPERSEDED') return true;
      if ([401, 403].includes(error.status)) { snapshot = undefined; renderResult(region, null, state); }
      errorBox.textContent = error.message || '客户资料读取失败，请重试';
      errorBox.insertAdjacentHTML('beforeend', button('重试', 'customer-query-retry'));
      errorBox.hidden = false;
      return false;
    } finally { progress.finish(); }
  }

  function changeSelection() {
    snapshot = undefined;
    window.clearTimeout(expiryTimer);
    A.render();
  }
  function prefill(node, command) {
    const customerId = view().customerId;
    const current = () => active() && view().customerId === customerId && node.isConnected;
    return A.withActionFeedback(node, async () => {
      const result = await data.customerQuery('prefill', { customerId, ...command });
      if (!current()) return;
      A.modules.commerce.openCustomerOrder(result, command.orderId || '');
    }, { pending: '正在核对录单资料…', failure: '录单资料读取失败' });
  }

  window.IDDesignModules.push({
    id: 'customer-query', matches: value => value === route, render,
    afterRender({ routeChanged } = {}) {
      if (!view().query) return;
      const region = document.querySelector('[data-customer-query-region]');
      if (routeChanged || !snapshot || (view().customerId && snapshotTab !== view().tab)) void read(routeChanged);
      else if (region) scheduleDuration(region, snapshot);
    },
    deactivate(region) {
      sequence++;
      if (region?.dataset.pageRegion !== S.route) snapshot = undefined;
      window.clearTimeout(expiryTimer);
    },
    clearPageState() { sequence++; snapshot = undefined; window.clearTimeout(expiryTimer); },
    onDataChanges(scopes) {
      if (active() && scopes.some(scope => ['commerce', 'inventory', 'card-types', 'subscription-management'].includes(scope))) return read(true);
    },
    onInput(node) {
      if (node.id !== 'customer-query-input') return false;
      view().input = node.value;
      return true;
    },
    onSubmit(form) {
      if (form.id === 'customer-query-search') {
        const state = view(), query = state.input.trim();
        state.query = query;
        state.customerId = '';
        state.pages.search = page();
        changeSelection();
        return true;
      }
      if (form.id !== 'customer-query-product-form') return false;
      const node = document.querySelector('[form="customer-query-product-form"]');
      if (node) void prefill(node, { product: form.elements.product.value });
      return true;
    },
    onClick(action, node) {
      if (!active() || !action.startsWith('customer-query-')) return false;
      const state = view();
      if (action === 'customer-query-retry') void read(true);
      else if (action === 'customer-query-select' || action === 'customer-query-back') {
        state.customerId = node.dataset.id || '';
        state.tab = 'accounts';
        for (const id of Object.keys(tabs)) state.pages[id] = page();
        changeSelection();
      } else if (action === 'customer-query-tab' && state.tab !== node.dataset.tab) {
        state.tab = node.dataset.tab;
        const region = document.querySelector('[data-customer-query-region]');
        const rows = region?.querySelector('[data-customer-query-content]');
        window.clearTimeout(expiryTimer);
        if (rows) rows.innerHTML = results(snapshot, state, true);
        void read();
      } else if (action === 'customer-query-prefill') void prefill(node, { orderId: node.dataset.id });
      else if (action === 'customer-query-product') {
        A.openDrawer('仅采用客户资料', '选择产品后进入录单页面。',
          `<form id="customer-query-product-form" novalidate>${A.field('产品', 'customer-query-product',
            `<select id="customer-query-product" name="product">${A.options(products, 'GPT')}</select>`, true)}</form>`,
          button('取消', 'drawer-close') + '<button class="button primary" type="submit" form="customer-query-product-form">进入订单提交</button>', 'customer-query:product');
      } else if (action === 'customer-query-copy') {
        const customerId = state.customerId;
        const current = () => active() && view().customerId === customerId && node.isConnected;
        void A.withActionFeedback(node, async () => {
          const result = await data.customerQuery('copy-claude', { customerId, orderId: node.dataset.id });
          if (current()) await A.copyText(result.text, '已复制 Claude 账号和租户', { current });
        }, { failure: '复制失败，请重试' });
      }
      return true;
    }
  });
  document.addEventListener('id-pagination-change', ({ detail }) => {
    if (!active()) return;
    const state = view(), id = state.customerId ? state.tab : 'search';
    if (detail.id !== `customer-query-${id}`) return;
    state.pages[id] = { page: detail.page, pageSize: detail.pageSize };
    void read();
  });
})();
