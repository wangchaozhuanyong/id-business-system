const API_PREFIX = '/api';
const SUPABASE_FUNCTION_PATH = '/functions/v1/v2-api';
const SUPABASE_API_BASE_URL = 'https://fjquufgbnxyocmuzltxi.supabase.co/functions/v1/v2-api';
const SUPABASE_FUNCTION_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/u;

export default {
  async fetch(request, env) {
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname !== API_PREFIX && !incomingUrl.pathname.startsWith(`${API_PREFIX}/`)) {
      return Response.json(
        {
          success: false,
          errorCode: 'NOT_FOUND',
          message: '请求地址不存在。',
          requestId,
          retryable: false,
          timestamp: new Date().toISOString()
        },
        { status: 404, headers: { 'X-Request-Id': requestId } }
      );
    }

    try {
      const targetUrl = resolveTargetUrl(incomingUrl, env.SUPABASE_API_BASE_URL);
      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.delete('host');
      upstreamHeaders.set('x-forwarded-host', incomingUrl.host);
      upstreamHeaders.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));
      upstreamHeaders.set('x-request-id', requestId);
      await applyTrustedClientIpHeaders(upstreamHeaders, request, env, requestId);
      const functionRegion = resolveFunctionRegion(env.SUPABASE_FUNCTION_REGION);
      if (functionRegion) {
        upstreamHeaders.set('x-region', functionRegion);
      } else {
        // Region routing is deployment-owned. Never trust a caller-provided override.
        upstreamHeaders.delete('x-region');
      }

      const upstreamRequest = new Request(new Request(targetUrl, request), {
        headers: upstreamHeaders,
        redirect: 'manual'
      });
      const upstreamResponse = await fetch(upstreamRequest);
      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set('Cache-Control', 'no-store');
      responseHeaders.set(
        'X-Request-Id',
        upstreamResponse.headers.get('x-request-id') ?? requestId
      );

      if (upstreamResponse.status >= 500) {
        logProxyFailure({
          method: request.method,
          path: incomingUrl.pathname,
          requestId,
          status: upstreamResponse.status
        });
      }

      return new Response(upstreamResponse.body, {
        headers: responseHeaders,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText
      });
    } catch (error) {
      logProxyFailure({
        errorName: error instanceof Error ? error.name : 'UnknownProxyException',
        method: request.method,
        path: incomingUrl.pathname,
        requestId,
        status: 503
      });
      return Response.json(
        {
          success: false,
          errorCode: 'SERVICE_UNAVAILABLE',
          message: '服务暂时不可用，请稍后重试。',
          requestId,
          retryable: true,
          timestamp: new Date().toISOString()
        },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '1',
            'X-Request-Id': requestId
          }
        }
      );
    }
  }
};

export function resolveTargetUrl(incomingUrl, apiBaseUrl) {
  const baseUrl = new URL(String(apiBaseUrl ?? ''));
  if (baseUrl.href.replace(/\/+$/, '') !== SUPABASE_API_BASE_URL) {
    throw new Error('SUPABASE_API_BASE_URL is invalid');
  }

  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = `${SUPABASE_FUNCTION_PATH}${incomingUrl.pathname}`;
  targetUrl.search = incomingUrl.search;
  return targetUrl;
}

export function resolveFunctionRegion(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (!SUPABASE_FUNCTION_REGION_PATTERN.test(normalized)) {
    throw new Error('SUPABASE_FUNCTION_REGION is invalid');
  }
  return normalized;
}

function resolveRequestId(value) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : crypto.randomUUID();
}

async function applyTrustedClientIpHeaders(headers, request, env, requestId) {
  const secret = String(env.V2_TRUSTED_PROXY_SECRET ?? '').trim();
  const clientIp = String(request.headers.get('cf-connecting-ip') ?? '').trim();
  if (secret.length < 32) throw new Error('V2_TRUSTED_PROXY_SECRET is invalid');
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(clientIp)) {
    throw new Error('Cloudflare client IP is unavailable');
  }

  const timestamp = String(Date.now());
  const signature = await createClientIpSignature(secret, timestamp, requestId, clientIp);
  for (const name of [
    'cf-connecting-ip',
    'forwarded',
    'x-forwarded-for',
    'x-real-ip',
    'x-v2-client-ip',
    'x-v2-proxy-timestamp',
    'x-v2-proxy-signature'
  ]) {
    headers.delete(name);
  }
  headers.set('x-v2-client-ip', clientIp);
  headers.set('x-v2-proxy-timestamp', timestamp);
  headers.set('x-v2-proxy-signature', signature);
}

async function createClientIpSignature(secret, timestamp, requestId, clientIp) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}\n${requestId}\n${clientIp}`)
  );
  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function logProxyFailure(input) {
  console.log(
    JSON.stringify({
      errorName: input.errorName ?? null,
      method: input.method,
      path: input.path,
      requestId: input.requestId,
      status: input.status,
      target: 'supabase-v2-api'
    })
  );
}
