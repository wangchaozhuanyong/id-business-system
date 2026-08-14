<template>
  <div class="v2-shell v2-orders-design-fixture">
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
            <el-icon class="v2-navigation__parent-icon">
              <component :is="section.icon" />
            </el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item" href="./order-entry-design-fixture.html#order-entry">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单录入</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#orders">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单列表</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity">
          <h1>订单管理</h1>
        </div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-orders-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-orders-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page">
            <V2OrdersOverview :page="page" />
            <V2OrdersToolbar :page="page" />
            <V2OrdersList :page="page" />
          </section>
        </div>
      </main>
    </div>

    <V2OrderRefundDialog
      v-model="refundDialogVisible"
      :order="refundOrder"
      :saving="false"
      @submit="notice = '预览操作：退款表单校验通过。'"
    />
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
import V2OrdersList from '@/v2/features/orders/components/V2OrdersList.vue';
import V2OrdersOverview from '@/v2/features/orders/components/V2OrdersOverview.vue';
import V2OrderRefundDialog from '@/v2/features/orders/components/V2OrderRefundDialog.vue';
import V2OrdersToolbar from '@/v2/features/orders/components/V2OrdersToolbar.vue';
import type { useOrdersPage } from '@/v2/features/orders/useOrdersPage';
import {
  accountDispositionMeta,
  accountDispositionOptions,
  formatDate,
  formatDecimal,
  formatNullableDecimal,
  profitClass,
  selectorLabel,
  statusMeta,
  statusOptions
} from '@/v2/features/orders/order-presentation';
import type { V2OptionSelector, V2Order, V2OrderStatus } from '@/v2/features/orders/contracts';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

