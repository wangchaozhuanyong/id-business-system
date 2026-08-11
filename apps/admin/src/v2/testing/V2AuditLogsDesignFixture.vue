<template>
  <div class="v2-shell v2-audit-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
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
            <a class="v2-navigation__item" href="#roles">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">角色权限</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#audit-logs">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">审计日志</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>审计日志</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-audit-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-audit-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-audit-logs-page">
            <V2AuditLogsOverview :page="page" />
            <V2AuditLogsNavigation :page="page" />
            <V2AuditLogsToolbar :page="page" />
            <V2AuditLogsList :page="page" />
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
import V2AuditLogsList from '@/v2/features/audit-logs/components/V2AuditLogsList.vue';
import V2AuditLogsNavigation from '@/v2/features/audit-logs/components/V2AuditLogsNavigation.vue';
import V2AuditLogsOverview from '@/v2/features/audit-logs/components/V2AuditLogsOverview.vue';
import V2AuditLogsToolbar from '@/v2/features/audit-logs/components/V2AuditLogsToolbar.vue';
import type {
  V2AuditLogRecord,
  V2AuditLogTab,
  V2SensitiveAccessLogRecord
} from '@/v2/features/audit-logs/contracts';
import {
  auditUserLabel,
  formatAuditDate,
  formatAuditJson,
  operationObjectLabel,
  sensitiveObjectLabel
} from '@/v2/features/audit-logs/audit-log-presentation';
import type { useAuditLogsPage } from '@/v2/features/audit-logs/useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];

const users = [
  { id: 'user-1', username: 'admin', displayName: '系统管理员' },
  { id: 'user-2', username: 'operator01', displayName: '王超' },
  { id: 'user-3', username: 'finance01', displayName: '林晓雯' }
];
const modules = ['apple.order', 'apple.account', 'customer', 'finance', 'data.dictionary'];
const actions = ['create', 'update', 'confirm', 'soft_delete', 'restore_request'];

function makeOperation(index: number): V2AuditLogRecord {
  return {
    id: `operation-${index + 1}`,
    userId: users[index % users.length].id,
    user: users[index % users.length],
    module: modules[index % modules.length],
    action: actions[index % actions.length],
    objectType: index % 2 ? 'Order' : 'AppleAccount',
    objectId: `object-${String(index + 1).padStart(3, '0')}`,
    beforeData: { status: 'pending' },
    afterData: { status: 'completed' },
    ip: `192.168.1.${10 + (index % 20)}`,
    userAgent: 'Chrome / macOS',
    remark: index % 4 === 0 ? '业务资料已复核并完成变更。' : null,
    createdAt: `2026-08-${String(1 + (index % 10)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`
  };
}

