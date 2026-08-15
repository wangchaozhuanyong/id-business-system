import { createParamDecorator, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const CLIENT_IP_HEADER = 'x-v2-client-ip';
const PROXY_TIMESTAMP_HEADER = 'x-v2-proxy-timestamp';
const PROXY_SIGNATURE_HEADER = 'x-v2-proxy-signature';
const REQUEST_ID_HEADER = 'x-request-id';
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export interface RequestWithClientIp {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string | null;
}

interface TrustedProxyEnvironment {
  SUPABASE_EDGE_FUNCTION?: string;
  V2_TRUSTED_PROXY_SECRET?: string;
}

export function resolveTrustedClientIp(
  request: RequestWithClientIp | undefined,
  environment: TrustedProxyEnvironment = process.env,
  now = Date.now()
) {
  const secret = environment.V2_TRUSTED_PROXY_SECRET?.trim();
  if (secret) {
    const signedIp = verifySignedClientIp(request, secret, now);
    if (signedIp) return signedIp;
    if (environment.SUPABASE_EDGE_FUNCTION === 'true') {
      throw new ServiceUnavailableException('请求未经过可信代理，暂时无法处理。');
    }
  }

  return normalizeIp(request?.ip);
}

export const TrustedClientIp = createParamDecorator((_data, context) =>
  resolveTrustedClientIp(context.switchToHttp().getRequest<RequestWithClientIp>())
);

function verifySignedClientIp(
  request: RequestWithClientIp | undefined,
  secret: string,
  now: number
) {
  if (secret.length < 32) return undefined;
  const clientIp = normalizeIp(readHeader(request, CLIENT_IP_HEADER));
  const timestampValue = readHeader(request, PROXY_TIMESTAMP_HEADER)?.trim();
  const signature = readHeader(request, PROXY_SIGNATURE_HEADER)?.trim().toLowerCase();
  const requestId = readHeader(request, REQUEST_ID_HEADER)?.trim();
  if (!clientIp || !timestampValue || !signature || !requestId) return undefined;
  if (!/^\d{13}$/.test(timestampValue) || !/^[a-f0-9]{64}$/.test(signature)) return undefined;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) return undefined;

  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return undefined;
  }

  const expected = createHmac('sha256', secret)
    .update(createSignaturePayload(timestampValue, requestId, clientIp))
    .digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected)
    ? clientIp
    : undefined;
}

function createSignaturePayload(timestamp: string, requestId: string, clientIp: string) {
  return `${timestamp}\n${requestId}\n${clientIp}`;
}

function readHeader(request: RequestWithClientIp | undefined, name: string) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIp(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && isIP(normalized) ? normalized : undefined;
}
