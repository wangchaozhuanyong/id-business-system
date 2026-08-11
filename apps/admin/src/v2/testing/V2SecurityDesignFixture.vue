<template>
  <div class="v2-shell v2-security-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong><span>业务管理工作台</span>
        </div>
      </div>
      <nav class="v2-navigation" aria-label="设计验收导航">
        <section
          v-for="section in navigation"
          :key="section.title"
          class="v2-navigation__section"
          :class="{ 'is-open': section.active, 'is-active': section.active }"
        >
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><component :is="section.icon" /></el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item" href="#audit-logs">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">审计日志</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#security">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">安全中心</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>安全中心</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span><el-icon><Bell /></el-icon>
          <span class="v2-security-fixture-avatar">管</span>
        </div>
      </header>
      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-security-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-security-page">
            <V2SecurityOverview :page="page" />
            <V2SecurityNavigation :page="page" />
            <V2SecurityToolbar :page="page" />
            <p class="v2-security-note">
              <el-icon><Lock /></el-icon>
              强制下线、策略状态和白名单读取均受管理员角色保护；所有高风险写操作都会写入审计。
            </p>
            <V2SecurityPolicyPanel v-if="page.activeTab === 'policy'" :page="page" />
            <V2SecurityRecordsPanel v-else :page="page" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, type UnwrapNestedRefs } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Lock,
  Setting,
  User
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2SecurityNavigation from '@/v2/features/security/components/V2SecurityNavigation.vue';
import V2SecurityOverview from '@/v2/features/security/components/V2SecurityOverview.vue';
import V2SecurityPolicyPanel from '@/v2/features/security/components/V2SecurityPolicyPanel.vue';
import V2SecurityRecordsPanel from '@/v2/features/security/components/V2SecurityRecordsPanel.vue';
import V2SecurityToolbar from '@/v2/features/security/components/V2SecurityToolbar.vue';
import type {
  V2ActiveSessionRecord,
  V2IpWhitelistRecord,
  V2LoginLogRecord,
  V2MfaUserRecord,
  V2SecurityTab,
  V2SecurityUser
} from '@/v2/features/security/contracts';
import {
  clientSummary,
  formatSecurityDate,
  loginRiskLabel,
  loginStatusMeta,
  securityUserLabel,
  sessionStateMeta
} from '@/v2/features/security/security-presentation';
import type { useSecurityPage } from '@/v2/features/security/useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];
const users: V2SecurityUser[] = [
  { id: 'user-1', username: 'admin', displayName: '系统管理员' },
  { id: 'user-2', username: 'operator01', displayName: '王超' },
  { id: 'user-3', username: 'finance01', displayName: '林晓雯' }
];

function makeLogin(index: number): V2LoginLogRecord {
  const status = index % 5 === 0 ? 'blocked' : index % 3 === 0 ? 'failed' : 'success';
  return {
    id: `login-${index + 1}`,
    userId: users[index % users.length].id,
    user: users[index % users.length],
    username: users[index % users.length].username,
    status,
    failureReason: status === 'success' ? null : '凭据校验失败或访问策略拦截',
    ip: `192.168.10.${10 + (index % 20)}`,
    userAgent: 'Mozilla/5.0 Chrome/150 macOS',
    location: '美国',
    abnormal: status !== 'success' && index % 2 === 0,
    createdAt: `2026-08-${String(1 + (index % 10)).padStart(2, '0')}T10:20:00.000Z`
  };
}

