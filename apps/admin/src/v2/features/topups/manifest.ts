import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const topupWorkbenchFeature = defineV2Feature({
  key: 'topup-workbench',
  title: 'ID加额',
  group: '工作台',
  route: '/v2/workbench/topups',
  sourceSheet: '工作台-加卡',
  permission: 'apple.balance.view',
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'country', label: '国家', kind: 'select', options: ['美国', '马来西亚'] },
    {
      key: 'balancePreset',
      label: '余额范围',
      kind: 'select',
      options: ['等于0', '大于0且小于20', '自定义']
    },
    { key: 'balance', label: '自定义余额', kind: 'number-range' }
  ],
  tables: v2TablesByFeature['topup-workbench'],
  loadView: () => import('./V2TopupWorkbenchView.vue')
});
