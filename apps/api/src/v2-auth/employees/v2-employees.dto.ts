export interface ListV2EmployeesQuery {
  page?: string;
  pageSize?: string;
  keyword?: string;
  status?: string;
  roleId?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface CreateV2EmployeeDto {
  username?: string;
  displayName?: string;
  initialPassword?: string;
  roleIds?: string[];
}

export interface UpdateV2EmployeeDto {
  expectedUpdatedAt?: string;
  displayName?: string;
  status?: string;
  roleIds?: string[];
}
