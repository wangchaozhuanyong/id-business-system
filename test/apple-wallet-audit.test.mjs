import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAppleWallets } from '../server/finance/apple-wallet-audit.mjs';

const walletId = 'apple-id-1';
const orderId = 'order-1';
const refundId = 'refund-1';
const movement = (id, kind, amount, before, after, versionAfter, extra = {}) =>
  ({ id, appleIdId: walletId, kind, amount, before, after, versionAfter, ...extra });

function fixture() {
  return {
    inventory: { mailboxes: [{ id: walletId, type: 'apple', email: 'private@example.test', password: 'private-material' }] },
    commerce: { orders: [{ id: orderId, appleIdId: walletId, payment: '苹果内购', paidAmount: '20.0001',
      paidCurrency: 'USD', paidConfirmed: false, refunds: [
        { id: refundId, payment: '苹果内购' },
        { id: 'refund-pending', payment: '苹果内购' }
      ] }] },
    appleBalance: {
      wallets: [{ id: walletId, currency: 'USD', balance: '34.1999', version: 6 }],
      allocations: [{ orderId, appleIdId: walletId, amount: '20.0001', returned: '4.2' }],
      refunds: [
        { id: refundId, orderId, appleIdId: walletId, amount: '4.2', status: 'received' },
        { id: 'refund-pending', orderId, appleIdId: walletId, amount: '1.01', status: 'pending' }
      ],
      movements: [
        movement('open-1', 'opening', '50', '0', '50', 2, { reason: 'private-opening-reference' }),
        movement('charge-1', 'order-charge', '-20.0001', '50', '29.9999', 3, { orderId }),
        movement('topup-1', 'topup', '5', '29.9999', '34.9999', 4, { undoneBy: 'undo-1' }),
        movement('undo-1', 'manual-undo', '-5', '34.9999', '29.9999', 5, { originalEntryId: 'topup-1' }),
        movement('received-1', 'apple-refund', '4.2', '29.9999', '34.1999', 6, { orderId, refundId })
      ]
    }
  };
}

test('Apple 钱包余额、原单扣款、待回款与到账分别核对', () => {
  const input = fixture();
  const before = structuredClone(input);
  const report = auditAppleWallets(input);
  assert.deepEqual(report.counts, { wallets: 1, orders: 1, issueCount: 0 });
  assert.equal(report.wallets[0].movementBalance, '34.1999');
  assert.equal(report.wallets[0].movementVersion, 6);
  assert.equal(report.orders[0].movementDebit, '20.0001');
  assert.equal(report.orders[0].debitEvidence, 'posted');
  assert.equal(report.orders[0].walletChainVerified, true);
  assert.equal(report.orders[0].pending, '1.0100');
  assert.equal(report.orders[0].received, '4.2000');
  assert.deepEqual(report.orders[0].movementIds, ['charge-1', 'received-1']);
  assert.deepEqual(input, before);
  assert.doesNotMatch(JSON.stringify(report), /private@example\.test|private-material|private-opening-reference/);
});

test('历史扣款分配缺失时分开报告已扣、已冲正和没有流水记录', () => {
  const input = fixture();
  input.appleBalance.allocations = [];
  const posted = auditAppleWallets(input);
  assert.equal(posted.orders[0].allocated, null);
  assert.equal(posted.orders[0].debitEvidence, 'posted');
  assert.ok(posted.orders[0].issues.includes('posted_debit_without_allocation'));
  assert.ok(posted.orders[0].issues.includes('allocation_missing_or_ambiguous'));

  input.appleBalance.refunds = [];
  input.commerce.orders[0].refunds = [];
  input.appleBalance.movements.splice(2, 3, movement('reversal-1', 'order-reversal', '20.0001',
    '29.9999', '50', 4, { orderId }));
  Object.assign(input.appleBalance.wallets[0], { balance: '50', version: 4 });
  const reversed = auditAppleWallets(input);
  assert.equal(reversed.orders[0].debitEvidence, 'reversed');
  assert.equal(reversed.orders[0].movementDebit, '0.0000');
  assert.equal(reversed.orders[0].walletChainVerified, true);

  input.appleBalance.movements.splice(1);
  input.appleBalance.wallets[0].version = 2;
  assert.equal(auditAppleWallets(input).orders[0].debitEvidence, 'none');
  delete input.appleBalance.movements;
  const partial = auditAppleWallets(input);
  assert.equal(partial.orders[0].debitEvidence, 'unknown');
  assert.equal(partial.orders[0].movementDebit, null);
  assert.equal(partial.wallets[0].movementBalance, null);
});

