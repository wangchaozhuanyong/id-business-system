import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2FinanceCurrency, V2OrderReceiptFxQuote } from '@apple-business/shared';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  ConsumeV2OrderInput,
  ConsumeV2OrderResult,
  CancelV2OrderInput,
  CompleteV2OrderResult,
  CreateV2OrderInput,
  CreateV2OrderResult,
  DeleteV2OrderInput,
  DeleteV2OrderResult,
  RefundV2OrderInput,
  PreviewV2OrderUpgradeBalanceReturnInput,
  RecordV2OrderUpgradeBalanceReturnInput,
  ReverseV2OrderUpgradeBalanceReturnInput,
  SearchV2OrderCandidatesInput,
  UpdateV2OrderInput,
  V2Order,
  V2OrderEntryOptions,
  V2OrderLifecycleResult,
  V2OrderListQuery,
  V2OrderListResult,
  V2OrderMatchingResult,
  V2OrderUpgradeBalanceReturnPreview,
  V2OrderUpgradeBalanceReturnResult
} from '@/v2/types/orders';
import type { V2OptionSelector } from '@/v2/types/options';

export const idBusinessV2OrdersApi = {
  list(params: V2OrderListQuery, options: ApiRequestOptions = {}) {
    return request<V2OrderListResult>(
      http.get('/id-business-v2/orders', { params, signal: options.signal })
    );
  },
  bootstrap(params: V2OrderListQuery, options: ApiRequestOptions = {}) {
    return request<{
      list: V2OrderListResult;
      options: {
        services: V2OptionSelector[];
        settlementPlatforms: V2OptionSelector[];
      };
      generatedAt: string;
    }>(
      http.get('/id-business-v2/orders/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  get(id: string, options: ApiRequestOptions = {}) {
    return request<V2Order>(http.get(`/id-business-v2/orders/${id}`, { signal: options.signal }));
  },
  getEntryOptions(customerKeyword?: string, options: ApiRequestOptions = {}) {
    return request<V2OrderEntryOptions>(
      http.get('/id-business-v2/orders/entry-options', {
        params: {
          customerKeyword
        },
        signal: options.signal
      })
    );
  },
  quoteReceiptFx(currency: V2FinanceCurrency, options: ApiRequestOptions = {}) {
    return request<V2OrderReceiptFxQuote>(
      http.post('/id-business-v2/orders/receipt-fx-quote', { currency }, { signal: options.signal })
    );
  },
  findMatchingCandidates(
    params: {
      serviceOptionId: string;
      balanceAmount: string;
      accountSource?: 'inventory' | 'customer_owned';
      customerId?: string;
      orderId?: string;
      limit?: number;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<V2OrderMatchingResult>(
      http.get('/id-business-v2/orders/matching-candidates', {
        params,
        signal: options.signal
      })
    );
  },
  searchManualCandidates(payload: SearchV2OrderCandidatesInput, options: ApiRequestOptions = {}) {
    return request<V2OrderMatchingResult>(
      http.post('/id-business-v2/orders/manual-candidates/search', payload, {
        signal: options.signal
      })
    );
  },
  create(payload: CreateV2OrderInput) {
    return withV2QueryInvalidation(
      request<CreateV2OrderResult>(http.post('/id-business-v2/orders', payload)),
      ORDER_MUTATION_SCOPES
    );
  },
  consumeBalance(id: string, payload: ConsumeV2OrderInput) {
    return withV2QueryInvalidation(
      request<ConsumeV2OrderResult>(
        http.post(`/id-business-v2/orders/${id}/consume-balance`, payload)
      ),
      ORDER_MUTATION_SCOPES
    );
  },
  complete(id: string) {
    return withV2QueryInvalidation(
      request<CompleteV2OrderResult>(http.post(`/id-business-v2/orders/${id}/complete`)),
      ORDER_MUTATION_SCOPES
    );
  },
  update(id: string, payload: UpdateV2OrderInput) {
    return withV2QueryInvalidation(
      request<V2Order>(http.patch(`/id-business-v2/orders/${id}`, payload)),
      ORDER_MUTATION_SCOPES
    );
  },
  refund(id: string, payload: RefundV2OrderInput) {
    return withV2QueryInvalidation(
      request<V2OrderLifecycleResult>(http.post(`/id-business-v2/orders/${id}/refund`, payload)),
      ORDER_MUTATION_SCOPES
    );
  },
  previewUpgradeBalanceReturn(
    id: string,
    payload: PreviewV2OrderUpgradeBalanceReturnInput,
    options: ApiRequestOptions = {}
  ) {
    return request<V2OrderUpgradeBalanceReturnPreview>(
      http.post(`/id-business-v2/orders/${id}/upgrade-balance-return/preview`, payload, {
        signal: options.signal
      })
    );
  },
  recordUpgradeBalanceReturn(id: string, payload: RecordV2OrderUpgradeBalanceReturnInput) {
    return withV2QueryInvalidation(
      request<V2OrderUpgradeBalanceReturnResult>(
        http.post(`/id-business-v2/orders/${id}/upgrade-balance-return`, payload)
      ),
      ORDER_MUTATION_SCOPES
    );
  },
  reverseUpgradeBalanceReturn(id: string, payload: ReverseV2OrderUpgradeBalanceReturnInput) {
    return withV2QueryInvalidation(
      request<V2OrderUpgradeBalanceReturnResult>(
        http.post(`/id-business-v2/orders/${id}/upgrade-balance-return/reverse`, payload)
      ),
      ORDER_MUTATION_SCOPES
    );
  },
  cancel(id: string, payload: CancelV2OrderInput) {
    return withV2QueryInvalidation(
      request<V2OrderLifecycleResult>(http.post(`/id-business-v2/orders/${id}/cancel`, payload)),
      ORDER_MUTATION_SCOPES
    );
  },
  remove(id: string, payload: DeleteV2OrderInput) {
    return withV2QueryInvalidation(
      request<DeleteV2OrderResult>(
        http.delete(`/id-business-v2/orders/${id}`, {
          data: payload
        })
      ),
      ORDER_MUTATION_SCOPES
    );
  }
};

const ORDER_MUTATION_SCOPES = [
  'orders',
  'accounts',
  'balances',
  'balance-records',
  'activations',
  'renewals',
  'order-entry-options',
  'order-entry-matching',
  'finance-accounts',
  'finance-ledger',
  'finance-reports'
] as const;
