import type { Prisma } from '@prisma/client';
import type { PaginationQuery } from '../common/pagination';

export interface CreateAuditLogInput {
  userId?: string;
  module: string;
  action: string;
  objectType?: string;
  objectId?: string;
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
  remark?: string;
}

export interface ListAuditLogsQuery extends PaginationQuery {
  module?: string;
  action?: string;
  operator?: string;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListSensitiveAccessLogsQuery extends PaginationQuery {
  module?: string;
  fieldName?: string;
  operator?: string;
  approved?: string;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export type AuditLogExportKind = 'operations' | 'sensitive_access';

export interface ExportAuditLogsInput {
  kind?: AuditLogExportKind;
  module?: string;
  action?: string;
  fieldName?: string;
  operator?: string;
  approved?: string;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?: string;
  sortOrder?: string;
}
