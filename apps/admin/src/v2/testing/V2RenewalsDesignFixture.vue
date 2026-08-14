<template>
  <div class="v2-shell v2-renewals-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#renewals">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">续费操作</span>
            </a>
            <a class="v2-navigation__item" href="#order-entry">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单录入</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>续费操作</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-renewals-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-renewals-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page">
            <V2RenewalsOverview :page="page" />
            <V2RenewalsToolbar :page="page" />
            <V2RenewalsList :page="page" />
          </section>

          <V2RenewalOrderDrawer
            v-model="drawerVisible"
            v-model:confirmation-visible="confirmationVisible"
            v-model:category-option-id="renewalForm.categoryOptionId"
            v-model:service-option-id="renewalForm.serviceOptionId"
            v-model:settlement-platform-option-id="renewalForm.settlementPlatformOptionId"
            v-model:platform-order-no="renewalForm.platformOrderNo"
            v-model:received-amount="renewalForm.receivedAmount"
            v-model:target-profit-rate="renewalForm.targetProfitRate"
            v-model:balance-amount="renewalForm.balanceAmount"
            v-model:opened-at="renewalForm.openedAt"
            v-model:due-at="renewalForm.dueAt"
            v-model:remark="renewalForm.remark"
            :renewal="selectedRenewal"
            :categories="manualRenewalCategories"
            :services="manualRenewalServices"
            :settlement-platforms="manualRenewalOptions.settlementPlatforms"
            :selected-service="selectedManualService"
            :options-loading="false"
            options-error=""
            :submitting="false"
            submit-disabled-reason=""
            platform-fee-preview="2.80"
            estimated-balance-cost-preview="116.00"
            estimated-profit-preview="31.20"
            estimated-profit-rate-preview="20.80"
            :suggested-received="suggestedReceived"
            :recommendation-applied="recommendationApplied"
            applied-suggested-cny="150.00"
            balance-after-preview="304.20"
            confirmation-message="设计验收夹具不会提交业务数据。"
            @opened-at-change="handleOpenedAtChange"
            @category-change="handleCategoryChange"
            @settlement-platform-change="handleSettlementPlatformChange"
            @apply-suggested="applySuggestedPrice"
            @undo-suggested="undoSuggestedPrice"
            @manual-price-input="recommendationApplied = false"
            @open-confirmation="confirmationVisible = true"
            @submit="handleFixtureSubmit"
          />
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
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
import V2RenewalOrderDrawer from '@/v2/features/renewals/components/V2RenewalOrderDrawer.vue';
import V2RenewalsList from '@/v2/features/renewals/components/V2RenewalsList.vue';
import V2RenewalsOverview from '@/v2/features/renewals/components/V2RenewalsOverview.vue';
import V2RenewalsToolbar from '@/v2/features/renewals/components/V2RenewalsToolbar.vue';
import { addOneInclusiveMonthToV2DateTimeInput } from '@/v2/utils/dateTime';
import type { useRenewalsPage } from '@/v2/features/renewals/useRenewalsPage';
import type {
  V2ManualRenewalOptions,
  V2RenewalDueStatus,
  V2RenewalStatusCode,
  V2RenewalWorkbenchItem
} from '@/v2/types/renewals';

type RenewalsPage = UnwrapNestedRefs<ReturnType<typeof useRenewalsPage>>;
type RenewalWarningScope = '' | 'warning' | 'expired';

const navigation = [
  { title: '工作台', icon: Document, active: true },
  { title: '业务中心', icon: Document, active: false },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];
