import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupRechargeCodeOwner } from '../server/recharge-code-requests.mjs';
import { setup, call, actor, other } from './helpers/recharge-return-fixture.mjs';

test('资格、归属、已交付、历史任务和未知状态逐项显示，领用编号稳定', async () => {
  const f = setup(), handler = f.start();
  const rows = (await call(handler, null, actor, '?view=codes')).items;
  assert.deepEqual(rows.map(row => row.id), f.items);
  assert.deepEqual(rows.map(row => row.eligible), [true, true, false, false, false, false, false]);
  const request = (await call(handler)).requests[0];
  assert.equal(request.counts.returnable, 2); assert.equal(request.counts.used, 1);
  assert.equal((await call(handler, { action: 'return-preview', itemIds: [f.items[0]] }, other)).items[0].eligible, false);
  assert.equal((await call(handler, { action: 'return', itemIds: [f.items[0]] }, other)).status, 403);
  assert.equal((await call(handler, { action: 'return-preview', itemIds: [f.items[0], f.items[0]] })).status, 400);
  assert.equal(f.commands.length, 0);
});
test('部分归还保留申请数量和其他码；旧申请与列表不再返回已归还原码，历史归属保留', async () => {
  const f = setup(), handler = f.start();
  const result = await call(handler, { action: 'return', itemIds: f.items.slice(0, 2), note: '合成未用归还' });
  assert.equal(result.status, 200); assert(result.items.every(row => row.state === 'returned'));
  const request = (await call(handler)).requests[0];
  assert.equal(request.count, 7); assert.equal(request.status, 'issued'); assert.equal(request.counts.returned, 2);
  assert.equal(request.counts.returnable, 0); assert.equal(request.codes.length, 5);
  for (const code of f.codes.slice(0, 2)) {
    assert(!JSON.stringify(await call(handler)).includes(code));
    assert(!JSON.stringify(await call(handler, null, actor, '?view=codes')).includes(code));
    assert.equal(lookupRechargeCodeOwner(f.store.load().data, code).employeeId, actor.id);
    assert(!JSON.stringify(f.audit).includes(code));
  }
  assert.equal(f.store.load().data.retained, '保留独立资料');
  const count = f.commands.length;
  assert((await call(f.start(), { action: 'return', itemIds: [f.items[0]] })).items.every(row => row.state === 'returned'));
  assert.equal(f.commands.length, count, '重复提交不再撤销或重新发码');
});
test('确认前资格变化阻止整批，不静默只归还其中可用项', async () => {
  const f = setup();
  const result = await call(f.start(), { action: 'return', itemIds: [f.items[0], f.items[4]] });
  assert.equal(result.status, 409); assert.equal(result.items.length, 2);
  assert.equal(f.commands.length, 0); assert.equal(f.store.load().data.requests[0].returns, undefined);
});
test('逐项并发变化如实返回部分成功与阻止原因，不取消其他任务', async () => {
  const f = setup(), original = f.transport.commitReturn;
  f.transport.commitReturn = async command => { const result = await original(command); f.blocked.set(f.codes[1], '充值码已使用或正在受理'); return result; };
  const result = await call(f.start(), { action: 'return', itemIds: f.items.slice(0, 2) });
  assert.deepEqual(result.items.map(row => row.state), ['returned', 'blocked']);
  assert.equal(f.commands.length, 1); assert.match(result.items[1].reason, /正在受理/);
});
test('上游已失效但响应丢失时回读原回执；不得把超时当失败后重发', async () => {
  const f = setup(), original = f.transport.commitReturn;
  f.transport.commitReturn = async command => { await original(command); throw new Error('lost_response'); };
  const result = await call(f.start(), { action: 'return', itemIds: [f.items[0]] });
  assert.equal(result.items[0].state, 'returned'); assert.equal(f.commands.length, 1);
});
test('原码失效后本地落账失败保留 pending，重启后同操作回读完成', async () => {
  const f = setup(); f.failNextSave();
  const result = await call(f.start(), { action: 'return', itemIds: [f.items[0]], note: '原始备注' });
  assert.equal(result.items[0].state, 'pending');
  assert.equal((await call(f.start())).requests[0].counts.pendingReturns, 1);
  assert(!(await call(f.start())).requests[0].codes.includes(f.codes[0]));
  const retried = await call(f.start(), { action: 'return-reconcile', itemIds: [f.items[0]], note: '不会覆盖原备注' });
  assert.equal(retried.items[0].state, 'returned'); assert.equal(retried.items[0].note, '原始备注'); assert.equal(f.commands.length, 1);
});
test('外部未受理就断线可按原操作显式核对并继续，不复活或重新分配原码', async () => {
  const f = setup(), original = f.transport.commitReturn;
  f.transport.commitReturn = async () => { throw new Error('not_accepted'); };
  const result = await call(f.start(), { action: 'return', itemIds: [f.items[0]] });
  assert.equal(result.items[0].state, 'pending');
  const operation = f.store.load().data.requests[0].returns[0].id;
  f.transport.commitReturn = original;
  const retried = await call(f.start(), { action: 'return-reconcile', itemIds: [f.items[0]] });
  assert.equal(retried.items[0].state, 'returned'); assert.equal(f.commands[0].operationId, operation);
});
test('无效资格回读和错误操作回执均不计成功，未知状态禁止归还', async () => {
  const f = setup(); f.transport.checkReturns = async () => [];
  assert.equal((await call(f.start(), { action: 'return', itemIds: [f.items[0]] })).status, 409);
  const g = setup(); g.transport.commitReturn = async () => ({ state: 'returned', operationId: 'wrong', returnedAt: '2026-11-08T01:00:00Z' });
  assert.equal((await call(g.start(), { action: 'return', itemIds: [g.items[0]] })).items[0].state, 'pending');
});
