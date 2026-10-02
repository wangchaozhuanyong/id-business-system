import { V2_BANK_RECHARGE_PLANS, V2_RECHARGE_PLANS } from '@apple-business/shared';
import { describe, expect, it } from 'vitest';
import {
  bankRechargePlanLabel,
  bankRechargePlanOptions,
  rechargePlanOptions
} from './recharge-plan-options';

describe('ChatGPT 套餐目录与付款支持范围', () => {
  it('自动充值只展示个人套餐和三档 Pro，不展示组织套餐', () => {
    expect(rechargePlanOptions.map((item) => item.value)).toEqual([
      'go',
      'plus',
      'pro-5x',
      'pro-20x',
      'pro-500'
    ]);
  });

  it('新增目录项不会放开未经接入的付款套餐', () => {
    expect(rechargePlanOptions.filter((item) => !item.disabled).map((item) => item.value)).toEqual([
      ...V2_RECHARGE_PLANS
    ]);
    for (const item of rechargePlanOptions.filter((item) => item.disabled)) {
      expect(item.note).not.toBe('');
    }
  });

  it('五种档位按套餐与使用额度区分，不用美元价格或倍数命名', () => {
    expect(rechargePlanOptions.map((item) => item.label)).toEqual([
      'ChatGPT Go',
      'ChatGPT Plus',
      'ChatGPT Pro（标准）',
      'ChatGPT Pro（更多使用额度）',
      'ChatGPT Pro（最高使用额度）'
    ]);
    expect(rechargePlanOptions.find((item) => item.value === 'go')).toMatchObject({
      disabled: true,
      note: '暂未接入自动充值'
    });
    for (const item of rechargePlanOptions) {
      expect(`${item.label} ${item.note}`).not.toMatch(/美元|\d+\s*[×x]/);
    }
  });

  it('手工记录包含全部付费套餐，免费版不产生银充付款记录', () => {
    expect(bankRechargePlanOptions.map((item) => item.value)).toEqual([...V2_BANK_RECHARGE_PLANS]);
    expect(bankRechargePlanOptions.some((item) => item.value === 'free')).toBe(false);
    expect(bankRechargePlanLabel('go')).toBe('Go');
    expect(bankRechargePlanLabel('business')).toBe('Business（商业版）');
    expect(bankRechargePlanLabel('pro-5x')).toBe('Pro（标准）');
    expect(bankRechargePlanLabel('pro-20x')).toBe('Pro（更多使用额度）');
    expect(bankRechargePlanLabel('pro-500')).toBe('Pro（最高使用额度）');
    expect(bankRechargePlanLabel('unknown_internal_plan')).toBe('套餐待核实');
  });
});
