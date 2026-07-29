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
    { key: 'rowNumber', label: '序号', minWidth: 72 },
    { key: 'account', label: 'ID账号', minWidth: 210 },
    { key: 'country', label: '国家', minWidth: 110 },
    { key: 'supplier', label: '供应商', minWidth: 120 },
    { key: 'saleState', label: '销售状态', minWidth: 110 },
    { key: 'soldOrderNo', label: '来源订单', minWidth: 170 },
    { key: 'lossBalance', label: '损失余额', minWidth: 120 },
    { key: 'lossCostAmount', label: '人民币亏损', minWidth: 130 },
    { key: 'reason', label: '报损原因', minWidth: 220 },
    { key: 'reportedBy', label: '操作人', minWidth: 120 },
    { key: 'reportedAt', label: '报损时间', minWidth: 165 }
  ],
  loadView: () => import('./V2AccountLossesView.vue')
});
