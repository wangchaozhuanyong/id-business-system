<template>
  <div class="v2-shell v2-accounts-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#accounts">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">ID 管理</span>
            </a>
            <a class="v2-navigation__item" href="#balances">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">余额流水</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity">
          <h1>ID 管理</h1>
        </div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-accounts-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-accounts-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page">
            <V2AccountsOverview v-if="!showingLossRecords" :page="page" />
            <V2PageContext
              v-else
              description="查看报损冻结、余额损失和财务冲回记录；恢复操作会保留原报损快照和审计记录。"
              aria-label="ID 报损记录说明"
            >
              <template #meta><span>ID 报损记录 · 不可修改快照</span></template>
            </V2PageContext>
            <V2AccountsToolbar
              :page="page"
              :active-lifecycle="activeLifecycle"
              :showing-loss-records="showingLossRecords"
              @select="selectLifecycle"
            />
            <V2AccountsList v-if="!showingLossRecords" :page="page" />
            <section v-else class="v2-accounts-fixture-loss-placeholder">
              <strong>报损记录预览</strong>
              <span>正式页面继续使用既有报损筛选、财务冲回、分页和恢复流程。</span>
            </section>
          </section>
          <V2AccountLossDialogs :page="page" />
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
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AccountsList from '@/v2/features/accounts/components/V2AccountsList.vue';
import V2AccountLossDialogs from '@/v2/features/accounts/components/V2AccountLossDialogs.vue';
import V2AccountsOverview from '@/v2/features/accounts/components/V2AccountsOverview.vue';
import V2AccountsToolbar from '@/v2/features/accounts/components/V2AccountsToolbar.vue';
import { formatAccountDate, formatAccountDecimal } from '@/v2/features/accounts/account-format';
import type { useAccountsPage } from '@/v2/features/accounts/useAccountsPage';
import type {
  V2Account,
  V2AccountLifecycle,
  V2OptionSelector
} from '@/v2/features/accounts/contracts';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const navigation = [
  { title: '订单管理', icon: Document, active: false },
  { title: 'ID 资源', icon: Collection, active: true },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

const countryOptions: V2OptionSelector[] = [
  {
    id: 'country-us',
    type: 'country',
    code: 'US',
    name: '美国',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: 'USD'
  },
  {
    id: 'country-my',
    type: 'country',
    code: 'MY',
    name: '马来西亚',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: 'MYR'
  }
];
const statusOptions: V2OptionSelector[] = [
  {
    id: 'status-normal',
    type: 'id_status',
    code: 'normal',
    name: '正常',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  },
  {
    id: 'status-review',
    type: 'id_status',
    code: 'review',
    name: '余额复核',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  }
];
const supplierOptions: V2OptionSelector[] = [
  {
    id: 'supplier-horizon',
    type: 'id_supplier',
    code: 'horizon',
    name: '远景供应商',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  },
  {
    id: 'supplier-pacific',
    type: 'id_supplier',
    code: 'pacific',
    name: '太平洋账号库',
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  }
];

const accountNames = [
  '85********@qq.com',
  '77********@163.com',
  '92********@gmail.com',
  '60********@qq.com',
  '31********@outlook.com',
  '18********@icloud.com'
];
const balances = ['324.2', '182.7', '68.5', '15.3', '402.8', '210.0'];
const balanceCosts = ['116', '78', '42', '18', '205', '102'];
const purchaseCosts = ['0', '12', '8', '0', '20', '15'];
const exchangeRates = ['0.3578', '0.4269', '0.6131', '1.1764', '0.5089', '0.4857'];

function makeAccount(index: number, lifecycle: Exclude<V2AccountLifecycle, 'reported'>): V2Account {
  const country = countryOptions[index % countryOptions.length];
  const status = statusOptions[index % statusOptions.length];
  const supplier = supplierOptions[index % supplierOptions.length];
  const sold = lifecycle === 'sold';
  const disabled = lifecycle === 'disabled';
  const day = String(9 - Math.floor(index / 7)).padStart(2, '0');
  return {
    id: `${lifecycle}-${index + 1}`,
    appleIdMasked: accountNames[index % accountNames.length],
    hasPassword: index % 4 !== 3,
    hasPhone: index % 3 === 0,
    maskedPhone: index % 3 === 0 ? `138****${String(2300 + index).slice(-4)}` : null,
    phoneTail: index % 3 === 0 ? String(2300 + index).slice(-4) : null,
    hasSecurityInfo: index % 2 === 0,
    countryOptionId: country.id,
    country: { id: country.id, code: country.code, name: country.name },
    statusOptionId: status.id,
    status: { id: status.id, code: status.code, name: status.name, isSystem: true },
    supplierOptionId: supplier.id,
    supplier: { id: supplier.id, code: supplier.code, name: supplier.name },
    currentBalance: balances[index % balances.length],
    balanceCostAmount: balanceCosts[index % balanceCosts.length],
    purchaseCost: purchaseCosts[index % purchaseCosts.length],
    purchaseOriginalAmount: purchaseCosts[index % purchaseCosts.length],
    purchaseCurrency: 'CNY',
    purchaseFxRateToCny: '1',
    purchaseFxSnapshotId: null,
    purchaseFinanceAccountId: 'finance-account-1',
    purchaseSupplierAccountId: null,
    purchasedAt: `2026-08-${day}T08:20:00.000Z`,
    saleState: sold ? 'sold' : 'available',
    soldAt: sold ? `2026-08-${day}T12:30:00.000Z` : null,
    soldByOrder: sold
      ? { id: `order-${index + 1}`, orderNo: `V2202608${day}${String(index + 1).padStart(6, '0')}` }
      : null,
    lossStatus: 'active',
    lossReportedAt: null,
    activeLossId: null,
    recordStatus: disabled ? 'disabled' : 'active',
    disabledReason: disabled ? '库存复核期间暂停使用' : null,
    disabledAt: disabled ? `2026-08-${day}T15:10:00.000Z` : null,
    remark: index % 5 === 0 ? '优先用于美国区订阅业务' : null,
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: `2026-08-${day}T08:20:00.000Z`,
    updatedAt: `2026-08-${day}T16:05:00.000Z`
  };
}

const fixtureParams = new URLSearchParams(window.location.search);
const emptyState = fixtureParams.get('state') === 'empty';
const allAccounts: V2Account[] = emptyState
  ? []
  : [
      ...Array.from({ length: 23 }, (_, index) => makeAccount(index, 'available')),
      ...Array.from({ length: 6 }, (_, index) => makeAccount(index, 'disabled')),
      ...Array.from({ length: 8 }, (_, index) => makeAccount(index, 'sold'))
    ];
const activeLifecycle = ref<V2AccountLifecycle>('available');
const showingLossRecords = computed(() => activeLifecycle.value === 'reported');
const notice = ref('');

const page = reactive({
  items: [] as V2Account[],
  total: 0,
  loading: false,
  listError: '',
  countryOptions,
  statusOptions,
  supplierOptions,
  exporting: false,
  canViewLosses: true,
  canImport: true,
  canCreate: true,
  canUpdate: true,
  canReportLoss: true,
  canRevealAppleId: true,
  canRevealPassword: true,
  canRevealPhone: true,
  canRevealSecurity: true,
  activeFilterCount: 0,
  lifecycleLabel: '可用 ID',
  lossTarget: null as V2Account | null,
  lossDialogVisible: false,
  lossSubmitting: false,
  lossReason: '',
  lossConfirmed: false,
  unfreezeTarget: null as V2Account | null,
  unfreezeDialogVisible: false,
  unfreezeSubmitting: false,
  unfreezeReason: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    countryOptionId: '',
    statusOptionId: '',
    supplierOptionId: '',
    recordStatus: '',
    saleState: '',
    lifecycle: 'available' as V2AccountLifecycle,
    sortBy: 'updatedAt',
    sortOrder: 'desc'
  },
  loadAccounts: () => {
    notice.value = 'ID 资料已刷新，当前列表内容保持稳定。';
    applyFilters();
  },
  handleToolbarCommand: (command: string) => {
    notice.value = `预览操作：已选择${command === 'export' ? '导出当前结果' : command === 'import' ? '导入 ID' : '下载导入模板'}。`;
  },
  openCreate: () => {
    notice.value = '预览操作：已打开新增 ID 抽屉。';
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, {
      page: 1,
      keyword: '',
      countryOptionId: '',
      statusOptionId: '',
      supplierOptionId: ''
    });
    applyFilters();
  },
  changeLifecycle: (lifecycle: Exclude<V2AccountLifecycle, 'reported'>) => {
    page.query.lifecycle = lifecycle;
    applyFilters(true);
  },
  handlePageSizeChange: () => applyFilters(true),
  handlePageChange: () => applyFilters(),
  handleSortChange: () => undefined,
  getAccountExchangeRate: (item: V2Account) =>
    exchangeRates[
      allAccounts.findIndex((account) => account.id === item.id) % exchangeRates.length
    ] ?? '0.5000',
  formatDecimal: formatAccountDecimal,
  formatDate: formatAccountDate,
  openDisabledReason: (item: V2Account) => {
    notice.value = `停用原因：${item.disabledReason || '未填写原因'}`;
  },
  openSensitiveAccess: (item: V2Account) => {
    notice.value = `预览操作：正在申请查看 ${item.appleIdMasked} 的敏感资料。`;
  },
  openEdit: (item: V2Account) => {
    notice.value = `预览操作：正在编辑 ${item.appleIdMasked}。`;
  },
  openRecordStatusChange: (item: V2Account) => {
    notice.value = `预览操作：正在变更 ${item.appleIdMasked} 的资料状态。`;
  },
  openReportLoss: (item: V2Account) => {
    notice.value = `预览操作：正在核对 ${item.appleIdMasked} 的报损信息。`;
    page.lossTarget = item;
    page.lossReason = '';
    page.lossConfirmed = false;
    page.lossDialogVisible = true;
  },
  openUnfreezeLoss: (item: V2Account) => {
    notice.value = `预览操作：正在解除 ${item.appleIdMasked} 的报损冻结。`;
    page.unfreezeTarget = item;
    page.unfreezeReason = '';
    page.unfreezeDialogVisible = true;
  },
  confirmReportLoss: async () => {
    page.lossDialogVisible = false;
    notice.value = '设计验收完成，未提交报损业务数据。';
  },
  confirmUnfreezeLoss: async () => {
    page.unfreezeDialogVisible = false;
    notice.value = '设计验收完成，未提交解除冻结业务数据。';
  }
}) as unknown as AccountsPage;

