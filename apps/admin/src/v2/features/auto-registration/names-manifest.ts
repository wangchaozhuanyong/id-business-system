import { defineV2Feature } from '@/v2/features/feature';
export const registrationNamesFeature = defineV2Feature({
  key: 'registration-names',
  title: '名字数据表',
  group: '自动注册',
  route: '/v2/auto-registration/names',
  sourceSheet: '名字数据表',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [{ key: 'keyword', label: '搜索', kind: 'search', placeholder: '名字' }],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['registration-names']
    ),
  loadView: () => import('./V2RegistrationNamesView.vue')
});
