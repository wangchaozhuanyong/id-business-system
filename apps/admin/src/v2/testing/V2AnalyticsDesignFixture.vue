<template>
  <div class="v2-shell v2-analytics-design-fixture">
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
            <a class="v2-navigation__item" href="#finance-ledger">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">钱包账户</span>
            </a>
            <a class="v2-navigation__item" href="#finance-expenses">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">收支记账</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#analytics">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">经营分析</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>经营分析</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-analytics-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-analytics-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-finance-page">
            <div class="v2-analytics-page">
              <V2AnalyticsOverview :page="page" />
              <V2AnalyticsToolbar :page="page" />
              <V2AnalyticsNavigation v-model:active-section="activeAnalysisSection" />
              <div class="v2-analytics-content">
                <div v-show="activeAnalysisSection === 'profit'" class="v2-analytics-section-stack">
                  <V2ProfitOverview
                    :overview="page.overview!"
                    :analysis-range-label="page.analysisRangeLabel"
                    :format-cny="page.formatCny"
                    :add-amounts="page.addAmounts"
                    :amount-tone="page.amountTone"
                  />
                  <V2SettlementPlatformReport :report="page.overview!.settlementPlatformReport" />
                </div>
                <V2AfterSalesReport
                  v-show="activeAnalysisSection === 'after-sales'"
                  :report="page.overview!.afterSales"
                  :format-cny="page.formatCny"
                  :amount-tone="page.amountTone"
                />
                <V2AnalyticsCurrencyReport
                  v-show="activeAnalysisSection === 'cash-flow'"
                  :overview="page.overview!"
                  :format-cny="page.formatCny"
                  :format-original="page.formatOriginal"
                  :amount-tone="page.amountTone"
                />
                <V2AnalyticsAssetsReport
                  v-show="activeAnalysisSection === 'assets'"
                  :overview="page.overview!"
                  :asset-rows="page.assetRows"
                  :wallets="page.wallets"
                  :format-cny="page.formatCny"
                  :format-original="page.formatOriginal"
                  :amount-tone="page.amountTone"
                />
                <V2AnalyticsReconciliationReport
                  v-show="activeAnalysisSection === 'reconciliation'"
                  :overview="page.overview!"
                  :journals="page.journals"
                  :format-cny="page.formatCny"
                  :format-original="page.formatOriginal"
                  :format-date="page.formatDate"
                  :journal-amount="page.journalAmount"
                  :journal-type-label="page.journalTypeLabel"
                  :account-code-label="page.accountCodeLabel"
                  :direction-label="page.directionLabel"
                />
              </div>
            </div>
          </section>
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
import type {
  V2FinanceAccount,
  V2FinanceAccountCode,
  V2FinanceCurrency,
  V2FinanceJournal,
  V2FinanceJournalType,
  V2FinanceOverview,
  V2FinanceSupplierWallet
} from '@apple-business/shared';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2AfterSalesReport from '@/v2/features/data-analytics/components/V2AfterSalesReport.vue';
import V2AnalyticsAssetsReport from '@/v2/features/data-analytics/components/V2AnalyticsAssetsReport.vue';
import V2AnalyticsCurrencyReport from '@/v2/features/data-analytics/components/V2AnalyticsCurrencyReport.vue';
import V2AnalyticsNavigation, {
  type AnalyticsSectionKey
} from '@/v2/features/data-analytics/components/V2AnalyticsNavigation.vue';
import V2AnalyticsOverview from '@/v2/features/data-analytics/components/V2AnalyticsOverview.vue';
import V2AnalyticsReconciliationReport from '@/v2/features/data-analytics/components/V2AnalyticsReconciliationReport.vue';
import V2AnalyticsToolbar from '@/v2/features/data-analytics/components/V2AnalyticsToolbar.vue';
import V2ProfitOverview from '@/v2/features/data-analytics/components/V2ProfitOverview.vue';
import V2SettlementPlatformReport from '@/v2/features/data-analytics/components/V2SettlementPlatformReport.vue';
import type { useDataAnalyticsPage } from '@/v2/features/data-analytics/useDataAnalyticsPage';
import { addDecimalStrings, formatV2Decimal } from '@/v2/utils/decimal';

type DataAnalyticsPage = UnwrapNestedRefs<ReturnType<typeof useDataAnalyticsPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];
const currencies: V2FinanceCurrency[] = ['CNY', 'MYR', 'USD', 'USDT'];
const journalTypeOptions: Array<{ value: V2FinanceJournalType; label: string }> = [
  { value: 'order_completed', label: '订单完成' },
  { value: 'gift_card_purchase', label: '礼品卡采购' },
  { value: 'account_purchase', label: 'ID 采购' },
  { value: 'expense', label: '额外开支' }
];
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const notice = ref('');
const activeAnalysisSection = ref<AnalyticsSectionKey>('profit');

