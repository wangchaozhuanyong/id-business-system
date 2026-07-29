import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
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
import { idBusinessV2CustomersApi } from './api';
import type {
  CreateV2CustomerInput,
  V2Customer,
  V2CustomerListQuery,
  V2CustomerListResult,
  V2OptionSelector,
  V2RecordStatus
} from './contracts';

interface CustomersReferenceOptions {
  sources: V2OptionSelector[];
  tags: V2OptionSelector[];
  services: V2OptionSelector[];
}

interface CustomersPageSnapshot {
  list: V2CustomerListResult;
  options: CustomersReferenceOptions;
}

const CUSTOMERS_OPTIONS_SCOPE = 'customers-options';
const CUSTOMERS_OPTIONS_KEY = 'selectors';

interface CustomerFormState {
  name: string;
  phone: string;
  clearPhone: boolean;
  wechat: string;
  sourceOptionId: string;
  tagOptionIds: string[];
  serviceOptionIds: string[];
  active: boolean;
  remark: string;
}

function emptyForm(): CustomerFormState {
  return {
    name: '',
    phone: '',
    clearPhone: false,
    wechat: '',
    sourceOptionId: '',
    tagOptionIds: [],
    serviceOptionIds: [],
    active: true,
    remark: ''
  };
}

export function useCustomersPage() {
  const authStore = useAuthStore();
  const items = ref<V2Customer[]>([]);
  const total = ref(0);
  const sourceOptions = ref<V2OptionSelector[]>([]);
  const tagOptions = ref<V2OptionSelector[]>([]);
  const serviceOptions = ref<V2OptionSelector[]>([]);
  const drawerVisible = ref(false);
  const saving = ref(false);
  const editingItem = ref<V2Customer | null>(null);
  const deletingItem = ref<V2Customer | null>(null);
  const deleteDialogVisible = ref(false);
  const deleting = ref(false);
  const revealTarget = ref<V2Customer | null>(null);
  const revealDialogVisible = ref(false);
  const revealing = ref(false);
  const formRef = ref<FormInstance>();

  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    sourceOptionId: '',
    tagOptionId: '',
    recordStatus: '' as V2RecordStatus | '',
    sortBy: 'updatedAt' as 'name' | 'wechat' | 'recordStatus' | 'createdAt' | 'updatedAt',
    sortOrder: 'desc' as 'asc' | 'desc'
  });

  const form = reactive<CustomerFormState>(emptyForm());
  const revealForm = reactive({
    reason: '',
    approvalId: '',
    phone: ''
  });

  const canCreate = computed(() => hasUserPermission(authStore.user, 'customer.create'));
  const canUpdate = computed(() => hasUserPermission(authStore.user, 'customer.update'));
  const canDelete = computed(() => hasUserPermission(authStore.user, 'customer.delete'));
  const canRevealPhone = computed(() => hasUserPermission(authStore.user, 'customer.view_phone'));

  const formRules: FormRules<CustomerFormState> = {
    name: [{ required: true, message: '请输入客户名称', trigger: 'blur' }]
  };

  function getCustomersListQuery(): V2CustomerListQuery {
    return {
      ...query,
      keyword: query.keyword.trim() || undefined,
      sourceOptionId: query.sourceOptionId || undefined,
      tagOptionId: query.tagOptionId || undefined,
      recordStatus: query.recordStatus || undefined
    };
  }

  const customersQuery = useV2ModuleQuery<CustomersPageSnapshot>({
    moduleKey: 'customers',
    scope: 'customers',
    key: () => createV2QueryKey(getCustomersListQuery()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getCustomersListQuery();
      const cachedOptions = getV2QueryData<CustomersReferenceOptions>(
        CUSTOMERS_OPTIONS_SCOPE,
        CUSTOMERS_OPTIONS_KEY,
        {}
      );
      if (cachedOptions) {
        return {
          list: await idBusinessV2CustomersApi.list(params, { signal }),
          options: cachedOptions
        };
      }
      const result = await idBusinessV2CustomersApi.bootstrap(params, { signal });
      primeV2Query({
        scope: CUSTOMERS_OPTIONS_SCOPE,
        key: CUSTOMERS_OPTIONS_KEY,
        data: result.options
      });
      return { list: result.list, options: result.options };
    }
  });
  watch(
    customersQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      items.value = snapshot.list.items;
      total.value = snapshot.list.total;
      sourceOptions.value = snapshot.options.sources;
      tagOptions.value = snapshot.options.tags;
      serviceOptions.value = snapshot.options.services;
    },
    { immediate: true }
  );
  const loading = computed(
    () => customersQuery.isInitialLoading.value || customersQuery.isRefreshing.value
  );
  const listError = computed(() =>
    customersQuery.error.value ? getApiErrorMessage(customersQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = customersQuery;

  async function loadCustomers() {
    await customersQuery.refresh();
  }

  function loadCurrentCustomers() {
    void customersQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentCustomers();
  }

  function handleFilterChange() {
    query.page = 1;
    loadCurrentCustomers();
  }

  function handlePageSizeChange() {
    query.page = 1;
    loadCurrentCustomers();
  }

  function handlePageChange() {
    loadCurrentCustomers();
  }

  function optionNames(options: Array<{ name: string }>) {
    return options.map((option) => option.name).join('、');
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported = ['name', 'wechat', 'recordStatus', 'createdAt', 'updatedAt'] as const;
    query.sortBy =
      sort.prop && supported.includes(sort.prop as (typeof supported)[number])
        ? (sort.prop as typeof query.sortBy)
        : 'updatedAt';
    query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    loadCurrentCustomers();
  }

  function openCreate() {
    editingItem.value = null;
    Object.assign(form, emptyForm());
    drawerVisible.value = true;
  }

  function openEdit(item: V2Customer) {
    editingItem.value = item;
    Object.assign(form, {
      name: item.name,
      phone: '',
      clearPhone: false,
      wechat: item.wechat ?? '',
      sourceOptionId: item.sourceOptionId ?? '',
      tagOptionIds: [...item.tagOptionIds],
      serviceOptionIds: [...item.serviceOptionIds],
      active: item.recordStatus === 'active',
      remark: item.remark ?? ''
    });
    drawerVisible.value = true;
  }

  async function submitForm() {
    const valid = await formRef.value?.validate().catch(() => false);
    if (!valid) return;

    const payload: CreateV2CustomerInput = {
      name: form.name.trim(),
      wechat: form.wechat.trim() || null,
      sourceOptionId: form.sourceOptionId || null,
      tagOptionIds: form.tagOptionIds,
      serviceOptionIds: form.serviceOptionIds,
      recordStatus: form.active ? 'active' : 'disabled',
      remark: form.remark.trim() || null
    };
    if (!editingItem.value || form.phone.trim()) {
      payload.phone = form.phone.trim() || null;
    } else if (form.clearPhone) {
      payload.phone = null;
    }

    saving.value = true;
    try {
      if (editingItem.value) {
        await idBusinessV2CustomersApi.update(editingItem.value.id, payload);
        ElMessage.success('客户资料已更新');
      } else {
        await idBusinessV2CustomersApi.create(payload);
        ElMessage.success('客户资料已新增');
      }
      drawerVisible.value = false;
      await loadCustomers();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      saving.value = false;
    }
  }

  async function toggleStatus(item: V2Customer) {
    try {
      await idBusinessV2CustomersApi.update(item.id, {
        recordStatus: item.recordStatus === 'active' ? 'disabled' : 'active'
      });
      ElMessage.success(item.recordStatus === 'active' ? '客户已停用' : '客户已启用');
      await loadCustomers();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    }
  }

  function openRevealPhone(item: V2Customer) {
    revealTarget.value = item;
    Object.assign(revealForm, {
      reason: '',
      approvalId: '',
      phone: ''
    });
    revealDialogVisible.value = true;
  }

  async function revealPhone() {
    if (!revealTarget.value || !revealForm.reason.trim()) return;
    revealing.value = true;
    try {
      const result = await idBusinessV2CustomersApi.revealPhone(revealTarget.value.id, {
        reason: revealForm.reason.trim(),
        approvalId: revealForm.approvalId.trim() || null
      });
      revealForm.phone = result.phone;
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      revealing.value = false;
    }
  }

  function openDelete(item: V2Customer) {
    deletingItem.value = item;
    deleteDialogVisible.value = true;
  }

  async function confirmDelete() {
    if (!deletingItem.value) return;
    deleting.value = true;
    try {
      await idBusinessV2CustomersApi.remove(deletingItem.value.id);
      ElMessage.success('客户资料已删除');
      deleteDialogVisible.value = false;
      deletingItem.value = null;
      await loadCustomers();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      deleting.value = false;
    }
  }

  function selectorLabel(option: V2OptionSelector) {
    return [option.country?.name, option.parent?.name, option.name].filter(Boolean).join(' / ');
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

  return {
    items,
    total,
    loading,
    listError,
    sourceOptions,
    tagOptions,
    serviceOptions,
    drawerVisible,
    saving,
    editingItem,
    deletingItem,
    deleteDialogVisible,
    deleting,
    revealTarget,
    revealDialogVisible,
    revealing,
    formRef,
    query,
    form,
    revealForm,
    canCreate,
    canUpdate,
    canDelete,
    canRevealPhone,
    formRules,
    hasLoadedOnce,
    isInitialLoading,
    loadCustomers,
    handleSearch,
    handleFilterChange,
    handlePageSizeChange,
    handlePageChange,
    optionNames,
    handleSortChange,
    openCreate,
    openEdit,
    submitForm,
    toggleStatus,
    openRevealPhone,
    revealPhone,
    openDelete,
    confirmDelete,
    selectorLabel,
    formatDate
  };
}
