import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const dataGovernanceFeature = defineV2Feature({
  key: 'data-governance',
  title: '数据治理',
  group: '数据中心',
  route: '/v2/data/governance',
  sourceSheet: '数据中心-数据治理',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-driven',
  summary: '集中管理回收站恢复、受控汇率历史清理、异人审批、检查点和逐项审计。',
  safetyNotice: '通用硬删除始终关闭；所有变更必须先生成预览、填写备份证据并由另一名管理员审批。',
  filters: [
    {
      key: 'entity',
      label: '回收站类型',
      kind: 'select',
      options: ['ID 资料', '客户', '业务选项', '订单']
    },
    {
      key: 'type',
      label: '任务类型',
      kind: 'select',
      options: ['回收站恢复', '汇率历史清理']
    },
    {
      key: 'status',
      label: '任务状态',
      kind: 'select',
      options: ['待审批', '待执行', '执行中', '已完成', '部分完成', '失败', '已驳回']
    }
  ],
  tables: v2TablesByFeature['data-governance'],
  loadView: () => import('./V2DataGovernanceView.vue')
});
