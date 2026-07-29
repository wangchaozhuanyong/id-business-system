import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const ordersFeature = defineV2Feature({
  key: 'orders',
  title: '订单管理',
  group: '业务数据',
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
      options: ['保留 ID', '已卖出', '已收回']
    },
    { key: 'openedAt', label: '开通时间', kind: 'date-range' }
  ],
  columns: [
    { key: 'orderNo', label: '订单', minWidth: 182 },
    { key: 'createdAt', label: '创建时间', minWidth: 160 },
    { key: 'customer', label: '客户', minWidth: 140 },
    { key: 'service', label: '业务', minWidth: 140 },
    { key: 'account', label: '使用 ID', minWidth: 190 },
    { key: 'accountDisposition', label: 'ID 处理状态', minWidth: 118 },
    { key: 'appliedAccountCostAmount', label: '本单 ID 成本', minWidth: 128 },
    { key: 'websiteAccount', label: '客户网站账号', minWidth: 170 },
    { key: 'receivedAmount', label: '实收金额', minWidth: 120 },
    { key: 'profit', label: '利润', minWidth: 110 },
    { key: 'openedAt', label: '开通时间', minWidth: 160 },
    { key: 'dueAt', label: '到期时间', minWidth: 160 },
    { key: 'status', label: '状态', minWidth: 100 },
    {
      key: 'actions',
      label: '操作',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.wide,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2OrdersView.vue')
});
