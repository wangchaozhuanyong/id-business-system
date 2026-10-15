import { defineV2Feature } from '@/v2/features/feature';

export const onlineRechargeRedeemFeature = defineV2Feature({
  key: 'online-recharge-redeem',
  title: '兑换充值',
  group: '线上代充',
  route: '/v2/online-recharge/redeem',
  sourceSheet: '线上代充',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  filters: [],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['online-recharge-redeem']
    ),
  loadView: () => import('./V2OnlineRedeemView.vue')
});
