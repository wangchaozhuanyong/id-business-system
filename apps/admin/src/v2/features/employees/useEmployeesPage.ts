import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { v2EmployeesApi } from './api';
import type {
  CreateV2EmployeeInput,
  UpdateV2EmployeeInput,
  V2Employee,
  V2EmployeeListQuery,
  V2EmployeeStatus
} from './contracts';

interface EmployeeFormModel {
  username: string;
  displayName: string;
  initialPassword: string;
  roleIds: string[];
  status: V2EmployeeStatus;
}

function emptyForm(): EmployeeFormModel {
  return {
    username: '',
    displayName: '',
    initialPassword: '',
    roleIds: [],
    status: 'active'
  };
}

export function useEmployeesPage() {
  const authStore = useAuthStore();
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: '' as V2EmployeeStatus | '',
    roleId: '',
    sortBy: 'createdAt' as NonNullable<V2EmployeeListQuery['sortBy']>,
    sortOrder: 'desc' as 'asc' | 'desc'
  });
  const drawerVisible = ref(false);
  const editingItem = ref<V2Employee | null>(null);
  const saving = ref(false);
  const mutationError = ref('');
  const form = reactive<EmployeeFormModel>(emptyForm());
  const formBaseline = ref(JSON.stringify(emptyForm()));

  function getListQuery(): V2EmployeeListQuery {
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      status: query.status || undefined,
      roleId: query.roleId || undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    };
  }

  const employeesQuery = useV2ModuleQuery({
    moduleKey: 'employees',
    scope: 'employees',
    key: () => createV2QueryKey(getListQuery()),
    keepPreviousData: true,
    query: ({ signal }) => v2EmployeesApi.bootstrap(getListQuery(), { signal })
  });

  const items = computed(() => employeesQuery.data.value?.list.items ?? []);
  const total = computed(() => employeesQuery.data.value?.list.total ?? 0);
  const displayedPage = computed(() => employeesQuery.data.value?.list.page ?? query.page);
  const displayedPageSize = computed(
    () => employeesQuery.data.value?.list.pageSize ?? query.pageSize
  );
  const roleOptions = computed(() => employeesQuery.data.value?.roles ?? []);
  const activeFilterCount = computed(
    () => [query.keyword.trim(), query.status, query.roleId].filter(Boolean).length
  );
  const loading = computed(
    () => employeesQuery.isInitialLoading.value || employeesQuery.isRefreshing.value
  );
  const listError = computed(() =>
    employeesQuery.error.value ? getApiErrorMessage(employeesQuery.error.value) : ''
  );
  const isEditingSelf = computed(() =>
    Boolean(editingItem.value && editingItem.value.id === authStore.user?.id)
  );
  const rolesChanged = computed(() => {
    if (!editingItem.value) return false;
    const existingRoleIds = editingItem.value.roles.map((role) => role.id).sort();
    const nextRoleIds = [...form.roleIds].sort();
    return JSON.stringify(existingRoleIds) !== JSON.stringify(nextRoleIds);
  });
  const securitySensitiveChangeMessage = computed(() => {
    const current = editingItem.value;
    if (!current || isEditingSelf.value) return '';
    const disabling = current.status === 'active' && form.status === 'disabled';
    if (disabling && rolesChanged.value) {
      return '停用或修改角色都会立即撤销该员工的全部在线会话。';
    }
    if (disabling) return '保存后该员工的在线会话会立即失效。';
    if (rolesChanged.value) {
      return '保存角色变更后，该员工的在线会话会立即失效，重新登录后新权限才会生效。';
    }
    return '';
  });
  const drawerDirty = computed(() => JSON.stringify(form) !== formBaseline.value);
  const formRules = computed<FormRules<EmployeeFormModel>>(() => ({
    username: editingItem.value
      ? []
      : [
          { required: true, message: '请输入登录账号', trigger: 'blur' },
          {
            pattern: /^[a-z0-9][a-z0-9._-]{2,99}$/,
            message: '请输入 3 至 100 位小写字母、数字、点、下划线或短横线',
            trigger: 'blur'
          }
        ],
    displayName: [
      { required: true, message: '请输入员工姓名', trigger: 'blur' },
      { max: 100, message: '员工姓名不能超过 100 个字符', trigger: 'blur' }
    ],
    initialPassword: editingItem.value
      ? []
      : [
          { required: true, message: '请输入初始密码', trigger: 'blur' },
          { min: 8, max: 160, message: '初始密码长度需为 8 至 160 位', trigger: 'blur' }
        ],
    roleIds: [
      {
        type: 'array',
        required: true,
        min: 1,
        message: '请至少选择一个角色',
        trigger: 'change'
      }
    ]
  }));
  const { hasLoadedOnce, isInitialLoading } = employeesQuery;

  function handleSearch() {
    query.page = 1;
    void employeesQuery.refresh();
  }

  function resetFilters() {
    query.page = 1;
    query.keyword = '';
    query.status = '';
    query.roleId = '';
    query.sortBy = 'createdAt';
    query.sortOrder = 'desc';
    void employeesQuery.refresh();
  }

  function handleSortChange(input: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    if (
      input.prop !== 'username' &&
      input.prop !== 'displayName' &&
      input.prop !== 'status' &&
      input.prop !== 'lastLoginAt' &&
      input.prop !== 'createdAt'
    ) {
      return;
    }
    query.sortBy = input.prop;
    query.sortOrder = input.order === 'ascending' ? 'asc' : 'desc';
    query.page = 1;
    void employeesQuery.refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void employeesQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void employeesQuery.ensureFresh();
  }

  function setForm(next: EmployeeFormModel) {
    Object.assign(form, next);
    formBaseline.value = JSON.stringify(next);
  }

  function openCreate() {
    editingItem.value = null;
    mutationError.value = '';
    setForm(emptyForm());
    drawerVisible.value = true;
  }

  function openEdit(item: V2Employee) {
    editingItem.value = item;
    mutationError.value = '';
    setForm({
      username: item.username,
      displayName: item.displayName,
      initialPassword: '',
      roleIds: item.roles.map((role) => role.id),
      status: item.status
    });
    drawerVisible.value = true;
  }

  async function submitEmployee(formInstance?: FormInstance) {
    if (!(await validateV2Form(formInstance))) return;
    mutationError.value = '';
    const current = editingItem.value;
    const disabling = current?.status === 'active' && form.status === 'disabled';
    if (current && (disabling || rolesChanged.value)) {
      const changingRoles = rolesChanged.value;
      try {
        await ElMessageBox.confirm(
          changingRoles
            ? `修改角色后，${current.displayName} 的所有在线会话会立即失效，需重新登录后新权限才会生效。确认继续吗？`
            : `停用后，${current.displayName} 的所有在线会话会立即失效。确认继续吗？`,
          changingRoles ? '确认修改员工权限' : '确认停用员工账号',
          {
            confirmButtonText: changingRoles ? '确认修改' : '确认停用',
            cancelButtonText: '取消',
            type: 'warning'
          }
        );
      } catch {
        return;
      }
    }

    saving.value = true;
    try {
      if (current) {
        const input: UpdateV2EmployeeInput = {
          displayName: form.displayName.trim()
        };
        if (!isEditingSelf.value) {
          input.roleIds = [...form.roleIds];
          input.status = form.status;
        }
        await v2EmployeesApi.update(current.id, input);
        ElMessage.success('员工账号已更新');
      } else {
        const input: CreateV2EmployeeInput = {
          username: form.username.trim().toLowerCase(),
          displayName: form.displayName.trim(),
          initialPassword: form.initialPassword,
          roleIds: [...form.roleIds]
        };
        await v2EmployeesApi.create(input);
        ElMessage.success('员工账号已开通');
      }
      drawerVisible.value = false;
      await employeesQuery.refresh();
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
      ElMessage.error(mutationError.value);
    } finally {
      saving.value = false;
    }
  }

  function formatDate(value: string | null) {
    if (!value) return '从未登录';
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
    query,
    items,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: employeesQuery.phase,
    isParameterTransition: employeesQuery.isParameterTransition,
    roleOptions,
    activeFilterCount,
    loading,
    listError,
    hasLoadedOnce,
    isInitialLoading,
    drawerVisible,
    editingItem,
    isEditingSelf,
    rolesChanged,
    securitySensitiveChangeMessage,
    saving,
    mutationError,
    form,
    formRules,
    drawerDirty,
    loadEmployees: employeesQuery.refresh,
    handleSearch,
    handleFilterChange: handleSearch,
    resetFilters,
    handleSortChange,
    handlePageChange,
    handlePageSizeChange,
    openCreate,
    openEdit,
    submitEmployee,
    formatDate
  };
}
