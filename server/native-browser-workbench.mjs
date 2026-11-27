import { randomUUID } from 'node:crypto';
import { launchNativeChrome, isBrowserRunning, closeNativeBrowser, operatorBrowserProfileKey } from './native-chrome-runner.mjs';

export const nativeWorkbenchDomain = 'native-browser-workbench';

export class NativeWorkbenchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const regionLabels = {
  auto: '共享代充池 · 智能选路',
  PH: '菲律宾 (PH · 自动代充 IP 池)',
  EG: '埃及 (EG · 自动代充 IP 池)',
  direct: '服务器直连 (无代理)'
};

function formatProxySummary(input) {
  if (input.proxyRegion && regionLabels[input.proxyRegion]) {
    return regionLabels[input.proxyRegion];
  }
  if (input.proxySummary && String(input.proxySummary).trim()) {
    return String(input.proxySummary).trim();
  }
  return '共享代充池 · 智能选路';
}

/**
 * Parse single account session JSON and extract session essentials safely.
 */
export function parseSessionPayload(sessionJson) {
  if (typeof sessionJson !== 'string' || !sessionJson.trim()) {
    throw new NativeWorkbenchError(400, '请提供完整的授权 JSON');
  }
  let data;
  try {
    data = JSON.parse(sessionJson);
  } catch {
    throw new NativeWorkbenchError(400, '授权 JSON 格式无效，请粘贴完整内容');
  }

  const token = String(data.sessionToken ?? data.session_token ?? '').trim();
  if (!token) {
    throw new NativeWorkbenchError(400, '授权 JSON 中未找到有效的 sessionToken');
  }

  const email = String(data.user?.email || '').trim().toLowerCase();
  if (!email || !emailPattern.test(email)) {
    throw new NativeWorkbenchError(400, '授权 JSON 中未找到有效的邮箱地址');
  }

  const accountId = String(data.account?.id || data.account?.account_id || '').trim();
  const userId = String(data.user?.id || '').trim();

  const deviceId =
    typeof data.statsigContext?.deviceId === 'string' && data.statsigContext.deviceId.trim()
      ? data.statsigContext.deviceId.trim()
      : typeof data.deviceId === 'string' && data.deviceId.trim()
        ? data.deviceId.trim()
        : typeof data.device_id === 'string' && data.device_id.trim()
          ? data.device_id.trim()
          : '';

  const plan = String(data.account?.planType || data.account?.plan_type || 'free').toLowerCase();

  return {
    email,
    token,
    accountId,
    userId,
    deviceId,
    plan
  };
}

/**
 * Filter and sort accounts.
 */
