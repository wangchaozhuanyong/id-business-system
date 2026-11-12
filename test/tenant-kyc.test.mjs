import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTenantKycRecovery, checkTenantKycWrite, tenantKycStatus } from '../server/tenant-kyc.mjs';
import { normalizeClaudeCertification } from '../server/order-policy.mjs';

const verifier = { id: 'verifier-a', name: '合成认证人甲', phone: '+60123456780', active: true };
const otherVerifier = { id: 'verifier-b', name: '合成认证人乙', phone: '+60123456781', active: true };
const deadAccount = { id: 'dead-claude', type: 'claude', email: 'dead-claude@example.test', health: 'dead',
  status: '冻结', inventoryState: 'used', used: true, version: 3 };
const inventory = { accounts: [deadAccount] };
const order = (values = {}) => ({ id: 'historic-order', product: 'Claude Max', plan: 'Max 20x',
  businessType: '成品交付', accountId: deadAccount.id, email: deadAccount.email,
  kyc: '未认证', verifier: '', verifierPhone: '', corrections: [], refunds: [], bankReturns: [],
  version: 2, ...values });
const certification = tenant => ({ kyc: 'KYC 认证', claudeVerifierId: tenant.id,
  verifier: tenant.name, verifierPhone: tenant.phone });
const commerce = orders => ({ orders, tenants: [verifier, otherVerifier] });
function correct(prior, changes = {}) {
  const { corrections, refunds, bankReturns, ...previous } = structuredClone(prior);
  return { ...structuredClone(prior), ...changes, version: prior.version + 1,
    corrections: [...corrections, { id: `correction-${prior.version}`, reason: '核对原始资料后修正录入错误',
      previous, versionAfter: prior.version + 1 }] };
}
const check = (prior, next, stock = inventory, action = '更正订单') =>
  checkTenantKycWrite(commerce([prior]), commerce([next]), stock, { requireVerifier: true, action });

test('死号原订单可补录历史 KYC，保留原快照与账号状态且不占用认证资格', () => {
  const prior = order();
  const next = correct(prior, certification(verifier));
  const originalStock = structuredClone(inventory);
  assert.equal(check(prior, next), undefined);
  assert.equal(next.corrections[0].previous.kyc, '未认证');
  assert.deepEqual(inventory, originalStock);
  assert.equal(tenantKycStatus(commerce([next]), inventory, verifier).status, 'available');
});

test('死号已认证资料可更正认证人和状态，原认证证据仍保留', () => {
  const prior = order(certification(verifier));
  const next = correct(prior, certification(otherVerifier));
  assert.equal(check(prior, next), undefined);
  const unverified = correct(next, { kyc: '未认证' });
  assert.equal(check(next, unverified), undefined);
  assert.equal(unverified.corrections[0].previous.claudeVerifierId, verifier.id);
  assert.equal(unverified.corrections[1].previous.claudeVerifierId, otherVerifier.id);
  for (const tenant of [verifier, otherVerifier])
    assert.equal(tenantKycStatus(commerce([unverified]), inventory, tenant).status, 'available');
});

test('死号历史资料允许补录已被其他正常账号使用的认证人，不改变该正常账号锁定', () => {
  const prior = order();
  const live = order({ id: 'live-order', accountId: '', email: 'live@example.test', ...certification(verifier) });
  const next = correct(prior, certification(verifier));
  assert.equal(checkTenantKycWrite(commerce([prior, live]), commerce([next, live]), inventory,
    { requireVerifier: true, action: '更正订单' }), undefined);
  assert.deepEqual(tenantKycStatus(commerce([next, live]), inventory, verifier),
    { status: 'locked', accounts: ['live@example.test'] });
});

test('未保留有效更正快照、原因、历史或版本的死号写入仍被拒绝', async t => {
  const base = order(certification(verifier));
  const prior = correct(base, { notes: '先前有效更正' });
  const changes = certification(otherVerifier);
  for (const [name, mutate, action] of [
    ['缺少更正', next => { next.corrections = prior.corrections; }],
    ['空原因', next => { next.corrections.at(-1).reason = ' '; }],
    ['伪造原资料', next => { next.corrections.at(-1).previous.verifier = '伪造'; }],
    ['缺少原资料字段', next => { delete next.corrections.at(-1).previous.email; }],
    ['移除原历史', next => { next.corrections.shift(); }],
    ['旧版本', next => { next.version = prior.version; }],
    ['不匹配的版本回执', next => { next.corrections.at(-1).versionAfter++; }],
    ['错误操作入口', () => {}, '新增独立订单']
  ]) await t.test(name, () => {
    const next = correct(prior, changes); mutate(next);
    assert.equal(typeof check(prior, next, inventory, action || '更正订单'), 'string');
  });
});

