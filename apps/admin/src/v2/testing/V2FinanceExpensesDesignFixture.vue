<template>
  <div class="v2-shell v2-finance-expenses-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#finance-expenses">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">收支记账</span>
            </a>
            <a class="v2-navigation__item" href="#analytics">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">经营分析</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>收支记账</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-finance-expenses-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-finance-expenses-fixture-notice" role="status">
            {{ notice }}
          </p>
          <section class="v2-finance-page">
            <div class="v2-finance-expenses-page">
              <V2FinanceExpensesOverview :page="page" />
              <V2FinanceCashbookNavigation :page="page" />
              <V2FinanceExpensesToolbar :page="page" />
              <V2FinanceInflowsTable v-if="page.cashbookView === 'inflows'" :page="page" />
              <V2FinanceExpensesTable v-else :page="page" />
            </div>
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
import V2FinanceCashbookNavigation from '@/v2/features/finance-ledger/components/V2FinanceCashbookNavigation.vue';
import V2FinanceExpensesOverview from '@/v2/features/finance-ledger/components/V2FinanceExpensesOverview.vue';
import V2FinanceExpensesTable from '@/v2/features/finance-ledger/components/V2FinanceExpensesTable.vue';
import V2FinanceExpensesToolbar from '@/v2/features/finance-ledger/components/V2FinanceExpensesToolbar.vue';
import V2FinanceInflowsTable from '@/v2/features/finance-ledger/components/V2FinanceInflowsTable.vue';
import type {
  V2FinanceAccount,
  V2FinanceCurrency,
  V2FinanceExpense,
  V2FinanceInflow,
  V2FinanceInflowNature
} from '@/v2/features/finance-ledger/contracts';
import type { useFinanceLedgerPage } from '@/v2/features/finance-ledger/useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];
const currencies: V2FinanceCurrency[] = ['CNY', 'MYR', 'USD', 'USDT'];
const categoryNames = ['办公服务', '员工薪酬', '软件订阅', '市场推广', '通信费用'];
const accountNames = ['人民币收款账户', '马币备用金', '美元结算账户', 'USDT 主钱包'];
const payees = ['Cloud Services', '吉隆坡办公室', '广告平台', '通信服务商', '行政采购'];
const notice = ref('');
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';

const accounts: V2FinanceAccount[] = currencies.map((currency, index) => ({
  id: `account-${index + 1}`,
  name: accountNames[index],
  accountType:
    index === 0 ? 'bank' : index === 1 ? 'cash' : index === 2 ? 'ewallet' : 'usdt_wallet',
  currency,
  openingBalance: String(3200 + index * 500),
  currentBalance: String(4680 + index * 760),
  openingBalanceCny: String(4900 + index * 860),
  currentBalanceCny: String(7120 + index * 1180),
  status: 'active',
  remark: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-08-10T09:20:00.000Z'
}));

function makeExpense(index: number): V2FinanceExpense {
  const currency = currencies[index % currencies.length];
  const amount = String(68 + index * 17.5);
  const rate = currency === 'CNY' ? '1' : currency === 'MYR' ? '1.68' : '7.18';
  return {
    id: `expense-${index + 1}`,
    journalId: `journal-${index + 1}`,
    categoryOptionId: `category-${(index % categoryNames.length) + 1}`,
    categoryName: categoryNames[index % categoryNames.length],
    financeAccountId: accounts[index % accounts.length].id,
    financeAccountName: accountNames[index % accountNames.length],
    currency,
    amountOriginal: amount,
    fxRateToCny: rate,
    amountCny: String(68 + index * 31.5),
    occurredAt: `2026-08-${String(10 - Math.floor(index / 5)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
    payee: payees[index % payees.length],
    receiptAttachmentId: null,
    remark: index % 3 === 0 ? '已核对业务凭证' : null,
    status: index % 9 === 8 ? 'reversed' : 'posted',
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: '2026-08-10T09:20:00.000Z'
  };
}

const allExpenses = emptyState ? [] : Array.from({ length: 23 }, (_, index) => makeExpense(index));

function makeInflow(index: number): V2FinanceInflow {
  const currency = currencies[index % currencies.length];
  const nature: V2FinanceInflowNature =
    index % 3 === 0
      ? 'operating_income'
      : index % 3 === 1
        ? 'capital_contribution'
        : 'borrowed_funds';
  const hasEvidence = index % 4 !== 3;
  const receiptId = hasEvidence ? `inflow-receipt-${index + 1}` : null;
  return {
    id: `inflow-${index + 1}`,
    journalId: `inflow-journal-${index + 1}`,
    nature,
    categoryOptionId: nature === 'operating_income' ? `income-category-${index + 1}` : null,
    categoryName: nature === 'operating_income' ? '额外服务收入' : null,
    financeAccountId: accounts[index % accounts.length].id,
    financeAccountName: accountNames[index % accountNames.length],
    currency,
    amountOriginal: String(180 + index * 20),
    fxRateToCny: currency === 'CNY' ? '1' : currency === 'MYR' ? '1.68' : '7.18',
    amountCny: String(180 + index * 72),
    occurredAt: `2026-08-${String(10 - Math.floor(index / 5)).padStart(2, '0')}T${String(8 + (index % 10)).padStart(2, '0')}:20:00.000Z`,
    payer:
      nature === 'capital_contribution'
        ? '股东甲'
        : nature === 'borrowed_funds'
          ? '合作方'
          : '客户',
    externalReference: hasEvidence ? `INCOME-${String(index + 1).padStart(4, '0')}` : null,
    receiptAttachmentId: receiptId,
    receiptAttachment: receiptId
      ? {
          id: receiptId,
          originalName: `收款凭证-${String(index + 1).padStart(4, '0')}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: String(84_000 + index * 1_280),
          contentSha256: 'a'.repeat(64)
        }
      : null,
    remark: index % 2 === 0 ? '已核对收款凭证' : null,
    status: index % 9 === 8 ? 'reversed' : 'posted',
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: '2026-08-10T09:20:00.000Z'
  };
}

