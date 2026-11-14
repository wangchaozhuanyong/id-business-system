import { randomUUID } from 'node:crypto';
import { financeReconciliation, websitePages } from '../modules/website/pages.mjs';
import { createFinanceReconciliation } from './finance/recharge-reconciliation.mjs';
import { canUseWorkspace, employeeCommerce, managesCards, ownsRecord, registrarInventory } from './access-roles.mjs';
import { checkFrozenCardPoolWrite } from './card-management.mjs';
import { extractManagedMailboxCode } from './tools/mailbox-pool.mjs';
import { validMoney } from './order-policy.mjs';
import { validCurrencyCode } from '../modules/finance/accounting.mjs';
import { describeWriteOperation } from './write-operation.mjs';
import { personalPlans, personalProduct, subscriptionSeries } from './personal-subscriptions.mjs';
import { normalizeRechargeProxyInput } from '../modules/recharge/codexdaichong/proxy-input.mjs';
import { isProxyType } from '../modules/recharge/bitbrowser/proxy-types.mjs';
import { calculateTotp } from '../modules/tools/totp.mjs';

export const staffPath = '/api/local/staff/';
const commerceLists = ['customers', 'tenants', 'orders', 'operating', 'rentBatches', 'logs'];
const inventoryLists = ['mailboxes', 'accounts', 'batches', 'returnRecords', 'importRecords', 'registrationRecords', 'tableSettings', 'undo'];
const configuredPlans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const orderPlans = { GPT: ['Plus', 'Pro 100', 'Pro 200', 'Pro 500'],
  'Claude Pro': ['Pro'], 'Claude Max': ['Max 5x', 'Max 20x'], ...personalPlans };
const registrations = new Set(['google', 'apple', 'microsoft', 'gpt', 'claude', 'gemini', 'grok']);
const accountTypes = new Set(['gpt', 'claude', 'gemini', 'grok']);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const clean = (value, maximum = 254) => typeof value === 'string' && value.length <= maximum &&
  !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const emptyDocument = keys => Object.fromEntries(keys.map(key => [key, []]));
const isReadable = method => method === 'GET';
const declaredWorkspaces = new Map(websitePages.map(page => ['/api/local/' + page.resource, page]));

function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail(415, '请从当前页面提交');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 240 * 1024) { request.resume(); fail(413, '单次提交内容过多，请分批保存'); }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  fail(400, '请核对填写的资料');
}

function keepVersion(body, snapshot) {
  if (!Number.isSafeInteger(body.version) || body.version !== snapshot.version)
    fail(409, '资料已更新，请刷新后重新核对，输入已保留');
}

function readCustomerService(store, actor) {
  return employeeCommerce(store.load('commerce'), actor);
}

function addCustomer(store, snapshot, body, actor, operation) {
  const data = snapshot.data || emptyDocument(commerceLists);
  const name = clean(body.name, 80);
  const wechat = clean(body.wechat, 120);
  if (!name) fail(400, '请填写客户姓名');
  const key = value => clean(value, 120).normalize('NFKC').toLowerCase();
  if (data.customers.some(row => (wechat && key(row.wechat) === key(wechat)) ||
      (!wechat && key(row.name) === key(name))))
    fail(409, '客户可能已存在，请查询或请管理员分配原客户');
  const id = 'customer-' + randomUUID();
  const at = new Date().toISOString();
  store.saveBatch([{ domain: 'commerce', version: snapshot.version, action: '新增资料', data: {
    ...data, customers: [{ id, name, wechat, active: true, version: 1, createdAt: at, updatedAt: at,
      createdById: actor.id, updatedById: actor.id }, ...data.customers]
  } }], { actor, operation });
  return { savedId: id };
}

