'use strict';
// Compatibility facade only. The worker has no SQL driver, database credentials,
// arbitrary query RPC, account authentication, or persistent credential store.
const { rpc, wasSubmitted, wasPaymentConfirmed, recordKnownOutcome } = require('../rpc.cjs');
const { rememberSecrets, clearSensitive } = require('../security.cjs');
const { requestCredential, forgetCredential } = require('../credential-client.cjs');
const cards = new Map();
const plans = { plus: 'chatgptplusplan', pro_5x: 'chatgptprolite', pro_20x: 'chatgptpro', pro5x: 'chatgptprolite', pro20x: 'chatgptpro' };
async function reserveCard(ownerKey, excludedIds = []) {
  const card = await rpc('reserveCard', { ownerKey, excludedIds });
  if (!card) return null;
  if (card.pendingCredentials) { const error = new Error('等待补齐本次临时安全码'); error.code = 'PENDING_CREDENTIALS'; throw error; }
  const normalized = { ...card, card_expiry: card.card_expiry || `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`,
    card_cvc: await requestCredential(String(card.id)), card_holder: card.card_holder || card.name || '', usage_count: card.usage_count ?? card.bind_count ?? 0 };
  if (!normalized.card_cvc) { clearSensitive(normalized); const error = new Error('等待补齐本次临时安全码'); error.code = 'PENDING_CREDENTIALS'; throw error; }
  rememberSecrets(normalized); cards.set(String(card.id), normalized); return normalized;
}
async function cardRpc(method, id, args = {}) {
  const card = cards.get(String(id));
  return rpc(method, { cardId: id, cardLeaseId: card?.leaseId, cardLeaseVersion: card?.leaseVersion, ...args });
}
async function releaseCard(id) {
  if (!id) return;
  try { if (!wasSubmitted() && !wasPaymentConfirmed()) await cardRpc('releaseCard', id); }
  finally { const card = cards.get(String(id)); clearSensitive(card); cards.delete(String(id)); forgetCredential(String(id)); }
}
function clearCredentials() { for (const [id, card] of cards) { clearSensitive(card); forgetCredential(id); } cards.clear(); }
async function createBillingRecord(data) {
  // Full PAN/CVC must never enter a billing record or an RPC error response.
  const { card_number: _pan, card_cvc: _cvc, cvc: _ignored, ...safe } = data;
  safe.amount = data.amount == null ? null : String(data.amount);
  safe.amountSource = data.amountSource || (safe.amount == null ? 'unknown' : 'checkout');
  return rpc('createBillingRecord', safe);
}
module.exports = {
  currentCardLease: () => { const card = [...cards.values()].at(-1); return card ? { cardId: card.id, cardLeaseId: card.leaseId, cardLeaseVersion: card.leaseVersion } : {}; },
  resolvePlanName: (p) => plans[p] || plans.plus,
  getRuntimeConfig: () => rpc('getRuntimeConfig'),
  getPaymentRegion: () => rpc('getPaymentRegion'),
  getCardPolicy: () => rpc('getCardPolicy'),
  verifyCdkDetails: (cdk) => rpc('verifyCdkDetails', { code: cdk }),
  getActiveProxy: async (proxyId) => { const proxy = await rpc('getActiveProxy', proxyId ? { proxyId } : {}); return proxy?.proxy_url || (typeof proxy === 'string' ? proxy : null); },
  getAppConfigValue: (key, fallback) => key === 'last_used_address_id' ? rpc('getAppConfigValue', { key, fallback }) : Promise.reject(new Error('不允许读取该配置')),
  setAppConfigValue: (key, value) => key === 'last_used_address_id' ? rpc('setAppConfigValue', { key, value }) : Promise.reject(new Error('不允许写入该配置')),
  reserveCard, releaseCard, clearCredentials,
  recordCardUsage: async (id) => { recordKnownOutcome('success'); const out = await cardRpc('recordCardUsage', id); return out; },
  recordCardDecline: async (id) => { const out = await cardRpc('recordCardDecline', id); recordKnownOutcome(); return out; },
  bindCardPaymentProfile: (id, profile) => cardRpc('bindCardPaymentProfile', id, { profile: { ...profile, addressId: profile.address?.id || null } }),
  createBillingRecord,
  listAddresses: (region) => rpc('listAddresses', { region }),
  markAddressBound: (addressId, cardId) => cardRpc('markAddressBound', cardId, { addressId }),
};
