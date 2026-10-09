import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeLoginLogsFeature = defineV2Feature({
  key: 'online-recharge-login-logs',
  title: sectionTitles['login-logs'],
  group: '线上代充',
  route: '/v2/online-recharge/login-logs',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['login-logs'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-login-logs']
    ),
  loadView: () => import('./V2OnlineLoginLogsView.vue')
});
