import { defineV2Feature } from '@/v2/features/feature';

export const bankRechargeCardsFeature = defineV2Feature({
  key: 'bank-recharge-cards',
  title: '银行卡管理',
  group: '自动充值',
  route: '/v2/auto-recharge/bank-cards',
  sourceSheet: '银行卡管理',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '名称、尾号或备注' },
    { key: 'status', label: '状态', kind: 'select', options: ['启用', '停用'] }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['bank-recharge-cards']
    ),
  loadView: () => import('./V2BankRechargeCardsView.vue')
});
