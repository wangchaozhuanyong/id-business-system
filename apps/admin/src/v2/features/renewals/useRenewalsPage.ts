import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import type { V2StatusStripItem } from '@/v2/components/V2StatusStrip.vue';
import { calculateOneMonthInclusiveDueAt } from '@/v2/utils/subscriptionPeriod';
import { idBusinessV2RenewalsApi } from './api';
import type {
  V2ManualRenewalOptions,
  V2RenewalDueStatus,
  V2RenewalFilterOptions,
  V2RenewalStatusCode,
  V2RenewalWorkbenchItem,
  V2RenewalWorkbenchQuery,
  V2RenewalWorkbenchResult
} from './contracts';
import { useRenewalWarningSettings } from './useRenewalWarningSettings';

const dueStatusOptions: Array<{ value: V2RenewalDueStatus; label: string }> = [
  { value: 'due_within_1_hour', label: '1小时内到期' },
  { value: 'due_within_23_hours', label: '23小时内到期' },
  { value: 'due_within_7_days', label: '7天内到期' },
  { value: 'expired', label: '已到期' }
];

function isValidNonNegativeDecimal(value: string, scale: number) {
  return new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`).test(value.trim());
}

function isValidPositiveDecimal(value: string, scale: number) {
  return isValidNonNegativeDecimal(value, scale) && Number(value) > 0;
}

interface RenewalsReferenceOptions {
  filters: V2RenewalFilterOptions;
  manualRenewal: V2ManualRenewalOptions | null;
}

interface RenewalsPageSnapshot {
  list: V2RenewalWorkbenchResult;
  options: RenewalsReferenceOptions;
}

const RENEWALS_OPTIONS_SCOPE = 'renewals-options';
const RENEWALS_OPTIONS_KEY = 'selectors';
const RENEWAL_WARNING_REFRESH_EVENT = 'v2:renewal-warning-refresh';
const EMPTY_FILTER_OPTIONS: V2RenewalFilterOptions = {
  customers: [],
  accounts: [],
  services: []
};
const EMPTY_MANUAL_RENEWAL_OPTIONS: V2ManualRenewalOptions = {
  settlementPlatforms: [],
  services: []
};

export function useRenewalsPage() {
  const authStore = useAuthStore();
  const canRenew = computed(
    () =>
      hasUserPermission(authStore.user, 'apple.renewal_task.update') &&
      hasUserPermission(authStore.user, 'apple.order.create')
  );
  const dueRange = ref<[string, string] | []>([]);
  const warningOnly = ref(false);
  const refreshedManualOptions = ref<V2ManualRenewalOptions | null>(null);
  const optionsLoading = ref(false);
  const optionsError = ref('');
  const drawerVisible = ref(false);
  const confirmationVisible = ref(false);
  const submitting = ref(false);
  const selectedRenewal = ref<V2RenewalWorkbenchItem | null>(null);
  const idempotencyKey = ref('');
  const form = reactive({
    serviceOptionId: '',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    receivedAmount: '',
    balanceAmount: '',
    openedAt: null as Date | null,
    dueAt: null as Date | null,
    remark: ''
  });
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    customerId: '',
    serviceOptionId: '',
    accountId: '',
    dueStatus: '' as V2RenewalDueStatus | '',
    sortBy: 'dueAt' as NonNullable<V2RenewalWorkbenchQuery['sortBy']>,
    sortOrder: 'asc' as 'asc' | 'desc'
  });

  function getRenewalsListQuery(): V2RenewalWorkbenchQuery {
    return {
      ...query,
      keyword: query.keyword.trim() || undefined,
      customerId: query.customerId || undefined,
      serviceOptionId: query.serviceOptionId || undefined,
      accountId: query.accountId || undefined,
      dueStatus: query.dueStatus || undefined,
      dueFrom: dueRange.value[0] || undefined,
      dueTo: dueRange.value[1] || undefined,
      warningOnly: warningOnly.value || undefined
    };
  }

  const renewalsQuery = useV2ModuleQuery<RenewalsPageSnapshot>({
    moduleKey: 'renewal-workbench',
    scope: 'renewals',
    key: () => createV2QueryKey(getRenewalsListQuery()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getRenewalsListQuery();
      const cachedOptions = getV2QueryData<RenewalsReferenceOptions>(
        RENEWALS_OPTIONS_SCOPE,
        RENEWALS_OPTIONS_KEY,
        { tier: 'reference' }
      );
      if (cachedOptions) {
        return {
          list: await idBusinessV2RenewalsApi.listWorkbench(params, { signal }),
          options: cachedOptions
        };
      }

      const result = await idBusinessV2RenewalsApi.bootstrapWorkbench(params, { signal });
      primeV2Query({
        scope: RENEWALS_OPTIONS_SCOPE,
        key: RENEWALS_OPTIONS_KEY,
        data: result.options
      });
      return {
        list: result.list,
        options: result.options
      };
    }
  });
  const {
    canManageWarning,
    warningSettings,
    warningSettingsVisible,
    warningSettingsLoading,
    warningSettingsSaving,
    warningSettingsError,
    warningDaysInput,
    openWarningSettings,
    saveWarningSettings
  } = useRenewalWarningSettings({
    onSaved: async () => {
      warningOnly.value = false;
      query.dueStatus = '';
      dueRange.value = [];
      query.page = 1;
      await renewalsQuery.refresh();
    }
  });

  const items = computed(() => renewalsQuery.data.value?.list.items ?? []);
  const total = computed(() => renewalsQuery.data.value?.list.total ?? 0);
  const evaluatedAt = computed(() => renewalsQuery.data.value?.list.evaluatedAt ?? '');
  const warningSummary = computed(
    () =>
      renewalsQuery.data.value?.list.warningSummary ?? {
        warningDays: warningSettings.warningDays,
        upcomingCount: 0,
        expiredCount: 0,
        totalCount: 0
      }
  );
  const warningDays = computed(() => warningSummary.value.warningDays);
  const filterOptions = computed(
    () => renewalsQuery.data.value?.options.filters ?? EMPTY_FILTER_OPTIONS
  );
  const options = computed(
    () =>
      refreshedManualOptions.value ??
      renewalsQuery.data.value?.options.manualRenewal ??
      EMPTY_MANUAL_RENEWAL_OPTIONS
  );
  const loading = computed(
    () => renewalsQuery.isInitialLoading.value || renewalsQuery.isRefreshing.value
  );
  const listError = computed(() =>
    renewalsQuery.error.value ? getApiErrorMessage(renewalsQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = renewalsQuery;
  watch(renewalsQuery.refreshedAt, (current, previous) => {
    if (current && previous && current !== previous) refreshedManualOptions.value = null;
  });

  const availableServices = computed(() => {
    const countryId = selectedRenewal.value?.account.country.id;
    if (!countryId) return [];
    return options.value.services.filter((service) => service.country?.id === countryId);
  });
  const selectedManualService = computed(
    () => availableServices.value.find((service) => service.id === form.serviceOptionId) ?? null
  );
  const selectedPlatform = computed(
    () =>
      options.value.settlementPlatforms.find(
        (platform) => platform.id === form.settlementPlatformOptionId
      ) ?? null
  );
  const platformFeePreview = computed(() => {
    const receivedAmount = Number(form.receivedAmount);
    const platform = selectedPlatform.value;
    if (!platform || !Number.isFinite(receivedAmount) || receivedAmount < 0) return '0.0000';
    return (
      Number(platform.fixedFee) +
      (receivedAmount * Number(platform.percentageFee)) / 100
    ).toFixed(4);
  });
  const balanceAfterPreview = computed(() => {
    const currentBalance = Number(selectedRenewal.value?.account.currentBalance ?? '');
    const balanceAmount = Number(form.balanceAmount);
    if (!Number.isFinite(currentBalance) || !Number.isFinite(balanceAmount)) return '0.0000';
    return (currentBalance - balanceAmount).toFixed(4);
  });
  const canSubmitRenewal = computed(() => {
    const renewal = selectedRenewal.value;
    if (
      !renewal ||
      !renewal.withinActionWindow ||
      !form.serviceOptionId ||
      !form.openedAt ||
      !form.dueAt ||
      optionsLoading.value ||
      Boolean(optionsError.value) ||
      submitting.value
    ) {
      return false;
    }
    const sourceDueAt = renewal.dueAt ? new Date(renewal.dueAt) : null;
    const balanceAmount = Number(form.balanceAmount);
    const currentBalance = Number(renewal.account.currentBalance);
    return (
      availableServices.value.some((service) => service.id === form.serviceOptionId) &&
      isValidNonNegativeDecimal(form.receivedAmount, 4) &&
      isValidPositiveDecimal(form.balanceAmount, 4) &&
      Number.isFinite(balanceAmount) &&
      Number.isFinite(currentBalance) &&
      balanceAmount <= currentBalance &&
      (!form.platformOrderNo.trim() || Boolean(form.settlementPlatformOptionId)) &&
      (!sourceDueAt || form.openedAt.getTime() >= sourceDueAt.getTime()) &&
      form.dueAt.getTime() > form.openedAt.getTime() &&
      form.dueAt.getTime() > Date.now()
    );
  });
  const renewalStatusStripItems = computed<V2StatusStripItem[]>(() => {
    return [
      {
        key: 'warning',
        label: `未来 ${warningDays.value} 天预警`,
        count: warningSummary.value.upcomingCount,
        tone: 'warning'
      },
      {
        key: 'expired',
        label: '已到期',
        count: warningSummary.value.expiredCount,
        tone: 'danger'
      }
    ];
  });
  const activeWarningScope = computed(() => {
    if (warningOnly.value) return 'warning';
    if (query.dueStatus === 'expired') return 'expired';
    return '';
  });
  const emptyDescription = computed(() => {
    if (dueRange.value.length) return '当前设定的到期日期范围内没有数据';
    if (warningOnly.value) return `当前没有未来 ${warningDays.value} 天内到期的开通记录`;
    if (query.dueStatus) {
      return `当前没有“${
        dueStatusOptions.find((option) => option.value === query.dueStatus)?.label ?? '所选状态'
      }”记录`;
    }
    return `当前没有未来 ${warningDays.value} 天内到期或已经到期的开通记录`;
  });
  const confirmationMessage = computed(() => {
    const renewal = selectedRenewal.value;
    const service = availableServices.value.find((item) => item.id === form.serviceOptionId);
    if (!renewal || !service || !form.openedAt || !form.dueAt) return '';
    return `确认给客户“${renewal.customer.name}”的 ${renewal.account.appleIdMasked} 续费“${
      service.name
    }”，立即扣减系统 ID 余额 ${form.balanceAmount}，余额将变为 ${
      balanceAfterPreview.value
    }，并生成已完成订单和续费记录。`;
  });

  async function loadManualRenewalOptions() {
    optionsLoading.value = true;
    optionsError.value = '';
    try {
      const result = await idBusinessV2RenewalsApi.listManualRenewalOptions();
      refreshedManualOptions.value = result;
      const cachedOptions = getV2QueryData<RenewalsReferenceOptions>(
        RENEWALS_OPTIONS_SCOPE,
        RENEWALS_OPTIONS_KEY,
        { tier: 'reference' }
      );
      if (cachedOptions) {
        primeV2Query({
          scope: RENEWALS_OPTIONS_SCOPE,
          key: RENEWALS_OPTIONS_KEY,
          data: {
            ...cachedOptions,
            manualRenewal: result
          }
        });
      }
      if (drawerVisible.value && !form.balanceAmount) {
        applySelectedServiceAmount();
      }
    } catch (error) {
      optionsError.value = getApiErrorMessage(error);
    } finally {
      optionsLoading.value = false;
    }
  }

  async function loadWorkbench() {
    await renewalsQuery.refresh();
  }

  function loadCurrentWorkbench() {
    void renewalsQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handleFilterChange() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handleTimeFilterChange() {
    warningOnly.value = false;
    handleFilterChange();
  }

  function selectWarningScope(key: string) {
    dueRange.value = [];
    if (key === 'warning') {
      const shouldEnable = !warningOnly.value;
      warningOnly.value = shouldEnable;
      query.dueStatus = '';
    } else if (key === 'expired') {
      const shouldClear = !warningOnly.value && query.dueStatus === 'expired';
      warningOnly.value = false;
      query.dueStatus = shouldClear ? '' : 'expired';
    }
    handleFilterChange();
  }

  function handlePageSizeChange() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handlePageChange() {
    loadCurrentWorkbench();
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported: Array<NonNullable<V2RenewalWorkbenchQuery['sortBy']>> = [
      'customer',
      'account',
      'currentBalance',
      'service',
      'openedAt',
      'dueAt'
    ];
    query.sortBy = supported.includes(sort.prop as NonNullable<V2RenewalWorkbenchQuery['sortBy']>)
      ? (sort.prop as NonNullable<V2RenewalWorkbenchQuery['sortBy']>)
      : 'dueAt';
    query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    loadCurrentWorkbench();
  }

  function openRenewalDrawer(renewal: V2RenewalWorkbenchItem) {
    if (!canRenew.value || !renewal.withinActionWindow) return;
    const now = new Date();
    now.setSeconds(0, 0);
    const sourceDueAt = renewal.dueAt ? new Date(renewal.dueAt) : now;
    const openedAt = new Date(Math.max(now.getTime(), sourceDueAt.getTime()));

    selectedRenewal.value = renewal;
    idempotencyKey.value = globalThis.crypto.randomUUID();
    Object.assign(form, {
      serviceOptionId: renewal.service.id,
      settlementPlatformOptionId: '',
      platformOrderNo: '',
      receivedAmount: '',
      balanceAmount: '',
      openedAt,
      dueAt: calculateOneMonthInclusiveDueAt(openedAt),
      remark: ''
    });
    applySelectedServiceAmount();
    drawerVisible.value = true;
    confirmationVisible.value = false;
    if (!options.value.services.length || optionsError.value) void loadManualRenewalOptions();
  }

  function renewalActionDisabledReason(renewal: V2RenewalWorkbenchItem) {
    if (!renewal.withinActionWindow) return '可查看任意日期，但仅支持为 7 天内到期或已到期记录续费';
    return '';
  }

  function renewalRowClassName({ row }: { row: V2RenewalWorkbenchItem }) {
    if (row.warningState === 'expired') return 'is-renewal-expired';
    if (row.warningState === 'upcoming') return 'is-renewal-warning';
    return '';
  }

  function handleRenewalOpenedAtChange(openedAt: Date | null) {
    form.dueAt = openedAt ? calculateOneMonthInclusiveDueAt(openedAt) : null;
  }

  function handleSettlementPlatformChange() {
    if (!form.settlementPlatformOptionId) form.platformOrderNo = '';
  }

  function applySelectedServiceAmount() {
    const amount = selectedManualService.value?.businessAmount ?? '';
    form.balanceAmount = isValidPositiveDecimal(amount, 4) ? amount : '';
  }

  function openConfirmation() {
    if (!canSubmitRenewal.value) {
      ElMessage.warning('请核对续费业务、金额、ID余额和续费周期');
      return;
    }
    confirmationVisible.value = true;
  }

  async function submitRenewal() {
    const renewal = selectedRenewal.value;
    if (!renewal || !form.openedAt || !form.dueAt || !canSubmitRenewal.value || submitting.value) {
      return;
    }
    submitting.value = true;
    try {
      const result = await idBusinessV2RenewalsApi.createManualRenewal(renewal.id, {
        serviceOptionId: form.serviceOptionId,
        settlementPlatformOptionId: form.settlementPlatformOptionId || null,
        platformOrderNo: form.platformOrderNo.trim() || null,
        receivedAmount: form.receivedAmount.trim(),
        balanceAmount: form.balanceAmount.trim(),
        openedAt: form.openedAt.toISOString(),
        dueAt: form.dueAt.toISOString(),
        idempotencyKey: idempotencyKey.value,
        remark: form.remark.trim() || null
      });
      ElMessage.success(
        result.idempotentReplay
          ? `续费订单 ${result.order.orderNo} 已处理，未重复扣款`
          : `续费完成，ID 余额 ${formatDecimal(result.balance.before)} → ${formatDecimal(
              result.balance.after
            )}`
      );
      confirmationVisible.value = false;
      drawerVisible.value = false;
      await loadWorkbench();
      window.dispatchEvent(new Event(RENEWAL_WARNING_REFRESH_EVENT));
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      submitting.value = false;
    }
  }

  function serviceLabel(service: V2RenewalFilterOptions['services'][number]) {
    return service.parent ? `${service.parent.name} / ${service.name}` : service.name;
  }

  watch(
    () => form.serviceOptionId,
    () => applySelectedServiceAmount()
  );

  function formatDecimal(value: string | number | null | undefined) {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed)) return '-';
    return parsed.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    });
  }

  function formatDate(value: string | null) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
  }

  function formatTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  }

  function statusType(status: V2RenewalStatusCode) {
    if (status === 'expired' || status === 'due_within_1_hour') return 'danger';
    if (status === 'due_within_23_hours') return 'warning';
    return 'info';
  }

  return {
    dueStatusOptions,
    canRenew,
    canManageWarning,
    items,
    total,
    evaluatedAt,
    loading,
    listError,
    dueRange,
    warningSettings,
    warningSettingsVisible,
    warningSettingsLoading,
    warningSettingsSaving,
    warningSettingsError,
    warningDaysInput,
    filterOptions,
    options,
    optionsLoading,
    optionsError,
    drawerVisible,
    confirmationVisible,
    submitting,
    selectedRenewal,
    form,
    query,
    availableServices,
    selectedManualService,
    platformFeePreview,
    balanceAfterPreview,
    canSubmitRenewal,
    renewalStatusStripItems,
    activeWarningScope,
    emptyDescription,
    confirmationMessage,
    hasLoadedOnce,
    isInitialLoading,
    loadWorkbench,
    handleSearch,
    handleFilterChange,
    handleTimeFilterChange,
    selectWarningScope,
    handlePageSizeChange,
    handlePageChange,
    handleSortChange,
    openRenewalDrawer,
    renewalActionDisabledReason,
    renewalRowClassName,
    openWarningSettings,
    saveWarningSettings,
    handleRenewalOpenedAtChange,
    handleSettlementPlatformChange,
    openConfirmation,
    submitRenewal,
    serviceLabel,
    formatDecimal,
    formatDate,
    formatTime,
    statusType
  };
}
