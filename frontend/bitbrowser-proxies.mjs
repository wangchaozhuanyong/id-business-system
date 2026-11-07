const kinds = { mobile: '移动 IP', dynamic_residential: '动态住宅', static_residential: '静态住宅' };
const countries = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
export function initializeExecutionProxies({ get, drafts, onChange, locked }) {
  const select = get('bit-execution-proxy'), editor = get('bit-proxy-editor');
  const message = get('bit-proxy-result'), saveMessage = get('bit-ip-save-result');
  let data, saving = false, reading = false, generation = 0, alive = true;
  const pending = new Set();
  const setMessage = text => { message.textContent = text; };
  const ready = () => Boolean(!reading && !saving && !editor.open && data?.items?.some(item => item.id === select.value));
  function capture() {
    const values = drafts?.read('bit-local') || {};
    values['bit-execution-proxy'] = select.value;
    for (const field of ['name', 'country', 'kind', 'mode', 'protocol']) values['ip-draft/' + field] = get('bit-ip-' + field).value;
    drafts?.write('bit-local', values);
  }
  function render(preferred = select.value || drafts?.read('bit-local')?.['bit-execution-proxy']) {
    select.replaceChildren(new Option(data?.items.length ? '请选择执行 IP' : '暂无 IP，请先新增', ''),
      ...(data?.items || []).map(item => new Option(`${countries.of(item.countryCode)} ${item.countryCode} · ${kinds[item.kind]} · ${item.name} · ${item.endpoint}`, item.id)));
    select.value = preferred || '';
    select.disabled = !data || locked();
    onChange();
  }
  async function request(method = 'GET', body, signal) {
    const controller = new AbortController(); pending.add(controller);
    try {
      const response = await fetch('/api/local/bitbrowser-proxies', { method, cache: 'no-store', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'IP 操作失败，请重试');
      if (method !== 'POST' && (!Number.isSafeInteger(result.version) || !Array.isArray(result.items) ||
        !result.items.every(item => typeof item.id === 'string' && typeof item.name === 'string' &&
          /^[A-Z]{2}$/.test(item.countryCode) && Object.hasOwn(kinds, item.kind)) ||
        (method === 'PUT' && !result.items.some(item => item.id === result.savedId))))
        throw new Error('IP 列表返回不完整，请刷新重试；输入已保留。');
      return result;
    } finally { pending.delete(controller); }
  }
  async function refresh() {
    if (saving || locked()) return;
    const revision = ++generation; reading = true; onChange();
    setMessage('正在读取执行 IP 列表…');
    try {
      const result = await request();
      if (!alive || revision !== generation) return;
      data = result; render();
      setMessage(data.items.length ? '直接选择 IP，国家和类型随 IP 资料读取。' : '尚未录入 IP，请点击“新增 IP／代理链接”。');
    } catch (error) { if (alive && revision === generation) setMessage(error.message); }
    finally { if (revision === generation) { reading = false; onChange(); } }
  }
  select.addEventListener('change', () => { capture(); onChange(); });
  get('bit-refresh-proxies').addEventListener('click', refresh);
  get('bit-add-proxy').addEventListener('click', () => {
    if (locked() || saving) return;
    const draft = drafts?.read('bit-local') || {};
    for (const field of ['name', 'country', 'kind', 'mode', 'protocol']) if (Object.hasOwn(draft, 'ip-draft/' + field)) get('bit-ip-' + field).value = draft['ip-draft/' + field];
    saveMessage.textContent = ''; editor.showModal(); onChange(); get('bit-ip-name').focus();
  });
  editor.addEventListener('input', capture);
  editor.addEventListener('close', onChange);
  function close() { if (!saving) { capture(); get('bit-ip-link').value = ''; editor.close(); } }
  get('bit-ip-close').addEventListener('click', close);
  editor.addEventListener('cancel', event => { event.preventDefault(); close(); });
  get('bit-ip-save').addEventListener('click', async () => {
    if (saving || locked()) return;
    if (!data) { saveMessage.textContent = '请先关闭并刷新 IP 列表，输入已保留。'; return; }
    const body = { version: data.version, name: get('bit-ip-name').value, countryCode: get('bit-ip-country').value.trim().toUpperCase(),
      kind: get('bit-ip-kind').value, mode: get('bit-ip-mode').value, protocol: get('bit-ip-protocol').value, link: get('bit-ip-link').value.trim() };
    const snapshot = JSON.stringify(body);
    capture(); saving = true; reading = false; generation++; get('bit-ip-save').disabled = true; get('bit-ip-close').disabled = true;
    saveMessage.textContent = '正在保存 IP…';
    try {
      const result = await request('PUT', body);
      if (!alive) return;
      data = result; render(result.savedId);
      const latest = { ...body, name: get('bit-ip-name').value, countryCode: get('bit-ip-country').value.trim().toUpperCase(),
        kind: get('bit-ip-kind').value, mode: get('bit-ip-mode').value, protocol: get('bit-ip-protocol').value, link: get('bit-ip-link').value.trim() };
      if (JSON.stringify(latest) === snapshot) {
        const draft = drafts?.read('bit-local') || {};
        for (const key of Object.keys(draft)) if (key.startsWith('ip-draft/')) delete draft[key];
        draft['bit-execution-proxy'] = result.savedId; drafts?.write('bit-local', draft);
        get('bit-ip-link').value = ''; get('bit-ip-name').value = ''; get('bit-ip-country').value = ''; editor.close();
      }
      setMessage('IP 已保存并选中。');
    } catch (error) { if (alive) saveMessage.textContent = error.message; }
    finally { body.link = ''; saving = false; get('bit-ip-save').disabled = false; get('bit-ip-close').disabled = false; onChange(); }
  });
  window.addEventListener('pagehide', () => { alive = false; for (const controller of pending) controller.abort(); get('bit-ip-link').value = ''; });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.source === 'id-recharge-shell' && event.data.type === 'visibility' && !event.data.visible) close();
  });
  return { ready, refresh, async settings(signal) {
    if (!ready()) throw new Error('请先选择有效的执行 IP');
    const id = select.value, version = data.version;
    const proxy = await request('POST', { id, version }, signal);
    if (signal.aborted || id !== select.value || version !== data.version) throw new Error('执行 IP 已变化，请重新开始');
    const url = new URL(proxy.link); proxy.link = '';
    return { proxyType: proxy.protocol, expectedCountryCode: proxy.countryCode,
      dynamicProxyUrl: proxy.mode === 'dynamic' ? url.href : '',
      browserOptions: { proxyMode: proxy.mode, ...(proxy.mode === 'static' && { staticHost: url.hostname, staticPort: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }) },
      staticProxyCredentials: proxy.mode === 'static' ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : undefined };
  } };
}
