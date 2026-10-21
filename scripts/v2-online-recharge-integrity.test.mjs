import assert from 'node:assert/strict';
import test from 'node:test';
import { auditOnlineRechargeIntegrity } from './v2-online-recharge-integrity-audit.mjs';
import { V2_ONLINE_RECHARGE_INTEGRITY_CHECKS as definitions } from './lib/v2-online-recharge-integrity.mjs';

function fixture({ grants = 'SELECT, SHOW VIEW', identity = {}, count = '0', failAt = 0 } = {}) {
  const calls = [];
  let rules = 0;
  return {
    calls,
    async $connect() {},
    async $disconnect() {
      calls.push('disconnect');
    },
    async $queryRawUnsafe(sql) {
      assert.equal(sql, 'SHOW GRANTS');
      return [{ grants: `GRANT ${grants} ON \`fixture\`.* TO 'audit'@'localhost'` }];
    },
    async $executeRawUnsafe(sql) {
      calls.push(sql);
      assert.equal(sql, 'SET SESSION TRANSACTION READ ONLY');
    },
    async $transaction(fn, options) {
      assert.deepEqual(options, { isolationLevel: 'RepeatableRead', timeout: 120000 });
      return fn({
        async $queryRawUnsafe(sql) {
          if (sql.startsWith('SELECT DATABASE()'))
            return [
              {
                databaseName: 'fixture',
                isolationLevel: 'REPEATABLE-READ',
                readOnly: 1n,
                foreignKeys: 1n,
                ...identity
              }
            ];
          calls.push(sql);
          if (++rules === failAt) throw new Error('synthetic suppressed detail');
          return [{ count }];
        }
      });
    }
  };
}
test('完整执行独立代充规则，验证只读账户和一致性快照', async () => {
  const client = fixture();
  const result = await auditOnlineRechargeIntegrity(client, { expectedDatabase: 'fixture' });
  assert.equal(result.ok, true);
  assert.equal(result.checkCount, 11);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.equal(client.calls.filter((c) => c.startsWith('SELECT CAST(COUNT')).length, 11);
  assert.equal(client.calls.at(-1), 'disconnect');
});
test('写权限、目标错误、非只读和隔离级别异常均不能继续查询规则', async () => {
  for (const options of [
    { grants: 'SELECT, INSERT' },
    { identity: { databaseName: 'wrong' } },
    { identity: { readOnly: 0 } },
    { identity: { foreignKeys: 0 } },
    { identity: { isolationLevel: 'READ-COMMITTED' } }
  ]) {
    const client = fixture(options);
    await assert.rejects(auditOnlineRechargeIntegrity(client, { expectedDatabase: 'fixture' }));
    assert.equal(
      client.calls.some((c) => c.startsWith('SELECT CAST(COUNT')),
      false
    );
    assert.equal(client.calls.at(-1), 'disconnect');
  }
});
test('规则执行失败或无效计数必须报错，不能输出零异常结果', async () => {
  for (const options of [
    { failAt: 2 },
    { count: undefined },
    { count: 'NaN' },
    { count: '-1' },
    { count: '9007199254740992' }
  ]) {
    const client = fixture(
      options.count === undefined && !options.failAt ? { count: null } : options
    );
    await assert.rejects(auditOnlineRechargeIntegrity(client, { expectedDatabase: 'fixture' }));
    assert.equal(client.calls.at(-1), 'disconnect');
  }
});
test('待核对警告和硬性异常分别统计，均不能被报告为完整闭环', async () => {
  const result = await auditOnlineRechargeIntegrity(fixture({ count: '1' }), {
    expectedDatabase: 'fixture'
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCount, 8);
  assert.equal(result.warningCount, 3);
  assert.equal(new Set(definitions.map((c) => c.code)).size, 11);
});
