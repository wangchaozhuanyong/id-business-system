import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const activationsFeature = defineV2Feature({
  key: 'activation-records',
  title: '开通记录',
  group: '记录',
  route: '/v2/records/activations',
  sourceSheet: '开通记录',
  permission: 'apple.activation.view',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '订单、客户、ID账号' },
    {
      key: 'status',
      label: '到期状态',
      kind: 'select',
      options: ['1小时内到期', '23小时内到期', '7天内到期', '已到期']
    },
    { key: 'dueAt', label: '到期时间', kind: 'date-range' }
  ],
  columns: [
    { key: 'order', label: '订单', kind: 'identifier', minWidth: 192 },
    { key: 'customer', label: '客户', kind: 'text', minWidth: 140 },
    { key: 'service', label: '业务', kind: 'text', minWidth: 140 },
    { key: 'account', label: '苹果ID', kind: 'identifier', minWidth: 192 },
    { key: 'websiteAccount', label: '客户网站账号', kind: 'identifier', minWidth: 160 },
    { key: 'openedAt', label: '开通日期', kind: 'date', minWidth: 165 },
    { key: 'dueAt', label: '到期日期', kind: 'date', minWidth: 165 },
    { key: 'status', label: '状态', kind: 'status', minWidth: 112 },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2ActivationsView.vue')
});
