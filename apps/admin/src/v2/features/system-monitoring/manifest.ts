import { defineV2Feature } from '@/v2/features/feature';

export const systemMonitoringFeature = defineV2Feature({
  key: 'system-monitoring',
  title: '系统监控',
  group: '监控中心',
  route: '/v2/monitoring/system',
  sourceSheet: '规划占位-系统监控',
  permission: 'monitor.system.view',
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-with-deadline',
  summary: '规划 API、数据库、实时同步、定时任务和应用错误的健康视图。',
  plannedSections: [
    {
      title: 'API 健康',
      description: '展示服务可用性、响应时间和关键只读探针状态。'
    },
    {
      title: '数据库健康',
      description: '规划连接、迁移、容量和备份可用性检查。'
    },
    {
      title: '实时同步',
      description: '展示私有 Realtime 频道和版本补偿机制状态。'
    },
    {
      title: '定时任务',
      description: '查看汇率采集等任务的最近运行与失败记录。'
    },
    {
      title: '错误与性能',
      description: '规划前后端错误、慢请求和导航性能的聚合入口。'
    }
  ],
  safetyNotice: '当前页面不新增监控采集器或日志上报，只确认未来监控信息架构。',
  filters: [],
  columns: [],
  loadView: () => import('./V2SystemMonitoringView.vue')
});
