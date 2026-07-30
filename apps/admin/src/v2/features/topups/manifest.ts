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
    { key: 'account', label: 'ID账号', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'country', label: '国家', kind: 'text', widthPreset: 'compact' },
    { key: 'balance', label: '余额', kind: 'numeric', widthPreset: 'compact' },
    { key: 'averageCost', label: '平均成本', kind: 'numeric', widthPreset: 'standard' },
    { key: 'topupRecords', label: '加卡记录', kind: 'text', widthPreset: 'standard' },
    {
      key: 'balanceChanges',
      label: '余额流水',
      kind: 'text',
      widthPreset: 'standard'
    },
    { key: 'lastTopupAt', label: '最近加卡', kind: 'date', widthPreset: 'dateTime' },
    { key: 'updatedAt', label: '更新时间', kind: 'date', widthPreset: 'dateTime' },
    { key: 'currentServices', label: '当前业务', kind: 'text', widthPreset: 'wide' },
    { key: 'status', label: 'ID 状态', kind: 'status', widthPreset: 'compact' },
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
