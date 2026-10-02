import assert from 'node:assert/strict';
import test from 'node:test';

test('银充含开通日共 30 天，跨月与跨年都使用同一周期', async () => {
  const { bankRechargeDefaultDueAt } = await import('../dist/index.js');
  for (const [openedAt, dueAt] of [
    ['2026-01-01T10:15:00+08:00', '2026-01-30T02:15:00.000Z'],
    ['2026-02-01T10:15:00+08:00', '2026-03-02T02:15:00.000Z'],
    ['2028-02-01T10:15:00+08:00', '2028-03-01T02:15:00.000Z'],
    ['2026-12-20T10:15:00+08:00', '2027-01-18T02:15:00.000Z']
  ])
    assert.equal(bankRechargeDefaultDueAt(openedAt).toISOString(), dueAt);
  assert.throws(() => bankRechargeDefaultDueAt('invalid'), /开通时间无效/);
});

test('loads the compiled shared package with standard Node ESM resolution', async () => {
  const shared = await import('../dist/index.js');

  assert.equal(typeof shared.multiplyDecimalStrings, 'function');
  assert.equal(shared.V2_FINANCE_CURRENCIES.length, 26);
  assert.ok(shared.V2_FINANCE_CURRENCIES.includes('USDT'));
});

test('换汇扣费计算使用十进制且币种中文目录完整', async () => {
  const { calculateFinanceExchange, V2_FINANCE_CURRENCY_OPTIONS } =
    await import('../dist/index.js');
  assert.equal(V2_FINANCE_CURRENCY_OPTIONS.length, 26);
  assert.equal(new Set(V2_FINANCE_CURRENCY_OPTIONS.map((x) => x.code)).size, 26);
  assert.ok(V2_FINANCE_CURRENCY_OPTIONS.every((x) => /[\u4e00-\u9fff]/.test(x.label)));
  for (const currency of ['JPY', 'KRW', 'CLP', 'VND'])
    assert.equal(V2_FINANCE_CURRENCY_OPTIONS.find((x) => x.code === currency).minorUnits, 0);
  const source = calculateFinanceExchange({
    sourceAmount: '1000',
    targetAmount: '600',
    feeAmount: '10',
    feeMode: 'source_extra'
  });
  assert.equal(source.totalDebit, '1010');
  assert.equal(source.feePercent, '1');
  assert.equal(source.exchangeRate, '0.6');
  assert.equal(source.effectiveRate, '0.59405941');
  const target = calculateFinanceExchange({
    sourceAmount: '1000',
    targetAmount: '590',
    feeAmount: '10',
    feeMode: 'target_deducted'
  });
  assert.equal(target.grossTargetAmount, '600');
  assert.equal(target.feePercent, '1.66666667');
  assert.equal(target.exchangeRate, '0.6');
  assert.equal(target.effectiveRate, '0.59');
  assert.equal(
    calculateFinanceExchange({
      sourceAmount: '9999999999999',
      targetAmount: '9999999999999',
      feeAmount: '0.0001',
      feeMode: 'source_extra'
    }).totalDebit,
    '9999999999999.0001'
  );
  for (const feeMode of ['source_extra', 'target_deducted'])
    assert.equal(
      calculateFinanceExchange({
        sourceAmount: '0.0001',
        targetAmount: '1',
        feeAmount: '0',
        feeMode
      }).feePercent,
      '0'
    );
  for (const amount of ['0', '-1', '1.00001', '100000000000000', 'NaN'])
    assert.throws(() =>
      calculateFinanceExchange({
        sourceAmount: amount,
        targetAmount: '1',
        feeAmount: '0',
        feeMode: 'source_extra'
      })
    );
});
