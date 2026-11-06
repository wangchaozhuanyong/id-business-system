export const BIT_BROWSER_AUTHORIZATION_MAX_BYTES = 65_000;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sessionTokenPattern = /^[!#$%&'()*+\-./0-9:<=>?@A-Z[\]^_`a-z{|}~]{1,16384}$/;
const validAuthorizations = new WeakSet();
const requiredTaskText = ['id', 'plan', 'addressId', 'windowName', 'lockedCurrency'];
const optionalTaskText = [
  'billingAllocationId',
  'cardId',
  'billingName',
  'proxyId',
  'proxyCountryCode'
];

function decodeAccessClaims(accessToken) {
  const payload = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function readProfileEmail(accessToken) {
  if (typeof accessToken !== 'string') return '';
  try {
    const email = decodeAccessClaims(accessToken)?.['https://api.openai.com/profile']?.email;
    return typeof email === 'string' && emailPattern.test(email.trim())
      ? email.trim().toLowerCase()
      : '';
  } catch {
    // The selected access token is checked independently as part of the credential.
    return '';
  }
}

/**
 * Browser-local preflight. The decoded claims are only used to check consistency.
 * A local executor must still verify the credential with ChatGPT before use.
 */
export function parseBitBrowserAuthorization(sessionJson) {
  if (typeof sessionJson !== 'string' || !sessionJson.trim()) {
    throw new Error('请粘贴完整的单账户授权 JSON');
  }
  if (
    sessionJson.length > BIT_BROWSER_AUTHORIZATION_MAX_BYTES ||
    new TextEncoder().encode(sessionJson).length > BIT_BROWSER_AUTHORIZATION_MAX_BYTES
  ) {
    throw new Error('授权 JSON 超过 65 KB，请提供单账户授权文件');
  }

  try {
    const data = JSON.parse(sessionJson);
    const token = data.sessionToken ?? data.session_token;
    if (
      (data.sessionToken && data.session_token && data.sessionToken !== data.session_token) ||
      typeof token !== 'string' ||
      !sessionTokenPattern.test(token)
    ) {
      throw new Error();
    }

    const access = data.accessToken ?? data.access_token;
    const claims = access ? decodeAccessClaims(access) : null;
    const accountId =
      claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? data.account?.id;
    const userId = data.user?.id;
    if (
      (data.account?.id && data.account.id !== accountId) ||
      typeof accountId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(accountId) ||
      typeof userId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(userId) ||
      typeof data.user.email !== 'string' ||
      !emailPattern.test(data.user.email)
    ) {
      throw new Error();
    }

    const email = data.user.email.toLowerCase();
    const profileEmails = [readProfileEmail(data.accessToken), readProfileEmail(data.access_token)];
    if (profileEmails.some((profileEmail) => profileEmail && profileEmail !== email)) {
      throw new Error();
    }

    const authorization = { email, userId, accountId };
    Object.defineProperty(authorization, 'token', { value: token });
    validAuthorizations.add(authorization);
    return Object.freeze(authorization);
  } catch {
    throw new Error('授权 JSON 缺少有效的会话、用户或账号资料，请重新授权。');
  }
}

/**
 * Keep the parsed credential in the browser. The task service receives only the
 * metadata accepted by the direct recharge start endpoint.
 */
export function buildBitBrowserBackupPayload(authorization, task) {
  if (!validAuthorizations.has(authorization)) {
    throw new Error('请先核对当前浏览器中的授权 JSON');
  }

  const metadata = {};
  const isText = (value) => typeof value === 'string' && value.trim().length > 0;
  const invalidTask = () => new Error('比特备用充值任务资料无效，请核对后重试');
  for (const key of requiredTaskText) {
    const value = task?.[key];
    if (!isText(value)) throw invalidTask();
    metadata[key] = value;
  }
  for (const key of optionalTaskText) {
    const value = task[key];
    if (value === undefined) continue;
    if (!isText(value)) throw invalidTask();
    metadata[key] = value;
  }
  const { connectionProfileId, subscriptionCycleProtocol } = task;
  if (connectionProfileId !== undefined) {
    if (connectionProfileId !== null && !isText(connectionProfileId)) throw invalidTask();
    metadata.connectionProfileId = connectionProfileId;
  }
  if (subscriptionCycleProtocol !== undefined) {
    if (subscriptionCycleProtocol !== 1) throw invalidTask();
    metadata.subscriptionCycleProtocol = subscriptionCycleProtocol;
  }

  return {
    ...metadata,
    expectedEmail: authorization.email,
    directMode: true,
    authorizeSinglePayment: true,
    manualPaymentConfirmation: true
  };
}
