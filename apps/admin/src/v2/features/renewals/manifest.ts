import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const renewalWorkbenchFeature = defineV2Feature({
  key: 'renewal-workbench',
  title: '续费操作',
  group: '工作台',
  route: '/v2/workbench/renewals',
  sourceSheet: '工作台-续费操作',
  permission: 'apple.renewal_task.view',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '订单、客户、ID账号、网站账号'
    },
    {
      key: 'status',
      label: '到期状态',
      kind: 'select',
      options: ['1小时内到期', '23小时内到期', '7天内到期', '已到期']
    },
    { key: 'dueAt', label: '到期时间', kind: 'date-range' }
  ],
  tables: v2TablesByFeature['renewal-workbench'],
  loadView: () => import('./V2RenewalsView.vue')
});