export function queryWorkbenchAccounts(records = [], { search = '', status = '', limit = 50 } = {}, ownerId) {
  let list = Array.isArray(records) ? [...records] : [];
  const query = search.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (item) =>
        item.email.toLowerCase().includes(query) ||
        (item.renewalNotes && item.renewalNotes.toLowerCase().includes(query)) ||
        (item.proxySummary && item.proxySummary.toLowerCase().includes(query))
    );
  }
  if (status) {
    list = list.filter((item) => item.status === status);
  }
  list.sort((a, b) => {
    const timeA = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
    const timeB = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
    if (timeA !== timeB) return timeB - timeA;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return list.slice(0, limit).map((row) => {
    const profileKey = operatorBrowserProfileKey('chatgpt', ownerId, row.id);
    return {
      id: row.id,
      email: row.email,
      accountId: row.accountId,
      profileKey,
      proxyRegion: row.proxyRegion || 'auto',
      proxySummary: row.proxySummary || '共享代充池 · 智能选路',
      status: row.status,
      currentPlan: row.currentPlan || 'free',
      lastOpenedAt: row.lastOpenedAt || null,
      renewalNotes: row.renewalNotes || '',
      hasToken: Boolean(row.token),
      hasDeviceId: Boolean(row.deviceId),
      isRunning: isBrowserRunning(profileKey, ownerId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  });
}

/**
 * Add or update an account record in the workbench document.
 */
export function upsertWorkbenchAccount(records = [], input = {}) {
  const entries = Array.isArray(records) ? [...records] : [];
  let { email, token, accountId, userId, deviceId, plan } = input;

  if (input.sessionJson) {
    const parsed = parseSessionPayload(input.sessionJson);
    email = parsed.email;
    token = parsed.token;
    accountId = parsed.accountId || accountId;
    userId = parsed.userId || userId;
    deviceId = parsed.deviceId || deviceId;
    plan = parsed.plan || plan;
  }

  email = String(email || '').trim().toLowerCase();
  if (!email || !emailPattern.test(email)) {
    throw new NativeWorkbenchError(400, '请提供有效的账号邮箱');
  }

  const now = new Date().toISOString();
  const existingIndex = entries.findIndex((row) => row.email === email);
  const proxySummary = formatProxySummary(input);
  const proxyRegion = input.proxyRegion || 'auto';

  if (existingIndex >= 0) {
    const current = entries[existingIndex];
    const updated = {
      ...current,
      ...(token && { token }),
      ...(accountId && { accountId }),
      ...(userId && { userId }),
      ...(deviceId && { deviceId }),
      ...(plan && { currentPlan: plan }),
      ...(input.proxyRegion !== undefined && { proxyRegion }),
      proxySummary: input.proxyRegion !== undefined || input.proxySummary !== undefined ? proxySummary : current.proxySummary,
      ...(input.proxyUrl !== undefined && { proxyUrl: String(input.proxyUrl).trim() }),
      ...(input.status && { status: input.status }),
      ...(input.renewalNotes !== undefined && { renewalNotes: String(input.renewalNotes).trim() }),
      updatedAt: now
    };
    entries[existingIndex] = updated;
    return { record: updated, records: entries };
  }

  const record = {
    id: randomUUID(),
    email,
    accountId: accountId || '',
    userId: userId || '',
    token: token || '',
    deviceId: deviceId || '',
    proxyRegion,
    proxyUrl: String(input.proxyUrl || '').trim(),
    proxySummary,
    status: input.status || 'pending_renewal',
    currentPlan: plan || 'free',
    lastOpenedAt: null,
    renewalNotes: String(input.renewalNotes || '').trim(),
    createdAt: now,
    updatedAt: now
  };
  entries.push(record);
  return { record, records: entries };
}

/**
 * Mark renewal outcome or update user note.
 */
export function updateWorkbenchNote(records = [], { id, status, currentPlan, renewalNotes } = {}) {
  const entries = Array.isArray(records) ? [...records] : [];
  const index = entries.findIndex((row) => row.id === id);
  if (index < 0) {
    throw new NativeWorkbenchError(404, '该账号记录不存在或已被移除');
  }
  const current = entries[index];
  const updated = {
    ...current,
    ...(status && { status }),
    ...(currentPlan && { currentPlan }),
    ...(renewalNotes !== undefined && { renewalNotes: String(renewalNotes).trim() }),
    updatedAt: new Date().toISOString()
  };
  entries[index] = updated;
  return { record: updated, records: entries };
}

/**
 * Replace an account's authorization JSON (when the previous session token expires)
 * and update credentials in-place.
 */
export function updateAccountSessionJson(records = [], id, sessionJson) {
  const entries = Array.isArray(records) ? [...records] : [];
  const index = entries.findIndex((row) => row.id === id);
  if (index < 0) {
    throw new NativeWorkbenchError(404, '该账号记录不存在');
  }
  const current = entries[index];
  const parsed = parseSessionPayload(sessionJson);

  if (parsed.email && current.email && parsed.email !== current.email) {
    throw new NativeWorkbenchError(400, `粘贴的 JSON 邮箱 (${parsed.email}) 与当前账号 (${current.email}) 不一致`);
  }

  const updated = {
    ...current,
    token: parsed.token,
    deviceId: parsed.deviceId || current.deviceId,
    accountId: parsed.accountId || current.accountId,
    userId: parsed.userId || current.userId,
    currentPlan: parsed.plan || current.currentPlan,
    status: 'pending_renewal',
    updatedAt: new Date().toISOString()
  };
  entries[index] = updated;
  return { record: updated, records: entries };
}

/**
 * Delete an account record.
 */
export function removeWorkbenchAccount(records = [], id) {
  const entries = Array.isArray(records) ? [...records] : [];
  const next = entries.filter((row) => row.id !== id);
  if (next.length === entries.length) {
    throw new NativeWorkbenchError(404, '该账号记录不存在');
  }
  return { records: next };
}

/**
 * Execute native Chrome launch for an account.
 */
export async function launchWorkbenchBrowser(records = [], id, {
  customProxyUrl = '',
  ownerId = '',
  windowSize = '1280,800',
  exitInfo = null,
  skipSessionRotation = false
} = {}) {
  const entries = Array.isArray(records) ? [...records] : [];
  const index = entries.findIndex((row) => row.id === id);
  if (index < 0) {
    throw new NativeWorkbenchError(404, '该账号记录不存在');
  }
  const account = entries[index];
  const profileKey = operatorBrowserProfileKey('chatgpt', ownerId, account.id);
  const proxyUrl = customProxyUrl || account.proxyUrl;

  const result = await launchNativeChrome({
    profileKey,
    scopeId: account.id,
    proxyUrl,
    skipSessionRotation,
    token: account.token,
    deviceId: account.deviceId,
    windowSize,
    ownerId,
    exitInfo
  });

  const now = new Date().toISOString();
  entries[index] = { ...account, lastOpenedAt: now, updatedAt: now };

  return {
    ok: true,
    result,
    account: {
      id: account.id,
      email: account.email,
      profileKey,
      proxyRegion: account.proxyRegion || 'auto',
      proxySummary: account.proxySummary || '',
      lastOpenedAt: now
    },
    records: entries
  };
}

/**
 * Close native Chrome instance for an account and stop proxy usage immediately.
 */
export function closeWorkbenchBrowser(records = [], id, ownerId) {
  const entries = Array.isArray(records) ? [...records] : [];
  const index = entries.findIndex((row) => row.id === id);
  if (index < 0) {
    throw new NativeWorkbenchError(404, '该账号记录不存在');
  }
  const account = entries[index];
  const closed = closeNativeBrowser(operatorBrowserProfileKey('chatgpt', ownerId, account.id), ownerId);
  return { ok: true, closed, id: account.id };
}
