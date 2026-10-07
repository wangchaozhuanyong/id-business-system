import { defineV2Feature } from '@/v2/features/feature';
export const autoRechargeFeature = defineV2Feature({
  key: 'auto-recharge',
  title: '自动充值',
  group: '自动充值',
  route: '/v2/auto-recharge',
  sourceSheet: '自动充值',
  requiredRoles: ['admin'],
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['auto-recharge']
    ),
  loadView: () => import('./V2AutoRechargeView.vue')
});
