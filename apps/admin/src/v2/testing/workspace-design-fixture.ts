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
