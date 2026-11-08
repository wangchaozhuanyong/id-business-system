import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRechargeCodeHandler } from '../../server/recharge-code-requests.mjs';
import { rechargeCodeItemId } from '../../server/recharge-code-returns.mjs';
export const actor = { id: 'a', name: '合成员工', role: 'employee', active: true };
export const other = { id: 'b', name: '另一员工', role: 'employee', active: true };
const origin = 'https://return.invalid';
export async function call(handler, body, user = actor, query = '') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.url = '/api/local/recharge-codes' + query; req.method = body ? 'POST' : 'GET';
  req.headers = { origin, 'content-type': 'application/json' };
  let status, result;
  await handler(req, { writeHead(s) { status = s; }, end(value) { result = JSON.parse(value); } }, user);
  return { status, ...result };
}
export function setup() {
  const id = '11111111-1111-4111-8111-111111111111';
  const codes = Array.from({ length: 7 }, (_, i) => 'KC-' + (i + 1).toString(16).padStart(28, '0').toUpperCase());
  let doc = { version: 1, data: { retained: '保留独立资料', requests: [{ id, status: 'issued', count: 7, plan: 'plus',
    codes, applicantId: actor.id, applicantName: actor.name, issuedAt: '2026-11-08T01:00:00Z' }] } };
  const native = new Map(codes.map(code => [code, { code, plan_type: 'plus', type: '自助', status: 'unused', shipped: false }]));
  const blocked = new Map([[codes[4], '存在历史充值任务，请管理员核对']]);
  native.get(codes[2]).status = 'used'; native.get(codes[3]).status = 'processing'; native.get(codes[5]).shipped = true; native.delete(codes[6]);
  const receipts = new Map(), audit = [], commands = [];
  let failSave = false;
  const store = {
    load: () => structuredClone(doc),
    save(version, data, entry) {
      if (failSave && entry.action === 'recharge_code_returned') { failSave = false; throw new Error('synthetic_save_failure'); }
      if (version !== doc.version) throw Object.assign(new Error('conflict'), { status: 409 });
      doc = { version: version + 1, data: structuredClone(data) }; audit.push(entry);
    }
  };
  const transport = {
    listCodes: async () => [...native.values()],
    checkReturns: async items => items.map(({ code, plan }) => {
      const receipt = [...receipts.values()].find(row => row.code === code);
      const row = native.get(code);
      const reason = blocked.get(code) || (!row ? '状态待核对' : row.status !== 'unused' ? '已使用或正在使用' : row.shipped ? '已交付' : '可归还');
      return { code, plan, ...(receipt ? receipt : { state: reason === '可归还' ? 'unused' : 'blocked', eligible: reason === '可归还', reason }) };
    }),
    returnReceipt: async ({ operationId }) => receipts.get(operationId) || { state: 'not-found' },
    async commitReturn(command) {
      commands.push(command);
      assert(store.load().data.requests[0].returns.some(row => row.id === command.operationId && row.state === 'pending'), '必须先记录可恢复意图');
      const receipt = { state: 'returned', eligible: false, operationId: command.operationId, code: command.code,
        returnedAt: '2026-11-08T02:00:00Z' };
      receipts.set(command.operationId, receipt); native.delete(command.code); return receipt;
    }
  };
  return { store, transport, native, blocked, receipts, audit, commands, codes, id,
    items: codes.map(code => rechargeCodeItemId(id, code)), failNextSave: () => { failSave = true; },
    start: () => createRechargeCodeHandler({ store, transport, publicOrigin: origin }) };
}
