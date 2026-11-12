import { isDeepStrictEqual } from 'node:util';
import { validOrderEmail } from '../frontend/order-opening.mjs';
import { accountMarkedDead } from './account-lifecycle.mjs';

const rows = value => Array.isArray(value) ? value : [];
const nameKey = value => String(value || '').trim().toLowerCase();
const phoneKey = value => String(value || '').replace(/\D/g, '').replace(/^00/, '');
const emailKey = value => validOrderEmail(value) ? value.trim().toLowerCase() : '';
export const verifiedKyc = value => value === true || ['KYC 认证', 'KYC认证'].includes(value);
const certified = row => ['Claude Pro', 'Claude Max'].includes(row?.product) && verifiedKyc(row.kyc);
const sameAccount = (a, b) => Boolean((a.accountId && a.accountId === b.accountId) ||
  (a.email && a.email === b.email));

function verifierMatch(record, tenants) {
  const phone = phoneKey(record.verifierPhone), name = nameKey(record.verifier);
  const matchesPhone = phone ? tenants.filter(tenant => phoneKey(tenant.phone) === phone) : [];
  const exact = matchesPhone.filter(tenant => name && nameKey(tenant.name) === name);
  if (record.claudeVerifierId) {
    const current = tenants.find(tenant => tenant.id === record.claudeVerifierId);
    const currentPhone = phoneKey(current?.phone), currentName = nameKey(current?.name);
    const duplicates = currentPhone && currentName ? tenants.filter(tenant =>
      phoneKey(tenant.phone) === currentPhone && nameKey(tenant.name) === currentName) : [];
    return { ids: [...new Set([record.claudeVerifierId, ...exact.concat(duplicates).map(tenant => tenant.id)])], certain: true };
  }
  if (exact.length === 1) return { ids: [exact[0].id], certain: true };
  const possible = exact.length ? exact : matchesPhone.length ? matchesPhone :
    name ? tenants.filter(tenant => nameKey(tenant.name) === name) : [];
  return { ids: possible.map(tenant => tenant.id), certain: false };
}

