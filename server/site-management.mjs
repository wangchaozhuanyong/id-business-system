import { createHash } from 'node:crypto';
import { subscriptionTime, automaticGptOrder } from '../modules/orders/order-opening.mjs';
import { describeWriteOperation } from './write-operation.mjs';
import { isDiagnostic, softwareVersion } from './site-observations.mjs';

export const siteManagementPath = '/api/local/site-management';
export const siteObservationScope = 'site-observations';
const minute = 60_000;
const collections = ['customers', 'orders'];
const products = new Set(['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']);
const statuses = { customers: ['active', 'inactive'], orders: ['recorded', 'cancelled'] };
const issueKinds = new Set(['duplicate', 'deleted-source', 'customer', 'tenant', 'inventory']);
const array = value => Array.isArray(value) ? value : [];
const recordId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(value) && !/\d{12,}/.test(value) ? value : '';
const orderNumber = value => typeof value === 'string' && /^(?:OD|GPT|Claude|CL|Gemini|Grok|ORD|ID)[ -]?[A-Za-z0-9-]{1,64}$/i.test(value) &&
  !/\d{12,}/.test(value) ? value : '';
const timestamp = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now ? value : null;
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const dateText = at => new Date(at + 8 * 60 * minute).toISOString().slice(0, 10);
const active = row => row?.deleted !== true;
const draft = row => row?.draft || ['draft', '草稿'].includes(row?.status);
const allowedError = (status, message) => Object.assign(new Error(message), { status });

export function siteReleaseInfo(value) {
  const version = softwareVersion(value?.version);
  return { version, updatedAt: version ? timestamp(value.updatedAt, Date.now()) : null };
}

export function siteDataIssues(commerce, inventory, synchronization, { kind = '', page = 1, pageSize = 20 } = {}) {
  const customers = new Set(array(commerce?.customers).filter(active).map(row => row.id));
  const tenants = new Set(array(commerce?.tenants).filter(active).map(row => row.id));
  const accounts = new Set(array(inventory?.accounts).filter(active).map(row => row.id));
  const orders = array(commerce?.orders).filter(row => active(row) && !draft(row));
  const sources = new Map();
  const issues = [];
  const allOrders = new Set(orders.filter(row => row.orderNo).map(row => row.orderNo));
  function add(type, row, at) {
    if (kind && kind !== type) return;
    issues.push({
      type, at: Number.isFinite(at) ? at : null,
      orderId: recordId(row?.id), orderNo: orderNumber(row?.orderNo),
      product: products.has(row?.product) ? row.product : ''
    });
  }
  for (const row of orders) {
    const at = subscriptionTime(row.createdAt);
    if (automaticGptOrder(row)) {
      const group = sources.get(row.taskId);
      if (group) group.push(row); else sources.set(row.taskId, [row]);
    }
    if (row.cancelled) continue;
    if (row.customerId && !customers.has(row.customerId)) add('customer', row, at);
    if (row.tenantId && !tenants.has(row.tenantId)) add('tenant', row, at);
    if (inventory && row.accountId && (row.accountSource === '库存' || row.businessType === '成品交付') &&
        !accounts.has(row.accountId)) add('inventory', row, at);
  }
  for (const group of sources.values()) if (group.length > 1)
    for (const row of group) add('duplicate', row, subscriptionTime(row.createdAt));
  for (const row of array(synchronization?.rows))
    if (!row.excluded && row.jobKey && row.orderNo && !sources.has(row.jobKey) && !allOrders.has(row.orderNo))
      add('deleted-source', { orderNo: row.orderNo, product: 'GPT' }, row.checkedAt);
  issues.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) ||
    a.type.localeCompare(b.type) || a.orderId.localeCompare(b.orderId) || a.orderNo.localeCompare(b.orderNo));
  page = Math.min(page, Math.max(1, Math.ceil(issues.length / pageSize)));
  return { total: issues.length, page, pageSize, items: issues.slice((page - 1) * pageSize, page * pageSize),
    coverage: { inventory: Boolean(inventory), synchronization: Boolean(synchronization) } };
}

