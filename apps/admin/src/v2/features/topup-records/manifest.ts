import { defineV2Feature } from '@/v2/features/feature';

export const topupRecordsFeature = defineV2Feature({
  key: 'topup-records',
  title: '加卡记录',
  group: '业务中心',
  route: '/v2/records/topups',
  sourceSheet: '加卡记录',
  permission: 'apple.balance.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    {
      key: 'keyword',
      label: '搜索',
      kind: 'search',
      placeholder: '卡片名称、礼品卡尾号、ID、供应商'
    },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['加卡成功', '被赎回', '已撤回']
    },
    { key: 'changedAt', label: '变动时间', kind: 'date-range' }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['topup-records']
    ),
  loadView: () => import('./V2TopupRecordsView.vue')
});
