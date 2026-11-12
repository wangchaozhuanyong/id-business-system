import assert from 'node:assert/strict';
import test from 'node:test';
import { appleFundingEligibility, appleFundingIndex } from '../frontend/apple-funding.mjs';
import { checkAppleLedger } from '../server/local-business-integrity.mjs';

const wallet = { id: 'synthetic-apple', balance: '250.00', currency: 'USD', status: '正常',
  health: 'normal', country: '马来西亚', appStoreRegion: 'US' };
const order = { id: '', customerId: '', email: 'synthetic@example.test', product: 'Claude Max',
  plan: 'Max 20x', businessType: '成品交付', appleStoreRegion: 'US', paidAmount: '' };
const settings = { applePaidPrices: { 'Claude Max': { 'Max 20x': { US: '250' } } } };
const eligible = (asset = wallet, draft = order, index = appleFundingIndex([]), options = { forSelection: true }) =>
  appleFundingEligibility(asset, draft, index, settings, options);

test('250 美元余额可选择 250 美元套餐，注册地区不参与内购匹配', () => {
  const result = eligible();
  assert.equal(result.error, undefined);
  assert.equal(result.amount, 2500000n);
  assert.equal(result.balance, result.amount);
  assert.equal(result.region, 'US');
});

test('可先选未使用 ID，但保存时客户和订阅账号仍须完整', () => {
  for (const draft of [order, { ...order, email: '' }]) {
    assert.equal(eligible(wallet, draft).error, undefined);
    assert.match(eligible(wallet, draft, appleFundingIndex([]), {}).error, /客户和订阅账号/);
  }
  assert.equal(eligible(wallet, { ...order, customerId: 'customer' }, appleFundingIndex([]), {}).error, undefined);
});

test('候选预览仍排除余额不足、地区不符、异常、已使用及占用的 ID', () => {
  for (const [changes, expected] of [[{ balance: '249.9999' }, /余额不足/],
    [{ appStoreRegion: 'MY' }, /Id地区/], [{ health: 'dead' }, /状态异常/], [{ currency: 'CNY' }, /美元余额/]])
    assert.match(eligible({ ...wallet, ...changes }).error, expected);
  const used = appleFundingIndex([], { movements: [{ appleIdId: wallet.id, orderId: 'prior', kind: 'order-charge', amount: '-1' }] });
  assert.match(eligible(wallet, order, used).error, /未使用/);
  const pending = appleFundingIndex([{ ...order, id: 'pending', appleIdId: wallet.id, payment: '苹果内购' }]);
  assert.match(eligible(wallet, order, pending).error, /占用/);
  assert.match(eligible(wallet, { ...order, businessType: '续费' }).error, /原订阅/);
});

const inventory = { mailboxes: [{ id: wallet.id, type: 'apple' }] };
const before = { wallets: [{ id: wallet.id, currency: 'USD', balance: '0', version: 1 }],
  allocations: [], refunds: [], movements: [] };
const topup = reason => ({ wallets: [{ ...before.wallets[0], balance: '250', version: 2 }],
  allocations: [], refunds: [], movements: [{ id: 'synthetic-topup', appleIdId: wallet.id, kind: 'topup',
    amount: '250', before: '0', after: '250', versionAfter: 2, orderId: '', ...(reason !== undefined && { reason }) }] });
const check = (next, previous = before) => checkAppleLedger(previous, next, inventory, { orders: [] });

test('充值到账依据允许缺省、空白或填写，不伪造依据', () => {
  for (const reason of [undefined, '', '   ', '合成备注']) {
    const next = topup(reason), original = structuredClone(next);
    assert.equal(check(next), undefined);
    assert.deepEqual(next, original);
  }
});

test('选填到账依据不放宽充值金额、版本及历史流水检查', () => {
  for (const changes of [{ amount: '0' }, { amount: '-250' }, { versionAfter: 1 }, { after: '251' }]) {
    const next = topup('');
    Object.assign(next.movements[0], changes);
    assert.ok(check(next));
  }
  const saved = topup('');
  assert.match(check(before, saved), /原有苹果 ID 余额流水必须保留/);
  const changed = structuredClone(saved);
  changed.movements[0].reason = '改写旧流水';
  assert.match(check(changed, saved), /不能改写/);
});