test('仅原死号可更正：正常、解封中、无法唯一定位及更换账号仍受原 KYC 约束', () => {
  const prior = order(certification(verifier));
  for (const health of ['normal', 'unlocking']) {
    const stock = { accounts: [{ ...deadAccount, health, status: '正常' }] };
    assert.match(check(prior, correct(prior, certification(otherVerifier)), stock), /已完成的 KYC/);
    assert.match(check(prior, correct(prior, { kyc: '未认证' }), stock), /已完成的 KYC/);
  }
  const legacy = order({ accountId: '', ...certification(verifier) });
  assert.equal(typeof check(legacy, correct(legacy, certification(otherVerifier)),
    { accounts: [deadAccount, { ...deadAccount, id: 'ambiguous-dead' }] }), 'string');
  assert.equal(typeof check(prior, correct(prior, { ...certification(otherVerifier),
    accountId: 'different-dead', email: 'other-dead@example.test' }),
    { accounts: [deadAccount, { ...deadAccount, id: 'different-dead', email: 'other-dead@example.test' }] }), 'string');
});

test('历史死号可按唯一邮箱匹配补录，新的死号认证及正常账号重复认证仍被拒绝', () => {
  const prior = order({ accountId: '' });
  assert.equal(check(prior, correct(prior, certification(verifier))), undefined);
  assert.equal(typeof checkTenantKycWrite(commerce([]), commerce([order(certification(verifier))]), inventory,
    { requireVerifier: true, action: '更正订单' }), 'string');
  const live = order({ accountId: '', email: 'live@example.test', ...certification(verifier) });
  const fresh = order({ id: 'new-order', accountId: '', email: 'new@example.test', ...certification(verifier) });
  assert.match(checkTenantKycWrite(commerce([live]), commerce([live, fresh]), inventory,
    { requireVerifier: true, action: '新增独立订单' }), /未标记死号/);
});

test('死号历史更正后恢复账号仍检查认证人占用，不因补录绕过恢复边界', () => {
  const prior = order();
  const corrected = correct(prior, certification(verifier));
  assert.equal(check(prior, corrected), undefined);
  const live = order({ id: 'live-order', accountId: '', email: 'live@example.test', ...certification(verifier) });
  const restored = { accounts: [{ ...deadAccount, health: 'normal', status: '正常' }] };
  assert.match(checkTenantKycRecovery(commerce([corrected, live]), inventory, restored), /不能恢复原死号/);
});

test('有效死号更正可重新选同一认证人修正旧姓名电话，服务端仍采用人员主档', () => {
  const prior = order({ ...certification(verifier), verifierPhone: '+60100000000' });
  const next = correct(prior, certification(verifier));
  assert.equal(normalizeClaudeCertification(next, prior, [verifier], { allowHistoricalCorrection: true }), undefined);
  assert.equal(next.verifierPhone, verifier.phone);
  const ordinary = correct(prior, certification(verifier));
  normalizeClaudeCertification(ordinary, prior, [verifier]);
  assert.equal(ordinary.verifierPhone, prior.verifierPhone);
});

test('死号资料补偿撤回保留更正与补偿记录，伪造补偿不得清除 KYC', () => {
  const prior = order();
  const saved = correct(prior, certification(verifier));
  const restored = { ...structuredClone(saved), ...saved.corrections.at(-1).previous,
    version: saved.version + 1, compensations: [{ id: 'compensation-one',
      correctionId: saved.corrections.at(-1).id, reason: '撤回本次录入更正',
      fromVersion: saved.version, toVersion: saved.version + 1 }] };
  assert.equal(check(saved, restored, inventory, '补偿撤回更正'), undefined);
  const forged = structuredClone(restored); forged.compensations[0].correctionId = 'unrelated';
  assert.equal(typeof check(saved, forged, inventory, '补偿撤回更正'), 'string');
  assert.equal(restored.corrections.length, 1);
});
