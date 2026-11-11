import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeCodeReturns, migrateRechargeCodeReturns } from '../modules/recharge/codexdaichong/native-code-returns.mjs';
const code = 'KC-' + 'A'.repeat(28), plan = 'plus', operationId = 'return_' + 'a'.repeat(32);
function fixture(patch = {}, code = 'KC-' + 'A'.repeat(28)) {
  let state = { code: { cdk_code: code, plan_type: plan, type: '自助', is_active: 1, used_at: null,
    shipped_at: null, fail_count: 0, cooldown_until: null, ...patch }, receipts: [], task: false, hold: false };
  let failInsert = false;
  const connection = {
    async query(sql, values) {
      if (sql.includes('FROM cdk_codes')) { assert.match(sql, /FOR UPDATE/); assert.deepEqual(values, [code]); return [[structuredClone(state.code)]]; }
      if (sql.includes('FROM id_recharge_code_returns')) return [structuredClone(state.receipts.filter(row =>
        row.cdk_code === values[0] || row.operation_id === values[1] || (values.length === 1 && row.operation_id === values[0])))];
      if (sql.includes('FROM task_logs')) return [state.task ? [{ 1: 1 }] : []];
      if (sql.includes('FROM activation_manual_holds')) return [state.hold ? [{ 1: 1 }] : []];
      throw new Error('unexpected_query');
    },
    async execute(sql, values) {
      if (sql.startsWith('UPDATE cdk_codes')) {
        assert.deepEqual(values, [code, plan]); assert.match(sql, /used_at IS NULL AND shipped_at IS NULL/);
        const affectedRows = state.code.is_active === 1 && !state.code.used_at ? 1 : 0;
        if (affectedRows) state.code.is_active = 0; return [{ affectedRows }];
      }
      if (sql.startsWith('INSERT INTO id_recharge_code_returns')) {
        if (failInsert) throw new Error('synthetic_receipt_failure');
        state.receipts.push({ operation_id: values[0], cdk_code: values[1], plan_type: values[2], returned_at: '2026-11-08T02:00:00Z' }); return [{ affectedRows: 1 }];
      }
      throw new Error('unexpected_execute');
    }
  };
  const store = {
    runQuery: async (sql, values) => (await connection.query(sql, values))[0],
    async withTransaction(callback) { const before = structuredClone(state); try { return await callback(connection); } catch (error) { state = before; throw error; } }
  };
  return { service: createNativeCodeReturns({ store }), state: () => state, insertFailure: () => { failInsert = true; } };
}
test('原子失效和回执同事务完成，重复操作回读原结果且不恢复原码', async () => {
  const f = fixture(), command = { code, plan, operationId };
  assert((await f.service.check(command)).eligible); assert.equal(f.state().code.is_active, 1);
  const result = await f.service.commit(command); assert.equal(result.state, 'returned');
  assert.equal(f.state().code.is_active, 0); assert.equal(f.state().receipts.length, 1);
  assert.deepEqual(await f.service.commit(command), result); assert.deepEqual(await f.service.receipt(command), result);
  assert.equal(f.state().receipts.length, 1);
  assert.equal((await f.service.commit({ ...command, operationId: operationId + '_other' })).state, 'conflict');
});
test('已用、已交付、停用、冷却、历史任务和人工待核对均禁止归还', async () => {
  for (const patch of [{ used_at: '2026-11-08' }, { shipped_at: '2026-11-08' }, { is_active: 0 }, { fail_count: 1 }, { cooldown_until: '2026-11-09' }]) {
    const f = fixture(patch); assert(!(await f.service.commit({ code, plan, operationId })).eligible); assert.equal(f.state().receipts.length, 0);
  }
  for (const key of ['task', 'hold']) {
    const f = fixture(); f.state()[key] = true;
    assert.equal((await f.service.commit({ code, plan, operationId })).state, 'blocked'); assert.equal(f.state().code.is_active, 1);
  }
});
test('回执插入失败回滚原码，错误操作编号和套餐不能误计成功', async () => {
  const f = fixture(); f.insertFailure();
  await assert.rejects(f.service.commit({ code, plan, operationId })); assert.equal(f.state().code.is_active, 1); assert.equal(f.state().receipts.length, 0);
  const g = fixture(); assert.equal((await g.service.commit({ code, plan: 'pro100', operationId })).state, 'blocked');
  assert.equal((await g.service.receipt({ code, plan, operationId })).state, 'not-found');
});
test('新增迁移仅建回执表，以唯一原码和外键阻止删除后重放旧码', async () => {
  const sql = []; await migrateRechargeCodeReturns({ query: async statement => sql.push(statement) });
  assert.equal(sql.length, 1); assert.match(sql[0], /CREATE TABLE IF NOT EXISTS id_recharge_code_returns/);
  assert.match(sql[0], /UNIQUE KEY.*\(cdk_code\)/); assert.match(sql[0], /ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.doesNotMatch(sql[0], /\b(?:DROP|DELETE FROM|ALTER TABLE|TRUNCATE)\b/i);
});

async function httpResult(service, method, url, body) {
  let status = 200;
  return service.handle({ method, url, body }, {
    status(value) { status = value; return this; },
    json(data) { return { status, ...data }; }
  });
}

test('代充原生短码可通过既有归还接口核对和失效', async () => {
  const short = 'KC-' + 'Z'.repeat(15), f = fixture({}, short);
  const checked = await httpResult(f.service, 'POST', '/api/admin/cdks/returns/check', {
    items: [{ code: short, plan }]
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.items[0].eligible, true);
  const committed = await httpResult(f.service, 'POST', '/api/admin/cdks/returns/commit', {
    code: short, plan, operationId
  });
  assert.equal(committed.receipt.state, 'returned');
  assert.equal(f.state().code.is_active, 0);
});

test('库存读接口只返回原生格式可发放码，并按原表排除占用和历史记录', async () => {
  const short = 'KC-' + 'Z'.repeat(15), queries = [];
  const service = createNativeCodeReturns({ store: { async runQuery(sql) {
    queries.push(sql);
    return [{ code: short, plan }, { code, plan }, { code: short, plan: 'unsupported' }];
  } } });
  const result = await httpResult(service, 'GET', '/api/admin/cdks/returns/stock');
  assert.deepEqual(result, { status: 200, success: true, items: [{ code: short, plan }] });
  assert.equal(queries.length, 1);
  const [sql] = queries;
  assert.match(sql, /c.is_active = 1.*c.used_at IS NULL.*c.shipped_at IS NULL/);
  assert.match(sql, /fail_count.*cooldown_until IS NULL/);
  for (const table of ['id_recharge_code_returns', 'task_logs', 'activation_manual_holds'])
    assert.ok(sql.includes('NOT EXISTS (SELECT 1 FROM ' + table));
});
