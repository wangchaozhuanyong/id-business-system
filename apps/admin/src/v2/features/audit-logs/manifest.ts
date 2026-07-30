import { defineV2Feature } from '@/v2/features/feature';

export const auditLogsFeature = defineV2Feature({
  key: 'audit-logs',
  title: '审计日志',
  group: '系统管理',
  route: '/v2/system/audit-logs',
  sourceSheet: '规划占位-审计日志',
  permission: 'audit_log.view',
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-driven',
  summary: '统一查看员工操作、对象变更、敏感访问和安全事件。',
  plannedSections: [
    {
      title: '日志筛选',
      description: '规划按员工、模块、动作、对象和时间范围筛选。'
    },
    {
      title: '操作详情',
      description: '查看变更前后差异、操作原因、IP 和客户端信息。'
    },
    {
      title: '敏感访问',
      description: '集中呈现密码、手机号和密保等敏感字段查看记录。'
    },
    {
      title: '审计留存',
      description: '规划导出、留存周期和审计完整性检查入口。'
    }
  ],
  safetyNotice: '当前页面尚未调用已有审计查询接口，也不会展示任何真实操作记录。',
  filters: [],
  columns: [],
  loadView: () => import('./V2AuditLogsView.vue')
});
