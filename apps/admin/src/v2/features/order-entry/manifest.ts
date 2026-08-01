import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const orderEntryFeature = defineV2Feature({
  key: 'order-entry',
  title: '订单录入',
  group: '工作台',
  route: '/v2/workbench/order-entry',
  sourceSheet: '工作台-订单录入',
  permission: 'apple.order.create',
  kind: 'form',
  freshnessPolicy: 'event-with-deadline',
  keepAlive: true,
  filters: [],
  tables: v2TablesByFeature['order-entry'],
  loadView: () => import('./V2OrderEntryView.vue')
});
