import { describe, expect, it } from 'vitest';
import { onlineBillingAmountText, type OnlineBillingSummary } from './billing-presentation';

const row: OnlineBillingSummary = {
  currency: 'USD',
  amount: null,
  knownAmount: '20.1234',
  count: 2,
  unknownAmountCount: 1,
  isComplete: false
};
describe('线上代充账单汇总展示', () => {
  it('未知金额明确显示已知小计和待核对笔数', () => {
    expect(onlineBillingAmountText(row)).toBe('已知金额小计 20.1234；1 笔金额待核对（共 2 笔）');
  });
  it('全部未知不显示零元消费', () => {
    expect(onlineBillingAmountText({ ...row, knownAmount: null, unknownAmountCount: 2 })).toContain(
      '尚无已知金额；2 笔金额待核对'
    );
  });
  it('确认的零元账单不显示为缺失', () => {
    expect(
      onlineBillingAmountText({
        ...row,
        amount: '0',
        knownAmount: '0',
        count: 1,
        unknownAmountCount: 0,
        isComplete: true
      })
    ).toBe('0（1 笔，金额完整）');
  });
  it('完整金额保留服务端精确字符串', () => {
    expect(
      onlineBillingAmountText({
        ...row,
        amount: '12345678901234.1234',
        count: 1,
        unknownAmountCount: 0,
        isComplete: true
      })
    ).toBe('12345678901234.1234（1 笔，金额完整）');
  });
});
