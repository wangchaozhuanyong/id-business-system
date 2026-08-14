<template>
  <div class="v2-shell v2-activations-design-fixture">
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
            <a class="v2-navigation__item" href="#orders">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单管理</span>
            </a>
            <a class="v2-navigation__item" href="#customers">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">客户记录</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#activations">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">开通记录</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>开通记录</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-activations-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-activations-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page">
            <V2ActivationsOverview :page="page" />
            <V2ActivationsToolbar :page="page" />
            <V2ActivationsList :page="page" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
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
import V2ActivationsList from '@/v2/features/activations/components/V2ActivationsList.vue';
import V2ActivationsOverview from '@/v2/features/activations/components/V2ActivationsOverview.vue';
import V2ActivationsToolbar from '@/v2/features/activations/components/V2ActivationsToolbar.vue';
import type { useActivationsPage } from '@/v2/features/activations/useActivationsPage';
import type {
  V2Activation,
  V2ActivationDueStatus,
  V2ActivationStoredStatus
} from '@/v2/types/activations';

type ActivationsPage = UnwrapNestedRefs<ReturnType<typeof useActivationsPage>>;

const navigation = [
  { title: '业务中心', icon: Document, active: true },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

const dueStatusOptions: Array<{ value: V2ActivationDueStatus; label: string }> = [
  { value: 'due_within_1_hour', label: '1小时内到期' },
  { value: 'due_within_23_hours', label: '23小时内到期' },
  { value: 'due_within_7_days', label: '7天内到期' },
  { value: 'expired', label: '已到期' },
  { value: 'active', label: '正常' },
  { value: 'abnormal', label: '异常' },
  { value: 'cancelled', label: '已取消' }
];
const statuses: V2ActivationDueStatus[] = [
  'active',
  'due_within_7_days',
  'due_within_23_hours',
  'due_within_1_hour',
  'expired',
  'abnormal',
  'cancelled'
];
const customerNames = ['王明', '林晓雯', '陈先生', '周欣怡', '郑文杰', '黄女士'];
const serviceNames = ['ChatGPT Plus', 'Claude Pro', 'Midjourney', 'Canva Pro'];

function storedStatus(status: V2ActivationDueStatus): V2ActivationStoredStatus {
  if (status === 'expired' || status === 'abnormal' || status === 'cancelled') return status;
  return 'active';
}

function statusLabel(status: V2ActivationDueStatus) {
  return dueStatusOptions.find((option) => option.value === status)?.label ?? status;
}

function makeActivation(index: number): V2Activation {
  const status = statuses[index % statuses.length];
  const day = String(10 - Math.floor(index / 5)).padStart(2, '0');
  return {
    id: `activation-${index + 1}`,
    orderId: `order-${index + 1}`,
    order: {
      id: `order-${index + 1}`,
      orderNo: `V2202608${day}${String(index + 1).padStart(6, '0')}`,
      status: 'completed',
      receivedAmount: `${129 + index * 3}.8`,
      profitAmount: `${23 + index}.4`
    },
    customer: { id: `customer-${index + 1}`, name: customerNames[index % customerNames.length] },
    service: {
      id: `service-${(index % serviceNames.length) + 1}`,
      code: `service-${(index % serviceNames.length) + 1}`,
      name: serviceNames[index % serviceNames.length],
      parent: { id: 'category-ai', name: 'AI 工具' }
    },
    account: {
      id: `account-${index + 1}`,
      appleIdMasked: `${String(85 + index).padStart(2, '0')}********@qq.com`,
      displayAppleId: `${String(85 + index).padStart(2, '0')}********@qq.com`,
      country: { id: 'country-us', code: 'US', name: '美国' }
    },
    maskedWebsiteAccount:
      index % 4 === 3 ? null : `user_${String(index + 1).padStart(2, '0')}***@mail.com`,
    displayWebsiteAccount:
      index % 4 === 3 ? null : `user_${String(index + 1).padStart(2, '0')}***@mail.com`,
    openedAt: `2026-08-${day}T08:20:00.000Z`,
    dueAt: `2026-09-${day}T08:20:00.000Z`,
    storedStatus: storedStatus(status),
    status: {
      code: status,
      label: statusLabel(status),
      hoursRemaining: status === 'expired' ? -12 : 36 + index,
      daysRemaining: status === 'expired' ? -1 : Math.ceil((36 + index) / 24)
    },
    remark: index % 5 === 0 ? '到期前联系客户确认续费' : null,
    statusChangedAt: `2026-08-${day}T08:20:00.000Z`,
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: `2026-08-${day}T08:20:00.000Z`,
    updatedAt: `2026-08-${day}T16:05:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allActivations: V2Activation[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeActivation(index));
const notice = ref('');

const page = reactive({
  items: [] as V2Activation[],
  total: 0,
  loading: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  activeFilterCount: 0,
  activationStatusStripItems: [] as Array<{
    key: string;
    label: string;
    count: number;
    tone?: 'danger' | 'warning' | 'primary' | 'success' | 'neutral';
  }>,
  dueStatusOptions,
  dueRange: [] as [string, string] | [],
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    dueStatus: '' as V2ActivationDueStatus | '',
    sortBy: 'openedAt',
    sortOrder: 'desc'
  },
  loadActivations: () => {
    notice.value = '开通记录已刷新，到期状态已重新评估。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, { page: 1, keyword: '', dueStatus: '' });
    page.dueRange = [];
    applyFilters();
  },
  selectDueStatus: (key: string) => {
    page.query.dueStatus = page.query.dueStatus === key ? '' : (key as V2ActivationDueStatus);
    applyFilters(true);
  },
  handlePageChange: () => applyFilters(),
  handlePageSizeChange: () => applyFilters(true),
  handleSortChange: () => undefined,
  openDetail: (item: V2Activation) => {
    notice.value = `预览操作：正在查看订单 ${item.order.orderNo} 的开通快照。`;
  },
  statusType: (status: V2ActivationDueStatus) => {
    if (status === 'active') return 'success';
    if (status === 'due_within_7_days') return 'primary';
    if (status === 'due_within_23_hours' || status === 'due_within_1_hour') return 'warning';
    if (status === 'expired' || status === 'abnormal') return 'danger';
    return 'info';
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
      : '—'
}) as unknown as ActivationsPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allActivations.filter((activation) => {
    const matchesKeyword =
      !keyword ||
      [
        activation.order.orderNo,
        activation.customer.name,
        activation.service.name,
        activation.account.appleIdMasked
      ].some((value) => value.toLowerCase().includes(keyword));
    return (
      matchesKeyword && (!page.query.dueStatus || activation.status.code === page.query.dueStatus)
    );
  });
  page.activeFilterCount = [
    keyword,
    page.query.dueStatus,
    page.dueRange.length ? 'dueRange' : ''
  ].filter(Boolean).length;
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
  const visibleStatuses: V2ActivationDueStatus[] = [
    'due_within_1_hour',
    'due_within_23_hours',
    'due_within_7_days',
    'expired',
    'active'
  ];
  const tones: Partial<
    Record<V2ActivationDueStatus, 'danger' | 'warning' | 'primary' | 'success'>
  > = {
    due_within_1_hour: 'danger',
    due_within_23_hours: 'warning',
    due_within_7_days: 'primary',
    expired: 'danger',
    active: 'success'
  };
  page.activationStatusStripItems = visibleStatuses.map((status) => ({
    key: status,
    label:
      status === 'expired' || status === 'active'
        ? statusLabel(status)
        : statusLabel(status).replace('到期', ''),
    count: page.items.filter((item) => item.status.code === status).length,
    tone: tones[status]
  }));
}

applyFilters();
</script>

<style scoped>
.v2-activations-fixture-avatar {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 13px;
  font-weight: 700;
}

.v2-activations-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
