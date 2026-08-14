<template>
  <div class="v2-shell v2-topup-records-design-fixture">
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
            <a class="v2-navigation__item" href="#accounts">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">ID 管理</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#records">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">余额流水</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>加卡记录与余额流水</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-topup-records-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-topup-records-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-topup-records">
            <V2TopupRecordsOverview
              :active-tab="activeTab"
              :gift-cards="giftCards"
              :gift-card-total="filteredGiftCards.length"
              :ledger-entries="ledgerEntries"
              :ledger-total="filteredLedgerEntries.length"
              :loading="false"
              @refresh="showNotice('记录已刷新，当前列表框架保持不变。')"
            />

            <section class="v2-topup-records-command-panel" aria-label="加卡与余额记录工具">
              <V2SectionHeading
                class="v2-topup-records-command-panel__heading"
                title="记录分类与筛选"
                help="先选择加卡记录或余额流水，再使用同一组条件缩小范围。"
              >
                <template #actions>
                  <span class="v2-topup-records-command-panel__result">{{ activeSummary }}</span>
                </template>
              </V2SectionHeading>

              <div class="v2-topup-records-tabs" aria-label="加卡记录视图">
                <el-tabs v-model="activeTab" @tab-change="handleTabChange">
                  <el-tab-pane label="加卡记录" name="giftCards" />
                  <el-tab-pane label="余额变动" name="ledger" />
                  <el-tab-pane label="加卡供应商" name="suppliers" disabled />
                  <el-tab-pane label="付款记录" name="payments" disabled />
                </el-tabs>
              </div>

              <section class="v2-topup-records-toolbar" aria-label="加卡记录筛选">
                <el-input
                  v-model="keyword"
                  clearable
                  placeholder="卡片名称、礼品卡尾号、ID、供应商"
                  aria-label="搜索加卡记录"
                  @keyup.enter="resetPage"
                  @clear="resetPage"
                />
                <el-select
                  v-if="activeTab === 'giftCards'"
                  v-model="giftCardStatus"
                  clearable
                  placeholder="全部状态"
                  aria-label="筛选礼品卡状态"
                  @change="resetPage"
                >
                  <el-option label="加卡成功" value="credited" />
                  <el-option label="被赎回" value="redeemed" />
                  <el-option label="已撤回" value="withdrawn" />
                </el-select>
                <el-select
                  v-else
                  v-model="ledgerType"
                  clearable
                  placeholder="全部变动"
                  aria-label="筛选余额变动类型"
                  @change="resetPage"
                >
                  <el-option label="礼品卡入账" value="gift_card_credit" />
                  <el-option label="订单扣减" value="order_consumption" />
                  <el-option label="撤回扣减" value="gift_card_withdrawal" />
                  <el-option label="ID 报损冻结" value="account_loss" />
                </el-select>
                <V2FilterDisclosure>
                  <el-select v-model="country" clearable placeholder="全部国家" @change="resetPage">
                    <el-option label="美国" value="美国" />
                    <el-option label="马来西亚" value="马来西亚" />
                  </el-select>
                  <el-select
                    v-model="supplier"
                    clearable
                    placeholder="全部供应商"
                    @change="resetPage"
                  >
                    <el-option label="远景礼品卡" value="远景礼品卡" />
                    <el-option label="太平洋卡库" value="太平洋卡库" />
                  </el-select>
                </V2FilterDisclosure>
                <div class="v2-records-toolbar__actions">
                  <AppButton variant="primary" @click="resetPage">
                    <el-icon><Search /></el-icon>
                    查询记录
                  </AppButton>
                  <AppButton variant="ghost" @click="resetFilters">重置</AppButton>
                </div>
              </section>

              <footer class="v2-topup-records-command-panel__footer">
                <p class="v2-records-security-note">
                  余额和成本快照按原始流水保存，筛选、分页与刷新不会覆盖历史账务。
                </p>
                <span>当前显示全部 ID</span>
              </footer>
            </section>

            <V2TopupRecordsTables
              :gift-card-page="giftCardPage"
              :gift-card-page-size="giftCardPageSize"
              :ledger-page="ledgerPage"
              :ledger-page-size="ledgerPageSize"
              :active-tab="activeTab"
              :active-loading="false"
              :is-initial-loading="false"
              :active-resolved="true"
              active-error=""
              query-phase="ready"
              :is-parameter-transition="false"
              :gift-card-loading="false"
              :gift-cards="giftCards"
              :gift-card-total="filteredGiftCards.length"
              :ledger-loading="false"
              :ledger-entries="ledgerEntries"
              :ledger-total="filteredLedgerEntries.length"
              :can-adjust-balance="true"
              :can-reassign-supplier="true"
              @retry="showNotice('记录已重新加载。')"
              @reset="resetFilters"
              @gift-card-sort-change="showNotice('已切换加卡记录排序。')"
              @ledger-sort-change="showNotice('已切换余额流水排序。')"
              @gift-card-page-change="handleGiftCardPageChange"
              @ledger-page-change="handleLedgerPageChange"
              @gift-card-page-size-change="handleGiftCardPageSizeChange"
              @ledger-page-size-change="handleLedgerPageSizeChange"
              @edit-metadata="showNotice('预览操作：正在修改备注。')"
              @reassign-supplier="showNotice('预览操作：正在更正供应商。')"
              @reverse="showNotice('预览操作：正在核对反向流水。')"
            />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Search,
  Setting,
  User
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2TopupRecordsOverview from '@/v2/features/topup-records/components/V2TopupRecordsOverview.vue';
import V2TopupRecordsTables from '@/v2/features/topup-records/components/V2TopupRecordsTables.vue';
import type {
  V2BalanceLedgerEntryType,
  V2BalanceLedgerRecord,
  V2GiftCardRecord,
  V2GiftCardRecordStatus
} from '@/v2/features/topup-records/contracts';

