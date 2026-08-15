export interface V2RolePermission {
  id: string;
  name: string;
  code: string;
  module: string;
  action: string;
  sensitive?: boolean;
}

export interface V2RoleMember {
  id: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled';
}

export type V2SensitiveDisplayContext =
  | 'account_management'
  | 'customer_management'
  | 'order_workbench'
  | 'topup_workbench'
  | 'renewal_workbench'
  | 'business_records'
  | 'dashboard_notifications'
  | 'export'
  | 'audit';

export type V2SensitiveDisplayMode =
  | 'hidden'
  | 'masked'
  | 'reveal_direct'
  | 'reveal_approval'
  | 'full';

export interface V2SensitiveDisplayPolicy {
  fieldKey: string;
  context: V2SensitiveDisplayContext;
  mode: V2SensitiveDisplayMode;
}

export interface V2SensitiveDisplayCatalogItem {
  fieldKey: string;
  fieldLabel: string;
  permissionCode: string;
  context: V2SensitiveDisplayContext;
  contextLabel: string;
  allowedModes: V2SensitiveDisplayMode[];
}

export interface V2Role {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isSystemRole: boolean;
  permissions: V2RolePermission[];
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
  sensitiveDisplayPolicies: V2SensitiveDisplayPolicy[];
  permissionCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface V2RoleDetail extends V2Role {
  members: V2RoleMember[];
}

export interface V2RolePermissionGroup {
  module: string;
  label: string;
  permissions: V2RolePermission[];
}

export interface V2RoleListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  sortBy?: 'name' | 'code' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2RoleListResult {
  items: V2Role[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2RolesBootstrap {
  list: V2RoleListResult;
  permissions: V2RolePermission[];
  sensitiveDisplayCatalog: V2SensitiveDisplayCatalogItem[];
  sensitiveDisplayModeLabels: Record<V2SensitiveDisplayMode, string>;
  generatedAt: string;
}

export interface CreateV2RoleInput {
  name: string;
  code: string;
  description: string;
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
  sensitiveDisplayPolicies: V2SensitiveDisplayPolicy[];
}

export interface UpdateV2RoleInput {
  expectedUpdatedAt: string;
  name: string;
  description: string;
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
  sensitiveDisplayPolicies: V2SensitiveDisplayPolicy[];
}
