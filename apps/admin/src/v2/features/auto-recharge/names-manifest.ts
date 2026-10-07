import { defineV2Feature } from '@/v2/features/feature';
export const autoRechargeNamesFeature = defineV2Feature({
  key: 'auto-recharge-names',
  title: '姓名库',
  group: '自动充值',
  route: '/v2/auto-recharge/names',
  sourceSheet: '充值姓名库',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [{ key: 'keyword', label: '姓名', kind: 'search', placeholder: '输入完整姓名' }],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['auto-recharge-names']
    ),
  loadView: () => import('./V2RechargeNamesView.vue')
});
