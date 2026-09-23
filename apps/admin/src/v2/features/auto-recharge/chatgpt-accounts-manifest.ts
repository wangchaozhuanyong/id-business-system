import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const chatgptAccountsFeature = defineV2Feature({
  key: 'chatgpt-accounts',
  title: 'ChatGPT 账号',
  group: '自动充值',
  route: '/v2/auto-recharge/chatgpt-accounts',
  sourceSheet: 'ChatGPT 账号',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [],
  tables: v2TablesByFeature['chatgpt-accounts'],
  loadView: () => import('./V2ChatgptAccountsView.vue')
});
