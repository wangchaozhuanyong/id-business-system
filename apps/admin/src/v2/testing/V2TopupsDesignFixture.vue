<template>
  <div class="v2-shell v2-topups-design-fixture">
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
            <a class="v2-navigation__item" href="#renewals">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">续费操作</span>
            </a>
            <a class="v2-navigation__item" href="#order-entry">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单录入</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#topups">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">ID加额</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>ID加额</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-topups-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-topups-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-topup-workbench">
            <V2TopupWorkbenchOverview :page="page" />
            <V2TopupWorkbenchToolbar :page="page" />
            <V2TopupWorkbenchList :page="page" />
            <V2ConfirmDialog
              v-model="soldPromptVisible"
              title="确认给已售出 ID 加卡"
              message=""
              width="min(520px, 92vw)"
              confirm-text="确认，为已售 ID 加卡"
              @confirm="confirmSoldPrompt"
            >
              <div v-if="soldPromptItem?.soldByOrder" class="v2-topup-sold-credit-prompt">
                <el-alert
                  title="该 ID 已售出，请先核对销售归属"
                  type="warning"
                  show-icon
                  :closable="false"
                />
                <dl>
                  <div>
                    <dt>目标 ID</dt>
                    <dd>{{ soldPromptItem.appleIdMasked }}</dd>
                  </div>
                  <div>
                    <dt>销售订单</dt>
                    <dd>{{ soldPromptItem.soldByOrder.orderNo }}</dd>
                  </div>
                  <div>
                    <dt>归属客户</dt>
                    <dd>{{ soldPromptItem.soldByOrder.customer.name }}</dd>
                  </div>
                </dl>
                <p>继续后可以填写礼品卡资料；最终提交时系统会再次核对该销售归属。</p>
              </div>
            </V2ConfirmDialog>
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
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2TopupWorkbenchList from '@/v2/features/topups/components/V2TopupWorkbenchList.vue';
import V2TopupWorkbenchOverview from '@/v2/features/topups/components/V2TopupWorkbenchOverview.vue';
import V2TopupWorkbenchToolbar from '@/v2/features/topups/components/V2TopupWorkbenchToolbar.vue';
import type { useTopupWorkbenchPage } from '@/v2/features/topups/useTopupWorkbenchPage';
import type {
  V2TopupBalancePreset,
  V2TopupWorkbenchItem,
  V2TopupWorkbenchSortBy
} from '@/v2/types/balances';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: true },
  { title: '业务中心', icon: Document, active: false },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];
const countries = [
  { id: 'country-us', code: 'US', name: '美国' },
  { id: 'country-my', code: 'MY', name: '马来西亚' }
];
const services = [
  { id: 'service-chatgpt', code: 'chatgpt-plus', name: 'ChatGPT Plus' },
  { id: 'service-claude', code: 'claude-pro', name: 'Claude Pro' },
  { id: 'service-midjourney', code: 'midjourney', name: 'Midjourney' }
];
const notice = ref('');
const soldPromptVisible = ref(false);
const soldPromptItem = ref<V2TopupWorkbenchItem | null>(null);

