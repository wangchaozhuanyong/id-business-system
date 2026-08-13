import { computed, reactive, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { addDecimalStrings, formatV2Decimal } from '@/v2/utils/decimal';
import { idBusinessV2FinanceApi, type V2FinanceReportQuery } from './api';
import type {
  V2FinanceAccount,
  V2FinanceAccountCode,
  V2FinanceCurrency,
  V2FinanceJournal,
  V2FinanceJournalType,
  V2FinanceOverview,
  V2FinanceSupplierWallet
} from './contracts';

const currencies = ['CNY', 'MYR', 'USD', 'USDT'] as const;
const journalTypeOptions: Array<{ value: V2FinanceJournalType; label: string }> = [
  { value: 'order_completed', label: '订单完成' },
  { value: 'order_refund', label: '订单退款' },
  { value: 'gift_card_purchase', label: '礼品卡采购' },
  { value: 'gift_card_redemption_loss', label: '礼品卡赎回' },
  { value: 'account_purchase', label: 'ID 采购' },
  { value: 'account_loss', label: 'ID 报损' },
  { value: 'expense', label: '额外开支' },
  { value: 'supplier_deposit', label: '卡商充值' },
  { value: 'supplier_refund', label: '卡商退款' },
  { value: 'supplier_adjustment', label: '余额调整' },
  { value: 'historical_backfill', label: '历史回填' },
  { value: 'reversal', label: '冲销' }
];

interface AnalyticsSnapshot {
  overview: V2FinanceOverview;
  accounts: V2FinanceAccount[];
  wallets: V2FinanceSupplierWallet[];
  journals: V2FinanceJournal[];
}

export function useDataAnalyticsPage() {
  const filters = reactive({
    dateRange: [] as string[],
    currency: '' as V2FinanceCurrency | '',
    supplierOptionId: '',
    journalType: '' as V2FinanceJournalType | '',
    financeAccountId: '',
    settlementPlatformOptionId: ''
  });
  const applied = ref<V2FinanceReportQuery>({});
  const query = useV2ModuleQuery<AnalyticsSnapshot>({
    moduleKey: 'analytics',
    scope: 'finance-reports',
    key: () => createV2QueryKey(applied.value),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const [overview, accountsResult, walletsResult, journalsResult] = await Promise.all([
        idBusinessV2FinanceApi.overview(applied.value, { signal }),
        idBusinessV2FinanceApi.listAccounts({}, { signal }),
        idBusinessV2FinanceApi.listSupplierWallets({}, { signal }),
        idBusinessV2FinanceApi.listJournals({ ...applied.value, page: 1, pageSize: 50 }, { signal })
      ]);
      return {
        overview,
        accounts: accountsResult.items,
        wallets: walletsResult.items,
        journals: journalsResult.items
      };
    }
  });

  const overview = computed(() => query.data.value?.overview);
  const accounts = computed(() => query.data.value?.accounts ?? []);
  const wallets = computed(() => query.data.value?.wallets ?? []);
  const journals = computed(() => query.data.value?.journals ?? []);
  const loading = computed(() => query.isInitialLoading.value || query.isRefreshing.value);
  const resolved = computed(() => query.hasLoadedOnce.value);
  const error = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));
  const supplierOptions = computed(() => {
    const items = new Map<string, string>();
    for (const wallet of wallets.value) items.set(wallet.supplierOptionId, wallet.supplierName);
    return [...items].map(([value, label]) => ({ value, label }));
  });
  const settlementPlatformOptions = computed(
    () => overview.value?.settlementPlatformReport.options ?? []
  );
  const analysisRangeLabel = computed(() => {
    const { dateFrom, dateTo } = applied.value;
    if (dateFrom && dateTo) return `${dateFrom} 至 ${dateTo}`;
    if (dateFrom) return `${dateFrom} 起`;
    if (dateTo) return `截至 ${dateTo}`;
    return '全部已记账业务日期';
  });
  const activeFilterLabel = computed(() => {
    const count = Object.values(applied.value).filter(
      (value) => value !== undefined && value !== null && value !== ''
    ).length;
    return count ? `已应用 ${count} 项筛选` : '未附加筛选';
  });
  const assetRows = computed(() => {
    if (!overview.value) return [];
    return [
      { label: '自有资金', value: overview.value.assets.cashCny },
      { label: '卡商预付款', value: overview.value.assets.supplierPrepaymentCny },
      { label: '未消耗余额成本', value: overview.value.assets.giftCardInventoryCny },
      { label: '未售 ID 成本', value: overview.value.assets.unsoldIdInventoryCny },
      { label: '待卡商退款', value: overview.value.assets.supplierRefundReceivableCny }
    ];
  });

  function applyFilters() {
    applied.value = {
      dateFrom: filters.dateRange[0] || undefined,
      dateTo: filters.dateRange[1] || undefined,
      currency: filters.currency || undefined,
      supplierOptionId: filters.supplierOptionId || undefined,
      journalType: filters.journalType || undefined,
      financeAccountId: filters.financeAccountId || undefined,
      settlementPlatformOptionId: filters.settlementPlatformOptionId || undefined
    };
    void query.refresh();
  }

  function resetFilters() {
    filters.dateRange = [];
    filters.currency = '';
    filters.supplierOptionId = '';
    filters.journalType = '';
    filters.financeAccountId = '';
    filters.settlementPlatformOptionId = '';
    applyFilters();
  }

  return {
    currencies,
    journalTypeOptions,
    filters,
    overview,
    queryPhase: query.phase,
    isParameterTransition: query.isParameterTransition,
    accounts,
    wallets,
    journals,
    loading,
    resolved,
    error,
    supplierOptions,
    settlementPlatformOptions,
    assetRows,
    analysisRangeLabel,
    activeFilterLabel,
    applyFilters,
    resetFilters,
    refresh: () => void query.refresh(),
    formatCny,
    formatOriginal,
    addAmounts,
    amountTone,
    formatDate,
    journalAmount,
    journalTypeLabel,
    accountCodeLabel,
    directionLabel
  };
}

