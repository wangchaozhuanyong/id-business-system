import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeSessionsFeature = defineV2Feature({
  key: 'online-recharge-sessions',
  title: sectionTitles['sessions'],
  group: '线上代充',
  route: '/v2/online-recharge/sessions',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['sessions'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-sessions']
    ),
  loadView: () => import('./V2OnlineSessionsView.vue')
});
