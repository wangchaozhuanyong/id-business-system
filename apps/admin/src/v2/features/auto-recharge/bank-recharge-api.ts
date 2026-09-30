import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';

const base = '/id-business-v2/bank-recharge';

export interface BankChatgptAccount {
  id: string;
  emailMasked: string;
  status: 'active' | 'disabled';
  subscriptionState: 'never_subscribed' | 'active' | 'due_soon' | 'expired' | 'unknown';
  dueAt: string | null;
  currentPlan: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  remark: string | null;
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
  id: string;
  orderNo: string;
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
    query: { page?: number; pageSize?: number; keyword?: string; subscriptionState?: string } = {}
  ) {
    return request<{ items: BankChatgptAccount[]; total: number; page: number; pageSize: number }>(
      http.get(`${base}/accounts`, { params: query, signal: options.signal })
    );
  },
  createAccount(input: { email: string; password: string; totpSecret: string; remark: string }) {
    return request<{ id: string }>(http.post(`${base}/accounts`, input));
  },
  importAccounts(
    accounts: Array<{ email: string; password: string; totpSecret: string; remark: string }>
  ) {
    return request<{ imported: number }>(http.post(`${base}/accounts/import`, { accounts }));
  },
  updateAccount(id: string, input: Record<string, unknown>) {
    return request<{ id: string }>(http.patch(`${base}/accounts/${id}`, input));
  },
  deleteAccount(id: string) {
    return request<{ id: string }>(http.delete(`${base}/accounts/${id}`));
  },
  totpCode(id: string) {
    return request<{ token: string; expiresAt: string }>(
      http.post(`${base}/accounts/${id}/totp-code`, {})
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
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: BankRechargeOrder[]; total: number; page: number; pageSize: number }>(
      http.get(`${base}/orders`, { params: query, signal: options.signal })
    );
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
      upstreamRefundReference?: string;
    }
  ) {
    return withV2QueryInvalidation(
      request<BankRechargeOrder>(http.post(`${base}/orders/${id}/refund`, input)),
      ['auto-recharge', 'renewals', 'renewal-warning-summary', 'finance-ledger', 'finance-reports']
    );
  }
};
