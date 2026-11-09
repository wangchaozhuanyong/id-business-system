import assert from 'node:assert/strict';
import test from 'node:test';
import { createRechargeCardTypeOverlay } from './card-type-overlay.mjs';

test('card types are keyed by the stable engine ID and retain the last verified snapshot on failure', async () => {
  const first = Promise.withResolvers();
  let reply = first.promise;
  let requests = 0;
  const overlay = createRechargeCardTypeOverlay({
    fetchSettings: () => { requests++; return reply; },
    onChange() {}
  });
  const assigned = overlay.cardKey(1);
  const unassigned = overlay.cardKey('2');
  const legacy = overlay.cardKey('3');
  assert.equal(assigned, 'recharge:1');
  assert.equal(overlay.cardKey('1"><img>'), '');
  assert.equal(overlay.cardKey(Number.MAX_SAFE_INTEGER + 1), '');
  const pending = overlay.refresh();
  assert.equal(overlay.refresh(), pending);
  assert.equal(overlay.label(assigned), '加载中…');
  assert.match(overlay.status, /正在读取/);
  first.resolve({
    version: 1,
    items: [{ id: 'fixture', name: '<b>演示</b>', active: true },
      { id: 'legacy', name: '历史类型', active: false }],
    assignments: { 'recharge:1': 'fixture', 'recharge:3': 'legacy', 'other:2': 'fixture' }
  });
  await pending;
  assert.equal(requests, 1);
  assert.equal(overlay.label(assigned), '<b>演示</b>');
  assert.equal(overlay.label(unassigned), '未设置');
  assert.equal(overlay.label(legacy), '历史类型');
  assert.equal(overlay.status, '');
  reply = Promise.resolve({ version: 2, items: [] });
  await overlay.refresh();
  assert.equal(overlay.failed, true);
  assert.match(overlay.status, /保留上次结果/);
  assert.equal(overlay.label(assigned), '<b>演示</b>');
  reply = Promise.resolve({ version: 3, items: [], assignments: {} });
  await overlay.refresh();
  assert.equal(overlay.failed, false);
  assert.equal(overlay.label(assigned), '未设置');
});

test('an unsuccessful first lookup does not claim the card has no assignment', async () => {
  const overlay = createRechargeCardTypeOverlay({
    fetchSettings: async () => { throw new Error('synthetic'); },
    onChange() {}
  });
  await overlay.refresh();
  assert.equal(overlay.label(overlay.cardKey(1)), '读取失败');
  assert.equal(overlay.status, '银行卡类型读取失败。');
});

test('a change during a pending lookup is coalesced into one follow-up read', async () => {
  const first = Promise.withResolvers();
  const response = (version, name) => ({
    version, items: [{ id: 'fixture', name, active: true }],
    assignments: { 'recharge:1': 'fixture' }
  });
  let reads = 0;
  const overlay = createRechargeCardTypeOverlay({
    fetchSettings: () => ++reads === 1 ? first.promise : response(2, '已同步'),
    onChange() {}
  });
  void overlay.refresh();
  const queued = overlay.invalidate();
  assert.equal(overlay.invalidate(), queued);
  first.resolve(response(1, '旧类型'));
  await queued;
  assert.equal(reads, 2);
  assert.equal(overlay.label('recharge:1'), '已同步');
});
