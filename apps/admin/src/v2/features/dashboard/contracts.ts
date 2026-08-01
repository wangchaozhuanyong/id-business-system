export interface V2DashboardAccess {
  orders: boolean;
  activations: boolean;
  renewals: boolean;
  accounts: boolean;
  balances: boolean;
  exchangeRates: boolean;
  finance: boolean;
  audit: boolean;
}

export interface V2DashboardBusinessMetrics {
  todayOrders: number | null;
  todayCompletedOrders: number | null;
  todayActivations: number | null;
  todayTopups: number | null;
  todayTopupCostCny: string | null;
  todayRevenueCny: string | null;
  todayProfitCny: string | null;
}

export interface V2DashboardRiskMetrics {
  pendingOrders: number | null;
  failedOrders: number | null;
  overdueRenewals: number | null;
  dueSoonRenewals: number | null;
  lowBalanceAccounts: number | null;
  failedExchangeRuns: number | null;
}

export interface V2DashboardAssets {
  totalAccounts: number | null;
  availableAccounts: number | null;
  inventoryBookValueCny: string | null;
  financeHistoryStatus: 'not_started' | 'in_progress' | 'incomplete' | 'completed' | null;
}

export type V2DashboardOrderStatus =
  | 'draft'
  | 'pending'
  | 'waiting_external'
  | 'processing'
  | 'completed'
  | 'refunded'
  | 'cancelled'
  | 'failed';

export interface V2DashboardRecentOrder {
  id: string;
  orderNo: string;
  status: V2DashboardOrderStatus;
  receivedAmount: string;
  profitAmount: string | null;
  createdAt: string;
  customer: { name: string };
  serviceOption: { name: string };
}

export interface V2DashboardUpcomingRenewal {
  id: string;
  status: 'active';
  dueAt: string | null;
  customer: { name: string };
  serviceOption: { name: string };
  account: { appleIdMasked: string };
}

export interface V2DashboardRecentAudit {
  id: string;
  module: string;
  action: string;
  objectType?: string | null;
  createdAt: string;
  user?: { username: string; displayName: string } | null;
}

export interface V2DashboardOverview {
  generatedAt: string;
  businessDate: string;
  timezone: 'Asia/Kuala_Lumpur';
  warningDays: number;
  access: V2DashboardAccess;
  business: V2DashboardBusinessMetrics;
  risks: V2DashboardRiskMetrics;
  assets: V2DashboardAssets;
  recentOrders: V2DashboardRecentOrder[];
  upcomingRenewals: V2DashboardUpcomingRenewal[];
  recentAudits: V2DashboardRecentAudit[];
}
