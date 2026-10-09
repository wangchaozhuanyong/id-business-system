import { defineV2Feature } from '@/v2/features/feature';

export const autoRegistrationFeature = defineV2Feature({
  key: 'auto-registration',
  title: '自动注册',
  group: '自动注册',
  route: '/v2/auto-registration',
  sourceSheet: '自动注册',
  requiredRoles: ['admin'],
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['auto-registration']
    ),
  loadView: () => import('./V2AutoRegistrationView.vue')
});
