import { defineV2Feature } from '@/v2/features/feature';

export const bankRechargeOrdersFeature = defineV2Feature({
  key: 'bank-recharge-orders',
  title: '充值订单',
  group: '自充设置',
  route: '/v2/account-settings/bank-orders',
  sourceSheet: '银充订单',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '订单号、客户或账号' },
    { key: 'status', label: '状态', kind: 'select', options: ['待补全', '已完成', '已退款'] }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['bank-recharge-orders']
    ),
  loadView: () => import('./V2BankRechargeOrdersView.vue')
});
