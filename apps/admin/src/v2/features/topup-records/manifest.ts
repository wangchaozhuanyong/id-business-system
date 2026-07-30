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
    { key: 'rowNumber', label: '序号', kind: 'index', minWidth: 72 },
    { key: 'giftCardCode', label: '礼品卡号', kind: 'identifier', minWidth: 192 },
    { key: 'faceValue', label: '面值', kind: 'numeric', minWidth: 112 },
    { key: 'exchangeRate', label: '卡片汇率', kind: 'numeric', minWidth: 112 },
    { key: 'costAmount', label: '本次人民币成本', kind: 'numeric', minWidth: 136 },
    { key: 'account', label: '加入 ID', kind: 'identifier', minWidth: 192 },
    { key: 'country', label: '国家', kind: 'text', minWidth: 110 },
    { key: 'supplier', label: '供应商', kind: 'text', minWidth: 120 },
    { key: 'balanceBefore', label: 'ID 加卡前余额', kind: 'numeric', minWidth: 136 },
    { key: 'balanceAfter', label: 'ID 加卡后余额', kind: 'numeric', minWidth: 136 },
    { key: 'supplierBalanceBefore', label: '供应商扣款前余额', kind: 'numeric', minWidth: 152 },
    { key: 'supplierBalanceAfter', label: '供应商扣款后余额', kind: 'numeric', minWidth: 152 },
    { key: 'changedAt', label: '加卡时间', kind: 'date', minWidth: 165 },
    { key: 'status', label: '状态', kind: 'status', minWidth: 112 },
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
