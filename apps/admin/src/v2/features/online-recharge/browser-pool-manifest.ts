import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeBrowserPoolFeature = defineV2Feature({
  key: 'online-recharge-browser-pool',
  title: sectionTitles['browser-pool'],
  group: '线上代充',
  route: '/v2/online-recharge/browser-pool',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['browser-pool'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-browser-pool']
    ),
  loadView: () => import('./V2OnlineBrowserPoolView.vue')
});
