import { defineV2Feature } from '@/v2/features/feature';
export const autoRegistrationFeature = defineV2Feature({
  key: 'auto-registration',
  title: '自动注册 GPT',
  group: '自动注册',
  route: '/v2/auto-registration/gpt',
  sourceSheet: '自动注册 GPT',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [{ key: 'keyword', label: '搜索', kind: 'search', placeholder: '注册邮箱' }],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['auto-registration']
    ),
  loadView: () => import('./V2AutoRegistrationView.vue')
});
