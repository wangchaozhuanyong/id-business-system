import { defineV2Feature } from '@/v2/features/feature';

export const activationsFeature = defineV2Feature({
  key: 'activation-records',
  title: '开通记录',
  group: '业务中心',
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
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['activation-records']
    ),
  loadView: () => import('./V2ActivationsView.vue')
});
