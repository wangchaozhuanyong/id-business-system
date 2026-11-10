import { currencies } from '../modules/finance/accounting.mjs';
import { lookupRechargeCodeOwner } from './recharge-code-requests.mjs';
import { rechargePlanLabels, validMoney } from './order-policy.mjs';

export const orderSyncRoute = '/api/local/order-sync';
const domain = 'order-sync';
const maxSessionPages = 3;
const maxBillPages = 3;
const maxChecks = 6;
const retryAfter = 15 * 60_000;
const fallbackRules = Object.freeze({
  currency: 'CNY', version: 1, cardIssueUsd: '0.5', cardPercent: '0.008', cardPerPaymentUsd: '0.3'
});
const beijing = (time) => new Date(time + 28800000).toISOString().slice(0, 16);
const canonical = (value) => {
  const compact = typeof value === 'string' ? value.toLowerCase().replace(/[ _-]/g, '') : '';
  return ({ chatgptplusplan: 'plus', chatgptplus: 'plus', chatgptpro100: 'pro100',
    chatgptpro200: 'pro200', chatgptpro500: 'pro500' })[compact] || compact;
};
const emailValid = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const utcInstant = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const jobPattern = /^[A-Za-z0-9_-]{1,120}$/;
const expiryFor = (start) => {
  const [year, month, day] = start.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10) + start.slice(10);
};

function providerReceipt(task) {
  if (!task.gptApiOrderId || !task.gptApiRaw) return null;
  let raw;
  try { raw = JSON.parse(task.gptApiRaw); } catch { return null; }
  const open = raw?.status === 'succeeded' && String(raw.orderId) === String(task.gptApiOrderId);
  const legacy = raw?.status === 'success' && String(raw.id) === String(task.gptApiOrderId);
  if (!open && !legacy) return null;
  const paidAmount = String((open ? raw.payment?.amount : raw.amount) ?? '');
  const paidCurrency = String((open ? raw.payment?.currency : raw.currency) ?? '').toUpperCase();
  return {
    email: open ? raw.targetEmail : raw.recharge_account,
    plan: canonical(open ? raw.planCode : raw.plan),
    completedAt: utcInstant(open ? raw.completedAt : raw.settled_at),
    tail: raw.card_last4,
    ...(validMoney(paidAmount) && /[1-9]/.test(paidAmount) && currencies.includes(paidCurrency) &&
      { paidAmount, paidCurrency })
  };
}

export function rechargeOrderEvidence(task, {
  bills = [], codes = [], cards = [], orbitCards = [], ownerData, runtimeEntries = [], now = Date.now()
} = {}) {
  if (task?.status !== 'success' || !jobPattern.test(task.jobKey || '')) return null;
  const created = utcInstant(task.createdAt);
  const provider = providerReceipt(task);
  const code = typeof task.cdk === 'string' && task.cdk ? task.cdk : '';
  const codePlan = codes.find((row) => row.code === code)?.plan_type;
  const matched = code && Number.isFinite(created) ? bills.filter((row) =>
    row.status === 'success' && row.cdk_code === code && row.stripe_session_id &&
    (!task.cardLast4 || row.card_last4 === task.cardLast4) &&
    utcInstant(row.payment_time) >= created && utcInstant(row.payment_time) <= now &&
    utcInstant(row.payment_time) - created <= 24 * 3600000) : [];
  const bill = matched.length === 1 ? matched[0] : null;
  const orbitLinks = orbitCards.flatMap((card) => (Array.isArray(card.recharges) ? card.recharges : []).filter((row) =>
    row.jobKey === task.jobKey && row.orderId != null && String(row.orderId) === String(task.gptApiOrderId) &&
    ['success', 'succeeded'].includes(row.status)).map((row) => ({ cardId: card.cardId, ...row })));
  const orbit = orbitLinks.length === 1 && Number.isSafeInteger(orbitLinks[0].cardId) && orbitLinks[0].cardId > 0 ? orbitLinks[0] : null;
  const evidencePlan = canonical(provider?.plan || bill?.plan_type || orbit?.planType);
  const codeCanonical = canonical(codePlan);
  const conflict = (evidencePlan && codeCanonical && evidencePlan !== codeCanonical) ||
    (orbit?.planType && evidencePlan && canonical(orbit.planType) !== evidencePlan);
  const plan = conflict ? '' : Object.hasOwn(rechargePlanLabels, evidencePlan || codeCanonical)
    ? rechargePlanLabels[evidencePlan || codeCanonical] : '';
  const email = provider?.email || bill?.email || orbit?.accountEmail;
  const tails = [...new Set([task.cardLast4, provider?.tail, bill?.card_last4, orbit?.cardLast4].filter(Boolean))];
  const tail = tails.length === 1 && /^\d{4}$/.test(tails[0]) ? tails[0] : '';
  const rawPan = typeof bill?.card_number === 'string' ? bill.card_number : '';
  const matchingCards = /^\d{12,19}$/.test(rawPan)
    ? cards.filter((card) => card.card_number === rawPan && Number.isSafeInteger(Number(card.id)) && card.last4 === tail) : [];
  const card = matchingCards.length === 1 ? matchingCards[0] : null;
  const cardId = tail && orbit && orbit.cardLast4 === tail ? 'orbitcard:' + orbit.cardId
    : card && !orbit ? 'recharge:' + card.id : '';
  const terminal = runtimeEntries.find((entry) => entry.jobKey === task.jobKey && entry.source === 'task' &&
    /^任务结束 status=success progress=100(?: |$)/.test(entry.text) && Number.isSafeInteger(entry.ts));
  const completed = Number.isFinite(provider?.completedAt) ? provider.completedAt : terminal?.ts;
  const start = Number.isFinite(completed) && completed >= created && completed <= now ? beijing(completed) : '';
  const owner = lookupRechargeCodeOwner(ownerData, code);
  const firstUse = cardId && orbit && Number.isSafeInteger(orbit.useNumber) && orbit.useNumber >= 1
    ? orbit.useNumber === 1
    : cardId && card && Number(card.usage_count) === 1 && bill &&
      Math.abs(utcInstant(card.last_used_at) - utcInstant(bill.payment_time)) < 60000 ? true : undefined;
  const needs = [
    !emailValid(email) && '邮箱证据待核对',
    !plan && '套餐证据待核对',
    !start && '开通时间待核对',
    !provider?.paidAmount && '实扣金额待核对',
    !tail && '卡尾待核对',
    !cardId && '银行卡归属待核对',
    typeof firstUse !== 'boolean' && '首次开卡费待核对'
  ].filter(Boolean);
  return {
    jobKey: task.jobKey, email: emailValid(email) ? email.trim() : '', plan, start,
    completedAt: start ? new Date(completed).toISOString() : '',
    expiry: start ? expiryFor(start) : '',
    paidAmount: provider?.paidAmount || '', paidCurrency: provider?.paidCurrency || '',
    paymentId: tail, cardId, employeeId: owner?.employeeId || '',
    firstUse, needs
  };
}

