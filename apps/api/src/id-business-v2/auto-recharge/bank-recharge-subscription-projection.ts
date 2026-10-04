import type { V2CommandTransaction } from '../runtime/public-api';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';

export async function activateBankRechargeSubscription(
  tx: V2CommandTransaction,
  repository: BankRechargeRepository,
  order: {
    id: string;
    accountId: string | null;
    customerId: string | null;
    plan: string;
    source: string;
    openedAt: Date | null;
    dueAt: Date | null;
  }
) {
  if (!order.accountId || !order.openedAt) return;
  const current = await repository.findSubscriptionWithOrder(tx, order.accountId);
  // 普通补资料及更正只能维护本单已有投影；历史单转为当前使用须单独核对。
  if (order.source === 'automatic' && current?.currentOrderId !== order.id) return;
  if (current && current.currentOrderId !== order.id && current.openedAt >= order.openedAt) return;
  await repository.upsertSubscription(tx, {
    accountId: order.accountId,
    currentOrderId: order.id,
    customerId: order.customerId,
    plan: order.plan,
    openedAt: order.openedAt,
    dueAt: order.dueAt
  });
}
