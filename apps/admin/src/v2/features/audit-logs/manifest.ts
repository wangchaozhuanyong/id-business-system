import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const auditLogsFeature = defineV2Feature({
  key: 'audit-logs',
  title: '审计日志',
  group: '系统管理',
  route: '/v2/system/audit-logs',
  sourceSheet: '系统管理-审计日志',
  permission: 'audit_log.view',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  filters: [
    { key: 'keyword', label: '搜索', kind: 'search', placeholder: '资料名称、说明、员工' },
    { key: 'module', label: '业务分类', kind: 'select' },
    { key: 'operator', label: '操作人', kind: 'search' },
    { key: 'action', label: '操作类型或查看内容', kind: 'select' },
    { key: 'createdAt', label: '时间', kind: 'date-range' }
  ],
  tables: v2TablesByFeature['audit-logs'],
  loadView: () => import('./V2AuditLogsView.vue')
});
