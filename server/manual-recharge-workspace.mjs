import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { managesBusiness } from './access-roles.mjs';
import { manualBrowserEmail, manualBrowserNotes, requireManualPlan } from './manual-browser-records.mjs';
import { ManualRenewalError } from './manual-renewal-records.mjs';

export const manualRechargePrefix = '/api/local/manual-recharge/';
const methods = {
  routes: ['GET'], windows: ['GET'], occupancy: ['GET'], probe: ['POST'], launch: ['POST'],
  release: ['POST'], 'release-legacy': ['POST'], window: ['PATCH', 'DELETE'],
};
const keys = {
  probe: ['email', 'plan', 'proxyId'], launch: ['email', 'plan', 'ticket', 'notes'],
  release: ['id', 'runId'], 'release-legacy': ['email'], window: ['id', 'revision', 'notes'],
};

function validRun(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
function canonicalIp(ip) {
  return isIP(ip) === 6 ? new URL('http://[' + ip + ']/').hostname : isIP(ip) === 4 ? ip : null;
}

export function createManualRechargeHandler({ routes, remote, store, publicOrigin, readJson }) {
  async function launch(request, actor, body) {
    const email = manualBrowserEmail(body.email);
    const plan = requireManualPlan(body.plan);
    const notes = body.notes === undefined ? undefined : manualBrowserNotes(body.notes);
    if (typeof body.ticket !== 'string' || !body.ticket || body.ticket.length > 256)
      throw new ManualRenewalError(400, '请先测速');
    if (!await remote.rechargeReady(request)) throw new ManualRenewalError(503, '浏览器工作区暂不可用');
    const selection = await routes.consume(actor, { email, plan, ticket: body.ticket });
    const expected = canonicalIp(selection.expectedIp);
    const binding = selection.routeBinding;
    if (!expected || !/^[A-Z]{2}$/.test(selection.expectedCountry) ||
        binding?.planType !== plan || binding.region !== selection.expectedCountry)
      throw new ManualRenewalError(409, '测速凭据缺少有效出口，请重新测速');
    // Persist only the configuration identity needed on reconnect.
    const { planType, region, configVersion, proxyId, proxyType, labelCountryCode, configHash } = binding;
    const routeBinding = { planType, region, configVersion, proxyId, proxyType, labelCountryCode, configHash };
    const runId = randomUUID();
    const id = store.stageManualBrowser({ runId, email, plan, notes, routeBinding }, actor);
    const opened = await remote.prepareRecharge(request, { email, runId, proxyUrl: selection.proxyUrl,
      expectedCountry: selection.expectedCountry, expectedIp: selection.expectedIp });
    if (opened.runId !== runId || opened.country !== selection.expectedCountry ||
        canonicalIp(opened.exitIp) !== expected) {
      await remote.releaseRecharge(request, { id, runId });
      throw new ManualRenewalError(409, '浏览器实测出口与测速结果不同，已关闭窗口，请重新测速');
    }
    return { viewerUrl: opened.viewerUrl, country: opened.country, exitIp: opened.exitIp, runId };
  }
  async function dispatch(request, actor, action, params) {
    if (action === 'windows') return store.listManualBrowserWindows(params, actor);
    if (action === 'routes') return routes.options(actor, params.get('plan') || '');
    if (action === 'occupancy') {
      const active = await remote.rechargeOccupancy(request);
      return { active: active && { ...active, email: store.manualBrowserOwnerEmail(active.id, active.runId, actor) || '' } };
    }
    const body = await readJson(request, 16_384);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !keys[action].includes(key)))
      throw new ManualRenewalError(400, '提交的工作区资料无效');
    if (action === 'probe') {
      if (typeof body.proxyId !== 'string' || !body.proxyId || body.proxyId.length > 64)
        throw new ManualRenewalError(400, '请选择执行线路');
      return routes.probe(actor, { email: manualBrowserEmail(body.email), plan: requireManualPlan(body.plan), proxyId: body.proxyId });
    }
    if (action === 'launch') return launch(request, actor, body);
    if (action === 'release-legacy') {
      await remote.releaseLegacyRecharge(request, { email: manualBrowserEmail(body.email) });
      return { ok: true };
    }
    if (typeof body.id !== 'string' || !/^recharge-[a-f0-9]{64}$/.test(body.id))
      throw new ManualRenewalError(400, '缺少有效的充值窗口');
    if (action === 'release') {
      if (!validRun(body.runId)) throw new ManualRenewalError(400, '请刷新当前运行的窗口');
      await remote.releaseRecharge(request, { id: body.id, runId: body.runId });
      return { ok: true };
    }
    if (!validRun(body.revision) || (request.method === 'DELETE' && Object.hasOwn(body, 'notes')))
      throw new ManualRenewalError(400, '请核对窗口记录及版本');
    return store.changeManualBrowserWindow(body, actor, request.method === 'DELETE');
  }
  return async function handle(request, response, actor, action) {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      if (!actor?.id || actor.active === false || !managesBusiness(actor))
        throw new ManualRenewalError(actor ? 403 : 401, '当前账号无权管理充值窗口');
      if (!Object.hasOwn(methods, action)) throw new ManualRenewalError(404, '找不到工作区操作');
      if (!methods[action].includes(request.method)) throw new ManualRenewalError(405, '不支持的工作区操作');
      const origin = publicOrigin || 'http://' + request.headers.host;
      if (((request.method !== 'GET' || request.headers.origin) && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
        throw new ManualRenewalError(403, '仅允许从当前站点操作');
      if (!store) throw new ManualRenewalError(503, '业务资料暂不可用');
      send(200, await dispatch(request, actor, action, new URL(request.url, origin).searchParams));
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      send(status, { error: status >= 500 && !(error instanceof ManualRenewalError)
        ? '充值工作区暂不可用，请刷新核对后重试' : error.message });
    }
  };
}
