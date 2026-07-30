import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  V2BalanceLedgerListQuery,
  V2BalanceLedgerListResult,
  V2GiftCardMetadataPayload,
  V2GiftCardCreditPayload,
  V2GiftCardCreditResult,
  V2GiftCardRecord,
  V2GiftCardRecordListQuery,
  V2GiftCardRecordListResult,
  V2GiftCardReversalPayload,
  V2GiftCardReversalResult,
  V2ReversibleGiftCardListResult,
  V2TopupWorkbenchListQuery,
  V2TopupWorkbenchListResult
} from '@/v2/types/balances';
import type { V2OptionSelector } from '@/v2/types/options';
import type { V2TopupSupplierFundSelector } from '@/v2/types/topupSupplierFunds';

export const idBusinessV2BalancesApi = {
  listTopupWorkbench(params: V2TopupWorkbenchListQuery, options: ApiRequestOptions = {}) {
    return request<V2TopupWorkbenchListResult>(
      http.get('/id-business-v2/balances/workbench', {
        params,
        signal: options.signal
      })
    );
  },
  bootstrapTopupWorkbench(params: V2TopupWorkbenchListQuery, options: ApiRequestOptions = {}) {
    return request<{
      list: V2TopupWorkbenchListResult;
      options: {
        cardNames: V2OptionSelector[];
        countries: V2OptionSelector[];
        suppliers: V2TopupSupplierFundSelector[];
      };
      generatedAt: string;
    }>(
      http.get('/id-business-v2/balances/workbench/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  confirmGiftCardCredit(accountId: string, payload: V2GiftCardCreditPayload) {
    return withV2QueryInvalidation(
      request<V2GiftCardCreditResult>(
        http.post(`/id-business-v2/gift-cards/${accountId}/credits`, payload)
      ),
      [
        'balances',
        'balance-records',
        'accounts',
        'orders',
        'renewals',
        'order-entry-options',
        'order-entry-matching',
        'finance-accounts',
        'finance-ledger',
        'finance-reports'
      ]
    );
  },
  listReversibleGiftCards(accountId: string) {
    return request<V2ReversibleGiftCardListResult>(
      http.get(`/id-business-v2/gift-cards/${accountId}/reversible`)
    );
  },
  reverseGiftCard(giftCardId: string, payload: V2GiftCardReversalPayload) {
    return withV2QueryInvalidation(
      request<V2GiftCardReversalResult>(
        http.post(`/id-business-v2/gift-cards/${giftCardId}/reversals`, payload)
      ),
      [
        'balances',
        'balance-records',
        'accounts',
        'account-losses',
        'activations',
        'orders',
        'renewals',
        'renewal-warning-summary',
        'order-entry-options',
        'order-entry-matching',
        'order-entry-manual-candidates',
        'finance-accounts',
        'finance-ledger',
        'finance-reports'
      ]
    );
  },
  listGiftCardRecords(params: V2GiftCardRecordListQuery, options: ApiRequestOptions = {}) {
    return request<V2GiftCardRecordListResult>(
      http.get('/id-business-v2/gift-cards/records', {
        params,
        signal: options.signal
      })
    );
  },
  listBalanceLedger(params: V2BalanceLedgerListQuery, options: ApiRequestOptions = {}) {
    return request<V2BalanceLedgerListResult>(
      http.get('/id-business-v2/gift-cards/balance-ledger', {
        params,
        signal: options.signal
      })
    );
  },
  bootstrapRecords(
    params:
      | ({ tab: 'giftCards' } & V2GiftCardRecordListQuery)
      | ({ tab: 'ledger' } & V2BalanceLedgerListQuery),
    options: ApiRequestOptions = {}
  ) {
    return request<
      | {
          tab: 'giftCards';
          list: V2GiftCardRecordListResult;
          options: {
            cardNames: V2OptionSelector[];
            countries: V2OptionSelector[];
            suppliers: V2OptionSelector[];
          };
          generatedAt: string;
        }
      | {
          tab: 'ledger';
          list: V2BalanceLedgerListResult;
          options: {
            cardNames: V2OptionSelector[];
            countries: V2OptionSelector[];
            suppliers: V2OptionSelector[];
          };
          generatedAt: string;
        }
    >(
      http.get('/id-business-v2/gift-cards/records/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  updateGiftCardMetadata(giftCardId: string, payload: V2GiftCardMetadataPayload) {
    return withV2QueryInvalidation(
      request<V2GiftCardRecord>(
        http.patch(`/id-business-v2/gift-cards/${giftCardId}/metadata`, payload)
      ),
      ['balance-records']
    );
  },
  reassignGiftCardSupplier(
    giftCardId: string,
    payload: { supplierOptionId: string; reason: string; idempotencyKey: string }
  ) {
    return withV2QueryInvalidation(
      request<{
        giftCardId: string;
        supplier: V2OptionSelector;
        legacyCutoverRecord: boolean;
        idempotentReplay: boolean;
      }>(http.post(`/id-business-v2/gift-cards/${giftCardId}/supplier-reassignments`, payload)),
      ['balance-records', 'supplier-funds', 'supplier-payments', 'balances-options']
    );
  }
};