export function siteBackupView(report, recoveries, now = Date.now()) {
  const sampledAt = timestamp(report?.at, now);
  const recent = sampledAt && now - sampledAt <= 3 * minute;
  const drive = report?.drive, mysql = report?.mysql;
  const point = (capture, verified) => ({
    capturedAt: timestamp(capture, now), verifiedAt: timestamp(verified, now)
  });
  function exercise(key) {
    const item = recoveries?.[key];
    if (item?.version !== 1 || item.database !== key || item.result !== 'passed' || item.isolated !== true ||
        !timestamp(item.finishedAt, now) || !timestamp(item.capturedAt, item.finishedAt) ||
        !Number.isSafeInteger(item.durationMs) || item.durationMs < 1 ||
        item.durationMs > item.finishedAt - item.capturedAt ||
        !Number.isSafeInteger(item.checkedRecords) || item.checkedRecords < 1) return null;
    return { finishedAt: item.finishedAt, capturedAt: item.capturedAt, durationMs: item.durationMs };
  }
  let sqliteStatus = 'unknown', rechargeStatus = 'unknown';
  if (recent && drive && timestamp(drive.at, now)) {
    if (drive.integrityFailure) sqliteStatus = 'check-failed';
    else if (drive.failures >= 3) sqliteStatus = 'failed';
    else if (now - drive.at > 20 * minute) sqliteStatus = 'stale';
    else if (drive.failures > 0) sqliteStatus = 'retrying';
    else if (timestamp(drive.verifiedAt, now)) sqliteStatus = 'verified';
  }
  if (recent) {
    if (!report.mysqlTimerActive) rechargeStatus = 'paused';
    else if (report.mysqlAttemptFailed) rechargeStatus = 'failed';
    else if (timestamp(mysql?.capturedAt, now) && timestamp(mysql?.verifiedAt, now))
      rechargeStatus = now - mysql.capturedAt > 35 * minute ? 'stale' : 'verified';
  }
  return { sampledAt, collector: recent ? 'connected' : sampledAt ? 'stale' : 'unknown',
    databases: [
      { key: 'business', state: sqliteStatus, ...point(drive?.capturedAt, drive?.verifiedAt), exercise: exercise('business') },
      { key: 'recharge', state: rechargeStatus, ...point(mysql?.capturedAt, mysql?.verifiedAt), exercise: exercise('recharge') }
    ] };
}

const csv = values => values.map(value => {
  const input = String(value ?? '');
  return '"' + (/^[\s\uFEFF]*[=+\-@]/.test(input) ? "'" : '') + input.replaceAll('"', '""') + '"';
}).join(',');
const exportLabels = { customers: '客户', orders: '订单' };
const statusLabels = { active: '使用中', inactive: '已停用', recorded: '已登记', cancelled: '已撤销' };
function nameMask(value) {
  if (typeof value !== 'string') return '';
  const characters = [...value.trim()];
  return characters.length >= 2 && /^\p{L}$/u.test(characters[0]) ? characters[0] + '＊＊' : '＊＊';
}

export function siteExport(commerce, filter) {
  const customer = filter.collection === 'customers';
  const full = filter.detail === 'business';
  const selectStatus = row => customer ? (row.active === false ? 'inactive' : 'active') : row.cancelled ? 'cancelled' : 'recorded';
  const rows = array(commerce?.[filter.collection]).filter(row => {
    if (!active(row) || (!customer && draft(row)) || (filter.status && selectStatus(row) !== filter.status) ||
        (filter.product && row.product !== filter.product)) return false;
    const at = subscriptionTime(row.createdAt);
    if (!filter.start && !filter.end) return true;
    if (!Number.isFinite(at)) return false;
    const date = dateText(at);
    return (!filter.start || date >= filter.start) && (!filter.end || date <= filter.end);
  }).sort((a, b) => (subscriptionTime(b.createdAt) || 0) - (subscriptionTime(a.createdAt) || 0) ||
    String(a.id).localeCompare(String(b.id)));
  const output = [customer
    ? full ? ['客户编号', '姓名', '微信', '电话', '状态', '录入日期'] : ['客户编号', '姓名（已遮盖）', '状态', '录入日期']
    : full ? ['订单编号', '产品', '业务类型', '状态', '录入日期', '套餐', '订单邮箱', '实收', '实收币种', '代付', '代付币种']
      : ['订单编号', '产品', '业务类型', '状态', '录入日期']];
  for (const row of rows) {
    const at = subscriptionTime(row.createdAt), date = Number.isFinite(at) ? dateText(at) : '';
    const status = statusLabels[selectStatus(row)];
    output.push(customer ? (full ? [recordId(row.id), row.name, row.wechat, row.phone, status, date]
      : [recordId(row.id), nameMask(row.name), status, date]) :
      [orderNumber(row.orderNo) || recordId(row.id), products.has(row.product) ? row.product : '',
        ['首次开通', '成品交付', '续费'].includes(row.businessType) ? row.businessType : '', status, date,
        ...(full ? [row.plan, row.email, row.saleAmount, row.saleCurrency, row.paidAmount, row.paidCurrency] : [])]);
  }
  const range = filter.start || filter.end ? (filter.start || '不限') + ' 至 ' + (filter.end || '不限') : '全部日期';
  const label = [(full ? '导出业务' : '导出脱敏') + exportLabels[filter.collection], range, filter.product || '', statusLabels[filter.status] || '',
    rows.length + ' 条'].filter(Boolean).join(' · ');
  return { content: '\uFEFF' + output.map(csv).join('\r\n') + '\r\n', count: rows.length, label };
}

