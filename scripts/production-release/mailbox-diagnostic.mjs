import { pathToFileURL } from 'node:url';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 4096;
const REQUEST_TIMEOUT = 20_000;
const TOTAL_TIMEOUT = 45_000;
const OWNER_MESSAGE = '共享平台资源仅允许超级管理员在平台管理中心管理';
const OPERATIONS = [
  ['primaryAccounts', 'icloudPrimaryAccounts'],
  ['virtualEmails', 'icloudVirtualEmails']
];
const GRAPHQL_CODES = new Set([
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED',
  'BAD_USER_INPUT',
  'USER_INPUT_ERROR',
  'INTERNAL_SERVER_ERROR'
]);
const NETWORK_CODES = new Map([
  ['ENOTFOUND', 'DNS_ERROR'],
  ['EAI_AGAIN', 'DNS_ERROR'],
  ['ECONNREFUSED', 'CONNECTION_REFUSED'],
  ['ECONNRESET', 'CONNECTION_RESET'],
  ['ETIMEDOUT', 'TIMEOUT'],
  ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'],
  ['UND_ERR_BODY_TIMEOUT', 'TIMEOUT'],
  ['EHOSTUNREACH', 'NETWORK_UNREACHABLE'],
  ['ENETUNREACH', 'NETWORK_UNREACHABLE'],
  ['CERT_HAS_EXPIRED', 'TLS_ERROR'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_ERROR'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_ERROR'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_ERROR'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'TLS_ERROR'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_ERROR']
]);

function item(category, code, status = null, count = null, path = []) {
  return { category, status, count, code, path };
}

function failureReceipt(config, category, code) {
  return {
    ...config,
    ...Object.fromEntries(OPERATIONS.map(([name]) => [name, item(category, code)]))
  };
}

function configuration(env) {
  const raw = env.VENDURE_MAILBOX_ADMIN_API_URL?.trim();
  const key = env.VENDURE_MAILBOX_API_KEY?.trim();
  const config = { configured: false, https: false, adminPath: false, queryChannelPresent: false };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { config, code: 'INVALID_CONFIGURATION' };
  }
  config.configured = Boolean(key && ['http:', 'https:'].includes(url.protocol));
  config.https = url.protocol === 'https:';
  config.adminPath = /^\/admin-api\/?$/.test(url.pathname);
  config.queryChannelPresent = url.searchParams.has('vendure-token');
  if (url.username || url.password) return { config, code: 'URL_CREDENTIALS_REJECTED' };
  if (!config.configured) return { config, code: 'INVALID_CONFIGURATION' };
  if (!config.https) return { config, code: 'HTTPS_REQUIRED' };
  if (!config.adminPath) return { config, code: 'ADMIN_PATH_REQUIRED' };
  return { config, url, key };
}

async function readEnvelope(response) {
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw Object.assign(new Error(), { safeCode: 'RESPONSE_TOO_LARGE' });
  }
  if (!response.body) throw Object.assign(new Error(), { safeCode: 'INVALID_JSON' });
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw Object.assign(new Error(), { safeCode: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw Object.assign(new Error(), { safeCode: 'INVALID_JSON' });
  }
}

function graphqlFailure(envelope, root, status) {
  if (!Array.isArray(envelope?.errors) || !envelope.errors.length) return null;
  const errors = envelope.errors;
  const ownerError = errors.find(
    (value) =>
      value?.message === OWNER_MESSAGE &&
      value?.extensions?.code === 'USER_INPUT_ERROR' &&
      Array.isArray(value.path) &&
      value.path.length === 1 &&
      value.path[0] === root
  );
  const error = ownerError || errors[0];
  const path = Array.isArray(error?.path) && error.path[0] === root ? [root] : [];
  if (ownerError) {
    return item('AUTHORIZATION', 'PLATFORM_OWNER_REQUIRED', status, null, path);
  }
  const codes = errors.map((value) => value?.extensions?.code);
  const code =
    codes.find((value) => ['FORBIDDEN', 'UNAUTHENTICATED'].includes(value)) ||
    codes.find((value) => GRAPHQL_CODES.has(value)) ||
    'GRAPHQL_ERROR';
  const category = ['FORBIDDEN', 'UNAUTHENTICATED'].includes(code) ? 'AUTHORIZATION' : 'GRAPHQL';
  return item(category, code, status, null, path);
}

