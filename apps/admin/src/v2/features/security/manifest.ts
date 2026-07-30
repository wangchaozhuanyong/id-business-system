import { defineV2Feature } from '@/v2/features/feature';

export const securityFeature = defineV2Feature({
  key: 'security',
  title: '安全中心',
  group: '系统管理',
  route: '/v2/system/security',
  sourceSheet: '规划占位-安全中心',
  requiredRoles: ['admin'],
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-with-deadline',
  summary: '集中规划登录风险、在线会话、MFA 和访问白名单管理。',
  plannedSections: [
    {
      title: '登录记录',
      description: '查看成功、失败、拦截和异常登录事件。'
    },
    {
      title: '在线会话',
      description: '规划当前会话、最近活动和管理员强制下线入口。'
    },
    {
      title: '多因素认证',
      description: '规划 MFA 策略、员工绑定状态和管理员重置流程。'
    },
    {
      title: 'IP 白名单',
      description: '按管理端和 API 范围控制可信 IP 或 CIDR。'
    }
  ],
  safetyNotice: '当前不会撤销会话、修改 MFA 策略或调整 IP 白名单。',
  filters: [],
  columns: [],
  loadView: () => import('./V2SecurityView.vue')
});
