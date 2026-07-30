export type V2EmployeeStatus = 'active' | 'disabled';

export interface V2EmployeeRole {
  id: string;
  code: string;
  name: string;
  description?: string | null;
}

export interface V2Employee {
  id: string;
  username: string;
  displayName: string;
  status: V2EmployeeStatus;
  roles: V2EmployeeRole[];
  mustResetPassword: boolean;
  activeSessionCount: number;
  lastLoginAt: string | null;
  lastAuthenticatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2EmployeeListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: V2EmployeeStatus;
  roleId?: string;
  sortBy?: 'username' | 'displayName' | 'status' | 'lastLoginAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2EmployeeListResult {
  items: V2Employee[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2EmployeesBootstrap {
  list: V2EmployeeListResult;
  roles: V2EmployeeRole[];
  generatedAt: string;
}

export interface CreateV2EmployeeInput {
  username: string;
  displayName: string;
  initialPassword: string;
  roleIds: string[];
}

export interface UpdateV2EmployeeInput {
  displayName: string;
  status?: V2EmployeeStatus;
  roleIds?: string[];
}
