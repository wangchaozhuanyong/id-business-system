import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditInventoryLinkage } from '../server/inventory-reconcile.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const asOf = '2026-11-13T06:00:00.000Z';
const clock = Date.parse(asOf);
const cli = fileURLToPath(new URL('../server/inventory-reconcile-cli.mjs', import.meta.url));
const email = id => id + '@example.test';
const mail = (id, changes = {}) => ({ id, email: email(id), type: 'google',
  inventoryState: 'available', status: '正常', health: 'normal', usageLinks: [], country: '马来西亚',
  password: 'test-mailbox-secret', ...changes });
const account = (id, mailbox, changes = {}) => ({ id, email: email(mailbox), type: 'gpt',
  emailType: 'google', country: '马来西亚', acquisitionMethod: 'self_registered', registered: '2026-10-01T00:00:00Z',
  password: 'test-account-secret', ...changes });
const docs = (mailboxes = [], accounts = [], orders = [], additions = {}) => ({
  inventory: { version: 7, data: { mailboxes, accounts, batches: [], registrationRecords: [], ...additions } },
  commerce: { version: 9, data: { orders } }
});

test('历史库存报告复用业务依据，模拟补关联并验证幂等，原资料保持完整', () => {
  const imported = { type: 'claude', source: '历史入库', status: '冻结', health: 'normal', importId: 'batch-old',
    claudeHistory: { phase: 'aging' }, inventoryHistory: [{ action: 'Claude 历史入库' }] };
  const existing = { kind: 'registration', accountId: 'legacy-account', product: 'gpt' };
  const input = docs([
    mail('unique'), mail('collision'), mail('legacy', { inventoryState: 'used', usageLinks: [existing] }),
    mail('orphan', { inventoryState: 'used', usageLinks: [{ ...existing, accountId: 'absent-account' }] }),
    mail('wrong-mailbox'), mail('purchased'), mail('customer-owned'), mail('safe-id:1'),
    mail('deleted', { deleted: true })
  ], [
    account('unique-account', 'unique', { email: ' UNIQUE@example.test ' }),
    account('collision-a', 'collision'), account('collision-b', 'collision', { type: 'claude' }),
    account('legacy-account', 'legacy'),
    account('wrong-source-account', 'different', { sourceMailboxId: 'wrong-mailbox' }),
    account('purchased-account', 'purchased', { acquisitionMethod: 'purchased' }),
    account('owned-account', 'customer-owned', { source: '客户提供' }),
    account('freeze-default', 'external-aging', imported),
    account('actually-frozen', 'external-frozen', { ...imported,
      inventoryHistory: [...imported.inventoryHistory, { action: '修改资料' }] })
  ]);

  const before = structuredClone(input);
  const report = auditInventoryLinkage(input, { clock });
  assert.deepEqual(input, before);
  assert.deepEqual(report.versions, { inventory: 7, commerce: 9 });
  assert.deepEqual(report.sourceCounts, { mailboxes: 8, accounts: 9, batches: 0, orders: 0 });
  assert.deepEqual(report.counts, { eligible: 1, review: 1, oneSided: 1, inconsistent: 2, legacyFreeze: 1 });
  assert.deepEqual(report.eligible.map(row => [row.assetId, row.accountId, row.kind]),
    [['unique', 'unique-account', 'registration']]);
  assert.deepEqual(report.review.map(row => [row.assetId, row.reason]), [['collision', 'conflicting-registration']]);
  assert.deepEqual(report.oneSided[0].mailboxIds, ['legacy']);
  assert.deepEqual(report.inconsistent.map(row => row.reason), ['invalid-recorded-source', 'missing-registration-account']);
  assert.deepEqual(report.legacyFreeze.map(row => row.assetId), ['freeze-default']);
  assert.deepEqual(report.simulation, { changed: true, changedOnRepeat: false,
    remaining: { eligible: 0, review: 1, oneSided: 1, inconsistent: 2, legacyFreeze: 1 } });
  assert.doesNotMatch(JSON.stringify(report), /@example\.test|test-mailbox-secret|test-account-secret/);
});

