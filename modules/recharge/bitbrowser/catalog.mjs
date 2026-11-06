// Read-only browser catalog subset of the pinned BitBrowser direct API.
const messages = {
  bitbrowser_secure_context_required: '请通过本机安全地址打开管理网站，再连接比特浏览器。',
  bitbrowser_direct_unreachable:
    '无法访问比特浏览器。请启动比特浏览器、开启本地接口，并允许此页面访问本机网络。',
  bitbrowser_direct_token_invalid: '请填写当前电脑比特浏览器系统设置中的接口密钥。',
  bitbrowser_direct_rejected: '比特接口未返回成功结果，请核对客户端登录状态和接口权限。',
  bitbrowser_direct_protocol: '无法确认比特接口地址或返回数据，请核对本机接口设置。',
  bitbrowser_direct_cancelled: '本次连接检测已取消。',
  local_api_login_required: '当前比特客户端尚未登录或登录已过期，请在客户端登录后重试。',
  local_api_permission_denied: '当前比特账号无权读取窗口资料，请核对本地接口及分组权限。'
};

export class BitBrowserCatalogError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'bitbrowser_direct_protocol';
    super(messages[safeCode]);
    this.name = 'BitBrowserCatalogError';
    this.code = safeCode;
  }
}

function localOrigin(value) {
  if (
    typeof value !== 'string' ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(value)
  ) {
    throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
  }
  const url = URL.parse(value);
  if (!url?.port || Number(url.port) < 1) {
    throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
  }
  return url.origin;
}

function refusalCode(result) {
  const hint = [result?.msg, result?.message]
    .filter((value) => typeof value === 'string')
    .map((value) => value.slice(0, 300))
    .join(' ');
  if (
    /未登录|尚未登录|请先登录|登录.{0,8}(?:过期|失效)|not.?logged|login.{0,12}(?:required|expired)|log.?in first/i.test(
      hint
    )
  ) {
    return 'local_api_login_required';
  }
  if (/没有权限|无权限|权限不足|permission denied|not permitted|forbidden/i.test(hint)) {
    return 'local_api_permission_denied';
  }
  return 'bitbrowser_direct_rejected';
}

function catalogRows(value) {
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') break;
    value = value.list ?? value.data;
  }
  throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
}

function choices(rows, nameKey) {
  if (rows.length > 2000) throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
  const ids = new Set();
  return rows.map((row) => {
    if (
      typeof row?.id !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row[nameKey] !== 'string' ||
      !row[nameKey].trim() ||
      row[nameKey].length > 80
    ) {
      throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
    }
    ids.add(row.id);
    return { id: row.id, name: row[nameKey] };
  });
}

export async function readBitBrowserCatalog({ url, token, signal } = {}) {
  if (globalThis.isSecureContext === false) {
    throw new BitBrowserCatalogError('bitbrowser_secure_context_required');
  }
  const origin = localOrigin(url);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new BitBrowserCatalogError('bitbrowser_direct_token_invalid');
  }

  async function post(path, body = {}) {
    let response;
    let value;
    const timeout = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      response = await fetch(origin + path, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-api-key': token },
        body: JSON.stringify(body),
        signal: requestSignal
      });
    } catch {
      throw new BitBrowserCatalogError(
        signal?.aborted ? 'bitbrowser_direct_cancelled' : 'bitbrowser_direct_unreachable'
      );
    }
    if ([401, 403].includes(response.status)) {
      throw new BitBrowserCatalogError('bitbrowser_direct_token_invalid');
    }
    try {
      value = await response.json();
    } catch {
      throw new BitBrowserCatalogError(
        signal?.aborted ? 'bitbrowser_direct_cancelled' : 'bitbrowser_direct_protocol'
      );
    }
    if (!response.ok || value?.success !== true) {
      throw new BitBrowserCatalogError(refusalCode(value));
    }
    return value;
  }

  await post('/health');
  const groups = [];
  for (let page = 0; ; page++) {
    const rows = catalogRows(await post('/group/list', { page, pageSize: 100, all: true }));
    groups.push(...rows);
    if (groups.length > 2000 || page > 20) {
      throw new BitBrowserCatalogError('bitbrowser_direct_protocol');
    }
    if (rows.length < 100) break;
  }
  return {
    groups: choices(groups, 'groupName'),
    tags: choices(catalogRows(await post('/browserTag/list')), 'tagName')
  };
}
