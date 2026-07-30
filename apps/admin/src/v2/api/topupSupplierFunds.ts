import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  V2TopupSupplierFundListQuery,
  V2TopupSupplierFundListResult,
  V2TopupSupplierFundMutationResult,
  V2TopupSupplierLedgerQuery,
  V2TopupSupplierLedgerResult,
  V2TopupSupplierPaymentListQuery,
  V2TopupSupplierPaymentListResult,
  V2TopupSupplierPaymentMutationResult
} from '@/v2/types/topupSupplierFunds';

const invalidationScopes = ['supplier-funds', 'supplier-payments', 'balance-records'] as const;

export const idBusinessV2TopupSupplierFundsApi = {
  listSuppliers(params: V2TopupSupplierFundListQuery, options: ApiRequestOptions = {}) {
    return request<V2TopupSupplierFundListResult>(
      http.get('/id-business-v2/topup-supplier-funds/suppliers', {
        params,
        signal: options.signal
      })
    );
  },
  listLedger(
    supplierOptionId: string,
    params: V2TopupSupplierLedgerQuery,
    options: ApiRequestOptions = {}
  ) {
    return request<V2TopupSupplierLedgerResult>(
      http.get(`/id-business-v2/topup-supplier-funds/suppliers/${supplierOptionId}/ledger`, {
        params,
        signal: options.signal
      })
    );
  },
  listPayments(params: V2TopupSupplierPaymentListQuery, options: ApiRequestOptions = {}) {
    return request<V2TopupSupplierPaymentListResult>(
      http.get('/id-business-v2/topup-supplier-funds/payments', {
        params,
        signal: options.signal
      })
    );
  },
  initialize(
    supplierOptionId: string,
    payload: { targetBalanceCny: string; reason: string; idempotencyKey: string }
  ) {
    return withV2QueryInvalidation(
      request<V2TopupSupplierFundMutationResult>(
        http.post(
          `/id-business-v2/topup-supplier-funds/suppliers/${supplierOptionId}/initialize`,
          payload
        )
      ),
      [...invalidationScopes, 'balances-options']
    );
  },
  createPayment(
    supplierOptionId: string,
    payload: {
      receivedUsdt: string;
      networkFeeUsdt?: string;
      settlementRateCnyUsdt: string;
      network?: string;
      transactionHash?: string;
      paidAt: string;
      remark?: string;
      idempotencyKey: string;
    }
  ) {
    return withV2QueryInvalidation(
      request<V2TopupSupplierPaymentMutationResult>(
        http.post(
          `/id-business-v2/topup-supplier-funds/suppliers/${supplierOptionId}/payments`,
          payload
        )
      ),
      [...invalidationScopes, 'balances-options']
    );
  },
  adjust(
    supplierOptionId: string,
    payload: { targetBalanceCny: string; reason: string; idempotencyKey: string }
  ) {
    return withV2QueryInvalidation(
      request<V2TopupSupplierFundMutationResult>(
        http.post(
          `/id-business-v2/topup-supplier-funds/suppliers/${supplierOptionId}/adjustments`,
          payload
        )
      ),
      [...invalidationScopes, 'balances-options']
    );
  },
  reversePayment(paymentId: string, payload: { reason: string; idempotencyKey: string }) {
    return withV2QueryInvalidation(
      request<V2TopupSupplierFundMutationResult>(
        http.post(`/id-business-v2/topup-supplier-funds/payments/${paymentId}/reversals`, payload)
      ),
      [...invalidationScopes, 'balances-options']
    );
  }
};
