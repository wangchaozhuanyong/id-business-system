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
      'free',
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

  it('免费版明确无需充值，500 美元档不猜测用量倍数', () => {
    expect(rechargePlanOptions.find((item) => item.value === 'free')?.note).toBe('无需充值');
    const pro500 = rechargePlanOptions.find((item) => item.value === 'pro-500')!;
    expect(pro500.label).toContain('500 美元');
    expect(pro500.label).not.toMatch(/\d+\s*[×x]/);
    expect(pro500.disabled).toBe(false);
  });

  it('手工记录包含全部付费套餐，免费版不产生银充付款记录', () => {
    expect(bankRechargePlanOptions.map((item) => item.value)).toEqual([...V2_BANK_RECHARGE_PLANS]);
    expect(bankRechargePlanOptions.some((item) => item.value === 'free')).toBe(false);
    expect(bankRechargePlanLabel('go')).toBe('Go（入门版）');
    expect(bankRechargePlanLabel('business')).toBe('Business（商业版）');
    expect(bankRechargePlanLabel('pro-500')).toContain('500 美元');
    expect(bankRechargePlanLabel('unknown_internal_plan')).toBe('套餐待核实');
  });
});
