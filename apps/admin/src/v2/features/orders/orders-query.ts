import type {
  V2OrderListQuery,
  V2OrderStatus,
  V2OrderAccountDisposition,
  V2OrderAccountSource
} from './contracts';

type OrdersQueryDraft = Omit<
  V2OrderListQuery,
  'status' | 'accountDisposition' | 'accountSource'
> & {
  status: V2OrderStatus | '';
  accountDisposition: V2OrderAccountDisposition | '';
  accountSource: V2OrderAccountSource | '';
};

export function normalizeOrdersListQuery(
  query: OrdersQueryDraft,
  openedRange: readonly string[],
  keyword: string
): V2OrderListQuery {
  return {
    ...query,
    keyword: keyword.trim() || undefined,
    serviceOptionId: query.serviceOptionId || undefined,
    settlementPlatformOptionId: query.settlementPlatformOptionId || undefined,
    status: query.status || undefined,
    accountDisposition: query.accountDisposition || undefined,
    accountSource: query.accountSource || undefined,
    openedFrom: openedRange[0] || undefined,
    openedTo: openedRange[1] || undefined
  };
}
