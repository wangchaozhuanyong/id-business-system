import { createHmac, timingSafeEqual } from 'node:crypto';
import { monitorPath, monitorReportPath, readyPath, monitoringError } from './monitoring-policy.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const known = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const incidentStates = ['', 'open', 'acknowledged', 'resolved'];
const deliveryStates = ['', 'queued', 'sending', 'accepted', 'failed', 'unknown', 'cancelled'];

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8192) {
      request.resume();
      throw monitoringError(413, '监控请求过长');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parse(body) {
  try { return JSON.parse(body); } catch { throw monitoringError(400, '监控请求格式无效'); }
}

function viewQuery(request, origin) {
  const params = new URL(request.url, origin).searchParams;
  const { tab = 'incidents', status = '', page = '1', pageSize = '20', q = '', days = '0', priority = '' } = Object.fromEntries(params);
  if ([...params.keys()].some(key => !['tab', 'status', 'page', 'pageSize', 'q', 'days', 'priority'].includes(key) || params.getAll(key).length > 1) ||
      !['incidents', 'config', 'deliveries', 'legacy'].includes(tab) ||
      !(tab === 'deliveries' ? deliveryStates : incidentStates).includes(status) ||
      q.length > 100 || /[\u0000-\u001f]/.test(q) || !['0', '1', '7', '30'].includes(days) ||
      !['', 'P0', 'P1', 'P2'].includes(priority) || (tab !== 'incidents' && priority !== '') ||
      !/^[1-9]\d{0,5}$/.test(page) || !['10', '20', '50'].includes(pageSize)) throw monitoringError(400, '监控筛选条件无效');
  return { tab, status, page: Number(page), pageSize: Number(pageSize), q: q.trim(), days: Number(days), priority };
}

export function createMonitoringHandler({ monitor, publicOrigin, confirmSettings }) {
  return async (request, response, actor) => {
    const origin = publicOrigin || 'http://' + request.headers.host;
    if (!actor?.id) return json(response, 401, { error: '请先登录' });
    if (!['admin', 'super'].includes(actor.role)) return json(response, 403, { error: '当前账号无权查看监控' });
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return json(response, 403, { error: '请求来源未通过校验' });
    try {
      if (request.method === 'GET') {
        const query = viewQuery(request, origin);
        if (query.tab === 'incidents') return json(response, 200, monitor.view(query));
        if (query.tab === 'legacy') return json(response, 200, { phase: monitor.legacyStatus().phase });
        if (actor.role !== 'super') return json(response, 403, { error: '仅超级管理员可以管理通知' });
        return json(response, 200, query.tab === 'config' ? monitor.configView() : monitor.view(query));
      }
      if (request.method !== 'POST') return json(response, 405, { error: '不支持此监控操作' });
      if (request.url !== monitorPath || request.headers.origin !== origin ||
          !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
        return json(response, 403, { error: '请从当前页面提交监控操作' });
      const body = parse(await readBody(request));
      if (known(body, ['action', 'id']) && body.action === 'acknowledge' && typeof body.id === 'string' && uuid.test(body.id))
        return json(response, 200, monitor.acknowledge(body.id, actor));
      if (actor.role !== 'super') return json(response, 403, { error: '仅超级管理员可以管理通知' });
      if (confirmSettings && !confirmSettings(request))
        return json(response, 403, { error: '请先在「我的账号」完成安全确认，再提交这项操作' });
      if (known(body, ['action', 'code', 'reference']) && body.action === 'verified' &&
          ['payment_duplicate', 'security_confirmed'].includes(body.code) &&
          typeof body.reference === 'string' && uuid.test(body.reference)) {
        const recorded = monitor.observe([{ code: body.code, scope: body.reference, status: 'bad' }],
          { action: 'monitor_verified', actor, targetId: body.reference });
        return json(response, 200, { recorded });
      }
      if (!object(body) || !Number.isSafeInteger(body.version) || body.version < 0)
        throw monitoringError(400, '监控设置版本无效');
      if (known(body, ['action', 'version', 'settings']) && body.action === 'settings')
        return json(response, 200, monitor.save(body.version, body.settings, actor));
      if (known(body, ['action', 'version', 'target']) && body.action === 'test' && typeof body.target === 'string')
        return json(response, 202, monitor.queueTest(body.version, body.target, actor));
      if (known(body, ['action', 'version']) && body.action === 'legacy-import')
        return json(response, 200, await monitor.importLegacy(body.version, actor));
      if (known(body, ['action', 'version', 'confirm']) && body.action === 'legacy-takeover' && body.confirm === true)
        return json(response, 200, await monitor.takeOver(body.version, actor));
      throw monitoringError(400, '监控操作格式无效');
    } catch (error) {
      const status = [400, 404, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 503;
      return json(response, status, { error: status === 503 && !error.status
        ? '监控资料暂时无法处理，请稍后重试' : error.message });
    }
  };
}

export function signMonitoringReport(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function createProbeReportHandler({ monitor, secret, clock = Date.now }) {
  const enabled = typeof secret === 'string' && Buffer.byteLength(secret) >= 32;
  return async (request, response) => {
    if (!enabled || request.url !== monitorReportPath) return response.writeHead(404).end();
    if (request.method !== 'POST' || request.headers.origin || request.headers.cookie ||
        !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
      return response.writeHead(403).end();
    try {
      const signature = request.headers['x-id-probe-signature'];
      if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return response.writeHead(403).end();
      const body = await readBody(request);
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signMonitoringReport(secret, body), 'hex')))
        return response.writeHead(403).end();
      const report = parse(body);
      const now = clock();
      if (!known(report, ['at', 'status', 'certificateDays', 'incident']) ||
          !Number.isSafeInteger(report.at) || report.at > now + 60_000 || now - report.at > 120_000 ||
          !['ok', 'bad'].includes(report.status) ||
          !(report.certificateDays === null || (Number.isSafeInteger(report.certificateDays) && report.certificateDays >= 0 && report.certificateDays <= 1000)))
        return response.writeHead(400).end();
      const { incident } = report;
      if (incident !== undefined && (!known(incident, ['id', 'at', 'accepted', 'recoveredAt']) ||
          typeof incident.id !== 'string' || !uuid.test(incident.id) ||
          !Number.isSafeInteger(incident.at) || incident.at <= 0 || incident.at > report.at ||
          typeof incident.accepted !== 'boolean' || (incident.recoveredAt !== undefined &&
            (!Number.isSafeInteger(incident.recoveredAt) || incident.recoveredAt <= incident.at || incident.recoveredAt > report.at))))
        return response.writeHead(400).end();
      monitor.receiveProbe(report);
      return response.writeHead(204).end();
    } catch (error) {
      return response.writeHead([400, 413].includes(error.status) ? error.status : 503).end();
    }
  };
}

export function createMonitoringReadiness({ check, clock = Date.now }) {
  let checkedAt = -Infinity;
  let ready = false;
  return (request, response) => {
    if (request.url !== readyPath) return response.writeHead(404).end();
    if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    const at = clock();
    if (at - checkedAt >= 5000) {
      try { ready = check() === true; } catch { ready = false; }
      checkedAt = at;
    }
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : ready ? 'id-business-ready\n' : 'unavailable\n');
  };
}
