import { defineV2Feature } from '@/v2/features/feature';

export const profileFeature = defineV2Feature({
  key: 'profile',
  title: '我的账户',
  group: '个人',
  route: '/v2/profile',
  sourceSheet: '规划占位-我的账户',
  navigation: false,
  status: 'planned',
  kind: 'planned',
  freshnessPolicy: 'event-with-deadline',
  summary: '为当前员工提供个人资料、密码、安全设置和登录设备入口。',
  plannedSections: [
    {
      title: '个人资料',
      description: '规划姓名、联系方式和账号基本信息维护。'
    },
    {
      title: '修改密码',
      description: '提供当前密码校验、强度提示和安全退出流程。'
    },
    {
      title: '安全设置',
      description: '查看 MFA、密码更新时间和账号安全状态。'
    },
    {
      title: '登录设备',
      description: '查看自己的活动会话，并规划主动退出其他设备。'
    }
  ],
  safetyNotice: '当前页面不会读取额外个人资料，也不会修改密码或登录会话。',
  filters: [],
  columns: [],
  loadView: () => import('./V2ProfileView.vue')
});
