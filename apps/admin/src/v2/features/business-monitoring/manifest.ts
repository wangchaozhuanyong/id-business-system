import { defineV2Feature } from '@/v2/features/feature';
import { v2TablesByFeature } from '@/v2/features/tableSchemas';

export const businessMonitoringFeature = defineV2Feature({
  key: 'business-monitoring',
  title: '业务监控',
  group: '监控中心',
  route: '/v2/monitoring/business',
  sourceSheet: '监控中心-业务监控',
  requiredRoles: ['admin'],
  kind: 'list',
  freshnessPolicy: 'event-with-deadline',
  summary: '集中识别订单、余额、续费和汇率采集中的业务风险。',
  safetyNotice: '异常只来自源业务状态；修正源数据后自动消失，不产生外部通知。',
  filters: [
    { key: 'severity', label: '风险级别', kind: 'select', options: ['紧急', '警告', '提示'] },
    {
      key: 'category',
      label: '异常分类',
      kind: 'select',
      options: ['订单', '余额', '续费与开通', '汇率采集', '财务基线']
    }
  ],
  tables: v2TablesByFeature['business-monitoring'],
  loadView: () => import('./V2BusinessMonitoringView.vue')
});
