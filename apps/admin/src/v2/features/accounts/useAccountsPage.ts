import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2AccountsApi } from './api';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { parseCsv } from '@/v2/utils/csv';
import { V2_DECIMAL_PLACES } from '@/v2/utils/decimal';
import {
  calculateBalanceCost,
  calculateExchangeRate,
  emptyAccountForm,
  isNonNegativeDecimal,
  isNonNegativeExchangeRate,
  isZeroDecimal,
  normalizeDecimalInput,
  type AccountFormState
} from './account-form';
import { exportAccountRowsToCsv } from './account-export';
import { formatAccountDate, formatAccountDecimal } from './account-format';
import {
  countActiveAccountsFilters,
  normalizeAccountsListQuery,
  resetAccountsListFilters,
  useAccountsListQuery
} from './accounts-query';
import {
  downloadAccountImportTemplate,
  prepareAccountImport,
  type AccountImportFailure
} from './account-import';
import { useAccountLossReporting } from './useAccountLossReporting';
import { useAccountPermissions } from './useAccountPermissions';
import { useAccountPurchaseSources } from './useAccountPurchaseSources';
import { useAccountCreateOptions } from './useAccountCreateOptions';
import { useAccountRecordStatus } from './useAccountRecordStatus';
import { useAccountSaleRecovery } from './useAccountSaleRecovery';
import { useAccountSensitiveAccess } from './useAccountSensitiveAccess';
import type {
  CreateV2AccountInput,
  ImportV2AccountRowInput,
  UpdateV2AccountInput,
  V2Account,
  V2AccountLifecycle,
  V2AccountListQuery,
  V2AccountSecretField,
  V2OptionSelector,
  V2RecordStatus
} from './contracts';

