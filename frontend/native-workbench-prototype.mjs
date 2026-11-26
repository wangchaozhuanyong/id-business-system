const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const el = {
  jsonInput: document.getElementById('protoJsonInput'),
  parsedEmail: document.getElementById('protoParsedEmail'),
  parsedPlan: document.getElementById('protoParsedPlan'),
  parsedDevice: document.getElementById('protoParsedDevice'),
  parsedToken: document.getElementById('protoParsedToken'),
  parseBtn: document.getElementById('protoParseBtn'),
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

let viewportWidth = VIEWPORT_WIDTH;
let viewportHeight = VIEWPORT_HEIGHT;

let activeProfileKey = '';
let expectedEmail = '';
let ws = null;
let lastMouseMoveAt = 0;
let renderingFrame = false;

export function parseSessionPreview(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const data = JSON.parse(text);
  const email = String(data?.user?.email || data?.email || '').trim();
  const token = String(
    data?.accessToken ||
    data?.sessionToken ||
    data?.token ||
    data?.['__Secure-next-auth.session-token'] ||
    ''
  ).trim();
  const deviceId = String(data?.deviceId || data?.oaiDeviceId || data?.['oai-did'] || '').trim();
  const plan = String(
    data?.account?.planType ||
    data?.planType ||
    data?.plan ||
    data?.user?.plan ||
    'unknown'
  ).trim();
  return { email, token, deviceId, plan };
}

function setMessage(text, tone = 'muted') {
  el.message.textContent = text || '';
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
  el.closeBtn.disabled = !enabled;
  el.sendTextInput.disabled = !enabled;
  el.sendTextBtn.disabled = !enabled;
  el.overlay.hidden = enabled;
}

function updateParsePreview() {
  const raw = el.jsonInput.value.trim();
  if (!raw) {
    el.parsedEmail.textContent = '—';
    el.parsedPlan.textContent = '—';
    el.parsedDevice.textContent = '—';
    el.parsedToken.textContent = '等待输入';
    return null;
  }
  try {
    const parsed = parseSessionPreview(raw);
    el.parsedEmail.textContent = parsed?.email || '未识别';
    el.parsedPlan.textContent = parsed?.plan || 'unknown';
    el.parsedDevice.textContent = parsed?.deviceId || '未提供';
    el.parsedToken.textContent = parsed?.token ? '已提取凭据' : '缺少 Token';
    return parsed;
  } catch {
    el.parsedEmail.textContent = 'JSON 格式错误';
    el.parsedPlan.textContent = '—';
    el.parsedDevice.textContent = '—';
    el.parsedToken.textContent = '解析失败';
    return null;
  }
}

function applyLoginVerification(verification) {
  if (!verification) {
    setPill(el.loginBadge, '登录态: 未核验', 'muted');
    return;
  }
  switch (verification.status) {
    case 'matched':
      setPill(el.loginBadge, `已登录且匹配: ${verification.actualEmail}`, 'ok');
      setMessage(`${verification.message}。请在右侧操作窗内手动选套餐并填写付款资料。`, 'ok');
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
  ws = new WebSocket(url);

  ws.onopen = () => {
    setControlsEnabled(true);
    el.canvas.focus();
  };

  ws.onmessage = (event) => {
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

  ws.onclose = () => {
    setControlsEnabled(false);
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

el.canvas.addEventListener('mousedown', (event) => {
  el.canvas.focus();
  const pos = mapCanvasCoords(event);
  sendWs({
    type: 'mouse',
    eventType: 'mousePressed',
    ...pos,
    button: mouseButtonName(event.button),
    clickCount: 1
  });
});

el.canvas.addEventListener('mouseup', (event) => {
  const pos = mapCanvasCoords(event);
  sendWs({
    type: 'mouse',
    eventType: 'mouseReleased',
    ...pos,
    button: mouseButtonName(event.button),
    clickCount: 1
  });
});

el.canvas.addEventListener('mousemove', (event) => {
  const now = performance.now();
  if (now - lastMouseMoveAt < 40) return;
  lastMouseMoveAt = now;
  const pos = mapCanvasCoords(event);
  sendWs({ type: 'mouse', eventType: 'mouseMoved', ...pos, button: 'none', clickCount: 0 });
});

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
el.parseBtn.addEventListener('click', () => {
  const parsed = updateParsePreview();
  if (parsed?.email && parsed?.token) {
    setMessage(`解析成功：${parsed.email} (${parsed.plan})`, 'ok');
  } else {
    setMessage('JSON 未包含有效邮箱或 Token，请检查内容', 'error');
  }
});

el.clearBtn.addEventListener('click', () => {
  el.jsonInput.value = '';
  updateParsePreview();
  setMessage('');
});

el.launchBtn.addEventListener('click', async () => {
  const sessionJson = el.jsonInput.value.trim();
  if (!sessionJson) {
    setMessage('请先粘贴授权 JSON', 'error');
    el.jsonInput.focus();
    return;
  }
  el.launchBtn.disabled = true;
  el.launchBtn.textContent = '正在校验线路并启动浏览器…';
  setMessage('正在解析凭据、校验出口并启动独立 Chrome 实例…');
  setPill(el.loginBadge, '登录态: 核验中…', 'muted');

  try {
    const res = await fetch('/api/local/native-workbench-prototype/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionJson,
        proxyRegion: el.regionSelect.value,
        customProxyUrl: el.proxyInput.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '启动失败');

    activeProfileKey = data.profileKey;
    expectedEmail = data.account?.email || '';
    applyProxyInfo(data.proxy);
    applyLoginVerification(data.loginVerification);
    connectWs(activeProfileKey);
  } catch (err) {
    setPill(el.loginBadge, '登录态: 启动失败', 'err');
    setMessage(err.message || '启动操作窗失败', 'error');
  } finally {
    el.launchBtn.disabled = false;
    el.launchBtn.textContent = '识别并启动站内操作窗';
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
  disconnectWs();
  try {
    await fetch('/api/local/native-workbench-prototype/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileKey: activeProfileKey })
    });
  } catch {}
  activeProfileKey = '';
  setControlsEnabled(false);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
  setPill(el.loginBadge, '登录态: 已关闭', 'muted');
  setMessage('浏览器实例已关闭并释放代理。');
});
