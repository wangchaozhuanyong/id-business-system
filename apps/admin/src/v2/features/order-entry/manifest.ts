import { defineV2Feature } from '@/v2/features/feature';

export const orderEntryFeature = defineV2Feature({
  key: 'order-entry',
  title: '订单录入',
  group: '工作台',
  route: '/v2/workbench/order-entry',
  sourceSheet: '工作台-订单录入',
  permission: 'apple.order.create',
  kind: 'form',
  loadingTier: 'reference',
  keepAlive: true,
  filters: [],
  columns: [],
  loadView: () => import('./V2OrderEntryView.vue')
});
