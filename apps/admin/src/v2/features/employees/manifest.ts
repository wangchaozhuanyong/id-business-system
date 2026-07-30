import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
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
  columns: [
    { key: 'username', label: '登录账号', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'displayName', label: '员工姓名', kind: 'text', widthPreset: 'wide' },
    { key: 'roles', label: '角色', kind: 'text', widthPreset: 'wide' },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
    {
      key: 'activeSessionCount',
      label: '在线会话',
      kind: 'numeric',
      widthPreset: 'compact'
    },
    { key: 'passwordState', label: '密码状态', kind: 'status', widthPreset: 'standard' },
    { key: 'lastLoginAt', label: '最近登录', kind: 'date', widthPreset: 'dateTime' },
    { key: 'createdAt', label: '开通时间', kind: 'date', widthPreset: 'dateTime' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2EmployeesView.vue')
});
