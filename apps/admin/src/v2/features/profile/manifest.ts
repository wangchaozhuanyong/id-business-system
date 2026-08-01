import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const profileFeature = defineV2Feature({
  key: 'profile',
  title: '我的账户',
  group: '个人',
  route: '/v2/profile',
  sourceSheet: '个人-我的账户',
  navigation: false,
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: '查看脱敏个人资料，管理密码、MFA 和当前账号的在线设备。',
  filters: [],
  tables: v2TablesByFeature['profile'],
  loadView: () => import('./V2ProfileView.vue')
});
