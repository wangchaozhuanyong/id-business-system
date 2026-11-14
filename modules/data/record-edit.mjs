import { documentDelta } from './document-delta.mjs';
import { normalizeInventoryAsset } from '../inventory/list.mjs';

const inventoryFields = ['notes', 'notes2', 'device', 'password', 'phone', 'totp', 'appPassword',
  'security1', 'security2', 'security3', 'birthday'];
const orderFields = ['notes'];
const inventoryTypes = ['google', 'microsoft', 'gpt', 'claude', 'gemini', 'grok'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validText = (value, max) => typeof value === 'string' && value.length <= max;
const canonical = value => Array.isArray(value) ? value.map(canonical) : isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const orderMeta = ['version', 'updatedBy', 'updatedById', 'updatedAt', 'corrections', 'correctionReason'];
const inventoryMeta = ['version', 'lastOperatedBy', 'lastOperatedById', 'lastOperatedAt', 'inventoryHistory'];

export function recordFingerprintInput(domain, row) {
  const canonicalRow = domain === 'inventory' ? normalizeInventoryAsset({ ...row }) : row;
  return JSON.stringify(canonical(canonicalRow));
}

export function recordEditAllowed(domain, row) {
  if (domain === 'commerce') return Boolean(row && !row.cancelled && !row.draft && !row.deleted);
  return inventoryTypes.includes(row?.type) && !row.deleted && !row.relayDeleted;
}

export const recordEditVersion = (domain, row) => row?.version || (domain === 'inventory' ? 1 : 0);

export function validRecordEdit(domain, action, edit) {
  const orders = domain === 'commerce';
  const allowed = orders ? orderFields : inventoryFields;
  const keys = ['collection', 'id', 'expectedVersion', 'expectedFingerprint', 'changes', 'eventId',
    ...(orders ? ['logId', 'reason'] : [])];
  return ((orders && action === '更正订单' && edit?.collection === 'orders') ||
      (domain === 'inventory' && action === 'inventory_edit' && ['mailboxes', 'accounts'].includes(edit?.collection))) &&
    isObject(edit) && Object.keys(edit).every(key => keys.includes(key)) && idValid(edit.id) && idValid(edit.eventId) &&
    Number.isSafeInteger(edit.expectedVersion) && edit.expectedVersion >= (orders ? 0 : 1) &&
    typeof edit.expectedFingerprint === 'string' && /^[a-f0-9]{64}$/.test(edit.expectedFingerprint) &&
    isObject(edit.changes) && Object.keys(edit.changes).length > 0 &&
    Object.entries(edit.changes).every(([key, value]) => allowed.includes(key) && validText(value, 4096)) &&
    (!orders || (idValid(edit.logId) && validText(edit.reason, 300) && edit.reason.trim()));
}

export function recordEditCandidate(domain, action, before, after) {
  if (!(domain === 'commerce' && action === '更正订单' || domain === 'inventory' && action === 'inventory_edit')) return;
  const orders = domain === 'commerce';
  const delta = documentDelta(domain, before, after);
  if (!delta) return;
  const rows = delta.filter(change => (orders ? ['orders'] : ['accounts', 'mailboxes']).includes(change.collection));
  if (rows.length !== 1) return;
  const [{ collection, start, previousKeys, rows: nextRows }] = rows;
  if (previousKeys.length !== 1 || nextRows.length !== 1 ||
      delta.some(change => ![collection, orders ? 'logs' : 'undo'].includes(change.collection))) return;
  const prior = before[collection][start], next = nextRows[0];
  if (prior.id !== next.id || !recordEditAllowed(domain, prior) ||
      next.version !== recordEditVersion(domain, prior) + 1) return;
  const fields = orders ? orderFields : inventoryFields;
  const meta = orders ? orderMeta : inventoryMeta;
  const changes = {};
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    if (meta.includes(key) || same(prior[key], next[key])) continue;
    if (!orders && (prior[key] ?? '') === (next[key] ?? '')) continue;
    if (!fields.includes(key) || !validText(next[key], 4096)) return;
    changes[key] = next[key];
  }
  if (!Object.keys(changes).length) return;
  const eventsBefore = (orders ? prior.corrections : prior.inventoryHistory) || [];
  const eventsAfter = orders ? next.corrections : next.inventoryHistory;
  const event = eventsAfter?.at(-1);
  if (!event?.id || eventsAfter.length !== eventsBefore.length + 1 || !same(eventsAfter.slice(0, -1), eventsBefore)) return;
  const edit = { collection, id: prior.id, expectedVersion: recordEditVersion(domain, prior), changes, eventId: event.id };
  if (orders) {
    const log = after.logs?.[0];
    if (!log || log.type !== action || log.entityId !== prior.id || event.versionAfter !== next.version ||
        !same(after.logs.slice(1), before.logs)) return;
    return { prior, edit: { ...edit, reason: event.reason, logId: log.id } };
  }
  if (event.action !== '修改资料') return;
  const withoutAsset = undo => (undo || []).filter(([id]) => id !== prior.id);
  if (!same(withoutAsset(before.undo), withoutAsset(after.undo))) return;
  return { prior, edit };
}
