import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const topupWorkbenchFeature = defineV2Feature({
  key: 'topup-workbench',
  title: 'ID加额',
  group: '工作台',
  route: '/v2/workbench/topups',
  sourceSheet: '工作台-加卡',
  permission: 'apple.balance.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
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
    { key: 'account', label: 'ID账号', kind: 'identifier', minWidth: 192 },
    { key: 'country', label: '国家', kind: 'text', minWidth: 110 },
    { key: 'balance', label: '余额', kind: 'numeric', minWidth: 112 },
    { key: 'averageCost', label: '平均成本', kind: 'numeric', minWidth: 128 },
    { key: 'topupRecords', label: '加卡记录', kind: 'text', minWidth: 120 },
    { key: 'balanceChanges', label: '余额流水', kind: 'text', minWidth: 120 },
    { key: 'lastTopupAt', label: '最近加卡', kind: 'date', minWidth: 165 },
    { key: 'updatedAt', label: '更新时间', kind: 'date', minWidth: 165 },
    { key: 'currentServices', label: '当前业务', kind: 'text', minWidth: 160 },
    { key: 'status', label: 'ID 状态', kind: 'status', minWidth: 112 },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2TopupWorkbenchView.vue')
});
