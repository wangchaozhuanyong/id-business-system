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
    { key: 'customer', label: '客户', kind: 'text', widthPreset: 'wide' },
    { key: 'account', label: 'ID账号', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'country', label: '国家', kind: 'text', widthPreset: 'compact' },
    {
      key: 'websiteAccount',
      label: '客户网站账号',
      kind: 'identifier',
      widthPreset: 'wide'
    },
    { key: 'balance', label: 'ID余额', kind: 'numeric', widthPreset: 'compact' },
    { key: 'service', label: '开通业务', kind: 'text', widthPreset: 'wide' },
    { key: 'dueAt', label: '到期时间', kind: 'date', widthPreset: 'dateTime' },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
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
