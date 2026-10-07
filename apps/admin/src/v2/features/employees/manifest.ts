import { defineV2Feature } from '@/v2/features/feature';

export const employeesFeature = defineV2Feature({
  key: 'employees',
  title: '员工账户',
  group: '系统管理',
  route: '/v2/system/employees',
  sourceSheet: '系统管理-员工账户',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '登录账号、员工姓名'
    },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['启用', '停用']
    },
    {
      key: 'roleId',
      label: '角色',
      kind: 'select'
    }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['employees']
    ),
  loadView: () => import('./V2EmployeesView.vue')
});