test('重复证据和错链分别列出，重复流水无法进入余额或已到账金额', () => {
  const input = fixture();
  const charge = input.appleBalance.movements[1];
  const receipt = input.appleBalance.movements.at(-1);
  input.appleBalance.movements.push({ ...charge }, { ...receipt, id: 'received-duplicate' });
  input.appleBalance.movements[3].amount = 'invalid';
  input.appleBalance.allocations.push({ ...input.appleBalance.allocations[0] });
  const report = auditAppleWallets(input);
  assert.ok(report.issues.some(row => row.code === 'duplicate_id' && row.id === charge.id && row.section === 'movement'));
  assert.ok(report.issues.some(row => row.code === 'duplicate_id' && row.id === orderId && row.section === 'allocation'));
  assert.ok(report.orders[0].issues.includes('refund_evidence_mismatch'));
  assert.equal(report.orders[0].debitEvidence, 'unknown');
  assert.equal(report.orders[0].received, null);
  assert.equal(report.wallets[0].movementBalance, null);
  assert.equal(report.wallets[0].movementIds.filter(id => id === charge.id).length, 1);
});

test('明确空的部分可核对，未导出和钱包余额不符分别标示', () => {
  const input = fixture();
  input.appleBalance.wallets[0].balance = '999';
  delete input.appleBalance.refunds;
  const report = auditAppleWallets(input);
  assert.equal(report.coverage.refunds, false);
  assert.ok(report.issues.some(row => row.code === 'missing_section' && row.section === 'refunds'));
  assert.ok(report.wallets[0].issues.includes('wallet_snapshot_mismatch'));
  assert.equal(report.wallets[0].movementBalance, '34.1999');
  assert.equal(report.orders[0].walletChainVerified, false);
  assert.equal(report.orders[0].received, null);

  const empty = auditAppleWallets({ commerce: { orders: [] }, inventory: { mailboxes: [] },
    appleBalance: { wallets: [], movements: [], allocations: [], refunds: [] } });
  assert.deepEqual(empty.counts, { wallets: 0, orders: 0, issueCount: 0 });
  assert.equal(auditAppleWallets().counts.issueCount, 6);
});

test('改用银行卡后的已完整冲正保留原 Apple 历史', () => {
  const input = fixture();
  Object.assign(input.commerce.orders[0], { payment: '银行卡', appleIdId: '', paidCurrency: 'CNY', refunds: [] });
  input.appleBalance.allocations = [];
  input.appleBalance.refunds = [];
  input.appleBalance.movements.splice(2, 3, movement('reversal-1', 'order-reversal', '20.0001',
    '29.9999', '50', 4, { orderId }));
  Object.assign(input.appleBalance.wallets[0], { balance: '50', version: 4 });
  const report = auditAppleWallets(input);
  assert.equal(report.counts.issueCount, 0);
  assert.equal(report.orders[0].debitEvidence, 'reversed');
  assert.deepEqual(report.orders[0].movementIds, ['charge-1', 'reversal-1']);
});

test('缺失订单关联的扣款不能被当成有完整流水的零扣款', () => {
  const input = fixture();
  delete input.appleBalance.movements[1].orderId;
  const report = auditAppleWallets(input);
  assert.ok(report.issues.some(row => row.code === 'invalid_reference' && row.section === 'order_movement'));
  assert.equal(report.orders[0].debitEvidence, 'unknown');
  assert.equal(report.orders[0].movementDebit, null);
});

test('Apple 对账过滤格式类似完整银行卡号的损坏编号', () => {
  const input = fixture();
  const unsafe = '1234567890123456';
  input.appleBalance.movements[0].id = unsafe;
  const report = auditAppleWallets(input);
  assert.ok(report.issues.some(row => row.code === 'invalid_id' && row.section === 'movement'));
  assert.doesNotMatch(JSON.stringify(report), new RegExp(unsafe));
});
