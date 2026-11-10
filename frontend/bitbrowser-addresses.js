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
  const hiddenColumns = new Set();
  const pendingCopied = new Set();
  const dates = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'short'
  });
  let pendingFile = null;
  let current = null;
  let totals = null;
  let readingFile = false;
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
    { id: 'createdAt', label: '导入时间', render: (row) => dates.format(new Date(row.createdAt)) },
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
    host.innerHTML = `<section class="panel" id="bit-addresses-panel" aria-labelledby="bit-address-heading">
      <header class="panel-heading bit-workspace-heading">
        <div class="title-with-help"><h2 id="bit-address-heading">地址管理</h2>${A.titleInfo(
          '地址管理',
          '生成美国账单地址模板，或导入 TXT 街道地址。导入沿用 Portland、OR、97204。复制成功后自动移入已使用，使用前请核对。',
          'bit-address-help'
        )}</div>
      </header>
      <div class="panel-body bit-address-body">
        <div class="bit-address-source-toolbar">
          <form id="bit-address-generate" class="bit-address-form" aria-label="生成账单地址" novalidate>
            ${field(
              '生成数量',
              'bit-address-generate-count',
              '<div class="bit-address-generate-controls">' +
                input(
                  'bit-address-generate-count',
                  draft.generationCount,
                  'type="number" min="1" max="100" step="1" required'
                ) +
                '<button id="bit-address-generate-button" class="button primary" type="submit">一键生成地址</button></div>',
              true
            )}
          </form>
          <form id="bit-address-import" class="bit-address-form" novalidate>
            ${field(
              '地址文件',
              'bit-address-file',
              '<div class="bit-address-import-controls"><input id="bit-address-file" type="file" accept=".txt,text/plain" /><button id="bit-address-import-button" class="button" type="submit">导入地址</button></div>',
              true
            )}
            <p id="bit-address-file-summary" class="footnote" hidden></p>
          </form>
        </div>
        <div class="tabs bit-address-tabs" role="tablist" aria-label="地址状态">
          ${statuses.map(([id, label]) => `
            <button id="bit-address-tab-${id}" class="tab" type="button" role="tab"
              aria-controls="bit-address-tabpanel" data-action="bit-address-tab" data-status="${id}">
              ${label}<span class="tab-count">—</span>
            </button>`).join('')}
        </div>
        <div id="bit-address-tabpanel" role="tabpanel">
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
    </section>`;
    $('.bit-address-tabs', host).addEventListener('keydown', onTabKeydown);
    renderTabs();
    renderList();
    void refresh('', { force: false });
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
    if (!addressPanel()) return;
    const summary = $('#bit-address-file-summary');
    summary.hidden = !pendingFile;
    summary.textContent = pendingFile
      ? `${pendingFile.name} · 已读取 ${pendingFile.streets.length} 行`
      : '';
    $('#bit-address-file').disabled = saving || readingFile;
    $('#bit-address-import-button').disabled = saving || readingFile || !pendingFile;
    $('#bit-address-generate-count').disabled = saving || readingFile;
    $('#bit-address-generate-button').disabled = saving || readingFile;
    const remove = $('[data-action="bit-address-delete-used"]');
    remove.hidden = filters.status !== 'used';
    remove.disabled = saving || !current?.totals?.used || !Number.isSafeInteger(current.version);
    for (const control of addressPanel().querySelectorAll('[data-action="bit-address-copy"]'))
      control.disabled = saving;
  }

  function renderList() {
    const list = $('#bit-address-list');
    if (!list) return;
    if (!current) {
      list.replaceChildren();
      updateControls();
      return;
    }
    const { items, total, page, pageSize } = current;
    const { status, keyword } = filters;
    const tableColumns = columns.filter(({ id }) =>
      !hiddenColumns.has(id) && (id !== 'usedAt' || status === 'used')
    );
    list.innerHTML = `
      ${A.table(tableColumns, items, '', labels[status] + '地址', {
        title: keyword ? '暂无符合条件的地址' : '暂无' + labels[status] + '地址',
        description: keyword ? '可调整搜索条件。' : status === 'unused'
          ? '可生成地址或导入 TXT 地址文件。' : '复制成功的地址会显示在这里。'
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

  async function readAddressFile(control) {
    const panel = addressPanel();
    const file = control.files?.[0];
    if (!file || saving) return;
    control.value = '';
    pendingFile = null;
    readingFile = true;
    control.disabled = true;
    A.setError('bit-address-file', '');
    updateControls();
    try {
      if (!/\.txt$/i.test(file.name)) throw new Error('请选择 TXT 文件');
      if (file.size > 256000) throw new Error('TXT 文件不能超过 256 KB');
      const streets = (await file.text())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!streets.length || streets.length > 2000)
        throw new Error('文件需要包含 1 至 2000 行街道地址');
      pendingFile = { name: file.name, streets };
    } catch (error) {
      if (addressPanel() === panel) A.setError('bit-address-file', error.message || '无法读取地址文件');
    } finally {
      readingFile = false;
      updateControls();
    }
  }

  async function save(payload, complete, { beforeWrite, failurePrefix = '', successToast = false } = {}) {
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

  A.modules.bitbrowserAddresses = { mount };
  window.IDDesignModules.push({
    id: 'bitbrowser-addresses',
    matches: () => false,
    onDataChanges(scopes) {
      if (scopes.includes(endpoint) && addressPanel() && !saving) return refresh();
    },
    onClick(action, node) {
      if (action === 'bit-address-tab') selectTab(node.dataset.status);
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
        if (saving || readingFile) return true;
        const count = Number(draft.generationCount);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
          A.setError('bit-address-generate-count', '每次可生成 1 至 100 条地址');
          return true;
        }
        A.setError('bit-address-generate-count', '');
        void save({ count }, (result) => {
          filters.page = 1;
          return `已成功生成 ${result.count} 条地址`;
        }, { successToast: true });
      } else if (form.id === 'bit-address-import') {
        if (pendingFile && !readingFile) {
          void save({ streets: pendingFile.streets }, ({ imported, duplicated, rejected }) => {
            pendingFile = null;
            filters.page = 1;
            return `成功导入 ${imported} 条，重复 ${duplicated} 条，未通过 ${rejected} 条。`;
          });
        }
      } else return false;
      return true;
    },
    onChange(node) {
      if (node.id === 'bit-address-file') void readAddressFile(node);
      else if (node.dataset.bitAddressColumn) {
        const id = node.dataset.bitAddressColumn;
        if (node.checked) hiddenColumns.delete(id);
        else hiddenColumns.add(id);
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
