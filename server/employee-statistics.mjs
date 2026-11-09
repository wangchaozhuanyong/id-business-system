import { currentV2BusinessDate, parseV2DateTimeInput } from '../modules/time/dateTime.ts';
import { rechargePlanLabels } from './order-policy.mjs';
import { rechargeCodeItemId } from './recharge-code-returns.mjs';

export const employeeStatisticsRoute = '/api/local/employee-statistics';

const dayMs = 86_400_000;
const categories = new Set(['all', 'order', 'customer', 'code', 'mail', 'account']);
const metricCategories = {
  orders: 'order', cancelledOrders: 'order', syncedOrders: 'order', customers: 'customer',
  extractedAccounts: 'account', submittedAccounts: 'account', openAccounts: 'account',
  extractedMail: 'mail', submittedMail: 'mail', openMail: 'mail',
  issuedCodes: 'code', pendingCodeRequests: 'code', unusedCodes: 'code', deliveredCodes: 'code',
  processingCodes: 'code', returningCodes: 'code',
  used: null, returned: null, undated: null, overdue: null, review: null
};
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const zonedTime = /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/i;
const identifier = /^[\w.-]{1,128}$/;
const stockPurposes = new Set(['注册 GPT', '注册 Claude', '注册苹果 ID', '客户交付', '比特充值', '业务备用', '其他']);
const list = value => Array.isArray(value) ? value : [];
const id = value => typeof value === 'string' && identifier.test(value) ? value : '';

function instant(value) {
  if (typeof value !== 'string') return NaN;
  const time = value.trim().replace(' ', 'T');
  return zonedTime.test(time) ? Date.parse(time) : parseV2DateTimeInput(time)?.getTime() ?? NaN;
}

function maskedEmail(value) {
  const match = typeof value === 'string' && /^([^\s@])[^\s@]*@([^\s@]{1,253})$/.exec(value);
  return match ? match[1] + '***@' + match[2] : '';
}

function uniqueRows(value) {
  return new Map(list(value).filter(row => id(row?.id)).map(row => [row.id, row]));
}

function indexCodeStatus(nativeCodes) {
  const statuses = new Map();
  for (const row of list(nativeCodes)) {
    if (typeof row?.code !== 'string') continue;
    statuses.set(row.code, statuses.has(row.code) ? null : row);
  }
  return statuses;
}

function parseQuery(search, today) {
  const fields = new Set(['date', 'kind', 'metric', 'employee', 'page', 'pageSize']);
  if ([...search.keys()].some(key => !fields.has(key) || search.getAll(key).length !== 1)) return null;
  const date = search.get('date') ?? today;
  const kind = search.get('kind') ?? 'all';
  const metric = search.get('metric');
  const employee = search.get('employee');
  const page = Number(search.get('page') ?? 1);
  const pageSize = Number(search.get('pageSize') ?? 10);
  if (!datePattern.test(date) || !parseV2DateTimeInput(date + 'T00:00') || date > today || !categories.has(kind) ||
      (metric ? !Object.hasOwn(metricCategories, metric) || !id(employee) : ['metric', 'employee', 'page', 'pageSize'].some(key => search.has(key))) ||
      !Number.isSafeInteger(page) || page < 1 || ![10, 20, 50].includes(pageSize)) return null;
  const detailKind = kind === 'all' ? metricCategories[metric] || kind : kind;
  return { date, kind: detailKind, metric, employee, page, pageSize };
}

