import { defineV2Feature } from '@/v2/features/feature';

export const renewalWorkbenchFeature = defineV2Feature({
  key: 'renewal-workbench',
  title: '续费操作',
  group: '工作台',
  route: '/v2/workbench/renewals',
  sourceSheet: '工作台-续费操作',
  permission: 'apple.renewal_task.view',
  kind: 'list',
  loadingTier: 'critical',
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
    { key: 'customer', label: '客户', minWidth: 140 },
    { key: 'account', label: 'ID账号', minWidth: 190 },
    { key: 'country', label: '国家', minWidth: 110 },
    { key: 'websiteAccount', label: '客户网站账号', minWidth: 170 },
    { key: 'balance', label: 'ID余额', minWidth: 110 },
    { key: 'service', label: '开通业务', minWidth: 140 },
    { key: 'dueAt', label: '到期时间', minWidth: 160 },
    { key: 'status', label: '状态', minWidth: 130 },
    { key: 'actions', label: '操作', minWidth: 180, fixed: 'right' }
  ],
  loadView: () => import('./V2RenewalsView.vue')
});
