import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { recordEditVersion, recordFingerprintInput } from '../modules/data/record-edit.mjs';
import { inventoryAccountTypes, inventoryMailboxTypes } from '../modules/inventory/list.mjs';
import { listIdentity } from '../modules/orders/order-list.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { inventoryHealthRecoveryProblem } from './inventory-archive.mjs';
import { checkTenantKycRecovery } from './tenant-kyc.mjs';
import { WriteOperationError } from './write-operation.mjs';

export const inventoryHealthAction = 'inventory_health_change';
export const restoreInventoryHealthAction = 'inventory_restore_health';
export const inventoryHealthRecoveryLabel = '撤回库存状态变更';
export const inventoryHealthRecoveryReasons = Object.freeze({
  wrong_status: '状态标错', wrong_record: '选错库存资料'
});

const healthLabels = new Map([['normal', '正常'], ['dead', '死号'], ['unlocking', '解封中']]);
const collections = { accounts: inventoryAccountTypes, mailboxes: inventoryMailboxTypes };
const typeLabels = { gpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', google: '谷歌邮箱', microsoft: '微软邮箱' };
const list = value => Array.isArray(value) ? value : [];
const health = row => row.health || 'normal';
const version = row => recordEditVersion('inventory', row);

const sameRow = (before, after) => isDeepStrictEqual(before, after) ||
  (before && after && recordFingerprintInput('inventory', before) === recordFingerprintInput('inventory', after));

function fieldsApartFromHealth(row) {
  const { health, healthChangedAt, version, inventoryHistory, lastOperatedById, lastOperatedBy, lastOperatedAt, ...fields } = row;
  return recordFingerprintInput('inventory', fields);
}

function inventoryField(document, field) {
  return field === 'appleRelay' ? document.appleRelay ?? { parents: [], imports: [], events: [] } : document[field];
}

export function captureInventoryHealthRecovery(before, after, fingerprint) {
  if (!before || [...new Set([...Object.keys(before), ...Object.keys(after)])].some(field =>
    !Object.hasOwn(collections, field) && !isDeepStrictEqual(inventoryField(before, field), inventoryField(after, field)))) return;
  let change;
  for (const [collection, types] of Object.entries(collections)) {
    if (before[collection].length !== after[collection].length) return;
    for (const [index, next] of after[collection].entries()) {
      const prior = before[collection][index];
      if (sameRow(prior, next)) continue;
      if (change || !prior || !next || !types.includes(prior.type) || typeof prior.id !== 'string' ||
          !prior.id || prior.id.length > 256 || prior.id !== next.id ||
          !Number.isSafeInteger(version(prior)) || version(prior) < 1 ||
          !Number.isSafeInteger(version(next) + 1) || next.version !== version(prior) + 1 ||
          fieldsApartFromHealth(prior) !== fieldsApartFromHealth(next)) return;
      const from = health(prior), to = health(next);
      if (from === to || !healthLabels.has(from) || !healthLabels.has(to)) return;
      const history = list(prior.inventoryHistory), nextHistory = list(next.inventoryHistory);
      const event = nextHistory.at(-1);
      if (nextHistory.length !== history.length + 1 || !event?.id || event.action !== '健康状态变化' ||
          event.detail !== to || !isDeepStrictEqual(nextHistory.slice(0, -1), history)) return;
      change = { collection, kind: collection === 'accounts' ? 'account' : 'mailbox',
        targetId: next.id, before: from, after: to, version: next.version, fingerprint: fingerprint(next) };
    }
  }
  return change;
}

export function inventoryHealthRecoveryPreview(entry, row) {
  const identity = String(listIdentity(row)).trim();
  const email = /^([^@\s]+)@([a-z0-9.-]{1,253})$/i.exec(identity);
  const hint = email ? email[1].slice(0, 1) + '***@' + email[2]
    : identity.replace(/^@/, '').slice(0, 1).padEnd(identity ? 4 : 0, '*');
  return {
    targetLabel: [typeLabels[row.type], hint].filter(Boolean).join(' · '),
    changes: [{ label: '健康状态', current: healthLabels.get(entry.after), restore: healthLabels.get(entry.before) }]
  };
}

export function prepareInventoryHealthRecovery(inventory, entry, fingerprint, commerce, managedMailboxes, subscriptionOwners) {
  const rows = list(inventory?.[entry.collection]);
  const index = rows.findIndex(row => row?.id === entry.targetId);
  const prior = rows[index];
  const matches = [...list(inventory?.mailboxes), ...list(inventory?.accounts)].filter(row => row?.id === entry.targetId);
  if (!prior || matches.length !== 1)
    throw new WriteOperationError(409, '这条库存资料已不存在或编号有冲突，请到库存页面核对。');
  if (version(prior) !== entry.version || fingerprint(prior) !== entry.fingerprint)
    throw new WriteOperationError(409, '这条库存资料在原操作后已有更新，请到库存页面核对。');
  const issue = inventoryHealthRecoveryProblem(prior, inventory, commerce, managedMailboxes);
  if (issue) throw new WriteOperationError(409, issue);
  if (entry.kind === 'account' && Object.values(subscriptionOwners || {}).some(row => row?.accountId === prior.id))
    throw new WriteOperationError(409, '资料已关联订阅，请到原业务页面核对。');
  const next = { ...prior, health: entry.before };
  const data = { ...inventory, [entry.collection]: rows.toSpliced(index, 1, next) };
  const kycIssue = checkTenantKycRecovery(commerce, inventory, data);
  if (kycIssue) throw new WriteOperationError(409, kycIssue);
  return { data, prior, next };
}

export function recordInventoryHealthRecovery(row, actor, at, reason, originalId) {
  const time = toV2DateTimeInput(at).replace('T', ' ');
  Object.assign(row, {
    version: version(row) + 1, healthChangedAt: time,
    lastOperatedById: actor.id, lastOperatedBy: actor.name, lastOperatedAt: time,
    inventoryHistory: [...list(row.inventoryHistory), {
      id: randomUUID(), action: '健康状态变化', detail: row.health, reason,
      recoveryOf: originalId, actorId: actor.id, actor: actor.name, time
    }]
  });
}
