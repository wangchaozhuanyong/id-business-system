export const sharedCardPlanOptions = [
  { value: 'go', label: 'Go 套餐' },
  { value: 'plus', label: 'Plus 套餐' },
  { value: 'pro_5x', label: 'Pro 5 倍' },
  { value: 'pro_20x', label: 'Pro 20 倍' },
  { value: 'pro_500', label: 'Pro 500 美元档' }
] as const;

export function sharedCardPlanLabel(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(
          (plan) =>
            sharedCardPlanOptions.find((option) => option.value === plan)?.label ?? '套餐待核对'
        )
        .join('、')
    : '套餐待核对';
}
