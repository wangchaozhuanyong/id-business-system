import type { PaginationQuery } from '../../common/pagination';

export interface ListIdBusinessV2CustomersQuery extends PaginationQuery {
  keyword?: string;
  sourceOptionId?: string;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface IdBusinessV2CustomerAuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export type IdBusinessV2CustomerRecordStatus = 'active' | 'disabled';
