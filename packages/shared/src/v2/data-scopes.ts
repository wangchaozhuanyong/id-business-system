export const V2_DATA_SCOPES = [
  'account-losses',
  'accounts',
  'accounts-options',
  'activations',
  'balances',
  'balances-options',
  'balance-records',
  'balance-record-options',
  'customers',
  'customers-options',
  'exchange-rates',
  'employees',
  'finance-accounts',
  'finance-ledger',
  'finance-reports',
  'options',
  'options-page',
  'options-reference',
  'orders',
  'orders-options',
  'order-entry-manual-candidates',
  'order-entry-matching',
  'order-entry-options',
  'renewals',
  'renewals-options',
  'renewal-warning-settings',
  'renewal-warning-summary',
  'supplier-funds',
  'supplier-payments'
] as const;

export type V2DataScope = (typeof V2_DATA_SCOPES)[number];

export const V2_SCOPE_DEPENDENCIES = {
  'account-losses': [
    'account-losses',
    'accounts',
    'balances',
    'balance-records',
    'orders',
    'activations',
    'renewals',
    'renewal-warning-summary',
    'finance-ledger',
    'finance-reports',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  accounts: [
    'account-losses',
    'accounts',
    'balances',
    'balance-records',
    'orders',
    'renewals',
    'finance-ledger',
    'finance-reports',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  'accounts-options': ['accounts-options'],
  activations: [
    'activations',
    'orders',
    'renewals',
    'renewal-warning-summary',
    'balances',
    'balance-records',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  balances: [
    'balances',
    'accounts',
    'balance-records',
    'supplier-funds',
    'supplier-payments',
    'orders',
    'renewals',
    'finance-ledger',
    'finance-reports'
  ],
  'balances-options': ['balances-options'],
  'balance-records': [
    'account-losses',
    'balance-records',
    'supplier-funds',
    'supplier-payments',
    'balances',
    'accounts',
    'orders',
    'renewals',
    'finance-ledger',
    'finance-reports',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  'balance-record-options': ['balance-record-options'],
  customers: ['customers', 'orders', 'renewals', 'renewal-warning-summary', 'order-entry-options'],
  'customers-options': ['customers-options'],
  'exchange-rates': ['exchange-rates'],
  employees: ['employees'],
  'finance-accounts': ['finance-accounts', 'finance-reports'],
  'finance-ledger': ['finance-ledger', 'finance-accounts', 'finance-reports'],
  'finance-reports': ['finance-reports'],
  options: [
    'options',
    'options-page',
    'options-reference',
    'accounts-options',
    'customers-options',
    'balances-options',
    'balance-record-options',
    'orders-options',
    'order-entry-options',
    'renewals-options',
    'supplier-funds',
    'supplier-payments',
    'finance-reports',
    'accounts',
    'customers',
    'orders',
    'renewals',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  'options-page': ['options-page'],
  'options-reference': ['options-reference'],
  orders: [
    'orders',
    'activations',
    'renewals',
    'balances',
    'balance-records',
    'finance-ledger',
    'finance-reports',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  'orders-options': ['orders-options'],
  'order-entry-manual-candidates': ['order-entry-manual-candidates'],
  'order-entry-matching': ['order-entry-matching'],
  'order-entry-options': ['order-entry-options'],
  renewals: ['renewals', 'renewal-warning-summary'],
  'renewals-options': ['renewals-options'],
  'renewal-warning-settings': ['renewal-warning-settings', 'renewals', 'renewal-warning-summary'],
  'renewal-warning-summary': ['renewal-warning-summary'],
  'supplier-funds': [
    'supplier-funds',
    'supplier-payments',
    'balance-records',
    'finance-accounts',
    'finance-ledger',
    'finance-reports'
  ],
  'supplier-payments': [
    'supplier-payments',
    'supplier-funds',
    'finance-accounts',
    'finance-ledger',
    'finance-reports'
  ]
} as const satisfies Record<V2DataScope, readonly V2DataScope[]>;

const V2_DATA_SCOPE_SET = new Set<string>(V2_DATA_SCOPES);

export function isV2DataScope(value: unknown): value is V2DataScope {
  return typeof value === 'string' && V2_DATA_SCOPE_SET.has(value);
}

export function expandV2DataScopes(scopes: readonly V2DataScope[]) {
  return [...new Set(scopes.flatMap((scope) => V2_SCOPE_DEPENDENCIES[scope]))] as V2DataScope[];
}

export interface V2ScopeVersion {
  scope: V2DataScope;
  version: string;
}

export interface V2ChangeEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  scopes: V2ScopeVersion[];
}

export interface V2ChangeVersionsResult {
  generatedAt: string;
  versions: Record<V2DataScope, string>;
}
