import {
  defineV2RuntimeFeature,
  type V2ModuleKey,
  type V2NavigationSection,
  type V2RuntimeFeatureManifest
} from '@/v2/features/feature';

export const v2RuntimeFeatureRegistry: readonly V2RuntimeFeatureManifest[] = [
  defineV2RuntimeFeature({
    key: 'renewal-workbench',
    title: '续费操作',
    group: '工作台',
    route: '/v2/workbench/renewals',
    permission: 'apple.renewal_task.view',
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./renewals/V2RenewalsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'order-entry',
    title: '订单录入',
    group: '工作台',
    route: '/v2/workbench/order-entry',
    permission: 'apple.order.create',
    kind: 'form',
    freshnessPolicy: 'event-with-deadline',
    keepAlive: true,
    loadView: () => import('./order-entry/V2OrderEntryView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'topup-workbench',
    title: 'ID加额',
    group: '工作台',
    route: '/v2/workbench/topups',
    permission: 'apple.balance.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./topups/V2TopupWorkbenchView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'accounts',
    title: 'ID录入',
    group: '业务数据',
    route: '/v2/accounts',
    permission: 'apple.account.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./accounts/V2AccountsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'orders',
    title: '订单管理',
    group: '业务数据',
    route: '/v2/orders',
    permission: 'apple.order.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./orders/V2OrdersView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'customers',
    title: '客户记录',
    group: '业务数据',
    route: '/v2/customers',
    permission: 'customer.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./customers/V2CustomersView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'topup-records',
    title: '加卡记录',
    group: '记录',
    route: '/v2/records/topups',
    permission: 'apple.balance.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./topup-records/V2TopupRecordsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'account-losses',
    title: 'ID报损记录',
    group: '记录',
    route: '/v2/records/account-losses',
    permission: 'apple.balance.view',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./account-losses/V2AccountLossesView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'activation-records',
    title: '开通记录',
    group: '记录',
    route: '/v2/records/activations',
    permission: 'apple.activation.view',
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./activations/V2ActivationsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'exchange-rates',
    title: '汇率记录',
    group: '系统',
    route: '/v2/exchange-rates',
    permission: 'apple.exchange_rate.view',
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./exchange-rates/V2ExchangeRatesView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'options',
    title: '选项设置',
    group: '系统',
    route: '/v2/options',
    permission: 'data.dictionary.manage',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./options/V2OptionsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'dashboard',
    title: '仪表盘',
    group: '总览',
    route: '/v2/dashboard',
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./dashboard/V2DashboardView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'analytics',
    title: '经营分析',
    group: '数据中心',
    route: '/v2/data/analytics',
    permission: 'data.analytics.view',
    status: 'ready',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./data-analytics/V2DataAnalyticsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'finance-ledger',
    title: '财务记账',
    group: '数据中心',
    route: '/v2/data/finance',
    permission: 'finance.view',
    status: 'ready',
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./finance-ledger/V2FinanceLedgerView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'data-governance',
    title: '数据治理',
    group: '数据中心',
    route: '/v2/data/governance',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./data-governance/V2DataGovernanceView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'business-monitoring',
    title: '业务监控',
    group: '监控中心',
    route: '/v2/monitoring/business',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./business-monitoring/V2BusinessMonitoringView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'system-monitoring',
    title: '系统监控',
    group: '监控中心',
    route: '/v2/monitoring/system',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./system-monitoring/V2SystemMonitoringView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'employees',
    title: '员工账户',
    group: '系统管理',
    route: '/v2/system/employees',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./employees/V2EmployeesView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'roles',
    title: '角色权限',
    group: '系统管理',
    route: '/v2/system/roles',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-driven',
    loadView: () => import('./roles/V2RolesView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'audit-logs',
    title: '审计日志',
    group: '系统管理',
    route: '/v2/system/audit-logs',
    permission: 'audit_log.view',
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./audit-logs/V2AuditLogsView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'security',
    title: '安全中心',
    group: '系统管理',
    route: '/v2/system/security',
    requiredRoles: ['admin'],
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./security/V2SecurityView.vue')
  }),
  defineV2RuntimeFeature({
    key: 'profile',
    title: '我的账户',
    group: '个人',
    route: '/v2/profile',
    navigation: false,
    kind: 'list',
    freshnessPolicy: 'event-with-deadline',
    loadView: () => import('./profile/V2ProfileView.vue')
  })
];

export const v2ModuleDefinitions = v2RuntimeFeatureRegistry;

const featureByKey = new Map<V2ModuleKey, V2RuntimeFeatureManifest>(
  v2RuntimeFeatureRegistry.map((feature) => [feature.key, feature])
);

export const v2WorkbenchModules = v2RuntimeFeatureRegistry.filter(
  (feature) => feature.group === '工作台'
);

function navigationItems(...groups: string[]) {
  return v2RuntimeFeatureRegistry.filter(
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
    title: '业务数据',
    items: navigationItems('业务数据')
  },
  {
    key: 'records',
    title: '记录中心',
    items: navigationItems('记录')
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

export function getV2RuntimeModuleDefinition(key: unknown) {
  return typeof key === 'string' ? featureByKey.get(key as V2ModuleKey) : undefined;
}
