import { defineV2Feature } from '@/v2/features/feature';

export const exchangeRatesFeature = defineV2Feature({
  key: 'exchange-rates',
  title: '汇率记录',
  group: '系统',
  route: '/v2/exchange-rates',
  sourceSheet: '汇率采集',
  permission: 'apple.exchange_rate.view',
  kind: 'list',
  loadingTier: 'live',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '备注、操作人' },
    { key: 'recordedAt', label: '记录时间', kind: 'date-range' }
  ],
  columns: [
    { key: 'recordedAt', label: '记录时间', minWidth: 170, fixed: 'left' },
    { key: 'binanceBuy', label: 'Binance 买入', minWidth: 130 },
    { key: 'binanceSell', label: 'Binance 卖出', minWidth: 130 },
    { key: 'okxBuy', label: 'OKX 买入', minWidth: 120 },
    { key: 'okxSell', label: 'OKX 卖出', minWidth: 120 },
    { key: 'averageBuyRate', label: '综合买入', minWidth: 125 },
    { key: 'averageSellRate', label: '综合卖出', minWidth: 125 },
    { key: 'midRate', label: '中间价', minWidth: 120 },
    { key: 'operator', label: '操作人', minWidth: 120 },
    { key: 'remark', label: '备注', minWidth: 180 },
    { key: 'actions', label: '操作', minWidth: 90, fixed: 'right' }
  ],
  loadView: () => import('./V2ExchangeRatesView.vue')
});
