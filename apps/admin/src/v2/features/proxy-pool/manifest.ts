import { defineV2Feature } from '@/v2/features/feature';

export const rechargeProxiesFeature = defineV2Feature({
  key: 'recharge-proxies',
  title: '代理 IP 管理',
  group: '自充设置',
  route: '/v2/account-settings/proxies',
  sourceSheet: '充值代理 IP',
  permission: 'id_business_v2.online_recharge.read',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '国家或备注' },
    { key: 'status', label: '状态', kind: 'select', options: ['启用', '停用'] }
  ],
  loadTables: () =>
    import('@/v2/features/tableSchemas').then(
      ({ v2TablesByFeature }) => v2TablesByFeature['recharge-proxies']
    ),
  loadView: () => import('./V2ProxyPoolView.vue')
});
