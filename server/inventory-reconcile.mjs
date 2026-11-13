import { inventoryOperationalStatus } from '../modules/orders/order-opening.mjs';
import { inspectInventoryUsage, applyInventoryUsage } from './inventory-usage.mjs';
import {
  conflictingRegistration, registrationEmail, registrationMailboxCandidates, registrationOccupancy
} from './inventory-registration.mjs';

const list = value => Array.isArray(value) ? value : [];
const identifier = value => typeof value === 'string' && /^[\w.:-]{1,120}$/.test(value) &&
  !/^\d{12,19}$/.test(value) ? value : null;
const assetType = value => ['google', 'relay', 'microsoft', 'apple', 'gpt', 'claude', 'gemini', 'grok'].includes(value) ? value : null;
const reasonCodes = new Map([
  ['有多条同地址资料，需核对来源', 'ambiguous-mailbox'],
  ['订单、任务或注册结果待确认', 'unresolved-use'],
  ['提取批次关联待核对', 'invalid-claim'],
  ['业务来源与领取人需核对', 'different-claim-actor'],
  ['业务产品与提取用途不一致', 'different-claim-purpose'],
  ['业务时间与本次提取或历史归还需核对', 'inconsistent-use-time'],
  ['该邮箱的注册结果待核对', 'unresolved-registration']
]);

function document(input, arrays, label) {
  const snapshot = input && Object.hasOwn(input, 'data');
  const data = snapshot ? input.data : input;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      arrays.some(field => !Array.isArray(data[field]) ||
        data[field].some(row => !row || typeof row !== 'object' || Array.isArray(row))))
    throw new Error(label + '导出不完整，必须提供 ' + arrays.join('、'));
  const version = snapshot && Number.isSafeInteger(input.version) && input.version >= 0 ? input.version : null;
  return { data, version };
}

const brief = row => ({
  assetId: identifier(row.id), type: assetType(row.type),
  importId: identifier(row.importId)
});
const liveMailbox = row => !row.relayDeleted && !row.deleted;
const byId = rows => Map.groupBy(rows, row => row.id);