const accounts: V2FinanceAccount[] = emptyState
  ? []
  : currencies.slice(0, 3).map((currency, index) => ({
      id: `account-${index + 1}`,
      name: ['人民币收款账户', '马币备用金', '美元结算账户'][index],
      accountType: index === 0 ? 'bank' : index === 1 ? 'cash' : 'ewallet',
      currency,
      openingBalance: String(4200 + index * 800),
      currentBalance: String(5680 + index * 920),
      openingBalanceCny: String(4200 + index * 3800),
      currentBalanceCny: String(5680 + index * 4560),
      status: 'active',
      remark: null,
      createdAt: '2026-07-01T08:00:00.000Z',
      updatedAt: '2026-08-10T09:20:00.000Z'
    }));

const wallets: V2FinanceSupplierWallet[] = emptyState
  ? []
  : Array.from({ length: 5 }, (_, index) => {
      const currency = currencies[(index + 1) % currencies.length];
      return {
        id: `wallet-${index + 1}`,
        supplierOptionId: `supplier-${(index % 3) + 1}`,
        supplierName: ['星河卡商', '远洋供应链', 'Nova Digital'][index % 3],
        currency,
        openingBalance: String(2600 + index * 480),
        currentBalance: String(3180 + index * 620),
        openingBalanceCny: String(4380 + index * 780),
        currentBalanceCny: String(5360 + index * 960),
        status: 'active',
        initializedAt: '2026-07-02T08:00:00.000Z',
        updatedAt: '2026-08-10T09:20:00.000Z'
      };
    });

