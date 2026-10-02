import type { V2DataScope } from '@apple-business/shared';

export const GOOGLE_SHEETS_CHANGE_DELAY_MS = 5_000;
export const GOOGLE_SHEETS_RECONCILE_MS = 30_000;
export const GOOGLE_SHEETS_REPORT_VERSION = '3';
export const GOOGLE_SHEETS_SOURCE_SCOPES = [
  'workspace',
  'orders',
  'customers',
  'options',
  'accounts',
  'balances',
  'balance-records',
  'activations',
  'renewals',
  'finance-accounts',
  'finance-ledger',
  'finance-reports',
  'supplier-funds',
  'supplier-payments',
  'auto-recharge'
] as const satisfies readonly V2DataScope[];

const sourceScopes = new Set<V2DataScope>(GOOGLE_SHEETS_SOURCE_SCOPES);
export function affectsGoogleSheetsReports(scope: V2DataScope) {
  return sourceScopes.has(scope);
}
