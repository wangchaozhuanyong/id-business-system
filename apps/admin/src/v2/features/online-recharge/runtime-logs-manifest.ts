import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeRuntimeLogsFeature = defineV2Feature({
  key: 'online-recharge-runtime-logs',
  title: sectionTitles['runtime-logs'],
  group: '线上代充',
  route: '/v2/online-recharge/runtime-logs',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['runtime-logs'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-runtime-logs']
    ),
  loadView: () => import('./V2OnlineRuntimeLogsView.vue')
});