function stockAccount(record, accounts) {
  const email = emailKey(record.email);
  const candidates = accounts.filter(account => account.type === 'claude' &&
    (record.accountId ? account.id === record.accountId && (!email || emailKey(account.email) === email) :
      email && emailKey(account.email) === email));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function binding(record, order, tenants, accounts) {
  const asset = stockAccount(record, accounts);
  return { orderId: order?.id || '', email: emailKey(record.email) || emailKey(asset?.email),
    accountId: record.accountId || asset?.id || '', dead: accountMarkedDead(asset),
    verifierName: nameKey(record.verifier), verifierPhone: phoneKey(record.verifierPhone),
    ...verifierMatch(record, tenants) };
}

function kycHistory(commerce, inventory) {
  const tenants = rows(commerce?.tenants), accounts = rows(inventory?.accounts);
  const records = [];
  for (const order of rows(commerce?.orders)) {
    for (const snapshot of [order, ...rows(order.corrections).map(entry => entry?.previous)]) {
      if (certified(snapshot)) records.push(binding(snapshot, order, tenants, accounts));
    }
  }
  for (const account of accounts) {
    if (account.type === 'claude' && verifiedKyc(account.kyc))
      records.push(binding({ ...account, accountId: account.id }, null, tenants, accounts));
  }
  return records;
}

export function tenantKycStatus(commerce, inventory, tenant) {
  const live = kycHistory(commerce, inventory).filter(record => !record.dead && record.ids.includes(tenant.id));
  return { status: tenant.active === false ? 'inactive' : live.some(record => record.certain) ? 'locked' :
    live.length ? 'review' : 'available',
  accounts: [...new Set(live.map(record => record.email).filter(Boolean))] };
}

// A recorded correction describes historical facts; it does not certify or restore an account.
export function isDeadAccountCorrection(prior, order, inventory, action) {
  if (!prior || !order || prior.id !== order.id || !['Claude Pro', 'Claude Max'].includes(prior.product) ||
      order.product !== prior.product || !Number.isSafeInteger(prior.version) || order.version !== prior.version + 1)
    return false;
  const accounts = rows(inventory?.accounts);
  const beforeAccount = stockAccount(prior, accounts), afterAccount = stockAccount(order, accounts);
  if (!accountMarkedDead(beforeAccount) || beforeAccount.id !== afterAccount?.id || !accountMarkedDead(afterAccount))
    return false;
  const before = rows(prior.corrections), after = rows(order.corrections);
  if (before.some((entry, index) => !isDeepStrictEqual(entry, after[index]))) return false;
  if (action === '更正订单') {
    const { corrections, refunds, bankReturns, ...snapshot } = prior;
    const change = after.at(-1);
    return after.length === before.length + 1 && change?.versionAfter === order.version &&
      typeof change.reason === 'string' && Boolean(change.reason.trim()) &&
      isDeepStrictEqual(change.previous, snapshot);
  }
  if (action === '补偿撤回更正') {
    const change = before.at(-1), oldCompensations = rows(prior.compensations), compensations = rows(order.compensations);
    const compensation = compensations.at(-1);
    return after.length === before.length && change?.versionAfter === prior.version &&
      compensations.length === oldCompensations.length + 1 &&
      oldCompensations.every((entry, index) => isDeepStrictEqual(entry, compensations[index])) &&
      compensation?.correctionId === change.id && compensation.fromVersion === prior.version &&
      compensation.toVersion === order.version && typeof compensation.reason === 'string' && Boolean(compensation.reason.trim()) &&
      ['product', 'email', 'accountId', 'kyc', 'verifier', 'verifierPhone', 'claudeVerifierId']
        .every(field => (order[field] ?? '') === (change.previous?.[field] ?? '') ||
          (['kyc', 'verifier', 'verifierPhone', 'claudeVerifierId'].includes(field) &&
            !Object.hasOwn(change.previous || {}, field) && order[field] === prior[field]));
  }
  return false;
}

// Called inside the existing business transaction after server-side verifier normalization.
export function checkTenantKycWrite(previous, next, inventory, { requireVerifier = false, action } = {}) {
  const before = rows(previous?.orders);
  const after = rows(next?.orders);
  const tenants = rows(next?.tenants), priorTenants = rows(previous?.tenants);
  const accounts = rows(inventory?.accounts);
  const byId = new Map(after.map(row => [row.id, row]));
  const priorById = new Map(before.map(row => [row.id, row]));
  const historicalCorrections = new Set(after.filter(order =>
    isDeadAccountCorrection(priorById.get(order.id), order, inventory, action)).map(order => order.id));
  for (const order of before) {
    const saved = byId.get(order.id);
    if (rows(order.corrections).some(entry => certified(entry?.previous) &&
        !rows(saved?.corrections).some(other => isDeepStrictEqual(entry, other))))
      return '原 KYC 核对记录必须保留';
    if (!certified(order) || historicalCorrections.has(order.id)) continue;
    const legacy = verifierMatch(order, priorTenants);
    if (!certified(saved) || (emailKey(order.email) && emailKey(saved.email) !== emailKey(order.email)) ||
        (order.accountId && order.accountId !== saved.accountId) ||
        nameKey(saved.verifier) !== nameKey(order.verifier) || phoneKey(saved.verifierPhone) !== phoneKey(order.verifierPhone) ||
        (order.claudeVerifierId && order.claudeVerifierId !== saved.claudeVerifierId) ||
        (saved.claudeVerifierId && (!legacy.certain || saved.claudeVerifierId !== legacy.ids[0])))
      return '已完成的 KYC 账号和认证人必须保留，不能通过更正或撤单释放';
    // Preserve uniquely matched historical identity when a tenant profile is edited.
    const refreshed = verifierMatch(saved, tenants);
    if (!saved.claudeVerifierId && legacy.certain && (!refreshed.certain || refreshed.ids[0] !== legacy.ids[0]))
      saved.claudeVerifierId = legacy.ids[0];
  }
  const history = kycHistory(previous, inventory);
  for (const order of after.filter(certified)) {
    const prior = priorById.get(order.id);
    if (certified(prior) && (emailKey(prior.email) || prior.accountId)) continue;
    if (certified(prior) && !emailKey(order.email) && !order.accountId) continue;
    const current = binding(order, order, tenants, accounts);
    if (requireVerifier && (!current.email || !current.certain ||
        (!certified(prior) && !order.claudeVerifierId)))
      return '登记 KYC 须选择租户认证人并填写可核对的 Claude 账号';
    if (current.dead) {
      if (historicalCorrections.has(order.id)) continue;
      return '死号的历史认证资料须通过原订单更正，并保留更正原因和原记录';
    }
    const others = history.filter(record => !certified(prior) || record.orderId !== order.id);
    const accountHistory = others.filter(record => sameAccount(record, current));
    if (accountHistory.length) {
      // Older internal delivery and renewal snapshots can carry the original proof.
      const carried = !requireVerifier && !prior && !order.claudeVerifierId &&
        ['成品交付', '续费'].includes(order.businessType) && current.accountId && current.email &&
        current.verifierName && current.verifierPhone && accountHistory.some(record =>
          record.accountId === current.accountId && record.email === current.email &&
          record.verifierName === current.verifierName && record.verifierPhone === current.verifierPhone);
      if (!carried) return '此 Claude 账号已登记过 KYC，不能重复认证';
      for (const field of ['kyc', 'verifier', 'verifierPhone']) delete order[field];
      continue;
    }
    if (current.ids.some(id => others.some(record => !record.dead && record.ids.includes(id))))
      return '此租户已有未标记死号的 KYC 账号，须先核对原账号状态';
    history.push(current);
  }
}

export function checkTenantKycRecovery(commerce, previous, next) {
  const restored = new Map(rows(next?.accounts).map(row => [row.id, row]));
  const oldDead = new Set(rows(previous?.accounts).filter(accountMarkedDead)
    .filter(row => !accountMarkedDead(restored.get(row.id))).map(row => row.id));
  if (!oldDead.size) return;
  const old = kycHistory(commerce, previous).filter(record => record.dead && oldDead.has(record.accountId));
  const live = kycHistory(commerce, next).filter(record => !record.dead);
  for (const record of old) {
    if (!restored.has(record.accountId)) return '已关联 KYC 的死号账号需保留原记录';
    if (record.ids.some(id => live.some(other => !sameAccount(record, other) && other.ids.includes(id))))
      return '该租户已在其他账号登记 KYC，不能恢复原死号';
  }
}