function addOrder(store, snapshot, body, actor, operation) {
  const data = snapshot.data || emptyDocument(commerceLists);
  const customer = data.customers.find(row => row.id === body.customerId && row.active !== false);
  if (!customer || (!ownsRecord(actor, customer) &&
      !data.orders.some(row => row.customerId === customer.id && ownsRecord(actor, row))))
    fail(404, '请选择本人负责的客户');
  const [product, plan] = String(body.planChoice || '').split('|');
  if (!Object.hasOwn(orderPlans, product) || !orderPlans[product].includes(plan)) fail(400, '请选择可用的套餐');
  const address = clean(body.email).toLowerCase();
  const loginMethod = ({ Gemini: 'google', Grok: 'email' })[product];
  if (!email(address)) fail(400, '请填写有效订单邮箱');
  if (product === 'Claude Pro') fail(400, 'Claude Pro 的租户资料请联系管理员登记');
  const { paidAmount, paidCurrency, saleAmount, saleCurrency } = body;
  if (!validMoney(paidAmount) || !/[1-9]/.test(paidAmount) || !validMoney(saleAmount) ||
      !validCurrencyCode(paidCurrency) || !validCurrencyCode(saleCurrency))
    fail(400, '请填写实际代付、客户实收和币种');
  const start = clean(body.start, 24);
  const expiry = clean(body.expiry, 24);
  if (![start, expiry].every(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + '+08:00'))) || expiry <= start)
    fail(400, '请填写开通和到期时间');
  if (body.payment !== '银行卡' && body.payment !== '苹果内购') fail(400, '请选择实际付款方式');
  if (body.payment === '苹果内购' && paidCurrency !== 'USD') fail(400, '苹果内购的实际代付币种请选择 USD');
  const id = 'order-' + randomUUID();
  const at = new Date().toISOString();
  const row = { id, product, plan, email: address,
    customerId: customer.id, businessType: product === 'GPT' ? '续费' : '首次开通',
    accountSource: '客户自有', source: '管理员手工', ownerId: actor.id, version: 1, start, expiry,
    payment: body.payment, paidAmount, paidCurrency, saleAmount, saleCurrency, createdAt: at, updatedAt: at,
    paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', costBasis: 'standard',
    ...(loginMethod && { loginMethod }) };
  if (personalProduct(product)) row.subscriptionSeries = subscriptionSeries(row);
  store.saveStaffOrder({ domain: 'commerce', version: snapshot.version, action: '新增独立订单',
    data: { ...data, orders: [row, ...data.orders] } }, actor, operation);
  return { savedId: id };
}

async function registerAsset(store, snapshot, body, actor, operation) {
  const type = body.type;
  const identity = clean(body.email).toLowerCase();
  const password = typeof body.password === 'string' && body.password.length <= 4096 && !/[\u0000\r\n]/.test(body.password)
    ? body.password : '';
  const totp = clean(body.totp, 4096);
  if (!registrations.has(type) || !email(identity)) fail(400, '请选择类型并填写有效邮箱');
  if (body.totp) {
    try { await calculateTotp(totp); }
    catch { fail(400, '请填写有效的动态验证码密钥或验证器链接'); }
  }
  const data = snapshot.data || emptyDocument(inventoryLists);
  const account = accountTypes.has(type);
  const target = account ? 'accounts' : 'mailboxes';
  const oldMailbox = body.mailboxId ? data.mailboxes.find(row => row.id === body.mailboxId && ownsRecord(actor, row) &&
    !row.deleted && !row.relayDeleted && !row.used && row.email?.toLowerCase() === identity) : null;
  if (body.mailboxId && (!account || !oldMailbox)) fail(400, '请选择本人已登记且邮箱相同的资料');
  if ((data[target] || []).some(row => row.email?.toLowerCase() === identity && (account || row.type === type)))
    fail(409, account ? '这个邮箱已登记过平台账号' : '这个邮箱已登记');
  const id = 'registration-' + randomUUID();
  const row = { id, type, email: identity, password, totp, version: 1, registered: new Date().toISOString(),
    status: '正常', health: 'normal', inventoryState: 'available', used: false, notes: clean(body.notes, 600),
    device: clean(body.device, 200), proxyUrl: clean(body.proxyUrl, 2048), country: clean(body.country, 100),
    inventoryHistory: [], usageLinks: [], source: '自行注册', createdById: actor.id, createdBy: actor.name,
    ...(account && { acquisitionMethod: 'self_registered' }),
    ...(!account && body.appPassword && { appPassword: clean(body.appPassword, 4096) }),
    ...(oldMailbox && { sourceMailboxId: oldMailbox.id, ...(oldMailbox.claimId && { sourceClaimId: oldMailbox.claimId }) }),
    ...(type === 'microsoft' && { microsoftSecurity: {
      loginMode: password ? 'password' : 'passwordless', recoveryAccess: 'unknown', twoStep: totp ? 'enabled' : 'unknown',
      verificationMethods: totp ? ['totp'] : password ? [] : ['authenticator']
    } })
  };
  store.saveBatch([{ domain: 'inventory', version: snapshot.version, action: 'inventory_create',
    data: { ...data, [target]: [row, ...data[target]] } }], { actor, operation });
  return { savedId: id };
}

