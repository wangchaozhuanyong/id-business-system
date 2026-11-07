import { parseBitBrowserProxyInput, bitBrowserProxySettings } from '/assets/bitbrowser/proxy-input.mjs';
import { testBitBrowserProxy } from '/assets/bitbrowser/proxy-test.mjs';
import { bitBrowserCountryOptions, resolveBitBrowserCountry, bitBrowserCountryName as countryName } from '/assets/bitbrowser/countries.mjs';
const kinds = { mobile: '移动 IP', dynamic_residential: '动态住宅', static_residential: '静态住宅' };
const fields = ['name', 'country', 'kind', 'mode', 'protocol'];
export function initializeExecutionProxies({ get, drafts, onChange, locked, onUse, connection }) {
  const select = get('bit-execution-proxy'), editor = get('bit-proxy-editor');
  const message = get('bit-proxy-result'), saveMessage = get('bit-ip-save-result');
  const search = get('bit-ip-search'), filter = get('bit-ip-filter'), sort = get('bit-ip-sort');
  const countryInput = get('bit-ip-country');
  get('bit-ip-countries').replaceChildren(...bitBrowserCountryOptions.map(({ code, name }) => new Option(code, name)));
  countryInput.addEventListener('change', () => {
    const code = resolveBitBrowserCountry(countryInput.value);
    if (code) countryInput.value = countryName(code);
  });
  let data, saving = false, probing = false, probeLoading = false, reading = false, generation = 0, alive = true, editingId = '', editVersion = 0, page = 1, opener;
  const pending = new Set(), probeResults = new Map();
  const probeSummary = ({ ip, countryCode, latencyMs, protocol }) => ({ ip, countryCode, latencyMs, protocol });
  let editorProbe, probeController;
  const readDraft = () => drafts?.read('bit-local') || {};
  const draftKey = () => `ip-draft/${editingId || 'new'}/`;
  const ready = () => Boolean(!reading && !saving && !probing && !probeLoading && !editor.open && data?.items?.some(item => item.id === select.value));
  function setMessage(text) { message.textContent = text; get('bit-library-result').textContent = text; }
  function capture() {
    const values = readDraft(); values['bit-execution-proxy'] = select.value;
    values['ip-search'] = search.value; values['ip-filter'] = filter.value; values['ip-sort'] = sort.value; values['ip-page'] = String(page);
    if (editor.open) {
      for (const field of fields) values[draftKey() + field] = get('bit-ip-' + field).value;
      values[draftKey() + 'version'] = String(editVersion);
    }
    drafts?.write('bit-local', values);
  }
  const initial = readDraft(); search.value = initial['ip-search'] || ''; filter.value = initial['ip-filter'] || ''; sort.value = initial['ip-sort'] || 'recent'; page = Number(initial['ip-page']) || 1;
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = (data?.items || []).filter(item => (!filter.value || item.kind === filter.value) &&
      `${item.name} ${countryName(item.countryCode)} ${item.countryCode} ${item.endpoint}`.toLocaleLowerCase().includes(query));
    if (sort.value === 'recent') items.reverse();
    else items.sort((a,b) => (sort.value === 'country' ? countryName(a.countryCode).localeCompare(countryName(b.countryCode), 'zh-Hans') : a.name.localeCompare(b.name, 'zh-Hans')) || a.id.localeCompare(b.id));
    const pages = Math.max(1, Math.ceil(items.length / 5)); page = Math.min(Math.max(1, page), pages);
    const rows = items.slice((page - 1) * 5, page * 5).map(item => {
      const row = document.createElement('tr'); row.setAttribute('aria-selected', String(item.id === select.value));
      for (const value of [item.name, item.countryCode ? `${countryName(item.countryCode)} ${item.countryCode}` : '自动识别', kinds[item.kind], probeResults.has(item.id) ? `可用 · ${probeResults.get(item.id).latencyMs}ms` : '未测试', item.endpoint]) {
        const cell = document.createElement('td'); cell.textContent = value; cell.title = value; row.append(cell);
      }
      const cell = document.createElement('td'), actions = document.createElement('div'); actions.className = 'bit-local__actions';
      for (const [label, action] of [[item.id === select.value ? '已选用' : '使用', () => use(item.id)], ['测试', () => void testSaved(item)], ['编辑', () => openEditor(item)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = label;
        button.disabled = saving || probing || locked(); button.addEventListener('click', action); actions.append(button);
      }
      cell.append(actions); row.append(cell); return row;
    });
    get('bit-ip-rows').replaceChildren(...rows);
    get('bit-ip-empty').hidden = Boolean(items.length);
    get('bit-ip-empty').textContent = !data ? 'IP 列表暂不可用，请刷新重试。' : data.items.length ? '没有匹配的 IP，请调整搜索或筛选。' : '还没有保存 IP，点击右上角“新增 IP”录入。';
    get('bit-ip-count').textContent = data ? String(data.items.length) : '—';
    get('bit-ip-page-info').textContent = `共 ${items.length} 条 · 第 ${page} / ${pages} 页`;
    get('bit-ip-prev').disabled = page <= 1; get('bit-ip-next').disabled = page >= pages;
  }
  function render(preferred = select.value || readDraft()['bit-execution-proxy']) {
    select.replaceChildren(new Option(data?.items.length ? '请选择执行 IP' : '暂无 IP，请先新增', ''),
      ...(data?.items || []).map(item => new Option(`${item.name} · ${item.countryCode ? countryName(item.countryCode) : '国家自动识别'} · ${kinds[item.kind]} · ${item.endpoint}`, item.id)));
    select.value = preferred || ''; select.disabled = !data || locked(); renderList(); onChange();
  }
  async function request(method = 'GET', body, signal) {
    const controller = new AbortController(); pending.add(controller);
    try {
      const response = await fetch('/api/local/bitbrowser-proxies', { method, cache: 'no-store', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || 'IP 操作失败，请重试'); error.status = response.status; throw error; }
      if (method !== 'POST' && (!Number.isSafeInteger(result.version) || !Array.isArray(result.items) ||
        !result.items.every(item => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.endpoint === 'string' &&
          /^(?:[A-Z]{2})?$/.test(item.countryCode) && Object.hasOwn(kinds, item.kind)) ||
        (method === 'PUT' && !result.items.some(item => item.id === result.savedId)))) throw new Error('IP 列表返回不完整，请刷新重试；输入已保留。');
      return result;
    } finally { pending.delete(controller); }
  }
  async function refresh() {
    if (saving || probing || locked()) return;
    const revision = ++generation; reading = true; onChange(); get('bit-refresh-proxies').disabled = true;
    setMessage('正在读取 IP 列表…');
    try {
      const result = await request(); if (!alive || revision !== generation) return;
      data = result; render(); setMessage(data.items.length ? `已保存 ${data.items.length} 个 IP，可直接选择使用。` : '暂无 IP，点击“新增 IP”录入代理链接。');
    } catch (error) { if (alive && revision === generation) { setMessage(error.message); renderList(); } }
    finally { if (revision === generation) { reading = false; get('bit-refresh-proxies').disabled = false; onChange(); } }
  }
  function use(id) {
    if (saving || probing || locked()) return;
    select.value = id; capture(); renderList(); onChange(); onUse?.(); select.focus();
  }
  select.addEventListener('change', () => { capture(); renderList(); onChange(); });
  for (const control of [search, filter, sort]) control.addEventListener(control === search ? 'input' : 'change', () => { page = 1; renderList(); capture(); });
  for (const [id, delta] of [['bit-ip-prev', -1], ['bit-ip-next', 1]]) get(id).addEventListener('click', () => { page += delta; renderList(); capture(); });
  get('bit-refresh-proxies').addEventListener('click', refresh);
  function fitEditorToHost() {
    try {
      if (window.parent === window || !window.frameElement) return;
      const frame = window.frameElement.getBoundingClientRect();
      const headerBottom = Math.max(0, window.parent.document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0);
      const visibleTop = Math.max(frame.top, headerBottom);
      editor.style.top = `${Math.max(0, visibleTop - frame.top)}px`;
      editor.style.height = `${Math.max(160, Math.min(frame.bottom, window.parent.innerHeight) - visibleTop)}px`;
      editor.style.bottom = 'auto';
    } catch { /* Standalone or cross-origin embedding keeps the CSS viewport layout. */ }
  }
  window.addEventListener('resize', () => { if (editor.open) fitEditorToHost(); });
  try { window.parent.addEventListener('scroll', () => { if (editor.open) fitEditorToHost(); }, { passive: true }); } catch { /* Same-origin host only. */ }
  function openEditor(item) {
    if (locked() || saving || probing) return;
    editingId = item?.id || ''; editVersion = data?.version ?? 0; opener = document.activeElement;
    const draft = readDraft(), prefix = draftKey();
    const defaults = { name: item?.name || '', country: item?.countryCode ? countryName(item.countryCode) : '', kind: item?.kind || 'dynamic_residential', mode: item?.mode || 'auto', protocol: item?.protocol || 'auto' };
    for (const field of fields) get('bit-ip-' + field).value = draft[prefix + field] ?? defaults[field];
    if (/^\d+$/.test(draft[prefix + 'version'] || '')) editVersion = Number(draft[prefix + 'version']);
    editorProbe = undefined; get('bit-ip-probe-result').textContent = '尚未测试代理。'; get('bit-ip-advanced').open = false;
    get('bit-proxy-editor-title').textContent = item ? '编辑执行 IP' : '新增执行 IP';
    get('bit-ip-save').textContent = item ? '确认保存修改' : '保存并使用';
    get('bit-ip-link').value = ''; get('bit-ip-link').placeholder = item ? '留空保留已保存的链接；输入新链接可替换' : '直接粘贴购买平台生成的代理信息';
    get('bit-ip-link-required').hidden = Boolean(item);
    get('bit-ip-edit-note').textContent = item ? `已保存地址：${item.endpoint}。修改仅影响后续使用；进行中的任务不受影响。` : '保存后会自动选中这个 IP，可在 IP 资料库再次查看和编辑。';
    saveMessage.textContent = ''; get('bit-ip-rebase').hidden = true; fitEditorToHost(); editor.showModal(); onChange(); get('bit-ip-name').focus();
  }
  for (const id of ['bit-add-proxy', 'bit-library-add']) get(id).addEventListener('click', () => openEditor());
  editor.addEventListener('input', event => {
    capture();
    if (['bit-ip-link', 'bit-ip-protocol', 'bit-ip-mode'].includes(event.target.id)) { editorProbe = undefined; get('bit-ip-probe-result').textContent = '代理资料已修改，请重新测试。'; }
  }); editor.addEventListener('change', capture);
  editor.addEventListener('close', () => { editorProbe = undefined; onChange(); if (opener?.isConnected) opener.focus(); });
  function close() { if (!saving && !probing) { capture(); get('bit-ip-link').value = ''; editor.close(); } }
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
  async function runProbe(proxy) {
    if (probing || locked()) throw new Error('已有任务正在执行，请稍候再测试。');
    const settings = connection?.();
    if (!settings?.token) throw new Error('请先选择可用的比特账号连接，再测试代理。');
    probeController = new AbortController(); probing = true; onChange(); renderList();
    for (const control of editor.querySelectorAll('input,select,button')) control.disabled = true;
    try { return await testBitBrowserProxy({ ...proxy, ...settings, signal: probeController.signal }); }
    finally {
      probing = false; probeController = undefined;
      for (const control of editor.querySelectorAll('input,select,button')) control.disabled = false;
      renderList(); onChange();
    }
  }
  async function probeEditor() {
    let link = get('bit-ip-link').value.trim();
    if (!link && editingId) link = (await request('POST', { id: editingId, version: editVersion })).link;
    get('bit-ip-probe-result').textContent = '正在通过当前比特浏览器测试代理…';
    try {
      const result = await runProbe({ link, protocol: get('bit-ip-protocol').value, mode: get('bit-ip-mode').value });
      if (!alive) throw new Error('页面已关闭。');
      editorProbe = result;
      if (result.countryCode) countryInput.value = countryName(result.countryCode);
      get('bit-ip-probe-result').textContent = `代理可用 · 出口 ${result.ip} · ${result.countryCode ? countryName(result.countryCode) : '国家未识别'} · ${result.latencyMs}ms`;
      return result;
    } catch (error) { get('bit-ip-probe-result').textContent = error.message; throw error; }
    finally { link = ''; }
  }
  get('bit-ip-test').addEventListener('click', () => { if (!saving && !probing && !locked()) void probeEditor().catch(() => {}); });
  async function testSaved(item) {
    if (saving || probing || locked()) return;
    if (probeLoading) return;
    probeLoading = true; onChange();
    setMessage(`正在测试“${item.name}”…`);
    let proxy;
    try {
      proxy = await request('POST', { id: item.id, version: data.version });
      const result = await runProbe(proxy); if (!alive) return;
      probeResults.set(item.id, probeSummary(result)); renderList();
      setMessage(`代理可用 · 出口 ${result.ip} · ${result.countryCode ? countryName(result.countryCode) : '国家未识别'} · ${result.latencyMs}ms`);
    } catch (error) { probeResults.delete(item.id); renderList(); setMessage(error.message); }
    finally { if (proxy) proxy.link = ''; probeLoading = false; onChange(); }
  }
  get('bit-ip-save').addEventListener('click', async () => {
    if (saving || probing || locked()) return;
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
      countryCode: editorProbe?.countryCode || resolveBitBrowserCountry(country), kind: get('bit-ip-kind').value,
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
      get('bit-ip-link').value = ''; editor.close(); setMessage('IP 已保存并选中。'); onUse?.();
    } catch (error) { if (alive) { saveMessage.textContent = error.message; get('bit-ip-rebase').hidden = error.status !== 409; } }
    finally {
      body.link = ''; saving = false;
      for (const control of editor.querySelectorAll('input,select,button')) control.disabled = false;
      get('bit-refresh-proxies').disabled = false; renderList(); onChange();
    }
  });
  window.addEventListener('pagehide', () => { alive = false; probeController?.abort(); for (const controller of pending) controller.abort(); get('bit-ip-link').value = ''; });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.source === 'id-recharge-shell' && event.data.type === 'visibility' && !event.data.visible) { probeController?.abort(); editorProbe = undefined; get('bit-ip-link').value = ''; if (!saving && editor.open) editor.close(); }
  });
  return { ready, refresh, async settings(signal) {
    if (!ready()) throw new Error('请先选择有效的执行 IP');
    const id = select.value, version = data.version;
    const proxy = await request('POST', { id, version }, signal);
    if (signal.aborted || id !== select.value || version !== data.version) throw new Error('执行 IP 已变化，请重新开始');
    try { return bitBrowserProxySettings(proxy); } finally { proxy.link = ''; }
  } };
}
