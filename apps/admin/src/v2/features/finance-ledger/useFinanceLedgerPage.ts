import { computed, reactive, ref } from 'vue';
import type {
  V2FinanceAccount,
  V2FinanceAccountStatus,
  V2FinanceAccountType,
  V2FinanceCurrency,
  V2FinanceExpense,
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
import type { V2OptionSelector } from '@/v2/types/options';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { idBusinessV2FinanceApi } from './api';
import { useFinanceHistory } from './useFinanceHistory';
import { useFinanceLedgerWallets } from './useFinanceLedgerWallets';

export type FinanceLedgerTab = 'accounts' | 'wallets' | 'expenses' | 'journals' | 'periods';
export type { WalletMutationMode } from './useFinanceLedgerWallets';
export type PeriodMutationMode = 'close' | 'reopen';

interface FinanceLedgerSnapshot {
  accounts: V2FinanceAccount[];
  wallets: V2FinanceSupplierWallet[];
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
  const activeTab = ref<FinanceLedgerTab>(expenseOnly ? 'expenses' : 'accounts');
  const filters = reactive({
    currency: '' as V2FinanceCurrency | '',
    periodMonth: '',
    journalType: '' as V2FinanceJournalType | ''
  });
  const expensePage = ref(1);
  const journalPage = ref(1);
  const pageSize = 50;

  const ledgerQuery = useV2ModuleQuery<FinanceLedgerSnapshot>({
    moduleKey,
    scope: 'finance-ledger',
    key: () =>
      createV2QueryKey({
        ...filters,
        expensePage: expensePage.value,
        journalPage: journalPage.value
      }),
    keepPreviousData: true,
    query: async ({ signal }) => {
      return idBusinessV2FinanceApi.bootstrapLedger(
        {
          currency: filters.currency || undefined,
          expensePage: expensePage.value,
          journalPage: journalPage.value,
          pageSize,
          periodMonth: filters.periodMonth || undefined,
          journalType: filters.journalType || undefined
        },
        { signal }
      );
    }
  });

  const data = computed(() => ledgerQuery.data.value);
  const accounts = computed(() => data.value?.accounts ?? []);
  const wallets = computed(() => data.value?.wallets ?? []);
  const expenses = computed(() => data.value?.expenses.items ?? []);
  const expenseTotal = computed(() => data.value?.expenses.total ?? 0);
  const journals = computed(() => data.value?.journals.items ?? []);
  const journalTotal = computed(() => data.value?.journals.total ?? 0);
  const periods = computed(() => data.value?.periods ?? []);
  const settings = computed(() => data.value?.settings);
  const supplierOptions = computed(() => data.value?.supplierOptions ?? []);
  const expenseCategories = computed(() => data.value?.expenseCategories ?? []);
  const loading = computed(
    () => ledgerQuery.isInitialLoading.value || ledgerQuery.isRefreshing.value
  );
  const resolved = computed(() => ledgerQuery.hasLoadedOnce.value);
  const error = computed(() =>
    ledgerQuery.error.value ? getApiErrorMessage(ledgerQuery.error.value) : ''
  );

  const accountDrawerVisible = ref(false);
  const accountSubmitting = ref(false);
  const editingAccount = ref<V2FinanceAccount | null>(null);
  const accountForm = reactive({
    name: '',
    accountType: 'bank' as V2FinanceAccountType,
    currency: 'CNY' as V2FinanceCurrency,
    openingBalance: '0',
    fxRateToCny: '',
    manualRateReason: '',
    remark: '',
    status: 'active' as V2FinanceAccountStatus
  });
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
  const expenseCorrectionReason = ref('');
  const expenseForm = reactive({
    categoryOptionId: '',
    financeAccountId: '',
    amount: '',
    occurredAt: toLocalDateTime(new Date()),
    fxRateToCny: '',
    manualRateReason: '',
    payee: '',
    remark: ''
  });
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
  const reversalReason = ref('');

  const periodDrawerVisible = ref(false);
  const periodSubmitting = ref(false);
  const periodMutationMode = ref<PeriodMutationMode>('close');
  const periodForm = reactive({ month: currentKualaLumpurMonth(), reason: '' });

  function refresh() {
    return ledgerQuery.refresh();
  }
  const walletActions = useFinanceLedgerWallets({ accounts, refresh });
  const historyActions = useFinanceHistory({ refresh });

  function applyFilters() {
    expensePage.value = 1;
    journalPage.value = 1;
    void refresh();
  }

  function resetFilters() {
    filters.currency = '';
    filters.periodMonth = '';
    filters.journalType = '';
    applyFilters();
  }

  function openAccount(account?: V2FinanceAccount) {
    editingAccount.value = account ?? null;
    Object.assign(accountForm, {
      name: account?.name ?? '',
      accountType: account?.accountType ?? 'bank',
      currency: account?.currency ?? 'CNY',
      openingBalance: account?.openingBalance ?? '0',
      fxRateToCny: '',
      manualRateReason: '',
      remark: account?.remark ?? '',
      status: account?.status ?? 'active'
    });
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
    try {
      if (editingAccount.value) {
        await idBusinessV2FinanceApi.updateAccount(editingAccount.value.id, {
          name: accountForm.name.trim(),
          status: accountForm.status,
          remark: accountForm.remark.trim()
        });
      } else {
        await idBusinessV2FinanceApi.createAccount({
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
      accountDrawerVisible.value = false;
      ElMessage.success(editingAccount.value ? '资金账户已更新' : '资金账户已创建');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      accountSubmitting.value = false;
    }
  }

  function openExpense(expense?: V2FinanceExpense) {
    editingExpense.value = expense ?? null;
    expenseCorrectionReason.value = '';
    Object.assign(expenseForm, {
      categoryOptionId: expense?.categoryOptionId ?? '',
      financeAccountId: expense?.financeAccountId ?? '',
      amount: expense?.amountOriginal ?? '',
      occurredAt: toLocalDateTime(expense ? new Date(expense.occurredAt) : new Date()),
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
    selectedJournal.value = journal;
    reversalReason.value = '';
    reversalDrawerVisible.value = true;
  }

  async function submitReversal() {
    if (!selectedJournal.value || !reversalReason.value.trim()) {
      return showWarning('请填写冲销原因');
    }
    reversalSubmitting.value = true;
    try {
      await idBusinessV2FinanceApi.reverseJournal(selectedJournal.value.id, {
        reason: reversalReason.value.trim(),
        idempotencyKey: requestKey()
      });
      reversalDrawerVisible.value = false;
      ElMessage.success('原账务已冲销，请按正确证据重新记账');
    } catch (cause) {
      ElMessage.error(getApiErrorMessage(cause));
    } finally {
      reversalSubmitting.value = false;
    }
  }

  function openPeriod(mode: PeriodMutationMode, period?: V2FinancePeriod) {
    periodMutationMode.value = mode;
    periodForm.month = period?.month ?? currentKualaLumpurMonth();
    periodForm.reason = '';
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
    try {
      if (periodMutationMode.value === 'close') {
        await idBusinessV2FinanceApi.closePeriod(periodForm.month);
      } else {
        await idBusinessV2FinanceApi.reopenPeriod(periodForm.month, periodForm.reason.trim());
      }
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

  function setJournalPage(page: number) {
    journalPage.value = page;
    void refresh();
  }

  return {
    expenseOnly,
    activeTab,
    filters,
    expensePage,
    journalPage,
    pageSize,
    canPost,
    canAdjust,
    canManage,
    canClose,
    accounts,
    wallets,
    expenses,
    expenseTotal,
    journals,
    journalTotal,
    periods,
    settings,
    supplierOptions,
    expenseCategories,
    queryPhase: ledgerQuery.phase,
    isParameterTransition: ledgerQuery.isParameterTransition,
    loading,
    resolved,
    error,
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

function toLocalDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoDate(value: string) {
  return new Date(value).toISOString();
}

function currentKualaLumpurMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit'
  }).format(new Date());
}
