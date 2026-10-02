import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { toRef, computed, reactive, ref } from 'vue';
import type {
  V2FinanceAccount,
  V2FinanceAccountStatus,
  V2FinanceAccountType,
  V2FinanceCurrency,
  V2FinanceExpense,
  V2FinanceInflow,
  V2FinanceInflowNature,
  V2FinanceInflowSummary,
  V2FinanceJournal,
  V2FinanceJournalType,
  V2FinancePeriod,
  V2FinanceSettings,
  V2FinanceSupplierWallet
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import type { V2ModuleKey } from '@/v2/features/feature';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  ensureV2BusinessNowInput,
  ensureV2BusinessNowMs,
  getV2BusinessNowInput,
  getV2BusinessNowMs
} from '@/v2/runtime/businessClock';
import type { V2OptionSelector } from './contracts';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import {
  currentV2BusinessMonth,
  toV2DateTimeInput,
  v2DateTimeInputToIso
} from '@/v2/utils/dateTime';
import { idBusinessV2FinanceApi } from './api';
import { journalReversalBlockReason } from './financeLedgerPresentation';
import { useFinanceHistory } from './useFinanceHistory';
import { useFinanceLedgerInflows } from './useFinanceLedgerInflows';
import { useFinanceLedgerWallets } from './useFinanceLedgerWallets';

export type FinanceLedgerTab = 'accounts' | 'wallets' | 'expenses' | 'journals' | 'periods';
export type FinanceCashbookView = 'inflows' | 'expenses' | 'exchanges';
export type { WalletMutationMode } from './useFinanceLedgerWallets';
export type PeriodMutationMode = 'close' | 'reopen';

interface FinanceLedgerSnapshot {
  accounts: V2FinanceAccount[];
  wallets: V2FinanceSupplierWallet[];
  inflows: {
    items: V2FinanceInflow[];
    total: number;
    summary: V2FinanceInflowSummary;
  };
  expenses: {
    items: V2FinanceExpense[];
    total: number;
  };
  journals: {
    items: V2FinanceJournal[];
    total: number;
  };
  periods: V2FinancePeriod[];
  settings: V2FinanceSettings;
  supplierOptions: V2OptionSelector[];
  expenseCategories: V2OptionSelector[];
  incomeCategories: V2OptionSelector[];
  pagination: {
    inflowPage: number;
    expensePage: number;
    journalPage: number;
    pageSize: number;
  };
}

