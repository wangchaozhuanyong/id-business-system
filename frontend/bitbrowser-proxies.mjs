import { parseBitBrowserProxyInput, bitBrowserProxySettings } from '/assets/bitbrowser/proxy-input.mjs';
import { testBitBrowserProxy } from '/assets/bitbrowser/proxy-test.mjs';
import { bitBrowserCountryOptions, resolveBitBrowserCountry, bitBrowserCountryName as countryName } from '/assets/bitbrowser/countries.mjs';
const kinds = { mobile: '移动 IP', dynamic_residential: '动态住宅', static_residential: '静态住宅' };
const protocolName = value => ({ socks5: 'SOCKS5', http: 'HTTP', https: 'HTTPS' })[value] || '自动识别';
const fields = ['name', 'country', 'kind', 'mode', 'protocol'];
export function initializeExecutionProxies({ get, drafts, onChange, locked, onUse, connection }) {
  const select = get('bit-execution-proxy'), editor = get('bit-proxy-editor');
  const defaultButton = get('bit-default-proxy');
  const sourceGet = get, editorHome = editor.parentNode;
  // Keep the original controls and listeners when the same-origin host owns the modal.
  get = id => editor.querySelector(`#${id}`) || sourceGet(id);
  const message = get('bit-proxy-result'), saveMessage = get('bit-ip-save-result');
  const search = get('bit-ip-search'), filter = get('bit-ip-filter'), sort = get('bit-ip-sort');
  const pagination = get('bit-ip-pagination');
  const { defaultPageSize, pageSizes } = window.IDPagination;
  let pageSize = defaultPageSize, renderedPagination;
  const countryInput = get('bit-ip-country');
  get('bit-ip-countries').replaceChildren(...bitBrowserCountryOptions.map(({ code, name }) => new Option(code, name)));
  countryInput.addEventListener('change', () => {
    const code = resolveBitBrowserCountry(countryInput.value);
    if (code) countryInput.value = countryName(code);
  });
  let data, saving = false, probing = false, probeLoading = false, reading = false, generation = 0, alive = true, editingId = '', editVersion = 0, page = 1, opener;
  const pending = new Set(), probeResults = new Map();
  const probeSummary = ({ ip, countryCode, latencyMs, protocol }) => ({ ip, countryCode, latencyMs, protocol, status: 'usable' });
  let batch, editorProbe, probeController, editReadController, editReadGeneration = 0, editLoading = false;
  const readDraft = () => drafts?.read('bit-local') || {};
  const draftKey = () => `ip-draft/${editingId || 'new'}/`;
  const ready = () => Boolean(!reading && !saving && !probing && !probeLoading && !batch && !editor.open && data?.items?.some(item => item.id === select.value));
  function setMessage(text) { message.textContent = text; get('bit-library-result').textContent = text; }
  function syncActions() {
    const busy = saving || probing || probeLoading || Boolean(batch) || locked();
    get('bit-test-all-proxies').disabled = batch ? batch.controller.signal.aborted : busy || reading || editor.open || !data?.items.length;
    get('bit-test-all-proxies').textContent = batch ? (batch.controller.signal.aborted ? '正在停止' : '停止检测') : '检测全部';
    get('bit-refresh-proxies').disabled = busy || reading;
    for (const id of ['bit-add-proxy', 'bit-library-add']) get(id).disabled = busy;
    select.disabled = !data || busy;
    defaultButton.disabled = select.disabled || reading || !select.value;
    defaultButton.textContent = select.value && select.value === data?.defaultId ? '取消默认' : '设为默认';
  }
  function capture() {
    const values = readDraft(); values['bit-execution-proxy'] = select.value;
    values['ip-search'] = search.value; values['ip-filter'] = filter.value; values['ip-sort'] = sort.value; values['ip-page'] = String(page);
    values['ip-page-size'] = String(pageSize);
    if (editor.open) {
      for (const field of fields) values[draftKey() + field] = get('bit-ip-' + field).value;
      values[draftKey() + 'version'] = String(editVersion);
    }
    drafts?.write('bit-local', values);
  }
  const initial = readDraft(); search.value = initial['ip-search'] || ''; filter.value = initial['ip-filter'] || ''; sort.value = initial['ip-sort'] || 'recent'; page = Number(initial['ip-page']) || 1;
  const savedPageSize = Number(initial['ip-page-size']);
  if (pageSizes.includes(savedPageSize)) pageSize = savedPageSize;
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = (data?.items || []).filter(item => (!filter.value || item.kind === filter.value) &&
      `${item.name} ${countryName(item.countryCode)} ${item.countryCode} ${item.endpoint}`.toLocaleLowerCase().includes(query));
    if (sort.value === 'recent') items.reverse();
    else items.sort((a,b) => (sort.value === 'country' ? countryName(a.countryCode).localeCompare(countryName(b.countryCode), 'zh-Hans') : a.name.localeCompare(b.name, 'zh-Hans')) || a.id.localeCompare(b.id));
    const pages = Math.max(1, Math.ceil(items.length / pageSize)); page = Math.min(Math.max(1, page), pages);
    const rows = items.slice((page - 1) * pageSize, page * pageSize).map(item => {
      const row = document.createElement('tr'); row.setAttribute('aria-selected', String(item.id === select.value));
      for (const value of [item.name, item.countryCode ? `${countryName(item.countryCode)} ${item.countryCode}` : '自动识别', kinds[item.kind], probeResults.has(item.id) ? (probeResults.get(item.id).status === 'usable' ? `可用 · ${probeResults.get(item.id).latencyMs}ms` : probeResults.get(item.id).status === 'failed' ? '检测未通过' : probeResults.get(item.id).status === 'testing' ? '检测中' : '未完成检测') : '未测试', `${item.endpoint} · ${protocolName(item.protocol)} · ${item.mode === 'dynamic' ? 'API 提取' : '代理地址'}`]) {
        const cell = document.createElement('td'); cell.textContent = value; cell.title = value; row.append(cell);
      }
      const cell = document.createElement('td'), actions = document.createElement('div'); actions.className = 'bit-local__actions';
      for (const [label, action] of [[item.id === select.value ? '已选用' : '使用', () => use(item.id)], ['测试', () => void testSaved(item)], ['编辑', () => openEditor(item)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = label;
        button.disabled = saving || probing || probeLoading || Boolean(batch) || locked(); button.addEventListener('click', action); actions.append(button);
      }
      cell.append(actions); row.append(cell); return row;
    });
    get('bit-ip-rows').replaceChildren(...rows);
    get('bit-ip-empty').hidden = Boolean(items.length);
    get('bit-ip-empty').textContent = !data ? 'IP 列表暂不可用，请刷新重试。' : data.items.length ? '没有匹配的 IP，请调整搜索或筛选。' : '还没有保存 IP，点击右上角“新增 IP”录入。';
    get('bit-ip-count').textContent = data ? String(data.items.length) : '—';
    const nextPagination = window.IDPagination.render({ id: 'bit-ip', page, pageSize, total: items.length });
    if (nextPagination !== renderedPagination) {
      pagination.innerHTML = nextPagination;
      renderedPagination = nextPagination;
    }
    syncActions();
  }
  function render(preferred = select.value) {
    select.replaceChildren(new Option(data?.items.length ? '请选择执行 IP' : '暂无 IP，请先新增', ''),
      ...(data?.items || []).map(item => new Option(`${item.name}${item.id === data.defaultId ? '（我的默认）' : ''} · ${item.countryCode ? countryName(item.countryCode) : '国家自动识别'} · ${kinds[item.kind]} · ${item.endpoint}`, item.id)));
    select.value = data?.items.some(item => item.id === preferred) ? preferred : '';
    renderList(); onChange();
  }
  async function request(method = 'GET', body, signal) {
    const controller = new AbortController(); pending.add(controller);
    try {
      const response = await fetch('/api/local/bitbrowser-proxies', { method, cache: 'no-store', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || 'IP 操作失败，请重试'); error.status = response.status; throw error; }
      if (method === 'PATCH') {
        if (result?.defaultId !== body.defaultId) throw new Error('无法确认默认 IP 已保存，请刷新后核对。');
        return result;
      }
      if (method !== 'POST' && (!Number.isSafeInteger(result.version) || !Array.isArray(result.items) ||
        !result.items.every(item => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.endpoint === 'string' &&
          /^(?:[A-Z]{2})?$/.test(item.countryCode) && Object.hasOwn(kinds, item.kind)) ||
        (method === 'PUT' && !result.items.some(item => item.id === result.savedId)))) throw new Error('IP 列表返回不完整，请刷新重试；输入已保留。');
      return result;
    } finally { pending.delete(controller); }
  }
  async function refresh() {
    if (saving || probing || batch || locked()) return;
    const revision = ++generation; reading = true; onChange(); get('bit-refresh-proxies').disabled = true;
    setMessage('正在读取 IP 列表…');
    try {
      const result = await request(); if (!alive || revision !== generation) return;
      const preferred = data ? select.value : readDraft()['bit-execution-proxy'] ?? result.defaultId;
      data = result; render(preferred); setMessage(data.items.length ? `已保存 ${data.items.length} 个 IP，可直接选择使用。` : '暂无 IP，点击“新增 IP”录入代理链接。');
    } catch (error) { if (alive && revision === generation) { setMessage(error.message); renderList(); } }
    finally { if (revision === generation) { reading = false; syncActions(); onChange(); } }
  }
  function use(id) {
    if (saving || probing || batch || locked()) return;
    select.value = id; capture(); renderList(); onChange(); onUse?.(); select.focus();
  }
  select.addEventListener('change', () => { capture(); renderList(); onChange(); });
  defaultButton.addEventListener('click', async () => {
    if (defaultButton.disabled || locked()) return;
    const defaultId = select.value === data.defaultId ? null : select.value;
    saving = true; syncActions(); onChange();
    setMessage('正在保存个人默认执行 IP…');
    try {
      const result = await request('PATCH', { defaultId });
      if (!alive) return;
      data.defaultId = result.defaultId;
      render();
      setMessage(defaultId ? '已设为我的默认执行 IP。' : '已取消默认执行 IP。');
    } catch (error) { if (alive) setMessage(error.message); }
    finally { saving = false; if (alive) { renderList(); onChange(); } }
  });
  for (const control of [search, filter, sort]) control.addEventListener(control === search ? 'input' : 'change', () => { page = 1; renderList(); capture(); });
  document.addEventListener('id-pagination-change', ({ detail }) => {
    if (detail?.id !== 'bit-ip') return;
    page = detail.page;
    pageSize = detail.pageSize;
    renderList();
    get('bit-ip-rows').closest('.table-viewport').scrollTop = 0;
    capture();
  });
  get('bit-refresh-proxies').addEventListener('click', refresh);
  function mountEditor() {
    try {
      if (window.parent !== window &&
          window.frameElement?.matches('.recharge-integration__frame--bit-local'))
        window.parent.document.body.append(editor);
    } catch { /* Standalone or cross-origin embedding retains its own modal. */ }
  }
  function restoreEditor() {
    if (editor.parentNode === editorHome) return;
    if (editorHome.isConnected) editorHome.append(editor);
    else editor.remove();
  }
  function finishEditor() { editReadGeneration++; editReadController?.abort(); editLoading = false; editor.close(); restoreEditor(); }
  function openEditor(item) {
    if (locked() || saving || probing || probeLoading || batch) return;
    editReadController?.abort(); const readGeneration = ++editReadGeneration;
    editingId = item?.id || ''; editVersion = data?.version ?? 0; opener = document.activeElement;
    const draft = readDraft(), prefix = draftKey();
    const defaults = { name: item?.name || '', country: item?.countryCode ? countryName(item.countryCode) : '', kind: item?.kind || 'dynamic_residential', mode: item?.mode || 'auto', protocol: item?.protocol || 'auto' };
    for (const field of fields) get('bit-ip-' + field).value = draft[prefix + field] ?? defaults[field];
    if (/^\d+$/.test(draft[prefix + 'version'] || '')) editVersion = Number(draft[prefix + 'version']);
    editorProbe = undefined; get('bit-ip-probe-result').textContent = '尚未测试代理。'; get('bit-ip-advanced').open = false;
    get('bit-proxy-editor-title').textContent = item ? '编辑执行 IP' : '新增执行 IP';
    get('bit-ip-save').textContent = item ? '确认保存修改' : '保存并使用';
    get('bit-ip-link').value = ''; get('bit-ip-link').placeholder = item ? '正在读取已保存的代理链接…' : '直接粘贴购买平台生成的代理信息';
    get('bit-ip-link-required').hidden = Boolean(item);
    get('bit-ip-edit-note').textContent = item ? `已保存地址：${item.endpoint}。修改仅影响后续使用；进行中的任务不受影响。` : '保存后会自动选中这个 IP，可在 IP 资料库再次查看和编辑。';
    saveMessage.textContent = ''; get('bit-ip-rebase').hidden = true;
    mountEditor(); editor.showModal(); editor.querySelector('.bit-local__drawer-body').scrollTop = 0;
    onChange(); syncActions(); get('bit-ip-name').focus({ preventScroll: true });
    editLoading = Boolean(item); get('bit-ip-save').disabled = editLoading; get('bit-ip-test').disabled = editLoading;
    if (item) {
      editReadController = new AbortController();
      void request('POST', { id: item.id, version: editVersion }, editReadController.signal).then(proxy => {
        try {
          if (alive && editor.open && readGeneration === editReadGeneration && editingId === item.id && !get('bit-ip-link').value)
            get('bit-ip-link').value = proxy.link;
        } finally { proxy.link = ''; }
      }).catch(error => {
        if (alive && editor.open && readGeneration === editReadGeneration) {
          saveMessage.textContent = error.message; get('bit-ip-rebase').hidden = error.status !== 409;
        }
      }).finally(() => {
        if (readGeneration !== editReadGeneration) return;
        editLoading = false; editReadController = undefined;
        get('bit-ip-link').placeholder = '粘贴新的代理链接可替换；留空保留原链接';
        get('bit-ip-save').disabled = false; get('bit-ip-test').disabled = false;
      });
    }
  }
  for (const id of ['bit-add-proxy', 'bit-library-add']) get(id).addEventListener('click', () => openEditor());
  editor.addEventListener('input', event => {
    capture();
    if (['bit-ip-link', 'bit-ip-protocol', 'bit-ip-mode'].includes(event.target.id)) { editorProbe = undefined; get('bit-ip-probe-result').textContent = '代理资料已修改，请重新测试。'; }
  }); editor.addEventListener('change', capture);
  editor.addEventListener('close', () => { restoreEditor(); editorProbe = undefined; syncActions(); onChange(); if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  function close() { if (!saving && !probing && !probeLoading) { capture(); get('bit-ip-link').value = ''; finishEditor(); } }
  for (const id of ['bit-ip-close', 'bit-ip-dismiss']) get(id).addEventListener('click', close);
  editor.addEventListener('cancel', event => { event.preventDefault(); close(); });
  get('bit-ip-rebase').addEventListener('click', async () => {
    if (saving || probing) return;
    get('bit-ip-rebase').disabled = true;
    try {
      const result = await request(); if (!alive) return;
      const current = result.items.find(item => item.id === editingId);
      if (editingId && !current) throw new Error('该 IP 已不存在。输入已保留，请关闭后新增。');
      data = result; editVersion = result.version; capture(); render();
      saveMessage.textContent = current ? `最新资料：${current.name} · ${countryName(current.countryCode)} · ${kinds[current.kind]} · ${current.endpoint}。你的输入已保留，请核对后再确认保存。` : '已读取最新列表，输入已保留，可以重新保存。';
      get('bit-ip-rebase').hidden = true;
    } catch (error) { saveMessage.textContent = error.message; }
    finally { get('bit-ip-rebase').disabled = false; }
  });
  async function runProbe(proxy, { signal, settings = connection?.() } = {}) {
    if (probing || locked()) throw new Error('已有任务正在执行，请稍候再测试。');
    if (!settings?.token) throw new Error('请先选择可用的比特账号连接，再测试代理。');
    probeController = new AbortController(); probing = true; onChange(); renderList();
    for (const control of editor.querySelectorAll('input,select,button')) control.disabled = true;
    try { return await testBitBrowserProxy({ ...proxy, ...settings, signal: signal ? AbortSignal.any([probeController.signal, signal]) : probeController.signal }); }
    finally {
      probing = false; probeController = undefined;
      for (const control of editor.querySelectorAll('input,select,button')) control.disabled = false;
      renderList(); onChange();
    }
  }
  async function probeEditor() {
    let link = get('bit-ip-link').value.trim();
    probeLoading = true; onChange();
    get('bit-ip-test').disabled = true; get('bit-ip-save').disabled = true;
    get('bit-ip-probe-result').textContent = '正在通过当前比特浏览器测试代理，单次最多等待 30 秒…';
    try {
      if (!link && editingId) link = (await request('POST', { id: editingId, version: editVersion })).link;
      const result = await runProbe({ link, protocol: get('bit-ip-protocol').value, mode: get('bit-ip-mode').value });
      if (!alive) throw new Error('页面已关闭。');
      editorProbe = result;
      if (result.countryCode && !countryInput.value.trim()) countryInput.value = countryName(result.countryCode);
      get('bit-ip-probe-result').textContent = `代理可用 · 出口 ${result.ip} · ${result.countryCode ? countryName(result.countryCode) : '国家未识别'} · ${result.latencyMs}ms · ${protocolName(result.protocol)}`;
      return result;
    } catch (error) { get('bit-ip-probe-result').textContent = error.message; throw error; }
    finally { link = ''; probeLoading = false; get('bit-ip-test').disabled = false; get('bit-ip-save').disabled = false; onChange(); }
  }
  get('bit-ip-test').addEventListener('click', () => { if (!saving && !probing && !probeLoading && !batch && !editLoading && !locked()) void probeEditor().catch(() => {}); });
  async function testSaved(item) {
    if (saving || probing || batch || locked()) return;
    if (probeLoading) return;
    probeLoading = true; renderList(); onChange();
    setMessage(`正在测试“${item.name}”…`);
    let proxy;
    try {
      proxy = await request('POST', { id: item.id, version: data.version });
      const result = await runProbe(proxy); if (!alive) return;
      probeResults.set(item.id, probeSummary(result)); renderList();
      setMessage(`代理可用 · 出口 ${result.ip} · ${result.countryCode ? countryName(result.countryCode) : '国家未识别'} · ${result.latencyMs}ms · ${protocolName(result.protocol)}`);
    } catch (error) { probeResults.set(item.id, { status: error.reason === 'proxy_unavailable' ? 'failed' : 'incomplete' }); renderList(); setMessage(error.message); }
    finally { if (proxy) proxy.link = ''; probeLoading = false; renderList(); onChange(); }
  }
  function stopBatch(reason = '已手动停止') {
    if (!batch) return;
    batch.reason = reason; batch.controller.abort(); syncActions();
    setMessage('正在停止检测，已完成的结果将保留…');
  }
  for (const id of ['bit-connection-profile', 'bit-local-url', 'bit-local-token'])
    get(id)?.addEventListener(id === 'bit-connection-profile' ? 'change' : 'input', () => stopBatch('比特连接已变化，已停止'));
  function waitForBatch(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  get('bit-test-all-proxies').addEventListener('click', async () => {
    if (batch) { stopBatch(); return; }
    if (saving || probing || probeLoading || reading || editor.open || locked() || !data?.items.length) return;
    const settings = { ...connection?.() };
    if (!settings.token) { setMessage('请先选择可用的比特账号连接，再检测全部 IP。'); return; }
    const items = [...data.items], version = data.version;
    const job = { controller: new AbortController(), completed: 0, usable: 0, failed: 0, incomplete: 0, reason: '' };
    const counts = () => `已完成 ${job.completed}/${items.length}，可用 ${job.usable}，未通过 ${job.failed}，未完成 ${job.incomplete}`;
    const connectionChanged = () => { const current = connection?.(); return settings.url !== current?.url || settings.token !== current?.token; };
    batch = job; renderList(); onChange(); let nextExtractionAt = 0;
    try {
      for (const item of items) {
        if (job.controller.signal.aborted || !alive) break;
        if (connectionChanged()) { job.reason = '比特连接已变化，已停止'; break; }
        let proxy;
        try {
          // The extraction relay permits 20 requests/minute per user; do not burst it.
          if (item.mode === 'dynamic' && Date.now() < nextExtractionAt) {
            setMessage(`正在等待提取间隔 · ${counts()}`);
            await waitForBatch(nextExtractionAt - Date.now(), job.controller.signal);
          }
          job.controller.signal.throwIfAborted();
          probeResults.set(item.id, { status: 'testing' }); renderList();
          setMessage(`正在检测“${item.name}” · ${counts()}`);
          proxy = await request('POST', { id: item.id, version }, job.controller.signal);
          if (connectionChanged()) { job.reason = '比特连接已变化，已停止'; throw new Error(job.reason); }
          if (item.mode === 'dynamic') nextExtractionAt = Date.now() + 3100;
          const result = await runProbe(proxy, { signal: job.controller.signal, settings });
          job.controller.signal.throwIfAborted();
          probeResults.set(item.id, probeSummary(result)); job.usable++;
        } catch (error) {
          probeResults.set(item.id, { status: error.reason === 'proxy_unavailable' ? 'failed' : 'incomplete' });
          if (job.controller.signal.aborted || !alive) break;
          if (error.reason === 'proxy_unavailable') job.failed++; else job.incomplete++;
          if (!proxy || connectionChanged() || [401, 403, 409, 429].includes(error.status) ||
              ['bitbrowser_direct_token_invalid', 'bitbrowser_direct_unreachable', 'bitbrowser_secure_context_required'].includes(error.reason)) {
            job.reason ||= `已停止：${error.message}`;
          }
        } finally { if (proxy) proxy.link = ''; }
        job.completed++; renderList();
        if (job.reason) break;
      }
      if (alive) setMessage(`${job.reason || (job.controller.signal.aborted ? '已停止检测' : '检测全部完成')} · ${counts()}${job.completed < items.length ? `；其余 ${items.length - job.completed} 条未检测完。` : '。'}`);
    } finally {
      settings.token = '';
      if (batch === job) batch = undefined;
      if (alive) { renderList(); onChange(); }
    }
  });
  get('bit-ip-save').addEventListener('click', async () => {
    if (saving || probing || probeLoading || batch || editLoading || locked()) return;
    if (!data) { saveMessage.textContent = '请先关闭并刷新 IP 列表，输入已保留。'; return; }
    let parsed;
    const rawLink = get('bit-ip-link').value.trim();
    const prior = data.items.find(item => item.id === editingId);
    const country = countryInput.value.trim();
    if (country && !resolveBitBrowserCountry(country)) { saveMessage.textContent = '国家无法识别，请填写中文国家名，或留空自动识别。'; get('bit-ip-advanced').open = true; countryInput.focus(); return; }
    if (!get('bit-ip-name').value.trim() || (!editingId && !rawLink)) { saveMessage.textContent = '请填写备注名称和代理链接。'; return; }
    try {
      if (rawLink) {
        parsed = parseBitBrowserProxyInput(rawLink, { mode: get('bit-ip-mode').value, protocol: get('bit-ip-protocol').value });
        if (parsed.automaticProtocol) {
          const result = editorProbe || await probeEditor();
          parsed = parseBitBrowserProxyInput(result.link, { mode: result.mode, protocol: result.protocol });
        } else if (editorProbe) parsed.protocol = editorProbe.protocol;
      }
    } catch (error) { saveMessage.textContent = error.message; return; }
    const body = { ...(editingId && { id: editingId }), version: editVersion, name: get('bit-ip-name').value,
      countryCode: resolveBitBrowserCountry(country) || editorProbe?.countryCode || '', kind: get('bit-ip-kind').value,
      mode: parsed?.mode || prior?.mode, protocol: parsed?.protocol || prior?.protocol, link: parsed?.link || '' };
    const prefix = draftKey(); capture(); const snapshot = readDraft();
    saving = true; reading = false; generation++; onChange();
    for (const control of editor.querySelectorAll('input,select,button')) control.disabled = true;
    saveMessage.textContent = '正在保存 IP…';
    try {
      const result = await request('PUT', body); if (!alive) return;
      data = result; probeResults.delete(result.savedId); if (editorProbe) probeResults.set(result.savedId, probeSummary(editorProbe)); render(result.savedId);
      const latest = readDraft();
      for (const key of Object.keys(snapshot)) if (key.startsWith(prefix) && latest[key] === snapshot[key]) delete latest[key];
      latest['bit-execution-proxy'] = result.savedId; drafts?.write('bit-local', latest);
      get('bit-ip-link').value = ''; finishEditor(); setMessage('IP 已保存并选中。'); onUse?.();
    } catch (error) { if (alive) { saveMessage.textContent = error.message; get('bit-ip-rebase').hidden = error.status !== 409; } }
    finally {
      body.link = ''; saving = false;
      for (const control of editor.querySelectorAll('input,select,button')) control.disabled = false;
      get('bit-refresh-proxies').disabled = false; renderList(); onChange();
    }
  });
  window.addEventListener('pagehide', () => { alive = false; batch?.controller.abort(); editReadGeneration++; editReadController?.abort(); probeController?.abort(); for (const controller of pending) controller.abort(); get('bit-ip-link').value = ''; if (editor.open) finishEditor(); restoreEditor(); });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.source === 'id-recharge-shell' && event.data.type === 'visibility' && !event.data.visible) { stopBatch('离开比特页面，已停止'); probeController?.abort(); editorProbe = undefined; get('bit-ip-link').value = ''; if (!saving && editor.open) finishEditor(); }
  });
  return { ready, refresh, editing: () => editor.open || Boolean(batch), async settings(signal) {
    if (!ready()) throw new Error('请先选择有效的执行 IP');
    const id = select.value, version = data.version;
    const proxy = await request('POST', { id, version }, signal);
    if (signal.aborted || id !== select.value || version !== data.version) throw new Error('执行 IP 已变化，请重新开始');
    try { return bitBrowserProxySettings(proxy); } finally { proxy.link = ''; }
  } };
}