function filters(body) {
  if (!body || Array.isArray(body) ||
      Object.keys(body).some(key => !['collection', 'start', 'end', 'status', 'product', 'detail'].includes(key)) ||
      !collections.includes(body.collection)) throw allowedError(400, '请选择要导出的资料');
  const { collection, start = '', end = '', status = '', product = '', detail = 'masked' } = body;
  if ([start, end, status, product].some(value => typeof value !== 'string') ||
      (start && !day(start)) || (end && !day(end)) || (start && end && start > end) ||
      (status && !statuses[collection].includes(status)) || (product && (collection !== 'orders' || !products.has(product))) ||
      !['masked', 'business'].includes(detail))
    throw allowedError(400, '请核对导出日期、产品和状态');
  return { collection, start, end, status, product, ...(detail === 'business' && { detail }) };
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 1024) {
      request.resume();
      throw allowedError(413, '请求内容过长');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { throw allowedError(400, '请求内容无法读取'); }
}
function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
}

export function createSiteManagement({ store, observations, origin, release, readBackups, readRecoveries, readSources,
  authorizeBusinessExport, official = false, clock = Date.now }) {
  return async (request, response, actor) => {
    const expectedOrigin = origin || 'http://' + request.headers.host;
    const url = new URL(request.url, expectedOrigin);
    if ((request.headers.origin && request.headers.origin !== expectedOrigin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return send(response, 403, { error: '请从当前网站操作' });
    try {
      const timing = url.pathname === siteManagementPath + '/timing';
      if (!timing && !actor?.id) return send(response, 401, { error: '请先登录' });
      if (!timing && !['admin', 'super'].includes(actor.role)) return send(response, 403, { error: '当前账号无权查看此资料' });
      if (request.method === 'POST') {
        if (request.headers.origin !== expectedOrigin || url.search ||
            !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
          return send(response, 403, { error: '请从当前网站操作' });
        if (!timing && url.pathname !== siteManagementPath + '/export') return send(response, 405, { error: '此页面只供查看' });
        const body = await readJson(request);
        if (timing) {
          if (!observations.sample(body, actor?.id)) return send(response, 400, { error: '未能记录本次测量' });
          return response.writeHead(204, { 'Cache-Control': 'private, no-store' }).end();
        }
        const filter = filters(body);
        if (filter.detail === 'business' && !authorizeBusinessExport?.(request, actor))
          return send(response, 403, { error: '下载含联系方式或金额的资料前，请完成安全确认' });
        const { content, count, label } = siteExport(store.load('commerce').data, filter);
        const digest = createHash('sha256').update(content).digest('hex');
        const operation = describeWriteOperation(request.headers['x-id-operation'], actor, { filter, digest });
        if (!operation) throw allowedError(400, '请重新点击导出');
        store.recordSiteExport(actor, operation, label);
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store',
          'Content-Disposition': 'attachment; filename="' + filter.collection + '-' + dateText(clock()) + '.csv"',
          'X-ID-Export-Count': String(count) });
        return response.end(content);
      }
      if (request.method !== 'GET' || url.pathname !== siteManagementPath)
        return send(response, 405, { error: '此页面只供查看' });
      const params = url.searchParams, view = params.get('view') || '';
      const allowed = { health: ['kind', 'page', 'pageSize'], performance: ['hours'], diagnostic: ['id'],
        resources: [], backups: [], information: [] };
      if (!Object.hasOwn(allowed, view) || [...params.keys()].some(key =>
        (key !== 'view' && !allowed[view].includes(key)) || params.getAll(key).length !== 1))
        throw allowedError(400, '请核对查询条件');
      const now = clock();
      switch (view) {
        case 'performance': {
          const hours = params.get('hours') || '24';
          if (!['24', '168'].includes(hours)) throw allowedError(400, '请选择查看时段');
          return send(response, 200, observations.performanceView(Number(hours)));
        }
        case 'diagnostic': {
          const id = params.get('id')?.trim().toLowerCase();
          if (!isDiagnostic(id)) throw allowedError(400, '请输入完整的诊断编号');
          return send(response, 200, { item: observations.diagnostic(id) });
        }
        case 'health': {
          const kind = params.get('kind') || '', page = params.get('page') || '1', pageSize = params.get('pageSize') || '20';
          if ((kind && !issueKinds.has(kind)) || !/^[1-9]\d{0,5}$/.test(page) || !['10', '20', '50'].includes(pageSize))
            throw allowedError(400, '请核对资料筛选条件');
          return send(response, 200, { at: now, ...siteDataIssues(store.load('commerce').data, store.load('inventory').data,
            store.featureDocument('order-sync').data, { kind, page: Number(page), pageSize: Number(pageSize) }),
            sources: readSources()?.sources || [] });
        }
        case 'resources':
          return send(response, 200, { ...observations.resourceView(), ...readSources() });
        case 'backups': {
          const [backups, recoveries] = await Promise.all([readBackups(), readRecoveries()]);
          return send(response, 200, siteBackupView(backups, recoveries, now));
        }
        case 'information':
          return send(response, 200, { official, domain: official ? new URL(expectedOrigin).host : null,
            timeZone: '北京时间（UTC+8）', ...release });
      }
    } catch (error) {
      if (response.headersSent) return response.end();
      const status = [400, 409, 413].includes(error?.status) ? error.status : 503;
      return send(response, status, { error: status === 503 ? '暂时无法读取，请稍后重试' : error.message });
    }
  };
}
