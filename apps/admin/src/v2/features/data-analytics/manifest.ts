import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const dataAnalyticsFeature = defineV2Feature({
  key: 'analytics',
  title: '经营分析',
  group: '数据中心',
  route: '/v2/data/analytics',
  sourceSheet: '规划占位-经营分析',
  permission: 'data.analytics.view',
  status: 'ready',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '按经营利润、原币现金流和资产余额三套口径展示多币种盈亏闭环。',
  filters: [
    { key: 'businessDate', label: '业务日期', kind: 'date-range' },
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USD', 'USDT'] },
    { key: 'supplier', label: '供应商', kind: 'select' },
    { key: 'journalType', label: '业务类型', kind: 'select' },
    { key: 'financeAccount', label: '资金账户', kind: 'select' }
  ],
  tables: v2TablesByFeature['analytics'],
  loadView: () => import('./V2DataAnalyticsView.vue')
});
