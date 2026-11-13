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
  let snapshot, searchSnapshot, sequence = 0, expiryTimer, readFailed = false;
  const sections = new Map();

  function view() {
    if (!S.drafts.has(route)) S.drafts.set(route, { input: '', query: '', customerId: '',
      expanded: { accounts: true, orders: false, records: false },
      pages: { search: page(), accounts: page(), orders: page(), records: page() } });
    const state = S.drafts.get(route);
    state.expanded ||= { accounts: true, orders: false, records: false };
    return state;
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
  function pager(id, result) {
    return window.IDPagination.render({ id: 'customer-query-' + id, page: result.page,
      pageSize: result.pageSize, total: result.total });
  }
  function facts(items, className = 'customer-query-facts') {
    return `<dl class="${className}">${items.map(([label, value]) =>
      `<div><dt>${E(label)}</dt><dd>${value || '—'}</dd></div>`).join('')}</dl>`;
  }
  function subscriptionCard(row, order = false) {
    const tenant = row.tenant ? `${E(row.tenant.name)} ${tag(row.tenant.active ? '正常' : '已停用', row.tenant.active ? 'success' : 'warning')}`
      : row.tenantConflict ? '关联待核对' : Object.hasOwn(row, 'tenant') ? '未关联' : '—';
    const actions = `${!order && row.copyClaude ? textAction('复制 Claude 资料', 'customer-query-copy', attr(row.id)) : ''}${
      row.canPrefill ? button('采用此单提交订单', 'customer-query-prefill', '', '', attr(row.id)) : ''}`;
    return `<article class="customer-query-account" data-customer-query-row="${E(row.id)}">
      <div class="customer-query-account-heading"><h3>${E([row.product, row.plan].filter(Boolean).join(' · ') || '套餐待核对')}</h3>${
        row.cancelled ? tag('已撤单') : tag(status[row.status] || '待核对', row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : '')}
        <span class="footnote" data-customer-duration="${E(row.id)}">${E(duration(row))}</span></div>
      <p class="customer-query-account-name">${E(row.account || '账号待核对')}${row.email && row.email !== row.account ? `<br>${E(row.email)}` : ''}</p>
      ${facts([['开通日期', date(row.start)], ['到期时间', date(row.expiry)],
        ['付款资料', assetMarkup(row)], ...(Object.hasOwn(row, 'tenant') ? [['租户', tenant]] : []),
        ...(order ? [['订单编号', E(row.orderNo || '待核对')], ['业务类型', E(row.businessType || '待核对')],
          ['退款', row.refunds?.map(refund => `<div>${E(`${refund.amount} ${refund.currency}`)} · ${date(refund.at)}</div>`).join('') || '—']] : [])])}
      ${actions ? `<div class="customer-query-account-actions">${actions}</div>` : ''}</article>`;
  }
  function section(id, state) {
    const result = sections.get(id), open = state.expanded[id], heading = tabs[id];
    const content = !result ? `<div class="panel-body" role="status">${readFailed ? '此部分尚未读取成功，请重试。' : '正在读取…'}</div>`
      : !result.items.length ? A.empty(`暂无${heading}`, '没有已核实关联到此客户的记录。')
      : id === 'records' ? `<ol class="customer-query-records">${result.items.map(row =>
        `<li><strong>${E(row.type || '关联记录')}</strong><time>${E(row.at || '时间待核对')}</time><span>${E(row.actor || '操作人未记录')}</span></li>`).join('')}</ol>`
      : `<div class="customer-query-accounts">${result.items.map(row => subscriptionCard(row, id === 'orders')).join('')}</div>`;
    return `<section class="panel customer-query-section" aria-labelledby="customer-query-${id}-title">
      <div class="customer-query-section-heading"><h2 id="customer-query-${id}-title">${heading}</h2>${
        result ? `<span class="footnote">${result.total} 条</span>` : ''}${id !== 'accounts'
        ? button(open ? '收起' : '展开', 'customer-query-section', '', '', `data-tab="${id}" aria-label="${open ? '收起' : '展开'}${heading}" aria-expanded="${open}" aria-controls="customer-query-${id}-content"`) : ''}</div>
      <div id="customer-query-${id}-content" ${open ? '' : 'hidden'}>${open ? content + (result?.total ? pager(id, result) : '') : ''}</div></section>`;
  }
  function results(result, state) {
    if (!result) return `<section class="panel">${A.empty(readFailed ? '暂时无法读取资料' : state.query ? '正在查询客户资料' : '查询一位客户，查看完整档案',
      readFailed ? '请重试本次查询。' : state.query ? '正在核对客户与账号关联。' : '输入客户姓名或微信，也可一键粘贴查询。')}</section>`;
    if (!result.customer) {
      if (!result.items.length) return `<section class="panel">${A.empty('未找到匹配客户', '请核对客户姓名或微信后重新查询。')}</section>`;
      return `<section class="panel"><div class="customer-query-section-heading"><h2>选择本次查询的客户</h2><span class="footnote">${result.total} 位匹配客户</span></div>
        <div class="customer-query-candidates">${result.items.map(row => `<article class="customer-query-candidate" data-customer-query-candidate="${E(row.id)}">
          <div class="customer-query-account-heading"><h3>${E(row.name)}</h3>${tag(row.active ? '使用中' : '已停用', row.active ? 'success' : 'warning')}</div>
          ${facts([['微信', E(row.wechat || '未登记')], ['客户编号', E(row.id)]])}
          ${button('查看客户', 'customer-query-select', '', '', attr(row.id))}</article>`).join('')}</div>${pager('search', result)}</section>`;
    }
    const c = result.customer;
    const properties = [['微信', c.wechat], ['客户电话', c.phone], ['QQ', c.qq], ['WhatsApp', c.whatsapp], ['Telegram', c.telegram],
      ['来源', c.source], ['标签', c.tags?.join('、')]].filter(([, value]) => value);
    const warnings = (result.warnings || []).map(row => `<li><strong>${E(row.account || '账号待核对')}</strong> ${
      row.kind === 'bank' ? bankBadge(row) : appleBadge({ ...row, account: row.apple })}${row.kind === 'apple' && row.state === 'dead'
      ? row.bound ? '<p>此绑定 ID 已死号。此订阅账号不可继续绑定其他 Apple ID，建议更换订阅账号或改用银行卡订阅。</p>'
        : '<p>待付款 Apple ID 已死号，请核对原订单及付款资料。</p>' : ''}</li>`);
    const profile = `<section class="panel customer-query-profile-panel"><div class="toolbar"><div class="toolbar-left"><h2>${E(c.name)}</h2>${
      tag(c.active ? '使用中' : '已停用', c.active ? 'success' : 'warning')}</div><div class="toolbar-right">${searchSnapshot?.total > 1 ? button('返回匹配客户', 'customer-query-back') : ''}${
      c.active ? button('仅采用客户资料', 'customer-query-product', 'primary') : ''}</div></div>${
      facts([['客户编号', E(c.id)], ...properties.map(([label, value]) => [label, E(value)])], 'customer-query-facts customer-query-profile')}${
      warnings.length ? `<ul class="customer-query-warnings" aria-label="付款资料异常">${warnings.join('')}</ul>` : ''}${
      result.unresolved ? `<p class="inline-notice warning">有 ${result.unresolved} 笔历史订单的客户关联待核对。</p>` : ''}${
      c.notes ? `<div class="customer-query-notes"><strong>备注</strong><p>${E(c.notes)}</p></div>` : ''}</section>`;
    return profile + Object.keys(tabs).map(id => section(id, state)).join('');
  }

  function render() {
    const state = view();
    return A.header('客户查询', '按姓名或微信查找客户，核对订阅及付款资料，也可带入新订单。') +
      `<div class="customer-query-page"><section class="panel"><form id="customer-query-search" class="customer-query-search">
      <div class="customer-query-search-label"><label for="customer-query-input">客户资料</label>${A.titleInfo('客户资料查询', '按客户姓名或微信查询。唯一匹配直接显示档案；多位匹配时先选择客户。', 'customer-query-help')}</div>
      <div class="customer-query-search-row"><div class="search-field">${A.icon('search')}
      <input id="customer-query-input" type="search" aria-label="客户姓名或微信" aria-describedby="customer-query-input-notice" maxlength="160" placeholder="输入客户姓名或微信" value="${E(state.input)}"></div>
      <button class="button primary" type="submit">查询</button>${button('粘贴查询', 'customer-query-paste', '', 'copy')}${
        state.query || state.input ? button('重新查询', 'customer-query-reset') : ''}</div>
      <p id="customer-query-input-notice" class="field-error" role="status" hidden></p></form></section>
      <div data-customer-query-region><div data-customer-query-progress role="status" hidden></div>
      <p data-customer-query-error class="inline-notice warning" role="status" hidden></p>
      <div data-customer-query-content>${results(state.customerId ? snapshot : searchSnapshot, state)}</div></div></div>`;
  }

  function renderResult(region, result, state) {
    region.querySelector('[data-customer-query-content]').innerHTML = results(result, state);
    scheduleDuration(region);
  }
  function scheduleDuration(region) {
    window.clearTimeout(expiryTimer);
    const token = sequence, now = Date.now(), state = view(), records = new Map();
    for (const id of Object.keys(tabs)) {
      const section = sections.get(id);
      if (!state.expanded[id] || section?.customer?.id !== state.customerId) continue;
      for (const row of section.items) {
        if (!records.has(row.id) && !row.cancelled && !row.ended) records.set(row.id, row);
      }
    }
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
      if (!active() || !region.isConnected || token !== sequence) return;
      const at = Date.now();
      if ([...records.values()].some(row => row.status === 'active' && dates.subscriptionTime(row.expiry) <= at ||
          row.status === 'scheduled' && dates.subscriptionTime(row.start) <= at)) { void read(true); return; }
      for (const item of region.querySelectorAll('[data-customer-duration]')) {
        const row = records.get(item.dataset.customerDuration);
        if (row) item.textContent = duration(row);
      }
      scheduleDuration(region);
    }, Math.min(2_147_000_000, Math.min(...deadlines) - now + 25));
  }

  async function read(refresh = false, refreshTab = '', measure = false) {
    const state = view(), region = document.querySelector('[data-customer-query-region]');
    if (!active() || !region || !state.query) return true;
    const token = ++sequence;
    const current = () => active() && region.isConnected && token === sequence;
    const progress = A.beginRegionRead(region, region.querySelector('[data-customer-query-progress]'), { loadingText: '正在查询客户资料…' });
    const errorBox = region.querySelector('[data-customer-query-error]');
    errorBox.hidden = true;
    readFailed = false;
    const timing = measure ? window.IDSiteTiming?.start('customer-search') : undefined;
    try {
      if (!data?.customerQuery) throw new Error('客户查询服务尚未连接');
      const load = async (action, command) => {
        const fetch = () => data.customerQuery(action, command, { timing: action === 'search' || command.tab === 'accounts' ? timing : undefined });
        const result = await (data.queries?.read('customer-query', JSON.stringify([action, command]), fetch,
          { refresh: refresh || command.tab === refreshTab }) || fetch());
        if (!Array.isArray(result?.items) || (action === 'detail' && result.customer?.id !== command.customerId))
          throw new Error('客户资料与本次查询不符');
        return result;
      };
      if (!state.customerId) {
        const result = await load('search', { query: state.query, ...state.pages.search });
        if (!current()) return true;
        searchSnapshot = result;
        state.pages.search = { page: result.page, pageSize: result.pageSize };
        if (result.total !== 1 || result.items.length !== 1) {
          renderResult(region, result, state);
          timing?.finish();
          return true;
        }
        state.customerId = result.items[0].id;
      }
      const customerId = state.customerId;
      const requested = Object.keys(tabs).filter(id => state.expanded[id]);
      const replies = await Promise.all(requested.map(async tab => [tab,
        await load('detail', { customerId, tab, ...state.pages[tab] })]));
      if (!current() || state.customerId !== customerId) return true;
      for (const [tab, result] of replies) {
        state.pages[tab] = { page: result.page, pageSize: result.pageSize };
        sections.set(tab, result);
      }
      snapshot = sections.get('accounts');
      renderResult(region, snapshot, state);
      timing?.finish();
      return true;
    } catch (error) {
      if (!current() || error?.code === 'READ_SUPERSEDED') return true;
      readFailed = true;
      if ([401, 403].includes(error.status)) { snapshot = searchSnapshot = undefined; sections.clear(); }
      renderResult(region, state.customerId ? snapshot : searchSnapshot, state);
      errorBox.textContent = error.message || '客户资料读取失败，请重试';
      errorBox.insertAdjacentHTML('beforeend', button('重试', 'customer-query-retry'));
      errorBox.hidden = false;
      window.IDSiteTiming?.show(errorBox, timing?.finish(error));
      return false;
    } finally { progress.finish(); }
  }

  let measureNextSearch = false;
  function changeSelection() {
    sequence++;
    snapshot = undefined;
    sections.clear();
    readFailed = false;
    window.clearTimeout(expiryTimer);
    A.render();
  }
  function inputNotice(message) {
    const notice = document.getElementById('customer-query-input-notice');
    if (notice) { notice.textContent = message; notice.hidden = !message; }
  }
  function submitQuery(value) {
    const state = view(), query = value.trim();
    if (!query || query.length > 160) {
      inputNotice(query ? '客户姓名或微信最多 160 字。' : '请输入客户姓名或微信。');
      document.getElementById('customer-query-input')?.focus();
      return;
    }
    state.input = query;
    state.query = query;
    state.customerId = '';
    state.expanded = { accounts: true, orders: false, records: false };
    for (const id of Object.keys(state.pages)) state.pages[id] = page();
    searchSnapshot = undefined;
    measureNextSearch = true;
    changeSelection();
  }
  function pasteQuery(node) {
    const token = sequence, input = view().input;
    const current = () => active() && node.isConnected && sequence === token && view().input === input;
    return A.withActionFeedback(node, async () => {
      try {
        if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
        const value = await navigator.clipboard.readText();
        if (!current()) return;
        if (!value.trim()) { inputNotice('剪贴板为空，请复制客户姓名或微信后重试。'); return false; }
        submitQuery(value);
      } catch {
        if (current()) {
          inputNotice('无法读取剪贴板，请手动粘贴到输入框后查询。');
          document.getElementById('customer-query-input')?.focus();
        }
        return false;
      }
    }, { pending: '正在读取剪贴板…' });
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
      const measure = measureNextSearch;
      measureNextSearch = false;
      if (routeChanged || !(view().customerId ? snapshot : searchSnapshot)) void read(routeChanged, '', measure);
      else if (region) scheduleDuration(region);
    },
    deactivate(region) {
      sequence++;
      if (region?.dataset.pageRegion !== S.route) { snapshot = searchSnapshot = undefined; sections.clear(); }
      window.clearTimeout(expiryTimer);
    },
    clearPageState() { measureNextSearch = false; sequence++; snapshot = searchSnapshot = undefined; sections.clear(); window.clearTimeout(expiryTimer); },
    onDataChanges(scopes) {
      if (active() && scopes.some(scope => ['commerce', 'inventory', 'card-types', 'subscription-management'].includes(scope))) {
        for (const id of Object.keys(tabs)) if (!view().expanded[id]) sections.delete(id);
        return read(true);
      }
    },
    onInput(node) {
      if (node.id !== 'customer-query-input') return false;
      view().input = node.value;
      inputNotice('');
      return true;
    },
    onSubmit(form) {
      if (form.id === 'customer-query-search') {
        submitQuery(view().input);
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
      if (action === 'customer-query-retry') void read(true, '', true);
      else if (action === 'customer-query-paste') void pasteQuery(node);
      else if (action === 'customer-query-reset') {
        state.input = state.query = state.customerId = '';
        searchSnapshot = undefined;
        changeSelection();
        document.getElementById('customer-query-input')?.focus();
      }
      else if (action === 'customer-query-select' || action === 'customer-query-back') {
        state.customerId = node.dataset.id || '';
        state.expanded = { accounts: true, orders: false, records: false };
        for (const id of Object.keys(tabs)) state.pages[id] = page();
        changeSelection();
      } else if (action === 'customer-query-section' && ['orders', 'records'].includes(node.dataset.tab)) {
        state.expanded[node.dataset.tab] = !state.expanded[node.dataset.tab];
        if (state.expanded[node.dataset.tab]) sections.delete(node.dataset.tab);
        const region = document.querySelector('[data-customer-query-region]');
        if (region) renderResult(region, snapshot, state);
        if (state.expanded[node.dataset.tab]) void read(false, node.dataset.tab);
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
    const state = view(), id = detail.id?.replace(/^customer-query-/, '');
    if (!Object.hasOwn(state.pages, id) || detail.id !== `customer-query-${id}` ||
        (state.customerId ? !state.expanded[id] : id !== 'search')) return;
    state.pages[id] = { page: detail.page, pageSize: detail.pageSize };
    void read();
  });
})();
