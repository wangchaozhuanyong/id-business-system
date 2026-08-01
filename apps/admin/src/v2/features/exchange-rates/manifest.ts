import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const exchangeRatesFeature = defineV2Feature({
  key: 'exchange-rates',
  title: '汇率记录',
  group: '系统',
  route: '/v2/exchange-rates',
  sourceSheet: '汇率采集',
  permission: 'apple.exchange_rate.view',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '备注、操作人' },
    { key: 'recordedAt', label: '记录时间', kind: 'date-range' }
  ],
  tables: v2TablesByFeature['exchange-rates'],
  loadView: () => import('./V2ExchangeRatesView.vue')
});
