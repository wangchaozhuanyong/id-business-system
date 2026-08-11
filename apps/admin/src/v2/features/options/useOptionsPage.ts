import { computed, markRaw, reactive, ref, watch, type Component } from 'vue';
import { useRoute } from 'vue-router';
import {
  Box,
  CircleCheck,
  CreditCard,
  Files,
  Location,
  PriceTag,
  Tickets,
  User,
  Wallet
} from '@element-plus/icons-vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, getV2QueryData, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2Decimal } from '@/v2/utils/decimal';
import { idBusinessV2OptionsApi } from './api';
import { resolveCountryCurrencyAutoMatch } from './countryCurrency';
import type {
  CreateV2OptionInput,
  V2Option,
  V2OptionSelector,
  V2OptionStatus,
  V2OptionType,
  V2OptionTypeDefinition,
  V2OptionTypesResult
} from './contracts';

interface OptionsPageSnapshot {
  list: {
    items: V2Option[];
    total: number;
  };
  types: V2OptionTypesResult;
}

const OPTIONS_TYPES_SCOPE = 'options-reference';
const OPTIONS_TYPES_KEY = 'types';

export function useOptionsPage() {
  const route = useRoute();
  interface OptionFormState {
    type: V2OptionType;
    name: string;
    parentId: string;
    countryOptionId: string;
    businessAmount: number;
    currencyCode: string;
    fixedFee: number;
    percentageFee: number;
    sortOrder: number;
    active: boolean;
    remark: string;
  }

  const typeDefinitions = ref<V2OptionTypeDefinition[]>([]);
  const optionTypeIcons: Record<V2OptionType, Component> = {
    id_status: markRaw(CircleCheck),
    customer_source: markRaw(User),
    customer_tag: markRaw(PriceTag),
    country: markRaw(Location),
    business_category: markRaw(Files),
    service: markRaw(Tickets),
    id_supplier: markRaw(Box),
    topup_supplier: markRaw(Wallet),
    gift_card_name: markRaw(CreditCard),
    settlement_platform: markRaw(CreditCard),
    expense_category: markRaw(Wallet)
  };
  const requestedType =
    typeof route.query.type === 'string' ? (route.query.type as V2OptionType) : 'id_status';
  const selectedType = ref<V2OptionType>(requestedType);
  const renderedType = ref<V2OptionType>(requestedType);
  const items = ref<V2Option[]>([]);
  const total = ref(0);
  const drawerVisible = ref(false);
  const saving = ref(false);
  const editingItem = ref<V2Option | null>(null);
  const parentOptions = ref<V2OptionSelector[]>([]);
  const parentOptionsLoading = ref(false);
  const countryOptions = ref<V2OptionSelector[]>([]);
  const countryOptionsLoading = ref(false);
  const deleteDialogVisible = ref(false);
  const deleting = ref(false);
  const deletingItem = ref<V2Option | null>(null);
  let forceNextListRequest = false;

  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: '' as V2OptionStatus | '',
    sortBy: 'sortOrder' as 'name' | 'sortOrder' | 'status' | 'createdAt' | 'updatedAt',
    sortOrder: 'asc' as 'asc' | 'desc'
  });
  const renderedQuery = ref(snapshotQuery());
  const listResolved = ref(false);

  const form = reactive<OptionFormState>(createEmptyForm());
  const currencyOptions = [
    'USD',
    'CNY',
    'JPY',
    'HKD',
    'SGD',
    'MYR',
    'PHP',
    'EUR',
    'GBP',
    'CAD',
    'AUD',
    'KRW',
    'TWD',
    'THB'
  ] as const;
  let autoMatchedCountryCurrencyCode = '';

  watch(
    () => [form.type, form.name] as const,
    ([type, name]) => {
      if (type !== 'country' || editingItem.value) {
        autoMatchedCountryCurrencyCode = '';
        return;
      }
      const match = resolveCountryCurrencyAutoMatch(
        name,
        form.currencyCode,
        autoMatchedCountryCurrencyCode
      );
      form.currencyCode = match.currencyCode;
      autoMatchedCountryCurrencyCode = match.autoMatchedCurrencyCode;
    }
  );

  const activeTypeDefinition = computed(() =>
    typeDefinitions.value.find((item) => item.type === renderedType.value)
  );
  const selectedTypeDefinition = computed(() =>
    typeDefinitions.value.find((item) => item.type === selectedType.value)
  );
  const formTypeDefinition = computed(() =>
    typeDefinitions.value.find((item) => item.type === form.type)
  );
  const parentTypeLabel = computed(
    () =>
      typeDefinitions.value.find((item) => item.type === formTypeDefinition.value?.parentType)
        ?.label ?? '上级选项'
  );
  const selectedServiceCurrency = computed(
    () =>
      countryOptions.value.find((option) => option.id === form.countryOptionId)?.currencyCode ??
      '选择国家后自动带入'
  );
  const activeFilterCount = computed(
    () => Number(Boolean(query.keyword.trim())) + Number(Boolean(query.status))
  );
  const submitDisabledReason = computed(() => {
    if (parentOptionsLoading.value || countryOptionsLoading.value) {
      return '正在加载关联业务选项';
    }
    if (formTypeDefinition.value?.parentType && !parentOptions.value.length) {
      return `暂无可用${parentTypeLabel.value}`;
    }
    if (formTypeDefinition.value?.requiresCountry && !countryOptions.value.length) {
      return '暂无已配置货币的国家选项';
    }
    return '';
  });

  function createEmptyForm(): OptionFormState {
    return {
      type: selectedType.value,
      name: '',
      parentId: '',
      countryOptionId: '',
      businessAmount: 0,
      currencyCode: '',
      fixedFee: 0,
      percentageFee: 0,
      sortOrder: 0,
      active: true,
      remark: ''
    };
  }

  function getListRequest() {
    const requestedQuery = snapshotQuery();
    return {
      page: requestedQuery.page,
      pageSize: requestedQuery.pageSize,
      keyword: requestedQuery.keyword.trim() || undefined,
      type: selectedType.value,
      status: requestedQuery.status,
      sortBy: requestedQuery.sortBy,
      sortOrder: requestedQuery.sortOrder
    };
  }

  const optionsQuery = useV2ModuleQuery<OptionsPageSnapshot>({
    moduleKey: 'options',
    scope: 'options-page',
    key: () => createV2QueryKey(getListRequest()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getListRequest();
      const force = forceNextListRequest;
      forceNextListRequest = false;
      const cachedTypes = getV2QueryData<V2OptionTypesResult>(
        OPTIONS_TYPES_SCOPE,
        OPTIONS_TYPES_KEY,
        {}
      );
      if (!cachedTypes) {
        const result = await idBusinessV2OptionsApi.bootstrap(params, { signal });
        return { list: result.list, types: result.types };
      }
      return {
        list: await idBusinessV2OptionsApi.list(params, { force }),
        types: cachedTypes
      };
    }
  });
  watch(
    optionsQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      typeDefinitions.value = snapshot.types.items;
      if (!snapshot.types.items.some((item) => item.type === selectedType.value)) {
        selectedType.value = snapshot.types.items[0]?.type ?? 'id_status';
        void optionsQuery.ensureFresh();
        return;
      }
      items.value = snapshot.list.items;
      total.value = snapshot.list.total;
      renderedType.value = selectedType.value;
      renderedQuery.value = snapshotQuery();
      listResolved.value = true;
    },
    { immediate: true }
  );
  watch(optionsQuery.error, (error) => {
    if (!error || !listResolved.value) return;
    selectedType.value = renderedType.value;
    Object.assign(query, renderedQuery.value);
  });
  const loading = computed(
    () => optionsQuery.isInitialLoading.value || optionsQuery.isRefreshing.value
  );
  const displayedPage = computed(() => renderedQuery.value.page);
  const displayedPageSize = computed(() => renderedQuery.value.pageSize);
  const listError = computed(() =>
    optionsQuery.error.value ? getApiErrorMessage(optionsQuery.error.value) : ''
  );
  const typesLoading = computed(
    () => !typeDefinitions.value.length && optionsQuery.isInitialLoading.value
  );
  const typesError = listError;
  const { isInitialLoading } = optionsQuery;

  function loadInitialData() {
    return optionsQuery.refresh();
  }

  function loadOptions(force = false) {
    if (force) {
      forceNextListRequest = true;
      optionsQuery.cancel();
    }
    return force ? optionsQuery.refresh() : optionsQuery.ensureFresh();
  }

  function handleTypeChange(value: string | number | boolean | undefined) {
    if (typeof value !== 'string') return;
    selectedType.value = value as V2OptionType;
    query.page = 1;
    query.keyword = '';
    query.status = '';
    query.sortBy = 'sortOrder';
    query.sortOrder = 'asc';
    void loadOptions(true);
  }

  function handleSearch() {
    query.page = 1;
    void loadOptions();
  }

  function handleFilterChange() {
    query.page = 1;
    void loadOptions();
  }

  function resetFilters() {
    query.page = 1;
    query.keyword = '';
    query.status = '';
    void loadOptions();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void loadOptions();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void loadOptions();
  }

  function handleRefresh() {
    void loadOptions(true);
  }

  function handleRetry() {
    void loadOptions(true);
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported = ['name', 'sortOrder', 'status', 'createdAt', 'updatedAt'] as const;
    if (!sort.prop || !supported.includes(sort.prop as (typeof supported)[number])) {
      query.sortBy = 'sortOrder';
      query.sortOrder = 'asc';
    } else {
      query.sortBy = sort.prop as typeof query.sortBy;
      query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    }
    query.page = 1;
    void loadOptions();
  }

  async function openCreate() {
    editingItem.value = null;
    autoMatchedCountryCurrencyCode = '';
    Object.assign(form, createEmptyForm(), { type: selectedType.value });
    drawerVisible.value = true;
    await loadRelatedOptions();
  }

  async function openEdit(item: V2Option) {
    if (item.isSystem) return;
    editingItem.value = item;
    autoMatchedCountryCurrencyCode = '';
    Object.assign(form, {
      type: item.type,
      name: item.name,
      parentId: item.parentId ?? '',
      countryOptionId: item.countryOptionId ?? '',
      businessAmount: Number(item.businessAmount ?? 0),
      currencyCode: item.currencyCode ?? '',
      fixedFee: Number(item.fixedFee),
      percentageFee: Number(item.percentageFee),
      sortOrder: item.sortOrder,
      active: item.status === 'active',
      remark: item.remark ?? ''
    });
    drawerVisible.value = true;
    await loadRelatedOptions();
  }

  async function handleFormTypeChange(value: string | number | boolean | undefined) {
    if (typeof value !== 'string') return;
    form.type = value as V2OptionType;
    form.parentId = '';
    form.countryOptionId = '';
    form.businessAmount = 0;
    form.currencyCode = '';
    form.fixedFee = 0;
    form.percentageFee = 0;
    await loadRelatedOptions();
  }

  async function loadRelatedOptions() {
    await Promise.all([loadParentOptions(), loadCountryOptions()]);
  }

  async function loadParentOptions() {
    parentOptions.value = [];
    const parentType = formTypeDefinition.value?.parentType;
    if (!parentType) return;

    parentOptionsLoading.value = true;
    try {
      const result = await idBusinessV2OptionsApi.listSelectors(parentType);
      parentOptions.value = result.items;
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      parentOptionsLoading.value = false;
    }
  }

  async function loadCountryOptions() {
    countryOptions.value = [];
    if (!formTypeDefinition.value?.requiresCountry) return;

    countryOptionsLoading.value = true;
    try {
      const result = await idBusinessV2OptionsApi.listSelectors('country');
      countryOptions.value = result.items;
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      countryOptionsLoading.value = false;
    }
  }

  async function submitForm() {
    if (submitDisabledReason.value) return;

    const payload = {
      name: form.name.trim(),
      parentId: formTypeDefinition.value?.parentType ? form.parentId : null,
      countryOptionId: formTypeDefinition.value?.requiresCountry ? form.countryOptionId : null,
      businessAmount: formTypeDefinition.value?.supportsBusinessAmount ? form.businessAmount : null,
      currencyCode: formTypeDefinition.value?.supportsCurrency
        ? form.currencyCode.trim().toUpperCase()
        : null,
      fixedFee: formTypeDefinition.value?.supportsFees ? form.fixedFee : 0,
      percentageFee: formTypeDefinition.value?.supportsFees ? form.percentageFee : 0,
      sortOrder: form.sortOrder,
      status: form.active ? ('active' as const) : ('disabled' as const),
      remark: form.remark.trim() || null
    };

    saving.value = true;
    try {
      if (editingItem.value) {
        await idBusinessV2OptionsApi.update(editingItem.value.id, payload);
        ElMessage.success('选项已更新');
      } else {
        await idBusinessV2OptionsApi.create({
          ...payload,
          type: form.type
        } satisfies CreateV2OptionInput);
        ElMessage.success('选项已新增');
      }
      drawerVisible.value = false;
      void loadOptions(true);
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      saving.value = false;
    }
  }

  function openDelete(item: V2Option) {
    if (item.isSystem) return;
    deletingItem.value = item;
    deleteDialogVisible.value = true;
  }

  async function confirmDelete() {
    if (!deletingItem.value) return;

    deleting.value = true;
    try {
      await idBusinessV2OptionsApi.remove(deletingItem.value.id);
      ElMessage.success('选项已删除');
      deleteDialogVisible.value = false;
      deletingItem.value = null;
      if (items.value.length === 1 && query.page > 1) {
        query.page -= 1;
      }
      void loadOptions(true);
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      deleting.value = false;
    }
  }

  function getSelectorLabel(option: V2OptionSelector) {
    return option.parent?.name ? `${option.parent.name} / ${option.name}` : option.name;
  }

  function getDeleteTitle(item: V2Option) {
    if (item.isSystem) return '系统固定选项不能删除';
    return '删除选项';
  }

  function getDeleteMessage(item: V2Option | null) {
    if (!item) return '确认删除该选项？';
    const cascadeNotice =
      item.childCount > 0 && (item.type === 'country' || item.type === 'business_category')
        ? `系统会同时删除关联的开通业务；已有 ID、订单和历史账目仍保留原始名称。`
        : '已有业务记录会保留原始关联，但后续不能再选择该选项。';
    return `确认删除“${item.name}”？${cascadeNotice}`;
  }

  function formatDecimal(value: string) {
    return formatV2Decimal(value);
  }

  function formatDate(value: string) {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  function snapshotQuery() {
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      status: query.status,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    };
  }

  return {
    typeDefinitions,
    optionTypeIcons,
    selectedType,
    renderedType,
    items,
    total,
    typesLoading,
    loading,
    typesError,
    listError,
    drawerVisible,
    saving,
    editingItem,
    parentOptions,
    parentOptionsLoading,
    countryOptions,
    countryOptionsLoading,
    deleteDialogVisible,
    deleting,
    deletingItem,
    query,
    displayedPage,
    displayedPageSize,
    queryPhase: optionsQuery.phase,
    isParameterTransition: optionsQuery.isParameterTransition,
    listResolved,
    form,
    currencyOptions,
    activeTypeDefinition,
    selectedTypeDefinition,
    formTypeDefinition,
    parentTypeLabel,
    selectedServiceCurrency,
    activeFilterCount,
    submitDisabledReason,
    isInitialLoading,
    loadInitialData,
    handleTypeChange,
    handleSearch,
    handleFilterChange,
    resetFilters,
    handlePageSizeChange,
    handlePageChange,
    handleRefresh,
    handleRetry,
    handleSortChange,
    openCreate,
    openEdit,
    handleFormTypeChange,
    submitForm,
    openDelete,
    confirmDelete,
    getSelectorLabel,
    getDeleteTitle,
    getDeleteMessage,
    formatDecimal,
    formatDate
  };
}
