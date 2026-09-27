import { describe, expect, it } from 'vitest';
import type { FinancePostingLineInput } from '../finance/public-api';
import { calculateBankRechargeRefund } from './bank-recharge-refund-calculation';

const line = (
  accountCode: FinancePostingLineInput['accountCode'],
  direction: FinancePostingLineInput['direction'],
  amount: string,
  financeAccountId?: string
): FinancePostingLineInput => ({
  accountCode,
  direction,
  currency: 'CNY',
  amountOriginal: amount,
  amountCny: amount,
  fxRateToCny: '1',
  financeAccountId
});
const original = {
  lines: [
    line('cash', 'debit', '120', 'received'),
    line('bank_recharge_revenue', 'credit', '100'),
    line('bank_recharge_service_fee', 'credit', '20'),
    line('bank_recharge_cost', 'debit', '100'),
    line('cash', 'credit', '100', 'funding'),
    line('bank_recharge_bank_fee', 'debit', '2'),
    line('cash', 'credit', '2', 'funding')
  ]
};
const history = (amount: string) => {
  const result = calculateBankRechargeRefund(original, [], { customerRefundAmount: amount });
  return { lines: result.lines, metadata: { customerRefundAmount: amount } };
};

describe('银充退款按真实资金流计算', () => {
  it('customer-only refund retains 102 of cost and never restores funding cash', () => {
    const result = calculateBankRechargeRefund(original, [], {});
    expect(result.customerRefundCny.toString()).toBe('120');
    expect(result.chargeRecovery.toString()).toBe('0');
    expect(result.feeRecovery.toString()).toBe('0');
    expect(result.fullyRefunded).toBe(true);
    expect(result.fullyReversed).toBe(false);
    expect(result.lines.some((item) => item.financeAccountId === 'funding')).toBe(false);
    expect(result.lines.some((item) => item.accountCode === 'bank_recharge_cost')).toBe(false);
  });

  it('supports partial refunds and only refunds the remaining customer receipt next time', () => {
    const first = history('50');
    const result = calculateBankRechargeRefund(original, [first], {});
    expect(result.customerRefund.toString()).toBe('70');
    expect(result.customerRefundCny.toString()).toBe('70');
    expect(result.fullyRefunded).toBe(true);
    const totalIncomeRefund = [...first.lines, ...result.lines]
      .filter((item) => item.accountCode === 'bank_recharge_service_fee')
      .reduce((sum, item) => sum + Number(item.amountCny.toString()), 0);
    expect(totalIncomeRefund).toBe(20);
  });

  it('records later upstream recovery without refunding the customer twice', () => {
    const result = calculateBankRechargeRefund(original, [history('120')], {
      customerRefundAmount: '0',
      chargeRecoveryAmountCny: '100',
      bankFeeRecoveryAmountCny: '2'
    });
    expect(result.customerRefund.toString()).toBe('0');
    expect(result.fullyReversed).toBe(true);
    expect(result.lines.filter((item) => item.financeAccountId === 'funding')).toHaveLength(2);
    expect(result.lines.some((item) => item.financeAccountId === 'received')).toBe(false);
  });

  it.each([
    { customerRefundAmount: '121' },
    { chargeRecoveryAmountCny: '101' },
    { bankFeeRecoveryAmountCny: '3' }
  ])('rejects amounts beyond the unprocessed original payment: %j', (input) => {
    expect(() => calculateBankRechargeRefund(original, [], input)).toThrow('超过原单尚未处理');
  });

  it('prevents duplicate upstream recovery after the full amount has been recovered', () => {
    const first = calculateBankRechargeRefund(original, [], {
      chargeRecoveryAmountCny: '100',
      customerRefundAmount: '0'
    });
    expect(() =>
      calculateBankRechargeRefund(
        original,
        [{ lines: first.lines, metadata: { customerRefundAmount: '0' } }],
        {
          customerRefundAmount: '0',
          chargeRecoveryAmountCny: '1'
        }
      )
    ).toThrow('超过原单尚未处理');
  });
});
