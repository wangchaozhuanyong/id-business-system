import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const dashboardFeature = defineV2Feature({
  key: 'dashboard',
  title: '仪表盘',
  group: '总览',
  route: '/v2/dashboard',
  sourceSheet: '总览-经营仪表盘',
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: '按权限汇总今日业务、待办风险、ID 库存成本和团队审计摘要。',
  filters: [],
  tables: v2TablesByFeature['dashboard'],
  loadView: () => import('./V2DashboardView.vue')
});
