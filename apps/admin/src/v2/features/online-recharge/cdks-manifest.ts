import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeCdksFeature = defineV2Feature({
  key: 'online-recharge-cdks',
  title: sectionTitles['cdks'],
  group: '线上代充',
  route: '/v2/online-recharge/cdks',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['cdks'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-cdks']
    ),
  loadView: () => import('./V2OnlineCdksView.vue')
});
