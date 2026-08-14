export interface ListV2RolesQuery {
  page?: string;
  pageSize?: string;
  keyword?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface CreateV2RoleDto {
  name?: string;
  code?: string;
  description?: string;
  permissionIds?: string[];
  sensitiveApprovalPermissionIds?: string[];
  sensitiveDisplayPolicies?: V2SensitiveDisplayPolicyDto[];
}

export interface UpdateV2RoleDto {
  name?: string;
  description?: string;
  permissionIds?: string[];
  sensitiveApprovalPermissionIds?: string[];
  sensitiveDisplayPolicies?: V2SensitiveDisplayPolicyDto[];
}

export interface V2SensitiveDisplayPolicyDto {
  fieldKey?: string;
  context?: string;
  mode?: string;
}
