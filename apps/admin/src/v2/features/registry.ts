import { accountsFeature } from '@/v2/features/accounts/manifest';
import { accountLossesFeature } from '@/v2/features/account-losses/manifest';
import { activationsFeature } from '@/v2/features/activations/manifest';
import { auditLogsFeature } from '@/v2/features/audit-logs/manifest';
import { brandingFeature } from '@/v2/features/branding/manifest';
import { businessMonitoringFeature } from '@/v2/features/business-monitoring/manifest';
import { customersFeature } from '@/v2/features/customers/manifest';
import { dashboardFeature } from '@/v2/features/dashboard/manifest';
import { dataAnalyticsFeature } from '@/v2/features/data-analytics/manifest';
import { dataGovernanceFeature } from '@/v2/features/data-governance/manifest';
import { employeesFeature } from '@/v2/features/employees/manifest';
import { exchangeRatesFeature } from '@/v2/features/exchange-rates/manifest';
import { financeExpensesFeature } from '@/v2/features/finance-expenses/manifest';
import { financeLedgerFeature } from '@/v2/features/finance-ledger/manifest';
import type { V2FeatureManifest, V2ModuleKey, V2NavigationSection } from '@/v2/features/feature';
import { optionsFeature } from '@/v2/features/options/manifest';
import { orderEntryFeature } from '@/v2/features/order-entry/manifest';
import { ordersFeature } from '@/v2/features/orders/manifest';
import { profileFeature } from '@/v2/features/profile/manifest';
import { renewalWorkbenchFeature } from '@/v2/features/renewals/manifest';
import { rolesFeature } from '@/v2/features/roles/manifest';
import { securityFeature } from '@/v2/features/security/manifest';
import { systemMonitoringFeature } from '@/v2/features/system-monitoring/manifest';
import { topupRecordsFeature } from '@/v2/features/topup-records/manifest';
import { topupWorkbenchFeature } from '@/v2/features/topups/manifest';

export const v2FeatureRegistry: readonly V2FeatureManifest[] = [
  renewalWorkbenchFeature,
  orderEntryFeature,
  topupWorkbenchFeature,
  accountsFeature,
  ordersFeature,
  customersFeature,
  topupRecordsFeature,
  accountLossesFeature,
  activationsFeature,
  exchangeRatesFeature,
  optionsFeature,
  dashboardFeature,
  financeLedgerFeature,
  financeExpensesFeature,
  dataAnalyticsFeature,
  dataGovernanceFeature,
  businessMonitoringFeature,
  systemMonitoringFeature,
  brandingFeature,
  employeesFeature,
  rolesFeature,
  auditLogsFeature,
  securityFeature,
  profileFeature
];

// Compatibility alias while existing V2 consumers migrate to the feature vocabulary.
export const v2ModuleDefinitions = v2FeatureRegistry;

const featureByKey = new Map<V2ModuleKey, V2FeatureManifest>(
  v2FeatureRegistry.map((feature) => [feature.key, feature])
);

export const v2WorkbenchModules = v2FeatureRegistry.filter((feature) => feature.group === '工作台');

function navigationItems(...groups: string[]) {
  return v2FeatureRegistry.filter(
    (feature) => feature.navigation !== false && groups.includes(feature.group)
  );
}

export const v2NavigationSections: readonly V2NavigationSection[] = [
  {
    key: 'overview',
    title: '总览',
    items: navigationItems('总览')
  },
  { key: 'workspace', title: '工作台', items: v2WorkbenchModules },
  {
    key: 'business',
    title: '业务中心',
    items: navigationItems('业务中心')
  },
  {
    key: 'finance',
    title: '财务记账',
    items: navigationItems('财务记账')
  },
  {
    key: 'data',
    title: '数据中心',
    items: navigationItems('数据中心')
  },
  {
    key: 'monitoring',
    title: '监控中心',
    items: navigationItems('监控中心')
  },
  {
    key: 'system',
    title: '系统管理',
    items: navigationItems('系统', '系统管理')
  }
];

export function getV2ModuleDefinition(key: unknown) {
  return typeof key === 'string' ? featureByKey.get(key as V2ModuleKey) : undefined;
}