const allInflows = emptyState ? [] : Array.from({ length: 17 }, (_, index) => makeInflow(index));

const page = reactive({
  expenseOnly: true,
  activeTab: 'expenses',
  cashbookView: 'inflows',
  filters: {
    currency: '' as V2FinanceCurrency | '',
    inflowNature: '' as V2FinanceInflowNature | '',
    periodMonth: '',
    journalType: ''
  },
  inflowPage: 1,
  expensePage: 1,
  displayedInflowPage: 1,
  displayedExpensePage: 1,
  journalPage: 1,
  pageSize: 10,
  canPost: true,
  canAdjust: true,
  canManage: true,
  canClose: true,
  accounts,
  wallets: [],
  inflows: [] as V2FinanceInflow[],
  inflowTotal: allInflows.length,
  inflowSummary: {
    operatingIncomeCny: emptyState ? '0' : '2860',
    capitalContributionCny: emptyState ? '0' : '4200',
    borrowedFundsCny: emptyState ? '0' : '1800',
    totalInflowCny: emptyState ? '0' : '8860'
  },
  expenses: [] as V2FinanceExpense[],
  expenseTotal: allExpenses.length,
  journals: [],
  journalTotal: 0,
  periods: [],
  settings: {
    baseCurrency: 'CNY',
    timezone: 'Asia/Shanghai',
    enabledAt: '2026-01-01T00:00:00.000Z',
    historyStatus: 'completed',
    historyCompletedAt: '2026-02-08T12:00:00.000Z',
    historyNote: '历史订单、旧开支与期初资产已完成核对。'
  },
  loading: false,
  queryPhase: 'ready',
  resolved: true,
  error: '',
  receiptDownloadingId: '',
  refresh: () => setNotice('收支记账数据已刷新。'),
  applyFilters: () => {
    page.inflowPage = 1;
    page.expensePage = 1;
    page.displayedInflowPage = 1;
    page.displayedExpensePage = 1;
    applyInflowPage();
    applyExpensePage();
    setNotice(
      page.filters.currency ? `已筛选 ${page.filters.currency} 开支。` : '已显示全部币种。'
    );
  },
  resetFilters: () => {
    page.filters.currency = '';
    page.filters.inflowNature = '';
    page.inflowPage = 1;
    page.expensePage = 1;
    page.displayedInflowPage = 1;
    page.displayedExpensePage = 1;
    applyInflowPage();
    applyExpensePage();
    setNotice('筛选条件已清除。');
  },
  openExpense: (expense?: V2FinanceExpense) =>
    setNotice(expense ? `预览操作：更正 ${expense.categoryName}` : '预览操作：记录经营开支'),
  openInflow: (inflow?: V2FinanceInflow) =>
    setNotice(
      inflow ? `预览操作：更正 ${inflow.categoryName || '资金流入'}` : '预览操作：收入记账'
    ),
  viewInflowReceipt: (inflow: V2FinanceInflow) =>
    setNotice(`预览操作：查看 ${inflow.receiptAttachment?.originalName || '收款凭证'}`),
  setInflowPage: (nextPage: number) => {
    page.inflowPage = nextPage;
    page.displayedInflowPage = nextPage;
    applyInflowPage();
  },
  setExpensePage: (nextPage: number) => {
    page.expensePage = nextPage;
    page.displayedExpensePage = nextPage;
    applyExpensePage();
  }
}) as unknown as FinanceLedgerPage;

function applyExpensePage() {
  const filtered = page.filters.currency
    ? allExpenses.filter((item) => item.currency === page.filters.currency)
    : allExpenses;
  page.expenseTotal = filtered.length;
  const start = (page.expensePage - 1) * page.pageSize;
  page.expenses = filtered.slice(start, start + page.pageSize);
}

function applyInflowPage() {
  const filtered = allInflows.filter(
    (item) =>
      (!page.filters.currency || item.currency === page.filters.currency) &&
      (!page.filters.inflowNature || item.nature === page.filters.inflowNature)
  );
  page.inflowTotal = filtered.length;
  const start = (page.inflowPage - 1) * page.pageSize;
  page.inflows = filtered.slice(start, start + page.pageSize);
}

function setNotice(message: string) {
  notice.value = message;
}

applyInflowPage();
applyExpensePage();
</script>

<style scoped>
.v2-finance-expenses-fixture-avatar {
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

.v2-finance-expenses-fixture-notice {
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
