import { computed, reactive, ref, watch } from 'vue';
import type { TagProps } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2LatestRequest } from '@/v2/composables/useV2LatestRequest';
import type { V2StatusStripItem } from '@/v2/components/V2StatusStrip.vue';
import { idBusinessV2ActivationsApi } from './api';
import type {
  V2Activation,
  V2ActivationDueStatus,
  V2ActivationListQuery,
  V2ActivationListResult
} from './contracts';

const dueStatusOptions: Array<{ value: V2ActivationDueStatus; label: string }> = [
  { value: 'due_within_1_hour', label: '1小时内到期' },
  { value: 'due_within_23_hours', label: '23小时内到期' },
  { value: 'due_within_7_days', label: '7天内到期' },
  { value: 'expired', label: '已到期' },
  { value: 'active', label: '正常' },
  { value: 'abnormal', label: '异常' },
  { value: 'cancelled', label: '已取消' }
];

export function useActivationsPage() {
  const dueRange = ref<[string, string] | []>([]);
  const detailVisible = ref(false);
  const detailLoading = ref(false);
  const detailError = ref('');
  const detail = ref<V2Activation | null>(null);
  const detailTarget = ref<V2Activation | null>(null);
  const detailRequest = useV2LatestRequest();
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    dueStatus: '' as V2ActivationDueStatus | '',
    sortBy: 'dueAt' as NonNullable<V2ActivationListQuery['sortBy']>,
    sortOrder: 'asc' as 'asc' | 'desc'
  });

  function getActivationListQuery(): V2ActivationListQuery {
    return {
      ...query,
      keyword: query.keyword.trim() || undefined,
      dueStatus: query.dueStatus || undefined,
      dueFrom: dueRange.value[0] || undefined,
      dueTo: dueRange.value[1] || undefined
    };
  }

  const activationQuery = useV2ModuleQuery<V2ActivationListResult>({
    moduleKey: 'activation-records',
    scope: 'activations',
    key: () => createV2QueryKey(getActivationListQuery()),
    keepPreviousData: true,
    getRevalidateAt: (result) => result.revalidateAt,
    query: ({ signal }) => idBusinessV2ActivationsApi.list(getActivationListQuery(), { signal })
  });
  const items = computed(() => activationQuery.data.value?.items ?? []);
  const total = computed(() => activationQuery.data.value?.total ?? 0);
  const displayedPage = computed(() => activationQuery.data.value?.page ?? query.page);
  const displayedPageSize = computed(() => activationQuery.data.value?.pageSize ?? query.pageSize);
  const loading = computed(
    () => activationQuery.isInitialLoading.value || activationQuery.isRefreshing.value
  );
  const listError = computed(() =>
    activationQuery.error.value ? getApiErrorMessage(activationQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = activationQuery;
  const activeFilterCount = computed(
    () =>
      [query.keyword.trim(), query.dueStatus, dueRange.value.length ? 'dueRange' : ''].filter(
        Boolean
      ).length
  );
  const activationStatusStripItems = computed<V2StatusStripItem[]>(() => {
    const visibleStatuses: V2ActivationDueStatus[] = [
      'due_within_1_hour',
      'due_within_23_hours',
      'due_within_7_days',
      'expired',
      'active'
    ];
    const tones: Partial<Record<V2ActivationDueStatus, V2StatusStripItem['tone']>> = {
      due_within_1_hour: 'danger',
      due_within_23_hours: 'warning',
      due_within_7_days: 'primary',
      expired: 'danger',
      active: 'success'
    };
    return visibleStatuses.map((status) => ({
      key: status,
      label:
        status === 'expired' || status === 'active'
          ? (dueStatusOptions.find((option) => option.value === status)?.label ?? status)
          : (dueStatusOptions.find((option) => option.value === status)?.label ?? status).replace(
              '到期',
              ''
            ),
      count: items.value.filter((item) => item.status.code === status).length,
      tone: tones[status]
    }));
  });

  async function loadActivations() {
    await activationQuery.refresh();
  }

  function loadCurrentActivations() {
    void activationQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentActivations();
  }

  function handleFilterChange() {
    query.page = 1;
    loadCurrentActivations();
  }

  function resetFilters() {
    Object.assign(query, {
      page: 1,
      keyword: '',
      dueStatus: ''
    });
    dueRange.value = [];
    loadCurrentActivations();
  }

  function selectDueStatus(key: string) {
    const dueStatus = key as V2ActivationDueStatus;
    query.dueStatus = query.dueStatus === dueStatus ? '' : dueStatus;
    handleFilterChange();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    loadCurrentActivations();
  }

  function handlePageChange(page: number) {
    query.page = page;
    loadCurrentActivations();
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported: Array<NonNullable<V2ActivationListQuery['sortBy']>> = [
      'openedAt',
      'dueAt',
      'status',
      'createdAt',
      'updatedAt'
    ];
    query.sortBy = supported.includes(sort.prop as NonNullable<V2ActivationListQuery['sortBy']>)
      ? (sort.prop as NonNullable<V2ActivationListQuery['sortBy']>)
      : 'dueAt';
    query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    loadCurrentActivations();
  }

  async function openDetail(item: V2Activation) {
    const switchingTarget = detailTarget.value?.id !== item.id;
    detailTarget.value = item;
    detailVisible.value = true;
    detailLoading.value = true;
    detailError.value = '';
    if (switchingTarget) detail.value = null;
    const request = detailRequest.begin();
    try {
      const result = await idBusinessV2ActivationsApi.get(item.id, { signal: request.signal });
      if (!request.isCurrent() || detailTarget.value?.id !== item.id) return;
      detail.value = result;
    } catch (error) {
      if (!request.isCurrent() || detailTarget.value?.id !== item.id) return;
      detailError.value = getApiErrorMessage(error);
    } finally {
      if (request.isCurrent() && detailTarget.value?.id === item.id) {
        detailLoading.value = false;
      }
      request.finish();
    }
  }

  function retryDetail() {
    if (detailTarget.value) void openDetail(detailTarget.value);
  }

  watch(detailVisible, (visible) => {
    if (visible) return;
    detailRequest.cancel();
    detailLoading.value = false;
    detailError.value = '';
    detail.value = null;
    detailTarget.value = null;
  });

  function statusType(status: V2ActivationDueStatus): TagProps['type'] {
    if (status === 'active') return 'success';
    if (status === 'due_within_7_days') return 'primary';
    if (status === 'due_within_23_hours' || status === 'due_within_1_hour') return 'warning';
    if (status === 'expired' || status === 'abnormal') return 'danger';
    return 'info';
  }

  function formatDate(value: string | null) {
    if (!value) return '—';
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

  function formatNullableDecimal(value: string | null) {
    if (value === null) return '—';
    const [integer, fraction = ''] = value.split('.');
    const trimmedFraction = fraction.replace(/0+$/, '');
    return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  }

  return {
    items,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: activationQuery.phase,
    isParameterTransition: activationQuery.isParameterTransition,
    loading,
    listError,
    hasLoadedOnce,
    isInitialLoading,
    activeFilterCount,
    activationStatusStripItems,
    dueStatusOptions,
    dueRange,
    detailVisible,
    detailLoading,
    detailError,
    detail,
    query,
    loadActivations,
    handleSearch,
    handleFilterChange,
    resetFilters,
    selectDueStatus,
    handlePageSizeChange,
    handlePageChange,
    handleSortChange,
    openDetail,
    retryDetail,
    statusType,
    formatDate,
    formatNullableDecimal
  };
}
