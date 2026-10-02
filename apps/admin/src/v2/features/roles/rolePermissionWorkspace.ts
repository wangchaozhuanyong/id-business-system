import type { V2RolePermission, V2RolePermissionGroup } from './contracts';

export interface V2RolePermissionWorkspaceGroup extends V2RolePermissionGroup {
  allPermissions: V2RolePermission[];
  selectedCount: number;
}

export function filterRolePermissionGroups(
  groups: V2RolePermissionGroup[],
  keywordInput: string,
  selectedOnly: boolean,
  selectedPermissionIds: string[]
): V2RolePermissionWorkspaceGroup[] {
  const keyword = keywordInput.trim().toLowerCase();
  const selectedIds = new Set(selectedPermissionIds);

  return groups.flatMap((group) => {
    const groupMatches = group.label.toLowerCase().includes(keyword);
    const permissions = group.permissions.filter((permission) => {
      if (selectedOnly && !selectedIds.has(permission.id)) return false;
      if (!keyword || groupMatches) return true;
      return `${permission.name} ${permission.code}`.toLowerCase().includes(keyword);
    });

    if (!permissions.length) return [];
    return [
      {
        ...group,
        permissions,
        allPermissions: group.permissions,
        selectedCount: group.permissions.filter((permission) => selectedIds.has(permission.id))
          .length
      }
    ];
  });
}

export function getInitialExpandedPermissionModules(
  groups: V2RolePermissionGroup[],
  selectedPermissionIds: string[]
) {
  const selectedIds = new Set(selectedPermissionIds);
  const selectedModules = groups
    .filter((group) => group.permissions.some((permission) => selectedIds.has(permission.id)))
    .map((group) => group.module);

  if (selectedModules[0]) return [selectedModules[0]];
  return groups[0] ? [groups[0].module] : [];
}

export const PERMISSION_MODULE_LABELS: Record<string, string> = {
  'apple.account': 'ID 资料',
  'apple.secret': 'ID 敏感资料',
  'apple.balance': '余额与加卡',
  'apple.topup_supplier_fund': '供应商资金',
  'apple.gift_card': '礼品卡',
  'apple.order': '订单',
  'apple.activation': '开通记录',
  'apple.renewal_task': '续费',
  'apple.exchange_rate': '汇率',
  customer: '客户',
  'data.dictionary': '业务选项',
  audit_log: '审计日志',
  'id_business_v2.renewal_warning': '续费预警',
  'data.analytics': '经营分析',
  finance: '财务'
};
