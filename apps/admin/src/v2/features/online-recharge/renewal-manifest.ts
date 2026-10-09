import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeRenewalFeature = defineV2Feature({
  key: 'online-recharge-renewal',
  title: sectionTitles['renewal'],
  group: '线上代充',
  route: '/v2/online-recharge/renewal',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['renewal'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-renewal']
    ),
  loadView: () => import('./V2OnlineRenewalView.vue')
});
