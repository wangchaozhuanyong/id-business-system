import { onlineRechargeJobsFeature } from './jobs-manifest';
import { onlineRechargeAutomationFeature } from './automation-manifest';
import { onlineRechargeRuntimeLogsFeature } from './runtime-logs-manifest';
import { onlineRechargeBillingFeature } from './billing-manifest';
import { onlineRechargeCardsFeature } from './cards-manifest';
import { onlineRechargeProxiesFeature } from './proxies-manifest';
import { onlineRechargeAddressesFeature } from './addresses-manifest';
import { onlineRechargeBrowserPoolFeature } from './browser-pool-manifest';
import { onlineRechargeCdksFeature } from './cdks-manifest';
import { onlineRechargeSessionsFeature } from './sessions-manifest';
import { onlineRechargeRenewalFeature } from './renewal-manifest';
import { onlineRechargeCheckoutDebugFeature } from './checkout-debug-manifest';
import { onlineRechargeConfigFeature } from './config-manifest';
import { onlineRechargeLoginLogsFeature } from './login-logs-manifest';
import { defineV2Feature } from '@/v2/features/feature';
export const onlineRechargeOverviewFeature = defineV2Feature({
  key: 'online-recharge-overview',
  title: '概览中心',
  group: '线上代充',
  route: '/v2/online-recharge/overview',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-overview']
    ),
  loadView: () => import('./V2OnlineOverviewView.vue')
});
export const onlineRechargeFeatures = [
  onlineRechargeOverviewFeature,
  onlineRechargeJobsFeature,
  onlineRechargeAutomationFeature,
  onlineRechargeRuntimeLogsFeature,
  onlineRechargeBillingFeature,
  onlineRechargeCardsFeature,
  onlineRechargeProxiesFeature,
  onlineRechargeAddressesFeature,
  onlineRechargeBrowserPoolFeature,
  onlineRechargeCdksFeature,
  onlineRechargeSessionsFeature,
  onlineRechargeRenewalFeature,
  onlineRechargeCheckoutDebugFeature,
  onlineRechargeConfigFeature,
  onlineRechargeLoginLogsFeature
] as const;
