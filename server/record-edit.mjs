import { createHash } from 'node:crypto';
import { recordEditAllowed, recordEditVersion, recordFingerprintInput, validRecordEdit } from '../modules/data/record-edit.mjs';
import { toV2DateTimeInput } from '../modules/time/dateTime.ts';
import { WriteOperationError } from './write-operation.mjs';

export function mergeRecordEdit(domain, action, edit, { version, data }, actor, ledger, at = new Date()) {
  if (!validRecordEdit(domain, action, edit)) throw new WriteOperationError(400, '资料变更格式不正确');
  const rows = data?.[edit.collection];
  const matches = rows?.filter(row => row.id === edit.id) || [];
  const [prior] = matches;
  if (matches.length !== 1 || !recordEditAllowed(domain, prior) || recordEditVersion(domain, prior) !== edit.expectedVersion ||
      createHash('sha256').update(recordFingerprintInput(domain, prior)).digest('hex') !== edit.expectedFingerprint)
    throw new WriteOperationError(409, '这条资料已有更新，输入已保留，请重新核对后保存');
  if (Object.entries(edit.changes).every(([key, value]) => (prior[key] ?? '') === value))
    throw new WriteOperationError(409, '资料没有变化，请重新核对');
  const time = toV2DateTimeInput(at).replace('T', ' ');
  const attribution = { actorId: actor.id, actor: actor.name };
  const next = { ...prior, ...edit.changes, version: edit.expectedVersion + 1 };
  const candidate = { ...data, [edit.collection]: rows.toSpliced(rows.indexOf(prior), 1, next) };
  if (domain === 'commerce') {
    if (data.logs.some(row => row.id === edit.logId) || prior.corrections?.some(row => row.id === edit.eventId))
      throw new WriteOperationError(409, '记录已存在，请核对原保存结果');
    const { corrections = [], refunds, bankReturns, ...previous } = prior;
    const allocation = ledger?.allocations?.find(row => row.orderId === prior.id) || null;
    const wallet = ledger?.wallets?.find(row => row.appleIdId === prior.appleIdId || row.id === prior.appleIdId);
    next.corrections = [...corrections, { id: edit.eventId, ...attribution, at: time, reason: edit.reason,
      previous, versionAfter: next.version, appleLedgerAfter: allocation, appleWalletVersionAfter: wallet?.version || null }];
    Object.assign(next, { correctionReason: edit.reason, updatedBy: actor.name, updatedById: actor.id, updatedAt: time });
    candidate.logs = [{ id: edit.logId, type: action, entityId: prior.id, detail: `${prior.orderNo} · 修改备注 · 原因：${edit.reason}`,
      ...attribution, at: time }, ...data.logs];
  } else {
    const history = prior.inventoryHistory || [];
    if (history.some(row => row.id === edit.eventId)) throw new WriteOperationError(409, '记录已存在，请核对原保存结果');
    Object.assign(next, { inventoryHistory: [...history, { id: edit.eventId, action: '修改资料', detail: '普通资料已更新',
      ...attribution, time }], lastOperatedBy: actor.name, lastOperatedById: actor.id, lastOperatedAt: time });
    if (prior.type !== 'microsoft' || prior.microsoftSecurity) {
      const snapshot = Object.fromEntries(Object.keys(edit.changes).map(key => [key, prior[key] ?? null]));
      const undo = new Map(data.undo);
      undo.set(prior.id, { version: next.version, snapshot });
      candidate.undo = [...undo];
    }
  }
  return { domain, action, version, data: candidate };
}