test('已有领取关系按原批次、领取人及用途判断，确认记录可单独回放', () => {
  const claimed = (id, changes = {}) => mail(id, { inventoryState: 'claimed', claimId: 'claim-' + id,
    claimBatchId: 'batch-' + id, ...changes });
  const batch = (id, purpose) => ({ id: 'batch-' + id, kind: 'mail', actorId: 'operator', purpose,
    time: '2026-11-01T00:00:00Z',
    items: [{ id: 'claim-' + id, assetId: id, type: 'google', email: email(id), status: 'pending' }] });
  const input = docs([claimed('accepted'), claimed('other-actor'), claimed('other-purpose'), claimed('unmatched')],
    [
      account('confirmed', 'accepted', { sourceMailboxId: 'accepted', createdById: 'operator', registered: '2026-11-02T00:00:00Z' }),
      account('different-actor', 'other-actor', { createdById: 'someone-else', registered: '2026-11-02T00:00:00Z' }),
      account('different-purpose', 'other-purpose', { createdById: 'operator', registered: '2026-11-02T00:00:00Z' }),
      account('missing-claim', 'unmatched', { createdById: 'operator', registered: '2026-11-02T00:00:00Z' })
    ], [], { batches: [batch('accepted', '注册 GPT'), batch('other-actor', '注册 GPT'), batch('other-purpose', '注册 Claude')] });
  const before = structuredClone(input);
  const report = auditInventoryLinkage(input, { clock });
  assert.deepEqual(report.eligible.map(row => [row.assetId, row.batchId, row.claimId]),
    [['accepted', 'batch-accepted', 'claim-accepted']]);
  assert.deepEqual(report.review.map(row => row.reason), ['different-claim-actor', 'different-claim-purpose', 'invalid-claim']);
  assert.equal(report.simulation.changedOnRepeat, false);
  assert.equal(report.simulation.remaining.eligible, 0);
  assert.equal(report.simulation.remaining.review, 3);
  assert.deepEqual(input, before);
});

test('使用既有业务库快照时，报告区分已入账的关联和外部客户的同址订单', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const input = docs([mail('stock')], [account('stock-account', 'stock')], [], {
    tableSettings: [], returnRecords: [], importRecords: [], undo: []
  });
  store.saveBatch([{ domain: 'inventory', version: 0, action: 'inventory_import', data: input.inventory.data }]);
  store.saveBatch([{ domain: 'commerce', version: 0, data: {
    orders: [{ id: 'renewal-1', orderNo: 'ORD-1', product: 'GPT', businessType: '续费',
      email: email('stock'), source: '管理员手工', payment: '银行卡', plan: 'Plus', accountSource: '客户自有', start: '2026-11-01T00:00:00Z' }],
    customers: [], tenants: [], operating: [], rentBatches: [], logs: []
  }, action: '新增资料' }]);
  const inventory = store.load('inventory');
  const commerce = store.load('commerce');
  assert.equal(inventory.data.accounts[0].sourceMailboxId, 'stock');
  assert.deepEqual(auditInventoryLinkage({ inventory, commerce }, { clock }).counts,
    { eligible: 0, review: 0, oneSided: 0, inconsistent: 0, legacyFreeze: 0 });
  assert.deepEqual(store.load('inventory'), inventory);
  assert.deepEqual(store.load('commerce'), commerce);
});

test('编号重复和缺少入库依据的显式来源只报告，禁止错误地模拟为已使用', () => {
  const input = docs([mail('duplicated'), mail('duplicated'), mail('pointer-only', { inventoryState: 'used' })],
    [account('would-match', 'duplicated'), account('pointer-account', 'pointer-only', { sourceMailboxId: 'pointer-only' })]);
  const report = auditInventoryLinkage(input, { clock });
  assert.equal(report.counts.eligible, 0);
  assert.equal(report.counts.inconsistent, 2);
  assert.deepEqual(report.inconsistent.map(row => row.reason), ['duplicate-inventory-id', 'source-without-usage-evidence']);
  assert.equal(report.simulation.changed, false);
});

test('只读 CLI 标准输入输出，严格模式区分待处理与无效输入', () => {
  const run = (input, ...args) => spawnSync(process.execPath, [cli, '--as-of', asOf, ...args],
    { input, encoding: 'utf8' });
  const clear = run(JSON.stringify(docs()), '--strict');
  assert.equal(clear.status, 0);
  assert.equal(JSON.parse(clear.stdout).asOf, asOf);
  const eligible = run(JSON.stringify(docs([mail('eligible')], [account('eligible-account', 'eligible')])), '--strict');
  assert.equal(eligible.status, 2);
  assert.equal(JSON.parse(eligible.stdout).counts.eligible, 1);
  const invalid = run('{"secret":"must-not-leak"}', '--strict');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.doesNotMatch(invalid.stderr, /must-not-leak/);
});
