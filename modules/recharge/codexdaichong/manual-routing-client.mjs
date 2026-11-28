import { createHash } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { signRechargeAssertion } from '../assertion.mjs';
import { validateRuntimeOrigin } from './runtime-health.mjs';

export const manualRoutingPrefix = '/api/internal/manual-routing/';
export const manualRoutingDigest = value => createHash('sha256').update(value).digest('hex');

export class ManualRouteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Never route a signed internal request or its credential-bearing reply through a
// process-wide fetch dispatcher or HTTP_PROXY, including Node's --use-env-proxy.
const loopbackAgent = new Agent({ keepAlive: true, proxyEnv: {} });
function postJson(url, body, assertion, timeout) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { agent: loopbackAgent, method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'x-id-recharge-assertion': assertion } }, async res => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of res) {
          length += chunk.length;
          if (length > 1024 * 1024) throw new Error('adapter_response_too_large');
          chunks.push(chunk);
        }
        resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

// This transport only talks to the authenticated loopback adapter. The consume
// response contains server-only proxy credentials; its caller passes it to the broker.
export function createManualRoutingClient(config) {
  const upstream = config && validateRuntimeOrigin(config.upstreamUrl);
  async function request(operation, actor, command) {
    if (!actor?.active || !['admin', 'super'].includes(actor.role) || typeof actor.id !== 'string' || !actor.id)
      throw new ManualRouteError(403, '无权使用手动充值工作台');
    if (!upstream || !config.secret) throw new ManualRouteError(503, '手动充值线路服务尚未配置');
    const body = JSON.stringify(command);
    const path = manualRoutingPrefix + operation + '?digest=' + manualRoutingDigest(body);
    const principal = { id: 'manual-routing:' + manualRoutingDigest(actor.id), email: 'manual-routing@localhost',
      admin: true, sensitive: false };
    try {
      const { status, payload } = await postJson(upstream + path, body,
        signRechargeAssertion(config.secret, 'POST', path, principal), operation === 'probe' ? 35_000 : 10_000);
      if (status !== 200 || payload.success !== true) {
        const known = [400, 403, 409, 422, 429, 503].includes(status);
        throw new ManualRouteError(known ? status : 503,
          known && typeof payload.error === 'string' ? payload.error : '线路服务暂不可用，请稍后重试');
      }
      return payload.result;
    } catch (error) {
      if (error instanceof ManualRouteError) throw error;
      throw new ManualRouteError(503, '未能取得线路服务回执，请重新测速');
    }
  }
  return {
    options: (actor, plan = '') => request('options', actor, { plan: plan || '' }),
    probe: (actor, command) => request('probe', actor, command),
    consume: (actor, command) => request('consume', actor, command),
    validate: (actor, command) => request('validate', actor, command)
  };
}
