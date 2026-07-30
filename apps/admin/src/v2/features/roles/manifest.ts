import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
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
  columns: [
    { key: 'name', label: '角色名称', kind: 'text', widthPreset: 'wide', fixed: 'left' },
    { key: 'code', label: '角色编码', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'description', label: '角色说明', kind: 'text', widthPreset: 'wide' },
    { key: 'permissionCount', label: '权限数量', kind: 'numeric', widthPreset: 'compact' },
    { key: 'memberCount', label: '成员数量', kind: 'numeric', widthPreset: 'compact' },
    { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2RolesView.vue')
});
