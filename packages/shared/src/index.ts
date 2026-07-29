export interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  message: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  errorCode: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export type {
  DecimalString,
  IsoDateTimeString,
  PaginatedResult,
  PaginationQueryContract,
  V2PageQuery,
  V2SortOrder
} from './v2/common';
