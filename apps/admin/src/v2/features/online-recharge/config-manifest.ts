import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeConfigFeature = defineV2Feature({
  key: 'online-recharge-config',
  title: sectionTitles['config'],
  group: '线上代充',
  route: '/v2/online-recharge/config',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['config'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-config']
    ),
  loadView: () => import('./V2OnlineConfigView.vue')
});
