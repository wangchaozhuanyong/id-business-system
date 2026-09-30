import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { sessionCoordinator, transitionSessionState } from '@/auth/sessionCoordinator';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2WorkspaceDesignFixture from './V2WorkspaceDesignFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
idBusinessV2WorkspaceApi.list = async () => ({ items: [] });
const quickActionsFixture = new URLSearchParams(window.location.search).get('quick-actions');
let quickActions =
  quickActionsFixture === 'empty'
    ? []
    : Array.from({ length: 13 }, (_, index) => ({
        id: `quick-action-fixture-${index + 1}`,
        title: `客户回复 ${index + 1}`,
        content: index === 0 ? '第一行\n第二行，仅复制正文。' : `第 ${index + 1} 条回复内容`,
        createdAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString()
      }));
idBusinessV2WorkspaceApi.listQuickActions = async () => ({ items: [...quickActions] });
idBusinessV2WorkspaceApi.createQuickAction = async (input) => {
  const item = {
    id: `quick-action-fixture-${quickActions.length + 1}`,
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  quickActions = [item, ...quickActions];
  return item;
};
idBusinessV2WorkspaceApi.updateQuickAction = async (id, input) => {
  const old = quickActions.find((item) => item.id === id);
  if (!old) throw new Error('记录不存在');
  const item = { ...old, ...input, updatedAt: new Date().toISOString() };
  quickActions = quickActions.map((candidate) => (candidate.id === id ? item : candidate));
  return item;
};
idBusinessV2WorkspaceApi.removeQuickAction = async (id) => {
  quickActions = quickActions.filter((item) => item.id !== id);
  return { id, deleted: true };
};
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
const mailboxFixture = new URLSearchParams(window.location.search).get('mailbox');
if (mailboxFixture) {
  const now = Date.now();
  const providers = ['microsoft', 'icloud', 'gmail'] as const;
  const domains = ['outlook.com', 'icloud.com', 'gmail.com'];
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `mailbox-fixture-${index + 1}`,
    email: `mailbox${String(index + 1).padStart(2, '0')}@${domains[index % 3]}`,
    label: index === 0 ? '邮箱备注保留在第二行' : null,
    provider: providers[index % 3],
    status: index === 2 ? ('auth_failed' as const) : ('active' as const),
    queryCode: index === 3 ? null : `FixtureQueryCode${String(index + 1).padStart(5, '0')}`,
    queryCodeHint: String(index + 1).padStart(4, '0'),
    queryCodeExpiresAt: new Date(
      now + (index === 1 ? 47.5 : index === 2 ? -1 : 30 * 24) * 3_600_000
    ).toISOString(),
    lastVerifiedAt: new Date(now).toISOString(),
    lastQueriedAt: index === 0 ? null : new Date(now).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  }));
  idBusinessV2WorkspaceApi.listManagedMailboxes = async (query) => {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const filtered = rows.filter(
      (row) =>
        mailboxFixture !== 'empty' &&
        (!query.q || `${row.email} ${row.label ?? ''}`.includes(query.q)) &&
        (!query.provider || row.provider === query.provider) &&
        (!query.status || row.status === query.status)
    );
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length
    };
  };
}
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
const app = createApp(V2WorkspaceDesignFixture);
app.use(createPinia());
app.directive('v2-column-visibility', v2TableColumnVisibility);
app.mount('#app');
