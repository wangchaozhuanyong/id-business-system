import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeAutomationFeature = defineV2Feature({
  key: 'online-recharge-automation',
  title: sectionTitles['automation'],
  group: '线上代充',
  route: '/v2/online-recharge/automation',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['automation'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-automation']
    ),
  loadView: () => import('./V2OnlineAutomationView.vue')
});