const dueStatusOptions: Array<{ value: V2RenewalDueStatus; label: string }> = [
  { value: 'due_within_1_hour', label: '1小时内到期' },
  { value: 'due_within_23_hours', label: '23小时内到期' },
  { value: 'due_within_7_days', label: '7天内到期' },
  { value: 'expired', label: '已到期' }
];
const statusSequence: V2RenewalStatusCode[] = [
  'active',
  'due_within_7_days',
  'due_within_23_hours',
  'due_within_1_hour',
  'expired'
];
const customerNames = ['王明', '林晓雯', '陈先生', '周欣怡', '郑文杰', '黄女士'];
const serviceNames = ['ChatGPT Plus', 'Claude Pro', 'Midjourney', 'Canva Pro'];

function statusLabel(status: V2RenewalStatusCode) {
  if (status === 'active') return '正常';
  return dueStatusOptions.find((option) => option.value === status)?.label ?? status;
}

function makeRenewal(index: number): V2RenewalWorkbenchItem {
  const status = statusSequence[index % statusSequence.length];
  const warningState = status === 'expired' ? 'expired' : status === 'active' ? null : 'upcoming';
  const withinActionWindow = status !== 'active';
  const day = String(10 - Math.floor(index / 5)).padStart(2, '0');
  return {
    id: `renewal-${index + 1}`,
    orderId: `order-${index + 1}`,
    orderNo: `V2202608${day}${String(index + 1).padStart(6, '0')}`,
    customer: { id: `customer-${index + 1}`, name: customerNames[index % customerNames.length] },
    account: {
      id: `account-${index + 1}`,
      appleIdMasked: `${String(85 + index).padStart(2, '0')}********@qq.com`,
      currentBalance: `${324 - index * 4}.20`,
      balanceCostAmount: `${116 - index}.40`,
      recordStatus: 'active',
      saleState: index % 3 === 0 ? 'sold' : 'available',
      soldByOrder:
        index % 3 === 0
          ? {
              id: `sold-order-${index + 1}`,
              orderNo: `V2202607${day}${String(index + 1).padStart(6, '0')}`,
              customer: {
                id: `customer-${index + 1}`,
                name: customerNames[index % customerNames.length]
              }
            }
          : null,
      country: { id: 'country-us', code: 'US', name: '美国' }
    },
    service: {
      id: `service-${(index % serviceNames.length) + 1}`,
      code: `service-${(index % serviceNames.length) + 1}`,
      name: serviceNames[index % serviceNames.length],
      parent: { id: 'category-ai', name: 'AI 工具' }
    },
    maskedWebsiteAccount:
      index % 4 === 3 ? null : `user_${String(index + 1).padStart(2, '0')}***@mail.com`,
    openedAt: `2026-08-${day}T08:20:00.000Z`,
    dueAt: `2026-09-${day}T08:20:00.000Z`,
    status: {
      code: status,
      label: statusLabel(status),
      hoursRemaining: status === 'expired' ? -12 : 36 + index,
      daysRemaining: status === 'expired' ? -1 : Math.ceil((36 + index) / 24)
    },
    warningState,
    withinActionWindow,
    updatedAt: `2026-08-${day}T16:05:00.000Z`
  };
}

