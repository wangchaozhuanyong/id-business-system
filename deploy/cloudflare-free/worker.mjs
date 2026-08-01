import { httpServerHandler } from 'cloudflare:node';
import { createCloudflareV2HttpServer } from '../../apps/api/dist-cloudflare/cloudflare-v2-bootstrap.js';
import { runWithCloudflarePrisma } from '../../apps/api/dist-cloudflare/common/prisma/cloudflare-prisma.service.js';

let handlerPromise;
let coldStart = true;

export default {
  async fetch(request, env, context) {
    const startedAt = performance.now();
    const requestId = resolveRequestId(request.headers.get('x-request-id'));
    const cfRay = request.headers.get('cf-ray') ?? undefined;
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-request-id', requestId);
    const correlatedRequest = new Request(request, { headers: requestHeaders });
    const wasColdStart = coldStart;
    coldStart = false;

    try {
      const response = await runWithCloudflarePrisma(async () => {
        const handler = await getNestHandler();
        return handler.fetch(correlatedRequest, env, context);
      }, env.HYPERDRIVE?.connectionString);
      const correlatedResponse = withRequestId(response, requestId);
      const errorCode = await readResponseErrorCode(correlatedResponse);
      logRequest({
        cfRay,
        coldStart: wasColdStart,
        durationMs: performance.now() - startedAt,
        errorCode,
        request: correlatedRequest,
        requestId,
        status: correlatedResponse.status
      });
      return correlatedResponse;
    } catch (error) {
      logRequest({
        cfRay,
        coldStart: wasColdStart,
        durationMs: performance.now() - startedAt,
        errorCode: 'SERVICE_UNAVAILABLE',
        errorName: error instanceof Error ? error.name : 'UnknownWorkerException',
        request: correlatedRequest,
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

async function createNestHandler() {
  const server = await createCloudflareV2HttpServer();
  return httpServerHandler(server);
}

function getNestHandler() {
  handlerPromise ??= createNestHandler().catch((error) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

function resolveRequestId(value) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(normalized) ? normalized : crypto.randomUUID();
}

function withRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

async function readResponseErrorCode(response) {
  if (response.status < 500) return null;
  try {
    const body = await response.clone().json();
    return typeof body?.errorCode === 'string' && body.errorCode
      ? body.errorCode
      : 'WORKER_REQUEST_FAILED';
  } catch {
    return 'WORKER_REQUEST_FAILED';
  }
}

function logRequest(input) {
  if (input.status < 500 && Math.random() >= 0.1) return;
  console.log(
    JSON.stringify({
      cfRay: input.cfRay ?? null,
      coldStart: input.coldStart,
      durationMs: Number(input.durationMs.toFixed(1)),
      errorCode: input.errorCode ?? null,
      errorName: input.errorName ?? null,
      method: input.request.method,
      path: new URL(input.request.url).pathname,
      requestId: input.requestId,
      status: input.status,
      type: 'edge_request_complete'
    })
  );
}
