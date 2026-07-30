import { V2_TABLE_ACTION_COLUMN_WIDTH } from '@/v2/components/tableActionLayout';
import { defineV2Feature } from '@/v2/features/feature';

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
  columns: [
    {
      key: 'recordedAt',
      label: '记录时间',
      kind: 'date',
      widthPreset: 'dateTime',
      fixed: 'left'
    },
    { key: 'binanceBuy', label: 'Binance 买入', kind: 'numeric', widthPreset: 'standard' },
    { key: 'binanceSell', label: 'Binance 卖出', kind: 'numeric', widthPreset: 'standard' },
    { key: 'okxBuy', label: 'OKX 买入', kind: 'numeric', widthPreset: 'standard' },
    { key: 'okxSell', label: 'OKX 卖出', kind: 'numeric', widthPreset: 'standard' },
    {
      key: 'averageBuyRate',
      label: '综合买入',
      kind: 'numeric',
      widthPreset: 'standard'
    },
    {
      key: 'averageSellRate',
      label: '综合卖出',
      kind: 'numeric',
      widthPreset: 'standard'
    },
    { key: 'midRate', label: '中间价', kind: 'numeric', widthPreset: 'standard' },
    { key: 'operator', label: '操作人', kind: 'text', widthPreset: 'standard' },
    { key: 'remark', label: '备注', kind: 'text', widthPreset: 'identifier' },
    {
      key: 'actions',
      label: '操作',
      kind: 'actions',
      minWidth: V2_TABLE_ACTION_COLUMN_WIDTH.icon,
      fixed: 'right'
    }
  ],
  loadView: () => import('./V2ExchangeRatesView.vue')
});