const fixtureParams = new URLSearchParams(window.location.search);
const emptyState = fixtureParams.get('state') === 'empty';
const allRenewals: V2RenewalWorkbenchItem[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeRenewal(index));
const filterOptions = {
  customers: allRenewals.slice(0, 6).map((item) => item.customer),
  accounts: allRenewals.slice(0, 8).map((item) => ({
    id: item.account.id,
    appleIdMasked: item.account.appleIdMasked
  })),
  services: serviceNames.map((name, index) => ({
    id: `service-${index + 1}`,
    code: `service-${index + 1}`,
    name,
    parent: { id: 'category-ai', name: 'AI 工具' }
  }))
};
const notice = ref('');
const drawerVisible = ref(false);
const confirmationVisible = ref(false);
const selectedRenewal = ref<V2RenewalWorkbenchItem | null>(null);
const recommendationApplied = ref(false);
const manualRenewalOptions: V2ManualRenewalOptions = {
  services: [
    {
      id: 'service-1',
      code: 'chatgpt-plus',
      name: 'ChatGPT Plus',
      category: { id: 'category-ai', name: 'AI 工具' },
      country: {
        id: 'country-us',
        code: 'US',
        name: '美国',
        currencyCode: 'USD'
      },
      businessAmount: '20.00',
      currencyCode: 'USD'
    },
    {
      id: 'service-2',
      code: 'claude-pro',
      name: 'Claude Pro',
      category: { id: 'category-ai', name: 'AI 工具' },
      country: {
        id: 'country-us',
        code: 'US',
        name: '美国',
        currencyCode: 'USD'
      },
      businessAmount: '20.00',
      currencyCode: 'USD'
    },
    {
      id: 'service-3',
      code: 'netflix-premium',
      name: 'Netflix Premium',
      category: { id: 'category-streaming', name: '影音订阅' },
      country: {
        id: 'country-us',
        code: 'US',
        name: '美国',
        currencyCode: 'USD'
      },
      businessAmount: '22.99',
      currencyCode: 'USD'
    }
  ],
  settlementPlatforms: [
    {
      id: 'platform-1',
      code: 'alipay',
      name: '支付宝',
      fixedFee: '0.00',
      percentageFee: '1.90'
    }
  ]
};
const renewalForm = reactive({
  categoryOptionId: 'category-ai',
  serviceOptionId: 'service-1',
  settlementPlatformOptionId: 'platform-1',
  platformOrderNo: '202608120001',
  receivedAmount: '150',
  targetProfitRate: '20',
  balanceAmount: '20',
  openedAt: '2026-09-10T16:20',
  dueAt: '2026-10-09T16:20',
  remark: ''
});
const manualRenewalCategories = [
  { id: 'category-ai', name: 'AI 工具' },
  { id: 'category-streaming', name: '影音订阅' }
];
const manualRenewalServices = computed(() =>
  manualRenewalOptions.services.filter(
    (service) => service.category?.id === renewalForm.categoryOptionId
  )
);
const selectedManualService = computed(
  () =>
    manualRenewalOptions.services.find((service) => service.id === renewalForm.serviceOptionId) ??
    null
);
const suggestedReceived = {
  amount: '150.00',
  exactAmount: '149.87',
  platformFee: '2.80',
  estimatedProfit: '31.20',
  estimatedProfitRate: '20.80',
  error: ''
};