function selectLifecycle(lifecycle: V2AccountLifecycle) {
  activeLifecycle.value = lifecycle;
  if (lifecycle !== 'reported') page.changeLifecycle(lifecycle);
}

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allAccounts.filter((account) => {
    const matchesLifecycle =
      page.query.lifecycle === 'available'
        ? account.saleState === 'available' && account.recordStatus === 'active'
        : page.query.lifecycle === 'disabled'
          ? account.recordStatus === 'disabled'
          : account.saleState === 'sold';
    const matchesKeyword =
      !keyword ||
      [account.appleIdMasked, account.maskedPhone, account.supplier?.name]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(keyword));
    return (
      matchesLifecycle &&
      matchesKeyword &&
      (!page.query.countryOptionId || account.countryOptionId === page.query.countryOptionId) &&
      (!page.query.statusOptionId || account.statusOptionId === page.query.statusOptionId) &&
      (!page.query.supplierOptionId || account.supplierOptionId === page.query.supplierOptionId)
    );
  });
  page.activeFilterCount = [
    keyword,
    page.query.countryOptionId,
    page.query.statusOptionId,
    page.query.supplierOptionId
  ].filter(Boolean).length;
  page.lifecycleLabel =
    page.query.lifecycle === 'available'
      ? '可用 ID'
      : page.query.lifecycle === 'disabled'
        ? '已停用 ID'
        : '已售出 ID';
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
}

applyFilters();
if (fixtureParams.get('lossDialog') === 'open' && allAccounts[0]) {
  page.lossTarget = allAccounts[0];
  page.lossDialogVisible = true;
}
</script>

<style scoped>
.v2-accounts-fixture-avatar {
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

.v2-accounts-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}

.v2-accounts-fixture-loss-placeholder {
  display: grid;
  min-height: 320px;
  place-content: center;
  justify-items: center;
  gap: 6px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
  color: var(--v2-text-soft);
}

.v2-accounts-fixture-loss-placeholder strong {
  color: var(--v2-text);
}
</style>