const navigation = [
  { title: '订单管理', icon: Document, active: true },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

const serviceOptions: V2OptionSelector[] = [
  {
    id: 'service-chatgpt-plus',
    type: 'service',
    code: 'chatgpt-plus-20',
    name: 'plus-20us / 20 USD',
    parentId: 'category-chatgpt',
    parent: { id: 'category-chatgpt', name: 'ChatGPT' },
    countryOptionId: 'country-us',
    country: { id: 'country-us', name: '美国', currencyCode: 'USD' },
    businessAmount: '20',
    currencyCode: 'USD'
  },
  {
    id: 'service-icloud',
    type: 'service',
    code: 'icloud-200gb',
    name: 'iCloud+ 200GB',
    parentId: 'category-apple',
    parent: { id: 'category-apple', name: 'Apple 服务' },
    countryOptionId: 'country-us',
    country: { id: 'country-us', name: '美国', currencyCode: 'USD' },
    businessAmount: '2.99',
    currencyCode: 'USD'
  }
];

const settlementOptions: V2OptionSelector[] = [
  {
    id: 'settlement-company',
    type: 'settlement_platform',
    code: 'company',
    name: '公司开发',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: 'CNY'
  },
  {
    id: 'settlement-wechat',
    type: 'settlement_platform',
    code: 'wechat',
    name: '微信收款',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: 'CNY'
  }
];

const statuses: V2OrderStatus[] = [
  'pending',
  'processing',
  'completed',
  'completed',
  'waiting_external',
  'completed',
  'draft',
  'refunded'
];
const customers = ['王朝', '陈先生', '林女士', '云帆科技', '周先生', '星河工作室'];
const accounts = [
  '85********@qq.com',
  '77********@163.com',
  '92********@gmail.com',
  '60********@qq.com'
];
const receivedAmounts = ['188', '200', '212', '224', '236'];
const accountCosts = ['116', '119', '122', '125'];
const profitAmounts = ['64', '73', '82', '91', '96'];
const profitRates = ['34.04', '36.50', '38.68', '40.63', '40.68'];

function makeOrder(index: number): V2Order {
  const status = statuses[index % statuses.length];
  const service = serviceOptions[index % serviceOptions.length];
  const completed = status === 'completed';
  const receivedAmount = receivedAmounts[index % receivedAmounts.length];
  const cost = accountCosts[index % accountCosts.length];
  const day = String(9 - Math.floor(index / 5)).padStart(2, '0');
  const hour = String(8 + (index % 9)).padStart(2, '0');

  return {
    id: `order-${index + 1}`,
    orderNo: `V2202608${day}${String(index + 1).padStart(6, '0')}`,
    customer: {
      id: `customer-${(index % customers.length) + 1}`,
      name: customers[index % customers.length]
    },
    service: {
      id: service.id,
      code: service.code,
      name: service.name,
      parent: service.parent ? { id: service.parent.id, name: service.parent.name } : null
    },
    account: {
      id: `account-${(index % accounts.length) + 1}`,
      appleIdMasked: accounts[index % accounts.length],
      displayAppleId: accounts[index % accounts.length],
      country: { id: 'country-us', code: 'US', name: '美国' }
    },
    settlementPlatform: {
      id: settlementOptions[index % settlementOptions.length].id,
      code: settlementOptions[index % settlementOptions.length].code,
      name: settlementOptions[index % settlementOptions.length].name
    },
    platformOrderNo: index % 3 === 0 ? `PT202608${String(index + 1).padStart(5, '0')}` : null,
    maskedWebsiteAccount: `${String(728455343 + index).slice(0, 5)}****@qq.com`,
    displayWebsiteAccount: `${String(728455343 + index).slice(0, 5)}****@qq.com`,
    hasWebsiteAccount: true,
    receivedAmount,
    receivedOriginalAmount: receivedAmount,
    receivedCurrency: 'CNY',
    receivedFxRateToCny: '1',
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedAt: `2026-08-${day}T${hour}:18:00.000Z`,
    platformFeeAmount: '8',
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    sourceSoldOrder: null,
    accountDisposition: index % 4 === 0 ? 'sold' : 'retained',
    accountCostAmount: cost,
    appliedAccountCostAmount: cost,
    balanceAmount: '20',
    balanceCostAmount: cost,
    refundCostAmount: status === 'refunded' ? '20' : null,
    profitAmount: completed ? profitAmounts[index % profitAmounts.length] : null,
    profitRate: completed ? profitRates[index % profitRates.length] : null,
    status,
    statusChangedAt: `2026-08-${day}T${hour}:30:00.000Z`,
    openedAt: status === 'draft' ? null : `2026-08-${day}T${hour}:20:00.000Z`,
    dueAt: status === 'draft' ? null : `2026-09-${day}T${hour}:20:00.000Z`,
    remark: index % 4 === 0 ? '客户要求开通后发送确认信息' : null,
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: `2026-08-${day}T${hour}:05:00.000Z`,
    updatedAt: `2026-08-${day}T${hour}:30:00.000Z`,
    activeLock: null,
    operations: {
      canConsume: status === 'pending',
      canComplete: status === 'processing' || status === 'waiting_external',
      canEdit: status !== 'refunded',
      canEditCore: status === 'draft' || status === 'pending',
      canEditPricing: status !== 'refunded',
      canRefund: status === 'completed',
      canCancel: status === 'draft' || status === 'pending',
      canDelete: status === 'draft'
    }
  };
}

const fixtureParams = new URLSearchParams(window.location.search);
const emptyState = fixtureParams.get('state') === 'empty';
const allOrders: V2Order[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeOrder(index));
const notice = ref('');
const refundOrder = allOrders.find((order) => order.status === 'completed') ?? null;
const refundDialogVisible = ref(fixtureParams.get('refundDialog') === 'open');

const page = reactive({
  statusOptions,
  accountDispositionOptions,
  items: [] as V2Order[],
  total: 0,
  loading: false,
  queryPhase: 'ready' as const,
  isParameterTransition: false,
  listError: '',
  displayedPage: 1,
  displayedPageSize: 10,
  serviceOptions,
  settlementOptions,
  openedRange: [] as string[],
  consumingOrderId: '',
  completingOrderId: '',
  lifecycleBusyOrderId: '',
  canConsumeOrders: true,
  canUpdateOrders: true,
  canDeleteOrders: true,
  hasActiveFilters: false,
  activeFilterCount: 0,
  hasLoadedOnce: true,
  isInitialLoading: false,
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    serviceOptionId: '',
    settlementPlatformOptionId: '',
    status: '' as V2OrderStatus | '',
    accountDisposition: '',
    accountSource: '',
    sortBy: 'openedAt',
    sortOrder: 'desc'
  },
  loadOrders: () => {
    notice.value = '订单数据已刷新，当前内容保持稳定。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    page.query.keyword = '';
    page.query.status = '';
    page.query.accountDisposition = '';
    page.query.accountSource = '';
    page.query.serviceOptionId = '';
    page.query.settlementPlatformOptionId = '';
    page.openedRange = [];
    applyFilters(true);
  },
  handlePageSizeChange: (pageSize: number) => {
    page.query.pageSize = pageSize;
    page.displayedPageSize = pageSize;
    applyFilters(true);
  },
  handlePageChange: (currentPage: number) => {
    page.query.page = currentPage;
    page.displayedPage = currentPage;
    applyFilters();
  },
  openOrderEntry: () => {
    notice.value = '预览操作：将进入订单录入页。';
  },
  handleSortChange: () => undefined,
  openDetail: (order: V2Order) => {
    notice.value = `预览操作：正在查看订单 ${order.orderNo}。`;
  },
  openEdit: (order: V2Order) => {
    notice.value = `预览操作：正在修改订单 ${order.orderNo}。`;
  },
  hasLifecycleActions: (order: V2Order) =>
    order.operations.canRefund || order.operations.canCancel || order.operations.canDelete,
  handleLifecycleCommand: (_command: unknown, order: V2Order) => {
    notice.value = `预览操作：已选择订单 ${order.orderNo} 的后续处理。`;
  },
  consumeOrderBalance: (order: V2Order) => {
    notice.value = `预览操作：已进入订单 ${order.orderNo} 的余额扣减确认。`;
  },
  completeOrder: (order: V2Order) => {
    notice.value = `预览操作：已进入订单 ${order.orderNo} 的开通确认。`;
  },
  statusMeta,
  accountDispositionMeta,
  selectorLabel,
  formatDecimal,
  formatNullableDecimal,
  profitClass,
  formatDate
}) as unknown as OrdersPage;

