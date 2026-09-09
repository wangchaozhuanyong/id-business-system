import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const autoRechargeAddressesFeature = defineV2Feature({
  key: 'auto-recharge-addresses',
  title: '地址管理',
  group: '自动充值',
  route: '/v2/auto-recharge/addresses',
  sourceSheet: '自动充值地址',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '街道地址' },
    {
      key: 'status',
      label: '状态',
      kind: 'select',
      options: ['未使用', '已使用', '已停用']
    }
  ],
  tables: v2TablesByFeature['auto-recharge-addresses'],
  loadView: () => import('./V2RechargeAddressesView.vue')
});
