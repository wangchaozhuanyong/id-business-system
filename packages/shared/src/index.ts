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
export {
  V2_DECIMAL_PLACES,
  V2_DECIMAL_STEP,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  addDecimalStrings,
  divideDecimalStrings,
  isV2UnsignedDecimal,
  multiplyDecimalStrings,
  roundDecimalString,
  v2UnsignedDecimalPattern
} from './v2/decimal';
export {
  V2_DATA_SCOPES,
  V2_SCOPE_DEPENDENCIES,
  expandV2DataScopes,
  isV2DataScope,
  type V2ChangeEvent,
  type V2ChangeVersionsResult,
  type V2DataScope,
  type V2ScopeVersion
} from './v2/data-scopes';
