import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { toRef, computed, reactive, ref, watch, type UnwrapNestedRefs } from 'vue';
import {
  calculateFinanceExchange,
  type V2FinanceCurrency,
  type V2FinanceExchange,
  type V2FinanceExchangeFeeMode,
  type V2FinanceExchangeWrite
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ensureV2BusinessNowInput } from '@/v2/runtime/businessClock';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2FinanceApi } from './api';
import type { useFinanceLedgerPage } from './useFinanceLedgerPage';
export function useFinanceExchanges(
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>
) {
  const filters = useV2SessionDraft('finance-ledger/useFinanceExchanges:filters', () =>
    reactive({
      currency: '',
      financeAccountId: '',
      status: '',
      dateFrom: '',
      dateTo: '',
      keyword: '',
      sort: 'newest'
    })
  );
  const currentPage = useV2SessionDraft('finance-ledger/useFinanceExchanges:currentPage', () =>
    ref(1)
  );
  const query = useV2ModuleQuery({
    moduleKey: 'finance-expenses',
    scope: 'finance-ledger',
    enabled: () => page.cashbookView === 'exchanges',
    key: () => createV2QueryKey({ ...filters, page: currentPage.value }),
    keepPreviousData: true,
    query: ({ signal }) =>
      idBusinessV2FinanceApi.listExchanges(
        {
          ...filters,
          currency: (filters.currency as V2FinanceCurrency) || undefined,
          status: (filters.status as 'posted' | 'reversed') || undefined,
          sort: filters.sort as 'newest' | 'oldest',
          page: currentPage.value,
          pageSize: 20
        },
        { signal }
      )
  });
  const accountQuery = useV2ModuleQuery({
    moduleKey: 'finance-expenses',
    scope: 'finance-accounts',
    enabled: () => page.cashbookView === 'exchanges' || page.exchangeDrawerVisible,
    key: 'exchange-active-accounts',
    query: ({ signal }) => idBusinessV2FinanceApi.listAccounts({ status: 'active' }, { signal })
  });
  const editing = ref<V2FinanceExchange | null>(null);
  const reasonDraft = useV2FormDraft('finance-exchange-correction-reason', () => ({ value: '' }));
  const submitting = ref(false),
    error = ref(''),
    reason = toRef(reasonDraft.form, 'value');
  const formDraft = useV2FormDraft('finance-exchange-editor', () => ({
    sourceAccountId: '',
    targetAccountId: '',
    sourceCurrency: 'CNY' as V2FinanceCurrency,
    targetCurrency: 'MYR' as V2FinanceCurrency,
    sourceAmount: '',
    targetAmount: '',
    feeMode: 'source_extra' as V2FinanceExchangeFeeMode,
    feeAmount: '0',
    occurredAt: '',
    channel: '',
    remark: '',
    sourceFxRateToCny: '',
    targetFxRateToCny: '',
    manualRateReason: '',
    idempotencyKey: ''
  }));
  const form = formDraft.form;
  const initial = ref('');
  const dirty = computed(() => JSON.stringify(form) !== initial.value || Boolean(reason.value));
  const calculation = computed(() => {
    try {
      return calculateFinanceExchange(form);
    } catch {
      return null;
    }
  });
  const feeCurrency = computed(() =>
    form.feeMode === 'source_extra' ? form.sourceCurrency : form.targetCurrency
  );
  const accounts = computed(() => {
    const items = [...(accountQuery.data.value?.items ?? page.accounts)].filter(
      (a) => a.status === 'active'
    );
    if (page.lastCreatedAccount && !items.some((a) => a.id === page.lastCreatedAccount?.id))
      items.unshift(page.lastCreatedAccount);
    return items;
  });
  const quickSide = ref<'source' | 'target' | null>(null);
  watch(
    () => page.lastCreatedAccount,
    (account) => {
      if (!account || !quickSide.value) return;
      form[`${quickSide.value}Currency`] = account.currency;
      form[`${quickSide.value}AccountId`] = account.id;
      quickSide.value = null;
    }
  );
  watch(
    () => page.exchangeDrawerVisible,
    (visible) => {
      if (visible && !form.idempotencyKey) void open();
    },
    { immediate: true }
  );
  function changeCurrency(side: 'source' | 'target') {
    form[`${side}AccountId`] = '';
    form[`${side}FxRateToCny`] = '';
  }
  function quickAccount(side: 'source' | 'target') {
    quickSide.value = side;
    page.openAccount();
    page.accountForm.currency = form[`${side}Currency`];
  }
  async function open(row?: V2FinanceExchange) {
    const now = row ? null : await ensureV2BusinessNowInput();
    if (!row && !now) {
      error.value = '无法读取服务器北京时间，请重试';
      return;
    }
    editing.value = row ?? null;
    reasonDraft.open(row?.id ?? 'create');
    error.value = '';
    formDraft.open(row?.id ?? 'create', {
      sourceAccountId: row?.sourceAccountId ?? '',
      targetAccountId: row?.targetAccountId ?? '',
      sourceCurrency: row?.sourceCurrency ?? 'CNY',
      targetCurrency: row?.targetCurrency ?? 'MYR',
      sourceAmount: row?.sourceAmount ?? '',
      targetAmount: row?.targetAmount ?? '',
      feeMode: row?.feeMode ?? 'source_extra',
      feeAmount: row?.feeAmount ?? '0',
      occurredAt: row ? toV2DateTimeInput(row.occurredAt) : (now ?? ''),
      channel: row?.channel ?? '',
      remark: row?.remark ?? '',
      sourceFxRateToCny: '',
      targetFxRateToCny: '',
      manualRateReason: '',
      idempotencyKey: crypto.randomUUID()
    });
    initial.value = JSON.stringify(form);
    page.exchangeDrawerVisible = true;
  }
  async function save() {
    if (
      !calculation.value ||
      !form.sourceAccountId ||
      !form.targetAccountId ||
      form.sourceCurrency === form.targetCurrency ||
      !form.occurredAt
    ) {
      error.value = '请填写两个不同币种的账户、换汇时间和有效金额';
      return;
    }
    if (editing.value && !reason.value.trim()) {
      error.value = '请填写更正原因';
      return;
    }
    submitting.value = true;
    const completeSave = () => formDraft.complete();
    const completeReason = () => reasonDraft.complete();
    error.value = '';
    try {
      const payload: V2FinanceExchangeWrite = {
        ...form,
        occurredAt: v2DateTimeInputToIso(form.occurredAt),
        sourceFxRateToCny: form.sourceFxRateToCny || undefined,
        targetFxRateToCny: form.targetFxRateToCny || undefined,
        manualRateReason: form.manualRateReason || undefined
      };
      if (editing.value)
        await idBusinessV2FinanceApi.correctExchange(editing.value.id, {
          ...payload,
          reason: reason.value.trim()
        });
      else await idBusinessV2FinanceApi.createExchange(payload);
      completeSave();
      completeReason();
      page.exchangeDrawerVisible = false;
      form.idempotencyKey = '';
      ElMessage.success('换汇已入账');
      await query.refresh();
      await page.refresh();
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      submitting.value = false;
    }
  }
  const reversalReasonDraft = useV2FormDraft('finance-exchange-reversal-reason', () => ({
    value: ''
  }));
  const reversing = ref<V2FinanceExchange | null>(null),
    reversalOpen = ref(false),
    reversalReason = toRef(reversalReasonDraft.form, 'value'),
    reversalKey = ref('');
  function openReverse(row: V2FinanceExchange) {
    reversing.value = row;
    reversalReasonDraft.open(row.id);
    reversalKey.value = crypto.randomUUID();
    error.value = '';
    reversalOpen.value = true;
  }
  async function reverse() {
    if (!reversing.value || !reversalReason.value.trim()) {
      error.value = '请填写冲销原因';
      return;
    }
    submitting.value = true;
    const completeReversalReasonSave = () => reversalReasonDraft.complete();
    error.value = '';
    try {
      await idBusinessV2FinanceApi.reverseExchange(reversing.value.id, {
        reason: reversalReason.value.trim(),
        idempotencyKey: reversalKey.value
      });
      completeReversalReasonSave();
      reversalOpen.value = false;
      ElMessage.success('换汇已按原金额、原汇率冲销');
      await query.refresh();
      await page.refresh();
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      submitting.value = false;
    }
  }
  function search() {
    currentPage.value = 1;
    void query.refresh();
  }
  function changePage(value: number) {
    currentPage.value = value;
    void query.ensureFresh();
  }
  return {
    filters,
    currentPage,
    query,
    accountQuery,
    editing,
    submitting,
    error,
    reason,
    form,
    dirty,
    calculation,
    feeCurrency,
    accounts,
    changeCurrency,
    quickAccount,
    open,
    save,
    reversalOpen,
    reversalReason,
    openReverse,
    reverse,
    search,
    changePage
  };
}
