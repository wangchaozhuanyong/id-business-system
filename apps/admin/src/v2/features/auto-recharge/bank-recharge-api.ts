import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2AccountOffer } from '@apple-business/shared';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';

const base = '/id-business-v2/bank-recharge';

export type BankLifecycleEntity = 'account' | 'order';
export type BankLifecycleAction = 'cancel' | 'delete' | 'restore';
export interface BankLifecyclePreview {
  id: string;
  entity: BankLifecycleEntity;
  action: BankLifecycleAction;
  label: string;
  status: string;
  deletedAt: string | null;
  expectedUpdatedAt: string;
  references: Record<string, string | number | null>;
  previewFingerprint: string;
}
export interface BankSubscriptionReview {
  orderId: string;
  orderNo: string;
  expectedUpdatedAt: string;
  expectedCurrentOrderId: string | null;
  expectedSubscriptionUpdatedAt: string | null;
  openedAt: string | null;
  dueAt: string | null;
  currentOpenedAt: string | null;
}

export interface OpeningCardDeletion {
  cardId: string;
  orderId: string;
  label: string;
  last4: string;
  numberSummary: string | null;
  linkedAccountCount: number;
  orderCount: number;
  expectedUpdatedAt: string;
}

export interface BankChatgptAccount {
  openingCard?: {
    id: string | null;
    label: string | null;
    last4: string | null;
    numberSummary: string | null;
    deleted: boolean;
  } | null;
  id: string;
  deletedAt?: string | null;
  emailMasked: string;
  registrationCountryCode?: string | null;
  status: 'active' | 'disabled';
  subscriptionState: 'never_subscribed' | 'active' | 'due_soon' | 'expired' | 'unknown';
  dueAt: string | null;
  currentPlan: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  remark: string | null;
  offerStatus?: V2AccountOffer;
  offerSource?: 'automatic' | 'manual' | null;
  offerObservedAt?: string | null;
  firstLoginNetwork: { ip: string; countryCode: string; observedAt: string } | null;
  lastLoginNetwork: { ip: string; countryCode: string; observedAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface BankRechargeCurrency {
  code: string;
  name: string;
  minorUnits: number;
  active: boolean;
}

export interface BankRechargeCard {
  id: string;
  label: string;
  last4: string;
  currencyCode: string;
  active: boolean;
  hasNumber?: boolean;
  expiry?: string | null;
}

export interface ManagedBankRechargeCard {
  billingName: string | null;
  id: string;
  label: string;
  last4: string;
  expiry: string | null;
  currencyCode: string;
  status: 'active' | 'disabled';
  hasNumber: boolean;
  remark1: string | null;
  remark2: string | null;
  accountCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedBankRechargeCardDetail {
  id: string;
  label: string;
  number: string | null;
  last4: string;
  expiry: string | null;
  billingName: string | null;
  billingAddressId: string | null;
  currencyCode: string;
  status: 'active' | 'disabled';
  remark1: string | null;
  remark2: string | null;
}

export interface ManagedBankRechargeCardOrder {
  id: string;
  orderNo: string;
  accountId: string;
  account: { emailMasked: string } | null;
  chargeAmount: string;
  chargeCurrencyCode: string;
  status: BankRechargeOrderStatus;
  verifiedAt: string | null;
  createdAt: string;
}

export type BankRechargeOrderStatus =
  | 'pending_details'
  | 'pending_finance'
  | 'pending_receipt'
  | 'completed'
  | 'refunded'
  | 'cancelled';

export interface BankRechargeOrder {
  accountingVersion?: 'legacy' | 'subscription_cost_v2';
  usdtFeeAmount?: string | null;
  usdtFeeCurrencyCode?: string | null;
  usdtFeeFinanceAccountId?: string | null;
  usdtFeeFxRateToCny?: string | null;
  usdtFeeFxSnapshotId?: string | null;
  usdtFeeAmountCny?: string | null;
  shoppingFeeAmount?: string | null;
  shoppingFeeCurrencyCode?: string | null;
  shoppingFeeFinanceAccountId?: string | null;
  shoppingFeeFxRateToCny?: string | null;
  shoppingFeeFxSnapshotId?: string | null;
  shoppingFeeAmountCny?: string | null;

  id: string;
  orderNo: string;
  deletedAt?: string | null;
  source: 'automatic' | 'manual';
  rechargeJobId: string | null;
  accountId: string | null;
  account: { id: string; emailMasked: string } | null;
  customerId: string | null;
  customer: { id: string; name: string } | null;
  cardId: string | null;
  card: BankRechargeCard | null;
  activeSubscription: { status: 'active' | 'expired' | 'cancelled' } | null;
  cardLast4: string | null;
  plan: string;
  chargeAmount: string;
  chargeCurrencyCode: string;
  customerFeeRate: string;
  customerFeeAmount: string;
  customerFeeOverridden: boolean;
  bankFeeAmount: string | null;
  bankFeeCurrencyCode: string | null;
  receivedAmount: string | null;
  receivedCurrencyCode: string | null;
  chargeFxRateToCny: string | null;
  bankFeeFxRateToCny: string | null;
  receivedFxRateToCny: string | null;
  fundingFinanceAccountId: string | null;
  receivedFinanceAccountId: string | null;
  profitAmountCny: string | null;
  status: BankRechargeOrderStatus;
  financeStatus: 'unposted' | 'partial' | 'posted' | 'reversed';
  openedAt: string | null;
  dueAt: string | null;
  verifiedAt: string | null;
  manualEvidenceRef: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BankRechargeOrderOptions {
  customers: Array<{ id: string; name: string }>;
  financeAccounts: Array<{ id: string; name: string; currency: string; accountType: string }>;
}

export interface BankRechargeRenewalWarnings {
  warningDays: number;
  upcomingCount: number;
  expiredCount: number;
  totalCount: number;
  evaluatedAt: string;
  revalidateAt: string;
  items: Array<{
    id: string;
    orderId: string;
    orderNo: string;
    customerName: string;
    accountMasked: string;
    plan: string;
    dueAt: string;
    warningState: 'upcoming' | 'expired';
  }>;
}

export const bankRechargeApi = {
  listAccounts(
    options: ApiRequestOptions = {},
    query: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      subscriptionState?: string;
      offerStatus?: V2AccountOffer | 'all';
      deleted?: 'active' | 'deleted';
    } = {}
  ) {
    return request<{ items: BankChatgptAccount[]; total: number; page: number; pageSize: number }>(
      http.get(`${base}/accounts`, { params: query, signal: options.signal })
    );
  },
  createAccount(input: {
    email: string;
    password?: string;
    totpSecret?: string;
    remark?: string;
    registrationCountryCode?: string | null;
  }) {
    return request<{ id: string }>(http.post(`${base}/accounts`, input));
  },
  importAccounts(
    accounts: Array<{ email: string; password?: string; totpSecret?: string; remark?: string }>
  ) {
    return withV2QueryInvalidation(
      request<{ imported: number }>(http.post(`${base}/accounts/import`, { accounts })),
      'auto-recharge'
    );
  },
  copyAccount(id: string) {
    return request<{ text: string }>(http.post(`${base}/accounts/${id}/copy`, {}));
  },
  accountCopySettings(options: ApiRequestOptions = {}) {
    return request<{ suffix: string }>(
      http.get(`${base}/account-copy-settings`, { signal: options.signal })
    );
  },
  updateAccountCopySettings(suffix: string) {
    return withV2QueryInvalidation(
      request<{ suffix: string }>(http.put(`${base}/account-copy-settings`, { suffix })),
      'auto-recharge'
    );
  },
  updateAccount(id: string, input: Record<string, unknown>) {
    return request<{ id: string }>(http.patch(`${base}/accounts/${id}`, input));
  },
  deleteAccount(id: string, input: Record<string, unknown> = {}) {
    return request<{ id: string }>(http.delete(`${base}/accounts/${id}`, { data: input }));
  },
  lifecyclePreview(
    entity: BankLifecycleEntity,
    id: string,
    action: BankLifecycleAction,
    options: ApiRequestOptions = {}
  ) {
    return request<BankLifecyclePreview>(
      http.get(`${base}/${entity === 'account' ? 'accounts' : 'orders'}/${id}/lifecycle-preview`, {
        params: { action },
        signal: options.signal
      })
    );
  },
  lifecycle(
    entity: BankLifecycleEntity,
    id: string,
    action: BankLifecycleAction,
    input: Record<string, unknown>
  ) {
    const path = `${base}/${entity === 'account' ? 'accounts' : 'orders'}/${id}`;
    return withV2QueryInvalidation(
      request<{ id: string }>(
        action === 'delete'
          ? http.delete(path, { data: input })
          : http.post(`${path}/${action}`, input)
      ),
      ['auto-recharge', 'renewals', 'renewal-warning-summary']
    );
  },
  subscriptionReview(id: string, options: ApiRequestOptions = {}) {
    return request<BankSubscriptionReview>(
      http.get(`${base}/orders/${id}/subscription-review`, { signal: options.signal })
    );
  },
  verifySubscription(id: string, input: Record<string, unknown>) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.post(`${base}/orders/${id}/subscription-review`, input)),
      ['auto-recharge', 'renewals', 'renewal-warning-summary']
    );
  },
  totpCode(id: string, options: ApiRequestOptions = {}) {
    return request<{ token: string; expiresAt: string }>(
      http.post(`${base}/accounts/${id}/totp-code`, {}, { signal: options.signal })
    );
  },
  accountIdentity(id: string) {
    return request<{ id: string; email: string }>(http.get(`${base}/accounts/${id}/identity`));
  },
  loginCredential(id: string) {
    return request<{ email: string; password: string }>(
      http.post(`${base}/accounts/${id}/login-credential`, {})
    );
  },
  listCurrencies(options: ApiRequestOptions = {}) {
    return request<{ items: BankRechargeCurrency[] }>(
      http.get(`${base}/currencies`, { signal: options.signal })
    );
  },
  createCurrency(input: { code: string; name: string; minorUnits: number }) {
    return request<BankRechargeCurrency>(http.post(`${base}/currencies`, input));
  },
  listCards(options: ApiRequestOptions = {}) {
    return request<{ items: BankRechargeCard[] }>(
      http.get(`${base}/cards`, { signal: options.signal })
    );
  },
  createCard(input: { label: string; last4: string; currencyCode: string }) {
    return request<BankRechargeCard>(http.post(`${base}/cards`, input));
  },
  listManagedCards(
    query: {
      page: number;
      pageSize: number;
      keyword?: string;
      status?: string;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      items: ManagedBankRechargeCard[];
      total: number;
      page: number;
      pageSize: number;
    }>(http.get(`${base}/cards/management`, { params: query, signal: options.signal }));
  },
  managedCardDetail(id: string) {
    return request<ManagedBankRechargeCardDetail>(http.get(`${base}/cards/management/${id}`));
  },
  managedCardOrders(
    id: string,
    query: { page: number; pageSize: number },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      items: ManagedBankRechargeCardOrder[];
      total: number;
      page: number;
      pageSize: number;
    }>(
      http.get(`${base}/cards/management/${id}/orders`, { params: query, signal: options.signal })
    );
  },
  createManagedCard(input: Record<string, unknown>) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.post(`${base}/cards/management`, input)),
      'auto-recharge'
    );
  },
  importManagedCards(
    currencyCode: string,
    cards: Array<{ number: string; expiry: string; remark1: string; remark2: string }>
  ) {
    return withV2QueryInvalidation(
      request<{ imported: number }>(
        http.post(`${base}/cards/management/import`, { currencyCode, cards })
      ),
      'auto-recharge'
    );
  },
  openingCardDeletion(id: string) {
    return request<OpeningCardDeletion>(http.get(`${base}/accounts/${id}/opening-card-deletion`));
  },
  deleteOpeningCard(id: string, input: OpeningCardDeletion) {
    return withV2QueryInvalidation(
      request<{ deleted: true }>(
        http.delete(`${base}/accounts/${id}/opening-card`, {
          data: {
            cardId: input.cardId,
            orderId: input.orderId,
            expectedUpdatedAt: input.expectedUpdatedAt,
            linkedAccountCount: input.linkedAccountCount,
            orderCount: input.orderCount
          }
        })
      ),
      'auto-recharge'
    );
  },
  preparePaymentCard(input: {
    number: string;
    expiry: string;
    name: string;
    currencyCode: string;
  }) {
    return request<{ cardId: string }>(
      http.post('/id-business-v2/auto-recharge/names/payment-card', input)
    );
  },
  matchCardName(number: string) {
    return request<{
      name: string;
      confirmed: boolean;
      cardId: string | null;
      billingAddressId: string | null;
    }>(http.post('/id-business-v2/auto-recharge/names/match', { number }));
  },
  checkCardAvailability(number: string) {
    return request<{ available: true }>(
      http.post(`${base}/cards/management/availability`, { number })
    );
  },
  updateManagedCard(id: string, input: Record<string, unknown>) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.patch(`${base}/cards/management/${id}`, input)),
      'auto-recharge'
    );
  },
  deleteManagedCard(id: string) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.delete(`${base}/cards/management/${id}`)),
      'auto-recharge'
    );
  },
  renewalWarnings(options: ApiRequestOptions = {}) {
    return request<BankRechargeRenewalWarnings>(
      http.get(`${base}/renewal-warnings`, { signal: options.signal })
    );
  },
  listOrders(
    query: {
      page: number;
      pageSize: number;
      keyword?: string;
      status?: string;
      accountId?: string;
      expiry?: 'all' | 'expired';
      deleted?: 'active' | 'deleted';
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      items: BankRechargeOrder[];
      total: number;
      page: number;
      pageSize: number;
      evaluatedAt: string;
      revalidateAt: string;
    }>(http.get(`${base}/orders`, { params: query, signal: options.signal }));
  },
  orderOptions(options: ApiRequestOptions = {}) {
    return request<BankRechargeOrderOptions>(
      http.get(`${base}/orders/options`, { signal: options.signal })
    );
  },
  createManualOrder(input: Record<string, unknown>) {
    return withV2QueryInvalidation(request<BankRechargeOrder>(http.post(`${base}/orders`, input)), [
      'auto-recharge',
      'renewals',
      'renewal-warning-summary'
    ]);
  },
  updateOrder(id: string, input: Record<string, unknown>) {
    return withV2QueryInvalidation(
      request<BankRechargeOrder>(http.patch(`${base}/orders/${id}`, input)),
      ['auto-recharge', 'renewals', 'renewal-warning-summary']
    );
  },
  correctOrder(id: string, input: Record<string, unknown>) {
    return withV2QueryInvalidation(
      request<BankRechargeOrder>(http.post(`${base}/orders/${id}/correct`, input)),
      ['auto-recharge', 'renewals', 'renewal-warning-summary', 'finance-ledger', 'finance-reports']
    );
  },
  completeOrder(id: string, expectedUpdatedAt: string) {
    return withV2QueryInvalidation(
      request<BankRechargeOrder>(http.post(`${base}/orders/${id}/complete`, { expectedUpdatedAt })),
      ['auto-recharge', 'renewals', 'renewal-warning-summary', 'finance-ledger', 'finance-reports']
    );
  },
  refundOrder(
    id: string,
    input: {
      expectedUpdatedAt: string;
      reason: string;
      refundReference: string;
      customerRefundAmount?: string;
      chargeRecoveryAmountCny?: string;
      bankFeeRecoveryAmountCny?: string;
      usdtFeeRecoveryAmount?: string;
      shoppingFeeRecoveryAmount?: string;
      upstreamRefundReference?: string;
    }
  ) {
    return withV2QueryInvalidation(
      request<BankRechargeOrder>(http.post(`${base}/orders/${id}/refund`, input)),
      ['auto-recharge', 'renewals', 'renewal-warning-summary', 'finance-ledger', 'finance-reports']
    );
  }
};
