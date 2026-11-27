const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const el = {
  jsonInput: document.getElementById('protoJsonInput'),
  parsedEmail: document.getElementById('protoParsedEmail'),
  jsonStatus: document.getElementById('protoJsonStatus'),
  launchForm: document.getElementById('protoLaunchForm'),
  reloadIps: document.getElementById('protoReloadIps'),
  proxyInputLabel: document.getElementById('protoProxyInputLabel'),
  stage: document.querySelector('.proto-stage'),
  clearBtn: document.getElementById('protoClearBtn'),
  regionSelect: document.getElementById('protoRegionSelect'),
  proxyInput: document.getElementById('protoProxyInput'),
  launchBtn: document.getElementById('protoLaunchBtn'),
  message: document.getElementById('protoMessage'),
  proxyBadge: document.getElementById('protoProxyBadge'),
  loginBadge: document.getElementById('protoLoginBadge'),
  backBtn: document.getElementById('protoBackBtn'),
  reloadBtn: document.getElementById('protoReloadBtn'),
  urlForm: document.getElementById('protoUrlForm'),
  urlInput: document.getElementById('protoUrlInput'),
  goBtn: document.getElementById('protoGoBtn'),
  recheckBtn: document.getElementById('protoRecheckBtn'),
  closeBtn: document.getElementById('protoCloseBtn'),
  sendTextInput: document.getElementById('protoSendTextInput'),
  sendTextBtn: document.getElementById('protoSendTextBtn'),
  canvas: document.getElementById('protoCanvas'),
  overlay: document.getElementById('protoEmptyOverlay')
};

const ctx = el.canvas.getContext('2d');
const endpoint = '/api/local/native-workbench-prototype/';
const paused = document.body.hasAttribute('data-workbench-paused');
const isolated = document.body.hasAttribute('data-workbench-isolated');
const layout = document.querySelector('.proto-layout');
const embedded = document.body.hasAttribute('data-workbench-embedded') && window.parent !== window;
let formBusy = false;
let formValid = false;
let proxyVersion;
let moduleVisible = true;
document.documentElement.dataset.rechargeNavigationLocked = 'false';

let viewportWidth = VIEWPORT_WIDTH;
let viewportHeight = VIEWPORT_HEIGHT;

let activeProfileKey = '';
let expectedEmail = '';
let ws = null;
let lastMouseMoveAt = 0;
let renderingFrame = false;

function setMessage(text, tone = 'muted') {
  el.message.textContent = text || '';
  el.message.hidden = !text;
  el.message.className = 'proto-message' + (tone === 'error' ? ' is-error' : tone === 'ok' ? ' is-ok' : tone === 'warn' ? ' is-warn' : '');
}

function setPill(node, text, tone = 'muted') {
  node.textContent = text;
  node.className = `proto-pill proto-pill-${tone}`;
}

function setControlsEnabled(enabled) {
  el.backBtn.disabled = !enabled;
  el.reloadBtn.disabled = !enabled;
  el.urlInput.disabled = !enabled;
  el.goBtn.disabled = !enabled;
  el.recheckBtn.disabled = !enabled;
  el.closeBtn.disabled = !activeProfileKey;
  el.sendTextInput.disabled = !enabled;
  el.sendTextBtn.disabled = !enabled;
  el.overlay.hidden = enabled;
}

function updateLaunchButton() {
  const custom = el.regionSelect.value === 'custom';
  el.proxyInput.hidden = el.proxyInputLabel.hidden = !custom;
  el.proxyInput.required = custom;
  el.launchBtn.disabled = paused || formBusy || !formValid || !el.regionSelect.value ||
    (custom && !el.proxyInput.value.trim()) || Boolean(activeProfileKey);
}

function updateParsePreview() {
  const raw = el.jsonInput.value.trim();
  let email = '', issue = '';
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const address = typeof data?.user?.email === 'string' ? data.user.email.trim() : '';
      email = address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address.toLowerCase() : '';
      const session = data?.sessionToken ?? data?.session_token;
      if (new TextEncoder().encode(raw).byteLength > 65_000) issue = '请粘贴 65 KB 以内的单账号授权 JSON。';
      else if (!email) issue = '授权 JSON 缺少有效邮箱。';
      else if (!isolated && (typeof session !== 'string' || !session.trim())) issue = '授权 JSON 缺少会话凭据。';
    } catch { issue = 'JSON 格式无效，请粘贴完整内容。'; }
  }
  formValid = Boolean(email) && !issue;
  el.parsedEmail.textContent = email || expectedEmail || '—';
  el.jsonStatus.textContent = issue;
  el.jsonStatus.hidden = !issue;
  updateLaunchButton();
}

