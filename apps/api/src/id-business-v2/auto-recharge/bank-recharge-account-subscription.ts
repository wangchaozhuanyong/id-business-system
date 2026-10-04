import { BadRequestException } from '@nestjs/common';
import type { IdBusinessV2ChatgptAccount } from '@prisma/client';

export type AccountSubscriptionState =
  | 'all'
  | 'never_subscribed'
  | 'active'
  | 'due_soon'
  | 'expired'
  | 'unknown';

export function parseAccountSubscriptionState(value?: string): AccountSubscriptionState {
  const state = value ?? 'all';
  if (!['all', 'never_subscribed', 'active', 'due_soon', 'expired', 'unknown'].includes(state))
    throw new BadRequestException('会员状态筛选无效');
  return state as AccountSubscriptionState;
}

export function accountSubscriptionState(
  subscription: { status: string; dueAt: Date | null } | undefined,
  now: number,
  warningBoundary: number
): Exclude<AccountSubscriptionState, 'all'> {
  if (!subscription || subscription.status === 'cancelled') return 'never_subscribed';
  if (subscription.status !== 'active') return 'expired';
  if (!subscription.dueAt) return 'unknown';
  if (subscription.dueAt.getTime() <= now) return 'expired';
  return subscription.dueAt.getTime() <= warningBoundary ? 'due_soon' : 'active';
}

export function accountListItem(
  item: IdBusinessV2ChatgptAccount,
  subscription: { status: string; dueAt: Date | null; plan: string } | undefined,
  now: number,
  warningBoundary: number
) {
  return {
    id: item.id,
    deletedAt: item.deletedAt ?? null,
    emailMasked: item.emailMasked,
    registrationCountryCode: item.registrationCountryCode,
    status: item.status,
    offerStatus: item.offerStatus ?? 'unknown',
    offerSource: item.offerSource ?? null,
    offerObservedAt: item.offerObservedAt ?? null,
    hasPassword: Boolean(item.passwordEncrypted),
    hasTotp: Boolean(item.totpSecretEncrypted),
    remark: item.remark,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    subscriptionState: accountSubscriptionState(subscription, now, warningBoundary),
    dueAt: subscription?.dueAt ?? null,
    currentPlan: subscription?.plan ?? null
  };
}
