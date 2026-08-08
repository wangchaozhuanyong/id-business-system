import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const accountLossesFeature = defineV2Feature({
  key: 'account-losses',
  title: 'ID报损记录',
  group: '业务中心',
  route: '/v2/records/account-losses',
  sourceSheet: 'ID报损记录',
  permission: 'apple.balance.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: 'ID、订单、原因、操作人' },
    { key: 'countryOptionId', label: '国家', kind: 'select' },
    { key: 'saleState', label: '销售状态', kind: 'select', options: ['可用', '已卖出'] },
    { key: 'status', label: '记录状态', kind: 'select', options: ['待恢复', '已恢复'] },
    { key: 'reportedAt', label: '报损时间', kind: 'date-range' }
  ],
  tables: v2TablesByFeature['account-losses'],
  loadView: () => import('./V2AccountLossesView.vue')
});
