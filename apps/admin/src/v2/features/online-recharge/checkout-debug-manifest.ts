import { defineV2Feature } from '@/v2/features/feature';
import { sectionTitles, sectionDescriptions } from './sections';
export const onlineRechargeCheckoutDebugFeature = defineV2Feature({
  key: 'online-recharge-checkout-debug',
  title: sectionTitles['checkout-debug'],
  group: '线上代充',
  route: '/v2/online-recharge/checkout-debug',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  summary: sectionDescriptions['checkout-debug'],
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-checkout-debug']
    ),
  loadView: () => import('./V2OnlineCheckoutDebugView.vue')
});
