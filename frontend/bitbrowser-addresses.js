(() => {
  'use strict';
  const localData = window.IDLocalData;
  if (!localData) return;

  const A = window.IDDesignAPI;
  const { $, esc, button, textAction, tag, field, input, options } = A;
  const endpoint = 'bitbrowser-addresses';
  const statuses = [
    ['all', '全部状态'],
    ['unused', '未使用'],
    ['used', '已使用'],
    ['disabled', '已停用']
  ];
  const labels = Object.fromEntries(statuses);
  const filters = { page: 1, pageSize: 20, keyword: '', status: 'all' };
  const draft = { keyword: '', status: 'all', generationCount: '10' };
  const hiddenColumns = new Set();
  const dates = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'short'
  });
  let pendingFile = null;
  let current = null;
  let readingFile = false;
  let saving = false;

  const columns = [
    { id: 'line1', label: '街道地址' },
    { id: 'city', label: '城市' },
    { id: 'state', label: '州' },
    { id: 'postalCode', label: '邮编' },
    { id: 'country', label: '国家', render: () => '美国 US' },
    {
      id: 'status',
      label: '状态',
      render: (row) =>
        tag(labels[row.status], { unused: 'green', used: 'blue', disabled: 'warning' }[row.status])
    },
    {
      id: 'usedAt',
      label: '使用时间',
      render: (row) => (row.usedAt ? dates.format(new Date(row.usedAt)) : '—')
    },
    { id: 'createdAt', label: '导入时间', render: (row) => dates.format(new Date(row.createdAt)) },
    { id: 'actions', label: '操作', action: true, render: rowActions }
  ];

  function rowActions(row) {
    const id = `data-id="${esc(row.id)}"`;
    const transitions =
      row.status === 'used'
        ? '<span class="footnote">不可恢复</span>'
        : textAction('标记已使用', 'bit-address-status', `${id} data-status="used"`) +
          (row.status === 'unused'
            ? textAction('停用', 'bit-address-status', `${id} data-status="disabled"`)
            : textAction('启用', 'bit-address-status', `${id} data-status="unused"`));
    return `<div class="action-links">${textAction('复制地址', 'bit-address-copy', id)}${transitions}</div>`;
  }

  function opened() {
    return $('#drawer').open ? $('#bit-addresses-panel') : null;
  }

  function showAddresses() {
    A.openDrawer(
      '地址管理',
      '可一键生成美国账单地址模板，付款前请核对资料。TXT 导入仍使用 Portland、OR、97204，时间按北京时间显示。',
      `<div id="bit-addresses-panel">
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
        <form id="bit-address-filters" class="toolbar bit-address-filters" aria-label="地址查询" novalidate>
          <div class="toolbar-left">
            <div class="search-field">${A.icon('search')}${input('bit-address-keyword', draft.keyword, 'aria-label="搜索街道地址" placeholder="搜索街道地址" maxlength="80"')}</div>
            <select id="bit-address-filter-status" name="bit-address-filter-status" aria-label="地址状态">${options(statuses, draft.status)}</select>
            <button class="button" type="submit">查询</button>
          </div>
          <div class="toolbar-right">
            ${button('列设置', 'bit-address-columns', '', 'columns', 'aria-expanded="false" aria-controls="bit-address-columns"')}
            ${button('刷新', 'bit-address-refresh')}
          </div>
        </form>
        <fieldset id="bit-address-columns" class="bit-address-columns" hidden>
          <legend>显示字段</legend>
          ${columns
            .slice(1, -1)
            .map(
              ({ id, label }) =>
                `<label class="checkbox-label"><input type="checkbox" data-bit-address-column="${id}" ${hiddenColumns.has(id) ? '' : 'checked'} /><span>${esc(label)}</span></label>`
            )
            .join('')}
        </fieldset>
        <div id="bit-address-feedback" aria-live="polite" hidden></div>
        <div class="design-async-region">
          <div data-bit-address-read-status role="status" hidden></div>
          <section id="bit-address-list" aria-label="地址清单"></section>
        </div>
      </div>`,
      button('关闭', 'drawer-close')
    );
    updateFileSummary();
    renderList();
    void refresh('', { force: false });
  }

  function feedback(message, kind = '') {
    const output = $('#bit-address-feedback');
    if (!opened() || !output) return;
    output.textContent = message;
    output.hidden = !message;
    output.className = kind === 'loading' ? 'design-region-progress' : `inline-notice ${kind}`;
  }

  function updateFileSummary() {
    if (!opened()) return;
    const summary = $('#bit-address-file-summary');
    summary.hidden = !pendingFile;
    summary.textContent = pendingFile
      ? `${pendingFile.name} · 已读取 ${pendingFile.streets.length} 行`
      : '';
    $('#bit-address-file').disabled = saving || readingFile;
    $('#bit-address-import-button').disabled = saving || readingFile || !pendingFile;
    $('#bit-address-generate-count').disabled = saving || readingFile;
    $('#bit-address-generate-button').disabled = saving || readingFile;
  }

  function renderList() {
    const list = $('#bit-address-list');
    if (!opened() || !current) return;
    const { items, total, totals, page, pageSize } = current;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const description =
      filters.keyword || filters.status !== 'all'
        ? '当前筛选条件下没有地址。'
        : '可一键生成地址或导入 TXT 地址文件。';
    list.innerHTML = `
      <div class="bit-address-counts" aria-label="地址数量">${statuses
        .slice(1)
        .map(([id, label]) => `<span>${label} <strong>${totals[id]}</strong></span>`)
        .join('')}</div>
      ${
        items.length
          ? A.table(
              columns.filter(({ id }) => !hiddenColumns.has(id)),
              items,
              '',
              '比特账单地址'
            )
          : A.empty('暂无地址', description)
      }
      <div class="pagination"><span>共 ${total} 条 · 第 ${page} / ${pages} 页</span><div class="pagination-controls">
        <select id="bit-address-page-size" aria-label="每页条数">${options(
          [20, 50, 100].map((count) => [count, `${count} 条 / 页`]),
          pageSize
        )}</select>
        ${button('上一页', 'bit-address-page', '', '', `data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}`)}
        ${button('下一页', 'bit-address-page', '', '', `data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}`)}
      </div></div>`;
  }

  async function refresh(completedMessage = '', { force = true } = {}) {
    const panel = opened();
    if (!panel) return;
    const query = { ...filters };
    const cached = localData.queries?.peek(endpoint, query);
    if (cached?.data && !force) {
      current = cached.data;
      renderList();
      if (!cached.stale) return;
    }
    const status = panel.querySelector('[data-bit-address-read-status]');
    const read = A.beginRegionRead(status.parentElement, status, {
      loadingText: current ? '' : '正在加载地址…',
      refreshButton: panel.querySelector('[data-action="bit-address-refresh"]')
    });
    try {
      const load = () => localData.load(`${endpoint}?${new URLSearchParams(query)}`);
      const result = localData.queries
        ? await localData.queries.read(endpoint, query, load, { refresh: force }) : await load();
      if (!read.current()) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (result.page > lastPage) {
        filters.page = lastPage;
        return await refresh(completedMessage);
      }
      current = result;
      filters.page = result.page;
      renderList();
      feedback(completedMessage);
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (read.current())
        feedback(
          `${completedMessage ? completedMessage + ' ' : ''}${error.message}。请点击刷新重试。`,
          'warning'
        );
      return false;
    } finally {
      read.finish();
    }
  }

  async function readAddressFile(control) {
    const panel = opened();
    const file = control.files?.[0];
    if (!file || saving) return;
    control.value = '';
    pendingFile = null;
    readingFile = true;
    control.disabled = true;
    A.setError('bit-address-file', '');
    updateFileSummary();
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
      if (opened() === panel) A.setError('bit-address-file', error.message || '无法读取地址文件');
    } finally {
      readingFile = false;
      updateFileSummary();
    }
  }

  async function save(payload, complete) {
    if (saving) return;
    saving = true;
    updateFileSummary();
    feedback('正在保存地址…', 'loading');
    try {
      const result = await localData.saveBitBrowserAddresses(payload);
      const message = complete(result);
      if (opened()) await refresh(message);
      else A.notify(message);
    } catch (error) {
      if (opened()) {
        if (error.status === 409) await refresh(error.message);
        else feedback(error.message, 'warning');
      } else A.notify(error.message);
    } finally {
      saving = false;
      updateFileSummary();
    }
  }

  function changeStatus(row, status) {
    if (saving || row.status === 'used') return;
    const label = { used: '标记已使用', disabled: '停用', unused: '启用' }[status];
    const description = status === 'used' ? '标记后不可恢复。' : '';
    A.confirmAction(
      `确认${label}`,
      `街道地址 ${row.line1}。${description}`,
      () => void save({ id: row.id, status, expectedStatus: row.status }, () => '地址状态已更新。'),
      '确认'
    );
  }

  A.modules.bitbrowserAddresses = { open: showAddresses };
  window.IDDesignModules.push({
    id: 'bitbrowser-addresses',
    matches: () => false,
    onDataChanges(scopes) {
      if (scopes.includes(endpoint) && opened() && !saving) return refresh();
    },
    onClick(action, node) {
      if (action === 'bit-address-refresh') void A.withActionFeedback(node, () => refresh(),
        { pending: '正在刷新地址…', success: '地址列表已刷新', failure: '地址读取失败，请重试' });
      else if (action === 'bit-address-columns') {
        const choices = $('#bit-address-columns');
        choices.hidden = !choices.hidden;
        node.setAttribute('aria-expanded', String(!choices.hidden));
      } else if (action === 'bit-address-page') {
        filters.page = Number(node.dataset.page);
        void refresh();
      } else if (action === 'bit-address-copy' || action === 'bit-address-status') {
        const row = current?.items.find(({ id }) => id === node.dataset.id);
        if (row && action === 'bit-address-copy')
          void A.copyText(
            `${row.line1}\n${row.city}, ${row.state} ${row.postalCode}\nUnited States`,
            '地址已复制'
          );
        else if (row) changeStatus(row, node.dataset.status);
      } else return false;
      return true;
    },
    onSubmit(form) {
      if (form.id === 'bit-address-filters') {
        Object.assign(filters, { keyword: draft.keyword.trim(), status: draft.status, page: 1 });
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
          return `已生成 ${result.count} 条账单地址，付款前请核对资料。`;
        });
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
      else if (node.id === 'bit-address-filter-status') draft.status = node.value;
      else if (node.id === 'bit-address-page-size') {
        Object.assign(filters, { pageSize: Number(node.value), page: 1 });
        void refresh();
      } else if (node.dataset.bitAddressColumn) {
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