export function buildEmployeeStatistics({ employees, commerce, inventory, requests, nativeCodes }, query, now) {
  const today = currentV2BusinessDate(now);
  const start = parseV2DateTimeInput(query.date + 'T00:00').getTime();
  const end = Math.min(start + dayMs - 1, now);
  const people = new Map();
  const details = [];
  const statusByCode = indexCodeStatus(nativeCodes);
  const orders = uniqueRows(commerce?.orders);
  const ordersByTask = new Map();
  const mailboxes = uniqueRows(inventory?.mailboxes);
  const accounts = uniqueRows(inventory?.accounts);

  function person(employeeId, name) {
    const key = id(employeeId) || 'unattributed';
    if (!people.has(key)) people.set(key, {
      id: key, name: key === 'unattributed' ? '归属未记录' : name || '历史员工', active: null,
      counts: {}, unverifiedCodes: 0, useTimeUnverified: 0
    });
    const employee = people.get(key);
    if (name && employee.name === '历史员工') employee.name = name;
    return employee;
  }
  for (const employee of list(employees)) {
    if (id(employee?.id)) person(employee.id, employee.name).active = true;
  }

  const includes = kind => query.kind === 'all' || query.kind === kind;
  function add(metric, employee, entry, time = NaN) {
    if (!includes(entry.kind)) return;
    employee.counts[metric] = (employee.counts[metric] ?? 0) + 1;
    if (query.metric === metric && query.employee === employee.id)
      details.push({ ...entry, at: Number.isFinite(time) ? new Date(time).toISOString() : null });
  }
  function dated(metric, employee, entry, time) {
    if (!Number.isFinite(time) || time > now) add('undated', employee, { ...entry, status: '发生时间待核对' });
    else if (time >= start && time <= end) add(metric, employee, entry, time);
  }
  function orderReference(orderId) {
    return id(orders.get(orderId)?.orderNo) || id(orderId);
  }

  for (const order of orders.values()) {
    const synced = order.source === '线上代充' && id(order.taskId);
    if (synced) ordersByTask.set(order.taskId, ordersByTask.has(order.taskId) ? null : order);
    if (!includes('order') || order.draft || ['draft', '草稿'].includes(order.status)) continue;
    const who = synced && !order.createdById ? person('system', '系统自动')
      : person(order.createdById, synced ? undefined : order.createdBy);
    const entry = { id: order.id, kind: 'order', reference: orderReference(order.id),
      subject: maskedEmail(order.email), status: order.cancelled ? '已撤单' : synced ? '系统同步' : '已提交' };
    const time = instant(order.createdAt);
    dated(synced ? 'syncedOrders' : 'orders', who, entry, time);
    if (!synced && order.cancelled && time >= start && time <= end) add('cancelledOrders', who, entry, time);
  }

  function creations(rows, metric, kind, status) {
    if (!includes(kind)) return;
    for (const row of rows.values()) {
      dated(metric, person(row.createdById, row.createdBy), {
        id: row.id, kind, reference: row.id, subject: maskedEmail(row.email), status
      }, instant(row.createdAt || row.importedAt));
    }
  }
  creations(uniqueRows(commerce?.customers), 'customers', 'customer', '已录入');
  creations(mailboxes, 'submittedMail', 'mail', '已入库');
  creations(accounts, 'submittedAccounts', 'account', '已入库');

  const seenClaims = new Set();
  for (const batch of uniqueRows(inventory?.batches).values()) {
    if (!['mail', 'account'].includes(batch.kind) || !includes(batch.kind)) continue;
    const who = person(batch.actorId, batch.actorName);
    const isMail = batch.kind === 'mail';
    const assets = isMail ? mailboxes : accounts;
    for (const claim of uniqueRows(batch.items).values()) {
      if (seenClaims.has(claim.id)) continue;
      seenClaims.add(claim.id);
      const claimAt = instant(claim.claimedAt || batch.time);
      const open = claim.status === 'pending';
      const asset = assets.get(claim.assetId);
      const mismatched = open && (!asset || asset.claimId !== claim.id || asset.claimBatchId !== batch.id);
      const reserved = Boolean(claim.orderId || claim.taskId || claim.registrationId);
      const status = ({
        used: '已使用', returned: '已归还', abnormal: '已登记异常归还',
        pending: mismatched ? '库存关联待核对' : reserved ? '业务处理中' : '待使用'
      })[claim.status] ?? '领用状态待核对';
      const entry = {
        id: claim.id, kind: batch.kind, reference: id(claim.assetId) || claim.id, batch: batch.id,
        subject: maskedEmail(claim.email || asset?.email), related: orderReference(claim.orderId) || id(claim.taskId) || id(claim.registrationId),
        purpose: stockPurposes.has(batch.purpose) ? batch.purpose : batch.purpose ? '自定义用途' : '',
        status
      };
      dated(isMail ? 'extractedMail' : 'extractedAccounts', who, entry, claimAt);
      if (claim.status === 'used') dated('used', who, entry, instant(claim.usedAt));
      else if (['returned', 'abnormal'].includes(claim.status)) dated('returned', who, entry, instant(claim.returnedAt));
      else {
        add(isMail ? 'openMail' : 'openAccounts', who, entry, claimAt);
        if (mismatched || !open || !Number.isFinite(claimAt) || claimAt > now) add('review', who, entry, claimAt);
        else if (!reserved && now - claimAt >= dayMs) add('overdue', who, entry, claimAt);
      }
    }
  }

  if (includes('code')) {
    for (const request of uniqueRows(requests).values()) {
      const who = person(request.applicantId, request.applicantName);
      if (['pending', 'issuing'].includes(request.status)) {
        add('pendingCodeRequests', who, { id: request.id, kind: 'code', reference: request.id,
          status: request.status === 'issuing' ? '发放待确认' : '待审核'
        }, instant(request.createdAt));
        continue;
      }
      if (request.status !== 'issued') continue;
      const issuedAt = instant(request.issuedAt);
      const returns = new Map(list(request.returns).map(row => [row?.itemId, row]));
      for (const code of new Set(list(request.codes))) {
        if (typeof code !== 'string' || !code) continue;
        const itemId = rechargeCodeItemId(request.id, code);
        const record = returns.get(itemId);
        const native = statusByCode.get(code);
        const order = ordersByTask.get(native?.session_job_key);
        const entry = {
          id: itemId, kind: 'code', reference: itemId, batch: request.id,
          subject: /^KC-[A-F0-9]{28}$/i.test(code) ? '尾号 ' + code.slice(-4) : '',
          purpose: Object.hasOwn(rechargePlanLabels, request.plan) ? rechargePlanLabels[request.plan] : '',
          related: orderReference(order?.id), status: '已发放'
        };
        dated('issuedCodes', who, entry, issuedAt);
        const returnedAt = instant(record?.returnedAt);
        if (record?.state === 'returned' && Number.isFinite(returnedAt) && returnedAt <= now) {
          dated('returned', who, { ...entry, status: '已归还作废' }, returnedAt);
          if (statusByCode.has(code)) add('review', who, { ...entry, status: '归还回执与码池状态冲突' }, issuedAt);
        } else if (record?.state === 'pending') {
          add('returningCodes', who, { ...entry, status: '归还结果待核对' }, instant(record.startedAt));
        } else if (record?.state === 'returned' || native?.type !== '自助' || native.plan_type !== request.plan ||
            !['unused', 'processing', 'used'].includes(native.status)) {
          who.unverifiedCodes++;
          add('review', who, { ...entry, status: '充值码状态待核对' }, issuedAt);
        } else if (native.status === 'used') {
          // The provider may return a wall clock with no offset. Use a bound task's confirmation
          // time when available and leave the day unresolved when there is no reliable clock.
          const usedAt = zonedTime.test(native.used_at || '') ? instant(native.used_at) : instant(order?.rechargeCompletedAt);
          const validTime = Number.isFinite(usedAt) && usedAt >= issuedAt && usedAt <= now;
          if (!validTime) who.useTimeUnverified++;
          dated('used', who, { ...entry, status: '平台已使用' }, validTime ? usedAt : NaN);
        } else if (native.status === 'processing') {
          add('processingCodes', who, { ...entry, status: '使用中' }, issuedAt);
        } else if (native.shipped === true) {
          add('deliveredCodes', who, { ...entry, status: '已交付待兑换' }, issuedAt);
        } else if (native.shipped === false) {
          const item = { ...entry, status: '未用未还' };
          add('unusedCodes', who, item, issuedAt);
          if (now - issuedAt >= dayMs) add('overdue', who, item, issuedAt);
        } else {
          who.unverifiedCodes++;
          add('review', who, { ...entry, status: '交付状态待核对' }, issuedAt);
        }
      }
    }
  }

  const meta = {
    date: query.date, today, asOf: new Date(now).toISOString(),
    codeSourceAvailable: nativeCodes !== null
  };
  if (query.metric) {
    details.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id));
    const page = Math.min(query.page, Math.max(1, Math.ceil(details.length / query.pageSize)));
    return { ...meta, total: details.length, page, pageSize: query.pageSize,
      items: details.slice((page - 1) * query.pageSize, page * query.pageSize) };
  }
  return { ...meta, items: [...people.values()]
    .filter(row => row.active || Object.keys(row.counts).length)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)) };
}

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store'
  });
  response.end(JSON.stringify(body));
}

