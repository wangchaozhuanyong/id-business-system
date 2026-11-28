import { isIP } from 'node:net';
import { signRechargeAssertion } from '../assertion.mjs';

const path = '/api/public/runtime';
const probeActor = Object.freeze({
  id: 'recharge-runtime-health',
  email: 'health@localhost',
  admin: false,
  sensitive: false
});

export function validateRuntimeOrigin(value) {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1 ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new TypeError('代充服务必须使用独立的 127.0.0.1 HTTP 回环端口');
  return url.origin;
}

export async function probeCodexdaichongRuntime({
  upstreamUrl,
  secret,
  actor = probeActor,
  clientIp,
  timeoutMs = 3000
}) {
  const origin = validateRuntimeOrigin(upstreamUrl);
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw new TypeError('需要至少 32 字节的桥接密钥');
  try {
    const response = await fetch(origin + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(isIP(clientIp) ? { 'x-real-ip': clientIp } : {}),
        'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', path, actor)
      }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ready: false,
        reason: [401, 403].includes(response.status) ? 'bridge_rejected' : 'runtime_not_ready'
      };
    }
    if (!response.body) return { ready: false, reason: 'invalid_runtime_response' };
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 4096) return { ready: false, reason: 'invalid_runtime_response' };
      chunks.push(chunk);
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks));
    } catch {
      return { ready: false, reason: 'invalid_runtime_response' };
    }
    const { active_foreground_jobs: active, max_foreground_jobs: max } = payload?.runtime ?? {};
    if (
      payload?.success !== true ||
      !Number.isSafeInteger(active) ||
      active < 0 ||
      !Number.isSafeInteger(max) ||
      max < 1
    )
      return { ready: false, reason: 'invalid_runtime_response' };
    return { ready: true };
  } catch {
    return { ready: false, reason: 'unreachable' };
  }
}
