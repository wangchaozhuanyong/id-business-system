export type V2SortOrder = 'asc' | 'desc';
export type IsoDateTimeString = string;
export type DecimalString = string;

export interface PaginationQueryContract {
  page?: number | string;
  pageSize?: number | string;
}

export interface V2PageQuery {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}