export function createEmployeeStatisticsHandler({ store, client, readEmployees, publicOrigin, clock = Date.now }) {
  return async (request, response, actor) => {
    if (!actor?.id) return reply(response, 401, { error: '请先登录后查看员工数据统计' });
    if (actor.active === false || !['admin', 'super'].includes(actor.role))
      return reply(response, 403, { error: '只有管理员可以查看员工数据统计' });
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return reply(response, 405, { error: '员工数据统计仅支持读取' });
    }
    const origin = publicOrigin || 'http://' + request.headers.host;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))
      return reply(response, 403, { error: '仅允许从当前页面查看员工数据统计' });
    try {
      const query = parseQuery(new URL(request.url, origin).searchParams, currentV2BusinessDate(clock()));
      if (!query) return reply(response, 400, { error: '统计日期或筛选条件无效' });
      const employees = readEmployees();
      const { data: commerce } = store.load('commerce');
      const { data: inventory } = store.load('inventory');
      const { data: codeData } = store.featureDocument('recharge-codes');
      const requests = list(codeData?.requests);
      let nativeCodes = [];
      if (['all', 'code'].includes(query.kind) && requests.some(row => row?.status === 'issued')) {
        try { nativeCodes = await client.listCodes(); }
        catch { nativeCodes = null; }
      }
      if (!response.destroyed)
        reply(response, 200, buildEmployeeStatistics({ employees, commerce, inventory, requests, nativeCodes }, query, clock()));
    } catch {
      if (!response.destroyed && !response.headersSent)
        reply(response, 503, { error: '暂时无法读取员工统计，请稍后重试' });
    }
  };
}