export function useAccountsPage() {
  const items = ref<V2Account[]>([]);
  const total = ref(0);
  const countryOptions = ref<V2OptionSelector[]>([]);
  const statusOptions = ref<V2OptionSelector[]>([]);
  const supplierOptions = ref<V2OptionSelector[]>([]);
  const drawerVisible = ref(false);
  const saving = ref(false);
  const editingItem = ref<V2Account | null>(null);
  const exporting = ref(false);
  const importing = ref(false);
  const importDialogVisible = ref(false);
  const importFileInput = ref<HTMLInputElement | null>(null);
  const importFilename = ref('');
  const importRows = ref<ImportV2AccountRowInput[]>([]);
  const importFailures = ref<AccountImportFailure[]>([]);
  const importSourceRowCount = ref(0);
  const importCompleted = ref(false);
  const importSuccessCount = ref(0);
  const revealTarget = ref<V2Account | null>(null);
  const revealDialogVisible = ref(false);
  const revealing = ref(false);

  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    countryOptionId: '',
    statusOptionId: '',
    supplierOptionId: '',
    recordStatus: '' as V2RecordStatus | '',
    saleState: '' as 'available' | 'sold' | '',
    lifecycle: 'available' as V2AccountLifecycle,
    sortBy: 'updatedAt' as NonNullable<V2AccountListQuery['sortBy']>,
    sortOrder: 'desc' as 'asc' | 'desc'
  });
  const activeFilterCount = computed(() => countActiveAccountsFilters(query));
  const lifecycleLabel = computed(
    () =>
      ({
        available: '可用 ID',
        disabled: '已停用 ID',
        sold: '已售出 ID',
        reported: '已报损 ID'
      })[query.lifecycle]
  );

  const form = reactive<AccountFormState>(emptyAccountForm());
  const purchaseSourceState = useAccountPurchaseSources(form, editingItem);
  const refreshCreateOptions = useAccountCreateOptions({
    countryOptions,
    statusOptions,
    supplierOptions,
    drawerVisible,
    editingItem,
    form
  });
  const revealForm = reactive({
    field: '' as V2AccountSecretField | '',
    reason: '',
    value: ''
  });
  const accountSensitiveAccess = useAccountSensitiveAccess({
    revealTarget,
    revealing,
    revealForm
  });

  const accountPermissions = useAccountPermissions(revealTarget);
  const accountRecordStatus = useAccountRecordStatus({
    canUpdate: accountPermissions.canUpdate,
    refreshAccounts: loadAccounts
  });
  const accountSaleRecovery = useAccountSaleRecovery({
    canUpdate: accountPermissions.canUpdate,
    refreshAccounts: loadAccounts
  });
  const lossReporting = useAccountLossReporting({
    canReportLoss: accountPermissions.canReportLoss,
    refreshAccounts: loadAccounts
  });
  const formStatusOptions = computed(() =>
    [...statusOptions.value].sort((left, right) => {
      if (left.code === right.code) return 0;
      if (left.code === 'normal') return -1;
      if (right.code === 'normal') return 1;
      return 0;
    })
  );
  const balanceInputError = computed(() =>
    isNonNegativeDecimal(form.currentBalance)
      ? ''
      : `请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`
  );
  const exchangeRateInputError = computed(() =>
    isNonNegativeExchangeRate(form.exchangeRate)
      ? ''
      : `请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负汇率`
  );
  const balanceCostInputError = computed(() => {
    if (!isNonNegativeDecimal(form.balanceCostAmount)) {
      return `请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`;
    }
    if (isZeroDecimal(form.currentBalance) && !isZeroDecimal(form.balanceCostAmount)) {
      return '余额为 0 时人民币成本也必须为 0';
    }
    return '';
  });
  const balanceChanged = computed(() => {
    if (!editingItem.value) return false;
    return (
      normalizeDecimalInput(form.currentBalance) !==
        normalizeDecimalInput(editingItem.value.currentBalance) ||
      normalizeDecimalInput(form.balanceCostAmount) !==
        normalizeDecimalInput(editingItem.value.balanceCostAmount)
    );
  });
  const formDisabledReason = computed(() => {
    if (editingItem.value?.lossStatus === 'reported') return '已报损冻结 ID 不能编辑';
    if (!countryOptions.value.length) return '系统缺少国家选项';
    if (!formStatusOptions.value.length) return '系统缺少 ID 状态选项';
    return '';
  });

  const accountsQuery = useAccountsListQuery(() => normalizeAccountsListQuery(query));
  watch(
    accountsQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      items.value = snapshot.list.items;
      total.value = snapshot.list.total;
      countryOptions.value = snapshot.options.countries;
      statusOptions.value = snapshot.options.statuses;
      supplierOptions.value = snapshot.options.suppliers;
    },
    { immediate: true }
  );
  const loading = computed(
    () => accountsQuery.isInitialLoading.value || accountsQuery.isRefreshing.value
  );
  const displayedPage = computed(() => accountsQuery.data.value?.list.page ?? query.page);
  const displayedPageSize = computed(
    () => accountsQuery.data.value?.list.pageSize ?? query.pageSize
  );
  const listError = computed(() =>
    accountsQuery.error.value ? getApiErrorMessage(accountsQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = accountsQuery;

  async function loadAccounts() {
    await accountsQuery.refresh();
  }

  function loadCurrentAccounts() {
    void accountsQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentAccounts();
  }

  function resetFilters() {
    resetAccountsListFilters(query);
    loadCurrentAccounts();
  }

  function changeLifecycle(lifecycle: Exclude<V2AccountLifecycle, 'reported'>) {
    query.lifecycle = lifecycle;
    query.recordStatus = '';
    query.saleState = '';
    query.page = 1;
    loadCurrentAccounts();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    loadCurrentAccounts();
  }

  function handlePageChange(page: number) {
    query.page = page;
    loadCurrentAccounts();
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported = [
      'appleId',
      'currentBalance',
      'balanceCostAmount',
      'purchaseCost',
      'recordStatus',
      'createdAt',
      'updatedAt'
    ] as const;
    query.sortBy =
      sort.prop && supported.includes(sort.prop as (typeof supported)[number])
        ? (sort.prop as typeof query.sortBy)
        : 'updatedAt';
    query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    loadCurrentAccounts();
  }

  function downloadImportTemplate() {
    downloadAccountImportTemplate();
    ElMessage.success('ID 导入模板已导出');
  }

  function selectImportFile() {
    importFileInput.value?.click();
  }

  async function handleImportFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      ElMessage.error('请选择 CSV 文件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      ElMessage.error('CSV 文件不能超过 5MB');
      return;
    }

    try {
      prepareImportFile(file.name, parseCsv(await file.text()));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : 'CSV 文件读取失败');
    }
  }

  function prepareImportFile(filename: string, csvRows: string[][]) {
    const prepared = prepareAccountImport(csvRows, {
      countries: countryOptions.value,
      statuses: statusOptions.value,
      suppliers: supplierOptions.value
    });

    importFilename.value = filename;
    importSourceRowCount.value = prepared.sourceRowCount;
    importRows.value = prepared.rows;
    importFailures.value = prepared.failures;
    importCompleted.value = false;
    importSuccessCount.value = 0;
    importDialogVisible.value = true;
  }

  async function confirmImport() {
    if (!importRows.value.length) return;
    importing.value = true;
    try {
      const result = await idBusinessV2AccountsApi.importRows(importRows.value);
      importSuccessCount.value = result.successCount;
      importFailures.value = [...importFailures.value, ...result.failures];
      importRows.value = [];
      importCompleted.value = true;
      if (result.successCount) {
        await loadAccounts();
      }
      if (importFailures.value.length) {
        ElMessage.warning(
          `导入完成：成功 ${result.successCount} 条，失败 ${importFailures.value.length} 条`
        );
      } else {
        ElMessage.success(`成功导入 ${result.successCount} 条 ID 资料`);
      }
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      importing.value = false;
    }
  }

  async function exportAccounts() {
    exporting.value = true;
    try {
      const result = await idBusinessV2AccountsApi.exportRows({
        keyword: query.keyword.trim() || undefined,
        countryOptionId: query.countryOptionId || undefined,
        statusOptionId: query.statusOptionId || undefined,
        supplierOptionId: query.supplierOptionId || undefined,
        recordStatus: query.recordStatus || undefined,
        saleState: query.saleState || undefined,
        lifecycle: query.lifecycle,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder
      });
      if (!result.items.length) {
        ElMessage.warning('当前筛选条件下没有可导出的 ID 资料');
        return;
      }

      exportAccountRowsToCsv(result.items);
      ElMessage.success(`已导出 ${result.total} 条脱敏 ID 资料`);
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      exporting.value = false;
    }
  }

  function openCreate() {
    editingItem.value = null;
    const normalStatus = statusOptions.value.find((option) => option.code === 'normal');
    Object.assign(form, emptyAccountForm(), {
      countryOptionId: countryOptions.value[0]?.id ?? '',
      statusOptionId: normalStatus?.id ?? ''
    });
    if (!normalStatus) {
      ElMessage.error('系统缺少“正常”ID 状态，请先在选项设置中恢复');
    }
    drawerVisible.value = true;
    void purchaseSourceState.loadPurchaseSources();
    void refreshCreateOptions();
  }

  function handleToolbarCommand(command: string) {
    if (command === 'template') {
      downloadImportTemplate();
      return;
    }
    if (command === 'import') {
      selectImportFile();
      return;
    }
    if (command === 'export') {
      void exportAccounts();
    }
  }

  function openEdit(item: V2Account) {
    if (accountsQuery.isParameterTransition.value) return;
    if (item.lossStatus === 'reported') {
      ElMessage.warning('已报损冻结 ID 不能编辑');
      return;
    }
    editingItem.value = item;
    Object.assign(form, {
      appleId: '',
      password: '',
      phone: '',
      securityInfo: '',
      countryOptionId: item.countryOptionId,
      statusOptionId: item.statusOptionId,
      supplierOptionId: item.supplierOptionId ?? '',
      currentBalance: item.currentBalance,
      exchangeRate: calculateExchangeRate(item.currentBalance, item.balanceCostAmount) ?? '0',
      balanceCostAmount: item.balanceCostAmount,
      balanceAdjustmentReason: '',
      purchaseCost: Number(item.purchaseCost),
      purchaseOriginalAmount: item.purchaseOriginalAmount,
      purchaseCurrency: item.purchaseCurrency,
      purchaseFxRateToCny: item.purchaseFxRateToCny,
      purchaseSourceId: item.purchaseFinanceAccountId
        ? `account:${item.purchaseFinanceAccountId}`
        : item.purchaseSupplierAccountId
          ? `wallet:${item.purchaseSupplierAccountId}`
          : '',
      purchaseManualRateReason: '',
      purchasedAt: item.purchasedAt,
      remark: item.remark ?? ''
    });
    drawerVisible.value = true;
  }

  function updateBalanceCostFromRate() {
    const balanceCostAmount = calculateBalanceCost(form.currentBalance, form.exchangeRate);
    if (balanceCostAmount !== null) {
      form.balanceCostAmount = balanceCostAmount;
    }
  }

  function getAccountExchangeRate(item: V2Account) {
    if (isZeroDecimal(item.currentBalance)) return '-';
    return calculateExchangeRate(item.currentBalance, item.balanceCostAmount) ?? '-';
  }

  async function submitForm() {
    if (formDisabledReason.value || purchaseSourceState.purchaseEvidenceError.value) return;
    const commonPayload = {
      countryOptionId: form.countryOptionId,
      statusOptionId: form.statusOptionId,
      supplierOptionId: form.supplierOptionId || null,
      remark: form.remark.trim() || null
    };

    saving.value = true;
    try {
      if (editingItem.value) {
        const payload: UpdateV2AccountInput = {
          ...commonPayload,
          purchaseCost: form.purchaseCost
        };
        if (form.appleId.trim()) payload.appleId = form.appleId.trim();
        if (form.password.trim()) payload.password = form.password.trim();
        if (form.phone.trim()) payload.phone = form.phone.trim();
        if (form.securityInfo.trim()) payload.securityInfo = form.securityInfo.trim();
        if (balanceChanged.value) {
          payload.currentBalance = normalizeDecimalInput(form.currentBalance);
          payload.balanceCostAmount = normalizeDecimalInput(form.balanceCostAmount);
          payload.expectedCurrentBalance = editingItem.value.currentBalance;
          payload.expectedBalanceCostAmount = editingItem.value.balanceCostAmount;
          payload.balanceAdjustmentReason = form.balanceAdjustmentReason.trim();
          payload.balanceAdjustmentIdempotencyKey = `account-adjustment-${globalThis.crypto.randomUUID()}`;
        }
        await idBusinessV2AccountsApi.update(editingItem.value.id, payload);
        ElMessage.success('ID 资料已更新');
      } else {
        const [purchaseSourceType, purchaseSourceId] = form.purchaseSourceId.split(':', 2);
        if (purchaseSourceType !== 'account' || !purchaseSourceId) {
          ElMessage.warning('请选择与采购币种一致的付款账户');
          return;
        }
        const payload: CreateV2AccountInput = {
          ...commonPayload,
          appleId: form.appleId.trim(),
          password: form.password.trim() || null,
          phone: form.phone.trim() || null,
          securityInfo: form.securityInfo.trim() || null,
          currentBalance: normalizeDecimalInput(form.currentBalance),
          balanceCostAmount: normalizeDecimalInput(form.balanceCostAmount),
          purchaseOriginalAmount: normalizeDecimalInput(form.purchaseOriginalAmount),
          purchaseCurrency: form.purchaseCurrency,
          purchaseFxRateToCny: form.purchaseFxRateToCny || undefined,
          purchaseFinanceAccountId: purchaseSourceId,
          purchaseManualRateReason: form.purchaseManualRateReason.trim() || undefined,
          purchasedAt: new Date(form.purchasedAt).toISOString()
        };
        await idBusinessV2AccountsApi.create(payload);
        ElMessage.success('ID 资料已新增');
      }
      drawerVisible.value = false;
      void loadAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      saving.value = false;
    }
  }

  function openReveal(item: V2Account, field: V2AccountSecretField) {
    if (accountsQuery.isParameterTransition.value) return;
    revealTarget.value = item;
    Object.assign(revealForm, {
      field,
      reason: '',
      value: ''
    });
    revealDialogVisible.value = true;
    void accountSensitiveAccess.prepareSensitiveAccess(field);
  }

  function openSensitiveAccess(item: V2Account) {
    if (accountsQuery.isParameterTransition.value) return;
    const field: V2AccountSecretField =
      item.hasPassword && accountPermissions.canRevealPassword.value
        ? 'password'
        : item.hasPhone && accountPermissions.canRevealPhone.value
          ? 'phone'
          : item.hasSecurityInfo && accountPermissions.canRevealSecurity.value
            ? 'securityInfo'
            : 'appleId';
    openReveal(item, field);
  }

  return {
    items,
    total,
    loading,
    listError,
    countryOptions,
    statusOptions,
    supplierOptions,
    ...purchaseSourceState,
    drawerVisible,
    saving,
    editingItem,
    exporting,
    importing,
    importDialogVisible,
    importFileInput,
    importFilename,
    importRows,
    importFailures,
    importSourceRowCount,
    importCompleted,
    importSuccessCount,
    revealTarget,
    revealDialogVisible,
    revealing,
    ...lossReporting,
    query,
    displayedPage,
    displayedPageSize,
    queryPhase: accountsQuery.phase,
    isParameterTransition: accountsQuery.isParameterTransition,
    form,
    revealForm,
    ...accountSensitiveAccess,
    ...accountPermissions,
    ...accountRecordStatus,
    ...accountSaleRecovery,
    activeFilterCount,
    lifecycleLabel,
    formStatusOptions,
    balanceInputError,
    exchangeRateInputError,
    balanceCostInputError,
    balanceChanged,
    formDisabledReason,
    loadAccounts,
    handleSearch,
    resetFilters,
    changeLifecycle,
    handleFilterChange: handleSearch,
    handlePageSizeChange,
    handlePageChange,
    handleSortChange,
    handleImportFile,
    confirmImport,
    handleToolbarCommand,
    openCreate,
    openEdit,
    updateBalanceCostFromRate,
    getAccountExchangeRate,
    submitForm,
    openReveal,
    openSensitiveAccess,
    openRecordStatusChange: (item: V2Account) => {
      if (!accountsQuery.isParameterTransition.value) {
        accountRecordStatus.openRecordStatusChange(item);
      }
    },
    openReportLoss: (item: V2Account) => {
      if (!accountsQuery.isParameterTransition.value) lossReporting.openReportLoss(item);
    },
    openUnfreezeLoss: (item: V2Account) => {
      if (!accountsQuery.isParameterTransition.value) lossReporting.openUnfreezeLoss(item);
    },
    formatDecimal: formatAccountDecimal,
    formatDate: formatAccountDate,
    hasLoadedOnce,
    isInitialLoading
  };
}
