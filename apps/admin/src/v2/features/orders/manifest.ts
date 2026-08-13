import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const ordersFeature = defineV2Feature({
  key: 'orders',
  title: '订单管理',
  group: '业务中心',
  route: '/v2/orders',
  sourceSheet: '订单管理',
  permission: 'apple.order.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '订单号、客户、平台订单号'
    },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['草稿', '待处理', '处理中', '已完成', '已退款', '已取消', '失败']
    },
    {
      key: 'accountDisposition',
      label: 'ID 处理状态',
      kind: 'select',
      options: ['保留 ID', '已卖出', 'ID 已退款']
    },
    { key: 'openedAt', label: '开通时间', kind: 'date-range' }
  ],
  tables: v2TablesByFeature['orders'],
  loadView: () => import('./V2OrdersView.vue')
});
