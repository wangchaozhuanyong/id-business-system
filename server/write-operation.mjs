import { createHash } from 'node:crypto';

export class WriteOperationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const digest = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Receipts use the existing encrypted document store and commit with the write.
// No credentials, request bodies or business records are copied into a receipt.
export function describeWriteOperation(id, actor, entries) {
  if (id === undefined) return null; // Existing clients remain compatible.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,120}$/.test(id))
    throw new WriteOperationError(400, '保存操作编号无效，请重新打开页面');
  const identity = actor?.id || 'local-operator';
  return {
    domain: 'write-receipt:' + digest(identity + '\0' + id),
    fingerprint: digest(JSON.stringify(canonical(entries)))
  };
}

export function checkWriteReceipt(receipt, operation) {
  if (!receipt) return null;
  if (receipt.fingerprint !== operation.fingerprint)
    throw new WriteOperationError(409, '同一保存操作的内容已变化，请核对原操作结果');
  return receipt.domains;
}