function makeSession(index: number): V2ActiveSessionRecord {
  return {
    id: `session-${index + 1}`,
    userId: users[index % users.length].id,
    user: users[index % users.length],
    ip: `192.168.20.${10 + (index % 20)}`,
    userAgent: 'Mozilla/5.0 Chrome/150 macOS',
    lastActiveAt: `2026-08-11T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
    expiresAt: '2026-08-12T08:20:00.000Z',
    revokedAt: index % 6 === 5 ? '2026-08-11T09:00:00.000Z' : null,
    createdAt: '2026-08-10T08:20:00.000Z',
    isCurrent: index === 0
  };
}

function makeWhitelist(index: number): V2IpWhitelistRecord {
  return {
    id: `whitelist-${index + 1}`,
    ipOrCidr: index % 2 ? `203.0.113.${10 + index}` : `10.${index}.0.0/24`,
    scope: index % 3 === 0 ? 'api' : 'admin',
    enabled: index % 4 !== 3,
    remark: '办公网络或受控 API 出口。',
    createdBy: users[0],
    createdAt: '2026-07-10T08:20:00.000Z',
    updatedAt: '2026-08-11T08:20:00.000Z'
  };
}

function makeMfaUser(index: number): V2MfaUserRecord {
  const configured = index % 4 !== 3;
  return {
    id: `mfa-user-${index + 1}`,
    username: users[index % users.length].username,
    displayName: `${users[index % users.length].displayName} ${index + 1}`,
    status: index % 6 === 5 ? 'disabled' : 'active',
    roles: index % 3 === 0 ? ['管理员'] : ['业务运营'],
    enabled: configured && index % 3 !== 2,
    configured,
    recoveryCodeCount: configured ? 8 - (index % 4) : 0,
    enabledAt: configured ? '2026-07-10T08:20:00.000Z' : null,
    lastUsedAt: configured ? '2026-08-11T08:20:00.000Z' : null,
    disabledAt: null
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allLoginItems = emptyState ? [] : Array.from({ length: 23 }, (_, index) => makeLogin(index));
const allSessionItems = emptyState
  ? []
  : Array.from({ length: 17 }, (_, index) => makeSession(index));
const allWhitelistItems = emptyState
  ? []
  : Array.from({ length: 13 }, (_, index) => makeWhitelist(index));
const allMfaUsers = emptyState ? [] : Array.from({ length: 12 }, (_, index) => makeMfaUser(index));
const notice = ref('');

const page = reactive({
  activeTab: 'login_logs' as V2SecurityTab,
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    status: '',
    abnormal: '',
    revoked: 'false',
    scope: '',
    enabled: '',
    sortBy: 'createdAt',
    sortOrder: 'desc',
    mfaUserPage: 1,
    mfaUserPageSize: 10,
    mfaUserKeyword: ''
  },
  overview: {
    failedLoginCount: 7,
    abnormalLoginCount: 4,
    activeSessionCount: 14,
    pendingApprovalCount: 2,
    enabledWhitelistCount: 10
  },
  loginItems: [] as V2LoginLogRecord[],
  sessionItems: [] as V2ActiveSessionRecord[],
  whitelistItems: [] as V2IpWhitelistRecord[],
  currentItems: [] as Array<V2LoginLogRecord | V2ActiveSessionRecord | V2IpWhitelistRecord>,
  mfaUserItems: allMfaUsers.slice(0, 10),
  mfaUserTotal: allMfaUsers.length,
  total: 0,
  activeFilterCount: 0,
  resolved: true,
  loading: false,
  listError: '',
  revokingSessionId: '',
  resettingMfaUserId: '',
  removingWhitelistId: '',
  mfaSetupLoading: false,
  mfaSettings: {
    id: 'mfa-settings',
    key: 'security.mfa',
    value: {
      enabled: true,
      requiredForAdmins: true,
      issuer: 'ID 业务管理系统',
      recoveryCodeCount: 10
    },
    updatedAt: '2026-08-11T08:20:00.000Z'
  },
  myMfaStatus: {
    enabled: true,
    configured: true,
    recoveryCodeCount: 8,
    enabledAt: '2026-07-10T08:20:00.000Z',
    lastUsedAt: '2026-08-11T08:20:00.000Z',
    disabledAt: null
  },
  refresh: () => {
    notice.value = '安全中心已刷新。';
    applyFilters();
  },
  handleTabChange: (name: string | number) => {
    page.activeTab = name === 'sessions' ? 'sessions' : name === 'policy' ? 'policy' : 'login_logs';
    page.query.page = 1;
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, {
      page: 1,
      keyword: '',
      status: '',
      abnormal: '',
      revoked: 'false',
      scope: '',
      enabled: ''
    });
    applyFilters();
  },
  handleSortChange: () => undefined,
  handlePageChange: (nextPage: number) => {
    page.query.page = nextPage;
    applyFilters();
  },
  handlePageSizeChange: (size: number) => {
    page.query.pageSize = size;
    applyFilters(true);
  },
  handleMfaUserSearch: () => {
    page.query.mfaUserPage = 1;
    applyMfaUsers();
  },
  handleMfaUserPageChange: (nextPage: number) => {
    page.query.mfaUserPage = nextPage;
    applyMfaUsers();
  },
  handleMfaUserPageSizeChange: (size: number) => {
    page.query.mfaUserPageSize = size;
    page.query.mfaUserPage = 1;
    applyMfaUsers();
  },
  selectMetric: (key: string) => {
    page.activeTab =
      key === 'sessions' ? 'sessions' : key === 'whitelist' ? 'policy' : 'login_logs';
    page.query.page = 1;
    applyFilters();
  },
  revokeSession: (item: V2ActiveSessionRecord) => {
    notice.value = `预览操作：将强制下线 ${item.id}。`;
  },
  openPolicySettings: () => {
    notice.value = '预览操作：已打开 MFA 策略设置。';
  },
  regenerateRecoveryCodes: () => {
    notice.value = '预览操作：将重新生成恢复码。';
  },
  disableMyMfa: () => {
    notice.value = '预览操作：将停用 MFA。';
  },
  openMfaSetup: () => {
    notice.value = '预览操作：已打开 MFA 绑定。';
  },
  resetUserMfa: (item: V2MfaUserRecord) => {
    notice.value = `预览操作：将重置 ${item.displayName} 的 MFA。`;
  },
  openCreateWhitelist: () => {
    notice.value = '预览操作：已打开新增白名单。';
  },
  openEditWhitelist: (item: V2IpWhitelistRecord) => {
    notice.value = `预览操作：正在编辑 ${item.ipOrCidr}。`;
  },
  removeWhitelist: (item: V2IpWhitelistRecord) => {
    notice.value = `预览操作：将删除 ${item.ipOrCidr}。`;
  },
  formatSecurityDate,
  securityUserLabel,
  loginStatusMeta,
  loginRiskLabel,
  sessionStateMeta,
  clientSummary
}) as unknown as SecurityPage;

function applyMfaUsers() {
  const keyword = page.query.mfaUserKeyword.trim().toLowerCase();
  const filtered = allMfaUsers.filter(
    (item) => !keyword || `${item.username} ${item.displayName}`.toLowerCase().includes(keyword)
  );
  page.mfaUserTotal = filtered.length;
  const start = (page.query.mfaUserPage - 1) * page.query.mfaUserPageSize;
  page.mfaUserItems = filtered.slice(start, start + page.query.mfaUserPageSize);
}

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const source =
    page.activeTab === 'sessions'
      ? allSessionItems
      : page.activeTab === 'policy'
        ? allWhitelistItems
        : allLoginItems;
  const filtered = source.filter((item) => {
    const text =
      'ipOrCidr' in item
        ? `${item.ipOrCidr} ${item.remark ?? ''}`
        : 'status' in item
          ? `${item.username} ${item.ip ?? ''} ${item.userAgent ?? ''}`
          : `${item.user.username} ${item.ip ?? ''} ${item.userAgent ?? ''}`;
    if (keyword && !text.toLowerCase().includes(keyword)) return false;
    if ('status' in item && page.query.status && item.status !== page.query.status) return false;
    if ('abnormal' in item && page.query.abnormal && String(item.abnormal) !== page.query.abnormal)
      return false;
    if (
      'revokedAt' in item &&
      page.query.revoked &&
      String(Boolean(item.revokedAt)) !== page.query.revoked
    )
      return false;
    if ('scope' in item && page.query.scope && item.scope !== page.query.scope) return false;
    if ('enabled' in item && page.query.enabled && String(item.enabled) !== page.query.enabled)
      return false;
    return true;
  });
  page.total = filtered.length;
  page.activeFilterCount = [
    page.query.keyword,
    page.activeTab === 'login_logs' ? page.query.status : '',
    page.activeTab === 'login_logs' ? page.query.abnormal : '',
    page.activeTab === 'sessions' && page.query.revoked !== 'false' ? page.query.revoked : '',
    page.activeTab === 'policy' ? page.query.scope : '',
    page.activeTab === 'policy' ? page.query.enabled : ''
  ].filter(Boolean).length;
  const start = (page.query.page - 1) * page.query.pageSize;
  const items = filtered.slice(start, start + page.query.pageSize);
  page.loginItems = page.activeTab === 'login_logs' ? (items as V2LoginLogRecord[]) : [];
  page.sessionItems = page.activeTab === 'sessions' ? (items as V2ActiveSessionRecord[]) : [];
  page.whitelistItems = page.activeTab === 'policy' ? (items as V2IpWhitelistRecord[]) : [];
  page.currentItems =
    page.activeTab === 'login_logs'
      ? page.loginItems
      : page.activeTab === 'sessions'
        ? page.sessionItems
        : page.whitelistItems;
}

applyFilters();
</script>

<style scoped>
.v2-security-fixture-avatar {
  display: inline-grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: #eaf1ff;
  color: #194ea8;
  font-size: 12px;
  font-weight: 700;
}
.v2-security-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
