<template>
  <div class="v2-shell v2-finance-ledger-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#finance-ledger">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">钱包账户</span>
            </a>
            <a class="v2-navigation__item" href="#finance-expenses">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">开支记账</span>
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
        <div class="v2-topbar__identity"><h1>钱包账户</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-finance-ledger-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-finance-ledger-fixture-notice" role="status">
            {{ notice }}
          </p>
          <section class="v2-finance-page v2-finance-page--ledger">
            <div class="v2-finance-ledger-page">
              <V2FinanceLedgerOverview :page="page" />
              <V2FinanceLedgerNavigation :page="page" />
              <V2FinanceLedgerToolbar :page="page" />
              <V2FinanceLedgerWorkspace :page="page" />
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
import V2FinanceLedgerNavigation from '@/v2/features/finance-ledger/components/V2FinanceLedgerNavigation.vue';
import V2FinanceLedgerOverview from '@/v2/features/finance-ledger/components/V2FinanceLedgerOverview.vue';
import V2FinanceLedgerToolbar from '@/v2/features/finance-ledger/components/V2FinanceLedgerToolbar.vue';
import V2FinanceLedgerWorkspace from '@/v2/features/finance-ledger/components/V2FinanceLedgerWorkspace.vue';
import type {
  V2FinanceAccount,
  V2FinanceAccountCode,
  V2FinanceJournal,
  V2FinanceJournalType,
  V2FinancePeriod,
  V2FinanceSupplierWallet
} from '@/v2/features/finance-ledger/contracts';
import type {
  FinanceLedgerTab,
  PeriodMutationMode,
  useFinanceLedgerPage,
  WalletMutationMode
} from '@/v2/features/finance-ledger/useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];
const notice = ref('');
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const accountTypes = ['bank', 'cash', 'ewallet', 'usdt_wallet'] as const;
const currencies = ['CNY', 'MYR', 'USD', 'USDT'] as const;
const journalTypes: V2FinanceJournalType[] = [
  'order_completed',
  'supplier_deposit',
  'account_purchase',
  'expense',
  'supplier_refund'
];
const accountCodes: V2FinanceAccountCode[] = [
  'cash',
  'sales_revenue',
  'supplier_prepayment',
  'id_inventory',
  'operating_expense'
];

const accounts = emptyState
  ? []
  : Array.from({ length: 6 }, (_, index): V2FinanceAccount => {
      const currency = currencies[index % currencies.length];
      const opening = String(1800 + index * 640);
      const current = String(2380 + index * 715);
      return {
        id: `account-${index + 1}`,
        name: ['人民币收款账户', '马币备用金', '美元结算账户', 'USDT 主钱包'][index % 4],
        accountType: accountTypes[index % accountTypes.length],
        currency,
        openingBalance: opening,
        currentBalance: current,
        openingBalanceCny: String(1800 + index * 880),
        currentBalanceCny: String(2380 + index * 990),
        status: index === 5 ? 'disabled' : 'active',
        remark: index === 5 ? '备用账户' : null,
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-08-10T09:20:00.000Z'
      };
    });

const wallets = emptyState
  ? []
  : Array.from({ length: 5 }, (_, index): V2FinanceSupplierWallet => {
      const currency = currencies[(index + 1) % currencies.length];
      return {
        id: `wallet-${index + 1}`,
        supplierOptionId: `supplier-${index + 1}`,
        supplierName: ['星河卡商', '远洋供应链', 'Cloud ID', 'Nova Digital', '金桥科技'][index],
        currency,
        openingBalance: String(3200 + index * 500),
        currentBalance: String(4680 + index * 760),
        openingBalanceCny: String(4900 + index * 860),
        currentBalanceCny: String(7120 + index * 1180),
        status: 'active',
        initializedAt: `2026-07-${String(index + 2).padStart(2, '0')}T08:00:00.000Z`,
        updatedAt: '2026-08-10T09:20:00.000Z'
      };
    });

function createJournal(index: number): V2FinanceJournal {
  const currency = currencies[index % currencies.length];
  const amount = String(168 + index * 37);
  const journalType = journalTypes[index % journalTypes.length];
  const accountCode = accountCodes[index % accountCodes.length];
  const nextAccountCode = accountCodes[(index + 1) % accountCodes.length];
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
    status: index % 8 === 7 ? 'reversed' : 'posted',
    reversalOfJournalId: null,
    reversedAt: index % 8 === 7 ? '2026-08-10T18:00:00.000Z' : null,
    summary: ['客户订单完成', '供应商钱包充值', '采购 ID 入库', '记录经营开支', '供应商退款到账'][
      index % 5
    ],
    lines: [
      {
        id: `line-${index + 1}-1`,
        lineNo: 1,
        accountCode,
        direction: 'debit',
        currency,
        amountOriginal: amount,
        fxRateToCny: currency === 'CNY' ? '1' : '7.18',
        amountCny: String(168 + index * 37),
        financeAccountId: null,
        supplierAccountId: null,
        memo: '业务入账'
      },
      {
        id: `line-${index + 1}-2`,
        lineNo: 2,
        accountCode: nextAccountCode,
        direction: 'credit',
        currency,
        amountOriginal: amount,
        fxRateToCny: currency === 'CNY' ? '1' : '7.18',
        amountCny: String(168 + index * 37),
        financeAccountId: null,
        supplierAccountId: null,
        memo: '对应科目'
      }
    ]
  };
}

