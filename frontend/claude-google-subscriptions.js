(() => {
  'use strict';

  const A = window.IDDesignAPI;
  const D = window.IDLocalData;
  const { $, esc, button, textAction } = A;
  const route = 'data-management/claude-google-subscriptions';
  const tableId = 'claude-google-subscriptions';
  const filterKey = tableId + ':filters';
  const settingsKey = tableId + ':copy-settings';
  const listScopes = ['commerce', 'inventory', 'tools/mailbox-pool', 'operators'];
  const day = 86_400_000;
  const suffixLimit = 2000;
  const codeStates = {
    active: '有效',
    missing: '未登记',
    expired: '已过期',
    disabled: '已停用',
    auth_failed: '授权失败',
    conflict: '资料冲突'
  };
  const credentialStates = { available: '已关联', missing: '未找到库存资料', conflict: '库存资料冲突' };
  const valueLabels = { email: '邮箱账号', password: '邮箱密码', totp: '邮箱 2FA', queryCode: '买家查询码' };
  const omittedLabels = new Set(['邮箱密码', '邮箱 2FA', '邮箱2FA', '邮箱买家查询码', '买家查询码', '查询码', '2FA']);
  const dateFormat = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'short'
  });
  const fieldNames = ['claude-google-copy1', 'claude-google-copy2'];
  let snapshot, listError, clearSensitiveDrawer, expiryTimer;
  const actorId = () => D?.actor?.()?.id || A.state.actor?.id || '';
  const active = () => A.state.route === route && Boolean(D?.claudeGoogleSubscriptions) &&
    (!D.authRequired || ['admin', 'super'].includes(D.actor()?.role));

  function filters() {
    if (!A.state.drafts.has(filterKey))
      A.state.drafts.set(filterKey, { input: '', query: '', status: '', page: 1, pageSize: 8 });
    return A.state.drafts.get(filterKey);
  }

  function latest(row) {
    return snapshot?.rows.get(row.id);
  }

  function displayDate(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? dateFormat.format(time) : '—';
  }

  function codeTiming(record) {
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || !Number.isFinite(snapshot?.serverTime)) return record;
    const difference = expires - snapshot.serverTime - (performance.now() - snapshot.receivedAt);
    return {
      codeStatus: record.codeStatus === 'active' && difference <= 0 ? 'expired' : record.codeStatus,
      remainingDays: Math.max(0, Math.ceil(difference / day)),
      difference
    };
  }

  function queryCode(row) {
    const record = latest(row);
    if (!record) return '—';
    const { codeStatus } = codeTiming(record);
    const label = codeStates[codeStatus] || '待核对';
    const kind = codeStatus === 'active' ? 'green' : codeStatus === 'missing' ? '' : 'warning';
    const code = record.queryCode ? longValue(row, 'queryCode') + ' ' : '';
    return code + A.tag(label, kind);
  }

  function remainingDays(row) {
    const record = latest(row);
    if (!record?.queryCode) return '—';
    const { remainingDays } = codeTiming(record);
    return Number.isInteger(remainingDays) && remainingDays >= 0
      ? `<span title="${esc(displayDate(record.expiresAt))}">${remainingDays} 天</span>` : '—';
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (!snapshot) return;
    let next = Infinity;
    for (const record of snapshot.rows.values()) {
      const { difference } = codeTiming(record);
      if (difference > 0) next = Math.min(next, difference - (Math.ceil(difference / day) - 1) * day);
    }
    if (!Number.isFinite(next)) return;
    expiryTimer = setTimeout(() => {
      if (!active() || !snapshot) return;
      const renderedRows = $('#claude-google-subscriptions')?.querySelectorAll('tr[data-row-id]') || [];
      const items = new Map(snapshot.items.map(row => [row.id, row]));
      for (const element of renderedRows) {
        const row = items.get(esc(element.dataset.rowId));
        if (!row) continue;
        const code = $('[data-column="queryCode"]', element);
        const days = $('[data-column="remainingDays"]', element);
        if (code && $('.tag', code)?.textContent !== codeStates[codeTiming(latest(row)).codeStatus])
          code.innerHTML = queryCode(row);
        if (days) days.innerHTML = remainingDays(row);
      }
      if (snapshot.status === 'active' && [...snapshot.rows.values()].some(record =>
        record.codeStatus === 'active' && codeTiming(record).codeStatus === 'expired')) void load();
      scheduleExpiry();
    }, Math.max(25, next + 5));
  }

  function operator(row) {
    const ownerDiffers = row.ownerId && row.operatorId ? row.ownerId !== row.operatorId :
      row.ownerName && row.ownerName !== row.operatorName;
    return `<span>${esc(row.operatorName || '历史未记录')}</span>` + (ownerDiffers
      ? `<br><span class="footnote">归属：${esc(row.ownerName || '历史未记录')}</span>` : '');
  }

  function longValue(row, field) {
    const value = latest(row)?.[field] || '';
    const short = field === 'email' ? 36 : 28;
    if (value.length <= short) return esc(value || '—');
    return `<button class="table-value-button" type="button" data-action="claude-google-value"
      data-id="${row.id}" data-field="${field}" aria-label="查看${valueLabels[field]}完整内容"><span>${esc(value)}</span>${A.icon('info')}</button>`;
  }

  const columns = [
    { id: 'email', label: '邮箱账号', class: 'email-cell', render: row => longValue(row, 'email') },
    { id: 'password', label: '邮箱密码', class: 'mono', render: row => {
      const password = latest(row)?.password;
      return password ? longValue(row, 'password') : row.credentialStatus === 'available' ? '—' :
        A.tag(credentialStates[row.credentialStatus] || '待核对', 'warning');
    } },
    { id: 'totp', label: '邮箱 2FA', class: 'mono', render: row => longValue(row, 'totp') },
    { id: 'queryCode', label: '买家查询码', class: 'mono', render: queryCode },
    { id: 'remainingDays', label: '剩余天数', render: remainingDays },
    { id: 'operatorName', label: '操作人', render: operator },
    { id: 'actions', label: '操作', action: true, render: row => {
      const attrs = `data-id="${row.id}"`;
      return '<div class="action-links">' +
        textAction('复制邮箱和查询码', 'claude-google-copy', attrs + ' data-mode="1"') +
        textAction('复制完整资料', 'claude-google-copy', attrs + ' data-mode="2"') + '</div>';
    } }
  ];

  function renderList() {
    if (!snapshot && listError)
      return `<div class="panel-body" role="status">${A.empty(listError.message, '可重试读取或调整筛选条件。')}</div>`;
    if (!snapshot) return '';
    A.state.page = snapshot.page;
    A.state.pageSize = snapshot.pageSize;
    return A.table(columns, snapshot.items, '', tableId, {
      title: '暂无符合条件的 Claude 谷歌订阅',
      description: '可调整搜索或查询码状态。'
    }) + A.pagination(snapshot.total);
  }

  function render() {
    if (!active())
      return A.header('Claude 谷歌订阅管理', '') +
        `<section class="panel">${A.empty('当前无法读取订阅资料', '请使用有权限的账号访问。')}</section>`;
    const filter = filters();
    return A.header('Claude 谷歌订阅管理', '订阅资料随订单、谷歌邮箱库存和邮箱池更新。可选择两种复制格式。',
      button('复制后缀设置', 'claude-google-copy-settings', '', 'settings') +
      button('列设置', 'column-settings', '', 'columns', `data-table-id="${tableId}"`)) +
      `<section class="panel" id="claude-google-subscriptions">
        <form class="toolbar" id="claude-google-filter-form" aria-label="筛选订阅" novalidate>
          <div class="toolbar-left">
            <div class="search-field">${A.icon('search')}${A.input('claude-google-query', filter.input,
              'maxlength="254" aria-label="搜索邮箱、操作人或归属人" placeholder="搜索邮箱、操作人或归属人"')}</div>
            <select id="claude-google-code-status" aria-label="查询码状态">${A.options(
              [['', '全部状态'], ...Object.entries(codeStates)], filter.status)}</select>
            <button class="button" type="submit">搜索</button>
          </div>
          <div class="toolbar-right">${button('刷新', 'claude-google-refresh')}</div>
        </form>
        <div class="design-async-region">
          <div id="claude-google-read-status" role="status" hidden></div>
          ${snapshot && listError ? `<div class="panel-body" role="status"><p class="inline-notice warning">${esc(listError.message)}，已保留上次读取的资料。</p></div>` : ''}
          ${renderList()}
        </div>
      </section>`;
  }

  function params() {
    const { query, status, page, pageSize } = filters();
    return { query: query.trim(), status, page, pageSize };
  }

  function renderAfterRead(panel) {
    const search = $('#claude-google-query', panel);
    const keepFocus = document.activeElement === search;
    const selection = keepFocus && [search.selectionStart, search.selectionEnd];
    A.render();
    if (keepFocus) {
      const input = $('#claude-google-query');
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(...selection);
    }
  }

  async function load() {
    const panel = $('#claude-google-subscriptions');
    if (!active() || !panel) return false;
    const status = $('#claude-google-read-status', panel);
    const identity = actorId();
    const parameters = params();
    const key = JSON.stringify(parameters);
    const read = A.beginRegionRead(status.parentElement, status, {
      loadingText: snapshot ? '正在更新订阅资料…' : '正在读取订阅资料…',
      refreshButton: panel.querySelector('[data-action="claude-google-refresh"]')
    });
    const current = () => read.current() && active() && actorId() === identity;
    try {
      const result = await D.claudeGoogleSubscriptions(parameters);
      if (!current()) return;
      if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 ||
          !Number.isSafeInteger(result.page) || result.page < 1 || ![8, 16].includes(result.pageSize) ||
          typeof result.revision !== 'string' || !result.revision)
        throw new Error('invalid subscription view');
      const rows = new Map(result.items.map(row => [esc(row.id), row]));
      const items = result.items.map(row => ({
        id: esc(row.id),
        email: row.email,
        credentialStatus: row.credentialStatus,
        operatorId: row.operatorId,
        operatorName: row.operatorName,
        ownerId: row.ownerId,
        ownerName: row.ownerName
      }));
      if (clearSensitiveDrawer && snapshot?.revision !== result.revision) A.closeDrawer();
      Object.assign(filters(), { page: result.page, pageSize: result.pageSize });
      snapshot = { items, rows, revision: result.revision, total: result.total, page: result.page,
        pageSize: result.pageSize, status: parameters.status, serverTime: Date.parse(result.now), receivedAt: performance.now(),
        key: JSON.stringify({ ...parameters, page: result.page, pageSize: result.pageSize }) };
      listError = undefined;
      renderAfterRead(panel);
      return true;
    } catch (error) {
      if (!current()) return;
      const denied = [401, 403].includes(error?.status);
      if (denied) discardSensitive();
      listError = { key, message: denied ? '当前账号无权查看订阅资料' : '读取订阅资料失败，请刷新重试' };
      renderAfterRead(panel);
      return false;
    } finally {
      read.finish();
    }
  }

  function discardSensitive() {
    snapshot = undefined;
    listError = undefined;
    clearTimeout(expiryTimer);
    clearSensitiveDrawer?.();
  }

  function clearListMarkup(panel) {
    const status = panel && $('#claude-google-read-status', panel);
    if (!status) return;
    const region = status.parentElement;
    A.finishRegionRead(region);
    region.replaceChildren(status);
  }

  function trackSensitiveDrawer(area) {
    clearSensitiveDrawer?.();
    if (!area) return;
    const drawer = area.closest('dialog');
    const cleanup = new AbortController();
    clearSensitiveDrawer = () => {
      area.value = '';
      area.textContent = '';
      cleanup.abort();
      clearSensitiveDrawer = undefined;
    };
    drawer.addEventListener('id-view-deactivate', clearSensitiveDrawer, { signal: cleanup.signal });
    drawer.addEventListener('close', clearSensitiveDrawer, { signal: cleanup.signal });
  }

  function showLongValue(node) {
    const field = node.dataset.field;
    if (!Object.hasOwn(valueLabels, field)) return;
    const value = snapshot?.rows.get(esc(node.dataset.id))?.[field];
    if (!value) return;
    A.openDrawer(valueLabels[field], '',
      `<textarea class="copy-block" id="claude-google-full-value" aria-label="${valueLabels[field]}" readonly>\n${esc(value)}</textarea>`,
      button('关闭', 'drawer-close'));
    const area = $('#claude-google-full-value');
    trackSensitiveDrawer(area);
    area.focus({ preventScroll: true });
  }

  async function copy(node) {
    const currentSnapshot = snapshot;
    if (!currentSnapshot || !active()) return;
    const identity = actorId(), context = A.state.drawerContext;
    const id = node.dataset.id, mode = Number(node.dataset.mode);
    await A.withActionFeedback(node, async () => {
      const current = () => active() && identity === actorId() && node.isConnected &&
        A.state.drawerContext === context && snapshot === currentSnapshot;
      try {
        const { text, omitted } = await D.copyClaudeGoogleSubscription({ id, mode, revision: currentSnapshot.revision });
        if (!current()) return;
        if (typeof text !== 'string' || !text) throw new Error('invalid copy response');
        const missing = Array.isArray(omitted) ? omitted.filter(label => omittedLabels.has(label)) : [];
        const message = missing.length ? `已复制现有资料，缺少${missing.join('、')}` : '订阅资料已复制';
        if (await A.copyText(text, message, { current }) || !current()) return;
        trackSensitiveDrawer($('#drawer[open] textarea.copy-block'));
      } catch (error) {
        if (!current()) return;
        if ([401, 403].includes(error?.status)) {
          discardSensitive();
          listError = { key: JSON.stringify(params()), message: '当前账号无权查看订阅资料' };
          A.render();
          return;
        }
        if (error?.status === 409) {
          if (currentSnapshot.rows.get(esc(id))?.credentialStatus === 'conflict') {
            A.notify('邮箱关联存在冲突，请先核对订单和库存', { kind: 'warning' });
            return;
          }
          A.notify('资料已更新，请从刷新后的列表重新复制', { kind: 'warning' });
          void load();
          return;
        }
        throw new Error('复制订阅资料失败，请重试');
      }
    }, { pending: '正在读取订阅资料…', failure: '复制订阅资料失败，请重试' });
  }

  function settingsField(label, name, value) {
    return A.field(label, name, `<textarea id="${name}" name="${name}" rows="3" maxlength="${suffixLimit}" spellcheck="false">\n${esc(value)}</textarea>`);
  }

  function showSettings() {
    const draft = A.state.drafts.get(settingsKey);
    A.openDrawer('复制后缀设置', '分别为两种复制格式设置尾部文字，仅对当前账号生效。留空可直接复制资料。',
      `<form id="claude-google-copy-settings-form" novalidate>
        <input type="hidden" name="version" value="${esc(draft?.version || '')}">
        <div id="claude-google-settings-status" role="status" hidden></div>
        <div id="claude-google-settings-error" class="inline-notice warning" role="status" hidden></div>
        <div class="form-grid">
          ${settingsField('邮箱和查询码后缀', fieldNames[0], draft?.[fieldNames[0]] || '')}
          ${settingsField('完整资料后缀', fieldNames[1], draft?.[fieldNames[1]] || '')}
        </div>
        <div class="form-footer">
          ${button('重新读取设置', 'claude-google-settings-reload', '', '', 'hidden')}
          ${button('取消', 'drawer-close')}
          <button class="button primary" type="submit" disabled>保存设置</button>
        </div>
      </form>`, '', settingsKey);
    const form = $('#claude-google-copy-settings-form');
    void loadSettings(form, Boolean(draft?.version), Boolean(draft?.version));
  }

  function settingsFeedback(form, message, retry = false) {
    const output = $('#claude-google-settings-error', form);
    output.textContent = message;
    output.hidden = !message;
    $('[data-action="claude-google-settings-reload"]', form).hidden = !retry;
  }

  async function loadSettings(form, preserveInput, preserveVersion = false) {
    const identity = actorId();
    const status = $('#claude-google-settings-status', form);
    const read = A.beginRegionRead(form, status, { loadingText: '正在读取复制设置…' });
    const current = () => read.current() && active() && actorId() === identity;
    const save = $('[type="submit"]', form);
    save.disabled = true;
    const before = fieldNames.map(name => form.elements[name].value);
    settingsFeedback(form, '');
    try {
      const result = await D.claudeGoogleCopySettings();
      if (!current()) return;
      if (!Number.isSafeInteger(result?.version) || result.version < 0 ||
          typeof result.copy1 !== 'string' || typeof result.copy2 !== 'string')
        throw new Error('invalid copy settings');
      if (!preserveVersion) form.elements.version.value = result.version;
      const serverValues = [result.copy1, result.copy2];
      fieldNames.forEach((name, index) => {
        const input = form.elements[name];
        if (!preserveInput && input.value === before[index]) input.value = serverValues[index];
      });
      save.disabled = false;
    } catch {
      if (current()) settingsFeedback(form, '读取复制设置失败，请重试。', true);
    } finally {
      read.finish();
    }
  }

  async function saveSettings(form) {
    const submit = $('[type="submit"]', form);
    if (!active() || submit.disabled) return;
    const identity = actorId();
    const values = A.readForm(form);
    const version = Number(values.version);
    if (values.version === '' || !Number.isSafeInteger(version) || version < 0) return;
    settingsFeedback(form, '');
    let valid = true;
    for (const name of fieldNames) {
      const invalid = values[name].length > suffixLimit || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(values[name]);
      A.setError(name, invalid ? '请填写有效的后缀，最多 2000 字。' : '');
      if (invalid) valid = false;
    }
    if (!valid) return;
    await A.withActionFeedback(submit, async () => {
      const current = () => active() && actorId() === identity && form.isConnected &&
        A.state.drawerContext === settingsKey && $('#drawer').open;
      try {
        const result = await D.saveClaudeGoogleCopySettings({
          version, copy1: values[fieldNames[0]], copy2: values[fieldNames[1]]
        });
        if (!current()) return;
        if (!Number.isSafeInteger(result?.version) || result.version <= version)
          throw new Error('invalid copy settings acknowledgement');
        form.elements.version.value = result.version;
        const untouched = fieldNames.every(name => form.elements[name].value === values[name]);
        if (untouched) {
          A.closeDrawer();
          A.state.drafts.delete(settingsKey);
        }
        A.notify('复制设置已保存', { kind: 'success' });
      } catch (error) {
        if (current()) settingsFeedback(form,
          error?.status === 409 ? '复制设置已更新。重新读取后可以保留当前输入并再次保存。' : '保存复制设置失败，请重试。',
          error?.status === 409);
      }
    }, { pending: '正在保存复制设置…', failure: '保存复制设置失败，请重试' });
  }

  window.IDDesignModules.push({
    id: tableId,
    matches: candidate => candidate === route,
    render,
    afterRender() {
      if (!active()) return;
      scheduleExpiry();
      const key = JSON.stringify(params());
      if (snapshot?.key !== key && listError?.key !== key) void load();
    },
    deactivate(region) {
      clearListMarkup($('#claude-google-subscriptions', region));
      if (!active()) discardSensitive();
    },
    clearPageState() {
      discardSensitive();
      A.state.drafts.delete(filterKey);
      A.state.drafts.delete(settingsKey);
      const form = $('#claude-google-copy-settings-form');
      if (form) for (const name of fieldNames) {
        form.elements[name].value = '';
        form.elements[name].textContent = '';
      }
    },
    onDataChanges(scopes) {
      if (active() && scopes.some(scope => listScopes.includes(scope))) return load();
    },
    onClick(action, node) {
      if (!active()) return false;
      if (action === 'claude-google-refresh') void load();
      else if (action === 'claude-google-copy-settings') showSettings();
      else if (action === 'claude-google-copy') void copy(node);
      else if (action === 'claude-google-value') showLongValue(node);
      else if (action === 'claude-google-settings-reload') {
        const form = node.closest('form');
        void loadSettings(form, Boolean(form.elements.version.value));
      } else if (action === 'page' && node.closest('#claude-google-subscriptions')) {
        filters().page = Number(node.dataset.page);
        void load();
      } else return false;
      return true;
    },
    onSubmit(form) {
      if (!active()) return false;
      if (form.id === 'claude-google-filter-form') {
        filters().query = filters().input;
        filters().page = 1;
        void load();
      } else if (form.id === 'claude-google-copy-settings-form') void saveSettings(form);
      else return false;
      return true;
    },
    onChange(node) {
      if (!active()) return false;
      if (node.id === 'claude-google-code-status') filters().status = node.value;
      else if (node.id === 'page-size' && node.closest('#claude-google-subscriptions'))
        filters().pageSize = Number(node.value);
      else return false;
      filters().page = 1;
      void load();
      return true;
    },
    onInput(node) {
      if (node.id !== 'claude-google-query' || !active()) return false;
      filters().input = node.value;
      return true;
    }
  });

  window.addEventListener('pagehide', () => {
    discardSensitive();
    clearListMarkup($('#claude-google-subscriptions'));
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && active()) void load();
  });
})();