function cardsView(data) {
  if (!Array.isArray(data.cards) || !Number.isSafeInteger(data.planPolicy?.version) ||
      typeof data.planPolicy.strict !== 'boolean') fail(503, '暂时无法确认银行卡和套餐设置');
  return {
    version: data.planPolicy.version, strict: data.planPolicy.strict,
    items: data.cards.filter(row => Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 && /^\d{4}$/.test(row.last4))
      .map(row => {
        const active = Number(row.is_active) === 1;
        const state = !active ? '已停用' : row.status && row.status !== '正常' ? '不可用'
          : Date.parse(row.cooldown_until) > Date.now() ? '暂缓使用' : '可用';
        return { id: Number(row.id), last4: row.last4, active, state,
          uses: Number(row.usage_count) || 0, lastUsedAt: row.last_used_at || null,
          plans: Array.isArray(row.allowed_plans) ? row.allowed_plans.filter(plan => configuredPlans.has(plan)) : null };
      })
  };
}

function allowedPlans(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > configuredPlans.size ||
      new Set(value).size !== value.length || !value.every(plan => configuredPlans.has(plan)))
    fail(400, '请至少选择一个允许使用的套餐');
  return value;
}

function importCommand(body) {
  if (typeof body.lines !== 'string') fail(400, '请填写银行卡');
  const rows = body.lines.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!rows.length || rows.length > 500) fail(400, '每次导入 1 至 500 张银行卡');
  const cards = rows.map((line, index) => {
    const match = /^(\d{12,19})\s*(?:\|\s*|\s+)(0[1-9]|1[0-2])\/(\d{2}|\d{4})\s*(?:\|\s*|\s+)(\d{3,4})(?:(?:\s*\|\s*|\s+)([^\u0000-\u001f]{1,100}))?$/.exec(line);
    if (!match) fail(400, '第 ' + (index + 1) + ' 行格式有误，请检查卡号、有效期和安全码');
    return { card_number: match[1], card_expiry: match[2] + '/' + match[3].slice(-2), card_cvc: match[4],
      card_holder: match[5]?.trim() || '' };
  });
  return { cards, allowedPlans: allowedPlans(body.plans), planVersion: body.version };
}

const samePlans = (actual, expected) => Array.isArray(actual) && expected.length === actual.length &&
  expected.every(plan => actual.includes(plan));
const cardActions = { import: '导入银行卡', plans: '设置套餐', strict: '修改取卡规则', stop: '停用银行卡' };
const uncertainCardWrite = '银行卡维护结果待核对，请刷新列表并使用「核对上次操作」';
const cardIdentity = (row, store) => store.financeCardIdentity(
  JSON.stringify([row.card_number, row.card_expiry, String(row.card_holder || '').trim()]));

function finishCardWrite(store, actor, domain, audit, count) {
  const result = { saved: true, ...(count !== undefined && { count }) };
  store.finishFinanceCardOperation(actor, domain, { audit, result });
  return result;
}

function reconcileCards(pending, raw, current, store) {
  const expected = pending.evidence;
  const cards = new Map(current.items.map(card => [card.id, card]));
  if (pending.action === 'stop') return { matches: cards.get(expected.id)?.active === false };
  if (pending.action !== 'import' && expected.needsChange && current.version <= expected.version)
    return { matches: false };
  if (pending.action === 'strict') return { matches: current.strict === expected.strict };
  if (pending.action === 'plans')
    return { matches: expected.ids.every(id => samePlans(cards.get(id)?.plans, expected.plans)) };
  if (pending.action !== 'import') return { matches: false };
  if (!expected.imported.length) return { matches: true, count: 0 };
  if (current.version <= expected.version) return { matches: false };
  const outstanding = new Set(expected.imported);
  for (const row of raw.cards) {
    if (/^\d{12,19}$/.test(row.card_number || '') && samePlans(cards.get(Number(row.id))?.plans, expected.plans))
      outstanding.delete(cardIdentity(row, store));
  }
  return outstanding.size === 0 ? { matches: true, count: expected.imported.length } : { matches: false };
}

