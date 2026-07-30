import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const topupRecordsFeature = defineV2Feature({
  key: 'topup-records',
  title: '加卡记录',
  group: '记录',
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
      placeholder: '礼品卡尾号、ID、供应商'
    },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['加卡成功', '被赎回', '已撤回']
    },
    { key: 'changedAt', label: '变动时间', kind: 'date-range' }
  ],
  columns: [
    { key: 'rowNumber', label: '序号', kind: 'index', widthPreset: 'index' },
    {
      key: 'giftCardCode',
      label: '礼品卡号',
      kind: 'identifier',
      widthPreset: 'identifier'
    },
    { key: 'faceValue', label: '面值', kind: 'numeric', widthPreset: 'compact' },
    { key: 'exchangeRate', label: '卡片汇率', kind: 'numeric', widthPreset: 'compact' },
    {
      key: 'costAmount',
      label: '本次人民币成本',
      kind: 'numeric',
      widthPreset: 'wide'
    },
    { key: 'account', label: '加入 ID', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'country', label: '国家', kind: 'text', widthPreset: 'compact' },
    { key: 'supplier', label: '供应商', kind: 'text', widthPreset: 'standard' },
    {
      key: 'balanceBefore',
      label: 'ID 加卡前余额',
      kind: 'numeric',
      widthPreset: 'wide'
    },
    {
      key: 'balanceAfter',
      label: 'ID 加卡后余额',
      kind: 'numeric',
      widthPreset: 'wide'
    },
    { key: 'changedAt', label: '加卡时间', kind: 'date', widthPreset: 'dateTime' },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.triple,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2TopupRecordsView.vue')
});