function summarize(inventory, commerce, clock) {
  const matches = inspectInventoryUsage(inventory, commerce, clock);
  const eligible = [], review = [], inconsistent = [];
  const groupedAssets = byId([...inventory.mailboxes.filter(liveMailbox), ...inventory.accounts]);
  const duplicateIds = new Set();
  for (const [assetId, assets] of groupedAssets) {
    if (assets.length > 1 || !identifier(assetId)) {
      duplicateIds.add(assetId);
      inconsistent.push({ ...brief(assets[0]), affected: assets.length,
        reason: assets.length > 1 ? 'duplicate-inventory-id' : 'invalid-inventory-id' });
    }
  }
  const registrationMatchesByAccount = new Set();
  for (const [assetId, match] of matches) {
    const { asset, evidence, claim, supplement, status, message, registrationConflict } = match;
    if (duplicateIds.has(assetId) || duplicateIds.has(evidence.accountId) || !identifier(assetId)) {
      matches.delete(assetId);
      continue;
    }
    if (evidence.kind === 'registration' && evidence.accountId) registrationMatchesByAccount.add(evidence.accountId);
    const reference = {
      ...brief(asset), accountId: identifier(evidence.accountId), orderId: identifier(evidence.orderId),
      registrationId: identifier(evidence.registrationId), claimId: identifier(claim?.item.id),
      batchId: identifier(claim?.batch.id), supplement: Boolean(supplement)
    };
    if (status === 'used') eligible.push({ ...reference, kind: evidence.kind });
    else review.push({ ...reference, reason: registrationConflict ? 'conflicting-registration'
      : reasonCodes.get(message) || 'unconfirmed-association' });
  }

  const mailboxes = byId(inventory.mailboxes.filter(liveMailbox));
  const accounts = byId(inventory.accounts);
  const occupancy = registrationOccupancy(inventory);
  const existingByAccount = new Map();
  for (const mailbox of inventory.mailboxes.filter(liveMailbox)) {
    for (const link of list(mailbox.usageLinks)) {
      if (link?.kind !== 'registration' || !link.accountId) continue;
      const entries = existingByAccount.get(link.accountId) || [];
      entries.push(mailbox);
      existingByAccount.set(link.accountId, entries);
    }
  }

  const oneSided = [], legacyFreeze = [];
  for (const account of inventory.accounts) {
    if (duplicateIds.has(account.id)) continue;
    const existing = [...new Set(existingByAccount.get(account.id) || [])];
    const entry = { ...brief(account), mailboxIds: existing.map(mailbox => identifier(mailbox.id)) };
    const facts = occupancy.get(registrationEmail(account.email));
    if (account.sourceMailboxId) {
      const ids = mailboxes.get(account.sourceMailboxId) || [];
      const compatible = registrationMailboxCandidates(account, ids);
      if (ids.length !== 1 || compatible.length !== 1 || conflictingRegistration(facts) ||
          duplicateIds.has(account.sourceMailboxId) || existing.some(mailbox => mailbox.id !== account.sourceMailboxId))
        inconsistent.push({ ...entry, sourceMailboxId: identifier(account.sourceMailboxId), reason: 'invalid-recorded-source' });
      else if (!existing.length && !registrationMatchesByAccount.has(account.id))
        inconsistent.push({ ...entry, sourceMailboxId: identifier(account.sourceMailboxId), reason: 'source-without-usage-evidence' });
    } else if (existing.length) {
      const compatible = registrationMailboxCandidates(account, existing, existing.length === 1 ? existing[0].id : undefined);
      if (existing.length === 1 && compatible.length === 1 && !conflictingRegistration(facts) &&
          !duplicateIds.has(existing[0].id))
        oneSided.push(entry);
      else inconsistent.push({ ...entry, reason: 'conflicting-persisted-registration' });
    }
    if (account.status === '冻结' && inventoryOperationalStatus(account) === '正常')
      legacyFreeze.push(brief(account));
  }
  for (const [accountId, existing] of existingByAccount) {
    if (!accounts.has(accountId))
      inconsistent.push({ assetId: identifier(accountId), type: null, importId: null,
        mailboxIds: [...new Set(existing.map(mailbox => identifier(mailbox.id)))], reason: 'missing-registration-account' });
  }
  return { matches, eligible, review, oneSided, inconsistent, legacyFreeze };
}

function totals(report) {
  return Object.fromEntries(['eligible', 'review', 'oneSided', 'inconsistent', 'legacyFreeze']
    .map(field => [field, report[field].length]));
}

export function auditInventoryLinkage(input, { clock = Date.now() } = {}) {
  if (!Number.isFinite(clock) || !Number.isFinite(new Date(clock).getTime())) throw new Error('核对时点无效');
  const inventory = document(input?.inventory, ['mailboxes', 'accounts', 'batches', 'registrationRecords'], '库存');
  const commerce = document(input?.commerce, ['orders'], '订单');
  const simulatedInventory = structuredClone(inventory.data);
  const now = new Date(clock);
  const { matches: simulationMatches, ...original } = summarize(simulatedInventory, commerce.data, clock);
  const changed = applyInventoryUsage(simulationMatches, null, now, simulatedInventory);
  const after = summarize(simulatedInventory, commerce.data, clock);
  const changedOnRepeat = applyInventoryUsage(after.matches, null, now, simulatedInventory);
  return {
    asOf: now.toISOString(),
    versions: { inventory: inventory.version, commerce: commerce.version },
    sourceCounts: {
      mailboxes: inventory.data.mailboxes.filter(liveMailbox).length, accounts: inventory.data.accounts.length,
      batches: inventory.data.batches.length, orders: commerce.data.orders.length
    },
    counts: totals(original), ...original,
    simulation: { changed, changedOnRepeat, remaining: totals(after) }
  };
}
