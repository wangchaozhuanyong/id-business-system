import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const financeExpensesFeature = defineV2Feature({
  key: 'finance-expenses',
  title: '收支记账',
  group: '财务记账',
  route: '/v2/data/finance/expenses',
  sourceSheet: '多币种财务账务-收支记账',
  permission: 'finance.view',
  status: 'ready',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '按资金性质、收付款账户和交易汇率快照记录经营收入与开支。',
  filters: [
    {
      key: 'nature',
      label: '资金性质',
      kind: 'select',
      options: ['经营收入', '股东投入', '借入资金']
    },
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USD', 'USDT'] }
  ],
  tables: v2TablesByFeature['finance-expenses'],
  loadView: () => import('./V2FinanceExpensesView.vue')
});