function applyFilters(resetPage = false) {
  if (resetPage) {
    page.query.page = 1;
    page.displayedPage = 1;
  }
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allOrders.filter((order) => {
    const matchesKeyword =
      !keyword ||
      [order.orderNo, order.customer.name, order.platformOrderNo, order.maskedWebsiteAccount]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(keyword));
    const matchesStatus = !page.query.status || order.status === page.query.status;
    const matchesDisposition =
      !page.query.accountDisposition || order.accountDisposition === page.query.accountDisposition;
    const matchesAccountSource =
      !page.query.accountSource || order.accountSource === page.query.accountSource;
    const matchesService =
      !page.query.serviceOptionId || order.service.id === page.query.serviceOptionId;
    const matchesSettlement =
      !page.query.settlementPlatformOptionId ||
      order.settlementPlatform?.id === page.query.settlementPlatformOptionId;
    return (
      matchesKeyword &&
      matchesStatus &&
      matchesDisposition &&
      matchesAccountSource &&
      matchesService &&
      matchesSettlement
    );
  });
  page.total = filtered.length;
  page.hasActiveFilters = Boolean(
    keyword ||
    page.query.status ||
    page.query.accountDisposition ||
    page.query.accountSource ||
    page.query.serviceOptionId ||
    page.query.settlementPlatformOptionId ||
    page.openedRange.length
  );
  page.activeFilterCount = [
    keyword,
    page.query.status,
    page.query.accountDisposition,
    page.query.accountSource,
    page.query.serviceOptionId,
    page.query.settlementPlatformOptionId,
    page.openedRange.length ? 'opened-range' : ''
  ].filter(Boolean).length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-orders-fixture-avatar {
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

.v2-orders-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