export function useFinanceLedgerPage(
  moduleKey: Extract<V2ModuleKey, 'finance-ledger' | 'finance-expenses'>,
  expenseOnly: boolean
) {
  const authStore = useAuthStore();
  const canPost = computed(() => hasUserPermission(authStore.user, 'finance.post'));
  const canAdjust = computed(() => hasUserPermission(authStore.user, 'finance.adjust'));
  const canManage = computed(() => hasUserPermission(authStore.user, 'finance.manage'));
  const canClose = computed(() => hasUserPermission(authStore.user, 'finance.close'));
  const activeTab = useV2SessionDraft(`${moduleKey}:activeTab`, () =>
    ref<FinanceLedgerTab>(expenseOnly ? 'expenses' : 'accounts')
  );
  const cashbookView = useV2SessionDraft(`${moduleKey}:cashbookView`, () =>
    ref<FinanceCashbookView>('inflows')
  );
  const filters = useV2SessionDraft(`${moduleKey}:filters`, () =>
    reactive({
      currency: '' as V2FinanceCurrency | '',
      inflowNature: '' as V2FinanceInflowNature | '',
      periodMonth: '',
      journalType: '' as V2FinanceJournalType | ''
    })
  );
  const inflowPage = useV2SessionDraft(`${moduleKey}:inflowPage`, () => ref(1));
  const expensePage = useV2SessionDraft(`${moduleKey}:expensePage`, () => ref(1));
  const journalPage = useV2SessionDraft(`${moduleKey}:journalPage`, () => ref(1));
  const pageSize = 50;

  const ledgerQuery = useV2ModuleQuery<FinanceLedgerSnapshot>({
    moduleKey,
    scope: 'finance-ledger',
    key: () =>
      createV2QueryKey({
        ...filters,
        inflowPage: inflowPage.value,
        expensePage: expensePage.value,
        journalPage: journalPage.value
      }),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const pagination = {
        inflowPage: inflowPage.value,
        expensePage: expensePage.value,
        journalPage: journalPage.value,
        pageSize
      };
      const snapshot = await idBusinessV2FinanceApi.bootstrapLedger(
        {
          currency: filters.currency || undefined,
          inflowNature: filters.inflowNature || undefined,
          ...pagination,
          periodMonth: filters.periodMonth || undefined,
          journalType: filters.journalType || undefined
        },
        { signal }
      );
      return { ...snapshot, pagination };
    }
  });

  const data = computed(() => ledgerQuery.data.value);
  const accounts = computed(() => data.value?.accounts ?? []);
  const wallets = computed(() => data.value?.wallets ?? []);
  const inflows = computed(() => data.value?.inflows.items ?? []);
  const inflowTotal = computed(() => data.value?.inflows.total ?? 0);
  const inflowSummary = computed<V2FinanceInflowSummary>(
    () =>
      data.value?.inflows.summary ?? {
        operatingIncomeCny: '0',
        capitalContributionCny: '0',
        borrowedFundsCny: '0',
        totalInflowCny: '0'
      }
  );
  const expenses = computed(() => data.value?.expenses.items ?? []);
  const expenseTotal = computed(() => data.value?.expenses.total ?? 0);
  const journals = computed(() => data.value?.journals.items ?? []);
  const journalTotal = computed(() => data.value?.journals.total ?? 0);
  const displayedExpensePage = computed(
    () => data.value?.pagination.expensePage ?? expensePage.value
  );
  const displayedInflowPage = computed(() => data.value?.pagination.inflowPage ?? inflowPage.value);
  const displayedJournalPage = computed(
    () => data.value?.pagination.journalPage ?? journalPage.value
  );
  const periods = computed(() => data.value?.periods ?? []);
  const settings = computed(() => data.value?.settings);
  const supplierOptions = computed(() => data.value?.supplierOptions ?? []);
  const expenseCategories = computed(() => data.value?.expenseCategories ?? []);
  const incomeCategories = computed(() => data.value?.incomeCategories ?? []);
  const loading = computed(
    () => ledgerQuery.isInitialLoading.value || ledgerQuery.isRefreshing.value
  );
  const resolved = computed(() => ledgerQuery.hasLoadedOnce.value);
  const error = computed(() =>
    ledgerQuery.error.value ? getApiErrorMessage(ledgerQuery.error.value) : ''
  );

  const exchangeDrawerVisible = ref(false);
  const lastCreatedAccount = ref<V2FinanceAccount | null>(null);
  const accountDrawerVisible = ref(false);
  const accountSubmitting = ref(false);
  const editingAccount = ref<V2FinanceAccount | null>(null);
  const accountFormDraft = useV2FormDraft('finance-account-editor', () => ({
    name: '',
    accountType: 'bank' as V2FinanceAccountType,
    currency: 'CNY' as V2FinanceCurrency,
    openingBalance: '0',
    fxRateToCny: '',
    manualRateReason: '',
    remark: '',
    status: 'active' as V2FinanceAccountStatus
  }));
  const accountForm = accountFormDraft.form;
  const accountDirty = computed(() =>
    Boolean(
      accountForm.name ||
      accountForm.openingBalance !== '0' ||
      accountForm.fxRateToCny ||
      accountForm.manualRateReason ||
      accountForm.remark ||
      editingAccount.value
    )
  );

  const expenseDrawerVisible = ref(false);
  const expenseSubmitting = ref(false);
  const editingExpense = ref<V2FinanceExpense | null>(null);
  const expenseCorrectionReasonDraft = useV2FormDraft('finance-expense-correction-reason', () => ({
    value: ''
  }));
  const expenseCorrectionReason = toRef(expenseCorrectionReasonDraft.form, 'value');
  const expenseFormDraft = useV2FormDraft('finance-expense-editor', () => ({
    categoryOptionId: '',
    financeAccountId: '',
    amount: '',
    occurredAt: getV2BusinessNowInput(),
    fxRateToCny: '',
    manualRateReason: '',
    payee: '',
    remark: ''
  }));
  const expenseForm = expenseFormDraft.form;
  const selectedExpenseAccount = computed(() =>
    accounts.value.find((item) => item.id === expenseForm.financeAccountId)
  );
  const expenseDirty = computed(() =>
    Boolean(
      expenseForm.categoryOptionId ||
      expenseForm.financeAccountId ||
      expenseForm.amount ||
      expenseForm.fxRateToCny ||
      expenseForm.manualRateReason ||
      expenseForm.payee ||
      expenseForm.remark
    )
  );

  const reversalDrawerVisible = ref(false);
  const reversalSubmitting = ref(false);
  const selectedJournal = ref<V2FinanceJournal | null>(null);
  const reversalReasonDraft = useV2FormDraft('finance-journal-reversal-reason', () => ({
    value: ''
  }));
  const reversalReason = toRef(reversalReasonDraft.form, 'value');

  const periodDrawerVisible = ref(false);
  const periodSubmitting = ref(false);
  const periodMutationMode = ref<PeriodMutationMode>('close');
  const periodFormDraft = useV2FormDraft('finance-period-editor', () => ({
    month: currentV2BusinessMonth(getV2BusinessNowMs()),
    reason: ''
  }));
  const periodForm = periodFormDraft.form;

  function refresh() {
    return ledgerQuery.refresh();
  }
  const walletActions = useFinanceLedgerWallets({ accounts, refresh });
  const inflowActions = useFinanceLedgerInflows({ accounts });
  const historyActions = useFinanceHistory({ refresh });

  function applyFilters() {
    inflowPage.value = 1;
    expensePage.value = 1;
    journalPage.value = 1;
    void refresh();
  }

  function resetFilters() {
    filters.currency = '';
    filters.inflowNature = '';
    filters.periodMonth = '';
    filters.journalType = '';
    applyFilters();
  }

  function openAccount(account?: V2FinanceAccount) {
    editingAccount.value = account ?? null;
    accountFormDraft.open(
      account?.id ?? 'create',
      {
        name: account?.name ?? '',
        accountType: account?.accountType ?? 'bank',
        currency: account?.currency ?? 'CNY',
        openingBalance: account?.openingBalance ?? '0',
        fxRateToCny: '',
        manualRateReason: '',
        remark: account?.remark ?? '',
        status: account?.status ?? 'active'
      },
      account?.updatedAt
    );
    accountDrawerVisible.value = true;
  }

  async function submitAccount() {
    if (!accountForm.name.trim()) return showWarning('请填写账户名称');
    if (!editingAccount.value && !validUnsigned(accountForm.openingBalance, true)) {
      return showWarning('期初余额格式不正确');
    }
    if (
      !editingAccount.value &&
      accountForm.currency !== 'CNY' &&
      accountForm.fxRateToCny &&
      !accountForm.manualRateReason.trim()
    ) {
      return showWarning('填写人工汇率时必须说明原因');
    }
    accountSubmitting.value = true;
    const completeSave = accountFormDraft.beginSave();
    try {
      if (editingAccount.value) {
        await idBusinessV2FinanceApi.updateAccount(editingAccount.value.id, {
          expectedUpdatedAt: accountFormDraft.version.value ?? editingAccount.value.updatedAt,
          name: accountForm.name.trim(),
          status: accountForm.status,
          remark: accountForm.remark.trim()
        });
      } else {
        lastCreatedAccount.value = await idBusinessV2FinanceApi.createAccount({
          name: accountForm.name.trim(),
          accountType: accountForm.accountType,
          currency: accountForm.currency,
          openingBalance: accountForm.openingBalance,
          fxRateToCny: accountForm.fxRateToCny || undefined,
          manualRateReason: accountForm.manualRateReason.trim() || undefined,
          remark: accountForm.remark.trim() || undefined,
          idempotencyKey: requestKey()
        });
      }
      completeSave();
      accountDrawerVisible.value = false;
      ElMessage.success(editingAccount.value ? '资金账户已更新' : '资金账户已创建');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      accountSubmitting.value = false;
    }
  }

  async function openExpense(expense?: V2FinanceExpense) {
    const businessNow = expense ? null : await ensureV2BusinessNowInput();
    if (!expense && !businessNow) {
      ElMessage.error('无法读取服务器北京时间，请稍后重试');
      return;
    }
    editingExpense.value = expense ?? null;
    expenseCorrectionReasonDraft.open(expense?.id ?? 'create');
    expenseFormDraft.open(expense?.id ?? 'create', {
      categoryOptionId: expense?.categoryOptionId ?? '',
      financeAccountId: expense?.financeAccountId ?? '',
      amount: expense?.amountOriginal ?? '',
      occurredAt: expense?.occurredAt ? toV2DateTimeInput(expense.occurredAt) : (businessNow ?? ''),
      fxRateToCny: '',
      manualRateReason: '',
      payee: expense?.payee ?? '',
      remark: expense?.remark ?? ''
    });
    expenseDrawerVisible.value = true;
  }

  async function submitExpense() {
    const account = selectedExpenseAccount.value;
    if (!expenseForm.categoryOptionId || !account) {
      return showWarning('请选择开支分类和付款账户');
    }
    if (!validUnsigned(expenseForm.amount, false)) return showWarning('开支金额必须大于 0');
    if (!expenseForm.occurredAt) return showWarning('请选择发生时间');
    if (editingExpense.value && !expenseCorrectionReason.value.trim()) {
      return showWarning('请填写更正原因');
    }
    if (
      account.currency !== 'CNY' &&
      expenseForm.fxRateToCny &&
      !expenseForm.manualRateReason.trim()
    ) {
      return showWarning('填写人工汇率时必须说明原因');
    }
    expenseSubmitting.value = true;
    const completeExpenseCorrectionReasonSave = expenseCorrectionReasonDraft.beginSave();
    const completeSave = expenseFormDraft.beginSave();
    try {
      const payload = {
        categoryOptionId: expenseForm.categoryOptionId,
        financeAccountId: account.id,
        amount: expenseForm.amount,
        currency: account.currency,
        occurredAt: toIsoDate(expenseForm.occurredAt),
        fxRateToCny: expenseForm.fxRateToCny || undefined,
        manualRateReason: expenseForm.manualRateReason.trim() || undefined,
        payee: expenseForm.payee.trim() || undefined,
        remark: expenseForm.remark.trim() || undefined,
        idempotencyKey: requestKey()
      };
      if (editingExpense.value) {
        await idBusinessV2FinanceApi.correctExpense(editingExpense.value.id, {
          ...payload,
          reason: expenseCorrectionReason.value.trim()
        });
      } else {
        await idBusinessV2FinanceApi.createExpense(payload);
      }
      completeSave();
      completeExpenseCorrectionReasonSave();
      expenseDrawerVisible.value = false;
      ElMessage.success(
        editingExpense.value ? '原流水已冲销，正确开支已重新入账' : '经营开支已入账'
      );
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      expenseSubmitting.value = false;
    }
  }

  function openReversal(journal: V2FinanceJournal) {
    const blockedReason = journalReversalBlockReason(journal);
    if (blockedReason) return showWarning(blockedReason);
    selectedJournal.value = journal;
    reversalReasonDraft.open(journal.id);
    reversalDrawerVisible.value = true;
  }

  async function submitReversal() {
    if (!selectedJournal.value || !reversalReason.value.trim()) {
      return showWarning('请填写冲销原因');
    }
    const blockedReason = journalReversalBlockReason(selectedJournal.value);
    if (blockedReason) return showWarning(blockedReason);
    reversalSubmitting.value = true;
    const completeReversalReasonSave = reversalReasonDraft.beginSave();
    try {
      await idBusinessV2FinanceApi.reverseJournal(selectedJournal.value.id, {
        reason: reversalReason.value.trim(),
        idempotencyKey: requestKey()
      });
      completeReversalReasonSave();
      reversalDrawerVisible.value = false;
      ElMessage.success('原账务已冲销，请按正确证据重新记账');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      reversalSubmitting.value = false;
    }
  }

  async function openPeriod(mode: PeriodMutationMode, period?: V2FinancePeriod) {
    const businessNow = period ? null : await ensureV2BusinessNowMs();
    if (!period && businessNow === null) {
      ElMessage.error('无法读取服务器北京时间，请稍后重试');
      return;
    }
    periodMutationMode.value = mode;
    periodFormDraft.open(`${mode}:${period?.month ?? 'current'}`, {
      month: period?.month ?? currentV2BusinessMonth(businessNow),
      reason: ''
    });
    periodDrawerVisible.value = true;
  }

  async function submitPeriod() {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodForm.month)) {
      return showWarning('月份格式必须是 YYYY-MM');
    }
    if (periodMutationMode.value === 'reopen' && !periodForm.reason.trim()) {
      return showWarning('重新打开月份必须填写原因');
    }
    periodSubmitting.value = true;
    const completeSave = periodFormDraft.beginSave();
    try {
      if (periodMutationMode.value === 'close') {
        await idBusinessV2FinanceApi.closePeriod(periodForm.month);
      } else {
        await idBusinessV2FinanceApi.reopenPeriod(periodForm.month, periodForm.reason.trim());
      }
      completeSave();
      periodDrawerVisible.value = false;
      ElMessage.success(periodMutationMode.value === 'close' ? '月份已关账' : '月份已重新打开');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      periodSubmitting.value = false;
    }
  }

  function setExpensePage(page: number) {
    expensePage.value = page;
    void refresh();
  }

  function setInflowPage(page: number) {
    inflowPage.value = page;
    void refresh();
  }

  function setJournalPage(page: number) {
    journalPage.value = page;
    void refresh();
  }

  return {
    expenseOnly,
    activeTab,
    cashbookView,
    filters,
    inflowPage,
    expensePage,
    journalPage,
    displayedInflowPage,
    displayedExpensePage,
    displayedJournalPage,
    pageSize,
    canPost,
    canAdjust,
    canManage,
    canClose,
    accounts,
    wallets,
    inflows,
    inflowTotal,
    inflowSummary,
    expenses,
    expenseTotal,
    journals,
    journalTotal,
    periods,
    settings,
    supplierOptions,
    expenseCategories,
    incomeCategories,
    queryPhase: ledgerQuery.phase,
    isParameterTransition: ledgerQuery.isParameterTransition,
    loading,
    resolved,
    error,
    exchangeDrawerVisible,
    lastCreatedAccount,
    accountDrawerVisible,
    accountSubmitting,
    editingAccount,
    accountForm,
    accountDirty,
    expenseDrawerVisible,
    expenseSubmitting,
    editingExpense,
    expenseCorrectionReason,
    expenseForm,
    selectedExpenseAccount,
    expenseDirty,
    ...inflowActions,
    ...walletActions,
    reversalDrawerVisible,
    reversalSubmitting,
    selectedJournal,
    reversalReason,
    periodDrawerVisible,
    periodSubmitting,
    periodMutationMode,
    periodForm,
    ...historyActions,
    refresh,
    applyFilters,
    resetFilters,
    openAccount,
    submitAccount,
    openExpense,
    submitExpense,
    openReversal,
    submitReversal,
    openPeriod,
    submitPeriod,
    setExpensePage,
    setInflowPage,
    setJournalPage
  };
}

function validUnsigned(value: string, allowZero: boolean) {
  return isV2UnsignedDecimal(value, { allowZero, decimalPlaces: 4 });
}

function requestKey() {
  return globalThis.crypto.randomUUID();
}

function showWarning(message: string) {
  ElMessage.warning(message);
}

function toIsoDate(value: string) {
  return v2DateTimeInputToIso(value);
}
