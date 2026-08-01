export type V2AuditLogTab = 'operations' | 'sensitive_access';
export type V2AuditSortOrder = 'asc' | 'desc';

export interface V2AuditUser {
  id: string;
  username: string;
  displayName: string;
}

export interface V2AuditLogRecord {
  id: string;
  userId?: string | null;
  user?: V2AuditUser | null;
  module: string;
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  remark?: string | null;
  createdAt: string;
}

export interface V2SensitiveAccessLogRecord {
  id: string;
  userId?: string | null;
  user?: V2AuditUser | null;
  module: string;
  fieldName: string;
  objectType: string;
  objectId?: string | null;
  accessReason?: string | null;
  approved: boolean;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface V2AuditLogListQuery {
  page?: number;
  pageSize?: number;
  module?: string;
  action?: string;
  operator?: string;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: 'createdAt' | 'module' | 'action' | 'objectType';
  sortOrder?: V2AuditSortOrder;
}

export interface V2SensitiveAccessLogListQuery {
  page?: number;
  pageSize?: number;
  module?: string;
  fieldName?: string;
  operator?: string;
  approved?: 'true' | 'false';
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: 'createdAt' | 'module' | 'fieldName' | 'objectType' | 'approved';
  sortOrder?: V2AuditSortOrder;
}

export interface V2AuditLogListResult<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2AuditLogExportInput {
  kind: V2AuditLogTab;
  module?: string;
  action?: string;
  fieldName?: string;
  operator?: string;
  approved?: 'true' | 'false';
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: V2AuditSortOrder;
}

export interface V2AuditLogExportResult<TItem> {
  kind: V2AuditLogTab;
  items: TItem[];
  total: number;
  exportedCount: number;
  capped: boolean;
  generatedAt: string;
}
