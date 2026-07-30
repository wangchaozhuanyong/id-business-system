import { defineV2Feature } from '@/v2/features/feature';

export const dashboardFeature = defineV2Feature({
  key: 'dashboard',
  title: '仪表盘',
  group: '总览',
  route: '/v2/dashboard',
  sourceSheet: '规划占位-仪表盘',
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-driven',
  summary: '集中呈现日常经营进展、风险待办、资产资金和团队操作概况。',
  plannedSections: [
    {
      title: '今日业务',
      description: '汇总订单录入、开通、续费和 ID 加额的当日进展。'
    },
    {
      title: '待办风险',
      description: '集中展示即将到期、异常订单、余额不足和人工复核事项。'
    },
    {
      title: '资产与资金',
      description: '规划 ID 库存、可用余额、成本和利润的概览入口。'
    },
    {
      title: '团队动态',
      description: '查看员工近期操作、任务处理和关键审计事件摘要。'
    }
  ],
  safetyNotice: '当前仪表盘不读取业务数据，也不会用占位数字冒充真实经营结果。',
  filters: [],
  columns: [],
  loadView: () => import('./V2DashboardView.vue')
});
