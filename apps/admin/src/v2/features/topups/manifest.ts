import { defineV2Feature } from '@/v2/features/feature';

export const topupWorkbenchFeature = defineV2Feature({
  key: 'topup-workbench',
  title: '加卡',
  group: '工作台',
  route: '/v2/workbench/topups',
  sourceSheet: '工作台-加卡',
  permission: 'apple.balance.view',
  kind: 'list',
  loadingTier: 'critical',
  filters: [
    { key: 'country', label: '国家', kind: 'select', options: ['美国', '马来西亚'] },
    {
      key: 'balancePreset',
      label: '余额范围',
      kind: 'select',
      options: ['等于0', '大于0且小于20', '自定义']
    },
    { key: 'balance', label: '自定义余额', kind: 'number-range' }
  ],
  columns: [
    { key: 'account', label: 'ID账号', minWidth: 190 },
    { key: 'country', label: '国家', minWidth: 110 },
    { key: 'balance', label: '余额', minWidth: 110 },
    { key: 'averageCost', label: '平均成本', minWidth: 120 },
    { key: 'topupRecords', label: '加卡记录', minWidth: 120 },
    { key: 'balanceChanges', label: '余额流水', minWidth: 120 },
    { key: 'lastTopupAt', label: '最近加卡', minWidth: 130 },
    { key: 'updatedAt', label: '更新时间', minWidth: 160 },
    { key: 'currentServices', label: '当前业务', minWidth: 160 },
    { key: 'status', label: 'ID 状态', minWidth: 110 },
    { key: 'actions', label: '操作', minWidth: 100, fixed: 'right' }
  ],
  loadView: () => import('./V2TopupWorkbenchView.vue')
});
