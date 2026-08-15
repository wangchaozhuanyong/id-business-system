export const V2_DATA_SCOPES = [
  'account-losses',
  'accounts',
  'accounts-options',
  'activations',
  'audit-logs',
  'balances',
  'balances-options',
  'balance-records',
  'balance-record-options',
  'branding',
  'customers',
  'customers-options',
  'data-governance',
  'dashboard',
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
  'security',
  'supplier-funds',
  'supplier-payments',
  'workspace'
] as const;

export type V2DataScope = (typeof V2_DATA_SCOPES)[number];

export const V2_SCOPE_DEPENDENCIES = {
  'account-losses': [
    'account-losses',
    'dashboard',
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
    'dashboard',
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
    'dashboard',
    'orders',
    'renewals',
    'renewal-warning-summary',
    'balances',
    'balance-records',
    'order-entry-matching',
    'order-entry-manual-candidates'
  ],
  'audit-logs': ['audit-logs', 'dashboard'],
  balances: [
    'balances',
    'dashboard',
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
    'dashboard',
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
  branding: ['branding'],
  customers: [
    'customers',
    'dashboard',
    'orders',
    'renewals',
    'renewal-warning-summary',
    'order-entry-options'
  ],
  'customers-options': ['customers-options'],
  'data-governance': ['data-governance', 'audit-logs', 'dashboard'],
  dashboard: ['dashboard'],
  'exchange-rates': ['exchange-rates', 'dashboard'],
  employees: ['employees', 'dashboard'],
  'finance-accounts': ['finance-accounts', 'finance-reports', 'dashboard'],
  'finance-ledger': ['finance-ledger', 'finance-accounts', 'finance-reports', 'dashboard'],
  'finance-reports': ['finance-reports', 'dashboard'],
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
    'finance-ledger',
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
    'dashboard',
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
  renewals: ['renewals', 'renewal-warning-summary', 'dashboard'],
  'renewals-options': ['renewals-options'],
  'renewal-warning-settings': ['renewal-warning-settings', 'renewals', 'renewal-warning-summary'],
  'renewal-warning-summary': ['renewal-warning-summary', 'dashboard'],
  security: ['security', 'audit-logs', 'dashboard'],
  'supplier-funds': [
    'supplier-funds',
    'dashboard',
    'supplier-payments',
    'balance-records',
    'finance-accounts',
    'finance-ledger',
    'finance-reports'
  ],
  'supplier-payments': [
    'supplier-payments',
    'dashboard',
    'supplier-funds',
    'finance-accounts',
    'finance-ledger',
    'finance-reports'
  ],
  workspace: ['workspace']
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
