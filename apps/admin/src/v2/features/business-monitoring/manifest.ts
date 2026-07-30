import { defineV2Feature } from '@/v2/features/feature';

export const businessMonitoringFeature = defineV2Feature({
  key: 'business-monitoring',
  title: '业务监控',
  group: '监控中心',
  route: '/v2/monitoring/business',
  sourceSheet: '规划占位-业务监控',
  permission: 'monitor.business.view',
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-with-deadline',
  summary: '集中识别订单、余额、续费和汇率采集中的业务风险。',
  plannedSections: [
    {
      title: '订单异常',
      description: '规划失败、长时间未完成、退款和取消异常的监控入口。'
    },
    {
      title: '余额风险',
      description: '识别余额不足、成本异常、锁定冲突和不可变流水问题。'
    },
    {
      title: '到期风险',
      description: '按预警窗口展示即将到期、已到期和异常开通记录。'
    },
    {
      title: '汇率采集异常',
      description: '展示采集失败、平台缺失和报价质量异常。'
    }
  ],
  safetyNotice: '当前页面不轮询业务列表、不推断异常数量，也不会产生外部通知。',
  filters: [],
  columns: [],
  loadView: () => import('./V2BusinessMonitoringView.vue')
});
