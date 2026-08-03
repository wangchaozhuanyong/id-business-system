import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { v2RolesApi } from './api';
import type {
  CreateV2RoleInput,
  UpdateV2RoleInput,
  V2Role,
  V2RoleListQuery,
  V2RoleMember,
  V2RolePermission,
  V2RolePermissionGroup
} from './contracts';
import {
  filterRolePermissionGroups,
  getInitialExpandedPermissionModules,
  type V2RolePermissionWorkspaceGroup
} from './rolePermissionWorkspace';

interface RoleFormModel {
  name: string;
  code: string;
  description: string;
  permissionIds: string[];
}

const PERMISSION_MODULE_LABELS: Record<string, string> = {
  'apple.account': 'ID 资料',
  'apple.secret': 'ID 敏感资料',
  'apple.balance': '余额与加卡',
  'apple.topup_supplier_fund': '供应商资金',
  'apple.gift_card': '礼品卡',
  'apple.order': '订单',
  'apple.activation': '开通记录',
  'apple.renewal_task': '续费',
  'apple.exchange_rate': '汇率',
  customer: '客户',
  'data.dictionary': '业务选项',
  audit_log: '审计日志',
  'id_business_v2.renewal_warning': '续费预警',
  'data.analytics': '经营分析',
  finance: '财务'
};

function emptyForm(): RoleFormModel {
  return {
    name: '',
    code: '',
    description: '',
    permissionIds: []
  };
}

