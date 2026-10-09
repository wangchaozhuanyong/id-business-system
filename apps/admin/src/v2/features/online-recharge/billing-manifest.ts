import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeBillingFeature = defineV2Feature({
  key: 'online-recharge-billing',
  title: sectionTitles['billing'],
  group: '线上代充',
  route: '/v2/online-recharge/billing',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['billing'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-billing']
    ),
  loadView: () => import('./V2OnlineBillingView.vue')
});
