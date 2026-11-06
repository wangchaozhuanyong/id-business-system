const form = document.querySelector('#mailbox-query-form');
const input = document.querySelector('#mailbox-query-code');
const submit = document.querySelector('#mailbox-query-submit');
const status = document.querySelector('#mailbox-query-status');
const results = document.querySelector('#mailbox-query-results');
const summary = document.querySelector('#mailbox-result-summary');
const note = document.querySelector('#mailbox-result-note');
const messages = document.querySelector('#mailbox-result-messages');
const copyStatus = document.querySelector('#mailbox-copy-status');
window.IDTitleHelp.attach(
  document.querySelector('#mailbox-title'),
  document.querySelector('.public-mailbox-intro')
);
const beijingTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short'
});

let request = null;
let resultExpiresAt = null;
let resultQueryCode = null;

function showStatus(message, state = '') {
  status.textContent = message;
  status.dataset.state = state;
}

function updateBusy(busy) {
  submit.disabled = busy;
  submit.textContent = busy ? '查询中…' : '查询邮件';
  results.setAttribute('aria-busy', String(busy));
}

function clearResults() {
  results.hidden = true;
  summary.replaceChildren();
  messages.replaceChildren();
  note.hidden = true;
  note.textContent = '';
  copyStatus.textContent = '';
  resultExpiresAt = null;
  resultQueryCode = null;
}

function resetQuery() {
  request?.abort();
  request = null;
  clearResults();
  showStatus('');
  updateBusy(false);
  input.removeAttribute('aria-invalid');
}

function appendSummary(label, value) {
  if (!value) return;
  const entry = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  entry.append(term, description);
  summary.append(entry);
}

function renderMessage(message, index) {
  const row = document.createElement('li');
  row.className = 'public-mailbox-message';
  const info = document.createElement('div');
  info.className = 'public-mailbox-message-info';
  const subject = document.createElement('p');
  subject.className = 'public-mailbox-message-subject';
  subject.textContent = message.subject || '无主题';
  const time = document.createElement('span');
  time.className = 'public-mailbox-message-time';
  time.textContent = message.receivedAt || '未记录收件时间';
  info.append(subject, time);
  row.append(info);

  if (typeof message.extractedCode === 'string' && message.extractedCode) {
    const verification = document.createElement('div');
    verification.className = 'public-mailbox-verification';
    const code = document.createElement('code');
    code.textContent = message.extractedCode;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button';
    copy.textContent = '复制验证码';
    copy.setAttribute('aria-label', `复制第 ${index + 1} 封邮件的验证码`);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message.extractedCode);
        if (row.isConnected) copyStatus.textContent = '已复制验证码。';
      } catch {
        if (row.isConnected) copyStatus.textContent = '无法访问剪贴板，请选中验证码后手动复制。';
      }
    });
    verification.append(code, copy);
    row.append(verification);
  }

  return row;
}

function showResults(data, queryCode) {
  clearResults();
  resultQueryCode = queryCode;
  appendSummary('查询范围', data.targetType === 'PRIMARY' ? '主邮箱' : '隐藏邮箱');
  appendSummary('主邮箱地址', data.primaryEmail);
  appendSummary('隐藏邮箱地址', data.aliasEmail);
  const expiration = Date.parse(data.codeExpiresAt);
  if (Number.isFinite(expiration)) {
    resultExpiresAt = expiration;
    appendSummary('查询码到期', beijingTime.format(expiration));
  }
  messages.replaceChildren(...data.items.map(renderMessage));
  if (!data.items.length || data.truncated) {
    note.textContent = data.items.length ? '当前仅显示最近的邮件。' : '授权范围内暂时没有邮件。';
    note.hidden = false;
  }
  results.hidden = false;
  showStatus(`查询完成，共显示 ${data.items.length} 封邮件。`);
}

function showFailure(httpStatus) {
  const feedback = {
    400: '请输入有效的查询码。',
    401: '查询码无效或已失效。',
    403: '请从当前查询页面重新提交。',
    404: '查询码无效、已失效或已过期。',
    410: '查询码已失效或已过期。',
    429: '查询过于频繁，请稍后重试。',
    503: '邮箱查询服务暂未就绪，请稍后重试。'
  };
  const message = feedback[httpStatus] || '未能读取查询结果，请稍后重试。';
  const transient = !httpStatus || httpStatus === 429 || httpStatus >= 500;
  const keep =
    transient && !results.hidden && (resultExpiresAt === null || resultExpiresAt > Date.now());
  if (!keep) clearResults();
  showStatus(keep ? `${message} 下方为上一次查询结果。` : message, keep ? 'stale' : 'error');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (request) return;
  const queryCode = input.value.trim();
  if (!queryCode || queryCode.includes('@')) {
    clearResults();
    input.setAttribute('aria-invalid', 'true');
    showStatus('请输入查询码。', 'error');
    input.focus();
    return;
  }

  if (
    resultQueryCode !== queryCode ||
    (resultExpiresAt !== null && resultExpiresAt <= Date.now())
  ) {
    clearResults();
  }
  const current = new AbortController();
  request = current;
  updateBusy(true);
  showStatus('正在查询邮件…');
  copyStatus.textContent = '';
  const isCurrent = () => request === current && queryCode === input.value.trim();
  try {
    const legacy = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{20}$/.test(queryCode);
    const managed = legacy || queryCode.startsWith('MBX-');
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryCode }),
      credentials: 'omit',
      cache: 'no-store',
      signal: current.signal
    };
    let response = await fetch(managed ? '/api/local/tools/mailbox-query' : '/api/local/apple-relay/public-query', options);
    if (legacy && response.status === 404 && isCurrent()) {
      const fallback = await fetch('/api/local/apple-relay/public-query', options);
      if (fallback.ok) {
        await response.body?.cancel();
        response = fallback;
      } else {
        await fallback.body?.cancel();
      }
    }
    if (!response.ok) {
      if (isCurrent()) showFailure(response.status);
      return;
    }
    const data = await response.json();
    if (!isCurrent()) return;
    if (
      data?.success !== true ||
      !['PRIMARY', 'VIRTUAL'].includes(data.targetType) ||
      !Array.isArray(data.items) ||
      data.items.some(
        (item) => !item || typeof item.subject !== 'string' || typeof item.receivedAt !== 'string'
      )
    ) {
      showFailure();
      return;
    }
    showResults(data, queryCode);
  } catch {
    if (isCurrent()) showFailure();
  } finally {
    if (request === current) {
      request = null;
      if (queryCode !== input.value.trim()) clearResults();
      updateBusy(false);
    }
  }
});

input.addEventListener('input', resetQuery);
window.addEventListener('pagehide', () => {
  input.value = '';
  resetQuery();
});

const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = preferredTheme.matches ? 'dark' : 'light';
}
preferredTheme.addEventListener('change', applyTheme);
applyTheme();
updateBusy(false);