export function useRolesPage() {
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    sortBy: 'code' as NonNullable<V2RoleListQuery['sortBy']>,
    sortOrder: 'asc' as 'asc' | 'desc'
  });
  const drawerVisible = ref(false);
  const editingItem = ref<V2Role | null>(null);
  const members = ref<V2RoleMember[]>([]);
  const detailLoading = ref(false);
  const detailResolved = ref(false);
  const detailError = ref('');
  const saving = ref(false);
  const mutationError = ref('');
  const permissionKeyword = ref('');
  const selectedPermissionsOnly = ref(false);
  const expandedPermissionModules = ref<string[]>([]);
  const permissionValidationAttempted = ref(false);
  const form = reactive<RoleFormModel>(emptyForm());
  const formBaseline = ref(JSON.stringify(emptyForm()));

  function getListQuery(): V2RoleListQuery {
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    };
  }

  const rolesQuery = useV2ModuleQuery({
    moduleKey: 'roles',
    scope: 'employees',
    key: () => createV2QueryKey(getListQuery()),
    keepPreviousData: true,
    query: ({ signal }) => v2RolesApi.bootstrap(getListQuery(), { signal })
  });

  const items = computed(() => rolesQuery.data.value?.list.items ?? []);
  const total = computed(() => rolesQuery.data.value?.list.total ?? 0);
  const permissions = computed(() => rolesQuery.data.value?.permissions ?? []);
  const permissionGroups = computed<V2RolePermissionGroup[]>(() => {
    const groups = new Map<string, V2RolePermission[]>();
    for (const permission of permissions.value) {
      const values = groups.get(permission.module) ?? [];
      values.push(permission);
      groups.set(permission.module, values);
    }
    return [...groups.entries()].map(([module, values]) => ({
      module,
      label: PERMISSION_MODULE_LABELS[module] ?? module,
      permissions: values
    }));
  });
  const loading = computed(
    () => rolesQuery.isInitialLoading.value || rolesQuery.isRefreshing.value
  );
  const listError = computed(() =>
    rolesQuery.error.value ? getApiErrorMessage(rolesQuery.error.value) : ''
  );
  const drawerDirty = computed(() => JSON.stringify(form) !== formBaseline.value);
  const isSystemRole = computed(() => editingItem.value?.isSystemRole ?? false);
  const selectedPermissionCount = computed(() => form.permissionIds.length);
  const filteredPermissionGroups = computed(() =>
    filterRolePermissionGroups(
      permissionGroups.value,
      permissionKeyword.value,
      selectedPermissionsOnly.value,
      form.permissionIds
    )
  );
  const activePermissionModules = computed<string[]>({
    get: () =>
      permissionKeyword.value.trim()
        ? filteredPermissionGroups.value.map((group) => group.module)
        : expandedPermissionModules.value,
    set: (modules) => {
      if (!permissionKeyword.value.trim()) {
        expandedPermissionModules.value = modules;
      }
    }
  });
  const permissionSelectionError = computed(() =>
    permissionValidationAttempted.value && !form.permissionIds.length ? '请至少选择一项权限' : ''
  );
  const formRules = computed<FormRules<RoleFormModel>>(() => ({
    name: [
      { required: true, message: '请输入角色名称', trigger: 'blur' },
      { max: 100, message: '角色名称不能超过 100 个字符', trigger: 'blur' }
    ],
    code: editingItem.value
      ? []
      : [
          { required: true, message: '请输入角色编码', trigger: 'blur' },
          {
            pattern: /^[a-z][a-z0-9._-]{2,99}$/,
            message: '需以小写字母开头，可包含数字、点、下划线或短横线',
            trigger: 'blur'
          }
        ],
    description: [{ max: 500, message: '角色说明不能超过 500 个字符', trigger: 'blur' }],
    permissionIds: [
      {
        type: 'array',
        required: true,
        min: 1,
        message: '请至少选择一项权限',
        trigger: 'change'
      }
    ]
  }));
  const { hasLoadedOnce, isInitialLoading } = rolesQuery;

  function handleSearch() {
    query.page = 1;
    void rolesQuery.refresh();
  }

  function resetFilters() {
    query.page = 1;
    query.keyword = '';
    query.sortBy = 'code';
    query.sortOrder = 'asc';
    void rolesQuery.refresh();
  }

  function handleSortChange(input: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    if (
      input.prop !== 'name' &&
      input.prop !== 'code' &&
      input.prop !== 'createdAt' &&
      input.prop !== 'updatedAt'
    ) {
      return;
    }
    query.sortBy = input.prop;
    query.sortOrder = input.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    void rolesQuery.refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void rolesQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void rolesQuery.ensureFresh();
  }

  function setForm(next: RoleFormModel) {
    Object.assign(form, next);
    formBaseline.value = JSON.stringify(next);
  }

  function resetPermissionWorkspace(permissionIds: string[]) {
    permissionKeyword.value = '';
    selectedPermissionsOnly.value = false;
    permissionValidationAttempted.value = false;
    expandedPermissionModules.value = getInitialExpandedPermissionModules(
      permissionGroups.value,
      permissionIds
    );
  }

  function openCreate() {
    editingItem.value = null;
    members.value = [];
    detailLoading.value = false;
    detailResolved.value = true;
    detailError.value = '';
    mutationError.value = '';
    const nextForm = emptyForm();
    setForm(nextForm);
    resetPermissionWorkspace(nextForm.permissionIds);
    drawerVisible.value = true;
  }

  function openEdit(item: V2Role) {
    editingItem.value = item;
    members.value = [];
    detailResolved.value = false;
    detailError.value = '';
    mutationError.value = '';
    setForm({
      name: item.name,
      code: item.code,
      description: item.description ?? '',
      permissionIds: [...item.permissionIds]
    });
    resetPermissionWorkspace(item.permissionIds);
    drawerVisible.value = true;
    void loadRoleDetail();
  }

  async function loadRoleDetail() {
    const current = editingItem.value;
    if (!current) return;
    detailLoading.value = true;
    detailError.value = '';
    try {
      const detail = await v2RolesApi.get(current.id);
      if (editingItem.value?.id !== current.id) return;
      members.value = detail.members;
      detailResolved.value = true;
    } catch (error) {
      detailError.value = getApiErrorMessage(error);
    } finally {
      if (editingItem.value?.id === current.id) {
        detailLoading.value = false;
      }
    }
  }

  function normalizeCode(value: string) {
    if (editingItem.value) return;
    form.code = value.toLowerCase().replace(/\s+/g, '');
  }

  function isGroupSelected(group: V2RolePermissionWorkspaceGroup) {
    return group.allPermissions.every((permission) => form.permissionIds.includes(permission.id));
  }

  function isGroupIndeterminate(group: V2RolePermissionWorkspaceGroup) {
    const selected = group.allPermissions.filter((permission) =>
      form.permissionIds.includes(permission.id)
    ).length;
    return selected > 0 && selected < group.allPermissions.length;
  }

  function toggleGroup(group: V2RolePermissionWorkspaceGroup, checked: boolean) {
    const groupIds = new Set(group.allPermissions.map((permission) => permission.id));
    const nextIds = form.permissionIds.filter((permissionId) => !groupIds.has(permissionId));
    if (checked) {
      nextIds.push(...groupIds);
    }
    form.permissionIds = [...new Set(nextIds)];
  }

  function clearPermissionSelection() {
    form.permissionIds = [];
  }

  function clearPermissionFilters() {
    permissionKeyword.value = '';
    selectedPermissionsOnly.value = false;
  }

  async function submitRole(formInstance?: FormInstance) {
    permissionValidationAttempted.value = true;
    if (isSystemRole.value || !(await validateV2Form(formInstance))) return;
    mutationError.value = '';
    const current = editingItem.value;
    if (current?.memberCount) {
      try {
        await ElMessageBox.confirm(
          `保存后将立即影响该角色下 ${current.memberCount} 名员工的访问权限。确认继续吗？`,
          '确认修改角色权限',
          {
            confirmButtonText: '确认保存',
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
        const input: UpdateV2RoleInput = {
          name: form.name.trim(),
          description: form.description.trim(),
          permissionIds: [...form.permissionIds]
        };
        await v2RolesApi.update(current.id, input);
        ElMessage.success('角色权限已更新');
      } else {
        const input: CreateV2RoleInput = {
          name: form.name.trim(),
          code: form.code.trim().toLowerCase(),
          description: form.description.trim(),
          permissionIds: [...form.permissionIds]
        };
        await v2RolesApi.create(input);
        ElMessage.success('角色已创建');
      }
      drawerVisible.value = false;
      await rolesQuery.refresh();
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
      ElMessage.error(mutationError.value);
    } finally {
      saving.value = false;
    }
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
    query,
    items,
    total,
    permissionGroups,
    loading,
    listError,
    hasLoadedOnce,
    isInitialLoading,
    drawerVisible,
    editingItem,
    members,
    detailLoading,
    detailResolved,
    detailError,
    saving,
    mutationError,
    form,
    formRules,
    drawerDirty,
    isSystemRole,
    selectedPermissionCount,
    permissionKeyword,
    selectedPermissionsOnly,
    filteredPermissionGroups,
    activePermissionModules,
    permissionSelectionError,
    loadRoles: rolesQuery.refresh,
    handleSearch,
    resetFilters,
    handleSortChange,
    handlePageChange,
    handlePageSizeChange,
    openCreate,
    openEdit,
    loadRoleDetail,
    normalizeCode,
    isGroupSelected,
    isGroupIndeterminate,
    toggleGroup,
    clearPermissionSelection,
    clearPermissionFilters,
    submitRole,
    formatDate
  };
}
