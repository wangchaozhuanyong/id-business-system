import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { isApiError } from '@/api/apiError';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { useV2SensitiveAccessApproval } from '@/v2/composables/useV2SensitiveAccessApproval';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2CustomersApi } from './api';
import type {
  V2Customer,
  V2CustomerDeletePreview,
  V2CustomerListQuery,
  V2CustomerListResult,
  V2OptionSelector,
  V2RecordStatus
} from './contracts';
import { createCustomerPayload, type CustomerFormState } from './customer-form';

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

function emptyForm(): CustomerFormState {
  return {
    name: '',
    phone: '',
    clearPhone: false,
    wechat: '',
    clearWechat: false,
    qq: '',
    clearQq: false,
    whatsapp: '',
    clearWhatsapp: false,
    sourceOptionId: '',
    tagOptionIds: [],
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
  const deletePreview = ref<V2CustomerDeletePreview | null>(null);
  const deletePreviewLoading = ref(false);
  let deletePreviewRequestId = 0;
  const revealTarget = ref<V2Customer | null>(null);
  const revealField = ref<'phone' | 'wechat' | 'qq' | 'whatsapp'>('phone');
  const revealDialogVisible = ref(false);
  const revealing = ref(false);
  const formRef = ref<FormInstance>();

  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    sourceOptionId: '',
    tagOptionId: '',
    serviceOptionId: '',
    recordStatus: '' as V2RecordStatus | '',
    sortBy: 'updatedAt' as 'name' | 'wechat' | 'recordStatus' | 'createdAt' | 'updatedAt',
    sortOrder: 'desc' as 'asc' | 'desc'
  });

  const form = reactive<CustomerFormState>(emptyForm());
  const revealForm = reactive({
    reason: '',
    value: ''
  });
  const revealFieldLabel = computed(() => {
    if (revealField.value === 'phone') return '手机号';
    if (revealField.value === 'wechat') return '微信';
    if (revealField.value === 'qq') return 'QQ';
    return 'WhatsApp';
  });
  const sensitiveAccess = useV2SensitiveAccessApproval();

  const canCreate = computed(() => hasUserPermission(authStore.user, 'customer.create'));
  const canUpdate = computed(() => hasUserPermission(authStore.user, 'customer.update'));
  const canDelete = computed(() => hasUserPermission(authStore.user, 'customer.delete'));
  const canRevealContact = computed(() => hasUserPermission(authStore.user, 'customer.view_phone'));
  const activeFilterCount = computed(
    () =>
      [
        query.keyword.trim(),
        query.sourceOptionId,
        query.tagOptionId,
        query.serviceOptionId,
        query.recordStatus
      ].filter(Boolean).length
  );

  const formRules: FormRules<CustomerFormState> = {
    name: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          callback(
            normalized.length >= 1 && normalized.length <= 120
              ? undefined
              : new Error('请输入 1 至 120 个字符的客户名称')
          );
        },
        trigger: 'blur'
      }
    ]
  };
  const revealRules = computed<FormRules>(() => ({
    reason:
      sensitiveAccess.requiresApproval.value && !sensitiveAccess.canReveal.value
        ? [
            {
              required: true,
              validator: (_rule, value, callback) => {
                const normalized = String(value ?? '').trim();
                callback(
                  normalized.length >= 2 && normalized.length <= 200
                    ? undefined
                    : new Error('请输入 2 至 200 个字符的申请原因')
                );
              },
              trigger: 'blur'
            }
          ]
        : []
  }));

  function getCustomersListQuery(): V2CustomerListQuery {
    return {
      ...query,
      keyword: query.keyword.trim() || undefined,
      sourceOptionId: query.sourceOptionId || undefined,
      tagOptionId: query.tagOptionId || undefined,
      serviceOptionId: query.serviceOptionId || undefined,
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
  const displayedPage = computed(() => customersQuery.data.value?.list.page ?? query.page);
  const displayedPageSize = computed(
    () => customersQuery.data.value?.list.pageSize ?? query.pageSize
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

  function resetFilters() {
    Object.assign(query, {
      page: 1,
      keyword: '',
      sourceOptionId: '',
      tagOptionId: '',
      serviceOptionId: '',
      recordStatus: ''
    });
    loadCurrentCustomers();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    loadCurrentCustomers();
  }

  function handlePageChange(page: number) {
    query.page = page;
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
    if (customersQuery.isParameterTransition.value) return;
    editingItem.value = item;
    Object.assign(form, {
      name: item.name,
      phone: '',
      clearPhone: false,
      wechat: '',
      clearWechat: false,
      qq: '',
      clearQq: false,
      whatsapp: '',
      clearWhatsapp: false,
      sourceOptionId: item.sourceOptionId ?? '',
      tagOptionIds: [...item.tagOptionIds],
      active: item.recordStatus === 'active',
      remark: item.remark ?? ''
    });
    drawerVisible.value = true;
  }

  async function submitForm() {
    if (!(await validateV2Form(formRef.value))) return;

    const payload = createCustomerPayload(form, editingItem.value);

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
    if (customersQuery.isParameterTransition.value) return;
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

  function openRevealContact(item: V2Customer, field: 'phone' | 'wechat' | 'qq' | 'whatsapp') {
    if (customersQuery.isParameterTransition.value) return;
    revealTarget.value = item;
    revealField.value = field;
    Object.assign(revealForm, {
      reason: '',
      value: ''
    });
    revealDialogVisible.value = true;
    void sensitiveAccess.prepare({
      module: 'id_business_v2_customer',
      fieldName: field,
      objectType: 'id_business_v2_customer',
      objectId: item.id
    });
  }

  function openRevealPhone(item: V2Customer) {
    openRevealContact(item, 'phone');
  }

  function openRevealWhatsapp(item: V2Customer) {
    openRevealContact(item, 'whatsapp');
  }

  function openRevealWechat(item: V2Customer) {
    openRevealContact(item, 'wechat');
  }

  function openRevealQq(item: V2Customer) {
    openRevealContact(item, 'qq');
  }

  function canRevealField(item: V2Customer, field: 'phone' | 'wechat' | 'qq' | 'whatsapp') {
    const mode = item.contactDisplayModes[field];
    return canRevealContact.value && (mode === 'reveal_direct' || mode === 'reveal_approval');
  }

  async function revealContact(formInstance?: FormInstance) {
    if (!revealTarget.value || !(await validateV2Form(formInstance))) return;
    revealing.value = true;
    try {
      if (sensitiveAccess.requiresApproval.value && !sensitiveAccess.approvedRequestId.value) {
        await sensitiveAccess.submitRequest(revealForm.reason);
        ElMessage.success('查看申请已提交，管理员审核后即可查看');
        return;
      }
      const payload = {
        reason: revealForm.reason.trim(),
        approvalId: sensitiveAccess.approvedRequestId.value
      };
      if (revealField.value === 'phone') {
        const result = await idBusinessV2CustomersApi.revealPhone(revealTarget.value.id, payload);
        revealForm.value = result.phone;
      } else if (revealField.value === 'whatsapp') {
        const result = await idBusinessV2CustomersApi.revealWhatsapp(
          revealTarget.value.id,
          payload
        );
        revealForm.value = result.whatsapp;
      } else if (revealField.value === 'wechat') {
        const result = await idBusinessV2CustomersApi.revealWechat(revealTarget.value.id, payload);
        revealForm.value = result.wechat;
      } else {
        const result = await idBusinessV2CustomersApi.revealQq(revealTarget.value.id, payload);
        revealForm.value = result.qq;
      }
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      revealing.value = false;
    }
  }

  const deleteConfirmDisabledReason = computed(() => {
    if (deletePreviewLoading.value) return '正在核对关联数据';
    if (!deletePreview.value) return '删除预览不可用';
    return deletePreview.value.blockingReasons.join('；');
  });
  const deleteImpactRows = computed(() => {
    const impact = deletePreview.value?.impact;
    if (!impact) return [];
    return [
      { label: '关联订单', value: impact.orderCount },
      { label: '进行中订单', value: impact.activeOrderCount },
      { label: '关联开通', value: impact.activationCount },
      { label: '活动开通', value: impact.activeActivationCount }
    ].filter((item) => item.value > 0);
  });

  async function openDelete(item: V2Customer) {
    if (customersQuery.isParameterTransition.value) return;
    const requestId = ++deletePreviewRequestId;
    deletingItem.value = item;
    deletePreview.value = null;
    deleteDialogVisible.value = true;
    deletePreviewLoading.value = true;
    try {
      const preview = await idBusinessV2CustomersApi.getDeletePreview(item.id);
      if (requestId === deletePreviewRequestId && deletingItem.value?.id === item.id) {
        deletePreview.value = preview;
      }
    } catch (error) {
      if (requestId !== deletePreviewRequestId) return;
      ElMessage.error(getApiErrorMessage(error));
      deleteDialogVisible.value = false;
      deletingItem.value = null;
    } finally {
      if (requestId === deletePreviewRequestId) deletePreviewLoading.value = false;
    }
  }

  async function confirmDelete() {
    if (!deletingItem.value || !deletePreview.value?.canDelete) return;
    deleting.value = true;
    try {
      await idBusinessV2CustomersApi.remove(deletingItem.value.id, deletePreview.value.fingerprint);
      ElMessage.success('客户资料已删除');
      deleteDialogVisible.value = false;
      deletingItem.value = null;
      deletePreview.value = null;
      await loadCustomers();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      if (isApiError(error) && error.kind === 'conflict' && deletingItem.value) {
        await openDelete(deletingItem.value);
      }
    } finally {
      deleting.value = false;
    }
  }

  watch(deleteDialogVisible, (visible) => {
    if (visible) return;
    deletePreviewRequestId += 1;
    deletePreviewLoading.value = false;
    deletePreview.value = null;
    if (!deleting.value) deletingItem.value = null;
  });

  function selectorLabel(option: V2OptionSelector) {
    return [option.country?.name, option.parent?.name, option.name].filter(Boolean).join(' / ');
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

  return {
    items,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: customersQuery.phase,
    isParameterTransition: customersQuery.isParameterTransition,
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
    deletePreview,
    deletePreviewLoading,
    deleteConfirmDisabledReason,
    deleteImpactRows,
    revealTarget,
    revealField,
    revealFieldLabel,
    revealDialogVisible,
    revealing,
    formRef,
    query,
    form,
    revealForm,
    sensitiveAccessPolicy: sensitiveAccess.policy,
    sensitiveAccessRequest: sensitiveAccess.request,
    sensitiveAccessRequiresApproval: sensitiveAccess.requiresApproval,
    sensitiveAccessCanReveal: sensitiveAccess.canReveal,
    sensitiveAccessLoading: sensitiveAccess.loading,
    sensitiveAccessRequesting: sensitiveAccess.requesting,
    sensitiveAccessError: sensitiveAccess.error,
    sensitiveAccessStatusText: sensitiveAccess.statusText,
    sensitiveAccessActionText: sensitiveAccess.actionText,
    canCreate,
    canUpdate,
    canDelete,
    canRevealContact,
    activeFilterCount,
    formRules,
    revealRules,
    hasLoadedOnce,
    isInitialLoading,
    loadCustomers,
    handleSearch,
    handleFilterChange,
    resetFilters,
    handlePageSizeChange,
    handlePageChange,
    optionNames,
    handleSortChange,
    openCreate,
    openEdit,
    submitForm,
    toggleStatus,
    openRevealPhone,
    openRevealWechat,
    openRevealQq,
    openRevealWhatsapp,
    canRevealField,
    revealContact,
    refreshSensitiveAccess: sensitiveAccess.refresh,
    openDelete,
    confirmDelete,
    selectorLabel,
    formatDate
  };
}