function makeSensitiveAccess(index: number): V2SensitiveAccessLogRecord {
  return {
    id: `sensitive-${index + 1}`,
    userId: users[index % users.length].id,
    user: users[index % users.length],
    module: 'apple.secret',
    fieldName: ['password', 'securityAnswers', 'phone'][index % 3],
    objectType: 'AppleAccount',
    objectId: `account-${String(index + 1).padStart(3, '0')}`,
    accessReason: '客户续费核对，需要查看受保护字段。',
    approved: index % 3 !== 0,
    ip: `192.168.2.${10 + (index % 20)}`,
    userAgent: 'Chrome / macOS',
    createdAt: `2026-08-${String(1 + (index % 10)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:40:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allOperations = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeOperation(index));
const allSensitiveAccess = emptyState
  ? []
  : Array.from({ length: 17 }, (_, index) => makeSensitiveAccess(index));
const notice = ref('');

const page = reactive({
  activeTab: 'operations' as V2AuditLogTab,
  createdRange: [] as [string, string] | [],
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    module: '',
    operator: '',
    action: '',
    fieldName: '',
    approved: '' as '' | 'true' | 'false',
    sortBy: 'createdAt',
    sortOrder: 'desc' as 'asc' | 'desc'
  },
  operationItems: [] as V2AuditLogRecord[],
  sensitiveItems: [] as V2SensitiveAccessLogRecord[],
  currentItems: [] as Array<V2AuditLogRecord | V2SensitiveAccessLogRecord>,
  total: 0,
  activeFilterCount: 0,
  loading: false,
  resolved: true,
  listError: '',
  exporting: false,
  detailDrawerVisible: false,
  selectedOperation: null as V2AuditLogRecord | null,
  selectedSensitiveAccess: null as V2SensitiveAccessLogRecord | null,
  refresh: () => {
    notice.value = '审计日志已刷新。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleTabChange: (name: string | number) => {
    page.activeTab = name === 'sensitive_access' ? 'sensitive_access' : 'operations';
    page.query.page = 1;
    applyFilters();
  },
  resetFilters: () => {
    Object.assign(page.query, {
      page: 1,
      keyword: '',
      module: '',
      operator: '',
      action: '',
      fieldName: '',
      approved: ''
    });
    page.createdRange = [];
    applyFilters();
  },
  handleSortChange: () => undefined,
  handlePageChange: (nextPage: number) => {
    page.query.page = nextPage;
    applyFilters();
  },
  handlePageSizeChange: (nextPageSize: number) => {
    page.query.pageSize = nextPageSize;
    applyFilters(true);
  },
  openOperationDetails: (item: V2AuditLogRecord) => {
    notice.value = `预览操作：正在查看 ${item.id}。`;
  },
  openSensitiveDetails: (item: V2SensitiveAccessLogRecord) => {
    notice.value = `预览操作：正在查看 ${item.id}。`;
  },
  exportCurrent: () => {
    notice.value = `预览操作：已导出当前 ${page.total} 条记录。`;
  },
  auditUserLabel,
  formatAuditDate,
  formatAuditJson,
  operationObjectLabel,
  sensitiveObjectLabel
}) as unknown as AuditLogsPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const module = page.query.module.trim().toLowerCase();
  const operator = page.query.operator.trim().toLowerCase();
  const source = page.activeTab === 'operations' ? allOperations : allSensitiveAccess;
  const filtered = source.filter((item) => {
    const objectText = `${item.objectType ?? ''} ${item.objectId ?? ''}`.toLowerCase();
    const userText = `${item.user?.username ?? ''} ${item.user?.displayName ?? ''}`.toLowerCase();
    if (keyword && !`${objectText} ${userText}`.includes(keyword)) return false;
    if (module && !item.module.toLowerCase().includes(module)) return false;
    if (operator && !userText.includes(operator)) return false;
    if ('action' in item && page.query.action && !item.action.includes(page.query.action)) {
      return false;
    }
    if (
      'fieldName' in item &&
      page.query.fieldName &&
      !item.fieldName.includes(page.query.fieldName)
    ) {
      return false;
    }
    if (
      'approved' in item &&
      page.query.approved &&
      String(item.approved) !== page.query.approved
    ) {
      return false;
    }
    return true;
  });
  page.total = filtered.length;
  page.activeFilterCount = [
    page.query.keyword.trim(),
    page.query.module.trim(),
    page.query.operator.trim(),
    page.activeTab === 'operations' ? page.query.action.trim() : page.query.fieldName.trim(),
    page.activeTab === 'sensitive_access' ? page.query.approved : '',
    page.createdRange.length ? 'date' : ''
  ].filter(Boolean).length;
  const start = (page.query.page - 1) * page.query.pageSize;
  const items = filtered.slice(start, start + page.query.pageSize);
  page.operationItems = page.activeTab === 'operations' ? (items as V2AuditLogRecord[]) : [];
  page.sensitiveItems =
    page.activeTab === 'sensitive_access' ? (items as V2SensitiveAccessLogRecord[]) : [];
  page.currentItems = page.activeTab === 'operations' ? page.operationItems : page.sensitiveItems;
}

applyFilters();
</script>

<style scoped>
.v2-audit-fixture-avatar {
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

.v2-audit-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
