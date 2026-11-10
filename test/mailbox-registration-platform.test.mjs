import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { prepareMailboxPlatformMarks } from '../server/mailbox-registration-platform.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { attributeInventory } from '../server/inventory-attribution.mjs';
import { pendingRelayClaimIds } from '../server/relay-claim-integrity.mjs';
import { checkRelayInventory } from '../server/local-business-integrity.mjs';

const source = await readFile(new URL('../frontend/inventory-prototype.js', import.meta.url), 'utf8');
const actor = { id: 'test-admin', name: '测试管理员', role: 'admin' };
const now = new Date('2026-11-10T10:00:00Z');
const row = (type = 'relay') => ({
  id: 'mail-1', type, email: 'fixture@example.test', inventoryState: 'used', used: true, version: 1,
  health: 'dead', actualUsedAt: '2026-10-01 12:00', claimId: 'claim-1', claimBatchId: 'batch-1',
  ...(type === 'relay' ? { parentMailboxId: 'parent-1' } : {}),
  usageLinks: [{ kind: 'manual-use', label: '历史使用', time: '2026-10-01 12:00' }], inventoryHistory: []
});
const doc = mailbox => ({ mailboxes: [mailbox], accounts: [], batches: [], registrationRecords: [], returnRecords: [], importRecords: [],
  appleRelay: { parents: [{ id: 'parent-1', email: 'parent@example.test', status: 'ACTIVE' }], events: [], imports: [] } });
function addMark(previous, product = 'claude') {
  const next = structuredClone(previous), asset = next.mailboxes[0];
  asset.usageLinks.push({ kind: 'registration', product, label: '客户端文案', time: '1900-01-01' });
  asset.inventoryHistory.push({ id: 'event-1', action: '标记注册平台', detail: product });
  asset.version++;
  return next;
}
function presentation(data) {
  const api = { collections: data, modules: {}, state: { drafts: new Map(), actor } };
  const instrumented = source.replace('  api.modules.inventory = {',
    '  window.fixtureRecords = registrationRecords;\n  api.modules.inventory = {');
  const window = { IDDesignAPI: api, IDDesignModules: [] };
  runInNewContext(instrumented, { window, document: { querySelector: () => null }, Map, Set });
  window.fixtureRecords.push(...data.registrationRecords);
  return api.modules.inventory.mailboxPlatformLabel;
}

test('从明确注册记录与关联账号识别平台，付款和相同邮箱不冒充注册依据', () => {
  const data = doc(row());
  data.accounts.push({ id: 'gpt-1', type: 'gpt', email: data.mailboxes[0].email });
  const label = presentation(data), asset = data.mailboxes[0];
  assert.equal(label(asset), '平台未登记');
  asset.usageLinks.push({ kind: 'order-use', product: 'gpt', accountId: 'gpt-1' });
  assert.equal(label(asset), '平台未登记');
  asset.usageLinks.push({ kind: 'registration', accountId: 'gpt-1' });
  assert.equal(label(asset), 'ChatGPT');
  asset.usageLinks.push({ kind: 'manual-use', product: 'claude' }, { kind: 'registration', product: 'ChatGPT' });
  assert.equal(label(asset), 'ChatGPT、Claude');
});

test('历史成功记录映射 ChatGPT／Codex，失败和待核对不显示成已注册', () => {
  const data = doc(row());
  data.registrationRecords = [
    { assetId: 'mail-1', state: '成功', product: 'GPT' },
    { assetId: 'mail-1', state: '成功', product: 'Codex' },
    { assetId: 'mail-1', state: '成功', product: 'Claude' },
    { assetId: 'mail-1', state: '待核对', product: 'Gemini' },
    { assetId: 'other', state: '成功', product: 'Grok' }
  ];
  assert.equal(presentation(data)(data.mailboxes[0]), 'ChatGPT、Claude');
  assert.equal(presentation(doc(row()))({ ...row(), inventoryState: 'available' }), '未登记');
});

for (const type of ['google', 'relay', 'microsoft']) test(`${type} 历史已使用邮箱可追加平台，保留使用时间、原历史和真实操作人`, () => {
  const previous = doc(row(type)), next = addMark(previous);
  assert.equal(checkRelayInventory(next), undefined);
  assert.deepEqual(pendingRelayClaimIds(previous, next, { action: 'inventory_registration_result', actor }), []);
  assert.equal(prepareMailboxPlatformMarks(previous, next, 'inventory_registration_result', actor, now), undefined);
  assert.equal(attributeInventory(previous, next, actor, 'inventory_registration_result'), undefined);
  assert.equal(checkInventoryHistory(previous, next), undefined);
  assert.equal(next.mailboxes[0].actualUsedAt, previous.mailboxes[0].actualUsedAt);
  assert.deepEqual(next.mailboxes[0].usageLinks[0], previous.mailboxes[0].usageLinks[0]);
  assert.equal(next.mailboxes[0].usageLinks[1].label, '人工登记 · 已注册 Claude');
  assert.equal(next.mailboxes[0].usageLinks[1].time, '2026-11-10 18:00');
  assert.equal(next.mailboxes[0].lastOperatedById, actor.id);
  assert.equal(next.mailboxes[0].inventoryHistory[0].actorId, actor.id);
  assert.equal(presentation(next)(next.mailboxes[0]), 'Claude');
});

test('拒绝未知平台、重复平台、错误入口和更改使用时间；保存旧记录无需重写', () => {
  const previous = doc(row());
  assert.match(prepareMailboxPlatformMarks(previous, addMark(previous, 'unknown'), 'inventory_registration_result', actor), /有效/);
  assert.match(prepareMailboxPlatformMarks(previous, addMark(previous), 'inventory_edit', actor), /入口/);
  const altered = addMark(previous); altered.mailboxes[0].actualUsedAt = '2026-11-10';
  assert.match(prepareMailboxPlatformMarks(previous, altered, 'inventory_registration_result', actor), /原使用时间/);
  previous.registrationRecords.push({ assetId: 'mail-1', state: '成功', product: 'CLAUDE' });
  assert.match(prepareMailboxPlatformMarks(previous, addMark(previous), 'inventory_registration_result', actor), /重复/);
  previous.registrationRecords = [];
  const twice = addMark(previous); twice.mailboxes[0].usageLinks.push({ kind: 'registration', product: 'claude' });
  assert.match(prepareMailboxPlatformMarks(previous, twice, 'inventory_registration_result', actor), /重复/);
  assert.equal(prepareMailboxPlatformMarks(previous, structuredClone(previous), 'inventory_edit', actor), undefined);
});

test('不能用平台补录绕过领取、消费库存或修改账号记录', () => {
  for (const state of ['available', 'claimed']) {
    const previous = doc({ ...row(), inventoryState: state });
    const next = addMark(previous); next.mailboxes[0].inventoryState = 'used';
    assert.match(prepareMailboxPlatformMarks(previous, next, 'inventory_registration_result', actor), /已使用邮箱/);
  }
  const previous = doc(row('gpt'));
  assert.match(prepareMailboxPlatformMarks(previous, addMark(previous), 'inventory_registration_result', actor), /已使用邮箱/);
});
