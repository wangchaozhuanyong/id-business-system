import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const rechargeProxiesFeature = defineV2Feature({
  key: 'recharge-proxies',
  title: '代理 IP 管理',
  group: '自动充值',
  route: '/v2/auto-recharge/proxies',
  sourceSheet: '充值代理 IP',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '国家或备注' },
    { key: 'status', label: '状态', kind: 'select', options: ['启用', '停用'] }
  ],
  tables: v2TablesByFeature['recharge-proxies'],
  loadView: () => import('./V2RechargeProxiesView.vue')
});