const page = reactive({
  items: [] as V2RenewalWorkbenchItem[],
  total: 0,
  evaluatedAt: '2026-08-10T09:20:00.000Z',
  loading: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  canRenew: true,
  canManageWarning: true,
  warningDays: 7,
  renewalStatusStripItems: [] as Array<{
    key: string;
    label: string;
    count: number;
    tone?: 'danger' | 'warning' | 'primary' | 'success' | 'neutral';
  }>,
  activeWarningScope: 'warning' as RenewalWarningScope,
  emptyDescription: '当前筛选条件下没有数据',
  dueStatusOptions,
  dueRange: [] as [string, string] | [],
  filterOptions,
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    customerId: '',
    serviceOptionId: '',
    accountId: '',
    dueStatus: '' as V2RenewalDueStatus | '',
    sortBy: 'dueAt',
    sortOrder: 'asc'
  },
  openWarningSettings: () => {
    notice.value = '预览操作：已打开续费预警设置。';
  },
  loadWorkbench: () => {
    notice.value = '续费待办已刷新，到期状态已重新计算。';
    applyFilters();
  },
  selectWarningScope: (key: string) => {
    if (key !== 'warning' && key !== 'expired') return;
    page.dueRange = [];
    page.activeWarningScope = key;
    page.query.dueStatus = key === 'expired' ? 'expired' : '';
    applyFilters(true);
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  handleTimeFilterChange: () => {
    page.activeWarningScope = page.query.dueStatus === 'expired' ? 'expired' : '';
    applyFilters(true);
  },
  handlePageChange: () => applyFilters(),
  handlePageSizeChange: () => applyFilters(true),
  handleSortChange: () => undefined,
  openRenewalDrawer: (item: V2RenewalWorkbenchItem) => {
    notice.value = `预览操作：正在为 ${item.customer.name} 录入续费订单。`;
    selectedRenewal.value = item;
    drawerVisible.value = true;
  },
  renewalActionDisabledReason: (item: V2RenewalWorkbenchItem) =>
    item.withinActionWindow ? '' : '仅支持为 7 天内到期或已到期记录续费',
  renewalRowClassName: ({ row }: { row: V2RenewalWorkbenchItem }) =>
    row.warningState === 'expired'
      ? 'is-renewal-expired'
      : row.warningState === 'upcoming'
        ? 'is-renewal-warning'
        : '',
  serviceLabel: (service: (typeof filterOptions.services)[number]) =>
    service.parent ? `${service.parent.name} / ${service.name}` : service.name,
  formatDecimal: (value: string | number | null | undefined) => value?.toString() ?? '0.00',
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
      : '—',
  formatTime: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value)),
  statusType: (status: V2RenewalStatusCode) => {
    if (status === 'expired' || status === 'due_within_1_hour') return 'danger';
    if (status === 'due_within_23_hours') return 'warning';
    return 'info';
  }
}) as unknown as RenewalsPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allRenewals.filter((renewal) => {
    const matchesKeyword =
      !keyword ||
      [
        renewal.orderNo,
        renewal.customer.name,
        renewal.account.appleIdMasked,
        renewal.maskedWebsiteAccount
      ]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(keyword));
    const matchesWarning =
      page.activeWarningScope !== 'warning' || renewal.warningState === 'upcoming';
    return (
      matchesKeyword &&
      matchesWarning &&
      (!page.query.dueStatus || renewal.status.code === page.query.dueStatus) &&
      (!page.query.customerId || renewal.customer.id === page.query.customerId) &&
      (!page.query.serviceOptionId || renewal.service.id === page.query.serviceOptionId) &&
      (!page.query.accountId || renewal.account.id === page.query.accountId)
    );
  });
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
  page.renewalStatusStripItems = [
    {
      key: 'warning',
      label: '未来 7 天预警',
      count: allRenewals.filter((item) => item.warningState === 'upcoming').length,
      tone: 'warning'
    },
    {
      key: 'expired',
      label: '已到期',
      count: allRenewals.filter((item) => item.warningState === 'expired').length,
      tone: 'danger'
    }
  ];
}

function handleOpenedAtChange(value: string | null) {
  if (!value) return;
  renewalForm.dueAt = addOneInclusiveMonthToV2DateTimeInput(value);
}

function handleSettlementPlatformChange() {
  if (!renewalForm.settlementPlatformOptionId) renewalForm.platformOrderNo = '';
}

function handleCategoryChange() {
  const serviceMatchesCategory = manualRenewalOptions.services.some(
    (service) =>
      service.id === renewalForm.serviceOptionId &&
      service.category?.id === renewalForm.categoryOptionId
  );
  if (!serviceMatchesCategory) renewalForm.serviceOptionId = '';
}

function applySuggestedPrice() {
  renewalForm.receivedAmount = suggestedReceived.amount ?? '';
  recommendationApplied.value = true;
}

function undoSuggestedPrice() {
  renewalForm.receivedAmount = '';
  recommendationApplied.value = false;
}

function handleFixtureSubmit() {
  confirmationVisible.value = false;
  notice.value = '设计验收完成，未提交任何业务数据。';
}

applyFilters();
if (fixtureParams.get('drawer') === 'open' && allRenewals[0]) {
  selectedRenewal.value = allRenewals[0];
  drawerVisible.value = true;
}
</script>

<style scoped>
.v2-renewals-fixture-avatar {
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

.v2-renewals-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
