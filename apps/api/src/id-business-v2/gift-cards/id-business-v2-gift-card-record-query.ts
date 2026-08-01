import type { PaginationQuery } from '../../common/pagination';

export interface ListIdBusinessV2GiftCardRecordsQuery extends PaginationQuery {
  keyword?: string;
  accountId?: string;
  cardNameOptionId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2BalanceLedgerQuery extends PaginationQuery {
  keyword?: string;
  accountId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  entryType?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}