function formatCny(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  return `¥${formatNumber(value)}`;
}

function formatOriginal(value: string, currency: V2FinanceCurrency) {
  const prefix =
    currency === 'CNY' ? '¥' : currency === 'MYR' ? 'RM ' : currency === 'USD' ? '$' : '₮';
  return `${prefix}${formatNumber(value)}`;
}

function formatNumber(value: string) {
  return formatV2Decimal(value, { minimumFractionDigits: 2 });
}

function addAmounts(...values: string[]) {
  return values.reduce((total, value) => addDecimalStrings(total, value || '0'), '0');
}

function amountTone(value: string | null | undefined) {
  const normalized = String(value ?? '0');
  if (normalized.startsWith('-') && !/^-(?:0|0\.0+)$/.test(normalized)) return 'is-negative';
  return /^(?:0|0\.0+)$/.test(normalized) ? '' : 'is-positive';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function journalAmount(journal: V2FinanceJournal) {
  return journal.lines
    .filter((line) => line.direction === 'debit')
    .reduce((total, line) => addDecimalStrings(total, line.amountCny || '0'), '0');
}

function journalTypeLabel(value: V2FinanceJournalType) {
  return journalTypeOptions.find((item) => item.value === value)?.label ?? value;
}

function accountCodeLabel(value: V2FinanceAccountCode) {
  const labels: Record<V2FinanceAccountCode, string> = {
    cash: '自有资金',
    supplier_prepayment: '卡商预付款',
    supplier_refund_receivable: '待卡商退款',
    gift_card_inventory: '礼品卡余额资产',
    id_inventory: 'ID 库存',
    sales_revenue: '销售收入',
    platform_fee: '平台手续费',
    gift_card_cost: '余额销售成本',
    id_cost: 'ID 销售成本',
    refund_loss: '退款损失',
    gift_card_redemption_loss: '礼品卡赎回损失',
    balance_loss: 'ID 余额报损',
    id_purchase_loss: 'ID 采购成本报损',
    operating_expense: '经营开支',
    realized_fx_gain_loss: '已实现汇兑损益',
    opening_equity: '期初权益',
    manual_adjustment: '手工调整'
  };
  return labels[value];
}

function directionLabel(value: 'debit' | 'credit') {
  return value === 'debit' ? '借' : '贷';
}
