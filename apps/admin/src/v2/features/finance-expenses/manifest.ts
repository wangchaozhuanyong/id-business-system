import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const financeExpensesFeature = defineV2Feature({
  key: 'finance-expenses',
  title: '开支记账',
  group: '财务记账',
  route: '/v2/data/finance/expenses',
  sourceSheet: '多币种财务账务-经营开支',
  permission: 'finance.view',
  status: 'ready',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '按原币金额、付款账户和交易汇率快照记录经营开支。',
  filters: [
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USD', 'USDT'] }
  ],
  tables: v2TablesByFeature['finance-expenses'],
  loadView: () => import('./V2FinanceExpensesView.vue')
});
