import { defineV2Feature } from '@/v2/features/feature';

export const rolesFeature = defineV2Feature({
  key: 'roles',
  title: '角色权限',
  group: '系统管理',
  route: '/v2/system/roles',
  sourceSheet: '规划占位-角色权限',
  requiredRoles: ['admin'],
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-driven',
  summary: '按角色集中管理页面、操作和敏感资料访问权限。',
  plannedSections: [
    {
      title: '角色列表',
      description: '规划系统角色、自定义角色、说明和启用状态。'
    },
    {
      title: '权限矩阵',
      description: '按业务模块展示查看、创建、修改、删除和敏感操作权限。'
    },
    {
      title: '角色成员',
      description: '查看角色下的员工，并规划批量调整入口。'
    },
    {
      title: '变更审计',
      description: '角色和权限变更必须保存操作者、差异和原因。'
    }
  ],
  safetyNotice: '当前不会修改数据库中的角色、权限或员工角色关系。',
  filters: [],
  columns: [],
  loadView: () => import('./V2RolesView.vue')
});