export function buildRechargeOrder(evidence, settings, at) {
  const { jobKey, email, plan, start, expiry, completedAt, paidAmount, paidCurrency, paymentId, cardId, employeeId } = evidence;
  if (!email || !plan) return null;
  return {
    product: 'GPT', businessType: '续费', accountSource: '客户自有', accountId: '',
    taskId: jobKey, source: '线上代充', email, plan, payment: '银行卡', paymentId, cardId,
    paidAmount, paidCurrency, paidConfirmed: Boolean(paidAmount && paidCurrency),
    receiptConfirmed: false, costConfirmed: false, costBasis: 'standard',
    costSettings: { ...fallbackRules, ...settings?.costSettings, currency: 'CNY' }, rates: {},
    saleCurrency: 'CNY', saleAmount: settings?.orderPrices?.GPT?.[plan]?.CNY || '',
    emailCostAmount: '0', emailCostCurrency: 'CNY', start, expiry, rechargeCompletedAt: completedAt,
    createdAt: beijing(at).replace('T', ' '), createdBy: '自动充值', createdById: employeeId, rechargeOwnerId: employeeId,
    updatedBy: '', updatedById: '', customerId: '', notes: '', version: 1,
    refunds: [], bankReturns: [], corrections: [], financialEvidence: paidAmount && paidCurrency ? [{
      kind: 'payment', amount: paidAmount, currency: paidCurrency, payment: '银行卡', cardId,
      at: completedAt || ''
    }] : [],
    issueFeeSnapshot: { cardId, applied: false, pending: true }
  };
}

const publicSummary = ({ jobKey, needs, orderNo }) => ({ jobKey, needs, orderNo: orderNo || '' });

