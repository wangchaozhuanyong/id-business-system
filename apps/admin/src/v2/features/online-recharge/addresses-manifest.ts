import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeAddressesFeature = defineV2Feature({
  key: 'online-recharge-addresses',
  title: sectionTitles['addresses'],
  group: '线上代充',
  route: '/v2/online-recharge/addresses',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['addresses'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-addresses']
    ),
  loadView: () => import('./V2OnlineAddressesView.vue')
});
