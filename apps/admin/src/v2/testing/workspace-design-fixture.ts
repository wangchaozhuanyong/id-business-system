import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { V2_GOOGLE_SHEETS_REPORT_NAMES } from '@apple-business/shared';
import { sessionCoordinator, transitionSessionState } from '@/auth/sessionCoordinator';
import { v2TableColumnVisibility } from '@/v2/directives/tableColumnVisibility';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2WorkspaceDesignFixture from './V2WorkspaceDesignFixture.vue';

const fixtureParams = new URLSearchParams(window.location.search);
const requestedTheme = fixtureParams.get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
const fixtureTime = '2026-10-13T08:00:00.000Z';
idBusinessV2WorkspaceApi.list = async () => ({
  items:
    fixtureParams.get('shortcuts') === 'empty'
      ? []
      : ['IP 查询', '常用服务后台', '虚拟卡资料', '代充信息网', '装修网站后台', '购物网站后台'].map(
          (name, index) => ({
            id: `workspace-shortcut-fixture-${index + 1}`,
            name,
            url: `https://example.com/workspace-fixture/${index + 1}`,
            sortOrder: index,
            createdAt: fixtureTime,
            updatedAt: fixtureTime
          })
        )
});
const quickActionsFixture = new URLSearchParams(window.location.search).get('quick-actions');
const requestedQuickActionCount = Number(fixtureParams.get('count') || 13);
const quickActionCount = Number.isInteger(requestedQuickActionCount)
  ? Math.min(100, Math.max(1, requestedQuickActionCount))
  : 13;
let quickActions =
  quickActionsFixture === 'empty'
    ? []
    : Array.from({ length: quickActionCount }, (_, index) => ({
        id: `quick-action-fixture-${index + 1}`,
        title:
          quickActionsFixture === 'long' && index === 12
            ? '使用说明与售后服务'
            : `客户回复 ${index + 1}`,
        content:
          quickActionsFixture === 'long' && index === 12
            ? [
                '使用说明与售后服务',
                '',
                '一、开始使用',
                '请先核对账号资料与所选套餐。首次使用时，请按页面提示完成设置；如果遇到无法登录、页面异常或订阅状态未更新，请保留错误提示并联系我们。',
                '',
                '二、问题反馈',
                '为了尽快定位问题，请提供发生时间、操作步骤和不含敏感信息的截图。请勿在聊天中发送密码、验证码或银行卡资料。',
                '',
                '三、服务说明',
                '我们会根据订单记录核对服务内容，说明处理进度与下一步操作。处理期间请保留原始记录，避免重复提交相同申请。',
                '',
                '四、常见问题',
                ...Array.from(
                  { length: 8 },
                  (_, i) =>
                    `${i + 1}. 遇到问题时，请先记录页面提示，再联系客服确认处理方式。我们会逐项核对并回复。`
                ),
                '',
                '谢谢你的理解与配合。'
              ].join('\n')
            : index === 0
              ? '第一行\n第二行，仅复制正文。'
              : `第 ${index + 1} 条回复内容`,
        createdAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 8, 30, 10, index)).toISOString()
      }));
let hasCustomQuickActionOrder = false;
let quickActionReads = 0;
let quickActionSaveAttempts = 0;
const fixtureDelay = () =>
  new Promise<void>((resolve) =>
    window.setTimeout(resolve, fixtureParams.get('save') === 'slow' ? 600 : 0)
  );
const beforeQuickActionSave = async () => {
  await fixtureDelay();
  if (fixtureParams.get('save') === 'fail-once' && quickActionSaveAttempts++ === 0)
    throw new Error('验收模拟保存失败，请重试');
};
idBusinessV2WorkspaceApi.listQuickActions = async () => {
  quickActionReads += 1;
  if (fixtureParams.get('read') === 'fail-once' && quickActionReads === 1)
    throw new Error('验收模拟读取失败，请重试');
  if (fixtureParams.get('read') === 'refresh-error' && quickActionReads === 2)
    throw new Error('验收模拟刷新失败，请重试');
  return { items: [...quickActions], hasCustomOrder: hasCustomQuickActionOrder };
};
idBusinessV2WorkspaceApi.reorderQuickActions = async (input) => {
  if (!(input.initializeOnly && hasCustomQuickActionOrder)) {
    if (quickActions.some((item, index) => item.id !== input.expectedQuickActionIds[index]))
      throw new Error('回复顺序已变化，请刷新后重试');
    quickActions = input.quickActionIds.map((id) => {
      const item = quickActions.find((candidate) => candidate.id === id);
      if (!item) throw new Error('回复记录已变化，请刷新后重试');
      return item;
    });
    hasCustomQuickActionOrder = true;
  }
  return { items: [...quickActions], hasCustomOrder: hasCustomQuickActionOrder };
};
idBusinessV2WorkspaceApi.createQuickAction = async (input) => {
  await beforeQuickActionSave();
  const item = {
    id: `quick-action-fixture-${quickActions.length + 1}`,
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  quickActions = hasCustomQuickActionOrder ? [...quickActions, item] : [item, ...quickActions];
  return item;
};
idBusinessV2WorkspaceApi.updateQuickAction = async (id, input) => {
  await beforeQuickActionSave();
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
  automaticTriggerDelaySeconds: 5,
  callbackUrl: 'https://id.example.com/api/public/google-sheets-sync/oauth/callback',
  clientId: 'report-sync.apps.googleusercontent.com',
  configured: true,
  enabled: true,
  excludedData: [
    'ID 密码与密保',
    'ChatGPT 密码与 2FA 密钥',
    '邮箱凭据、应用专用密码、查询码和邮件验证码',
    '完整礼品卡号',
    '完整银行卡号、有效期和银行卡安全码',
    '客户完整联系方式（仅同步脱敏值）',
    '自由填写的备注与凭证附件',
    '访问令牌、刷新令牌和审计敏感内容'
  ],
  lastAttemptAt: '2026-09-05T01:20:00.000Z',
  lastErrorMessage: null,
  lastSucceededAt: '2026-09-05T01:20:00.000Z',
  reportNames: [...V2_GOOGLE_SHEETS_REPORT_NAMES],
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/fixture/edit',
  syncIntervalSeconds: 30,
  targetFolderUrl: 'https://drive.google.com/drive/folders/fixture-folder',
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
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/orders', component: { render: () => null } },
    { path: '/accounts', component: { render: () => null } }
  ]
});
app.use(router);
app.directive('v2-column-visibility', v2TableColumnVisibility);
await router.push('/orders');
await router.isReady();
app.mount('#app');