export function createRechargeOrderSync({ store, client, publicOrigin, quoteService, clock = Date.now }) {
  const startAt = clock();
  let running;
  let lastError = '';
  async function scan(apply, selected) {
    let checkpoint = store.featureDocument(domain);
    if (apply && !checkpoint.data) checkpoint = store.saveFeatureDocument(domain, checkpoint.version, { since: startAt, rows: [] });
    let saved = checkpoint.data || { since: startAt, rows: [] };
    const jobs = new Set(selected || []);
    let more = false;
    let nextOffset = 100;
    for (let page = 0; !selected && page < maxSessionPages; page++) {
      const offset = page === 0 ? 0 : (saved.scanOffset || 100) + (page - 1) * 100;
      const result = await client.get('/api/admin/sessions?limit=100&offset=' + offset);
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total))
        throw new Error('代充 Session 记录格式不正确');
      for (const row of result.items)
        if (row.status === 'success' && jobPattern.test(row.job_key || '')) jobs.add(row.job_key);
      if (offset + result.items.length >= result.total || !result.items.length) {
        nextOffset = 100;
        break;
      }
      nextOffset = offset + 100;
      more = page === maxSessionPages - 1;
    }
    if (apply && !selected) saved = store.rememberRechargeSessions([...jobs], nextOffset);
    const prior = new Map(saved.rows.map((row) => [row.jobKey, row]));
    if (!selected) {
      for (const row of saved.rows) if (row.needs?.length && !row.excluded) jobs.add(row.jobKey);
    }
    const candidates = [...jobs].filter((id) => {
      const row = prior.get(id);
      return !row?.excluded && !(row?.orderNo && !row.needs?.length) &&
        (selected || !row?.checkedAt || clock() - row.checkedAt >= retryAfter);
    })
      .sort((a, b) => (prior.get(a)?.checkedAt || 0) - (prior.get(b)?.checkedAt || 0));
    if (!candidates.length) return { rows: [], more };
    const date = beijing(saved.since).slice(0, 10);
    const [codes, { cards }] = await Promise.all([client.listCodes(), client.get('/api/admin/cards')]);
    if (!Array.isArray(cards)) throw new Error('代充卡池格式不正确');
    const bills = [];
    for (let page = 1; page <= maxBillPages; page++) {
      const result = await client.get('/api/admin/billing?status=success&start_date=' + date + '&page=' + page);
      if (!Array.isArray(result.records)) throw new Error('代充账单格式不正确');
      bills.push(...result.records);
      if (page * 20 >= result.total || !result.records.length) break;
      more ||= page === maxBillPages;
    }
    const ownerData = store.featureDocument('recharge-codes').data;
    const settings = store.load('settings').data;
    const rows = [];
    for (const jobKey of candidates.slice(0, maxChecks)) {
      const checkedAt = clock();
      let result;
      try {
        const { task, runtimeEntries } = await client.get('/api/admin/task-logs/' + jobKey);
        if (task?.jobKey !== jobKey) continue;
        let orbitCards = [];
        if (typeof task.gptApiOrderId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(task.gptApiOrderId)) {
          try {
            const related = await client.get('/api/admin/orbitcard/usage?page_size=20&recharge_status=success&keyword=' +
              encodeURIComponent(task.gptApiOrderId));
            if (Array.isArray(related.cards)) orbitCards = related.cards;
          } catch {}
        }
        const evidence = rechargeOrderEvidence(task, { bills, codes, cards, orbitCards, ownerData, runtimeEntries, now: checkedAt });
        if (!evidence) continue;
        const completed = utcInstant(evidence.completedAt);
        const created = utcInstant(task.createdAt);
        if (!(completed >= saved.since || !Number.isFinite(completed) && created >= saved.since)) {
          if (apply) store.applyRechargeOrder({ since: saved.since, row: {
            jobKey, checkedAt, excluded: Number.isFinite(completed),
            needs: Number.isFinite(completed) ? [] : ['无法确认该任务在启用后开通']
          } });
          continue;
        }
        const order = buildRechargeOrder(evidence, settings, checkedAt);
        if (apply && order && quoteService?.enabled && order.start && order.paidCurrency) {
          try { order.fxSnapshot = await quoteService.snapshotFor(order); } catch {}
        }
        result = { jobKey, needs: evidence.needs, checkedAt };
        if (apply) result = store.applyRechargeOrder({ since: saved.since, row: result, order, firstUse: evidence.firstUse });
      } catch {
        result = { jobKey, checkedAt, needs: ['本次回读未确认，可重试'] };
        if (apply) result = store.applyRechargeOrder({ since: saved.since, row: result });
      }
      rows.push(publicSummary(result));
    }
    return { rows, more: more || candidates.length > maxChecks };
  }
  function run({ apply = false, jobKeys } = {}) {
    if (running) return Promise.reject(Object.assign(new Error('同步正在进行，请稍后查看'), { status: 409 }));
    running = scan(apply, jobKeys).then((result) => {
      lastError = '';
      return result;
    }, (error) => {
      lastError = '最近一轮读取失败，等待下一次核对';
      throw error;
    }).finally(() => { running = undefined; });
    return running;
  }
  async function handle(request, response, actor) {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (!['admin', 'super'].includes(actor?.role)) return send(403, { error: '没有同步订单的权限' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '请求来源未通过校验' });
    if (request.method === 'GET') {
      const data = store.featureDocument(domain).data;
      return send(200, { running: Boolean(running), since: new Date(data?.since ?? startAt).toISOString(), lastError,
        rows: (data?.rows || []).filter((row) => !row.excluded).slice(-100).reverse().map(publicSummary) });
    }
    if (request.method !== 'POST' || request.headers.origin !== (publicOrigin || `http://${request.headers.host}`))
      return send(403, { error: '请求来源未通过校验' });
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 1024) throw new Error('请求过长');
      }
      const { mode, jobKeys } = JSON.parse(raw);
      if (!['preview', 'apply'].includes(mode)) return send(400, { error: '请选择预览或同步' });
      if ((mode === 'apply' || jobKeys !== undefined) && (!Array.isArray(jobKeys) || !jobKeys.length ||
        jobKeys.length > maxChecks || jobKeys.some((id) => typeof id !== 'string' || !jobPattern.test(id))))
        return send(400, { error: '请选择已核对的代充任务' });
      return send(200, await run({ apply: mode === 'apply', jobKeys: jobKeys && [...new Set(jobKeys)] }));
    } catch (error) {
      return send(error.status === 409 ? 409 : 503, { error: error.status === 409 ? error.message : '代充资料暂时无法同步' });
    }
  }
  return { handle, run };
}
