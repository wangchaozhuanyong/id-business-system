import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const vendureMailboxFeature = defineV2Feature({
  key: 'vendure-mailbox',
  title: '邮件验证码查询',
  group: '自动充值',
  route: '/v2/auto-recharge/mailbox',
  sourceSheet: 'Vendure 邮件验证码查询',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  filters: [
    { key: 'q', label: '搜索', kind: 'search', placeholder: '邮箱、主题或验证码' },
    { key: 'status', label: '状态', kind: 'select', options: ['正常', '已禁用', '授权错误'] }
  ],
  tables: v2TablesByFeature['vendure-mailbox'],
  loadView: () => import('./V2VendureMailboxView.vue')
});
