import { randomUUID } from 'node:crypto';
import {
  buildCardIssueAllocations, expenseAccountingModes, orderExpenseTerms, validCurrencyCode
} from '../../modules/finance/accounting.mjs';
import { validMoney } from '../order-policy.mjs';

export const orderExpenseDomain = 'order-expense-receipts';
export const orderExpenseRoute = '/api/local/finance/expense-receipts';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, limit) => {
  if (typeof value !== 'string' || value.trim().length > limit || /[\p{Cc}\p{Cf}]/u.test(value)) return '';
  return value.trim();
};
const amountValid = value => validMoney(value) && /[1-9]/.test(value);
const beijingDate = time => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
const identity = value => value.normalize('NFKC').toLowerCase();
const send = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
};

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw invalid('登记内容过长', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw invalid('凭据登记格式无效');
}

function buildReceipt(input, snapshot, orders, actor, now) {
  const keys = ['category', 'chargedOn', 'source', 'reference', 'amount', 'currency',
    'settlementAmount', 'settlementCurrency', 'orderNo', 'accountingMode'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !keys.includes(key))) throw invalid('凭据资料无效');
  const { category, chargedOn, amount, currency, settlementAmount = '', settlementCurrency = '' } = input;
  const source = text(input.source, 60), reference = text(input.reference, 100);
  if (!Object.hasOwn(expenseAccountingModes, category) || !source || !reference)
    throw invalid('请选择费用项目，填写扣款来源及凭据编号');
  if (typeof chargedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(chargedOn) ||
      !Number.isFinite(Date.parse(chargedOn)) || new Date(chargedOn).toISOString().slice(0, 10) !== chargedOn ||
      chargedOn > beijingDate(now)) throw invalid('请选择有效且已发生的扣款日期');
  if (!amountValid(amount) || !validCurrencyCode(currency)) throw invalid('请填写有效的实付原币金额和币种');
  if ((settlementAmount !== '' || settlementCurrency !== '') &&
      (!amountValid(settlementAmount) || !validCurrencyCode(settlementCurrency) || settlementCurrency === currency))
    throw invalid('请填写账单上的结算金额和另一种币种，或将两项留空');
  const orderNo = text(input.orderNo ?? '', 80);
  const matches = orderNo ? orders.filter(order => order.orderNo === orderNo && !order.draft) : [];
  if (input.orderNo != null && input.orderNo !== '' && (!orderNo || matches.length !== 1))
    throw invalid('未找到唯一的原订单，请核对订单编号');
  if (snapshot.some(row => !row.voidedAt && identity(row.source) === identity(source) &&
      identity(row.reference) === identity(reference)))
    throw invalid('该来源的凭据编号已登记', 409);
  return { id: randomUUID(), category, chargedOn, source, reference, amount, currency,
    ...(settlementAmount && { settlementAmount, settlementCurrency }),
    ...(matches.length && { orderId: matches[0].id, orderNo }), recordedAt: new Date(now).toISOString(),
    recordedBy: actor.name || '管理员' };
}

function accountForReceipt(row, mode, items, orders, actor, now) {
  if (!expenseAccountingModes[row.category]?.includes(mode)) throw invalid('请选择适用于此凭据的核算方式');
  const checked = { ...row, accountingMode: mode, accountedAt: new Date(now).toISOString(),
    accountedBy: actor.name || '管理员' };
  delete checked.accountingCardId;
  if (mode === 'cash') return checked;
  const order = orders.find(item => item.id === row.orderId);
  let term;
  try {
    [term] = orderExpenseTerms(order, [checked, ...items.filter(item =>
      item.id !== row.id && item.orderId === row.orderId)]);
  } catch (error) {
    throw invalid(error.message);
  }
  if (mode === 'replace-card') {
    if (items.some(item => item.id !== row.id && !item.voidedAt &&
        item.accountingMode === mode && item.accountingCardId === term.cardId))
      throw invalid('原付款卡已有一笔计入核算的发卡凭据', 409);
    checked.accountingCardId = term.cardId;
    const allocation = buildCardIssueAllocations(orders, { clock: now, expenseReceipts: [checked] }).get(order.id);
    if (allocation?.status !== 'ready') throw invalid('缺少该卡成功开通或原付款卡记录', 409);
  }
  return checked;
}

export function createOrderExpenseHandler({ store, publicOrigin, clock = Date.now }) {
  return async (request, response, actor) => {
    if (!actor?.id) return send(response, 401, { error: '请先登录' });
    if (!['admin', 'super'].includes(actor.role) && !(actor.role === 'finance' && request.method === 'GET'))
      return send(response, 403, { error: '当前账号无权管理费用凭据' });
    const origin = publicOrigin || 'http://' + request.headers.host;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return send(response, 403, { error: '请求来源未通过校验' });
    try {
      if (request.method === 'GET') {
        const { version, data } = store.featureDocument(orderExpenseDomain);
        return send(response, 200, { version, items: data?.items || [] });
      }
      if (request.method !== 'POST') return send(response, 405, { error: '不支持此操作' });
      if (request.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
        return send(response, 403, { error: '请从当前页面提交费用凭据' });
      const command = await readBody(request);
      const { action, version } = command;
      const keys = action === 'record' ? ['action', 'version', 'entry']
        : action === 'void' ? ['action', 'version', 'id', 'reason']
          : action === 'account' ? ['action', 'version', 'id', 'mode'] : null;
      if (!keys || Object.keys(command).some(key => !keys.includes(key)) || !Number.isSafeInteger(version) || version < 0)
        throw invalid('凭据登记格式无效');
      const current = store.featureDocument(orderExpenseDomain);
      if (current.version !== version) throw invalid('费用凭据已更新，请刷新后重新核对', 409);
      const items = current.data?.items || [];
      const now = clock();
      let changed, next, commerceVersion;
      if (action === 'record') {
        const commerce = store.load('commerce');
        const orders = commerce.data?.orders || [];
        changed = buildReceipt(command.entry, items, orders, actor, now);
        if (changed.orderId) commerceVersion = commerce.version;
        const mode = command.entry.accountingMode;
        if (mode && mode !== 'cash') changed = accountForReceipt(changed, mode, items, orders, actor, now);
        next = [changed, ...items];
      } else {
        const row = items.find(item => item.id === command.id && !item.voidedAt);
        if (!row) throw invalid('该笔凭据已作废或不存在，请刷新后核对', 409);
        if (action === 'account') {
          const commerce = store.load('commerce');
          changed = accountForReceipt(row, command.mode, items, commerce.data?.orders || [], actor, now);
          if (changed.orderId) commerceVersion = commerce.version;
        } else {
          const reason = text(command.reason, 150);
          if (!reason) throw invalid('请填写作废原因');
          changed = { ...row, voidedAt: new Date(now).toISOString(), voidedBy: actor.name || '管理员', voidReason: reason };
        }
        next = items.map(item => item.id === row.id ? changed : item);
      }
      const saved = store.saveFeatureDocument(orderExpenseDomain, version, { items: next }, {
        action: 'order_expense_' + action, actor, targetId: changed.id, commerceVersion
      });
      return send(response, 200, { version: saved.version, items: saved.data.items });
    } catch (error) {
      const status = [400, 409, 413].includes(error.status) ? error.status : 503;
      return send(response, status, { error: status === 503 ? '费用凭据暂时无法读取或保存，请重新核对' : error.message });
    }
  };
}