async function loadIpChoices() {
  const selected = el.regionSelect.value;
  el.regionSelect.disabled = true;
  el.regionSelect.replaceChildren(new Option('正在读取 IP 线路…', ''));
  el.reloadIps.hidden = true;
  updateLaunchButton();
  try {
    const res = await fetch(endpoint + 'ip-options', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.choices)) throw new Error();
    proxyVersion = data.version;
    el.regionSelect.replaceChildren(new Option('请选择执行 IP', ''), ...data.choices.map(line =>
      new Option([line.name, line.countryCode, line.endpoint].filter(Boolean).join(' · '), line.id)
    ), new Option('输入 HTTP 代理地址', 'custom'));
    if ([...el.regionSelect.options].some(option => option.value === selected)) el.regionSelect.value = selected;
    el.regionSelect.disabled = false;
  } catch {
    el.regionSelect.replaceChildren(new Option('IP 线路暂时无法读取', ''));
    el.reloadIps.hidden = false;
  }
  updateLaunchButton();
}

function clearSensitiveInput() {
  el.jsonInput.value = '';
  el.proxyInput.value = '';
  el.sendTextInput.value = '';
  updateParsePreview();
}

function reportSize() {
  if (!embedded) return;
  window.parent.postMessage({
    source: 'id-manual-workbench', type: 'resize',
    height: Math.ceil(layout.getBoundingClientRect().height), open: !el.stage.hidden && moduleVisible
  }, location.origin);
}

function applyLoginVerification(verification) {
  if (!verification) {
    setPill(el.loginBadge, '登录态: 未核验', 'muted');
    return;
  }
  switch (verification.status) {
    case 'matched':
      setPill(el.loginBadge, `已登录且匹配: ${verification.actualEmail}`, 'ok');
      setMessage(`${verification.message}。请在操作窗内手动选套餐和付款。`, 'ok');
      break;
    case 'mismatch':
      setPill(el.loginBadge, `账号不匹配: ${verification.actualEmail}`, 'err');
      setMessage(verification.message, 'error');
      break;
    case 'logged_in_unverified':
      setPill(el.loginBadge, '已登录（邮箱未核对）', 'warn');
      setMessage(verification.message, 'warn');
      break;
    case 'unauthenticated':
      setPill(el.loginBadge, '未登录（需手动登录）', 'warn');
      setMessage(verification.message, 'warn');
      break;
    case 'expired':
      setPill(el.loginBadge, '会话已过期（需重登）', 'err');
      setMessage(verification.message, 'error');
      break;
    default:
      setPill(el.loginBadge, '登录核验失败', 'err');
      setMessage(verification.message || '登录核验异常', 'error');
  }
}

function applyProxyInfo(proxy) {
  const exit = proxy?.exitInfo;
  if (exit?.verified && exit?.country) {
    setPill(el.proxyBadge, `出口: ${exit.country} (${exit.ip || '未知 IP'})`, 'ok');
  } else if (proxy?.region && proxy.region !== 'auto') {
    setPill(el.proxyBadge, `线路: ${proxy.regionLabel || proxy.region}`, 'warn');
  } else {
    setPill(el.proxyBadge, '出口: 直连 / 自动', 'muted');
  }
}

async function drawBase64Frame(base64Data, metadata) {
  if (renderingFrame || !base64Data) return;
  renderingFrame = true;
  try {
    if (metadata?.deviceWidth > 0 && metadata?.deviceHeight > 0) {
      if (viewportWidth !== metadata.deviceWidth || viewportHeight !== metadata.deviceHeight) {
        viewportWidth = metadata.deviceWidth;
        viewportHeight = metadata.deviceHeight;
        el.canvas.width = viewportWidth;
        el.canvas.height = viewportHeight;
      }
    }
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, el.canvas.width, el.canvas.height);
    bitmap.close();
  } catch {
    // Ignore transient frame decode errors
  } finally {
    renderingFrame = false;
  }
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function disconnectWs() {
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
}

