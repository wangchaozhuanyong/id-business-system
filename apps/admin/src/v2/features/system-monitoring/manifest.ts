import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const systemMonitoringFeature = defineV2Feature({
  key: 'system-monitoring',
  title: '系统监控',
  group: '监控中心',
  route: '/v2/monitoring/system',
  sourceSheet: '监控中心-系统监控',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: '规划 API、数据库、实时同步、定时任务和应用错误的健康视图。',
  safetyNotice: '只展示可由当前运行时证明的聚合证据；未接入项明确标记未知。',
  filters: [],
  tables: v2TablesByFeature['system-monitoring'],
  loadView: () => import('./V2SystemMonitoringView.vue')
});
