<template>
  <div class="v2-shell v2-roles-design-fixture">
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
            <a class="v2-navigation__item" href="#employees">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">员工账户</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#roles">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">角色权限</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>角色权限</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-roles-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-roles-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-roles-page">
            <V2RolesOverview :page="page" />
            <V2RolesToolbar :page="page" />
            <V2RolesList :page="page" />
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
import V2RolesList from '@/v2/features/roles/components/V2RolesList.vue';
import V2RolesOverview from '@/v2/features/roles/components/V2RolesOverview.vue';
import V2RolesToolbar from '@/v2/features/roles/components/V2RolesToolbar.vue';
import type { V2Role } from '@/v2/features/roles/contracts';
import type { useRolesPage } from '@/v2/features/roles/useRolesPage';

type RolesPage = UnwrapNestedRefs<ReturnType<typeof useRolesPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];

const roleNames = ['业务运营', '客户维护', '财务专员', '续费专员', '审计查看', '资料审核'];

function makeRole(index: number): V2Role {
  const isSystemRole = index < 2;
  const name = isSystemRole ? (index === 0 ? '系统管理员' : '普通员工') : roleNames[index % 6];
  const code = isSystemRole
    ? index === 0
      ? 'admin'
      : 'employee'
    : `business.role.${String(index + 1).padStart(2, '0')}`;
  const permissionIds = Array.from(
    { length: 4 + (index % 8) },
    (_, permissionIndex) => `permission-${permissionIndex + 1}`
  );
  return {
    id: `role-${index + 1}`,
    name: isSystemRole ? name : `${name} ${String(index + 1).padStart(2, '0')}`,
    code,
    description: isSystemRole
      ? '系统内置角色，权限策略只读。'
      : '负责对应业务范围的数据查看、录入与审批。',
    isSystemRole,
    permissions: [],
    permissionIds,
    sensitiveApprovalPermissionIds: index % 3 === 0 ? permissionIds.slice(0, 2) : [],
    permissionCount: permissionIds.length,
    memberCount: index % 7,
    createdAt: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T08:20:00.000Z`,
    updatedAt: `2026-08-${String(1 + (index % 10)).padStart(2, '0')}T10:30:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allRoles = emptyState ? [] : Array.from({ length: 23 }, (_, index) => makeRole(index));
const notice = ref('');

const page = reactive({
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    sortBy: 'code',
    sortOrder: 'asc'
  },
  items: [] as V2Role[],
  total: 0,
  activeFilterCount: 0,
  loading: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  loadRoles: () => {
    notice.value = '角色权限已刷新。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, { page: 1, keyword: '' });
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
  openCreate: () => {
    notice.value = '预览操作：已打开新建角色入口。';
  },
  openEdit: (item: V2Role) => {
    notice.value = `预览操作：正在${item.isSystemRole ? '查看' : '编辑'} ${item.name}。`;
  },
  formatDate: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value))
}) as unknown as RolesPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allRoles.filter(
    (role) =>
      !keyword ||
      role.name.toLowerCase().includes(keyword) ||
      role.code.toLowerCase().includes(keyword) ||
      role.description?.toLowerCase().includes(keyword)
  );
  page.activeFilterCount = keyword ? 1 : 0;
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-roles-fixture-avatar {
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

.v2-roles-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
