import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const securityFeature = defineV2Feature({
  key: 'security',
  title: '安全中心',
  group: '系统管理',
  route: '/v2/system/security',
  sourceSheet: '系统管理-安全中心',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '账号、IP、失败原因' },
    { key: 'status', label: '状态', kind: 'select' },
    { key: 'abnormal', label: '风险', kind: 'select' }
  ],
  tables: v2TablesByFeature['security'],
  loadView: () => import('./V2SecurityView.vue')
});
