import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeJobsFeature = defineV2Feature({
  key: 'online-recharge-jobs',
  title: sectionTitles['jobs'],
  group: '线上代充',
  route: '/v2/online-recharge/jobs',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['jobs'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-jobs']
    ),
  loadView: () => import('./V2OnlineJobsView.vue')
});
