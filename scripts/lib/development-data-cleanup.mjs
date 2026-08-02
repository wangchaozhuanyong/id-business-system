const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

export function assertLocalAcceptanceDatabase(apiBaseUrlValue, databaseUrlValue) {
  const apiBaseUrl = parseRequiredUrl(apiBaseUrlValue, '验收 API 地址');
  if (
    !['http:', 'https:'].includes(apiBaseUrl.protocol) ||
    !LOCAL_HOSTS.has(normalizeHostname(apiBaseUrl.hostname))
  ) {
    throw new Error('验收 API 必须使用 localhost、127.0.0.1 或 ::1');
  }

  const databaseUrl = parseRequiredUrl(databaseUrlValue, '验收 DATABASE_URL');
  if (
    !DATABASE_PROTOCOLS.has(databaseUrl.protocol) ||
    !LOCAL_HOSTS.has(normalizeHostname(databaseUrl.hostname))
  ) {
    throw new Error('验收数据库必须使用本机 PostgreSQL，禁止连接远程或生产数据库');
  }
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

function parseRequiredUrl(value, label) {
  if (!value?.trim()) {
    throw new Error(`${label}不能为空`);
  }
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label}格式不正确`);
  }
}
