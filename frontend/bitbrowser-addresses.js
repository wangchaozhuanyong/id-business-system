(() => {
  'use strict';
  const localData = window.IDLocalData;
  if (!localData) return;

  const A = window.IDDesignAPI;
  const { $, esc, button, textAction, field, input } = A;
  const endpoint = 'bitbrowser-addresses';
  const statuses = [['unused', '未使用'], ['used', '已使用']];
  const labels = Object.fromEntries(statuses);
  const filters = { page: 1, pageSize: window.IDPagination.defaultPageSize, keyword: '', status: 'unused' };
  const draft = { keyword: '', generationCount: '10' };
  const pendingCopied = new Set();
  const dates = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'short'
  });
  let current = null;
  let totals = null;
  let saving = false;

  const columns = [
    { id: 'line1', label: '街道地址' },
    { id: 'city', label: '城市' },
    { id: 'state', label: '州' },
    { id: 'postalCode', label: '邮编' },
    { id: 'country', label: '国家', render: () => '美国 US' },
    {
      id: 'usedAt',
      label: '使用时间',
      render: (row) => (row.usedAt ? dates.format(new Date(row.usedAt)) : '—')
    },
    { id: 'createdAt', label: '创建时间', render: (row) => dates.format(new Date(row.createdAt)) },
    { id: 'actions', label: '操作', action: true, render: rowActions }
  ];

  function rowActions(row) {
    const label = pendingCopied.has(row.id) && row.status === 'unused' ? '重试标记' : '复制地址';
    return textAction(label, 'bit-address-copy', `data-id="${esc(row.id)}"`);
  }

  function addressPanel() {
    return $('#bit-addresses-panel');
  }

  function mount(host) {
    if (host.querySelector('#bit-addresses-panel')) return;
    const hiddenColumns = A.hiddenTableColumns(endpoint);
    host.innerHTML = `<section class="panel" id="bit-addresses-panel" aria-labelledby="bit-address-heading">
      <header class="panel-heading bit-workspace-heading bit-address-heading">
        <div class="tabs bit-management-tabs" role="tablist" aria-label="右侧管理">
          <button class="tab" type="button" role="tab" id="bit-address-heading" aria-controls="bit-address-content" data-pane="address">地址管理</button>
          <div data-address-help hidden>${A.titleInfo('地址管理', '生成美国账单地址模板。复制成功后自动移入已使用，使用前请核对。', 'bit-address-help')}</div>
          <button class="tab" type="button" role="tab" id="bit-renewals-heading" aria-controls="bit-renewals-content" data-pane="renewals">账号续费管理</button>
        </div>
        <div class="bit-address-heading-tools" data-address-tool>
        <button type="button" class="button primary compact" id="bit-address-generate-open" data-action="bit-address-open-generate" aria-label="生成地址" aria-haspopup="dialog">生成<span class="bit-generate-suffix">地址</span></button></div>
        <div data-renewal-help>${A.titleInfo('账号续费管理', '数量按当前操作员全部登记账号统计。套餐与状态以登记为准，完成手动续费后请更新记录。', 'bit-renewal-help')}</div>
      </header>
      <div class="panel-body bit-address-body" id="bit-address-content" role="tabpanel" aria-labelledby="bit-address-heading">
        <div class="list-controls bit-address-controls">
          <div class="tabs bit-address-tabs" role="tablist" aria-label="地址状态">
            ${statuses.map(([id, label]) => `
              <button id="bit-address-tab-${id}" class="tab" type="button" role="tab"
                aria-controls="bit-address-tabpanel" data-action="bit-address-tab" data-status="${id}">
                ${label}<span class="tab-count">—</span>
              </button>`).join('')}
          </div>
          <form id="bit-address-filters" class="toolbar bit-address-filters" aria-label="地址查询" novalidate>
            <div class="toolbar-left">
              <div class="search-field">${A.icon('search')}${input('bit-address-keyword', draft.keyword, 'aria-label="搜索街道地址" placeholder="搜索街道地址" maxlength="80"')}</div>
              <button class="button" type="submit">查询</button>
            </div>
            <div class="toolbar-right">
              ${button('列设置', 'bit-address-columns', '', 'columns', 'aria-expanded="false" aria-controls="bit-address-columns"')}
              ${button('刷新', 'bit-address-refresh')}
              ${button('一键删除已使用', 'bit-address-delete-used', 'danger', '', 'hidden disabled')}
            </div>
          </form>
        </div>
        <div id="bit-address-tabpanel" role="tabpanel">
          <fieldset id="bit-address-columns" class="bit-address-columns" hidden>
            <legend>显示字段</legend>
            ${columns
              .slice(1, -1)
              .map(
                ({ id, label }) =>
                  `<label class="checkbox-label" data-bit-address-field="${id}"><input type="checkbox" data-bit-address-column="${id}" ${hiddenColumns.has(id) ? '' : 'checked'} /><span>${esc(label)}</span></label>`
              )
              .join('')}
          </fieldset>
          <div id="bit-address-feedback" aria-live="polite" hidden></div>
          <div class="design-async-region">
            <div data-bit-address-read-status role="status" hidden></div>
            <div id="bit-address-list"></div>
          </div>
        </div>
      </div>
      <div id="bit-renewals-content" class="panel-body bit-renewals" role="tabpanel" aria-labelledby="bit-renewals-heading" hidden>
        <div class="bit-renewals-filters">
          <input class="input" type="search" id="bit-renewals-search" data-auto-search aria-label="搜索邮箱、代理或备注" placeholder="搜索邮箱、代理或备注" />
          <select class="select" id="bit-renewals-status" aria-label="续费状态">
            <option value="">全部状态</option><option value="pending_renewal">待续费</option><option value="active">已开通</option><option value="expired">已过期</option>
          </select>
          ${button('刷新', 'bit-renewals-refresh', '', 'refresh')}
        </div>
        <div class="bit-renewal-summary" data-renewal-summary></div>
        <div data-renewals-progress hidden role="status"></div>
        <p class="inline-notice warning" data-renewals-error role="alert" hidden></p>
        <table class="bit-renewal-records" aria-label="账号续费记录">
          <thead><tr><th scope="col">账号邮箱</th><th scope="col">当前套餐</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
          <tbody></tbody>
        </table>
        <div data-renewal-pagination></div>
      </div>
    </section>`;
    $('.bit-address-tabs', host).addEventListener('keydown', onTabKeydown);
    const panes = $('.bit-management-tabs', host);
    panes.addEventListener('click', event => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) selectPane(host, tab.dataset.pane);
    });
    const renewals = $('#bit-renewals-content', host);
    mountRenewals(host, renewals);
    selectPane(host, 'renewals');
    renderTabs();
    renderList();
    void refresh('', { force: false });
  }

  const renewalStatuses = { pending_renewal: '待续费', active: '已开通', expired: '已过期', unknown: '未登记' };
  const renewalPages = new WeakMap();
  const planName = value => value ? String(value).toUpperCase() : '未登记';
  const openDate = value => value && Number.isFinite(Date.parse(value)) ? dates.format(new Date(value)) : '未曾打开';

  function selectPane(host, name) {
    if (!host || !['address', 'renewals'].includes(name)) return;
    const tools = host.querySelector('.bit-management-tabs');
    if (!tools) return;
    const tab = tools.querySelector('[data-pane="' + name + '"]');
    if (tab.getAttribute('aria-selected') === 'true') return;
    const renewals = host.querySelector('#bit-renewals-content');
    for (const button of tools.querySelectorAll('[role="tab"]')) {
      const active = button === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      host.querySelector('#' + button.getAttribute('aria-controls')).hidden = !active;
    }
    host.querySelector('[data-address-tool]').hidden = name !== 'address';
    host.querySelector('[data-address-help]').hidden = name !== 'address';
    host.querySelector('[data-renewal-help]').hidden = name !== 'renewals';
    host.querySelector('#bit-addresses-panel').setAttribute('aria-labelledby', tab.id);
    if (name === 'renewals') {
      window.IDSearchInput?.restore(renewals);
      void readRenewals(renewals);
    } else {
      window.IDSearchInput?.suspend(renewals);
      renewalPages.get(renewals)?.controller?.abort();
    }
  }

  function mountRenewals(host, panel) {
    const state = { page: 1, pageSize: window.IDPagination.defaultPageSize, rows: [], controller: null };
    renewalPages.set(panel, state);
    const updateFilter = () => { state.page = 1; void readRenewals(panel); };
    panel.querySelector('#bit-renewals-search').addEventListener('input', updateFilter);
    panel.querySelector('#bit-renewals-status').addEventListener('change', updateFilter);
    panel.addEventListener('id-pagination-change', ({ detail }) => {
      Object.assign(state, { page: detail.page, pageSize: detail.pageSize });
      void readRenewals(panel);
    });
    panel.addEventListener('click', event => {
      const control = event.target.closest('button');
      if (!control) return;
      if (control.dataset.action === 'bit-renewals-refresh') void readRenewals(panel);
      const row = state.rows.find(item => item.id === control.dataset.record);
      if (row) editRenewal(panel, row);
    });
    const entry = host.closest('.bit-login-layout').querySelector('#bit-renewal-entry');
    entry.elements.email.addEventListener('paste', pasteRegistrationEmail);
    entry.addEventListener('submit', event => {
      event.preventDefault();
      void saveRecord(entry, panel);
    });
  }

  function pasteRegistrationEmail(event) {
    const input = event.currentTarget;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Plain email text keeps the browser's normal insertion and selection behavior.
      if (text && !/[{}\[\]"`\r\n]/.test(text)) return;
    }
    event.preventDefault();
    const feedback = input.form.querySelector('[data-record-feedback]');
    const checker = document.createElement('input');
    checker.type = 'email';
    const email = [data?.user?.email, data?.email]
      .map(value => typeof value === 'string' ? value.trim() : '')
      .find(value => {
        if (value.length > input.maxLength || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return false;
        checker.value = value;
        return checker.validity.valid;
      });
    if (!email) {
      feedback.textContent = '未能从粘贴内容识别邮箱，请输入账号邮箱。';
      return;
    }
    input.value = email;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    feedback.textContent = '已识别账号邮箱。';
  }

  function editRenewal(panel, row) {
    const remoteWorkspace = document.body.hasAttribute('data-manual-remote-workspaces');
    A.openDrawer('续费记录', '按实际办理结果登记状态和套餐。', `
      <form id="bit-edit-renewal" class="bit-registration-form">
        <div class="property-row"><span>账号邮箱</span><strong>${esc(row.email)}</strong></div>
        <div class="property-row"><span>最后打开</span><strong>${esc(openDate(row.lastOpenedAt))}</strong></div>
        ${remoteWorkspace
          ? `<a class="button" href="/manual-workspaces/${esc(encodeURIComponent(row.id))}/" target="_blank" rel="noopener noreferrer">打开服务器工作区</a>` : ''}
        <div class="property-row"><span>${remoteWorkspace ? '历史登记代理' : '绑定代理'}</span><strong>${esc(row.proxySummary || '—')}</strong></div>
        <label>当前套餐<input class="input" name="currentPlan" value="${esc(row.currentPlan)}" maxlength="48"></label>
        <label>续费状态<select class="select" name="status">${Object.entries(renewalStatuses)
          .filter(([key]) => key !== 'unknown' || row.status === key)
          .map(([key, label]) => `<option value="${key}" ${row.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>续费备注<textarea class="input" name="renewalNotes" rows="3" maxlength="2000">${esc(row.renewalNotes)}</textarea></label>
        <button class="button primary" type="submit">保存登记</button><div role="status" data-record-feedback></div>
      </form>`, '', 'bit-renewal-record');
    const form = $('#bit-edit-renewal');
    form.addEventListener('submit', event => {
      event.preventDefault();
      void saveRecord(form, panel, row);
    });
  }

  async function saveRecord(form, panel, previous) {
    if (form.getAttribute('aria-busy') === 'true') return;
    const data = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[type="submit"]');
    const status = form.querySelector('[data-record-feedback]');
    const snapshot = JSON.stringify(data);
    form.setAttribute('aria-busy', 'true');
    submit.disabled = true;
    status.textContent = '正在保存…';
    try {
      const saved = await localData.saveManualRenewal(previous ? { ...data, id: previous.id, expectedRevision: previous.revision } : data);
      if (!form.isConnected) return;
      const unchanged = JSON.stringify(Object.fromEntries(new FormData(form))) === snapshot;
      if (previous && unchanged) A.closeDrawer();
      else if (previous) previous.revision = saved.record.revision;
      else if (!previous && unchanged) form.reset();
      status.textContent = unchanged ? '已保存续费登记。' : '已保存上次提交的内容，后续修改尚未保存。';
      A.notify('已保存续费登记');
      if (!panel.hidden && panel.isConnected) await readRenewals(panel);
    } catch (error) {
      status.textContent = error.message || '保存失败，请重试。';
    } finally {
      form.setAttribute('aria-busy', 'false');
      submit.disabled = false;
    }
  }

  async function readRenewals(panel) {
    const state = renewalPages.get(panel);
    if (!state || panel.hidden || panel.closest('[hidden]')) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const query = { page: state.page, pageSize: state.pageSize, search: panel.querySelector('#bit-renewals-search').value.trim(),
      status: panel.querySelector('#bit-renewals-status').value };
    const read = A.beginRegionRead(panel, panel.querySelector('[data-renewals-progress]'), {
      loadingText: '正在读取续费记录…', refreshButton: panel.querySelector('[data-action="bit-renewals-refresh"]')
    });
    const errorBox = panel.querySelector('[data-renewals-error]');
    try {
      const result = await localData.listManualRenewals(query, controller.signal);
      if (controller.signal.aborted || !read.current() || panel.closest('[hidden]')) return;
      state.rows = result.items;
      state.page = result.page;
      errorBox.hidden = true;
      const counts = result.summary.statuses;
      panel.querySelector('[data-renewal-summary]').innerHTML = `<div class="bit-renewal-counts" aria-label="所有登记账号状态">
        <span>全部 <b>${esc(result.summary.total)}</b></span><span>待续费 <b>${esc(counts.pending_renewal)}</b></span>
        <span>已开通 <b>${esc(counts.active)}</b></span><span>已过期 <b>${esc(counts.expired)}</b></span>
        ${counts.unknown ? `<span>未登记 <b>${esc(counts.unknown)}</b></span>` : ''}</div>
        <div class="bit-renewal-plans">登记套餐　${result.summary.plans.map(p => `${esc(planName(p.name))} · ${esc(p.count)}`).join('　') || '—'}</div>`;
      panel.querySelector('tbody').innerHTML = state.rows.length ? state.rows.map(row => `<tr>
        <td><strong>${esc(row.email)}</strong><small>上次打开 · ${esc(openDate(row.lastOpenedAt))}</small></td>
        <td data-label="套餐">${esc(planName(row.currentPlan))}</td>
        <td data-label="状态">${A.tag(renewalStatuses[row.status] || '未登记', row.status === 'active' ? 'success' : row.status === 'pending_renewal' ? 'warning' : '')}</td>
        <td>${button('查看记录', 'bit-renewal-detail', '', '', `data-record="${esc(row.id)}"`)}</td>
      </tr>`).join('') : `<tr><td colspan="4" class="bit-renewal-empty">${query.search || query.status ? '没有符合条件的账号' : '暂无续费账号'}</td></tr>`;
      panel.querySelector('[data-renewal-pagination]').innerHTML = window.IDPagination.render({
        id: 'manual-renewals', page: result.page, pageSize: result.pageSize, total: result.total
      });
    } catch (error) {
      if (controller.signal.aborted || !read.current()) return;
      errorBox.textContent = '续费记录读取失败，请刷新重试。';
      errorBox.hidden = false;
    } finally { read.finish(); }
  }

  function renderTabs() {
    for (const [id] of statuses) {
      const active = id === filters.status;
      const tab = $(`#bit-address-tab-${id}`);
      tab.classList.toggle('active', active);
      tab.tabIndex = active ? 0 : -1;
      tab.setAttribute('aria-selected', String(active));
      tab.querySelector('.tab-count').textContent = totals?.[id] ?? '—';
    }
    $('#bit-address-tabpanel').setAttribute('aria-labelledby', `bit-address-tab-${filters.status}`);
    $('[data-bit-address-field="usedAt"]').hidden = filters.status !== 'used';
  }

  function selectTab(status) {
    if (filters.status === status || !Object.hasOwn(labels, status)) return;
    filters.status = status;
    filters.page = 1;
    current = null;
    renderTabs();
    renderList();
    feedback('');
    void refresh('', { force: false });
  }

  function onTabKeydown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const status = event.key === 'Home' || (event.key !== 'End' && filters.status === 'used')
      ? 'unused' : 'used';
    selectTab(status);
    $(`#bit-address-tab-${status}`).focus();
  }

  function feedback(message, kind = '') {
    const output = $('#bit-address-feedback');
    if (!addressPanel() || !output) return;
    output.textContent = message;
    output.hidden = !message;
    output.className = kind === 'loading' ? 'design-region-progress' : `inline-notice ${kind}`;
  }

  function updateControls() {
    const generator = $('#drawer[open] #bit-address-generate');
    if (generator) {
      const drawer = generator.closest('dialog');
      const submit = $('#bit-address-generate-button', drawer);
      generator.setAttribute('aria-busy', String(saving));
      $('#bit-address-generate-count', generator).disabled = saving;
      submit.disabled = saving;
      submit.textContent = saving ? '生成中…' : '生成地址';
      for (const close of drawer.querySelectorAll('[data-action="drawer-close"]'))
        close.disabled = saving;
    }
    if (!addressPanel()) return;
    $('#bit-address-generate-open').disabled = saving;
    const remove = $('[data-action="bit-address-delete-used"]');
    remove.hidden = filters.status !== 'used';
    remove.disabled = saving || !current?.totals?.used || !Number.isSafeInteger(current.version);
    for (const control of addressPanel().querySelectorAll('[data-action="bit-address-copy"]'))
      control.disabled = saving;
  }

  function openGenerateDrawer() {
    if (saving) return;
    A.openDrawer(
      '生成地址',
      '每次可生成 1 至 100 条美国账单地址模板，保存后加入未使用地址库。',
      `<form id="bit-address-generate" aria-label="生成账单地址" data-protect-drawer-dismiss novalidate>
        ${field('生成数量', 'bit-address-generate-count',
          input('bit-address-generate-count', draft.generationCount,
            'type="number" min="1" max="100" step="1" required autofocus'), true)}
      </form>
      <p id="bit-address-generate-error" class="inline-notice warning" role="alert" hidden></p>`,
      button('取消', 'drawer-close') +
        '<button id="bit-address-generate-button" class="button primary" type="submit" form="bit-address-generate">生成地址</button>'
    );
  }

  function generateAddresses(form) {
    const drawer = form.closest('#drawer[open]');
    if (!drawer || saving) return;
    const control = $('#bit-address-generate-count', form);
    const count = Number(control.value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      A.setError(control.id, '每次可生成 1 至 100 条地址', form);
      control.focus();
      return;
    }
    const error = $('#bit-address-generate-error', drawer);
    const drawerCurrent = () => drawer.open && form.isConnected;
    A.setError(control.id, '', form);
    error.hidden = true;
    void save({ count }, (result) => {
      filters.page = 1;
      if (drawerCurrent()) {
        A.closeDrawer();
        $('#bit-address-heading')?.focus({ preventScroll: true });
      }
      return `已成功生成 ${result.count} 条地址`;
    }, {
      successToast: true,
      onFailure(message) {
        if (!drawerCurrent()) return;
        error.textContent = message;
        error.hidden = false;
      }
    });
  }

  function renderList() {
    const list = $('#bit-address-list');
    if (!list) return;
    const hiddenColumns = A.hiddenTableColumns(endpoint);
    for (const control of addressPanel().querySelectorAll('[data-bit-address-column]:not([aria-busy])'))
      control.checked = !hiddenColumns.has(control.dataset.bitAddressColumn);
    if (!current) {
      list.replaceChildren();
      updateControls();
      return;
    }
    const { items, total, page, pageSize } = current;
    const { status, keyword } = filters;
    const tableColumns = columns.filter(({ id }) =>
      (id === 'line1' || id === 'actions' || !hiddenColumns.has(id)) && (id !== 'usedAt' || status === 'used')
    );
    list.innerHTML = `
      ${A.table(tableColumns, items, '', labels[status] + '地址', {
        title: keyword ? '暂无符合条件的地址' : '暂无' + labels[status] + '地址',
        description: keyword ? '可调整搜索条件。' : status === 'unused'
          ? '点击「生成地址」添加地址。' : '复制成功的地址会显示在这里。'
      })}
      ${window.IDPagination.render({ id: endpoint, page, pageSize, total })}`;
    updateControls();
  }

  async function refresh(completedMessage = '', { force = true, quietSuccess = false } = {}) {
    const panel = addressPanel();
    if (!panel) return;
    const query = { ...filters };
    const cached = localData.queries?.peek(endpoint, query);
    if (cached?.data && !force) {
      showResult(cached.data);
      if (!cached.stale) return;
    }
    const status = panel.querySelector('[data-bit-address-read-status]');
    const read = A.beginRegionRead(status.parentElement, status, {
      loadingText: current ? '' : '正在加载地址…',
      refreshButton: panel.querySelector('[data-action="bit-address-refresh"]')
    });
    const isCurrent = () => read.current() && addressPanel() === panel &&
      Object.keys(query).every((key) => query[key] === filters[key]);
    try {
      const load = () => localData.load(`${endpoint}?${new URLSearchParams(query)}`);
      let result;
      // A version event can invalidate this GET after the write has succeeded.
      // Retry only the read while this view still owns it; never repeat a write.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = localData.queries
            ? await localData.queries.read(endpoint, query, load, { refresh: force || attempt > 0 }) : await load();
          break;
        } catch (error) {
          if (error.code !== 'READ_SUPERSEDED') throw error;
          if (!isCurrent() || !localData.queries.peek(endpoint, query)) return;
          if (attempt === 2) throw new Error('地址列表持续更新，暂未取得最新结果');
        }
      }
      if (!isCurrent()) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (result.page > lastPage) {
        filters.page = lastPage;
        return await refresh(completedMessage, { quietSuccess });
      }
      showResult(result);
      feedback(quietSuccess ? '' : completedMessage);
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (isCurrent())
        feedback(
          `${completedMessage ? completedMessage + ' ' : ''}${error.message}。请点击刷新重试。`,
          'warning'
        );
      return false;
    } finally {
      read.finish();
    }
  }

  function showResult(result) {
    current = result;
    totals = result.totals;
    filters.page = result.page;
    for (const row of result.items)
      if (row.status === 'used') pendingCopied.delete(row.id);
    renderTabs();
    renderList();
  }

  async function save(payload, complete, { beforeWrite, failurePrefix = '', successToast = false, onFailure } = {}) {
    if (saving) return;
    saving = true;
    updateControls();
    try {
      if (beforeWrite && !(await beforeWrite())) return;
      feedback('正在保存地址…', 'loading');
      const result = await localData.saveBitBrowserAddresses(payload);
      const message = complete(result);
      if (successToast) {
        feedback('');
        A.notify(message, { kind: 'success' });
      }
      if (addressPanel()) {
        if (!successToast) feedback(message);
        await refresh(message, { quietSuccess: successToast });
      } else if (!successToast) A.notify(message);
    } catch (error) {
      const message = failurePrefix + error.message;
      onFailure?.(message);
      if (addressPanel()) {
        renderList();
        if (error.status === 409) await refresh(message);
        else feedback(message, 'warning');
      } else A.notify(message, { kind: 'warning' });
    } finally {
      saving = false;
      updateControls();
    }
  }

  function copyAddress(row) {
    if (saving) return;
    const state = row.state === 'OR' ? 'Oregon' : row.state;
    const value = [
      '国家：United States',
      '街道地址：' + row.line1,
      '州：' + state,
      '城市：' + row.city,
      '邮编：' + row.postalCode
    ].join('\n');
    if (row.status === 'used') {
      void A.copyText(value, '地址已复制');
      return;
    }
    void save({ id: row.id, status: 'used', expectedStatus: 'unused' }, () => {
      pendingCopied.delete(row.id);
      return '地址已复制并移入已使用。';
    }, {
      beforeWrite: async () => {
        if (pendingCopied.has(row.id)) return true;
        if (!(await A.copyText(value, '地址已复制'))) return false;
        pendingCopied.add(row.id);
        return true;
      },
      failurePrefix: '地址已复制，标记暂未完成。请点击「重试标记」。'
    });
  }

  function deleteUsed() {
    if (saving || !current?.totals?.used || !Number.isSafeInteger(current.version)) return;
    const { version, totals: { used } } = current;
    A.confirmAction(
      '删除已使用地址',
      `将删除当前地址库的 ${used} 条已使用地址，包含所有分页。删除后无法恢复。`,
      () => void save({ deleteUsed: true, version }, ({ deleted }) => `已删除 ${deleted} 条已使用地址。`),
      '确认删除'
    );
  }

  document.addEventListener('id-pagination-change', ({ detail }) => {
    if (detail?.id !== endpoint || !addressPanel()) return;
    Object.assign(filters, { page: detail.page, pageSize: detail.pageSize });
    void refresh();
  });

  A.modules.bitbrowserAddresses = { mount, selectPane };
  window.IDDesignModules.push({
    id: 'bitbrowser-addresses',
    matches: () => false,
    onDataChanges(scopes) {
      const jobs = [];
      const panel = document.querySelector('#bit-renewals-content');
      if (scopes.includes('manual-renewal-records') && panel && !panel.closest('[hidden]')) jobs.push(readRenewals(panel));
      if (scopes.includes(endpoint) && addressPanel() && !saving) jobs.push(refresh());
      if (jobs.length) return Promise.all(jobs);
    },
    onClick(action, node) {
      if (action === 'bit-address-open-generate') openGenerateDrawer();
      else if (action === 'bit-address-tab') selectTab(node.dataset.status);
      else if (action === 'bit-address-delete-used') deleteUsed();
      else if (action === 'bit-address-refresh') void A.withActionFeedback(node, () => refresh(),
        { pending: '正在刷新地址…', success: '地址列表已刷新', failure: '地址读取失败，请重试' });
      else if (action === 'bit-address-columns') {
        const choices = $('#bit-address-columns');
        choices.hidden = !choices.hidden;
        node.setAttribute('aria-expanded', String(!choices.hidden));
      } else if (action === 'bit-address-copy') {
        const row = current?.items.find(({ id }) => id === node.dataset.id);
        if (row) copyAddress(row);
      } else return false;
      return true;
    },
    onSubmit(form) {
      if (form.id === 'bit-address-filters') {
        Object.assign(filters, { keyword: draft.keyword.trim(), page: 1 });
        void refresh();
      } else if (form.id === 'bit-address-generate') {
        generateAddresses(form);
      } else return false;
      return true;
    },
    async onChange(node) {
      if (node.dataset.bitAddressColumn) {
        const columnId = node.dataset.bitAddressColumn;
        if (!columns.slice(1, -1).some(({ id }) => id === columnId)) return true;
        await A.saveColumnPreference(endpoint, { columnId, visible: node.checked }, node);
        renderList();
      } else return false;
      return true;
    },
    onInput(node) {
      if (node.id === 'bit-address-generate-count') {
        draft.generationCount = node.value;
        A.setError('bit-address-generate-count', '');
      } else if (node.id === 'bit-address-keyword') draft.keyword = node.value;
      else return false;
      return true;
    }
  });
})();
