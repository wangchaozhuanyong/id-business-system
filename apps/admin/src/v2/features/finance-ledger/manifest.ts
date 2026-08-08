import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const financeLedgerFeature = defineV2Feature({
  key: 'finance-ledger',
  title: '钱包账户',
  group: '财务记账',
  route: '/v2/data/finance',
  sourceSheet: '多币种财务账务',
  permission: 'finance.view',
  status: 'ready',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '管理资金账户、供应商钱包、不可变流水和月度关账。',
  filters: [
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USD', 'USDT'] },
    { key: 'periodMonth', label: '月份', kind: 'select' },
    { key: 'journalType', label: '业务类型', kind: 'select' }
  ],
  tables: v2TablesByFeature['finance-ledger'],
  loadView: () => import('./V2FinanceLedgerView.vue')
});