const allJournals = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => createJournal(index));
const periods: V2FinancePeriod[] = emptyState
  ? []
  : [
      {
        month: '2026-08',
        status: 'open',
        closedAt: null,
        reopenReason: null,
        reopenedAt: null,
        updatedAt: '2026-08-10T09:20:00.000Z'
      },
      {
        month: '2026-07',
        status: 'closed',
        closedAt: '2026-08-03T12:00:00.000Z',
        reopenReason: null,
        reopenedAt: null,
        updatedAt: '2026-08-03T12:00:00.000Z'
      },
      {
        month: '2026-06',
        status: 'reopened',
        closedAt: '2026-07-03T12:00:00.000Z',
        reopenReason: '补录供应商退款凭证',
        reopenedAt: '2026-07-05T10:30:00.000Z',
        updatedAt: '2026-07-05T10:30:00.000Z'
      }
    ];

const page = reactive({
  expenseOnly: false,
  activeTab: 'accounts' as FinanceLedgerTab,
  filters: { currency: '' as '' | (typeof currencies)[number], periodMonth: '', journalType: '' },
  expensePage: 1,
  journalPage: 1,
  pageSize: 10,
  canPost: true,
  canAdjust: true,
  canManage: true,
  canClose: true,
  accounts,
  wallets,
  expenses: [],
  expenseTotal: 0,
  journals: [] as V2FinanceJournal[],
  journalTotal: allJournals.length,
  periods,
  settings: {
    baseCurrency: 'CNY',
    timezone: 'Asia/Kuala_Lumpur',
    enabledAt: '2026-01-01T00:00:00.000Z',
    historyStatus: 'completed',
    historyCompletedAt: '2026-02-08T12:00:00.000Z',
    historyNote: '历史订单、旧开支与期初资产已完成核对。'
  },
  loading: false,
  resolved: true,
  error: '',
  historyPreviewLoading: false,
  historyConfirmationLoading: false,
  refresh: () => setNotice('钱包账户数据已刷新。'),
  applyFilters: () => setNotice('已按当前条件更新财务快照。'),
  resetFilters: () => {
    page.filters.currency = '';
    page.filters.periodMonth = '';
    setNotice('筛选条件已清除。');
  },
  openAccount: (account?: V2FinanceAccount) =>
    setNotice(account ? `预览操作：编辑 ${account.name}` : '预览操作：新建资金账户'),
  openWallet: () => setNotice('预览操作：新建供应商钱包'),
  openWalletMutation: (wallet: V2FinanceSupplierWallet, mode: WalletMutationMode) =>
    setNotice(`预览操作：${wallet.supplierName} · ${walletModeLabel(mode)}`),
  openReversal: (journal: V2FinanceJournal) => setNotice(`预览操作：冲销 ${journal.journalNo}`),
  openPeriod: (mode: PeriodMutationMode, period?: V2FinancePeriod) =>
    setNotice(`预览操作：${mode === 'close' ? '月度关账' : `重新打开 ${period?.month}`}`),
  openHistoryBackfillPreview: () => setNotice('预览操作：核对历史回填范围'),
  openHistoryConfirmation: () => setNotice('预览操作：确认期初与旧开支'),
  openHistoryReopen: () => setNotice('预览操作：重新核对历史'),
  setJournalPage: (nextPage: number) => {
    page.journalPage = nextPage;
    applyJournalPage();
  }
}) as unknown as FinanceLedgerPage;

function applyJournalPage() {
  const start = (page.journalPage - 1) * page.pageSize;
  page.journals = allJournals.slice(start, start + page.pageSize);
}

function setNotice(message: string) {
  notice.value = message;
}

function walletModeLabel(mode: WalletMutationMode) {
  return mode === 'deposit' ? '供应商充值' : mode === 'refund' ? '收到供应商退款' : '余额调整';
}

applyJournalPage();
</script>

<style scoped>
.v2-finance-ledger-fixture-avatar {
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

.v2-finance-ledger-fixture-notice {
  margin: 0 0 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--el-color-primary-light-9);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
