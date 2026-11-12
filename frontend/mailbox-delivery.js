(() => {
  'use strict';
  const A = window.IDDesignAPI, data = window.IDLocalData, S = A.state;
  const { esc: E, button, tag } = A;
  const settingsForm = 'mailbox-delivery-settings-form', validityForm = 'mailbox-delivery-validity-form';
  const suffixes = [
    ['relayQuery', '隐藏邮箱查询', 'alias@example.test----BUY-DEMO-0001'],
    ['googleCredentials', '谷歌邮箱账密', 'google@example.test----演示密码----演示密钥'],
    ['managedQuery', '普通邮箱查询', 'mail@example.test----MBX-演示查询码']
  ];
  const resetStatuses = { success: '已重置', failed: '失败', skipped: '已跳过', pending: '待核对' };
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
  const identity = () => data?.actor?.()?.id || S.actor?.id || '';
  const enabled = () => Boolean(data?.resetMailboxDelivery) && ['admin', 'super'].includes(data.actor?.()?.role || S.actor?.role);
  const selected = scope => A.getSelection(scope === 'google' ? 'inventory-module-assets' : 'mailbox-delivery-' + scope);
  const append = (first, suffix) => first + (suffix?.trim() ? '\n' + suffix : '');
  const pending = new Map();
  let pool, byEmail = new Map(), report, settingsRequest = 0, sessionVersion = 0;

  function rememberPool(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) throw new Error('邮箱池资料读取失败');
    if (!pool || snapshot.version > pool.version || (snapshot.version === pool.version &&
        (snapshot.inventoryVersion ?? 0) >= (pool.inventoryVersion ?? 0))) {
      const { issuedCode, batch, results, ...metadata } = snapshot;
      pool = metadata;
      byEmail = new Map(pool.items.map(row => [row.email.trim().toLowerCase(), row]));
    }
    return pool;
  }
  async function readPool(refresh = false) {
    const actor = identity(), session = sessionVersion;
    const loader = () => data.managedMailboxPool();
    const snapshot = await (data.queries?.read('tools/mailbox-pool', 'list', loader, { refresh }) || loader());
    if (identity() !== actor || sessionVersion !== session) throw new Error('登录身份已变化');
    return rememberPool(snapshot);
  }
  function connection(row) {
    if (!row) return pool ? '未绑定' : '待核对';
    if (row.associationConflict) return '待核对';
    if (row.authorizationPending) return '未绑定';
    if (row.authFailed) return '授权失效';
    if (!row.active) return '已停用';
    if (!Number.isFinite(Date.parse(row.expiresAt))) return '待核对';
    return Date.parse(row.expiresAt) <= Date.now() ? '已过期' : '可查询';
  }
  const canRotate = row => Boolean(row?.active && !row.authorizationPending && !row.authFailed && !row.associationConflict);
  const date = value => Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '—';
  function remaining(row) {
    const expiry = Date.parse(row?.expiresAt);
    if (!Number.isFinite(expiry)) return '—';
    if (expiry <= Date.now()) return '已过期';
    return Math.ceil((expiry - Date.now()) / 86_400_000) + ' 天';
  }
  function copyFallback(value, rotated) {
    const title = rotated ? '查询码已更新，复制失败' : '复制失败';
    A.openDrawer(title, '可重试写入剪贴板，或选中内容手动复制。',
      `<textarea data-no-draft class="copy-block" id="mailbox-delivery-copy-text" aria-label="待复制内容" readonly>${E(value)}</textarea>`,
      button('关闭', 'drawer-close') + button('重试复制', 'mailbox-delivery-retry-copy', 'primary', 'copy'), 'mailbox-delivery-copy');
    const drawer = document.getElementById('drawer'), area = document.getElementById('mailbox-delivery-copy-text');
    const clear = event => {
      if (event.type === 'close' && drawer.open && area.isConnected) return;
      area.value = '';
      area.textContent = '';
      drawer.removeEventListener('id-view-deactivate', clear);
      drawer.removeEventListener('close', clear);
    };
    drawer.addEventListener('id-view-deactivate', clear);
    drawer.addEventListener('close', clear);
    area.select();
    A.notify(title, { kind: 'error' });
  }
  async function copy(value, current, rotated = false, message = '内容已复制') {
    if (!value || !current()) return;
    try { await navigator.clipboard.writeText(value); }
    catch { if (current()) copyFallback(value, rotated); return; }
    if (current()) A.notify(message, { kind: 'success' });
  }
  const routeGuard = () => {
    const actor = identity(), route = S.route, session = sessionVersion;
    return () => identity() === actor && S.route === route && sessionVersion === session && enabled();
  };
  function reportBody() {
    const rows = report.results;
    const columns = [{ id: 'email', label: '邮箱账号', render: row => E(row.email || '未识别邮箱') },
      { id: 'status', label: '结果', render: row => tag(resetStatuses[row.status] || '待核对', row.status === 'success' ? 'success' : 'warning') },
      { id: 'expiresAt', label: '到期时间', render: row => E(date(row.expiresAt)) },
      { id: 'reason', label: '说明' }];
    const pageSize = 20, start = (report.page - 1) * pageSize;
    return A.table(columns, rows.slice(start, start + pageSize), '', 'mailbox-delivery-receipts') +
      window.IDPagination.render({ id: 'mailbox-delivery-receipts', page: report.page, pageSize, total: rows.length });
  }
  function showReport(results, replay, error = '') {
    report = { results, replay, page: 1 };
    const totals = Object.keys(resetStatuses).map(state => `${resetStatuses[state]} ${results.filter(row => row.status === state).length} 条`);
    A.openDrawer('查询码重置结果', '查看本次重置结果。待核对时可读取同一操作的结果。',
      `<div class="panel-body"><p role="status">${E(error || totals.join(' · '))}</p><div id="mailbox-delivery-report">${results.length ? reportBody() : ''}</div></div>`,
      button('关闭', 'drawer-close') + (replay ? button('核对本次结果', 'mailbox-delivery-reconcile', 'primary', 'return') : ''), 'mailbox-delivery-report');
    const opened = report, drawer = document.getElementById('drawer');
    drawer.addEventListener('id-view-deactivate', () => { if (report === opened) report = undefined; }, { once: true });
  }

  function reset(scope, mode, ids, count, node, { snapshot = pool, copyQuery = false, done } = {}) {
    if (!enabled() || !count || pending.has(scope)) return;
    const current = routeGuard();
    const inventoryVersion = scope === 'relay' ? A.modules.inventory.inventoryVersion() : snapshot?.inventoryVersion;
    if (!Number.isSafeInteger(inventoryVersion)) { A.notify('正在读取邮箱资料，请稍候重试'); return; }
    const command = { mode, ...(mode !== 'all' && { ids: [...ids] }), inventoryVersion,
      ...(scope !== 'relay' && { version: snapshot.version }) };
    const operationId = crypto.randomUUID();
    let settings;
    const run = async (trigger = node) => {
      if (!current() || pending.has(scope)) return;
      pending.set(scope, operationId);
      try {
        await A.withActionFeedback(trigger?.isConnected ? trigger : null, async () => {
          if (copyQuery && !settings) settings = await data.mailboxDeliverySettings();
          if (!current()) return;
          let result;
          try { result = await data.resetMailboxDelivery(scope, command, operationId); }
          catch (error) {
            if (!current()) return;
            if (!error.status || error.status >= 500) {
              showReport([], run, '本次操作的结果尚未确认，可核对同一操作。');
              return;
            }
            throw error;
          }
          if (!current()) return;
          if (scope !== 'relay') rememberPool(result);
          done?.(result);
          const receipts = result.results || [];
          const value = scope === 'relay' ? result.issued?.queryCode : result.issuedCode;
          const row = receipts[0];
          if (copyQuery && row?.status === 'success' && value) {
            const suffix = scope === 'relay' ? settings.relayQuery : settings.managedQuery;
            await copy(append(`${row.email}----${value}`, suffix), current, true, '新查询码已复制，旧码已失效');
          } else if (copyQuery && row?.status === 'success' && !value) {
            A.notify('本次重置已完成，当前查询码已变化，请核对后交付');
          } else {
            showReport(receipts, receipts.some(row => row.status === 'pending') ? run : null);
          }
        }, { pending: '正在重置查询码…', failure: '查询码重置失败' });
      } finally { if (pending.get(scope) === operationId) pending.delete(scope); }
    };
    if (copyQuery) void run();
    else A.confirmAction('确认重置查询码', `将核对 ${count} 个邮箱。符合条件的邮箱将生成新码，原查询码立即失效。`, () => void run(), '确认重置');
  }

  function batchMenu(node, scope, count, start) {
    A.openActionMenu(node, button(`重置已选（${selected(scope).size}）`, 'mailbox-delivery-batch-select', '', '',
      `data-scope="${scope}" data-mode="selected" ${selected(scope).size ? '' : 'disabled'}`) +
      button(`重置全部（${count}）`, 'mailbox-delivery-batch-select', '', '', `data-scope="${scope}" data-mode="all" ${count ? '' : 'disabled'}`),
    { label: '批量重置查询码', onSelect(choice) {
      const mode = choice.dataset.mode, ids = [...selected(scope)];
      start(mode, ids, mode === 'all' ? count : ids.length, node);
    } });
  }
  async function copyCredentials(asset, node) {
    if (!enabled()) return;
    const current = routeGuard();
    await A.withActionFeedback(node?.isConnected ? node : null, async () => {
      const result = await data.copyGoogleMailboxCredentials({ id: asset.id, version: asset.version });
      const missing = result.missing?.length ? `，缺少${result.missing.join('、')}` : '';
      await copy(result.text, current, false, '谷歌邮箱账密已复制' + missing);
    }, { failure: '谷歌邮箱账密读取失败' });
  }
  async function openSettings(node, validity) {
    if (!enabled()) return;
    const current = routeGuard(), request = ++settingsRequest, drawer = document.getElementById('drawer');
    const context = S.drawerContext;
    await A.withActionFeedback(node, async () => {
      const saved = validity ? await readPool(true) : await data.mailboxDeliverySettings();
      if (!current() || request !== settingsRequest || S.drawerContext !== context) return;
      const id = validity ? validityForm : settingsForm;
      const draft = S.drafts.get(id) || {};
      const fields = validity ? A.field('默认有效期（天）', 'mailbox-delivery-days', A.input('mailbox-delivery-days',
        draft['mailbox-delivery-days'] ?? saved.defaultValidDays, 'type="number" min="1" max="365"'), true,
      '从生成查询码时开始计算，适用于之后生成的新码。') : suffixes.map(([key, label, example]) => {
        const value = draft[key] ?? saved[key];
        return `<div class="mailbox-delivery-suffix">${A.field(label, `mailbox-delivery-${key}`,
          `<textarea id="mailbox-delivery-${key}" name="${key}" maxlength="2000" rows="3" data-example="${E(example)}">${E(value)}</textarea>`)}
          <pre class="mailbox-delivery-preview" aria-label="${label}预览" data-suffix-preview="${key}">${E(append(example, value))}</pre></div>`;
      }).join('');
      A.openDrawer(validity ? '查询码设置' : '复制后缀设置', validity
        ? '隐藏邮箱固定 30 天。普通邮箱可设置 1 至 365 天。' : '设置随当前登录账号保存。后缀从第二行开始添加。',
      `<form id="${id}" novalidate data-version="${saved.version}">${fields}</form>`,
      button('取消', 'drawer-close') + `<button class="button primary" type="submit" form="${id}">保存设置</button>`, id);
      const form = drawer.querySelector('#' + id);
      form.addEventListener('input', event => {
        S.drafts.set(id, A.readForm(form));
        const preview = form.querySelector(`[data-suffix-preview="${event.target.name}"]`);
        if (preview) preview.textContent = append(event.target.dataset.example, event.target.value);
      });
    }, { failure: '设置读取失败' });
  }

  A.modules.mailboxDelivery = { enabled, selected, reset, batchMenu, copyCredentials, readPool, rememberPool, connection, canRotate, date, remaining,
    currentPool: () => pool, google: email => byEmail.get(String(email || '').trim().toLowerCase()) };
  window.IDDesignModules.push({
    id: 'mailbox-delivery-actions', matches: () => false,
    clearPageState() { pool = undefined; byEmail = new Map(); report = undefined; settingsRequest++; sessionVersion++; pending.clear(); },
    onClick(action, node) {
      if (action === 'mailbox-delivery-settings' || action === 'mailbox-delivery-validity') {
        void openSettings(node, action === 'mailbox-delivery-validity'); return true;
      }
      if (action === 'mailbox-delivery-reconcile') { if (report?.replay) void report.replay(node); return true; }
      if (action === 'mailbox-delivery-retry-copy') {
        const area = document.getElementById('mailbox-delivery-copy-text');
        if (area) void A.withActionFeedback(node, async () => {
          await navigator.clipboard.writeText(area.value);
          if (area.isConnected) A.closeDrawer();
          A.notify('内容已复制');
        }, { failure: '复制失败，请选中内容手动复制' });
        return true;
      }
      return false;
    },
    onSubmit(form) {
      const validity = form.id === validityForm;
      if ((!validity && form.id !== settingsForm) || !enabled()) return false;
      const values = A.readForm(form), node = document.querySelector(`[form="${form.id}"]`);
      const version = Number(form.dataset.version);
      const days = Number(values['mailbox-delivery-days']);
      if (validity && (!Number.isSafeInteger(days) || days < 1 || days > 365)) {
        A.setError('mailbox-delivery-days', '请填写 1 至 365 天', form);
        return true;
      }
      void A.withActionFeedback(node, async () => {
        if (validity) rememberPool(await data.saveManagedMailboxPool({ action: 'settings', version, validDays: days }));
        else await data.saveMailboxDeliverySettings({ ...values, version });
        if (form.isConnected && JSON.stringify(A.readForm(form)) === JSON.stringify(values)) {
          S.drafts.delete(form.id);
          S.drawerContext = '';
          A.closeDrawer();
        }
        A.notify('设置已保存');
      }, { failure: '设置保存失败' });
      return true;
    }
  });
  document.addEventListener('id-pagination-change', ({ detail }) => {
    if (!report || detail.id !== 'mailbox-delivery-receipts') return;
    const region = document.getElementById('mailbox-delivery-report');
    if (region) { report.page = detail.page; region.innerHTML = reportBody(); }
  });
})();
