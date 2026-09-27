import type { CustomerDeleteImpact } from './persistence/id-business-v2-customer.repository';

export function customerDeleteBlockingReasons(impact: CustomerDeleteImpact) {
  const checks = [
    [impact.activeOrderCount, '进行中订单'],
    [impact.activeActivationCount, '活动开通记录'],
    [impact.activeBankOrderCount, '进行中银充订单'],
    [impact.activeBankSubscriptionCount, '活动银充订阅']
  ] as const;
  return checks
    .filter(([count]) => count > 0)
    .map(([count, label]) => `仍有 ${count} 个${label}，不能删除客户`);
}
