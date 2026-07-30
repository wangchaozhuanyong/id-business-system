import { defineV2Feature } from '@/v2/features/feature';

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
    { key: 'currency', label: '币种', kind: 'select', options: ['CNY', 'MYR', 'USDT'] },
    { key: 'supplier', label: '供应商', kind: 'select' },
    { key: 'journalType', label: '业务类型', kind: 'select' },
    { key: 'financeAccount', label: '资金账户', kind: 'select' }
  ],
  columns: [
    {
      key: 'journalNo',
      label: '财务流水号',
      kind: 'identifier',
      widthPreset: 'identifier',
      fixed: 'left'
    },
    { key: 'occurredAt', label: '发生时间', kind: 'date', widthPreset: 'dateTime' },
    { key: 'journalType', label: '业务类型', kind: 'status', widthPreset: 'wide' },
    { key: 'summary', label: '摘要', kind: 'text', widthPreset: 'longText' },
    {
      key: 'sourceReference',
      label: '来源单号',
      kind: 'identifier',
      widthPreset: 'identifier'
    },
    { key: 'amountCny', label: '人民币金额', kind: 'numeric', widthPreset: 'wide' }
  ],
  loadView: () => import('./V2DataAnalyticsView.vue')
});