const navigation = [
  { title: '订单管理', icon: Document, active: false },
  { title: 'ID 资源', icon: Collection, active: true },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

const accounts = ['85********@qq.com', '77********@163.com', '92********@gmail.com'];
const countries = [
  { id: 'country-us', code: 'US', name: '美国', currencyCode: 'USD' },
  { id: 'country-my', code: 'MY', name: '马来西亚', currencyCode: 'MYR' }
];
const suppliers = [
  { id: 'supplier-horizon', code: 'horizon', name: '远景礼品卡' },
  { id: 'supplier-pacific', code: 'pacific', name: '太平洋卡库' }
];
const operator = { id: 'admin-1', username: 'admin', displayName: '管理员' };

function makeGiftCard(index: number): V2GiftCardRecord {
  const country = countries[index % countries.length];
  const supplier = suppliers[index % suppliers.length];
  const status: V2GiftCardRecordStatus =
    index % 7 === 5 ? 'redeemed' : index % 7 === 6 ? 'withdrawn' : 'credited';
  const before = String(86 + index * 3);
  const after = String(Number(before) + 20);
  return {
    id: `gift-card-${index + 1}`,
    cardNameOptionId: 'card-apple',
    cardName: {
      id: 'card-apple',
      code: 'apple',
      name: index % 2 ? 'Apple Gift Card' : '苹果礼品卡'
    },
    code: `X9K4-${String(7310 + index).padStart(4, '0')}-Q2M8`,
    codeMasked: `****${7310 + index}`,
    codeTail: String(7310 + index),
    faceValue: index % 2 ? '20' : '25',
    exchangeRate: index % 2 ? '5.4123' : '7.1865',
    costAmount: index % 2 ? '108.2460' : '179.6625',
    purchaseOriginalAmount: index % 2 ? '20' : '25',
    purchaseCurrency: 'USD',
    purchaseFxRateToCny: index % 2 ? '5.4123' : '7.1865',
    purchaseFxSnapshotId: null,
    purchaseFinanceAccountId: 'finance-1',
    purchaseSupplierAccountId: null,
    paidAt: null,
    creditedAt: `2026-08-${String(9 - Math.floor(index / 4)).padStart(2, '0')}T08:20:00.000Z`,
    supplierRefundStatus: 'none',
    supplierRefundAmount: '0',
    supplierRefundAmountCny: '0',
    supplierRefundClosedAt: null,
    status,
    statusChangedAt: '2026-08-09T09:10:00.000Z',
    supplierOptionId: supplier.id,
    supplier,
    country,
    account: {
      id: `account-${(index % accounts.length) + 1}`,
      appleIdMasked: accounts[index % accounts.length],
      displayAppleId: accounts[index % accounts.length],
      lossStatus: 'active',
      lossReportedAt: null,
      country
    },
    creditedLedger: {
      id: `ledger-credit-${index + 1}`,
      balanceBefore: before,
      balanceAfter: after,
      costBefore: '54.0000',
      costAfter: '162.2460',
      averageCostBefore: '0.6279',
      averageCostAfter: '1.5306',
      createdAt: '2026-08-09T08:20:00.000Z'
    },
    hasSupplierFunding: true,
    reversal:
      status === 'credited'
        ? null
        : {
            id: `reversal-${index + 1}`,
            entryType: status === 'redeemed' ? 'gift_card_redeemed' : 'gift_card_withdrawal',
            balanceAmount: '-20',
            costAmount: '-108.2460',
            reason: '供应商复核',
            createdAt: '2026-08-09T09:10:00.000Z'
          },
    remark: index % 3 === 0 ? '已核对供应商批次' : null,
    hasSourceAttachment: false,
    createdBy: operator,
    updatedBy: operator,
    createdAt: '2026-08-09T08:20:00.000Z',
    updatedAt: '2026-08-09T09:10:00.000Z'
  };
}

const ledgerTypes: V2BalanceLedgerEntryType[] = [
  'gift_card_credit',
  'order_consumption',
  'gift_card_withdrawal',
  'order_consumption_reversal',
  'account_loss'
];

function makeLedgerEntry(index: number): V2BalanceLedgerRecord {
  const country = countries[index % countries.length];
  const supplier = suppliers[index % suppliers.length];
  const entryType = ledgerTypes[index % ledgerTypes.length];
  const credit = entryType === 'gift_card_credit' || entryType === 'order_consumption_reversal';
  const balanceBefore = 210 + index * 4;
  const balanceDelta = credit ? 20 : -20;
  const costDelta = credit ? 108.246 : -31.845;
  return {
    id: `ledger-${index + 1}`,
    entryType,
    direction: credit ? 'credit' : 'debit',
    balanceAmount: String(Math.abs(balanceDelta)),
    costAmount: String(Math.abs(costDelta)),
    balanceDelta: String(balanceDelta),
    costDelta: String(costDelta),
    balanceBefore: String(balanceBefore),
    balanceAfter: String(balanceBefore + balanceDelta),
    costBefore: '216.8400',
    costAfter: credit ? '325.0860' : '184.9950',
    averageCostBefore: '1.0325',
    averageCostAfter: credit ? '1.4134' : '0.9737',
    reason: entryType === 'account_loss' ? 'ID 报损冻结' : null,
    account: {
      id: `account-${(index % accounts.length) + 1}`,
      appleIdMasked: accounts[index % accounts.length],
      displayAppleId: accounts[index % accounts.length],
      country
    },
    giftCard: entryType.startsWith('gift_card')
      ? {
          id: `gift-card-${index + 1}`,
          code: `X9K4-${String(7310 + index).padStart(4, '0')}-Q2M8`,
          codeMasked: `****${7310 + index}`,
          codeTail: String(7310 + index),
          faceValue: '20',
          status: entryType === 'gift_card_credit' ? 'credited' : 'withdrawn',
          supplier
        }
      : null,
    reversalOf:
      entryType === 'order_consumption_reversal'
        ? {
            id: `source-ledger-${index + 1}`,
            entryType: 'order_consumption',
            createdAt: '2026-08-08T10:20:00.000Z'
          }
        : null,
    reversedBy: null,
    operator,
    createdAt: `2026-08-${String(9 - Math.floor(index / 5)).padStart(2, '0')}T10:20:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allGiftCards: V2GiftCardRecord[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeGiftCard(index));
const allLedgerEntries: V2BalanceLedgerRecord[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeLedgerEntry(index));
const activeTab = ref<'giftCards' | 'ledger'>('ledger');
const keyword = ref('');
const giftCardStatus = ref<V2GiftCardRecordStatus | ''>('');
const ledgerType = ref<V2BalanceLedgerEntryType | ''>('');
const country = ref('');
const supplier = ref('');
const giftCardPage = ref(1);
const giftCardPageSize = ref(10);
const ledgerPage = ref(1);
const ledgerPageSize = ref(10);
const notice = ref('');

const filteredGiftCards = computed(() => {
  const term = keyword.value.trim().toLowerCase();
  return allGiftCards.filter(
    (item) =>
      (!term ||
        `${item.code} ${item.cardName.name} ${item.account.appleIdMasked} ${item.supplier?.name}`
          .toLowerCase()
          .includes(term)) &&
      (!giftCardStatus.value || item.status === giftCardStatus.value) &&
      (!country.value || item.country.name === country.value) &&
      (!supplier.value || item.supplier?.name === supplier.value)
  );
});
const filteredLedgerEntries = computed(() => {
  const term = keyword.value.trim().toLowerCase();
  return allLedgerEntries.filter(
    (item) =>
      (!term ||
        `${item.giftCard?.code ?? ''} ${item.account.appleIdMasked} ${item.giftCard?.supplier?.name ?? ''}`
          .toLowerCase()
          .includes(term)) &&
      (!ledgerType.value || item.entryType === ledgerType.value) &&
      (!country.value || item.account.country.name === country.value) &&
      (!supplier.value || item.giftCard?.supplier?.name === supplier.value)
  );
});
const giftCards = computed(() => {
  const start = (giftCardPage.value - 1) * giftCardPageSize.value;
  return filteredGiftCards.value.slice(start, start + giftCardPageSize.value);
});
const ledgerEntries = computed(() => {
  const start = (ledgerPage.value - 1) * ledgerPageSize.value;
  return filteredLedgerEntries.value.slice(start, start + ledgerPageSize.value);
});
const activeSummary = computed(() =>
  activeTab.value === 'giftCards'
    ? `当前共 ${filteredGiftCards.value.length} 条`
    : `当前共 ${filteredLedgerEntries.value.length} 条`
);

function resetPage() {
  giftCardPage.value = 1;
  ledgerPage.value = 1;
}

function handleGiftCardPageChange(page: number) {
  giftCardPage.value = page;
  showNotice('已切换加卡记录分页。');
}

function handleLedgerPageChange(page: number) {
  ledgerPage.value = page;
  showNotice('已切换余额流水分页。');
}

function handleGiftCardPageSizeChange(pageSize: number) {
  giftCardPageSize.value = pageSize;
  resetPage();
}

function handleLedgerPageSizeChange(pageSize: number) {
  ledgerPageSize.value = pageSize;
  resetPage();
}
function resetFilters() {
  keyword.value = '';
  giftCardStatus.value = '';
  ledgerType.value = '';
  country.value = '';
  supplier.value = '';
  resetPage();
}
function handleTabChange() {
  resetPage();
}
function showNotice(message: string) {
  notice.value = message;
}
</script>

<style scoped>
.v2-topup-records-fixture-avatar {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: #edf3ff;
  color: #1f5ed6;
  font-size: 12px;
  font-weight: 700;
}

.v2-topup-records-fixture-notice {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: var(--v3-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
