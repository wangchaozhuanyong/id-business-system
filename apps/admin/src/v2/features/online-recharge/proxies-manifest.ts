import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeProxiesFeature = defineV2Feature({
  key: 'online-recharge-proxies',
  title: sectionTitles['proxies'],
  group: '线上代充',
  route: '/v2/online-recharge/proxies',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['proxies'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-proxies']
    ),
  loadView: () => import('./V2OnlineProxiesView.vue')
});
