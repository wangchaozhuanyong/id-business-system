import { isDeepStrictEqual } from 'node:util';
import { WriteOperationError } from './write-operation.mjs';

export const contactRecoveryWindow = 30 * 24 * 60 * 60 * 1000;
export const contactRecoveryAction = 'contact_recover';
export const contactRecoveryLabel = '撤回资料操作';
export const contactRecoveryReasons = Object.freeze({
  wrong_value: '资料填错',
  wrong_contact: '选错客户或租户',
  accidental_disable: '误停用'
});

const fieldLabels = {
  name: '姓名', phone: '联系电话', wechat: '客户微信', qq: 'QQ', whatsapp: 'WhatsApp',
  telegram: 'Telegram', source: '来源渠道', tags: '客户标签', active: '状态'
};
const editFields = {
  customer: ['name', 'phone', 'wechat', 'qq', 'whatsapp', 'telegram', 'source', 'tags'],
  tenant: ['name', 'phone']
};
const collections = { customer: 'customers', tenant: 'tenants' };
const implicitEmptyFields = { customer: ['owner'], tenant: ['wechat', 'qq', 'whatsapp', 'telegram', 'source'] };
const editMetadata = ['updatedBy', 'updatedById', 'updatedAt', 'version'];
const keysOf = (before, after) => new Set([...Object.keys(before), ...Object.keys(after)]);
const differs = (before, after, key) => !isDeepStrictEqual(before[key], after[key]);
const empty = (field, value) => value == null || (field === 'tags' ? Array.isArray(value) && !value.length : value === '');

export function captureContactRecovery(before, after, action, fingerprint) {
  if (!before || !['修改资料', '停用资料'].includes(action)) return;
  if ([...keysOf(before, after)].some(key =>
    !['customers', 'tenants', 'logs'].includes(key) && differs(before, after, key))) return;
  const log = after.logs[0];
  if (after.logs.length !== before.logs.length + 1 || typeof log?.id !== 'string' || !log.id ||
      log.type !== action || log.relatedOrderId || !isDeepStrictEqual(after.logs.slice(1), before.logs) ||
      before.logs.some(row => row.id === log.id)) return;
  const changed = Object.entries(collections).filter(([, list]) => differs(before, after, list));
  if (changed.length !== 1) return;
  const [[kind, list]] = changed;
  const rows = before[list], nextRows = after[list];
  if (rows.length !== nextRows.length) return;
  const index = rows.findIndex(row => row.id === log.entityId);
  if (index < 0 || rows.findLastIndex(row => row.id === log.entityId) !== index ||
      nextRows.some((row, i) => i !== index && !isDeepStrictEqual(rows[i], row))) return;
  const prior = rows[index], next = nextRows[index];
  if (typeof prior.id !== 'string' || !prior.id || prior.id.length > 128 || prior.id !== next.id ||
      !Number.isSafeInteger(prior.version) || prior.version < 0 ||
      !Number.isSafeInteger(next.version + 1) || next.version !== prior.version + 1) return;
  const fields = action === '停用资料' ? ['active'] : editFields[kind];
  const allowed = [...fields, ...editMetadata, ...(action === '修改资料' ? ['notes'] : [])];
  if ([...keysOf(prior, next)].some(key => !allowed.includes(key) && differs(prior, next, key) &&
      !(action === '修改资料' && implicitEmptyFields[kind].includes(key) && empty(key, prior[key]) && empty(key, next[key]))) ||
      (action === '停用资料' && (prior.active !== true || next.active !== false))) return;
  const changes = fields.filter(field => differs(prior, next, field) &&
    !(empty(field, prior[field]) && empty(field, next[field]))).map(field => ({
    field, before: prior[field], after: next[field]
  }));
  if (!changes.length || changes.some(({ field, before, after }) =>
    !validContactValue(field, before) || !validContactValue(field, after))) return;
  return { kind, targetId: next.id, version: next.version, fingerprint: fingerprint(next), changes };
}

function validContactValue(field, value) {
  if (field === 'active') return typeof value === 'boolean';
  if (field === 'name') return typeof value === 'string' && Boolean(value.trim()) && value.length <= 80;
  if (value == null) return true;
  if (field === 'tags') return Array.isArray(value) && value.length <= 100 &&
    value.every(tag => typeof tag === 'string' && tag.length <= 40);
  return typeof value === 'string' && value.length <= 60;
}

export function prepareContactRecovery(snapshot, entry, fingerprint, validate) {
  const list = collections[entry.kind];
  const rows = snapshot?.[list] || [];
  const index = rows.findIndex(row => row.id === entry.targetId);
  const prior = rows[index];
  if (!prior || rows.findLastIndex(row => row.id === entry.targetId) !== index)
    throw new WriteOperationError(409, '这条资料已不存在或编号有冲突，请到原业务页面核对。');
  if (prior.version !== entry.version || fingerprint(prior) !== entry.fingerprint)
    throw new WriteOperationError(409, '这条资料在原操作后已有更新，请到原业务页面核对。');
  const next = { ...prior };
  for (const { field, before } of entry.changes) {
    if (before === undefined) delete next[field];
    else next[field] = before;
  }
  const data = { ...snapshot, [list]: rows.toSpliced(index, 1, next) };
  validate(data, snapshot, entry.kind, prior, next);
  return { data, next, prior };
}

export function contactRecoveryPreview(entry) {
  return entry.changes.map(({ field, before, after }) => ({
    label: fieldLabels[field], current: after ?? null, restore: before ?? null
  }));
}

export function recoveryReasonOptions(action) {
  return Object.entries(contactRecoveryReasons).filter(([code]) =>
    action === '停用资料' ? code !== 'wrong_value' : code !== 'accidental_disable');
}
