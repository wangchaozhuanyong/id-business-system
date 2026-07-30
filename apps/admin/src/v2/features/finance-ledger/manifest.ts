import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

export const financeLedgerFeature = defineV2Feature({
  key: 'finance-ledger',
  title: '财务记账',
  group: '数据中心',
  route: '/v2/data/finance',
  sourceSheet: '多币种财务账务',
  permission: 'finance.view',
  status: 'ready',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '管理资金账户、供应商钱包、经营开支、不可变流水和月度关账。',
  filters: [
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USDT'] },
    { key: 'periodMonth', label: '月份', kind: 'select' },
    { key: 'journalType', label: '业务类型', kind: 'select' }
  ],
  columns: [
    {
      key: 'journalNo',
      label: '流水号',
      kind: 'identifier',
      widthPreset: 'identifier',
      fixed: 'left'
    },
    { key: 'occurredAt', label: '发生时间', kind: 'date', widthPreset: 'dateTime' },
    { key: 'summary', label: '摘要', kind: 'text', widthPreset: 'longText' },
    { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.single,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2FinanceLedgerView.vue')
});
