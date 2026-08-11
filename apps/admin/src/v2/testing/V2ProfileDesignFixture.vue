<template>
  <div class="v2-shell v2-profile-design-fixture">
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
            <a class="v2-navigation__item" href="#security">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">安全中心</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#profile">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">我的账户</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>我的账户</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span><el-icon><Bell /></el-icon>
          <span class="v2-profile-fixture-avatar">管</span>
        </div>
      </header>
      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-profile-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-profile-page">
            <div class="v2-profile-page__content">
              <V2ProfileOverview :page="page" />
              <V2ProfileSessionsPanel :page="page" />
            </div>
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
  Setting,
  User
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2ProfileOverview from '@/v2/features/profile/components/V2ProfileOverview.vue';
import V2ProfileSessionsPanel from '@/v2/features/profile/components/V2ProfileSessionsPanel.vue';
import type { V2ProfileRecord, V2ProfileSessionRecord } from '@/v2/features/profile/contracts';
import {
  formatProfileDate,
  profileClientSummary,
  profileRoleLabel,
  profileSessionStateMeta
} from '@/v2/features/profile/profile-presentation';
import type { useProfilePage } from '@/v2/features/profile/useProfilePage';

type ProfilePage = UnwrapNestedRefs<ReturnType<typeof useProfilePage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '个人中心', icon: Setting, active: true }
];

const profile: V2ProfileRecord = {
  id: 'user-1',
  username: 'admin',
  displayName: '系统管理员',
  emailMasked: 'ad***@example.com',
  phoneMasked: '138****2800',
  status: 'active',
  roles: [{ code: 'admin', name: '管理员' }],
  mustResetPassword: false,
  lastAuthenticatedAt: '2026-08-11T08:20:00.000Z',
  lastLoginAt: '2026-08-11T08:10:00.000Z',
  createdAt: '2026-01-10T08:20:00.000Z',
  updatedAt: '2026-08-11T08:20:00.000Z'
};

function makeSession(index: number): V2ProfileSessionRecord {
  return {
    id: `profile-session-${index + 1}`,
    userId: profile.id,
    user: { id: profile.id, username: profile.username, displayName: profile.displayName },
    ip: `192.168.30.${10 + (index % 20)}`,
    userAgent: index % 2 ? 'Chrome 150 / macOS' : 'Safari 20 / iPhone',
    lastActiveAt: `2026-08-11T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
    expiresAt: '2026-08-12T08:20:00.000Z',
    revokedAt: index % 7 === 6 ? '2026-08-11T09:00:00.000Z' : null,
    createdAt: '2026-08-10T08:20:00.000Z',
    isCurrent: index === 0
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allSessions = emptyState ? [] : Array.from({ length: 23 }, (_, index) => makeSession(index));
const notice = ref('');

const page = reactive({
  query: { page: 1, pageSize: 10 },
  profile,
  mfaStatus: {
    enabled: true,
    configured: true,
    recoveryCodeCount: 8,
    enabledAt: '2026-07-10T08:20:00.000Z',
    lastUsedAt: '2026-08-11T08:20:00.000Z',
    disabledAt: null
  },
  sessions: [] as V2ProfileSessionRecord[],
  sessionTotal: allSessions.length,
  hasOtherActiveSessions: true,
  resolved: true,
  loading: false,
  error: '',
  revokingSessionId: '',
  revokingOthers: false,
  mfaSetupLoading: false,
  refresh: () => {
    notice.value = '账户信息已刷新。';
    applyPage();
  },
  handlePageChange: (nextPage: number) => {
    page.query.page = nextPage;
    applyPage();
  },
  handlePageSizeChange: (size: number) => {
    page.query.pageSize = size;
    page.query.page = 1;
    applyPage();
  },
  openChangePassword: () => {
    notice.value = '预览操作：已进入修改密码流程。';
  },
  revokeSession: (item: V2ProfileSessionRecord) => {
    notice.value = `预览操作：将退出 ${item.id}。`;
  },
  revokeOtherSessions: () => {
    notice.value = '预览操作：将退出其他设备。';
  },
  openMfaSetup: () => {
    notice.value = '预览操作：已打开 MFA 绑定。';
  },
  regenerateRecoveryCodes: () => {
    notice.value = '预览操作：将重新生成恢复码。';
  },
  disableMfa: () => {
    notice.value = '预览操作：将停用 MFA。';
  },
  formatProfileDate,
  profileClientSummary,
  profileRoleLabel,
  profileSessionStateMeta
}) as unknown as ProfilePage;

function applyPage() {
  page.sessionTotal = allSessions.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.sessions = allSessions.slice(start, start + page.query.pageSize);
  page.hasOtherActiveSessions = page.sessions.some((item) => !item.isCurrent && !item.revokedAt);
}

applyPage();
</script>

<style scoped>
.v2-profile-fixture-avatar {
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
.v2-profile-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
