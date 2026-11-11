/* Apple relay registration. Mail synchronization and queries require a connection. */
(() => {
  'use strict';
  const A = window.IDDesignAPI;
  const E = A.esc;
  const mailboxes = A.collections.mailboxes;
  const local = Boolean(window.IDLocalData);
  const now = () =>
    local
      ? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
      : A.nowText();
  const uid = (kind) => (local ? `${kind}-${crypto.randomUUID()}` : A.newId(kind));
  const actor = () =>
    local
      ? window.IDLocalData?.actor?.() || { id: 'local-operator', name: '本机操作员' }
      : { id: A.state.actor?.id || '', name: A.state.actor?.name || '' };
  const connectionPending = '收件服务待接入';
  let parents = local
    ? []
    : [
        {
          id: 'parent-demo-1',
          email: 'main.a@example.test',
          note: '虚构 Apple 主邮箱 A',
          status: 'ACTIVE',
          hasCredential: true,
          days: 30,
          queryCode: 'DEMO-MAIN-A',
          queryExpiry: '2026-12-03 10:30',
          version: 1
        },
        {
          id: 'parent-demo-2',
          email: 'main.b@example.test',
          note: '虚构 Apple 主邮箱 B',
          status: 'ACTIVE',
          hasCredential: true,
          days: 30,
          queryCode: 'DEMO-MAIN-B',
          queryExpiry: '2026-12-03 10:30',
          version: 1
        }
      ];
  let imports = [],
    events = [];
  const mails = [];
  const remote = {
    status: null,
    statusLoading: false,
    statusError: '',
    parents: new Map(),
    pending: new Set(),
    mailKey: '',
    mailRequest: 0,
    mailLoading: false,
    mailError: '',
    queryRequest: 0,
    querying: false
  };
  const view = {
    tab: 'aliases',
    q: '',
    parentId: '',
    aliasId: '',
    inventory: '',
    health: '',
    assignment: '',
    query: '',
    result: null
  };
  let context = null,
    reconciliation = null,
    preview = null,
    seeded = false,
    fileReadVersion = 0;
  const statuses = [
    ['ACTIVE', '正常'],
    ['DISABLED', '已禁用']
  ];
  const healthOptions = [
    ['normal', '正常'],
    ['dead', '死号'],
    ['unlocking', '解封中']
  ];
  const useOptions = [
    ['available', '库存'],
    ['claimed', '已提取'],
    ['used', '已使用']
  ];
  const beijingTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function timestamp(text) {
    const value = String(text || '').trim().replace(' ', 'T');
    const source = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)
      ? value + '+08:00' : value;
    return Date.parse(source);
  }
  function timeText(value, fallback = '—') {
    const time = timestamp(value);
    return Number.isFinite(time) ? beijingTime.format(new Date(time)) : fallback;
  }
  function expiry(days) {
    const date = new Date(timestamp(now()) + Number(days) * 86400000);
    return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
  }
  function aliases() {
    return mailboxes.filter((row) => row.type === 'relay' && !row.relayDeleted);
  }
  function parent(id) {
    return parents.find((row) => row.id === id && !row.deleted);
  }
  function alias(id) {
    return aliases().find((row) => row.id === id);
  }
  function parentEmail(id) {
    return parents.find((row) => row.id === id)?.email || '主邮箱待核对';
  }
  function displayId(kind, value) {
    const row = typeof value === 'string'
      ? kind === 'parent'
        ? parent(value) || (local && A.modules.inventory.getAppleRelayState().parents
          .find((item) => item.id === value))
        : alias(value)
      : value;
    const id = row?.id || value;
    const number = String(
      row?.[kind === 'parent' ? 'remotePrimaryId' : 'remoteAliasId'] ||
      remote.status?.numbers?.[kind]?.[id] ||
      (!local && /^(?:parent|alias)-demo-(\d+)$/.exec(row?.aliasId || id)?.[1]) || ''
    );
    return /^\d+$/.test(number) && BigInt(number) > 0n
      ? (kind === 'parent' ? 'm' : 'y') + BigInt(number).toString().padStart(6, '0')
      : '待接入';
  }
  function displayImportId(value) {
    const id = String(value || '');
    return id.length > 11 ? id.replaceAll('-', '').slice(-11) : id;
  }
  function sourceBatchLabel(row) {
    return row.importId ? displayImportId(row.importId) : row.createdById ? '单条登记' : '历史未记录';
  }
  function initialize() {
    if (local) {
      const metadata = A.modules.inventory.getAppleRelayState();
      ({ parents, imports, events } = metadata);
      return;
    }
    for (const row of mailboxes.filter((item) => item.type === 'relay')) {
      const match = /^mail-(27|28|29|30|31|32)$/.exec(row.id);
      if (match) {
        const index = Number(match[1]) - 27;
        row.parentMailboxId ||= `parent-demo-${(index % 2) + 1}`;
        row.aliasId ||= `alias-demo-${index + 1}`;
        row.queryCode ||= `DEMO-QUERY-${index + 1}`;
        row.queryExpiry ||= '2026-12-03 10:30';
      }
      row.relayStatus ||= 'ACTIVE';
      row.codeResetIntervalDays ||= 30;
      row.inventoryHistory ||= [];
      row.usageLinks ||= [];
      row.version ||= 1;
      row.inventoryState ||= row.used ? 'used' : 'available';
      row.health ||= 'normal';
    }
    if (seeded) return;
    seeded = true;
    for (const p of parents) {
      const child = aliases().find((row) => row.parentMailboxId === p.id);
      if (child)
        mails.push({
          id: `mail-relay-${p.id}`,
          parentId: p.id,
          aliasId: child.id,
          from: '演示验证服务',
          subject: '虚构验证码邮件',
          code: p.id === 'parent-demo-1' ? '123456' : '654321',
          body: '这是离线页面演示邮件，不代表真实收信。验证码仅用于检查页面。',
          receivedAt: '2026-11-03 10:00',
          read: false
        });
      mails.push({
        id: `unassigned-${p.id}`,
        parentId: p.id,
        aliasId: '',
        from: '演示通知服务',
        subject: '待分配的演示邮件',
        recipientAddress: child?.email || '',
        code: '',
        body: '收件归属尚待人工核对，不能自动猜测其他主邮箱下的隐藏地址。',
        receivedAt: '2026-11-03 09:30',
        read: false
      });
    }
  }
  function isAvailable(row) {
    if (local) return false;
    initialize();
    const owner = parent(row?.parentMailboxId);
    return Boolean(
      row &&
      !row.relayDeleted &&
      row.relayStatus !== 'DISABLED' &&
      owner?.status === 'ACTIVE' &&
      owner.hasCredential &&
      row.queryCode &&
      Number.isFinite(timestamp(row.queryExpiry)) &&
      timestamp(row.queryExpiry) > timestamp(now())
    );
  }

  function audit(kind, row, note = '', { updateDetails = true } = {}) {
    const who = actor();
    const at = now();
    events.unshift({
      id: uid('relay-event'),
      kind,
      entityId: row.id,
      at,
      actorId: who.id,
      actor: who.name || '历史未记录',
      note
    });
    row.version = (row.version || 1) + 1;
    if (updateDetails) {
      row.updatedAt = at;
      row.updatedById = who.id;
      row.updatedBy = who.name;
    }
    if (row.type === 'relay') {
      row.lastOperatedAt = at;
      row.lastOperatedById = who.id;
      row.lastOperatedBy = who.name;
      (row.inventoryHistory ||= []).push({
        id: uid('relay-asset-event'),
        action: kind,
        detail: note,
        actorId: who.id,
        actor: who.name,
        time: at
      });
    }
  }
  function status(row) {
    if (row.relayStatus === 'DISABLED' || row.status === 'DISABLED') return '已禁用';
    if (row.status === 'AUTH_ERROR') return '授权异常';
    if (row.status === 'SYNCING') return '同步中';
    if (['ACTIVE', '正常', '冻结', '封控中'].includes(row.status) || row.relayStatus === 'ACTIVE')
      return '正常';
    return '待核对';
  }
  function usedLabel(row) {
    const review = A.modules.inventory?.usageReviewFor?.(row.id);
    if (review?.status === 'review') return '待核对';
    if (review?.status === 'used' && row.inventoryState !== 'used') return '检测到已使用';
    return (
      { available: '未使用', claimed: '已提取待使用', used: '已实际使用' }[row.inventoryState] ||
      '待核对'
    );
  }
  function healthLabel(row) {
    return (
      healthOptions.find(([key]) => key !== 'normal' && key === row.health)?.[1] ||
      row.status ||
      '正常'
    );
  }
  function registrationLabel(row) {
    if (A.modules.inventory?.mailboxRegistrationAccount?.(row)) return '已登记注册';
    const records = A.modules.inventory?.registrationRecordsFor?.(row.id) || [];
    const latest = records.find(record => record.state === '成功') ||
      [...records].sort((a, b) => timestamp(b.time) - timestamp(a.time))[0];
    if (latest)
      return (
        {
          成功: '已登记注册',
          待核对: '注册结果待核对',
          失败: '登记注册失败',
          失败且未使用: '登记注册失败，未使用'
        }[latest.state] || '注册结果待核对'
      );
    return row.usageLinks?.some((link) => link.kind === 'registration' || (link.kind === 'manual-use' && link.product))
      ? '已登记注册'
      : '未登记注册结果';
  }
  function platformLabel(row) {
    return A.modules.inventory?.mailboxPlatformLabel?.(row) || '平台未登记';
  }
  function registrationAccountCell(row) {
    return A.modules.inventory?.mailboxRegistrationAccountCell?.(row) || '—';
  }
  function unknown(value) {
    return value || '历史未记录';
  }
  function prop(label, value) {
    return `<div class="property-row"><span>${E(label)}</span><strong>${E(value || '—')}</strong></div>`;
  }
  function trace(row) {
    return (
      prop('录入人', unknown(row.createdBy)) +
      A.operatorIdProperty('录入人编号', row.createdById) +
      prop('录入时间', timeText(row.createdAt, '历史未记录')) +
      prop('最近操作人', unknown(row.lastOperatedBy || row.updatedBy)) +
      A.operatorIdProperty('最近操作人编号', row.lastOperatedById || row.updatedById) +
      prop('最近操作时间', timeText(row.lastOperatedAt || row.updatedAt, '历史未记录'))
    );
  }
  function code(kind) {
    return local ? '' : `DEMO-${kind}-${uid('query')}`;
  }
  function duplicateAlias(email, exceptId = '') {
    return aliases().some(
      (row) => row.id !== exceptId && row.email.toLowerCase() === email.toLowerCase()
    );
  }
  function lastMailTime(aliasId) {
    return timeText(
      mails
        .filter((mail) => mail.aliasId === aliasId)
        .sort((a, b) => timestamp(b.receivedAt) - timestamp(a.receivedAt))[0]?.receivedAt
    );
  }
  function list(columns, rows, id, emptyState) {
    return A.table(columns, A.pageRows(rows), '', id, emptyState) + A.pagination(rows.length);
  }
  function columnButton(id) {
    return A.button('列设置', 'column-settings', '', 'columns', `data-table-id="${id}"`);
  }
  function field(label, name, control, required = false, help = '') {
    return A.field(label, `relay-${name}`, control, required, help);
  }
  function input(name, value = '', extra = '') {
    return A.input(`relay-${name}`, value, extra);
  }
  function select(name, choices, value = '') {
    return A.select(`relay-${name}`, choices, value);
  }
  function parentChoices(current = '') {
    return [
      ['', '请选择 Apple 主邮箱'],
      ...parents
        .filter((p) => !p.deleted && (p.status === 'ACTIVE' || p.id === current))
        .map((p) => [p.id, `${p.email} · ${displayId('parent', p)}${p.status === 'DISABLED' ? '（已禁用）' : ''}`])
    ];
  }
  function matchedParentChoice(text, current = '') {
    const query = String(text || '').trim().toLowerCase();
    return parentChoices(current).find(([id, label]) => id && (
      label.toLowerCase() === query || parent(id)?.email?.toLowerCase() === query ||
      (/^m\d{6,}$/.test(query) && displayId('parent', id).toLowerCase() === query)
    ));
  }
  function parentPicker(selected = '', text, locked = false) {
    const choices = parentChoices(selected).filter(([id]) => id);
    if (!selected && text === undefined && choices.length === 1) selected = choices[0][0];
    const value = text ?? choices.find(([id]) => id === selected)?.[1] ?? '';
    const id = locked ? selected : matchedParentChoice(value, selected)?.[0] || '';
    return field(
      '所属主邮箱', 'parent-choice',
      `<div class="option-entry-controls">${input('parent-choice', value,
        `autocomplete="off" spellcheck="false" placeholder="输入主邮箱或编号搜索并选择" ${locked ? 'readonly' : 'list="relay-parent-options"'}`)}${locked ? '' : A.button('刷新', 'relay-parent-options-refresh', '', 'return')}</div>` +
        `<input type="hidden" id="relay-parentId" name="relay-parentId" value="${E(id)}"${locked ? ' disabled' : ''} />` +
        (locked ? '' : `<datalist id="relay-parent-options">${choices.map(([, label]) => `<option value="${E(label)}"></option>`).join('')}</datalist>`) +
        (choices.length ? '' : '<p class="field-error" role="status">暂无可用主邮箱，请联系管理员配置后刷新；已填写内容会保留。</p>'),
      true, locked ? '已绑定的主邮箱不可更换。' : '搜索并选择实际开通该隐藏地址的 Apple 主邮箱。'
    );
  }
  function updateParentChoice(node, normalize = false) {
    const control = document.getElementById('relay-parentId');
    if (!control || control.disabled) return;
    const choice = matchedParentChoice(node.value, control.value);
    control.value = choice?.[0] || '';
    if (normalize && choice) node.value = choice[1];
    A.setError('relay-parent-choice', '');
    if (context?.kind === 'import') {
      preview = null;
      const output = document.getElementById('relay-import-preview');
      if (output) output.innerHTML = '';
    }
    preserveDraft();
  }
  function traceColumns() {
    return [
      { id: 'createdBy', label: '录入人', render: (r) => E(unknown(r.createdBy)) },
      { id: 'createdAt', label: '录入时间', render: (r) => E(timeText(r.createdAt, '历史未记录')) },
      {
        id: 'updatedBy',
        label: '最近操作人',
        render: (r) => E(unknown(r.lastOperatedBy || r.updatedBy))
      },
      {
        id: 'updatedAt',
        label: '最近操作时间',
        render: (r) => E(timeText(r.lastOperatedAt || r.updatedAt, '历史未记录'))
      }
    ];
  }
  function toolbar(actions, id, filters = '', statusGroups = '') {
    const placeholder = statusGroups ? '搜索邮箱、编号或备注' : '搜索邮箱、编号、备注或录入人';
    const controls = `<div class="toolbar-left"><div class="search-field">${A.icon('search')}<input id="relay-search" aria-label="搜索苹果邮箱资料" value="${E(view.q)}" placeholder="${placeholder}" /></div>${filters}</div><div class="toolbar-right">${columnButton(id)}${actions}</div>`;
    return statusGroups
      ? `<div class="toolbar relay-alias-toolbar"><div class="relay-alias-filters">${statusGroups}</div><div class="relay-alias-controls">${controls}</div></div>`
      : `<div class="toolbar">${controls}</div>`;
  }
  function renderRelayPage() {
    if (A.state.route === 'mailboxes/relay') A.render();
  }
  async function readConnection() {
    if (!local || remote.statusLoading || !window.IDLocalData.relay) return;
    remote.statusLoading = true;
    remote.statusError = '';
    try {
      remote.status = await window.IDLocalData.relay('status');
      return true;
    } catch (error) {
      remote.statusError = error.message || '无法读取收件服务状态';
      return false;
    } finally {
      remote.statusLoading = false;
      renderRelayPage();
    }
  }
  function connectionNotice(title, text) {
    return (
      A.empty(remote.statusError ? '读取收件服务状态失败' : title, remote.statusError || text) +
      (remote.statusError ? `<div class="toolbar">${A.button('重新读取', 'relay-service-retry', '', 'refresh')}</div>` : '')
    );
  }
  const bound = (id) => remote.status?.configured && remote.status.parentIds?.includes(id);
  const codeTargetBound = (kind, id) =>
    kind === 'parent'
      ? bound(id)
      : remote.status?.configured && remote.status.aliasIds?.includes(id);
  const buyerCodeCells = new WeakMap();
  const buyerCodeReuseMs = 5 * 60_000;
  function buyerCodeSnapshot(row) {
    return JSON.stringify([row.id, row.version, row.email, row.parentMailboxId,
      parent(row.parentMailboxId)?.version, row.queryExpiry]);
  }
  function buyerCodeCell(row) {
    const connected = !local || codeTargetBound('alias', row.id);
    const text = !local ? row.queryCode || '暂无查询码'
      : !remote.status ? remote.statusError ? '收件服务读取失败' : '正在检测收件服务…'
        : connected ? '正在读取…' : '未接入收件服务';
    return `<div class="relay-buyer-code" data-relay-buyer-code="${E(row.id)}"><output aria-label="买家查询码">${E(text)}</output>${A.button('复制', 'relay-buyer-code-copy', 'compact', 'copy', `data-id="${E(row.id)}" aria-label="复制买家查询码" ${local || !row.queryCode ? 'disabled' : ''}`)}${local && connected ? A.button('重试', 'relay-buyer-code-retry', 'compact', '', `data-id="${E(row.id)}" hidden`) : ''}</div>`;
  }
  function currentBuyerCodeCell(cell, operatorId, snapshot) {
    const row = alias(cell.dataset.relayBuyerCode);
    return cell.isConnected && A.state.route === 'mailboxes/relay' && view.tab === 'aliases' &&
      actor().id === operatorId && row && buyerCodeSnapshot(row) === snapshot;
  }
  function showBuyerCode(cell, state) {
    buyerCodeCells.set(cell, state);
    cell.querySelector('output').textContent = state.value;
    cell.querySelector('[data-action="relay-buyer-code-copy"]').disabled = false;
    cell.querySelector('[data-action="relay-buyer-code-retry"]')?.setAttribute('hidden', '');
    cell.setAttribute('aria-busy', 'false');
  }
  function reuseBuyerCode(cell, row) {
    const operatorId = actor().id, snapshot = buyerCodeSnapshot(row);
    const cached = window.IDLocalData.queries?.peek('apple-relay', [operatorId, 'buyer-code', snapshot]);
    if (cached?.stale !== false || !(cached.data?.reuseUntil > Date.now())) return false;
    showBuyerCode(cell, { operatorId, snapshot, value: cached.data.queryCode });
    return true;
  }
  async function loadBuyerCode(cell, { refresh = false, result, read } = {}) {
    const id = cell.dataset.relayBuyerCode, row = alias(id);
    if (!local || !row || !codeTargetBound('alias', id) || !cell.isConnected) return;
    const previous = buyerCodeCells.get(cell);
    if (previous?.pending && !refresh) return previous.pending;
    if (!refresh && reuseBuyerCode(cell, row)) return;
    const operatorId = actor().id;
    const snapshot = buyerCodeSnapshot(row);
    const state = { value: '', pending: null, operatorId, snapshot };
    buyerCodeCells.set(cell, state);
    const current = () => buyerCodeCells.get(cell) === state &&
      currentBuyerCodeCell(cell, operatorId, snapshot);
    const output = cell.querySelector('output');
    const copy = cell.querySelector('[data-action="relay-buyer-code-copy"]');
    const retry = cell.querySelector('[data-action="relay-buyer-code-retry"]');
    cell.setAttribute('aria-busy', 'true');
    output.textContent = '正在读取…';
    copy.disabled = true;
    if (retry) retry.hidden = true;
    const loader = async () => {
      const value = result || await (read ? read(id)
        : window.IDLocalData.relay('code-read', { kind: 'alias', id }));
      if (typeof value?.queryCode !== 'string' || !value.queryCode ||
          String(value.email).toLowerCase() !== row.email.toLowerCase())
        throw new Error('查询码资料不匹配，请重试');
      const loadedAt = Date.now();
      const codeExpiry = timestamp(value.codeExpiresAt);
      const reuseUntil = codeExpiry > loadedAt
        ? Math.min(loadedAt + buyerCodeReuseMs, codeExpiry) : loadedAt + buyerCodeReuseMs;
      return { queryCode: value.queryCode, reuseUntil };
    };
    state.pending = (async () => {
      try {
        const queries = window.IDLocalData.queries;
        const value = queries
          ? await queries.read('apple-relay', [operatorId, 'buyer-code', snapshot], loader, {
              refresh: true, isFresh: () => actor().id === operatorId
            })
          : await loader();
        if (!current()) return;
        state.value = value.queryCode;
        showBuyerCode(cell, state);
      } catch (error) {
        if (!current()) return;
        output.textContent = error.status === 404 ? '暂无查询码' : '读取失败';
        if (retry) retry.hidden = false;
      } finally {
        if (current()) cell.setAttribute('aria-busy', 'false');
        state.pending = null;
      }
    })();
    return state.pending;
  }
  function hydrateBuyerCodes({ id, result, refresh = false } = {}) {
    if (!local || A.state.route !== 'mailboxes/relay' || view.tab !== 'aliases') return;
    const cells = [];
    for (const cell of document.querySelectorAll('#main [data-relay-buyer-code]')) {
      const rowId = cell.dataset.relayBuyerCode;
      if ((id && rowId !== id) || cell.closest('[hidden]') || !codeTargetBound('alias', rowId)) continue;
      const row = alias(rowId);
      if (row && (refresh || !reuseBuyerCode(cell, row))) cells.push(cell);
    }
    const requested = [];
    let batch;
    const read = rowId => {
      requested.push(rowId);
      // Per-row cache reads still deduplicate and reject stale responses. Only their
      // actual cache misses enter this page request in the same microtask turn.
      batch ||= Promise.resolve().then(() =>
        window.IDLocalData.relay('code-read', { kind: 'alias', ids: requested })
      ).then(response => {
        if (!Array.isArray(response?.items) || response.items.length !== requested.length)
          throw new Error('查询码返回格式无效，请重试');
        const items = new Map(response.items.map(item => [item?.id, item]));
        if (items.size !== requested.length || requested.some(id => !items.has(id)))
          throw new Error('查询码资料不匹配，请重试');
        return items;
      });
      return batch.then(items => {
        const item = items.get(rowId);
        if (item.error) throw Object.assign(new Error(item.error), { status: item.status });
        return item;
      });
    };
    for (const cell of cells) void loadBuyerCode(cell, { refresh, result, read });
  }
  async function copyBuyerCode(node) {
    const cell = node.closest('[data-relay-buyer-code]');
    const state = buyerCodeCells.get(cell);
    const value = local ? state?.value : alias(node.dataset.id)?.queryCode;
    if (!cell?.isConnected || node.disabled || !value) return;
    if (local && !currentBuyerCodeCell(cell, state.operatorId, state.snapshot)) return;
    await A.copyText(value, '买家查询码已复制');
  }
  function localConnection(id) {
    return remote.parents.get(id)?.message || parent(id)?.connection ||
      (bound(id) ? '已绑定，等待测试' : '未绑定收件服务');
  }
  function renderParents() {
    const rows = parents.filter(
      (p) =>
        !p.deleted &&
        `${p.email} ${p.id} ${displayId('parent', p)} ${p.note} ${p.createdBy || ''}`
          .toLowerCase()
          .includes(view.q.toLowerCase())
    );
    return (
      toolbar(
        (local && remote.status?.configured
          ? A.button('导入已有主邮箱', 'relay-primary-import', '', '', remote.importing ? 'disabled' : '')
          : '') + A.button('新增主邮箱', 'relay-parent-add', 'primary', 'plus'),
        'relay-parents'
      ) +
      (local && !remote.statusLoading && (!remote.status?.configured || remote.statusError)
        ? `<p class="inline-notice warning" role="status">${E(remote.statusError ||
          '原收件服务未连接，连接后可导入已有主邮箱及授权。')}</p>`
        : '') +
      list(
        [
          { id: 'id', label: '主邮箱编号', class: 'mono', render: (r) => E(displayId('parent', r)) },
          { id: 'email', label: 'Apple 主邮箱' },
          { id: 'status', label: '账号状态', render: (r) => E(status(r)) },
          {
            id: 'hasCredential',
            label: '收信凭据',
            render: (r) =>
              E(
                local
                  ? r.remotePrimaryId || bound(r.id)
                    ? '由收件服务管理'
                    : '未配置'
                  : r.hasCredential
                    ? '已配置（演示）'
                    : '未配置'
              )
          },
          {
            id: 'connection',
            label: '连接情况',
            render: (r) => E(local ? localConnection(r.id) : r.connection || '尚未测试（演示）')
          },
          {
            id: 'children',
            label: '隐藏邮箱数量',
            render: (r) => String(aliases().filter((a) => a.parentMailboxId === r.id).length)
          },
          { id: 'queryCode', label: '主查询码', long: true },
          { id: 'queryExpiry', label: '查询码到期', render: (r) => E(timeText(r.queryExpiry)) },
          { id: 'days', label: '有效天数' },
          {
            id: 'lastSyncedAt',
            label: '最近同步时间',
            render: (r) =>
              E(timeText((local && remote.parents.get(r.id)?.syncedAt) || r.lastSyncedAt))
          },
          {
            id: 'lastSyncError',
            label: '同步情况',
            long: true,
            render: (r) =>
              E((local ? remote.parents.get(r.id)?.syncMessage : r.lastSyncError) || '尚未同步')
          },
          { id: 'note', label: '备注', long: true },
          ...traceColumns(),
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (r) =>
              `<div class="action-links">${A.textAction('详情', 'relay-parent-detail', `data-id="${E(r.id)}"`)}${A.textAction('登记隐藏邮箱', 'relay-alias-add', `data-parent-id="${E(r.id)}"`)}${A.textAction('更多操作', 'relay-parent-more', `data-id="${E(r.id)}" aria-haspopup="menu" aria-expanded="false"`, '', 'down')}</div>`
          }
        ],
        rows,
        'relay-parents'
      )
    );
  }
  function renderAliases() {
    const allAliases = aliases();
    const query = view.q.toLowerCase();
    const matching = allAliases.filter(
      (r) =>
        (!view.parentId || r.parentMailboxId === view.parentId) &&
        (!query || `${r.email} ${r.id} ${displayId('alias', r)} ${r.parentMailboxId || ''} ${displayId('parent', r.parentMailboxId)} ${parentEmail(r.parentMailboxId)} ${r.notes || ''} ${r.createdBy || ''} ${r.importId || ''} ${displayImportId(r.importId)} ${platformLabel(r)} ${A.modules.inventory?.mailboxRegistrationAccount?.(r)?.id || ''}`
          .toLowerCase().includes(query))
    );
    const matchesUse = (row) =>
      !view.inventory || (row.inventoryState || 'available') === view.inventory;
    const matchesHealth = (row) => !view.health || (row.health || 'normal') === view.health;
    const rows = matching.filter((row) => matchesUse(row) && matchesHealth(row));
    const filters = `<select id="relay-filter-parent" aria-label="筛选所属主邮箱">${A.options([['', '全部主邮箱'], ...parents.filter((p) => !p.deleted).map((p) => [p.id, p.email])], view.parentId)}</select>`;
    const usage = statusButtons(
      'inventory',
      '使用状态',
      useOptions,
      matching.filter(matchesHealth),
      (row) => row.inventoryState || 'available'
    );
    const health = statusButtons(
      'health',
      '邮箱资料状态',
      healthOptions,
      matching.filter(matchesUse),
      (row) => row.health || 'normal'
    );
    const hasParent = parents.some((p) => !p.deleted && p.status === 'ACTIVE');
    const actions = hasParent
      ? A.button('批量导入', 'relay-import', '', 'upload') +
        (local && remote.status?.configured && ['admin', 'super'].includes(actor().role)
          ? A.button('历史入库', 'relay-intake', '', 'upload') : '') +
        A.button('登记隐藏邮箱', 'relay-alias-add', 'primary', 'plus')
      : A.button('新增主邮箱', 'relay-parent-add', 'primary', 'plus');
    const hasDetailFilter = view.q || view.parentId || view.health;
    const emptyState = !hasParent && !allAliases.length
      ? { title: '请先添加 Apple 主邮箱', description: '添加后即可登记或批量导入该主邮箱下已开通的隐藏邮箱。' }
      : view.inventory === 'claimed' && !hasDetailFilter
        ? { title: '暂无已提取的隐藏邮箱', description: '从工作台的「邮箱提取」领取后，待使用的记录会显示在这里。' }
        : !allAliases.length && !hasDetailFilter && !view.inventory
          ? { title: '暂无隐藏邮箱', description: '可在上方登记或批量导入已开通的隐藏邮箱。' }
          : undefined;
    const history = view.inventory === 'claimed'
      ? A.button('查看提取与归还', 'relay-extraction-history', '', 'work')
      : '';
    return (
      toolbar((A.modules.inventory?.usageReviewButton?.() || '') + history + actions,
        'relay-aliases', filters, usage + health) +
      list(
        [
          { id: 'aliasId', label: '隐藏邮箱编号', class: 'mono', render: (r) => E(displayId('alias', r)) },
          { id: 'parentMailboxId', label: '主邮箱编号', class: 'mono', render: (r) => E(displayId('parent', r.parentMailboxId)) },
          { id: 'email', label: '隐藏邮箱地址' },
          {
            id: 'parent',
            label: '所属 Apple 主邮箱',
            render: (r) => E(parentEmail(r.parentMailboxId))
          },
          { id: 'relayStatus', label: '邮箱启用状态', render: (r) => E(status(r)) },
          { id: 'inventoryState', label: '邮箱使用状态', render: (r) => E(usedLabel(r)) },
          { id: 'registrationPlatform', label: '注册平台', render: (r) => E(platformLabel(r)) },
          { id: 'registrationAccount', label: '关联账号', render: registrationAccountCell },
          { id: 'queryCode', label: '买家查询码', class: 'relay-buyer-code-column', render: buyerCodeCell },
          { id: 'queryExpiry', label: '查询码到期', render: (r) => E(timeText(r.queryExpiry)) },
          { id: 'lastQueriedAt', label: '最近查询时间', render: (r) => E(timeText(r.lastQueriedAt)) },
          { id: 'codeResetIntervalDays', label: '有效天数' },
          {
            id: 'mailCount',
            label: '邮件数量',
            render: (r) => String(mails.filter((m) => m.aliasId === r.id).length)
          },
          { id: 'notes', label: '备注', long: true },
          { id: 'lastMailReceivedAt', label: '最近收件时间', render: (r) => E(lastMailTime(r.id)) },
          {
            id: 'importId',
            label: '来源导入批次',
            render: (r) => E(sourceBatchLabel(r)),
            long: true
          },
          ...traceColumns(),
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (r) =>
              `<div class="action-links">${A.textAction('详情', 'relay-alias-detail', `data-id="${E(r.id)}"`)}${A.textAction('查看邮件', 'relay-mails', `data-id="${E(r.id)}"`)}${A.textAction('更多操作', 'relay-alias-more', `data-id="${E(r.id)}" aria-haspopup="menu" aria-expanded="false"`, '', 'down')}</div>`
          }
        ],
        rows,
        'relay-aliases',
        emptyState
      )
    );
  }
  function statusButtons(key, label, options, rows, valueOf) {
    const buttons = [['', '全部'], ...options].map(([value, text]) => {
      const count = value ? rows.filter((row) => valueOf(row) === value).length : rows.length;
      return A.button(
        `${text} ${count}`,
        'relay-inventory-status',
        view[key] === value ? 'primary' : '',
        '',
        `data-filter="${key}" data-value="${value}" aria-pressed="${view[key] === value}"`
      );
    });
    return `<div class="relay-status-group" role="group" aria-label="${label}"><span class="footnote">${label}</span>${buttons.join('')}</div>`;
  }
  function renderMails() {
    if (local && !remote.status?.configured)
      return connectionNotice(connectionPending, '绑定主邮箱后可同步并查看对应收件记录。');
    const rows = mails.filter(
      (r) =>
        (!view.parentId || r.parentId === view.parentId) &&
        (!view.aliasId || r.aliasId === view.aliasId) &&
        (!view.assignment ||
          (view.assignment === 'unassigned' ? !r.aliasId : Boolean(r.aliasId))) &&
        `${r.subject} ${r.from} ${r.code} ${alias(r.aliasId)?.email || ''} ${parentEmail(r.parentId)}`.includes(
          view.q
        )
    );
    return (
      toolbar(
        A.button(
          '同步并刷新邮件',
          'relay-mail-refresh',
          '',
          'refresh',
          local && remote.mailLoading ? 'disabled' : ''
        ),
        'relay-mails',
        `<select id="relay-filter-parent" aria-label="筛选所属主邮箱">${A.options([['', '全部主邮箱'], ...parents.filter((p) => !p.deleted).map((p) => [p.id, p.email])], view.parentId)}</select><select id="relay-filter-alias" aria-label="筛选隐藏邮箱">${A.options(
          [
            ['', '全部隐藏邮箱'],
            ...aliases()
              .filter((a) => !view.parentId || a.parentMailboxId === view.parentId)
              .map((a) => [a.id, a.email])
          ],
          view.aliasId
        )}</select><select id="relay-filter-assignment" aria-label="筛选邮件归属">${A.options(
          [
            ['', '全部归属'],
            ['unassigned', '未分配邮件'],
            ['assigned', '已匹配邮件']
          ],
          view.assignment
        )}</select>`
      ) +
      (local && (remote.mailLoading || remote.mailError)
        ? `<div class="inline-notice ${remote.mailError ? 'warning' : ''}" role="status">${E(remote.mailError || '正在读取收件记录…')}</div>`
        : '') +
      list(
        [
          { id: 'parentId', label: '主邮箱编号', render: (r) => E(displayId('parent', r.parentId)) },
          { id: 'parent', label: '主邮箱', render: (r) => E(parentEmail(r.parentId)) },
          {
            id: 'recipient',
            label: '隐藏邮箱',
            render: (r) => E(alias(r.aliasId)?.email || '未分配')
          },
          { id: 'from', label: '发件人' },
          { id: 'subject', label: '主题', long: true },
          { id: 'code', label: '验证码' },
          { id: 'receivedAt', label: '收件时间', render: (r) => E(timeText(r.receivedAt)) },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (r) =>
              `<div class="action-links">${A.textAction('查看正文', 'relay-mail-detail', `data-id="${E(r.id)}"`)}${!local || liveAssignmentTargets(r).length ? A.textAction('分配归属', 'relay-mail-reassign', `data-id="${E(r.id)}"`) : ''}</div>`
          }
        ],
        rows,
        'relay-mails'
      )
    );
  }
  function renderQuery() {
    const publicEntry = local
      ? '<div class="toolbar"><div class="toolbar-right"><a class="button" href="/mailbox-query" target="_blank" rel="noopener noreferrer">公开查询页</a></div></div>'
      : '';
    if (local && !remote.status?.configured)
      return (
        publicEntry +
        connectionNotice('查询服务待接入', '绑定收件服务后可按邮箱或已签发的查询码查询。')
      );
    const result = view.result;
    return `<div class="panel-body">${publicEntry}<form id="relay-query-form" novalidate>${field('查询内容', 'query', input('query', view.query, 'autocomplete="off" placeholder="隐藏邮箱、买家查询码或主查询码"'), true)}<div class="form-footer"><span class="footnote">${local ? '查询时同步对应主邮箱。' : '查询时先同步所属主邮箱；仅使用虚构演示资料。'}</span><button type="submit" class="button primary" ${local && remote.querying ? 'disabled' : ''}>${local && remote.querying ? '正在查询…' : '同步并查询'}</button></div></form><div id="relay-query-output">${
      result
        ? `<div class="inline-notice ${result.ok ? '' : 'warning'}" role="status">${E(result.message)}${!result.ok && result.rows ? '（显示上次成功结果）' : ''}</div>${
            result.rows
              ? A.table(
                  [
                    { id: 'subject', label: '邮件主题' },
                    { id: 'code', label: '验证码' },
                    { id: 'receivedAt', label: '收件时间', render: (r) => E(timeText(r.receivedAt)) },
                    {
                      id: 'actions',
                      label: '操作',
                      action: true,
                      render: (r) =>
                        A.textAction('查看正文', 'relay-mail-detail', `data-id="${E(r.id)}"`)
                    }
                  ],
                  result.rows,
                  '',
                  'relay-query-results'
                )
              : ''
          }`
        : ''
    }</div></div>`;
  }
  function renderImports() {
    const hasParent = parents.some((p) => !p.deleted && p.status === 'ACTIVE');
    return (
      `<div class="toolbar"><div class="toolbar-left"><span class="footnote">${hasParent ? '批量登记的结果会保留在这里。' : '先添加主邮箱，再批量导入隐藏邮箱。'}</span></div><div class="toolbar-right">${
        hasParent
          ? A.button('批量导入', 'relay-import', 'primary', 'upload')
          : A.button('新增主邮箱', 'relay-parent-add', 'primary', 'plus')
      }</div></div>` +
      list(
        [
          { id: 'id', label: '导入批次', render: (r) => E(displayImportId(r.id)), long: true },
          { id: 'parentId', label: '主邮箱编号', render: (r) => E(displayId('parent', r.parentId)) },
          { id: 'time', label: '导入时间', render: (r) => E(timeText(r.time)) },
          { id: 'actor', label: '导入人' },
          { id: 'total', label: '总数' },
          { id: 'success', label: '已登记' },
          { id: 'failed', label: '错误行' },
          { id: 'status', label: '结果' },
          {
            id: 'actions',
            label: '操作',
            action: true,
            render: (r) => A.textAction('详情', 'relay-import-detail', `data-id="${E(r.id)}"`)
          }
        ],
        imports,
        'relay-imports'
      )
    );
  }
  function render() {
    initialize();
    const header = A.header(
      '苹果隐藏邮箱',
      '先添加 Apple 主邮箱，再登记该主邮箱在 Apple 已开通的隐藏地址。主邮箱应用专用密码用于收信；同步邮件不会在 Apple 创建隐藏地址。'
    );
    const loadState = local ? A.modules.inventory.getLocalInventoryState() : 'ready';
    if (loadState !== 'ready') {
      const body =
        loadState === 'error'
          ? A.empty('读取邮箱资料失败', '请重试读取本机数据。') +
            `<div class="toolbar">${A.button('重试', 'relay-retry', '', 'refresh')}</div>`
          : '<div class="inline-notice" role="status">正在读取本机邮箱资料…</div>';
      return header + `<section class="panel">${body}</section>`;
    }
    if (local && !remote.status && !remote.statusError) void readConnection();
    const tabs = [
      ['parents', '主邮箱管理'],
      ['aliases', '隐藏邮箱管理'],
      ['mails', '收件记录'],
      ['query', '查询中心'],
      ['imports', '导入记录']
    ];
    const body =
      view.tab === 'parents'
        ? renderParents()
        : view.tab === 'aliases'
          ? renderAliases()
          : view.tab === 'mails'
            ? renderMails()
            : view.tab === 'query'
              ? renderQuery()
              : renderImports();
    return (
      header +
      `<section class="panel"><div class="tabs" role="tablist">${tabs.map(([id, label]) => `<button class="tab ${view.tab === id ? 'active' : ''}" role="tab" aria-selected="${view.tab === id}" data-action="relay-tab" data-tab="${id}">${label}</button>`).join('')}</div>${body}</section>`
    );
  }
  function preserveDraft() {
    for (const form of document.querySelectorAll('#drawer[open] form[data-relay-draft]')) {
      const raw = A.readDraft(form);
      delete raw['relay-appPassword'];
      A.state.drafts.set(form.dataset.relayDraft, raw);
    }
  }
  function openForm(kind, id, title, fields, footer = '') {
    const key = `apple-relay:${kind}:${id || 'new'}`;
    const row =
      kind === 'parent'
        ? parent(id)
        : kind === 'alias'
          ? alias(id)
          : mails.find((r) => r.id === id);
    const savedDraft = A.state.drafts.get(key);
    const next = {
      kind,
      id,
      version:
        savedDraft?.['relay-version'] !== undefined
          ? Number(savedDraft['relay-version'])
          : row?.version || 1,
      key,
      token: uid('relay-context')
    };
    const gridClass = kind === 'alias' && !id
      ? 'commerce-field-grid commerce-field-grid--single'
      : 'commerce-field-grid';
    const html = `<form id="relay-${kind}-form" data-relay-draft="${E(key)}" novalidate><input type="hidden" name="relay-context" value="${E(next.token)}" /><input type="hidden" name="relay-version" value="${E(next.version)}" /><div class="${gridClass}">${fields}</div></form>`;
    A.openDrawer(
      title,
      local
        ? kind === 'parent'
          ? '使用 Apple 应用专用密码授权收信，保存后可在更多操作中测试连接。'
          : '隐藏邮箱资料关联到指定主邮箱。'
        : '离线交互原型；不连接 Apple、IMAP 或 Vendure，不保存专用密码原文。',
      html,
      footer ||
        (id
          ? A.button(
              '重新载入当前资料',
              'relay-reload',
              '',
              'refresh',
              `data-id="${E(id)}" data-kind="${kind}"`
            )
          : '') +
          A.button('取消', 'drawer-close') +
          `<button type="submit" form="relay-${kind}-form" class="button primary">核对并保存</button>`,
      key
    );
    context = next;
    return next;
  }
  function draft(kind, id = '') {
    return A.state.drafts.get(`apple-relay:${kind}:${id || 'new'}`) || {};
  }
  function openParentEditor(id = '') {
    initialize();
    const row = parent(id),
      d = draft('parent', id),
      v = (key, fallback = '') => d[`relay-${key}`] ?? row?.[key] ?? fallback;
    openForm(
      'parent',
      id,
      id ? '编辑 Apple 主邮箱' : '新增 Apple 主邮箱',
      field('Apple 主邮箱', 'email', input('email', local && row ? row.email : v('email'),
        local && row ? 'autocomplete="off" readonly' : 'autocomplete="off"'), true) +
        field(
          id ? '更新专用密码' : '应用专用密码',
          'appPassword',
          input(
            'appPassword', '',
            `type="password" data-no-draft autocomplete="new-password" maxlength="256" placeholder="${id ? '留空表示不修改' : local ? '输入 Apple 应用专用密码' : '原型只填写虚构示例'}"`
          ),
          !id,
          local ? '开启 Apple 账户双重认证后，可在 Apple 账户的登录与安全设置中生成应用专用密码。'
            : '用于 iCloud 收信，不是 Apple ID 登录密码；本原型关闭后清除。'
        ) +
        field(
          '有效天数',
          'days',
          input('days', v('days', 30), 'type="number" min="1" max="3650"'),
          true
        ) +
        (id
          ? field('账号状态', 'status', select('status', statuses, v('status', 'ACTIVE')), true)
          : '') +
        field('备注', 'note', input('note', v('note'), 'maxlength="500"'))
    );
    const password = document.getElementById('relay-appPassword');
    document.querySelector('#drawer')?.addEventListener?.('close', () => {
      if (password) password.value = '';
    }, { once: true });
  }
  function openAliasEditor(id = '', parentId = '') {
    initialize();
    const row = alias(id),
      d = draft('alias', id),
      pid = row?.parentMailboxId || d['relay-parentId'] || parentId || (A.state.route === 'mailboxes/relay' ? view.parentId : '');
    if (id && !row) {
      A.notify('隐藏邮箱不存在');
      return;
    }
    const v = (key, fallback = '') => d[`relay-${key}`] ?? row?.[key] ?? fallback;
    const ctx = openForm(
      'alias',
      id,
      id ? '编辑隐藏邮箱' : '登记 Apple 隐藏邮箱',
      parentPicker(pid, id ? undefined : d['relay-parent-choice'], Boolean(id)) +
        field(
          '隐藏邮箱地址',
          'email',
          input(
            'email',
            v('email'),
            row && (local || row.inventoryState !== 'available' || row.usageLinks.length)
              ? 'readonly'
              : ''
          ),
          true,
          row && local
            ? '隐藏邮箱地址用于核对 Vendure 绑定，登记后不可修改。'
            : '填写已在 Apple 开通并转发到此主邮箱的地址，不在这里创建 Apple 地址。'
        ) +
        field(
          '有效天数',
          'days',
          input(
            'days',
            d['relay-days'] ?? row?.codeResetIntervalDays ?? 30,
            'type="number" min="1" max="3650"'
          ),
          true
        ) +
        (id
          ? field(
              '邮箱状态',
              'status',
              select('status', statuses, d['relay-status'] ?? row?.relayStatus ?? 'ACTIVE'),
              true
            )
          : '') +
        field(
          '备注',
          'note',
          input('note', d['relay-note'] ?? row?.notes ?? '', 'maxlength="500"')
        ) +
        `<div class="commerce-span-all footnote">${local ? '收件服务登记后可查看查询码。已签发的查询码可从“更多操作”中重置。' : '隐藏邮箱无需独立密码、2FA 或电话；查询码和到期时间由系统生成。'}</div>`
    );
    ctx.parentId = row?.parentMailboxId || '';
  }
  function openAliasImport(parentId = '') {
    initialize();
    preview = null;
    const d = draft('import');
    openForm(
      'import',
      '',
      '批量登记隐藏邮箱',
      parentPicker(d['relay-parentId'] || parentId || (A.state.route === 'mailboxes/relay' ? view.parentId : ''), d['relay-parent-choice']) +
        field(
          '有效天数',
          'days',
          input('days', d['relay-days'] || 30, 'type="number" min="1" max="3650"'),
          true
        ) +
        field(
          'CSV 文件',
          'file',
          '<input id="relay-file" type="file" accept=".csv,text/csv" data-no-draft />'
        ) +
        `<div class="commerce-span-all">${field('隐藏邮箱列表', 'content', `<textarea id="relay-content" name="relay-content" rows="6" placeholder="每行一个已开通的隐藏地址，可用逗号加备注；支持邮箱,备注表头">${E(d['relay-content'] || '')}</textarea>`, true, '整批必须属于同一 Apple 主邮箱；先预检再导入。')}</div><div class="commerce-span-all" id="relay-import-preview"></div>`,
      A.button('取消', 'drawer-close') +
        A.button('预检资料', 'relay-import-preview') +
        '<button type="submit" form="relay-import-form" class="button primary">确认导入</button>'
    );
  }
  const intakeFields = [
    ['隐藏邮箱', 'email'], ['注册时间', 'registered'], ['客户微信', 'wechat'], ['套餐', 'plan'],
    ['开通时间', 'start'], ['到期时间', 'expiry'], ['付款方式', 'payment'], ['备注', 'note']
  ];
  function openAliasIntake() {
    initialize();
    preview = null;
    const d = draft('intake');
    const heading = intakeFields.map(([label]) => label).join('\t');
    openForm('intake', '', 'ChatGPT 历史入库',
      parentPicker(d['relay-parentId'] || view.parentId, d['relay-parent-choice']) +
      field('有效天数', 'days', input('days', d['relay-days'] || 30, 'type="number" min="1" max="3650"'), true) +
      `<div class="commerce-span-all">${field('历史资料', 'intake-content',
        `<textarea id="relay-intake-content" name="relay-intake-content" rows="7">${E(d['relay-intake-content'] ?? heading + '\n')}</textarea>`,
        true, '可粘贴表格或 CSV，最多 100 条。仅登记注册时，保留邮箱和已核实的注册时间。已售还需填写已建档客户微信、原套餐、开通时间、到期时间及付款方式。账号密码和 2FA 密钥在 GPT 账号列表中单独补录。')}</div>` +
      '<div class="commerce-span-all" id="relay-intake-preview" aria-live="polite"></div>',
      A.button('取消', 'drawer-close') + A.button('预检资料', 'relay-intake-preview') +
      '<button type="submit" form="relay-intake-form" class="button primary">确认入库</button>');
  }
  async function previewIntake(form) {
    if (form.dataset.checking || form.dataset.saving) return;
    const check = checked(form, 'intake');
    if (!check) return;
    const { raw, ctx } = check;
    const fp = fingerprint(raw), who = actor(), p = parent(val(raw, 'parentId'));
    preview = null;
    const target = document.getElementById('relay-intake-preview');
    target.innerHTML = '';
    if (!p || p.status !== 'ACTIVE') return fail('parentId', '请选择正常的 Apple 主邮箱');
    if (!validDays(raw)) return fail('days', '有效天数应为 1 至 3650 的整数');
    const content = val(raw, 'intake-content');
    let lines;
    try {
      lines = content.split('\n')[0].includes('\t')
        ? content.split(/\r?\n/).map(line => line.split('\t').map(value => value.trim())).filter(line => line.some(Boolean))
        : A.legacy.parseCsv(content);
    } catch {
      return fail('intake-content', '请检查 CSV 引号和列格式');
    }
    if (lines[0]?.[0] === intakeFields[0][0]) {
      const header = lines.shift();
      if (header.length !== intakeFields.length || !intakeFields.every(([label], index) => header[index] === label))
        return fail('intake-content', '请按抽屉中的表头顺序填写');
    }
    if (!lines.length || lines.length > 100 || lines.some(line => line.length > intakeFields.length))
      return fail('intake-content', '请按表头填写 1 至 100 条历史资料');
    A.setError('relay-intake-content', '');
    const payload = { parentId: p.id, parentVersion: p.version || 1, days: Number(val(raw, 'days')),
      rows: lines.map(line => Object.fromEntries(intakeFields.map(([, field], i) => [field, line[i] || '']))) };
    form.dataset.checking = 'true';
    target.textContent = '正在核对历史资料…';
    try {
      const result = await window.IDLocalData.relay('alias-intake-preview', payload);
      if (!stillCurrent(form, ctx, fp, who)) {
        target.textContent = '';
        return;
      }
      preview = { ctx, fingerprint: fp, payload, ...result };
      target.innerHTML = A.table([
        { id: 'line', label: '行号' }, { id: 'email', label: '隐藏邮箱' },
        { id: 'mailbox', label: '邮箱资料' }, { id: 'account', label: '账号资料' },
        { id: 'order', label: '成品订单' }, { id: 'error', label: '待核对' }
      ], result.rows, '', 'relay-intake-preview-table');
      A.notify(result.rows.some(row => row.error) ? '请修正待核对的记录后重新预检' :
        result.pending ? `预检通过，待入库 ${result.pending} 条` : '全部记录已匹配');
    } catch (error) {
      if (context === ctx && form.isConnected) {
        target.innerHTML = '';
        fail('intake-content', error.message || '读取预检结果失败，请重试');
      }
    } finally {
      delete form.dataset.checking;
    }
  }
  function saveIntake(form) {
    if (form.dataset.saving || form.dataset.checking) return;
    const check = checked(form, 'intake');
    if (!check) return;
    const { raw, ctx } = check;
    const fp = fingerprint(raw), who = actor(), prepared = preview;
    if (prepared?.ctx !== ctx || prepared.fingerprint !== fp || prepared.rows.some(row => row.error))
      return fail('intake-content', '请先按当前内容完成预检并核对错误行');
    if (!prepared.pending) return A.notify('全部记录已匹配');
    A.confirmAction('确认历史入库',
      `${prepared.pending} 条历史资料登记到 ${parentEmail(prepared.payload.parentId)}。历史成品订单保存为待补全。`,
      async () => {
        if (!stillCurrent(form, ctx, fp, who) || form.dataset.saving) return;
        form.dataset.saving = 'true';
        const submit = document.querySelector('button[form="relay-intake-form"][type="submit"]');
        if (submit) submit.disabled = true;
        try {
          const { payload, inventoryVersion, commerceVersion } = prepared;
          const result = await window.IDLocalData.relay('alias-intake-confirm', { ...payload, inventoryVersion, commerceVersion });
          if (actor().id !== who.id) return;
          if (result.inventory) A.modules.inventory.applyCommittedInventory(result.inventory);
          initialize();
          if (context === ctx && form.isConnected && fingerprint(A.readForm(form)) === fp) finish(ctx);
          else {
            const saved = A.state.drafts.get(ctx.key);
            if (saved && fingerprint(saved) === fp) A.state.drafts.delete(ctx.key);
            renderRelayPage();
          }
          if (result.ordersCreated) void A.modules.commerce?.refreshOverview?.();
          void readConnection();
          A.notify(`历史入库 ${result.processed || 0} 条，复用 ${result.reused} 条，新增 GPT 账号 ${result.accountsCreated || 0} 个、成品订单 ${result.ordersCreated || 0} 笔`);
        } catch (error) {
          if (actor().id !== who.id) return;
          if (preview === prepared) preview = null;
          if (error.status === 409) {
            await A.modules.inventory.refreshLocalInventory({ keepContent: true });
            initialize();
          }
          A.notify(error.message || '请重新预检核对保存结果，当前输入已保留');
        } finally {
          delete form.dataset.saving;
          if (submit) submit.disabled = false;
        }
      }, '确认入库');
  }
  function finish(ctx) {
    A.state.drafts.delete(ctx.key);
    const form = document.getElementById(`relay-${ctx.kind}-form`);
    form?.removeAttribute?.('data-relay-draft');
    const drawer = document.querySelector('#drawer');
    if (drawer?.open) drawer.close();
    A.state.drawerContext = '';
    context = null;
    preview = null;
    A.render();
  }
  function saveChange(form, ctx, fingerprintAtSubmit, action, mutate, message) {
    if (!local) {
      mutate();
      finish(ctx);
      A.notify(message);
      return;
    }
    const pending = A.modules.inventory.saveAppleRelay((metadata) => {
      // Inventory stages this mutation in the same snapshot as the child mailboxes.
      ({ parents, imports, events } = metadata);
      return mutate();
    }, action);
    initialize();
    return pending.then((saved) => {
      initialize();
      if (!saved) return;
      if (
        context === ctx &&
        document.getElementById(form.id) === form &&
        document.querySelector('#drawer')?.open &&
        fingerprint(A.readForm(form)) === fingerprintAtSubmit
      ) {
        finish(ctx);
      } else {
        const savedDraft = A.state.drafts.get(ctx.key);
        if (savedDraft && fingerprint(savedDraft) === fingerprintAtSubmit)
          A.state.drafts.delete(ctx.key);
        if (A.state.route === 'mailboxes/relay') A.render();
      }
      A.notify(message);
    });
  }
  function checked(form, kind) {
    const raw = A.readForm(form),
      ctx = context;
    if (
      !ctx ||
      ctx.kind !== kind ||
      raw['relay-context'] !== ctx.token ||
      form.dataset.relayDraft !== ctx.key
    ) {
      A.notify('表单上下文已变化，请重新打开核对');
      return null;
    }
    const row =
      kind === 'parent'
        ? parent(ctx.id)
        : kind === 'alias'
          ? alias(ctx.id)
          : mails.find((m) => m.id === ctx.id);
    if (
      String(ctx.version) !== val(raw, 'version') ||
      (ctx.id && row && (row.version || 1) !== ctx.version)
    ) {
      A.notify('原始资料版本已变化，请保留草稿并核对，或重新载入当前资料');
      return null;
    }
    if (!actor().id || !actor().name) {
      A.notify('演示登录身份不可用');
      return null;
    }
    return { raw, ctx };
  }
  function val(raw, key) {
    return String(raw[`relay-${key}`] || '').trim();
  }
  function validDays(raw) {
    return (
      /^\d+$/.test(val(raw, 'days')) &&
      Number(val(raw, 'days')) >= 1 &&
      Number(val(raw, 'days')) <= 3650
    );
  }
  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  function fail(name, message) {
    A.setError(`relay-${name === 'parentId' ? 'parent-choice' : name}`, message);
    A.notify(message);
    return false;
  }
  function fingerprint(raw) {
    return JSON.stringify(
      Object.entries(raw)
        .filter(([key]) => key !== 'relay-appPassword' && key !== 'relay-file')
        .sort(([a], [b]) => a.localeCompare(b))
    );
  }
  function stillCurrent(form, ctx, fp, who) {
    const drawer = document.querySelector('#drawer');
    if (
      context !== ctx ||
      document.getElementById(form.id) !== form ||
      drawer?.open === false ||
      actor().id !== who.id ||
      fingerprint(A.readForm(form)) !== fp
    ) {
      A.notify('确认期间资料、窗口或身份已变化，本次未保存');
      return false;
    }
    const row =
      ctx.kind === 'parent' ? parent(ctx.id) : ctx.kind === 'alias' ? alias(ctx.id) : null;
    if (ctx.id && (!row || row.version !== ctx.version)) {
      A.notify('资料版本已变化，请重新打开核对');
      return false;
    }
    return true;
  }
  function saveParent(form) {
    if (form.dataset.saving) return;
    const check = checked(form, 'parent');
    if (!check) return;
    const { raw, ctx } = check,
      row = parent(ctx.id),
      appPassword = val(raw, 'appPassword'),
      credential = Boolean(appPassword);
    delete raw['relay-appPassword'];
    const password = document.getElementById('relay-appPassword');
    if (!local && password) password.value = '';
    if (!validEmail(val(raw, 'email'))) return fail('email', '请填写有效 Apple 主邮箱');
    if (!row && !credential)
      return fail('appPassword', local ? '请填写 Apple 应用专用密码' : '新增主邮箱需要应用专用密码，原型仅填写虚构值');
    if (!validDays(raw)) return fail('days', '有效天数应为 1 至 3650 的整数');
    if (row && !statuses.some(([id]) => id === val(raw, 'status')))
      return fail('status', '请选择有效状态');
    if (
      parents.some(
        (p) =>
          !p.deleted && p.id !== ctx.id && p.email.toLowerCase() === val(raw, 'email').toLowerCase()
      )
    )
      return fail('email', '主邮箱已存在');
    const fp = fingerprint(raw),
      who = actor();
    if (local) {
      return A.confirmAction(
        row ? '确认更新主邮箱' : '确认添加主邮箱',
        '保存至原收件服务。保存后可测试 iCloud 收信连接。',
        async () => {
          if (!stillCurrent(form, ctx, fp, who) || val(A.readForm(form), 'appPassword') !== appPassword) return;
          form.dataset.saving = 'true';
          const submit = document.querySelector('button[form="relay-parent-form"]');
          if (submit) submit.disabled = true;
          try {
            const result = await window.IDLocalData.relay('primary-save', {
              ...(row && { id: row.id, version: ctx.version, status: val(raw, 'status') }),
              email: val(raw, 'email'), note: val(raw, 'note'), days: Number(val(raw, 'days')),
              ...(appPassword && { appPassword })
            });
            A.modules.inventory.applyCommittedInventory(result.inventory);
            initialize();
            if (context === ctx && document.getElementById(form.id) === form &&
                fingerprint(A.readForm(form)) === fp && val(A.readForm(form), 'appPassword') === appPassword) {
              if (password) password.value = '';
              finish(ctx);
            }
            void readConnection();
            A.notify('主邮箱已保存，可在更多操作中测试连接');
          } catch (error) {
            A.notify(error.message || '保存主邮箱失败，请核对后重试');
          } finally {
            delete form.dataset.saving;
            if (submit) submit.disabled = false;
          }
        },
        '确认保存'
      );
    }
    A.confirmAction(
      '确认登记主邮箱',
      '专用密码原文不会保存在离线原型中；正式版本按原服务加密接入。',
      () => {
        if (!stillCurrent(form, ctx, fp, who)) return;
        if (
          parents.some(
            (p) =>
              !p.deleted &&
              p.id !== ctx.id &&
              p.email.toLowerCase() === val(raw, 'email').toLowerCase()
          )
        ) {
          A.notify('主邮箱已存在，本次未新增');
          return;
        }
        return saveChange(
          form,
          ctx,
          fp,
          'inventory_relay_parent_save',
          () => {
            const current = parent(ctx.id);
            const saved = current || {
              id: uid('apple-primary'),
              version: 1,
              createdAt: now(),
              createdById: who.id,
              createdBy: who.name,
              queryCode: code('MAIN'),
              queryExpiry: expiry(val(raw, 'days'))
            };
            Object.assign(saved, {
              email: val(raw, 'email'),
              note: val(raw, 'note'),
              days: Number(val(raw, 'days')),
              status: current ? val(raw, 'status') : 'ACTIVE',
              hasCredential: credential || saved.hasCredential || false
            });
            if (credential) {
              saved.connection = '凭据待测试（演示）';
              saved.lastSyncError = '';
            }
            if (!current) parents.unshift(saved);
            audit(current ? '修改主邮箱' : '登记主邮箱', saved);
          },
          '主邮箱演示资料已保存，未连接 Apple'
        );
      },
      '确认保存'
    );
  }
  function importExistingPrimaries() {
    if (!remote.status?.configured || remote.importing) return;
    A.confirmAction(
      '导入已有主邮箱',
      remote.status.aliasImportCount
        ? `沿用原主邮箱授权，并导入指定的 ${remote.status.aliasImportCount} 条隐藏邮箱。`
        : '沿用原收件服务中的主邮箱编号和授权，已绑定的记录会保留。',
      async () => {
        if (remote.importing) return;
        remote.importing = true;
        renderRelayPage();
        try {
          const result = await window.IDLocalData.relay('primary-import', {});
          if (result.inventory) A.modules.inventory.applyCommittedInventory(result.inventory);
          initialize();
          void readConnection();
          A.notify(result.imported || result.importedAliases
            ? `已导入 ${result.imported} 个主邮箱、${result.importedAliases || 0} 条隐藏邮箱`
            : '没有待导入的邮箱');
        } catch (error) {
          A.notify(error.message || '导入主邮箱失败，请核对收件服务后重试');
        } finally {
          remote.importing = false;
          renderRelayPage();
        }
      },
      '确认导入'
    );
  }
  function makeAlias(email, parentId, days, note, importId = '') {
    const who = actor(),
      id = uid('apple-alias');
    const row = {
      id,
      aliasId: id,
      type: 'relay',
      parentMailboxId: parentId,
      email,
      notes: note,
      source: 'Apple 主邮箱登记',
      importId,
      relayStatus: 'ACTIVE',
      codeResetIntervalDays: Number(days),
      queryCode: code('ALIAS'),
      queryExpiry: local ? '' : expiry(days),
      health: 'normal',
      status: '正常',
      inventoryState: 'available',
      used: false,
      inventoryHistory: [],
      usageLinks: [],
      version: 1,
      createdAt: now(),
      importedAt: now(),
      createdById: who.id,
      createdBy: who.name
    };
    mailboxes.unshift(row);
    audit('登记隐藏邮箱', row, parentId);
    return row;
  }
  function usesRelayRegistration() {
    return local && (remote.status?.configured || window.IDLocalData.authRequired);
  }
  async function registerAliases(form, ctx, fp, payload) {
    if (form.dataset.saving) return;
    form.dataset.saving = 'true';
    const submit = document.querySelector(`button[form="${form.id}"][type="submit"]`);
    if (submit) submit.disabled = true;
    try {
      const result = await window.IDLocalData.relay('alias-register', payload);
      A.modules.inventory.applyCommittedInventory(result.inventory);
      initialize();
      if (['workspace/mail-submit', 'workspace/mail-extract'].includes(A.state.route)) {
        const emails = new Set(payload.rows.map(row => row.email.toLowerCase()));
        const ids = result.inventory.data.mailboxes.filter(row => row.type === 'relay' &&
          row.parentMailboxId === payload.parentId && emails.has(row.email.toLowerCase())).map(row => row.id);
        const previous = A.state.drafts.get('inventory-relay-entry-results')?.ids || [];
        A.state.drafts.set('inventory-relay-entry-results', { ids: [...new Set([...ids, ...previous])].slice(0, 100) });
      }
      if (context === ctx && document.getElementById(form.id) === form &&
          document.querySelector('#drawer')?.open && fingerprint(A.readForm(form)) === fp) {
        finish(ctx);
      } else {
        const savedDraft = A.state.drafts.get(ctx.key);
        if (savedDraft && fingerprint(savedDraft) === fp) A.state.drafts.delete(ctx.key);
        renderRelayPage();
      }
      void readConnection();
      A.notify(`已登记 ${result.registered} 条隐藏邮箱，可在资料中查看查询码`);
    } catch (error) {
      if (error.status === 409) {
        await A.modules.inventory.refreshLocalInventory({ keepContent: true });
        initialize();
        renderRelayPage();
      }
      A.notify(error.message || '登记隐藏邮箱失败，保留当前资料供核对重试');
    } finally {
      delete form.dataset.saving;
      if (submit) submit.disabled = false;
    }
  }
  function saveAlias(form) {
    if (form.dataset.saving) return;
    const check = checked(form, 'alias');
    if (!check) return;
    const { raw, ctx } = check,
      row = alias(ctx.id),
      pid = row?.parentMailboxId || val(raw, 'parentId'),
      p = parent(pid);
    if (!p || p.status !== 'ACTIVE') return fail('parentId', '请选择存在且正常的 Apple 主邮箱');
    if (row && raw['relay-parentId'] && val(raw, 'parentId') !== row.parentMailboxId)
      return fail('parentId', '已登记隐藏邮箱不能更换所属主邮箱');
    if (!validEmail(val(raw, 'email')))
      return fail('email', '请填写已经在 Apple 开通的隐藏邮箱地址');
    if (!validDays(raw)) return fail('days', '有效天数应为 1 至 3650 的整数');
    if (row && !statuses.some(([id]) => id === val(raw, 'status')))
      return fail('status', '请选择有效状态');
    if (
      row &&
      (row.inventoryState !== 'available' || row.usageLinks.length) &&
      row.email !== val(raw, 'email')
    )
      return fail('email', '已提取或已使用的隐藏邮箱地址不能替换');
    if (duplicateAlias(val(raw, 'email'), ctx.id))
      return fail('email', '隐藏邮箱已登记，不能重复绑定其他主邮箱');
    const fp = fingerprint(raw),
      who = actor(),
      parentVersion = p.version || 1;
    A.confirmAction(
      '确认登记隐藏邮箱',
      '只登记已存在的 Apple 隐藏地址，不会在 Apple 创建邮箱。所属主邮箱需与实际转发设置一致。',
      () => {
        if (!stillCurrent(form, ctx, fp, who)) return;
        if (
          parent(pid)?.status !== 'ACTIVE' ||
          (parent(pid)?.version || 1) !== parentVersion ||
          duplicateAlias(val(raw, 'email'), ctx.id)
        ) {
          A.notify('主邮箱或隐藏邮箱库存已变化，本次未保存');
          return;
        }
        if (!row && usesRelayRegistration()) return registerAliases(form, ctx, fp, {
          parentId: pid, parentVersion, days: Number(val(raw, 'days')), batch: false,
          rows: [{ email: val(raw, 'email'), note: val(raw, 'note') }]
        });
        return saveChange(
          form,
          ctx,
          fp,
          'inventory_relay_alias_save',
          () => {
            const current = alias(ctx.id);
            if (current) {
              Object.assign(current, {
                email: val(raw, 'email'),
                notes: val(raw, 'note'),
                codeResetIntervalDays: Number(val(raw, 'days')),
                relayStatus: val(raw, 'status')
              });
              audit('修改隐藏邮箱', current);
            } else makeAlias(val(raw, 'email'), pid, val(raw, 'days'), val(raw, 'note'));
          },
          local
            ? '隐藏邮箱资料已保存'
            : '隐藏邮箱已登记到原主邮箱，查询码由系统生成'
        );
      },
      '确认保存'
    );
  }
  function parseBatch(raw) {
    const text = val(raw, 'content');
    if (!text) return [{ line: 1, email: '', note: '', error: '请填写隐藏邮箱列表' }];
    let lines;
    try {
      lines = A.legacy.parseCsv(text);
    } catch {
      return [{ line: 1, error: 'CSV 格式无效' }];
    }
    if (
      ['邮箱', '隐藏邮箱', '隐藏邮箱地址', 'email', 'aliasEmail'].includes(lines[0]?.[0]?.trim())
    ) {
      const header = lines.shift().map((v) => v.trim());
      if (header.length > 2 || (header[1] && !['备注', 'note'].includes(header[1])))
        return [{ line: 1, error: '仅接受邮箱、备注两列表头，不允许导入主邮箱、查询码或人员字段' }];
    }
    if (lines.length > 500) return [{ line: 1, error: '一次最多登记 500 条' }];
    const seen = new Set();
    return lines.map((line, index) => {
      const email = String(line[0] || '').trim(),
        note = String(line[1] || '').trim(),
        key = email.toLowerCase();
      const error =
        line.length > 2
          ? '只允许邮箱与备注两列'
          : !validEmail(email)
            ? '邮箱格式无效'
            : note.length > 500
              ? '备注最多 500 字'
              : seen.has(key) || duplicateAlias(email)
                ? '邮箱重复或已经登记'
                : '';
      seen.add(key);
      return { id: `row-${index + 1}`, line: index + 1, email, note, error };
    });
  }
  function previewImport(form) {
    const check = checked(form, 'import');
    if (!check) return;
    const { raw, ctx } = check,
      p = parent(val(raw, 'parentId'));
    if (!p || p.status !== 'ACTIVE') return fail('parentId', '请选择存在且正常的 Apple 主邮箱');
    if (!validDays(raw)) return fail('days', '有效天数应为 1 至 3650 的整数');
    const rows = parseBatch(raw);
    preview = {
      ctx,
      fingerprint: fingerprint(raw),
      parentId: p.id,
      parentVersion: p.version || 1,
      rows
    };
    const target = document.getElementById('relay-import-preview');
    if (target)
      target.innerHTML = A.table(
        [
          { id: 'line', label: '行号' },
          { id: 'email', label: '隐藏邮箱' },
          { id: 'note', label: '备注' },
          { id: 'error', label: '预检结果', render: (r) => E(r.error || '可以登记') }
        ],
        rows,
        '',
        'relay-import-preview-table'
      );
    A.notify(
      rows.some((r) => r.error)
        ? '存在错误行，请全部修正后重新预检'
        : `预检通过 ${rows.length} 条，请确认主邮箱后导入`
    );
  }
  function saveImport(form) {
    if (form.dataset.saving) return;
    const check = checked(form, 'import');
    if (!check) return;
    const { raw, ctx } = check,
      fp = fingerprint(raw),
      who = actor(),
      prior = preview;
    if (!prior || prior.ctx !== ctx || prior.fingerprint !== fp)
      return fail('content', '请先按当前内容完成预检');
    if (!prior.rows.length || prior.rows.some((r) => r.error))
      return fail('content', '请修正全部错误行，不会部分导入');
    A.confirmAction(
      '确认批量登记隐藏邮箱',
      `${prior.rows.length} 条均登记到 ${parentEmail(prior.parentId)}；不会在 Apple 新建地址。`,
      () => {
        if (!stillCurrent(form, ctx, fp, who)) return;
        if (
          parent(prior.parentId)?.status !== 'ACTIVE' ||
          (parent(prior.parentId)?.version || 1) !== prior.parentVersion ||
          parseBatch(raw).some((r) => r.error)
        ) {
          A.notify('主邮箱或库存已变化，请重新预检；本次未导入');
          return;
        }
        if (usesRelayRegistration()) return registerAliases(form, ctx, fp, {
          parentId: prior.parentId, parentVersion: prior.parentVersion, days: Number(val(raw, 'days')),
          batch: true, rows: prior.rows.map(({ email, note }) => ({ email, note }))
        });
        return saveChange(
          form,
          ctx,
          fp,
          'inventory_relay_alias_import',
          () => {
            const id = uid('relay-import');
            const results = prior.rows.map((r) => ({
              ...r,
              assetId: makeAlias(r.email, prior.parentId, val(raw, 'days'), r.note, id).id
            }));
            imports.unshift({
              id,
              type: 'relay',
              types: ['relay'],
              parentId: prior.parentId,
              time: now(),
              actor: who.name,
              actorId: who.id,
              total: results.length,
              success: results.length,
              failed: 0,
              status: '已登记',
              results
            });
          },
          '整批登记完成，可在隐藏邮箱和导入记录核对'
        );
      },
      '确认导入'
    );
  }
  function eventList(id) {
    const asset = alias(id);
    const rows = asset
      ? [...asset.inventoryHistory].reverse().map((entry) => ({
          id: entry.id,
          kind: entry.action,
          actor: entry.actor || '历史未记录',
          actorId: entry.actorId || '历史未记录',
          at: entry.time,
          note: entry.detail
        }))
      : events.filter((r) => r.entityId === id);
    return rows.length
      ? A.table(
          [
            { id: 'kind', label: '操作' },
            { id: 'actor', label: '操作人' },
            { id: 'actorId', label: '操作人编号' },
          { id: 'at', label: '操作时间', render: (r) => E(timeText(r.at)) },
            { id: 'note', label: '说明' }
          ],
          rows,
          '',
          'relay-events'
        )
      : A.empty('暂无新操作记录', '历史来源没有证据时保持未记录。');
  }
  function openParentDetail(id) {
    initialize();
    const p = parent(id);
    if (!p) return;
    A.openDrawer(
      'Apple 主邮箱详情',
      '主邮箱负责 iCloud 收信；隐藏地址只按实际父级登记，不从账号余额库存推断。',
      `<div class="property-list">${prop('主邮箱编号', displayId('parent', p))}${prop('Apple 主邮箱', p.email)}${prop('账号状态', status(p))}${prop('应用专用密码', p.hasCredential ? '已配置（演示，不保存原文）' : '未配置')}${prop('主查询码', p.queryCode)}${prop('查询码到期', timeText(p.queryExpiry))}${prop('有效天数', String(p.days))}${prop('最近同步', timeText(p.lastSyncedAt))}${prop('同步情况', p.lastSyncError || '尚未同步')}${prop('备注', p.note)}${trace(p)}</div><div class="toolbar">${A.button('登记隐藏邮箱', 'relay-alias-add', 'primary', 'plus', `data-parent-id="${E(p.id)}"`)}${A.button('批量导入', 'relay-import', '', 'upload', `data-parent-id="${E(p.id)}"`)}</div>${A.table(
        [
          { id: 'aliasId', label: '隐藏邮箱编号', render: (r) => E(displayId('alias', r)) },
          { id: 'email', label: '隐藏邮箱' },
          { id: 'relayStatus', label: '邮箱状态', render: (r) => E(status(r)) }
        ],
        aliases().filter((a) => a.parentMailboxId === p.id),
        '',
        'relay-parent-children'
      )}${eventList(p.id)}`,
      A.button('关闭', 'drawer-close')
    );
  }
  function openAliasDetail(id) {
    initialize();
    const a = alias(id);
    if (!a) return;
    const inventory = A.modules.inventory;
    const usage = inventory?.usageDetails?.(a) || '';
    const account = inventory?.mailboxRegistrationAccount?.(a);
    const claim = inventory?.mailboxClaim?.(a);
    const review = inventory?.usageReviewFor?.(a.id);
    const platform = platformLabel(a);
    const accountState = account && ({ dead: '死号', unlocking: '解封中' }[account.health] || account.status || '正常');
    const accountProperties = account ? prop('注册时间', timeText(inventory.registrationTime?.(account))) +
      prop('账号状态', accountState) + prop('账号状态变更时间', timeText(inventory.healthChangeTime?.(account))) : '';
    const registration = `<section class="form-section"><h3>关联账号</h3><div class="property-list">
      ${prop('注册平台', platform)}
      <div class="property-row"><span>账号编号</span><strong>${registrationAccountCell(a)}</strong></div>
      ${prop('注册状态', platform === '待核对' ? '待核对' : registrationLabel(a))}
      ${review?.status === 'review' ? prop('待核对原因', review.message) : ''}
      ${accountProperties}${prop('实际使用时间', timeText(a.actualUsedAt))}${claim ? prop('原领用批次', claim.label) : ''}
      </div>${claim ? A.button('查看原领用批次', 'inventory-batch', '', 'orders', `data-id="${E(claim.id)}"`) : ''}</section>`;
    const history = usage + eventList(a.id);
    A.openDrawer(
      'Apple 隐藏邮箱详情',
      '隐藏邮箱从所属 Apple 主邮箱收信；库存使用和平台注册记录分别保留。',
      `<div class="property-list">${prop('隐藏邮箱编号', displayId('alias', a))}${prop('主邮箱编号', displayId('parent', a.parentMailboxId))}${prop('所属主邮箱', parentEmail(a.parentMailboxId))}${prop('隐藏邮箱地址', a.email)}${prop('邮箱启用状态', status(a))}${prop('邮箱资料状态', healthLabel(a))}${prop('邮箱资料状态变更时间', timeText(a.healthChangedAt))}${prop('邮箱使用状态', usedLabel(a))}${prop('买家查询码', a.queryCode)}${prop('查询码到期', timeText(a.queryExpiry))}${prop('有效天数', String(a.codeResetIntervalDays))}${prop('最近查询时间', timeText(a.lastQueriedAt))}${prop('邮件数量', String(mails.filter((mail) => mail.aliasId === a.id).length))}${prop('最近收件时间', lastMailTime(a.id))}${prop('来源导入批次', sourceBatchLabel(a))}${prop('备注', a.notes)}${trace(a)}</div>${registration}${history}`,
      A.button('关闭', 'drawer-close') +
        (A.modules.inventory?.mailboxPlatformButton?.(a) || '') +
        A.button('查看邮件', 'relay-mails', '', 'mail', `data-id="${E(a.id)}"`) +
        (local && a.inventoryState === 'claimed'
          ? A.button(
              '登记注册结果',
              'inventory-register',
              'primary',
              'check',
              `data-id="${E(a.id)}"`
            )
          : '') + (A.modules.inventory?.personalRegistrationButtons?.(a) || '')
    );
  }
  function requestAliasHealth(id, health) {
    const row = alias(id);
    const label = healthOptions.find(([key]) => key === health)?.[1];
    if (!row || !label || (row.health || 'normal') === health) return;
    const version = row.version || 1;
    const operatorId = actor().id;
    const drawer = document.querySelector('#drawer');
    const drawerContent = drawer?.firstElementChild;
    A.confirmAction(
      '确认调整邮箱资料状态',
      `${row.email}：${healthLabel(row)} → ${label}。已有领用、实际使用、注册和收件记录均保留。`,
      async () => {
        function apply() {
          const current = alias(id);
          if (!current || (current.version || 1) !== version || actor().id !== operatorId) {
            A.notify('邮箱资料或当前账号已变化，请重新打开后核对');
            return false;
          }
          const previous = healthLabel(current);
          current.health = health;
          current.healthChangedAt = now();
          audit('邮箱资料状态变化', current, `${previous} → ${healthLabel(current)}`, {
            updateDetails: false
          });
          return true;
        }
        const saved = local
          ? await A.modules.inventory.saveAppleRelay((metadata) => {
              ({ parents, imports, events } = metadata);
              return apply();
            }, 'inventory_health_change')
          : apply();
        initialize();
        if (!saved) return;
        if (A.state.route === 'mailboxes/relay') {
          if (drawer?.open && drawer.firstElementChild === drawerContent) A.closeDrawer();
          A.render();
        }
        A.notify('隐藏邮箱账号状态已更新');
      }
    );
  }
  function more(kind, id, node) {
    const row = kind === 'parent' ? parent(id) : alias(id);
    if (!row) return;
    const attr = `data-id="${E(id)}" data-kind="${kind}"`;
    const edit = A.button('编辑资料', `relay-${kind}-edit`, '', 'edit', `data-id="${E(id)}"`);
    const actions = local
      ? edit +
        (codeTargetBound(kind, id)
          ? A.button('查看查询码', 'relay-live-code-read', '', 'key', attr) +
            A.button('重置查询码', 'relay-live-code-reset', '', 'refresh', attr)
          : '') +
        (kind === 'alias' && row.relayStatus === 'ACTIVE' && !row.remoteAliasId &&
          !codeTargetBound(kind, id) && bound(row.parentMailboxId)
          ? A.button('接入收件服务', 'relay-alias-bind', '', 'mail',
              `${attr} ${remote.pending.has('bind:' + id) ? 'disabled' : ''}`)
          : '') +
        (kind === 'parent' && bound(id)
          ? A.button(
              '测试连接',
              'relay-parent-test',
              '',
              '',
              `${attr} ${remote.pending.has(id) ? 'disabled' : ''}`
            ) +
            A.button(
              '立即同步',
              'relay-parent-sync',
              '',
              'refresh',
              `${attr} ${remote.pending.has(id) ? 'disabled' : ''}`
            ) +
            A.button('检查历史邮件', 'relay-live-history-preview', '', 'search', attr)
          : '')
      : edit +
        (kind === 'parent'
          ? A.button('连接测试（演示）', 'relay-parent-test', '', '', `data-id="${E(id)}"`) +
            A.button('立即同步（演示）', 'relay-parent-sync', '', 'refresh', `data-id="${E(id)}"`) +
            A.button('检查历史邮件', 'relay-history-preview', '', '', `data-id="${E(id)}"`) +
            A.button(
              row.simulateSyncFailure ? '恢复模拟连接' : '模拟同步失败',
              'relay-sync-failure',
              '',
              '',
              `data-id="${E(id)}"`
            )
          : A.button('库存与注册操作', 'inventory-more', '', '', `data-id="${E(id)}"`)) +
        A.button('重置查询码', 'relay-code-reset', '', 'refresh', attr) +
        A.button(status(row) === '正常' ? '禁用' : '恢复', 'relay-status', '', '', attr) +
        A.button('删除', 'relay-delete', 'danger', '', attr);
    const healthActions =
      local && kind === 'alias'
        ? healthOptions
            .filter(([key]) => key !== (row.health || 'normal'))
            .map(([key, label]) =>
              A.button(
                key === 'normal' ? '恢复正常' : `移入${label}`,
                'relay-health',
                key === 'dead' ? 'danger' : '',
                '',
                `${attr} data-health="${key}"`
              )
            )
            .join('')
        : '';
    A.openActionMenu(node, actions + (kind === 'alias' ? A.modules.inventory?.mailboxPlatformButton?.(row) || '' : '') + healthActions);
  }
  function bindExistingAlias(id, button) {
    initialize();
    const row = alias(id);
    const owner = row && parent(row.parentMailboxId);
    if (!row || !owner || !bound(owner.id) || codeTargetBound('alias', id)) return;
    const version = row.version || 1;
    const parentVersion = owner.version || 1;
    const operatorId = actor().id;
    const pendingKey = 'bind:' + id;
    A.confirmAction(
      '确认接入收件服务',
      `将 ${row.email} 接入所属主邮箱 ${owner.email} 的收件服务。已有的同主邮箱地址会复用，保留本条库存及领用历史。`,
      async () => {
        if (remote.pending.has(pendingKey)) return;
        const current = alias(id);
        if (!current || (current.version || 1) !== version ||
            (parent(owner.id)?.version || 1) !== parentVersion || actor().id !== operatorId) {
          A.notify('邮箱资料或当前账号已变化，请重新打开后核对');
          return;
        }
        remote.pending.add(pendingKey);
        button.disabled = true;
        try {
          const result = await window.IDLocalData.relay('alias-register', {
            existingId: id, existingVersion: version, parentId: owner.id, parentVersion,
            days: Number(row.codeResetIntervalDays || 30), batch: false,
            rows: [{ email: row.email, note: row.notes || '' }]
          });
          if (actor().id !== operatorId) return;
          A.modules.inventory.applyCommittedInventory(result.inventory);
          initialize();
          await readConnection();
          renderRelayPage();
          A.notify('原隐藏邮箱已接入收件服务，可查看查询码和收件记录');
        } catch (error) {
          if (actor().id !== operatorId) return;
          if (error.status === 409) {
            await A.modules.inventory.refreshLocalInventory({ keepContent: true });
            initialize();
            renderRelayPage();
          }
          A.notify(error.message || '接入失败，请核对后重试');
        } finally {
          remote.pending.delete(pendingKey);
          button.disabled = false;
        }
      },
      '确认接入'
    );
  }
  async function previewRemoteHistory(id) {
    if (!bound(id)) return;
    const attr = `data-id="${E(id)}"`;
    A.openDrawer(
      '检查历史邮件归属',
      '检查所选主邮箱的历史邮件，只显示匹配统计。',
      `<div class="property-list">${prop('主邮箱', parentEmail(id))}</div>
        <div id="relay-history-summary" class="design-region-progress" aria-live="polite" aria-busy="true">正在检查历史邮件…</div>`,
      A.button('关闭', 'drawer-close')
    );
    const region = document.getElementById('relay-history-summary');
    const stillOpen = () => region.isConnected && document.getElementById('drawer').open;
    try {
      const counts = await window.IDLocalData.relay('history-preview', { parentId: id });
      if (!stillOpen()) return;
      const metrics = [
        ['扫描', 'scannedCount'],
        ['匹配', 'matchedCount'],
        ['未匹配', 'unmatchedCount'],
        ['存在歧义', 'ambiguousCount'],
        ['无法判定', 'unresolvedCount'],
        ['已跳过', 'skippedCount'],
        ['本次改动', 'updatedCount']
      ];
      region.className = 'property-list';
      region.innerHTML = metrics.map(([label, key]) => prop(label, String(counts[key]))).join('');
    } catch (error) {
      if (!stillOpen()) return;
      region.className = 'inline-notice warning';
      region.innerHTML = `<span>${E(error.message || '历史邮件检查失败')}</span>${A.button('重试检查', 'relay-live-history-preview', '', 'refresh', attr)}`;
    } finally {
      if (stillOpen()) region.setAttribute('aria-busy', 'false');
    }
  }
  function showCodeResult(result, kind, id, reset = false) {
    if (reset && kind === 'alias') hydrateBuyerCodes({ id, result, refresh: true });
    const expiry = result.codeExpiresAt
      ? timeText(result.codeExpiresAt)
      : '无固定到期时间';
    A.openDrawer(
      reset ? '查询码已重置' : '邮箱查询码',
      reset ? '新查询码已生效，旧码失效。' : '请把查询码交给有权查看此邮箱的人员。',
      `<div class="property-list">${prop('邮箱', result.email)}<div class="property-row"><span>查询码</span><strong id="relay-code-result">${E(result.queryCode)}</strong></div>${prop('有效期（北京时间）', expiry)}</div>`,
      A.button('关闭', 'drawer-close') + A.button('复制查询码', 'relay-live-code-copy', 'primary', 'copy')
    );
    const drawer = document.getElementById('drawer');
    const node = document.getElementById('relay-code-result');
    const clear = () => {
      if (drawer.open && node.isConnected) return;
      node.textContent = '';
      drawer.removeEventListener('close', clear);
    };
    drawer.addEventListener('close', clear);
  }
  async function readCurrentCode(kind, id, button) {
    if (!codeTargetBound(kind, id) || button.disabled) return;
    button.disabled = true;
    const operatorId = actor().id;
    A.openDrawer('邮箱查询码', '请把查询码交给有权查看此邮箱的人员。',
      '<div id="relay-code-loading" class="design-region-progress" role="status" aria-busy="true">正在读取查询码…</div>',
      A.button('关闭', 'drawer-close'));
    const loading = document.getElementById('relay-code-loading');
    const current = () => loading.isConnected && document.getElementById('drawer').open && actor().id === operatorId;
    try {
      const result = await window.IDLocalData.relay('code-read', { kind, id });
      if (current()) showCodeResult(result, kind, id);
    } catch (error) {
      if (current()) {
        loading.className = 'inline-notice warning';
        loading.innerHTML = `<span>${E(error.message || '查询码读取失败，请重试')}</span>${A.button('重试', 'relay-live-code-read', '', '', `data-kind="${kind}" data-id="${E(id)}"`)}`;
        loading.setAttribute('aria-busy', 'false');
      }
    } finally {
      button.disabled = false;
    }
  }
  function openCodeReset(kind, id) {
    const row = kind === 'parent' ? parent(id) : alias(id);
    if (!row || !codeTargetBound(kind, id)) return;
    const key = `apple-relay:code-reset:${kind}:${id}`;
    const saved = A.state.drafts.get(key) || {};
    A.openDrawer(
      '重置邮箱查询码',
      '重置后原查询码会失效。请核对邮箱和新码有效天数。',
      `<div class="property-list">${prop('邮箱', row.email)}</div><form id="relay-live-code-form" data-relay-draft="${E(key)}" novalidate><input type="hidden" name="relay-code-kind" value="${E(kind)}" /><input type="hidden" name="relay-code-id" value="${E(id)}" /><div class="form-grid">${field(
        '有效天数',
        'code-days',
        select(
          'code-days',
          [30, 90, 180, 365].map((days) => [String(days), `${days} 天`]),
          saved['relay-code-days'] || '30'
        ),
        true
      )}</div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" class="button primary" form="relay-live-code-form">核对重置</button>',
      key
    );
  }
  function finishLiveDraft(form, snapshot) {
    const key = form.dataset.relayDraft;
    const current = form.isConnected && document.getElementById('drawer').open &&
      fingerprint(A.readDraft(form)) === snapshot;
    if (current || fingerprint(A.state.drafts.get(key) || {}) === snapshot)
      A.state.drafts.delete(key);
    if (current) {
      form.removeAttribute('data-relay-draft');
      A.state.drawerContext = '';
    }
    return current;
  }
  async function prepareCodeReset(form) {
    const {
      'relay-code-kind': kind,
      'relay-code-id': id,
      'relay-code-days': days
    } = A.readForm(form);
    const submit = document.querySelector('button[form="relay-live-code-form"]');
    if (!submit || submit.disabled) return;
    const snapshot = fingerprint(A.readDraft(form));
    const stillOpen = () => form.isConnected && document.getElementById('drawer').open &&
      fingerprint(A.readDraft(form)) === snapshot;
    submit.disabled = true;
    try {
      const review = await window.IDLocalData.relay('code-reset-prepare', {
        kind,
        id,
        validityDays: Number(days)
      });
      if (!stillOpen()) return;
      A.confirmAction(
        '确认重置查询码',
        `${review.email} 的旧查询码会失效，新码有效 ${review.validityDays} 天。`,
        async () => {
          if (!stillOpen() || submit.disabled) return;
          submit.disabled = true;
          try {
            const result = await window.IDLocalData.relay('code-reset-confirm', {
              confirmation: review.confirmation
            });
            if (finishLiveDraft(form, snapshot)) showCodeResult(result, kind, id, true);
            else A.notify('查询码已重置，后续填写的内容已保留');
          } catch (error) {
            if (error.status === 502) {
              window.IDLocalData.queries?.invalidate('apple-relay');
              hydrateBuyerCodes({ id, refresh: true });
            }
            A.notify(error.message);
          } finally {
            submit.disabled = false;
          }
        },
        '确认重置'
      );
    } catch (error) {
      A.notify(error.message);
    } finally {
      submit.disabled = false;
    }
  }
  function syncParent(id) {
    if (local) return { ok: false, message: connectionPending };
    const p = parent(id);
    if (!p || p.status !== 'ACTIVE' || !p.hasCredential)
      return { ok: false, message: '主邮箱不可用，先核对启用状态及应用专用密码' };
    if (p.simulateSyncFailure) {
      p.lastSyncError = '模拟同步失败，已保留已有邮件；可恢复模拟连接后重试';
      return { ok: false, message: p.lastSyncError };
    }
    p.lastSyncedAt = now();
    p.lastSyncError = '离线模拟完成，未连接 IMAP，新增 0 封';
    audit('模拟同步邮件', p, '只同步邮件，不创建 Apple 隐藏地址');
    return { ok: true, message: p.lastSyncError };
  }
  async function runParentOperation(operation, id) {
    if (!bound(id) || remote.pending.has(id)) return;
    remote.pending.add(id);
    const previous = remote.parents.get(id) || {};
    let result;
    try {
      result = await window.IDLocalData.relay(operation, { parentId: id });
    } catch (error) {
      result = { success: false, message: error.message || '收件服务未响应' };
    } finally {
      remote.pending.delete(id);
    }
    const { success, message } = result;
    remote.parents.set(
      id,
      operation === 'test'
        ? { ...previous, message }
        : { ...previous, syncMessage: message, ...(success ? { syncedAt: now() } : {}) }
    );
    renderRelayPage();
    A.notify(message || (success ? '操作成功' : '操作未完成'));
  }
  async function readRemoteMails(refresh) {
    if (!remote.status?.configured) return;
    const { parentId, aliasId, assignment } = view;
    const key = JSON.stringify([parentId, aliasId, assignment]);
    if (key !== remote.mailKey) {
      mails.length = 0;
      remote.mailKey = key;
    }
    const request = ++remote.mailRequest;
    remote.mailLoading = true;
    remote.mailError = '';
    renderRelayPage();
    try {
      const result = await window.IDLocalData.relay('mails', {
        ...(parentId && { parentId }),
        ...(aliasId && { aliasId }),
        ...(assignment === 'unassigned' && { unassignedOnly: true }),
        refresh
      });
      if (request === remote.mailRequest) {
        mails.splice(0, mails.length, ...result.items);
        if (result.truncated)
          remote.mailError = '仅显示最近一批邮件，可按主邮箱或隐藏邮箱缩小范围。';
        return true;
      }
    } catch (error) {
      if (request === remote.mailRequest)
        remote.mailError =
          (error.message || '读取邮件失败') + (mails.length ? '。当前显示上次成功结果。' : '');
      return request === remote.mailRequest ? false : undefined;
    } finally {
      if (request === remote.mailRequest) {
        remote.mailLoading = false;
        renderRelayPage();
      }
    }
  }
  function refreshMails(refresh = true) {
    if (local) {
      return readRemoteMails(refresh);
    }
    const ids = view.parentId
      ? [view.parentId]
      : parents.filter((p) => !p.deleted && p.status === 'ACTIVE').map((p) => p.id);
    const results = ids.map(syncParent);
    A.render();
    A.notify(
      results.find((r) => !r.ok)?.message || '已先模拟同步主邮箱，再读取现有邮件；不代表真实收信'
    );
  }
  function openMails(id) {
    initialize();
    const a = alias(id);
    if (!a) return;
    A.closeDrawer();
    view.tab = 'mails';
    view.parentId = a.parentMailboxId;
    view.aliasId = a.id;
    view.q = '';
    A.go('mailboxes/relay');
    if (local) refreshMails();
    else syncParent(a.parentMailboxId);
    A.render();
  }
  async function queryRemoteMail(query) {
    if (!query) {
      A.setError('relay-query', '请输入邮箱或查询码');
      return;
    }
    if (!remote.status?.configured || remote.querying) return;
    const request = ++remote.queryRequest;
    remote.querying = true;
    renderRelayPage();
    try {
      const result = await window.IDLocalData.relay('query', { query });
      if (request === remote.queryRequest) {
        view.result = {
          ok: true,
          message: `${result.email} · ${result.items.length} 封邮件`,
          rows: result.items
        };
      }
    } catch (error) {
      if (request === remote.queryRequest)
        view.result = { ok: false, message: error.message || '查询失败', rows: view.result?.rows };
    } finally {
      if (request === remote.queryRequest) {
        remote.querying = false;
        renderRelayPage();
      }
    }
  }
  function queryMail(form) {
    const raw = A.readForm(form);
    view.query = val(raw, 'query');
    if (local) {
      void queryRemoteMail(view.query);
      return;
    }
    const p = parents.find(
      (r) =>
        !r.deleted &&
        (r.email.toLowerCase() === view.query.toLowerCase() || r.queryCode === view.query)
    );
    const a = aliases().find(
      (r) => r.email.toLowerCase() === view.query.toLowerCase() || r.queryCode === view.query
    );
    const owner = p || parent(a?.parentMailboxId);
    if (!view.query || (!p && !a))
      view.result = { ok: false, message: '未找到该主邮箱、隐藏邮箱或查询码' };
    else if (!owner || owner.status !== 'ACTIVE' || (a && a.relayStatus === 'DISABLED'))
      view.result = { ok: false, message: '主邮箱或隐藏邮箱已禁用，不能查询' };
    else if (
      timestamp((p || a).queryExpiry) <= timestamp(now()) ||
      !Number.isFinite(timestamp((p || a).queryExpiry))
    )
      view.result = { ok: false, message: '查询码已到期，请在原邮箱资料中重置后再查询' };
    else {
      const targetKey = `${owner.id}:${a?.id || ''}`;
      const previous = view.result;
      const result = syncParent(owner.id);
      if (!result.ok)
        view.result = {
          ...result,
          targetKey,
          rows: previous?.targetKey === targetKey ? previous.rows : undefined
        };
      else {
        (p || a).lastQueriedAt = now();
        view.result = {
          ok: true,
          message: '已先模拟同步所属主邮箱，再读取邮件；未发起真实 IMAP 请求。',
          targetKey,
          rows: mails.filter((m) => m.parentId === owner.id && (!a || m.aliasId === a.id))
        };
      }
    }
    A.render();
  }
  function mailDetail(id) {
    const row = (local && view.tab === 'query' ? view.result?.rows || [] : mails).find(
      (m) => m.id === id
    );
    if (!row) return;
    row.read = true;
    A.openDrawer(
      '邮件正文',
      local ? '' : '离线虚构邮件；外部邮件接入仍需真实服务与安全渲染验收。',
      `<div class="property-list">${prop('主邮箱', parentEmail(row.parentId))}${prop('隐藏邮箱', alias(row.aliasId)?.email || '未分配')}${prop('发件人', row.from)}${prop('主题', row.subject)}${prop('验证码', row.code)}${prop('收件时间', timeText(row.receivedAt))}</div><div class="inline-notice">${E(row.body)}</div>`,
      A.button('关闭', 'drawer-close')
    );
  }
  function reassign(id) {
    const row = mails.find((m) => m.id === id);
    if (!row) return;
    if (local) {
      openLiveAssignment(row);
      return;
    }
    const saved = draft('reassign', id);
    const ctx = openForm(
      'reassign',
      id,
      '核对邮件归属',
      field(
        '隐藏邮箱',
        'aliasId',
        select(
          'aliasId',
          [
            ['', '请选择同一主邮箱下的地址'],
            ...aliases()
              .filter((a) => a.parentMailboxId === row.parentId)
              .map((a) => [a.id, a.email])
          ],
          saved['relay-aliasId'] ?? row.aliasId
        ),
        true
      )
    );
    ctx.parentId = row.parentId;
  }
  function liveAssignmentTargets(row) {
    const mapped = remote.status?.aliasIds || [];
    return aliases().filter(
      (item) =>
        item.parentMailboxId === row.parentId &&
        item.id !== row.aliasId &&
        item.relayStatus !== 'DISABLED' &&
        mapped.includes(item.id)
    );
  }
  function openLiveAssignment(row) {
    const targets = liveAssignmentTargets(row);
    if (!targets.length) {
      A.notify('同一主邮箱下暂无可分配的其他隐藏地址');
      return;
    }
    const key = `apple-relay:assignment:${row.parentId}:${row.id}`;
    const saved = A.state.drafts.get(key) || {};
    A.openDrawer(
      '分配邮件归属',
      '确认后，该邮件会归到所选隐藏邮箱。旧归属的买家查询码将不再显示这封邮件。',
      `<div class="property-list">${prop('主邮箱', parentEmail(row.parentId))}${prop('邮件主题', row.subject)}${prop('当前归属', alias(row.aliasId)?.email || '未分配')}</div><form id="relay-live-assignment-form" data-relay-draft="${E(key)}" novalidate><input type="hidden" name="relay-assign-parent" value="${E(row.parentId)}" /><input type="hidden" name="relay-assign-mail" value="${E(row.id)}" /><input type="hidden" name="relay-assign-source" value="${E(saved['relay-assign-source'] ?? row.aliasId ?? '')}" /><div class="form-grid">${field(
        '目标隐藏邮箱',
        'assign-alias',
        select('assign-alias', [
          ['', '请选择目标隐藏邮箱'],
          ...targets.map((item) => [item.id, item.email])
        ], saved['relay-assign-alias'] || ''),
        true
      )}</div><div id="relay-assignment-notice" class="inline-notice warning" role="alert" hidden></div></form>`,
      A.button('取消', 'drawer-close') +
        '<button type="submit" class="button primary" form="relay-live-assignment-form">核对分配</button>',
      key
    );
  }
  async function prepareLiveAssignment(form) {
    const {
      'relay-assign-parent': parentId,
      'relay-assign-mail': mailId,
      'relay-assign-source': sourceAliasId,
      'relay-assign-alias': aliasId
    } = A.readForm(form);
    if (!aliasId) return fail('assign-alias', '请选择目标隐藏邮箱');
    A.setError('relay-assign-alias', '');
    const submit = document.querySelector('button[form="relay-live-assignment-form"]');
    const notice = form.querySelector('#relay-assignment-notice');
    if (!submit || submit.disabled) return;
    const snapshot = fingerprint(A.readDraft(form));
    const stillOpen = () => form.isConnected && document.getElementById('drawer').open &&
      fingerprint(A.readDraft(form)) === snapshot;
    const showError = (error) => {
      if (!stillOpen()) return;
      notice.hidden = false;
      notice.textContent = error.message;
    };
    submit.disabled = true;
    notice.hidden = true;
    try {
      const review = await window.IDLocalData.relay('mail-reassign-prepare', {
        parentId,
        mailId,
        aliasId,
        sourceAliasId
      });
      if (!stillOpen()) return;
      A.confirmAction(
        '确认分配邮件',
        `${review.parentEmail} 的「${review.subject || '无主题邮件'}」将从 ${review.sourceAliasEmail || '未分配'} 调整到 ${review.aliasEmail}。`,
        async () => {
          if (!stillOpen() || submit.disabled) return;
          submit.disabled = true;
          try {
            await window.IDLocalData.relay('mail-reassign-confirm', {
              confirmation: review.confirmation
            });
            view.result = null;
            if (finishLiveDraft(form, snapshot)) A.closeDrawer();
            if (view.tab === 'mails') refreshMails(false);
            A.notify('邮件归属已更新');
          } catch (error) {
            showError(error);
            if (view.tab === 'mails' && [409, 502].includes(error.status)) refreshMails(false);
          } finally {
            submit.disabled = false;
          }
        },
        '确认分配'
      );
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  }
  function saveReassign(form) {
    const check = checked(form, 'reassign');
    if (!check) return;
    const { raw, ctx } = check,
      row = mails.find((m) => m.id === ctx.id),
      a = alias(val(raw, 'aliasId'));
    if (!row || !a || a.parentMailboxId !== row.parentId)
      return fail('aliasId', '只能分配到同一主邮箱下的隐藏邮箱');
    const fp = fingerprint(raw),
      who = actor(),
      version = row.version || 1;
    // Use the original context for the commit so opening another drawer invalidates it.
    A.confirmAction(
      '确认邮件归属',
      '只调整当前邮件，不更换所属主邮箱。',
      () => {
        if (
          context !== ctx ||
          document.querySelector('#drawer')?.open === false ||
          fingerprint(A.readForm(form)) !== fp ||
          actor().id !== who.id ||
          (row.version || 1) !== version ||
          alias(a.id)?.parentMailboxId !== row.parentId
        ) {
          A.notify('邮件或归属已变化，本次未分配');
          return;
        }
        row.aliasId = a.id;
        audit('重新分配邮件', row, a.email);
        finish(ctx);
        A.notify('邮件归属演示记录已更新');
      },
      '确认分配'
    );
  }
  function openImportDetail(id) {
    const batch = imports.find((r) => r.id === id);
    if (!batch) return;
    A.openDrawer(
      '隐藏邮箱导入详情',
      '每个地址都保留相同主邮箱和导入批次；此处不会创建第二份别名资料。',
      `<div class="property-list">${prop('批次', displayImportId(batch.id))}${prop('所属主邮箱', parentEmail(batch.parentId))}${prop('导入人', batch.actor)}${prop('导入时间', timeText(batch.time))}</div>${A.table(
        [
          { id: 'line', label: '行号' },
          { id: 'email', label: '隐藏邮箱' },
          { id: 'assetId', label: '隐藏邮箱编号', render: (r) => E(displayId('alias', r.assetId)) },
          { id: 'note', label: '备注' }
        ],
        batch.results,
        '',
        'relay-import-detail'
      )}`,
      A.button('关闭', 'drawer-close')
    );
  }
  function historyMatches(mail) {
    const address = String(mail.recipientAddress || '')
      .trim()
      .toLowerCase();
    return address
      ? aliases().filter(
          (a) => a.parentMailboxId === mail.parentId && a.email.toLowerCase() === address
        )
      : [];
  }
  function historyPreview(id) {
    const p = parent(id);
    if (!p) return;
    const rows = mails
      .filter((m) => m.parentId === id && !m.aliasId)
      .map((m) => {
        const candidates = historyMatches(m);
        return {
          id: m.id,
          subject: m.subject,
          recipientAddress: m.recipientAddress || '缺少明确收件地址',
          candidateId: candidates.length === 1 ? candidates[0].id : '',
          candidate: candidates.length === 1 ? candidates[0].email : '无法唯一匹配，保留未分配',
          version: m.version || 1
        };
      });
    reconciliation = { id, version: p.version, rows, actorId: actor().id };
    context = null;
    A.openDrawer(
      '检查历史邮件归属',
      '只按邮件中明确的收件地址匹配同一主邮箱下的隐藏邮箱；缺少依据或有歧义时不猜测。此时还未修改。',
      A.table(
        [
          { id: 'subject', label: '邮件主题' },
          { id: 'recipientAddress', label: '原收件地址' },
          { id: 'candidate', label: '归属预检' }
        ],
        rows,
        '',
        'relay-history-preview'
      ),
      A.button('关闭', 'drawer-close') +
        A.button('确认修复唯一匹配', 'relay-history-apply', 'primary')
    );
  }
  function applyHistory() {
    const plan = reconciliation;
    if (!plan) {
      A.notify('请先检查历史邮件');
      return;
    }
    A.confirmAction(
      '确认修复历史邮件归属',
      '只处理预检中可唯一匹配的邮件，其他继续保持未分配。',
      () => {
        if (
          reconciliation !== plan ||
          actor().id !== plan.actorId ||
          parent(plan.id)?.version !== plan.version ||
          document.querySelector('#drawer')?.open === false
        ) {
          A.notify('预检窗口、人员或主邮箱已变化，请重新检查');
          return;
        }
        for (const item of plan.rows) {
          const row = mails.find((m) => m.id === item.id),
            matches = row && historyMatches(row);
          if (
            !row ||
            row.aliasId ||
            (row.version || 1) !== item.version ||
            (item.candidateId && (matches.length !== 1 || matches[0].id !== item.candidateId))
          ) {
            A.notify('邮件或候选地址已变化，本次未修复');
            return;
          }
        }
        let count = 0;
        for (const item of plan.rows.filter((r) => r.candidateId)) {
          const row = mails.find((m) => m.id === item.id);
          row.aliasId = item.candidateId;
          audit('修复历史邮件归属', row, item.candidate);
          count++;
        }
        if (count) audit('修复历史邮件归属', parent(plan.id), `已匹配 ${count} 封`);
        reconciliation = null;
        A.closeDrawer();
        A.render();
        A.notify(`已修复 ${count} 封演示邮件，其余保留未分配`);
      },
      '确认修复'
    );
  }
  function onClick(action, node) {
    if (!action.startsWith('relay-')) return false;
    initialize();
    const id = node.dataset.id,
      kind = node.dataset.kind;
    if (action === 'relay-parent-options-refresh') {
      const ctx = context, form = document.getElementById(`relay-${ctx?.kind}-form`);
      if (!form || !['alias', 'import'].includes(ctx?.kind)) return true;
      preserveDraft();
      void A.withActionFeedback(node, async () => {
        if (local && !await A.modules.inventory.refreshLocalInventory({ keepContent: true })) return false;
        if (context !== ctx || !form.isConnected) return false;
        if (ctx.kind === 'alias') openAliasEditor(ctx.id);
        else if (ctx.kind === 'intake') openAliasIntake();
        else openAliasImport();
        return true;
      }, { pending: '正在读取主邮箱…', success: '主邮箱已更新', failure: '主邮箱读取失败，输入已保留' });
    } else if (action === 'relay-retry') {
      void A.withActionFeedback(node, () => A.modules.inventory.refreshLocalInventory(),
        { pending: '正在读取隐藏邮箱资料…', success: '隐藏邮箱资料已重新读取', failure: '隐藏邮箱资料读取失败，请重试' });
      A.render();
    } else if (action === 'relay-service-retry') {
      void A.withActionFeedback(node, () => readConnection(),
        { pending: '正在读取收件服务状态…', success: '收件服务状态已重新读取', failure: '收件服务状态读取失败，请重试' });
    } else if (local && action === 'relay-primary-import') {
      importExistingPrimaries();
    } else if (action === 'relay-buyer-code-copy') {
      void copyBuyerCode(node);
    } else if (action === 'relay-buyer-code-retry') {
      const cell = node.closest('[data-relay-buyer-code]');
      if (cell) void loadBuyerCode(cell, { refresh: true });
    } else if (local && action === 'relay-live-code-read') {
      void readCurrentCode(kind, id, node);
    } else if (local && action === 'relay-live-code-reset') {
      openCodeReset(kind, id);
    } else if (local && action === 'relay-live-code-copy') {
      const code = document.getElementById('relay-code-result')?.textContent;
      if (code && !navigator.clipboard) A.notify('请选中查询码手动复制');
      if (code && navigator.clipboard)
        void navigator.clipboard.writeText(code).then(
          () => A.notify('查询码已复制', { kind: 'success' }),
          () => A.notify('复制失败，请选中查询码手动复制', { kind: 'error' })
        );
    } else if (local && (action === 'relay-parent-test' || action === 'relay-parent-sync')) {
      void runParentOperation(action === 'relay-parent-test' ? 'test' : 'sync', id);
    } else if (local && action === 'relay-live-history-preview') {
      void previewRemoteHistory(id);
    } else if (local && action === 'relay-health') {
      requestAliasHealth(id, node.dataset.health);
    } else if (local && /^relay-(?:sync-failure|history-|code-reset|status|delete)/.test(action)) {
      A.notify('该操作尚未接入');
    } else if (action === 'relay-reload') {
      const key = `apple-relay:${kind}:${id || 'new'}`;
      A.confirmAction(
        '重新载入当前资料',
        '将丢弃本条尚未保存的草稿，按最新资料重新打开。',
        () => {
          A.state.drafts.delete(key);
          A.state.drawerContext = '';
          const form = document.getElementById(`relay-${kind}-form`);
          form?.removeAttribute?.('data-relay-draft');
          if (kind === 'parent') openParentEditor(id);
          else if (kind === 'alias') openAliasEditor(id);
          else if (kind === 'reassign') reassign(id);
        },
        '重新载入'
      );
    } else if (action === 'relay-tab') {
      preserveDraft();
      view.tab = node.dataset.tab;
      view.q = '';
      A.state.page = 1;
      A.render();
      if (view.tab === 'mails') refreshMails();
    } else if (action === 'relay-inventory-status') {
      const { filter, value } = node.dataset;
      const allowed =
        filter === 'inventory' ? useOptions : filter === 'health' ? healthOptions : null;
      if (!allowed || (value !== '' && !allowed.some(([key]) => key === value))) return true;
      view[filter] = value;
      A.state.page = 1;
      A.render();
      document
        .querySelector(
          `[data-action="relay-inventory-status"][data-filter="${filter}"][data-value="${value}"]`
        )
        ?.focus({ preventScroll: true });
    } else if (action === 'relay-extraction-history') {
      A.go('workspace/extractions');
    } else if (action === 'relay-parent-add') openParentEditor();
    else if (action === 'relay-parent-edit') openParentEditor(id);
    else if (action === 'relay-alias-add') openAliasEditor('', node.dataset.parentId || '');
    else if (action === 'relay-alias-edit') openAliasEditor(id);
    else if (action === 'relay-import') openAliasImport(node.dataset.parentId || '');
    else if (action === 'relay-import-preview')
      previewImport(document.getElementById('relay-import-form'));
    else if (action === 'relay-intake') openAliasIntake();
    else if (action === 'relay-intake-preview') void previewIntake(document.getElementById('relay-intake-form'));
    else if (action === 'relay-parent-detail') openParentDetail(id);
    else if (action === 'relay-alias-detail') openAliasDetail(id);
    else if (action === 'relay-parent-more') more('parent', id, node);
    else if (action === 'relay-alias-more') more('alias', id, node);
    else if (action === 'relay-alias-bind') bindExistingAlias(id, node);
    else if (action === 'relay-mails') openMails(id);
    else if (action === 'relay-mail-refresh') void A.withActionFeedback(node, () => refreshMails(),
      { pending: '正在读取收件记录…', success: '收件记录已刷新', failure: '收件记录读取失败，请重试' });
    else if (action === 'relay-mail-detail') mailDetail(id);
    else if (action === 'relay-mail-reassign') reassign(id);
    else if (action === 'relay-import-detail') openImportDetail(id);
    else if (action === 'relay-parent-test') {
      const p = parent(id);
      if (p && p.status === 'ACTIVE') {
        p.connection = p.hasCredential ? '模拟测试通过，未连接 IMAP' : '未配置专用密码';
        audit('模拟连接测试', p);
        A.notify(p.connection);
        A.render();
      } else A.notify('主邮箱不可用');
    } else if (action === 'relay-sync-failure') {
      const p = parent(id);
      if (p) {
        p.simulateSyncFailure = !p.simulateSyncFailure;
        A.notify(
          p.simulateSyncFailure
            ? '已切换模拟同步失败，可查询检验旧结果保留'
            : '模拟连接已恢复，可重试'
        );
        more('parent', id);
      }
    } else if (action === 'relay-history-preview') historyPreview(id);
    else if (action === 'relay-history-apply') applyHistory();
    else if (action === 'relay-parent-sync') {
      const result = syncParent(id);
      A.notify(result.message);
      A.render();
    } else if (
      action === 'relay-code-reset' ||
      action === 'relay-status' ||
      action === 'relay-delete'
    ) {
      const row = kind === 'parent' ? parent(id) : alias(id);
      if (!row) return true;
      const version = row.version,
        who = actor();
      A.confirmAction(
        action === 'relay-code-reset'
          ? '确认重置查询码'
          : action === 'relay-status'
            ? '确认调整邮箱状态'
            : '确认删除演示资料',
        '保留历史和操作记录；有业务引用时不会删除。',
        () => {
          const current = kind === 'parent' ? parent(id) : alias(id);
          if (!current || current.version !== version || actor().id !== who.id) {
            A.notify('资料或身份已变化，本次未操作');
            return;
          }
          if (action === 'relay-delete') {
            const referenced =
              kind === 'parent'
                ? mailboxes.some((a) => a.type === 'relay' && a.parentMailboxId === id) ||
                  mails.some((m) => m.parentId === id)
                : row.inventoryState !== 'available' ||
                  row.usageLinks.length ||
                  row.importId ||
                  imports.some((batch) => batch.results.some((r) => r.assetId === id)) ||
                  A.modules.inventory?.hasMailboxHistory?.(id) ||
                  mails.some((m) => m.aliasId === id);
            if (referenced) {
              A.notify('仍有隐藏邮箱、邮件或库存使用引用，不能删除；可改为禁用');
              return;
            }
            if (kind === 'parent') row.deleted = true;
            else {
              row.relayDeleted = true;
              row.relayStatus = 'DISABLED';
            }
            audit('移除邮箱资料', row);
          } else if (action === 'relay-code-reset') {
            row.queryCode = code(kind === 'parent' ? 'MAIN' : 'ALIAS');
            row.queryExpiry = expiry(kind === 'parent' ? row.days : row.codeResetIntervalDays);
            audit('重置查询码', row);
          } else {
            if (kind === 'parent') row.status = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
            else row.relayStatus = row.relayStatus === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
            audit('调整邮箱状态', row);
          }
          const drawer = document.querySelector('#drawer');
          if (drawer?.open) drawer.close();
          A.state.drawerContext = '';
          A.render();
          A.notify('演示记录已更新');
        },
        '确认操作'
      );
    } else return false;
    return true;
  }
  function onSubmit(form) {
    if (local && form.id === 'relay-live-code-form') void prepareCodeReset(form);
    else if (local && form.id === 'relay-live-assignment-form') void prepareLiveAssignment(form);
    else if (form.id === 'relay-parent-form') saveParent(form);
    else if (form.id === 'relay-alias-form') saveAlias(form);
    else if (form.id === 'relay-import-form') saveImport(form);
    else if (form.id === 'relay-intake-form') saveIntake(form);
    else if (form.id === 'relay-query-form') queryMail(form);
    else if (form.id === 'relay-reassign-form' && !local) saveReassign(form);
    else return false;
    return true;
  }
  async function readImportFile(node) {
    const file = node.files?.[0],
      form = document.getElementById('relay-import-form'),
      ctx = context;
    const readVersion = ++fileReadVersion;
    if (!file || !form || ctx?.kind !== 'import') return;
    if (file.size > 1048576) {
      fail('file', 'CSV 文件不能超过 1MB');
      return;
    }
    if (!/\.csv$/i.test(file.name || '')) {
      fail('file', '请选择 CSV 文件');
      return;
    }
    const original = fingerprint(A.readForm(form));
    try {
      const text = await file.text();
      if (
        readVersion !== fileReadVersion ||
        context !== ctx ||
        document.getElementById('relay-import-form') !== form ||
        document.querySelector('#drawer')?.open === false ||
        fingerprint(A.readForm(form)) !== original
      ) {
        A.notify('文件读取期间入口或内容已变化，未覆盖当前输入');
        return;
      }
      const control = document.getElementById('relay-content');
      if (control) control.value = text;
      preview = null;
      const output = document.getElementById('relay-import-preview');
      if (output) output.innerHTML = '';
      preserveDraft();
      A.setError('relay-file', '');
      A.notify('已读取 CSV，请核对主邮箱并重新预检');
    } catch {
      if (context === ctx && readVersion === fileReadVersion)
        fail('file', 'CSV 文件读取失败，请重新选择；原输入已保留');
    }
  }
  function onChange(node) {
    if (!node.id.startsWith('relay-')) return false;
    if (node.id === 'relay-file') {
      void readImportFile(node);
    } else if (node.id === 'relay-parent-choice') {
      updateParentChoice(node, true);
    } else if (node.id === 'relay-filter-parent') {
      view.parentId = node.value;
      view.aliasId = '';
      A.state.page = 1;
      A.render();
      if (view.tab === 'mails') refreshMails(!local);
    } else if (node.id === 'relay-filter-alias') {
      view.aliasId = node.value;
      A.state.page = 1;
      A.render();
      if (view.tab === 'mails') refreshMails(!local);
    } else if (node.id === 'relay-filter-assignment') {
      view.assignment = node.value;
      A.state.page = 1;
      A.render();
      if (view.tab === 'mails') refreshMails(!local);
    } else preserveDraft();
    return true;
  }
  function onInput(node) {
    if (!node.id.startsWith('relay-')) return false;
    if (node.id === 'relay-parent-choice') {
      updateParentChoice(node);
    } else if (node.id === 'relay-search') {
      const cursor = node.selectionStart;
      view.q = node.value;
      A.state.page = 1;
      if (view.tab === 'mails' && !local) refreshMails();
      else A.render();
      const search = document.getElementById(node.id);
      search?.focus();
      search?.setSelectionRange(cursor, cursor);
    } else if (node.id === 'relay-query') {
      view.query = node.value;
      view.result = null;
      if (local) {
        remote.queryRequest++;
        remote.querying = false;
        const submit = node.form?.querySelector('button[type="submit"]');
        if (submit) {
          submit.disabled = false;
          submit.textContent = '同步并查询';
        }
      }
      const result = document.getElementById('relay-query-output');
      if (result) result.innerHTML = '';
    } else preserveDraft();
    return true;
  }
  A.modules.appleRelay = {
    refreshConnection: readConnection,
    displayId,
    displayImportId,
    render,
    openQuery() {
      A.closeDrawer();
      view.tab = 'query';
      A.go('mailboxes/relay');
    },
    openAliasEditor,
    openAliasImport,
    openAliasDetail,
    openMails,
    openParentDetail,
    listParents: () => {
      initialize();
      return parents.filter((p) => !p.deleted);
    },
    getParent: (id) => {
      initialize();
      return parent(id);
    },
    isAvailable,
    listImports: () => imports,
    openImportDetail
  };
  window.IDDesignModules.push({
    id: 'apple-relay',
    matches: (route) => route === 'mailboxes/relay',
    render,
    afterRender: hydrateBuyerCodes,
    onClick,
    onSubmit,
    onInput,
    onChange,
    preserveDraft
  });
})();
