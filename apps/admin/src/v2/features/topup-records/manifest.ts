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
    { key: 'rowNumber', label: '序号', minWidth: 72 },
    { key: 'giftCardCode', label: '礼品卡号', minWidth: 190 },
    { key: 'faceValue', label: '面值', minWidth: 100 },
    { key: 'exchangeRate', label: '卡片汇率', minWidth: 120 },
    { key: 'account', label: '加入 ID', minWidth: 190 },
    { key: 'country', label: '国家', minWidth: 110 },
    { key: 'supplier', label: '供应商', minWidth: 120 },
    { key: 'balanceBefore', label: '加入前余额', minWidth: 130 },
    { key: 'balanceAfter', label: '加入后余额', minWidth: 130 },
    { key: 'changedAt', label: '变动时间', minWidth: 160 },
    { key: 'status', label: '状态', minWidth: 110 },
    {
      key: 'actions',
      label: '操作',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.triple,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2TopupRecordsView.vue')
});
