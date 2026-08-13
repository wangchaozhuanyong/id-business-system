<template>
  <div class="v2-shell v2-employees-design-fixture">
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
            <a class="v2-navigation__item" href="#branding">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">品牌设置</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#employees">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">员工账户</span>
            </a>
            <a class="v2-navigation__item" href="/roles-design-fixture.html#roles">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">角色权限</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>员工账户</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-employees-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-employees-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-employees-page">
            <V2EmployeesOverview :page="page" />
            <V2EmployeesToolbar :page="page" />
            <V2EmployeesList :page="page" />
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
import V2EmployeesList from '@/v2/features/employees/components/V2EmployeesList.vue';
import V2EmployeesOverview from '@/v2/features/employees/components/V2EmployeesOverview.vue';
import V2EmployeesToolbar from '@/v2/features/employees/components/V2EmployeesToolbar.vue';
import type {
  V2Employee,
  V2EmployeeRole,
  V2EmployeeStatus
} from '@/v2/features/employees/contracts';
import type { useEmployeesPage } from '@/v2/features/employees/useEmployeesPage';

type EmployeesPage = UnwrapNestedRefs<ReturnType<typeof useEmployeesPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];

const roleOptions: V2EmployeeRole[] = [
  { id: 'role-admin', code: 'admin', name: '管理员' },
  { id: 'role-operations', code: 'operations', name: '业务运营' },
  { id: 'role-finance', code: 'finance', name: '财务专员' },
  { id: 'role-auditor', code: 'auditor', name: '审计查看' }
];
const employeeNames = ['王超', '林晓雯', '陈立', '周欣怡', '郑文杰', '黄敏'];

function makeEmployee(index: number): V2Employee {
  const active = index % 5 !== 4;
  const roles = index === 0 ? [roleOptions[0]] : [roleOptions[(index % 3) + 1]];
  return {
    id: `employee-${index + 1}`,
    username: index === 0 ? 'admin' : `operator${String(index + 1).padStart(2, '0')}`,
    displayName: index === 0 ? '系统管理员' : employeeNames[index % employeeNames.length],
    status: active ? 'active' : 'disabled',
    roles,
    mustResetPassword: index > 0 && index % 4 === 0,
    activeSessionCount: active ? index % 3 : 0,
    lastLoginAt:
      index % 6 === 5
        ? null
        : `2026-08-${String(10 - Math.floor(index / 4)).padStart(2, '0')}T${String(8 + (index % 8)).padStart(2, '0')}:20:00.000Z`,
    lastAuthenticatedAt: `2026-08-10T08:20:00.000Z`,
    createdBy:
      index === 0 ? null : { id: 'employee-1', username: 'admin', displayName: '系统管理员' },
    createdAt: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T08:20:00.000Z`,
    updatedAt: `2026-08-10T08:20:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allEmployees = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeEmployee(index));
const notice = ref('');

const page = reactive({
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    status: '' as V2EmployeeStatus | '',
    roleId: '',
    sortBy: 'createdAt',
    sortOrder: 'desc'
  },
  items: [] as V2Employee[],
  total: 0,
  roleOptions,
  activeFilterCount: 0,
  loading: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  loadEmployees: () => {
    notice.value = '员工账户已刷新。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, { page: 1, keyword: '', status: '', roleId: '' });
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
    notice.value = '预览操作：已打开员工开通入口。';
  },
  openEdit: (item: V2Employee) => {
    notice.value = `预览操作：正在编辑 ${item.displayName}。`;
  },
  formatDate: (value: string | null) =>
    value
      ? new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(new Date(value))
      : '从未登录'
}) as unknown as EmployeesPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allEmployees.filter((employee) => {
    const matchesKeyword =
      !keyword ||
      employee.username.toLowerCase().includes(keyword) ||
      employee.displayName.toLowerCase().includes(keyword);
    const matchesStatus = !page.query.status || employee.status === page.query.status;
    const matchesRole =
      !page.query.roleId || employee.roles.some((role) => role.id === page.query.roleId);
    return matchesKeyword && matchesStatus && matchesRole;
  });
  page.activeFilterCount = [keyword, page.query.status, page.query.roleId].filter(Boolean).length;
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-employees-fixture-avatar {
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

.v2-employees-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
