import { isDeepStrictEqual } from 'node:util';
import { WriteOperationError } from './write-operation.mjs';
import { duplicateCustomerContact, normalizeCustomerNumbers } from '../modules/orders/order-customer-match.mjs';

const fail = message => { throw new WriteOperationError(409, message); };
export function checkCustomerContactDuplicate(rows, after, before) {
  if (duplicateCustomerContact(rows, after, before)) fail('相同姓名和联系方式的客户已存在，请核对原客户');
}

export function prepareCustomerContactWrites(rows, previous) {
  const byId = new Map((previous || []).map(row => [row.id, row]));
  for (const row of rows) {
    const before = byId.get(row.id);
    if (before && ['name', 'phone', 'whatsapp', 'wechat', 'qq', 'telegram'].every(key => before[key] === row[key])) continue;
    checkCustomerContactDuplicate(rows, row, before);
    const { numbers, error } = normalizeCustomerNumbers(row, before);
    if (error) throw new WriteOperationError(400, error.message);
    Object.assign(row, numbers);
  }
}

// Only an ordinary single contact edit may merge with unrelated changes.
// Stock, orders, balances, ownership transfers and batch writes keep strict CAS.
export function mergeContactWrite(write, current) {
  const change = write.recordChange;
  if (!change) return write;
  if (write.domain !== 'commerce' || !['新增资料', '修改资料'].includes(write.action) ||
      !['customers', 'tenants'].includes(change.list) || !change.after?.id ||
      !change.log?.id || change.log.entityId !== change.after.id || change.log.type !== write.action ||
      Object.hasOwn(change.after, 'initialCards')) fail('资料变更范围无效，请重新核对');
  const before = change.before ?? null, after = change.after;
  if (before ? write.action !== '修改资料' || before.id !== after.id || after.version !== before.version + 1
    : write.action !== '新增资料' || after.version !== 1) fail('资料版本无效，请重新核对');
  const data = structuredClone(current.data || { ...write.data, customers: [], tenants: [], orders: [],
    operating: [], rentBatches: [], logs: [] });
  const rows = data[change.list];
  if (!Array.isArray(rows) || !Array.isArray(data.logs)) fail('资料结构已变化，请重新核对');
  const latest = rows.find(row => row.id === after.id) ?? null;
  if (!isDeepStrictEqual(before, latest)) fail('这条资料已被其他操作更新，本次未保存，输入已保留，请重新核对');
  if (data.logs.some(row => row.id === change.log.id)) fail('操作记录已存在，请核对原保存结果');
  if (change.list === 'customers') checkCustomerContactDuplicate(rows, after, before);
  const saved = structuredClone(after);
  if (before) rows[rows.findIndex(row => row.id === after.id)] = saved;
  else rows.unshift(saved);
  data.logs.unshift(structuredClone(change.log));
  if (current.version === write.version && !isDeepStrictEqual(data, write.data))
    fail('普通资料保存包含其他业务改动，请重新核对');
  return { ...write, version: current.version, data };
}
