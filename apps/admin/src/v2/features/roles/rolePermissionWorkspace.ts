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
