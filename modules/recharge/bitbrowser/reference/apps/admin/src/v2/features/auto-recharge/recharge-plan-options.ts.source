import { V2_BANK_RECHARGE_PLANS, V2_RECHARGE_PLANS } from '@apple-business/shared';
import { planLabels } from './recharge-presentation';

// 官方套餐目录与执行器支持范围分开；新增目录项不能自动获得付款能力。
// 核对来源：https://learn.chatgpt.com/docs/pricing（2026-10-01）。
const catalog = [
  { value: 'free', label: 'ChatGPT 免费版', note: '无需充值' },
  { value: 'go', label: planLabels.go, note: '' },
  { value: 'plus', label: planLabels.plus, note: '' },
  { value: 'pro-5x', label: planLabels['pro-5x'], note: '' },
  { value: 'pro-20x', label: planLabels['pro-20x'], note: '' },
  { value: 'pro-500', label: planLabels['pro-500'], note: '' },
  { value: 'business', label: 'ChatGPT Business（商业版）', note: '组织套餐，暂未接入自动充值' },
  { value: 'enterprise', label: 'ChatGPT Enterprise（企业版）', note: '需联系官方销售开通' },
  { value: 'edu', label: 'ChatGPT Edu（教育版）', note: '需由教育机构联系官方开通' }
] as const;

const catalogOptions = catalog.map((item) => ({
  ...item,
  disabled: !V2_RECHARGE_PLANS.some((plan) => plan === item.value)
}));

// 自动充值展示五种个人付费档位；免费版无需充值，其他目录用于手工记录与历史标签。
export const rechargePlanOptions = catalogOptions.filter(
  (item) => item.value === 'go' || V2_RECHARGE_PLANS.some((plan) => plan === item.value)
);

export const bankRechargePlanOptions = catalogOptions.filter((item) =>
  V2_BANK_RECHARGE_PLANS.some((plan) => plan === item.value)
);

export function bankRechargePlanLabel(value: string) {
  return (
    catalog.find((item) => item.value === value)?.label.replace(/^ChatGPT /, '') ?? '套餐待核实'
  );
}
