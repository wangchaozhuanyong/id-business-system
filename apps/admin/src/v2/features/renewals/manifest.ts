import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

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
  columns: [
    { key: 'customer', label: '客户', kind: 'text', minWidth: 140 },
    { key: 'account', label: 'ID账号', kind: 'identifier', minWidth: 192 },
    { key: 'country', label: '国家', kind: 'text', minWidth: 110 },
    { key: 'websiteAccount', label: '客户网站账号', kind: 'identifier', minWidth: 160 },
    { key: 'balance', label: 'ID余额', kind: 'numeric', minWidth: 112 },
    { key: 'service', label: '开通业务', kind: 'text', minWidth: 140 },
    { key: 'dueAt', label: '到期时间', kind: 'date', minWidth: 165 },
    { key: 'status', label: '状态', kind: 'status', minWidth: 112 },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2RenewalsView.vue')
});