export function createStaffWorkspaces({ store, client, publicOrigin, getAuth, readMailbox, readRelayCodes, cardChanged }) {
  const readReconciliation = createFinanceReconciliation(client, store);
  const inProgress = new Set();
  const lastMailRead = new Map();
  async function manageCards(request, route, actor, body) {
    if (!managesCards(actor)) fail(403, '当前账号无权管理自动代充银行卡');
    if (route === 'finance/cards' && isReadable(request.method)) {
      const current = cardsView(await client.get('/api/admin/cards'));
      const pending = store.pendingFinanceCardOperations().map(row => ({ id: row.id, at: row.at,
        label: cardActions[row.action], submittedBy: row.actorName, canReview: actor.role === 'super' || row.actorId === actor.id }));
      return { ...current, pending };
    }
    if (route !== 'finance/cards' || request.method !== 'POST') fail(405, '此操作不可用');
    requireRecent(getAuth(), request);
    const operation = describeWriteOperation(request.headers['x-id-operation'], actor, [route, body]);
    const reconciling = body.action === 'reconcile';
    if (!reconciling && !operation) fail(400, '请从当前页面提交银行卡维护');
    if (inProgress.has('cards')) fail(409, '已有银行卡操作正在处理，请稍后重试');
    inProgress.add('cards');
    try {
      if (!reconciling) {
        const prior = store.financeCardOperation(operation);
        if (prior) return prior;
      }
      const raw = await client.get('/api/admin/cards');
      const current = cardsView(raw);
      if (reconciling) {
        const pending = store.pendingFinanceCardOperations().find(row => row.id === body.id);
        if (!pending) fail(409, '该操作已核对或已变化，请刷新列表');
        if (actor.role !== 'super' && pending.actorId !== actor.id)
          fail(403, '仅提交人或超级管理员可以核对这次维护');
        if (body.version !== current.version || body.confirmed !== true)
          fail(409, '请刷新列表并核对当前银行卡资料');
        if (body.outcome !== undefined && body.outcome !== 'unconfirmed')
          fail(400, '请选择要登记的核对结果');
        const actual = reconcileCards(pending, raw, current, store);
        if (body.outcome === 'unconfirmed') {
          if (actual.matches) fail(409, '当前资料与上次提交一致，请选择核对上次操作');
          const result = { saved: true, unconfirmed: true };
          store.finishFinanceCardOperation(actor, pending.domain, {
            audit: ['finance_card_unconfirmed', cardActions[pending.action]], result
          });
          return result;
        }
        if (!actual.matches) fail(409, '当前银行卡资料与上次提交不一致，结果仍待核对');
        const result = finishCardWrite(store, actor, pending.domain, ['finance_card_reconciled', cardActions[pending.action]], actual.count);
        cardChanged?.();
        return { ...result, reconciled: true };
      }
      let audit, count;
      const start = evidence => store.startFinanceCardOperation(actor, operation, body.action, body.version, current.version, evidence);
      const sendToCardPool = async callback => {
        try { return await callback(); }
        catch (error) {
          if ([400, 409].includes(error.upstreamStatus)) {
            store.finishFinanceCardOperation(actor, operation.domain, {});
            fail(409, '银行卡维护未提交，请刷新后核对');
          }
          fail(503, uncertainCardWrite);
        }
      };
      if (body.action === 'import') {
        const command = importCommand(body);
        checkFrozenCardPoolWrite(store, { kind: 'import', data: command });
        const existing = new Set(raw.cards.map(row => row.card_number));
        const seen = new Set();
        const imported = [];
        const numbers = [];
        for (const row of command.cards) {
          const number = row.card_number;
          if (seen.has(number)) continue;
          seen.add(number);
          numbers.push(store.orderCardFingerprint(number));
          if (!existing.has(number)) imported.push(cardIdentity(row, store));
        }
        const intent = store.financeCardIdentity(JSON.stringify([numbers.sort(), [...command.allowedPlans].sort()]));
        start({ intent, imported, plans: command.allowedPlans, version: current.version });
        const result = await sendToCardPool(() => client.writeCardMaintenance('POST', '/api/admin/cards/import', command, actor));
        if (!Number.isSafeInteger(result.imported) || result.imported < 0 || result.imported > command.cards.length)
          fail(503, uncertainCardWrite);
        count = result.imported;
        audit = ['finance_card_import', '导入 ' + count + ' 张'];
      } else if (body.action === 'plans' || body.action === 'strict') {
        const ids = body.cardIds;
        const command = { version: current.version };
        if (body.action === 'strict') {
          if (typeof body.strict !== 'boolean') fail(400, '请选择取卡规则');
          command.strict = body.strict;
        } else {
          if (!Array.isArray(ids) || !ids.length || ids.length > 500 ||
              ids.some(id => !current.items.some(row => row.id === id))) fail(409, '请选择列表中的银行卡');
          command.cardIds = [...new Set(ids)];
          command.allowedPlans = allowedPlans(body.plans);
        }
        const evidence = body.action === 'strict' ? { strict: command.strict } :
          { ids: [...command.cardIds].sort((a, b) => a - b), plans: [...command.allowedPlans].sort() };
        const needsChange = body.action === 'strict' ? command.strict !== current.strict :
          current.items.some(card => evidence.ids.includes(card.id) && !samePlans(card.plans, evidence.plans));
        start({ ...evidence, intent: JSON.stringify(evidence), version: current.version, needsChange });
        const result = await sendToCardPool(() => client.writeCardMaintenance('PUT', '/api/admin/cards/plan-policy', command, actor));
        if (!Number.isSafeInteger(result.planPolicy?.version) || result.planPolicy.version < current.version)
          fail(503, uncertainCardWrite);
        audit = ['finance_card_plans', command.cardIds?.length ? '设置 ' + command.cardIds.length + ' 张' : '修改取卡规则'];
      } else if (body.action === 'stop') {
        const card = current.items.find(row => row.id === body.id);
        if (!card) fail(404, '未找到该银行卡');
        start({ id: card.id, intent: String(card.id) });
        if (card.active) {
          const result = await sendToCardPool(() => client.stopCardUse(['recharge:' + body.id]));
          if (result.state === 'pending') {
            store.finishFinanceCardOperation(actor, operation.domain, {});
            fail(409, '这张卡正在使用，请在本笔充值结束后再试');
          }
          if (result.state !== 'stopped' || !result.refs?.includes('recharge:' + body.id)) fail(503, uncertainCardWrite);
        }
        audit = ['finance_card_stop', '卡尾 ' + card.last4];
      } else fail(400, '请选择可用的银行卡操作');
      const result = finishCardWrite(store, actor, operation.domain, audit, count);
      cardChanged?.();
      return result;
    } finally {
      inProgress.delete('cards');
    }
  }

  async function mailCodes(actor, body) {
    const now = Date.now();
    for (const [key, at] of lastMailRead) if (now - at >= 15_000) lastMailRead.delete(key);
    if (lastMailRead.has(actor.id) || lastMailRead.size >= 8) fail(429, '查询过于频繁，请稍后重试');
    const target = store.registrationMailbox(body.id, actor);
    if (!target) fail(404, '请选择本人已登记且可用的邮箱');
    lastMailRead.set(actor.id, now);
    let rows, result;
    if (target.asset.type === 'relay') rows = await readRelayCodes(target.asset, actor);
    else {
      if (!target.item) fail(409, '该邮箱尚未连接收信，请核对应用专用密码或联系管理员授权');
      result = await readMailbox({ ...target.item, limit: 8 });
      rows = (Array.isArray(result) ? result : result.rows).flatMap(row => {
        const code = extractManagedMailboxCode(row.body) || extractManagedMailboxCode(row.subject);
        return code ? [{ code, receivedAt: row.receivedAt }] : [];
      });
    }
    const current = store.registrationMailbox(body.id, actor);
    if (current?.asset.version !== target.asset.version || current?.item?.revision !== target.item?.revision ||
        current?.item?.id !== target.item?.id)
      fail(409, '邮箱资料已更新，请刷新再查询');
    if (result?.refreshToken && target.item?.id && result.refreshToken !== target.item.refreshToken)
      store.rotateMicrosoftRefreshToken(target.item.id, target.item.revision, result.refreshToken);
    store.recordAuthEvent({ action: 'registration_code_read', targetId: target.asset.id, actor });
    return { items: rows };
  }

  return async (request, response, path, actor) => {
    try {
      if (!actor?.id) fail(401, '请先登录');
      const origin = publicOrigin || 'http://' + request.headers.host;
      if ((request.headers.origin && request.headers.origin !== origin) ||
          (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) ||
          (!isReadable(request.method) && request.headers.origin !== origin))
        fail(403, '请从当前页面操作');
      if (!['GET', 'POST'].includes(request.method)) fail(405, '此操作不可用');
      const route = path.slice(staffPath.length);
      const read = isReadable(request.method);
      const page = declaredWorkspaces.get(path);
      if (page) {
        if (!page.roles.includes(actor.role)) fail(403, '当前账号无权访问此页面');
        if (!page.methods.includes(request.method)) fail(405, '此页面只供查看');
      } else if (['mail-code', 'registration-code'].includes(route) && !canUseWorkspace(actor, 'registration'))
        fail(403, '当前账号无权访问此页面');
      if (path === '/api/local/' + financeReconciliation.resource) {
        return send(response, 200, await readReconciliation(new URL(request.url, origin).searchParams, actor));
      }
      const body = read ? {} : await readBody(request);
      if (route.startsWith('finance/')) return send(response, 200, await manageCards(request, route, actor, body));
      if (route === 'team' && read) {
        const staff = getAuth().teamFor(actor.id);
        const orders = store.load('commerce').data?.orders || [];
        return send(response, 200, { items: staff.map(member => {
          const own = orders.filter(row => ownsRecord(member, row) && !row.cancelled && !row.draft);
          return { name: member.name, orders: own.length, customers: new Set(own.map(row => row.customerId).filter(Boolean)).size };
        }) });
      }
      if (route === 'business-proxies') {
        if (!read && body.action === 'recharge') {
          requireRecent(getAuth(), request);
          const countryCode = clean(body.countryCode, 2).toUpperCase();
          if (!/^[A-Z]{2}$/.test(countryCode) || !isProxyType(body.kind))
            fail(400, '请填写代理国家代码并选择类型');
          let proxies;
          try { ({ proxies } = normalizeRechargeProxyInput(body.link)); }
          catch { fail(400, '代理地址格式不正确'); }
          if (proxies.length !== 1) fail(400, '每次仅可登记一条业务 IP');
          const result = await client.addBusinessProxy({ countryCode, proxyType: body.kind, proxies }, actor);
          if (![result.added, result.labeled, result.skipped].every(Number.isSafeInteger))
            fail(503, '暂时无法确认业务 IP 登记结果');
          store.recordAuthEvent({ action: 'supervisor_proxy_add', actor, targetId: countryCode });
          return send(response, 200, { saved: true, added: result.added, skipped: result.skipped });
        }
        if (!read && body.id) fail(403, '主管可以登记新的业务 IP');
        const result = read ? store.loadBitBrowserProxies(actor) : store.saveBitBrowserProxy(body, actor);
        return send(response, 200, result);
      }
      if (route === 'mail-code' && !read) return send(response, 200, await mailCodes(actor, body));
      if (route === 'registration-code' && actor.role === 'registrar' && !read) {
        const inventory = store.load('inventory').data;
        const record = [...(inventory?.mailboxes || []), ...(inventory?.accounts || [])]
          .find(row => row.id === body.id && ownsRecord(actor, row) && !row.used && !row.deleted && !row.relayDeleted);
        if (!record?.totp) fail(404, '这条登记没有已保存的动态验证码');
        const generated = await calculateTotp(record.totp);
        store.recordAuthEvent({ action: 'registration_totp_read', targetId: record.id, actor });
        return send(response, 200, { code: generated.code, expiresAt: generated.expiresAt });
      }
      if (route === 'registration' || route === 'customer-service') {
        const registration = route === 'registration';
        const domain = registration ? 'inventory' : 'commerce';
        if (read) return send(response, 200, registration
          ? registrarInventory(store.load(domain), actor) : readCustomerService(store, actor));
        const operation = describeWriteOperation(request.headers['x-id-operation'], actor, [route, body]);
        const saved = operation && store.replayWrite(operation);
        const snapshot = store.load(domain);
        if (saved) return send(response, 200, { saved: true });
        keepVersion(body, snapshot);
        const result = registration ? await registerAsset(store, snapshot, body, actor, operation)
          : body.action === 'customer' ? addCustomer(store, snapshot, body, actor, operation)
            : body.action === 'manual-order' ? addOrder(store, snapshot, body, actor, operation)
              : body.action === 'renewal' ? fail(409, '请先从续费管理提交给财务')
                : fail(400, '请选择客户业务');
        return send(response, 200, { saved: true, ...result });
      }
      fail(404, '此工作页面不存在');
    } catch (error) {
      const status = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 503].includes(error.status) ? error.status
        : [400, 404, 409, 422].includes(error.upstreamStatus) ? 409 : 503;
      send(response, status, { error: error.status === status ? error.message :
        status === 409 ? '资料已变化，请刷新后核对。' : '暂时无法确认结果，请刷新核对后再试。' });
    }
  };
}

function requireRecent(auth, request) {
  if (!auth?.recentlyVerified(request)) fail(403, '请先完成安全确认，再提交这项操作');
}
