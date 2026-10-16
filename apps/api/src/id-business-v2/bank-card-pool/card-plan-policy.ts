import { BadRequestException, ConflictException } from '@nestjs/common';

export const SHARED_CARD_PLANS = ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_500'] as const;
export type SharedCardPlan = (typeof SHARED_CARD_PLANS)[number];
export const SHARED_CARD_SCOPES = ['auto-recharge', 'online-recharge'] as const;
export const SHARED_CARD_DEFAULT_LIMITS = { maxSubscriptionCount: 2, maxDeclineCount: 3 } as const;

export function sharedCardLimits(value: unknown) {
  const settings =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const positive = (input: unknown, fallback: number) =>
    Number.isInteger(Number(input)) && Number(input) > 0 ? Number(input) : fallback;
  return {
    maxSubscriptionCount: positive(
      settings.cardMaxSubscriptionCount,
      SHARED_CARD_DEFAULT_LIMITS.maxSubscriptionCount
    ),
    maxDeclineCount: positive(
      settings.cardMaxDeclineCount,
      SHARED_CARD_DEFAULT_LIMITS.maxDeclineCount
    )
  };
}

export function sharedCardPlan(value: unknown): SharedCardPlan {
  const plan = typeof value === 'string' ? value.replace(/-/g, '_') : '';
  if (!SHARED_CARD_PLANS.includes(plan as SharedCardPlan))
    throw new BadRequestException('银行卡适用套餐无效');
  return plan as SharedCardPlan;
}

export function sharedCardPlans(value: unknown): SharedCardPlan[] {
  if (!Array.isArray(value) || !value.length || value.length > SHARED_CARD_PLANS.length)
    throw new BadRequestException('请至少选择一个银行卡适用套餐');
  return [...new Set(value.map(sharedCardPlan))];
}

export function assertSharedCardPlan(allowedPlans: unknown, plan: unknown) {
  if (!sharedCardPlans(allowedPlans).includes(sharedCardPlan(plan)))
    throw new ConflictException('该银行卡不允许用于本次套餐，请选择对应套餐的银行卡');
}
