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

export interface V2Role {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isSystemRole: boolean;
  permissions: V2RolePermission[];
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
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
  generatedAt: string;
}

export interface CreateV2RoleInput {
  name: string;
  code: string;
  description: string;
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
}

export interface UpdateV2RoleInput {
  name: string;
  description: string;
  permissionIds: string[];
  sensitiveApprovalPermissionIds: string[];
}