function makeTopupItem(index: number): V2TopupWorkbenchItem {
  const country = countries[index % countries.length];
  const statusNormal = index % 7 !== 6;
  const currentService = services[index % services.length];
  const balanceWhole = (index * 7) % 46;
  const day = String(28 - (index % 20)).padStart(2, '0');
  return {
    id: `account-${index + 1}`,
    appleIdMasked: `${String(85 + index).padStart(2, '0')}********@qq.com`,
    displayAppleId: `${String(85 + index).padStart(2, '0')}********@qq.com`,
    country,
    currentBalance: `${balanceWhole}.2000`,
    balanceCostAmount: `${88 + index}.4000`,
    averageCost: `${5 + (index % 4)}.8000`,
    topupRecordCount: (index % 5) + 1,
    balanceChangeCount: (index % 7) + 2,
    lastTopupAt: `2026-08-${day}T08:20:00.000Z`,
    updatedAt: `2026-08-${day}T16:05:00.000Z`,
    status: {
      id: statusNormal ? 'status-normal' : 'status-maintenance',
      code: statusNormal ? 'normal' : 'maintenance',
      name: statusNormal ? '正常' : '维护中',
      isSystem: true
    },
    saleState: index % 4 === 0 ? 'sold' : 'available',
    soldByOrder:
      index % 4 === 0
        ? {
            id: `sold-order-${index + 1}`,
            orderNo: `V2202607${day}${String(index + 1).padStart(6, '0')}`,
            customer: { id: `customer-${index + 1}`, name: `客户 ${index + 1}` }
          }
        : null,
    historicalServices: services.slice(0, (index % services.length) + 1).map((service) => ({
      ...service,
      parent: { id: 'category-ai', name: 'AI 工具' }
    })),
    currentServices: index % 5 === 4 ? [] : [{ ...currentService, parent: null }],
    serviceDataAvailable: true
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allItems: V2TopupWorkbenchItem[] = emptyState
  ? []
  : Array.from({ length: 26 }, (_, index) => makeTopupItem(index));
const fixtureListState: Record<
  'available' | 'sold',
  { page: number; pageSize: number; sortBy: V2TopupWorkbenchSortBy; sortOrder: 'asc' | 'desc' }
> = {
  available: { page: 1, pageSize: 10, sortBy: 'updatedAt', sortOrder: 'desc' },
  sold: { page: 1, pageSize: 10, sortBy: 'updatedAt', sortOrder: 'desc' }
};

const page = reactive({
  activeList: 'available' as 'available' | 'sold',
  items: [] as V2TopupWorkbenchItem[],
  total: 0,
  evaluatedAt: '2026-08-10T09:20:00.000Z',
  loading: false,
  queryPhase: 'ready',
  isParameterTransition: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  countryOptions: countries,
  canTopup: true,
  canAdjustBalance: true,
  displayedPage: 1,
  displayedPageSize: 10,
  query: {
    keyword: '',
    countryOptionId: '',
    balancePreset: '' as V2TopupBalancePreset,
    balanceMin: '',
    balanceMax: '',
    onlyNormal: true,
    sortBy: 'updatedAt' as V2TopupWorkbenchSortBy,
    sortOrder: 'desc' as 'asc' | 'desc'
  },
  loadWorkbench: () => {
    notice.value = 'ID 余额与加卡记录已刷新。';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  handleBalancePresetChange: () => {
    if (page.query.balancePreset !== 'custom') {
      page.query.balanceMin = '';
      page.query.balanceMax = '';
      applyFilters(true);
    }
  },
  resetFilters: () => {
    Object.assign(page.query, {
      keyword: '',
      countryOptionId: '',
      balancePreset: '',
      balanceMin: '',
      balanceMax: '',
      onlyNormal: true
    });
    fixtureListState.available.page = 1;
    fixtureListState.sold.page = 1;
    applyFilters();
  },
  changeAccountList: (value: string | number) => {
    if (value !== 'available' && value !== 'sold') return;
    page.activeList = value;
    applyFilters();
  },
  handlePageChange: (value: number) => {
    fixtureListState[page.activeList].page = value;
    applyFilters();
  },
  handlePageSizeChange: (value: number) => {
    fixtureListState[page.activeList].pageSize = value;
    applyFilters(true);
  },
  handleSortChange: () => undefined,
  openCreditDrawer: (item: V2TopupWorkbenchItem) => {
    if (item.saleState === 'sold') {
      soldPromptItem.value = item;
      soldPromptVisible.value = true;
      return;
    }
    notice.value = `预览操作：正在为 ${item.appleIdMasked} 录入礼品卡。`;
  },
  openReversalDrawer: (item: V2TopupWorkbenchItem) => {
    notice.value = `预览操作：正在查看 ${item.appleIdMasked} 可处理礼品卡。`;
  },
  openAccountRecords: (item: V2TopupWorkbenchItem, tab: 'giftCards' | 'ledger') => {
    notice.value = `预览操作：正在查看 ${item.appleIdMasked} 的${tab === 'giftCards' ? '加卡记录' : '余额流水'}。`;
  },
  formatDecimal: (value: string | number | null | undefined) => value?.toString() ?? '0.0000',
  formatDate: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value)),
  formatTime: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value)),
  formatElapsed: (value: string | null) => (value ? '2 小时前' : '—'),
  servicePath: (service: V2TopupWorkbenchItem['currentServices'][number]) =>
    service.parent ? `${service.parent.name} / ${service.name}` : service.name
}) as unknown as TopupWorkbenchPage;

function confirmSoldPrompt() {
  if (!soldPromptItem.value) return;
  notice.value = `预览操作：已核对 ${soldPromptItem.value.appleIdMasked} 的销售归属。`;
  soldPromptVisible.value = false;
}

function decimalWhole(value: string) {
  const normalized = value.trim().split('.')[0] || '0';
  return BigInt(normalized);
}

function applyFilters(resetPage = false) {
  const state = fixtureListState[page.activeList];
  if (resetPage) state.page = 1;
  const minimum = page.query.balanceMin ? decimalWhole(page.query.balanceMin) : null;
  const maximum = page.query.balanceMax ? decimalWhole(page.query.balanceMax) : null;
  const filtered = allItems.filter((item) => {
    const balance = decimalWhole(item.currentBalance);
    const keyword = page.query.keyword.trim().toLowerCase();
    const matchesKeyword =
      !keyword ||
      item.appleIdMasked.toLowerCase().includes(keyword) ||
      item.soldByOrder?.orderNo.toLowerCase().includes(keyword);
    const matchesSource = item.saleState === page.activeList;
    const matchesPreset =
      !page.query.balancePreset ||
      (page.query.balancePreset === 'zero' && balance === 0n) ||
      (page.query.balancePreset === 'positive_under_20' && balance > 0n && balance < 20n) ||
      (page.query.balancePreset === 'custom' &&
        (minimum === null || balance >= minimum) &&
        (maximum === null || balance <= maximum));
    return (
      matchesKeyword &&
      matchesSource &&
      matchesPreset &&
      (!page.query.countryOptionId || item.country.id === page.query.countryOptionId) &&
      (!page.query.onlyNormal || item.status.code === 'normal')
    );
  });
  page.total = filtered.length;
  page.displayedPage = state.page;
  page.displayedPageSize = state.pageSize;
  const start = (state.page - 1) * state.pageSize;
  page.items = filtered.slice(start, start + state.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-topups-fixture-avatar {
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

.v2-topups-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
