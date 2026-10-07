import { defineV2Feature } from '@/v2/features/feature';

export const rolesFeature = defineV2Feature({
  key: 'roles',
  title: '角色权限',
  group: '系统管理',
  route: '/v2/system/roles',
  sourceSheet: '系统管理-角色权限',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '角色名称、编码或说明'
    }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['roles']
    ),
  loadView: () => import('./V2RolesView.vue')
});
