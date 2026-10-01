import { describe, expect, it } from 'vitest';
import type { FinancePostingLineInput } from '../finance/public-api';
import { calculateSubscriptionCostRefund } from './subscription-cost-refund';
const line = (
  accountCode: FinancePostingLineInput['accountCode'],
  direction: 'debit' | 'credit',
  amountOriginal: string,
  currency = 'CNY',
  amountCny = amountOriginal,
  financeAccountId?: string,
  fxRateToCny = '1',
  memo?: string
): FinancePostingLineInput => ({
  accountCode,
  direction,
  amountOriginal,
  amountCny,
  currency: currency as 'CNY',
  financeAccountId,
  fxRateToCny,
  memo
});
const original = {
  lines: [
    line('cash', 'debit', '150', 'CNY', '150', 'receipt'),
    line('bank_recharge_revenue', 'credit', '150'),
    line('bank_recharge_cost', 'debit', '100'),
    line('cash', 'credit', '100', 'CNY', '100', 'funding', '1', '银行卡代付'),
    line('bank_recharge_usdt_fee', 'debit', '0.3', 'USDT', '2', 'usdt', '6.66666667'),
    line('bank_recharge_shopping_fee', 'debit', '3', 'CNY', '3', 'shopping')
  ]
};
describe('订阅两项费用实际回款', () => {
  it('客户全退不会自动恢复两项费用或本金', () => {
    const r = calculateSubscriptionCostRefund(original, [], {});
    expect(r.customerRefundCny.toString()).toBe('150');
    expect(r.feeRecovery.toString()).toBe('0');
    expect(r.fullyRefunded).toBe(true);
    expect(r.fullyReversed).toBe(false);
    expect(r.lines).toHaveLength(2);
  });
  it('分批按原币回款，最后一笔精确冲清原人民币成本', () => {
    const first = calculateSubscriptionCostRefund(original, [], {
      customerRefundAmount: '50',
      usdtFeeRecoveryAmount: '0.1',
      shoppingFeeRecoveryAmount: '1'
    });
    expect(first.usdtFeeRecoveryCny.toString()).toBe('0.6667');
    const last = calculateSubscriptionCostRefund(original, [{ lines: first.lines }], {
      chargeRecoveryAmountCny: '100',
      usdtFeeRecoveryAmount: '0.2',
      shoppingFeeRecoveryAmount: '2'
    });
    expect(last.usdtFeeRecoveryCny.toString()).toBe('1.3333');
    expect(last.fullyReversed).toBe(true);
    expect(last.lines).toContainEqual(
      expect.objectContaining({
        accountCode: 'cash',
        direction: 'debit',
        currency: 'USDT',
        financeAccountId: 'usdt',
        fxRateToCny: '6.66666667'
      })
    );
  });
  it('独立限制两项退费、客户退款和本金回款上限', () => {
    for (const input of [
      { usdtFeeRecoveryAmount: '0.3001' },
      { shoppingFeeRecoveryAmount: '3.0001' },
      { customerRefundAmount: '150.0001' },
      { chargeRecoveryAmountCny: '100.0001' }
    ])
      expect(() => calculateSubscriptionCostRefund(original, [], input)).toThrow(/超过/);
  });
  it('拒绝没有任何实际退款或回款的登记', () => {
    expect(() =>
      calculateSubscriptionCostRefund(original, [], { customerRefundAmount: '0' })
    ).toThrow('请填写实际发生');
  });
});