function connectWs(profileKey) {
  disconnectWs();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/integrations/native-workbench/ws?profileKey=${encodeURIComponent(profileKey)}`;
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    setControlsEnabled(true);
    el.canvas.focus({ preventScroll: true });
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'frame') {
      void drawBase64Frame(msg.data, msg.metadata);
    } else if (msg.type === 'navigated' && msg.url) {
      el.urlInput.value = msg.url;
    } else if (msg.type === 'loginVerification') {
      applyLoginVerification(msg.verification);
    } else if (msg.type === 'error') {
      setMessage(msg.message || '操作窗通信错误', 'error');
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    setControlsEnabled(false);
    setMessage('操作窗连接已断开。可关闭后重新提交，或返回工作台接回现有窗口。', 'warn');
  };
}

function mapCanvasCoords(event) {
  const rect = el.canvas.getBoundingClientRect();
  const scaleX = viewportWidth / Math.max(rect.width, 1);
  const scaleY = viewportHeight / Math.max(rect.height, 1);
  return {
    x: Math.max(0, Math.min(viewportWidth, Math.round((event.clientX - rect.left) * scaleX))),
    y: Math.max(0, Math.min(viewportHeight, Math.round((event.clientY - rect.top) * scaleY)))
  };
}

function mouseButtonName(button) {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

function keyboardModifiers(event) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

let touchPointer;
el.canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    if (event.isPrimary) {
      touchPointer = { id: event.pointerId, y: event.clientY, moved: false };
      el.canvas.setPointerCapture(event.pointerId);
    }
    return;
  }
  el.canvas.focus();
  sendWs({ type: 'mouse', eventType: 'mousePressed', ...mapCanvasCoords(event),
    button: mouseButtonName(event.button), clickCount: 1 });
});
el.canvas.addEventListener('pointermove', (event) => {
  const position = mapCanvasCoords(event);
  if (event.pointerType === 'touch') {
    if (touchPointer?.id !== event.pointerId) return;
    const delta = touchPointer.y - event.clientY;
    if (!touchPointer.moved && Math.abs(delta) < 6) return;
    touchPointer = { ...touchPointer, y: event.clientY, moved: true };
    sendWs({ type: 'wheel', ...position, deltaX: 0, deltaY: delta * 2 });
    return;
  }
  const now = performance.now();
  if (now - lastMouseMoveAt < 40) return;
  lastMouseMoveAt = now;
  sendWs({ type: 'mouse', eventType: 'mouseMoved', ...position, button: 'none', clickCount: 0 });
});
el.canvas.addEventListener('pointerup', (event) => {
  const click = { type: 'mouse', ...mapCanvasCoords(event), button: mouseButtonName(event.button), clickCount: 1 };
  if (event.pointerType === 'touch') {
    if (touchPointer?.id !== event.pointerId) return;
    const tapped = !touchPointer.moved;
    touchPointer = undefined;
    if (!tapped) return;
    sendWs({ ...click, eventType: 'mousePressed' });
  }
  sendWs({ ...click, eventType: 'mouseReleased' });
});
el.canvas.addEventListener('pointercancel', () => { touchPointer = undefined; });

el.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const pos = mapCanvasCoords(event);
  sendWs({ type: 'wheel', ...pos, deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });

el.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

el.canvas.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
    return;
  }
  event.preventDefault();
  const modifiers = keyboardModifiers(event);
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    sendWs({ type: 'text', text: event.key });
    return;
  }
  sendWs({
    type: 'key',
    eventType: 'keyDown',
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    modifiers
  });
});

el.canvas.addEventListener('keyup', (event) => {
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
  sendWs({
    type: 'key',
    eventType: 'keyUp',
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    modifiers: keyboardModifiers(event)
  });
});

el.canvas.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text/plain');
  if (text) {
    event.preventDefault();
    sendWs({ type: 'text', text });
  }
});

el.jsonInput.addEventListener('input', updateParsePreview);
el.regionSelect.addEventListener('change', () => {
  el.proxyInput.value = '';
  updateLaunchButton();
});
el.proxyInput.addEventListener('input', updateLaunchButton);
el.clearBtn.addEventListener('click', () => {
  clearSensitiveInput();
  if (!paused) setMessage('');
  el.jsonInput.focus();
});
el.reloadIps.addEventListener('click', () => void loadIpChoices());

el.launchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (el.launchBtn.disabled) return;
  const proxyId = el.regionSelect.value;
  const body = { proxyId, proxyVersion, ...(isolated ? { email: el.parsedEmail.textContent }
    : { sessionJson: el.jsonInput.value.trim() }) };
  if (proxyId === 'custom') body.customProxyUrl = el.proxyInput.value.trim();
  formBusy = true;
  document.documentElement.dataset.rechargeNavigationLocked = 'true';
  updateLaunchButton();
  el.jsonInput.readOnly = el.proxyInput.readOnly = el.regionSelect.disabled = el.clearBtn.disabled = true;
  el.launchBtn.textContent = '正在打开操作窗…';
  setMessage('正在核验所选 IP 并打开 ChatGPT…');
  try {
    const res = await fetch(endpoint + 'launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409 && proxyId !== 'custom') void loadIpChoices();
      throw new Error(data.error || '未能打开站内操作窗');
    }
    if (isolated) {
      if (!/^\/manual-workspaces\/recharge-[a-f0-9]{64}\/$/.test(data.viewerUrl || ''))
        throw new Error('操作窗没有返回连接信息，请重试');
      clearSensitiveInput();
      if (embedded) {
        window.parent.postMessage({ source: 'id-manual-workbench', type: 'open-viewer', viewerUrl: data.viewerUrl }, location.origin);
      } else window.location.assign(data.viewerUrl);
      return;
    }
    if (!data.profileKey) throw new Error('操作窗没有返回连接信息，请重试');
    activeProfileKey = data.profileKey;
    expectedEmail = data.account?.email || '';
    clearSensitiveInput();
    applyProxyInfo(data.proxy);
    applyLoginVerification(data.loginVerification);
    el.stage.hidden = false;
    setControlsEnabled(false);
    reportSize();
    if (moduleVisible) connectWs(activeProfileKey);
  } catch (err) {
    setMessage(err.message || '未能打开站内操作窗，请重试', 'error');
  } finally {
    formBusy = false;
    document.documentElement.dataset.rechargeNavigationLocked = 'false';
    el.jsonInput.readOnly = el.proxyInput.readOnly = el.clearBtn.disabled = false;
    el.regionSelect.disabled = !el.regionSelect.options.length || !el.reloadIps.hidden;
    el.launchBtn.textContent = '提交并打开操作窗';
    updateLaunchButton();
  }
});

el.backBtn.addEventListener('click', () => sendWs({ type: 'back' }));
el.reloadBtn.addEventListener('click', () => sendWs({ type: 'reload' }));
el.urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendWs({ type: 'navigate', url: el.urlInput.value });
});
el.recheckBtn.addEventListener('click', () => {
  setPill(el.loginBadge, '登录态: 重新核验中…', 'muted');
  sendWs({ type: 'recheckLogin', expectedEmail });
});

el.sendTextBtn.addEventListener('click', () => {
  const text = el.sendTextInput.value;
  if (!text) return;
  sendWs({ type: 'text', text });
  el.sendTextInput.value = '';
  el.canvas.focus();
});

el.closeBtn.addEventListener('click', async () => {
  if (!activeProfileKey) return;
  el.closeBtn.disabled = true;
  try {
    const response = await fetch(endpoint + 'close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileKey: activeProfileKey })
    });
    if (!response.ok) throw new Error();
    activeProfileKey = '';
    expectedEmail = '';
    disconnectWs();
    setControlsEnabled(false);
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    el.stage.hidden = true;
    updateParsePreview();
    setMessage('操作窗已关闭。');
    reportSize();
  } catch {
    el.closeBtn.disabled = false;
    setMessage('暂时无法确认操作窗是否关闭，请重试。', 'error');
  }
});

window.addEventListener('pagehide', () => {
  moduleVisible = false;
  clearSensitiveInput();
  disconnectWs();
});
window.addEventListener('pageshow', ({ persisted }) => {
  if (!persisted || embedded) return;
  moduleVisible = true;
  if (activeProfileKey) connectWs(activeProfileKey);
});
if (embedded) {
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.origin !== location.origin || event.source !== window.parent ||
        message?.source !== 'id-recharge-shell') return;
    if (message.type === 'theme' && ['light', 'dark'].includes(message.theme)) {
      document.documentElement.dataset.theme = message.theme;
    } else if (message.type === 'visibility' && moduleVisible !== message.visible) {
      moduleVisible = message.visible;
      if (!moduleVisible) {
        clearSensitiveInput();
        disconnectWs();
      } else {
        if (activeProfileKey) connectWs(activeProfileKey);
        reportSize();
      }
    }
  });
  new ResizeObserver(reportSize).observe(layout);
  reportSize();
}
if (paused) {
  el.regionSelect.replaceChildren(new Option('内置浏览器暂未开放', ''));
  setMessage('当前站点的内置浏览器仍暂停开放。', 'warn');
} else {
  if (isolated) setMessage('站内工作区使用 ChatGPT 网页登录。已有有效登录的账号会恢复原会话。');
  void loadIpChoices();
}
