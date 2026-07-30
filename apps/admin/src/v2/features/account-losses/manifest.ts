import { defineV2Feature } from '@/v2/features/feature';

export const accountLossesFeature = defineV2Feature({
  key: 'account-losses',
  title: 'ID报损记录',
  group: '记录',
  route: '/v2/records/account-losses',
  sourceSheet: 'ID报损记录',
  permission: 'apple.balance.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: 'ID、订单、原因、操作人' },
    { key: 'countryOptionId', label: '国家', kind: 'select' },
    { key: 'saleState', label: '销售状态', kind: 'select', options: ['可用', '已卖出'] },
    { key: 'reportedAt', label: '报损时间', kind: 'date-range' }
  ],
  columns: [
    { key: 'rowNumber', label: '序号', kind: 'index', widthPreset: 'index' },
    { key: 'account', label: 'ID账号', kind: 'identifier', widthPreset: 'identifier' },
    { key: 'country', label: '国家', kind: 'text', widthPreset: 'compact' },
    { key: 'supplier', label: '供应商', kind: 'text', widthPreset: 'standard' },
    { key: 'saleState', label: '销售状态', kind: 'status', widthPreset: 'compact' },
    {
      key: 'soldOrderNo',
      label: '来源订单',
      kind: 'identifier',
      widthPreset: 'identifier'
    },
    { key: 'lossBalance', label: '损失余额', kind: 'numeric', widthPreset: 'standard' },
    {
      key: 'lossCostAmount',
      label: '人民币亏损',
      kind: 'numeric',
      widthPreset: 'standard'
    },
    { key: 'reason', label: '报损原因', kind: 'text', widthPreset: 'longText' },
    { key: 'reportedBy', label: '操作人', kind: 'text', widthPreset: 'standard' },
    { key: 'reportedAt', label: '报损时间', kind: 'date', widthPreset: 'dateTime' }
  ],
  loadView: () => import('./V2AccountLossesView.vue')
});
