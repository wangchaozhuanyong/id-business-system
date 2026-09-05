import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { sessionCoordinator, transitionSessionState } from '@/auth/sessionCoordinator';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2WorkspaceDesignFixture from './V2WorkspaceDesignFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
idBusinessV2WorkspaceApi.list = async () => ({ items: [] });
const analyticsFixture = new URLSearchParams(window.location.search).get('analytics');
let analyticsFixtureReads = 0;
idBusinessV2WorkspaceApi.getWebsiteAnalytics = async (days) => {
  if (analyticsFixture === 'refresh-error' && analyticsFixtureReads++ > 0)
    throw new Error('测试刷新失败');
  if (analyticsFixture === 'error') throw new Error('测试统计服务暂时不可用');
  const status = ['ready', 'refresh-error'].includes(analyticsFixture || '')
    ? 'ready'
    : analyticsFixture === 'empty'
      ? 'empty'
      : 'not_configured';
  return {
    status,
    days,
    fetchedAt: '2026-09-05T12:00:00.000Z',
    timeZone: 'Asia/Kuala_Lumpur',
    utcOffset: 'GMT+08:00',
    thresholded: false,
    summary:
      status === 'ready'
        ? {
            pageViews: days * 30 + (days * (days - 1)) / 2,
            visitors: days + 18,
            sessions: days * 20 + (days * (days - 1)) / 2
          }
        : null,
    daily:
      status === 'not_configured'
        ? []
        : Array.from({ length: days }, (_, index) => ({
            date: new Date(Date.UTC(2026, 8, 5) - (days - index - 1) * 86_400_000)
              .toISOString()
              .slice(0, 10),
            metrics:
              status === 'ready'
                ? { pageViews: 30 + index, visitors: 10 + index, sessions: 20 + index }
                : null
          }))
  };
};
idBusinessV2WorkspaceApi.getGoogleSheetsSyncStatus = async () => ({
  authorized: true,
  callbackUrl: 'https://id.example.com/api/public/google-sheets-sync/oauth/callback',
  clientId: 'report-sync.apps.googleusercontent.com',
  configured: true,
  enabled: true,
  excludedData: [
    'ID 密码与密保',
    '邮箱授权信息与应用专用密码',
    '完整礼品卡号',
    '手机号与其他联系方式',
    '访问令牌、刷新令牌和审计敏感内容'
  ],
  lastAttemptAt: '2026-09-05T01:20:00.000Z',
  lastErrorMessage: null,
  lastSucceededAt: '2026-09-05T01:20:00.000Z',
  reportNames: ['订单', '加卡', '续费', '财务汇总'],
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/fixture/edit',
  syncIntervalSeconds: 30,
  syncing: false
});
sessionCoordinator.hydrate();
transitionSessionState({
  kind: 'ready',
  user: {
    id: 'workspace-fixture-user',
    username: 'workspace-fixture',
    displayName: '工作区验收用户',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  },
  verifiedAt: Date.now()
});
createApp(V2WorkspaceDesignFixture).use(createPinia()).mount('#app');