function networkFailure(error, status) {
  if (['AbortError', 'TimeoutError'].includes(error?.name)) {
    return item('NETWORK', 'TIMEOUT', status);
  }
  if (['INVALID_JSON', 'RESPONSE_TOO_LARGE'].includes(error?.safeCode)) {
    return item('RESPONSE', error.safeCode, status);
  }
  if (error?.cause?.message === 'unexpected redirect') {
    return item('HTTP', 'REDIRECT_BLOCKED', status);
  }
  const code = NETWORK_CODES.get(error?.cause?.code) || NETWORK_CODES.get(error?.code);
  return item('NETWORK', code || 'NETWORK_ERROR', status);
}

async function request(url, key, root, fetchImpl, timeout) {
  const controller = new AbortController();
  let status = null;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(), { name: 'TimeoutError' }));
    }, timeout);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'cache-control': 'no-store',
            'vendure-api-key': key
          },
          body: JSON.stringify({ query: `query { ${root} { id } }`, variables: {} }),
          redirect: 'error',
          signal: controller.signal
        });
        status =
          Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
            ? response.status
            : null;
        if (status === null) return item('RESPONSE', 'INVALID_RESPONSE');
        if (status >= 300 && status <= 399) return item('HTTP', 'REDIRECT_BLOCKED', status);
        let envelope;
        try {
          envelope = await readEnvelope(response);
        } catch (error) {
          if (error?.safeCode === 'INVALID_JSON' && !response.ok) {
            return status === 401 || status === 403
              ? item('AUTHORIZATION', 'HTTP_AUTHORIZATION', status)
              : item('HTTP', 'HTTP_ERROR', status);
          }
          throw error;
        }
        const failure = graphqlFailure(envelope, root, status);
        if (failure) return failure;
        if (status === 401 || status === 403)
          return item('AUTHORIZATION', 'HTTP_AUTHORIZATION', status);
        if (!response.ok) return item('HTTP', 'HTTP_ERROR', status);
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          Array.isArray(envelope) ||
          (envelope.errors !== undefined && !Array.isArray(envelope.errors))
        ) {
          return item('RESPONSE', 'INVALID_RESPONSE', status);
        }
        const rows = envelope?.data?.[root];
        if (
          !Array.isArray(rows) ||
          rows.some((row) => !['string', 'number'].includes(typeof row?.id))
        ) {
          return item('RESPONSE', 'INVALID_RESPONSE', status);
        }
        return item('SUCCESS', 'OK', status, rows.length, [root]);
      })(),
      expired
    ]);
  } catch (error) {
    return networkFailure(error, status);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function diagnoseMailbox({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { config, url, key, code } = configuration(env);
  if (code) return failureReceipt(config, 'CONFIGURATION', code);
  const result = { ...config };
  const deadline = performance.now() + TOTAL_TIMEOUT;
  for (const [name, root] of OPERATIONS) {
    const remaining = deadline - performance.now();
    result[name] =
      remaining <= 0
        ? item('NETWORK', 'TOTAL_TIMEOUT')
        : await request(url, key, root, fetchImpl, Math.min(REQUEST_TIMEOUT, remaining));
  }
  return result;
}

function print(receipt) {
  const output = JSON.stringify(receipt) + '\n';
  if (Buffer.byteLength(output) > OUTPUT_LIMIT) process.exit(1);
  process.stdout.write(output, () => process.exit(0));
}

if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  const fallback = failureReceipt(configuration(process.env).config, 'NETWORK', 'TOTAL_TIMEOUT');
  const watchdog = setTimeout(() => print(fallback), TOTAL_TIMEOUT);
  try {
    print(await diagnoseMailbox());
  } catch {
    print(failureReceipt(configuration(process.env).config, 'RESPONSE', 'DIAGNOSTIC_FAILED'));
  } finally {
    clearTimeout(watchdog);
  }
}