function createJournal(index: number): V2FinanceJournal {
  const currency = currencies[index % currencies.length];
  const journalType = journalTypeOptions[index % journalTypeOptions.length].value;
  const amount = String(168 + index * 37);
  return {
    id: `journal-${index + 1}`,
    journalNo: `FIN-20260810-${String(index + 1).padStart(4, '0')}`,
    journalType,
    sourceType: 'fixture',
    sourceId: `source-${index + 1}`,
    sourceReference: `V220260810${String(index + 1).padStart(4, '0')}`,
    businessDate: '2026-08-10',
    periodMonth: '2026-08',
    occurredAt: `2026-08-10T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
    status: 'posted',
    reversalOfJournalId: null,
    reversedAt: null,
    summary: ['客户订单完成', '礼品卡采购入库', '采购 ID 入库', '记录经营开支'][index % 4],
    lines: [
      createJournalLine(index, 1, 'cash', 'debit', currency, amount),
      createJournalLine(index, 2, 'sales_revenue', 'credit', currency, amount)
    ]
  };
}

function createJournalLine(
  index: number,
  lineNo: number,
  accountCode: V2FinanceAccountCode,
  direction: 'debit' | 'credit',
  currency: V2FinanceCurrency,
  amount: string
) {
  return {
    id: `line-${index + 1}-${lineNo}`,
    lineNo,
    accountCode,
    direction,
    currency,
    amountOriginal: amount,
    fxRateToCny: currency === 'CNY' ? '1' : currency === 'MYR' ? '1.68' : '7.18',
    amountCny: String(168 + index * 37),
    financeAccountId: null,
    supplierAccountId: null,
    memo: lineNo === 1 ? '业务入账' : '对应科目'
  };
}

const journals = emptyState ? [] : Array.from({ length: 10 }, (_, index) => createJournal(index));
const overview: V2FinanceOverview = {
  settings: {
    baseCurrency: 'CNY',
    timezone: 'Asia/Shanghai',
    enabledAt: '2026-01-01T00:00:00.000Z',
    historyStatus: 'completed',
    historyCompletedAt: '2026-02-08T12:00:00.000Z',
    historyNote: '历史订单、旧开支与期初资产已完成核对。'
  },
  profitLoss: {
    salesRevenueCny: emptyState ? '0' : '126800.50',
    otherOperatingRevenueCny: emptyState ? '0' : '5600.00',
    totalOperatingRevenueCny: emptyState ? '0' : '132400.50',
    platformFeeCny: emptyState ? '0' : '3260.18',
    giftCardCostCny: emptyState ? '0' : '58620.42',
    idCostCny: emptyState ? '0' : '18260.00',
    customerOwnedBalanceCostCny: emptyState ? '0' : '604.36',
    refundLossCny: emptyState ? '0' : '860.00',
    redemptionLossCny: emptyState ? '0' : '420.00',
    balanceLossCny: emptyState ? '0' : '180.00',
    idPurchaseLossCny: emptyState ? '0' : '260.00',
    operatingExpenseCny: emptyState ? '0' : '7860.25',
    realizedFxGainLossCny: emptyState ? '0' : '680.46',
    netProfitCny: emptyState ? '0' : '37760.11',
    estimatedProfitCny: emptyState ? '0' : '4560.20'
  },
  currencyBreakdown: emptyState
    ? []
    : currencies.map((currency, index) => ({
        currency,
        income: String(16800 + index * 2180),
        manualOperatingIncome: String(1800 + index * 180),
        capitalContribution: String(2000 + index * 200),
        borrowedFunds: String(1000 + index * 100),
        expense: String(9200 + index * 1360),
        netCashFlow: String(7600 + index * 820),
        latestRateToCny: ['1', '1.68', '7.18', '7.17'][index],
        netCashFlowCny: String(7600 + index * 4680)
      })),
  assets: {
    cashCny: emptyState ? '0' : '28680.80',
    supplierPrepaymentCny: emptyState ? '0' : '36200.50',
    giftCardInventoryCny: emptyState ? '0' : '12860.00',
    customerOwnedBalanceCostCny: emptyState ? '0' : '604.36',
    unsoldIdInventoryCny: emptyState ? '0' : '18640.00',
    supplierRefundReceivableCny: emptyState ? '0' : '3260.00',
    totalBookValueCny: emptyState ? '0' : '99641.30',
    totalLatestValuationCny: emptyState ? '0' : '100326.72',
    unrealizedFxChangeCny: emptyState ? '0' : '685.42'
  },
  afterSales: {
    completedOrderCount: emptyState ? 0 : 12,
    grossRevenueCny: emptyState ? '0' : '16800',
    refundedRevenueCny: emptyState ? '0' : '600',
    platformFeeCny: emptyState ? '0' : '420',
    balanceCostCny: emptyState ? '0' : '7600',
    idCostCny: '0',
    refundLossCny: emptyState ? '0' : '120',
    netProfitCny: emptyState ? '0' : '8060',
    pendingOrderCount: emptyState ? 0 : 2,
    pendingRevenueCny: emptyState ? '0' : '2800',
    pendingProfitCny: emptyState ? '0' : '1100'
  },
  settlementPlatformReport: {
    options: [
      { id: 'platform-1', name: '公司开发' },
      { id: 'platform-2', name: 'Stripe' },
      { id: 'platform-3', name: '线下转账' }
    ],
    totals: {
      completedOrderCount: emptyState ? 0 : 48,
      originalAmounts: [],
      grossReceivedCny: emptyState ? '0' : '126800.50',
      refundedCny: emptyState ? '0' : '860.00',
      platformFeeCny: emptyState ? '0' : '3260.18',
      netSettlementCny: emptyState ? '0' : '122680.32',
      realizedProfitCny: emptyState ? '0' : '37760.11',
      realizedProfitRate: emptyState ? null : '29.78',
      pendingOrderCount: emptyState ? 0 : 6,
      pendingReceivedCny: emptyState ? '0' : '12680.00',
      pendingProfitCny: emptyState ? '0' : '4560.20'
    },
    rows: emptyState
      ? []
      : ['公司开发', 'Stripe', '线下转账'].map((name, index) => ({
          settlementPlatform: { id: `platform-${index + 1}`, name },
          completedOrderCount: 18 - index * 3,
          originalAmounts: [
            {
              currency: currencies[index],
              grossReceived: String(28600 + index * 5800),
              refunded: String(120 + index * 80)
            }
          ],
          grossReceivedCny: String(38600 + index * 5300),
          refundedCny: String(180 + index * 110),
          platformFeeCny: String(820 + index * 140),
          netSettlementCny: String(37600 + index * 5050),
          realizedProfitCny: String(12600 + index * 1680),
          realizedProfitRate: String(28 + index * 1.2),
          pendingOrderCount: 3 - index,
          pendingReceivedCny: String(4680 + index * 620),
          pendingProfitCny: String(1260 + index * 160)
        })),
    hasHistoricalUnspecified: false,
    historicalUnspecifiedAmountCny: '0'
  },
  reconciliation: {
    isComplete: emptyState,
    issueCount: emptyState ? 0 : 2,
    returnedIssueCount: emptyState ? 0 : 2,
    hasMoreIssues: false,
    issues: emptyState
      ? []
      : [
          {
            code: 'stale_fx_rate',
            severity: 'warning',
            sourceType: 'finance_rate',
            sourceId: 'rate-1',
            message: 'MYR 最新汇率超过核验时限，请刷新后复核资产估值。',
            amountCny: null
          },
          {
            code: 'open_supplier_refund',
            severity: 'info',
            sourceType: 'supplier_refund',
            sourceId: 'refund-1',
            message: '星河卡商有一笔退款仍在处理中。',
            amountCny: '3260.00'
          }
        ]
  }
};

const filters = reactive({
  dateRange: [] as string[],
  currency: '' as V2FinanceCurrency | '',
  supplierOptionId: '',
  journalType: '' as V2FinanceJournalType | '',
  financeAccountId: '',
  settlementPlatformOptionId: ''
});
const appliedFilterCount = ref(0);
const page = reactive({
  currencies,
  journalTypeOptions,
  filters,
  overview,
  accounts,
  wallets,
  journals,
  loading: false,
  resolved: true,
  error: '',
  supplierOptions: computed(() => {
    const items = new Map<string, string>();
    wallets.forEach((wallet) => items.set(wallet.supplierOptionId, wallet.supplierName));
    return [...items].map(([value, label]) => ({ value, label }));
  }),
  settlementPlatformOptions: overview.settlementPlatformReport.options,
  assetRows: [
    { label: '自有资金', value: overview.assets.cashCny },
    { label: '卡商预付款', value: overview.assets.supplierPrepaymentCny },
    { label: '自有 ID 剩余余额成本', value: overview.assets.giftCardInventoryCny },
    { label: '未售 ID 成本', value: overview.assets.unsoldIdInventoryCny },
    { label: '待卡商退款', value: overview.assets.supplierRefundReceivableCny }
  ],
  analysisRangeLabel: computed(() =>
    filters.dateRange.length === 2
      ? `${filters.dateRange[0]} 至 ${filters.dateRange[1]}`
      : '全部已记账业务日期'
  ),
  activeFilterLabel: computed(() =>
    appliedFilterCount.value ? `已应用 ${appliedFilterCount.value} 项筛选` : '未附加筛选'
  ),
  applyFilters: () => {
    appliedFilterCount.value = Object.values(filters).filter((value) =>
      Array.isArray(value) ? value.length > 0 : value !== ''
    ).length;
    setNotice(`已应用 ${appliedFilterCount.value} 项筛选。`);
  },
  resetFilters: () => {
    filters.dateRange = [];
    filters.currency = '';
    filters.supplierOptionId = '';
    filters.journalType = '';
    filters.financeAccountId = '';
    filters.settlementPlatformOptionId = '';
    appliedFilterCount.value = 0;
    setNotice('筛选条件已清除。');
  },
  refresh: () => setNotice('经营分析数据已刷新。'),
  formatCny,
  formatOriginal,
  addAmounts: (...values: string[]) =>
    values.reduce((total, value) => addDecimalStrings(total, value || '0'), '0'),
  amountTone,
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
  journalAmount: (journal: V2FinanceJournal) =>
    journal.lines
      .filter((line) => line.direction === 'debit')
      .reduce((total, line) => addDecimalStrings(total, line.amountCny || '0'), '0'),
  journalTypeLabel: (value: V2FinanceJournalType) =>
    journalTypeOptions.find((item) => item.value === value)?.label ?? value,
  accountCodeLabel: (value: V2FinanceAccountCode) => accountCodeLabels[value],
  directionLabel: (value: 'debit' | 'credit') => (value === 'debit' ? '借' : '贷')
}) as unknown as DataAnalyticsPage;

function formatCny(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  return `¥${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatV2Decimal(value, { minimumFractionDigits: 2 })}`;
}

function amountTone(value: string | null | undefined) {
  const normalized = String(value ?? '0');
  if (normalized.startsWith('-') && !/^-(?:0|0\.0+)$/.test(normalized)) return 'is-negative';
  return /^(?:0|0\.0+)$/.test(normalized) ? '' : 'is-positive';
}

const accountCodeLabels: Record<V2FinanceAccountCode, string> = {
  cash: '自有资金',
  supplier_prepayment: '卡商预付款',
  supplier_refund_receivable: '待卡商退款',
  gift_card_inventory: '礼品卡余额资产',
  id_inventory: 'ID 库存',
  sales_revenue: '销售收入',
  other_operating_revenue: '其他经营收入',
  platform_fee: '平台手续费',
  gift_card_cost: '余额销售成本',
  id_cost: 'ID 销售成本',
  customer_owned_balance_cost: '客户已购 ID 余额转移成本',
  refund_loss: '退款损失',
  gift_card_redemption_loss: '礼品卡赎回损失',
  balance_loss: 'ID 余额报损',
  id_purchase_loss: 'ID 采购成本报损',
  operating_expense: '经营开支',
  contributed_capital: '投入资本',
  borrowed_funds_payable: '借入资金负债',
  realized_fx_gain_loss: '已实现汇兑损益',
  opening_equity: '期初权益',
  manual_adjustment: '手工调整'
};

function setNotice(message: string) {
  notice.value = message;
}
</script>

<style scoped>
.v2-analytics-fixture-avatar {
  display: inline-grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-sidebar);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
}

.v2-analytics-fixture-notice {
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
