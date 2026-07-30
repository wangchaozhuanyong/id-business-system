import { defineV2Feature } from '@/v2/features/feature';

export const employeesFeature = defineV2Feature({
  key: 'employees',
  title: '员工账户',
  group: '系统管理',
  route: '/v2/system/employees',
  sourceSheet: '规划占位-员工账户',
  requiredRoles: ['admin'],
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-driven',
  summary: '由管理员统一开通、停用和管理内部员工登录账户。',
  plannedSections: [
    {
      title: '员工列表',
      description: '规划分页、搜索、状态、角色和最近登录信息。'
    },
    {
      title: '开通账户',
      description: '由管理员创建内部账号，不提供公开注册入口。'
    },
    {
      title: '账号状态',
      description: '规划启用、停用、强制退出和密码重置流程。'
    },
    {
      title: '角色分配',
      description: '为员工分配受控角色，并记录变更前后的审计信息。'
    }
  ],
  safetyNotice: '当前不会创建、停用或修改任何真实员工账户。',
  filters: [],
  columns: [],
  loadView: () => import('./V2EmployeesView.vue')
});
