import { defineV2Feature } from '@/v2/features/feature';

export const dataGovernanceFeature = defineV2Feature({
  key: 'data-governance',
  title: '数据治理',
  group: '数据中心',
  route: '/v2/data/governance',
  sourceSheet: '规划占位-数据治理',
  requiredRoles: ['admin'],
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-driven',
  summary: '统一规划数据导入导出、备份恢复、回收站、清理任务和留痕。',
  plannedSections: [
    {
      title: '导入与导出',
      description: '规划文件校验、错误反馈、权限控制和结果下载入口。'
    },
    {
      title: '备份与恢复',
      description: '展示备份状态、恢复演练和可验证恢复点。'
    },
    {
      title: '回收站',
      description: '集中查看软删除数据，并保留恢复和追溯入口。'
    },
    {
      title: '清理任务',
      description: '所有清理先生成影响预览，再经过确认和审批。'
    },
    {
      title: '执行记录',
      description: '记录任务发起人、审批人、范围、结果和审计编号。'
    }
  ],
  safetyNotice: '本阶段不提供删除或恢复操作；未来也必须先预览、备份、审批并写入审计。',
  filters: [],
  columns: [],
  loadView: () => import('./V2DataGovernanceView.vue')
});
