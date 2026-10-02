import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { v2EmployeesApi } from './api';
import type { V2Employee } from './contracts';

export function useEmployeeAccountActions(
  canManage: () => boolean,
  refresh: () => Promise<unknown>
) {
  const resetVisible = ref(false);
  const resetEmployee = ref<V2Employee | null>(null);
  // 密码只存在打开的输入窗口中，关闭、离页即清理，不进入会话草稿或浏览器存储。
  const resetPasswordForm = reactive({ password: '', confirmation: '' });
  const resetError = ref('');
  const resetting = ref(false);
  const deleteVisible = ref(false);
  const deleteEmployee = ref<V2Employee | null>(null);
  const deleteError = ref('');
  const deleting = ref(false);
  const deleteQuery = useV2ModuleQuery({
    moduleKey: 'employees',
    scope: 'employees',
    trackRouteData: false,
    enabled: () => deleteVisible.value && Boolean(deleteEmployee.value),
    key: () =>
      createV2QueryKey({
        operation: 'delete-preview',
        id: deleteEmployee.value?.id,
        version: deleteEmployee.value?.updatedAt
      }),
    query: ({ signal }) => v2EmployeesApi.deletePreview(deleteEmployee.value!.id, { signal })
  });
  const preview = computed(() => deleteQuery.data.value);
  const previewError = computed(() =>
    deleteQuery.error.value ? getApiErrorMessage(deleteQuery.error.value) : ''
  );
  const resetDirty = computed(() =>
    Boolean(resetPasswordForm.password || resetPasswordForm.confirmation)
  );
  const resetDisabledReason = computed(() => {
    if (!resetEmployee.value) return '请选择员工账号';
    if (resetPasswordForm.password.length < 8 || resetPasswordForm.password.length > 160)
      return '新密码长度需为 8 至 160 位';
    if (resetPasswordForm.password !== resetPasswordForm.confirmation)
      return '两次输入的密码不一致';
    return '';
  });
  const deleteDisabledReason = computed(() => {
    if (deleteQuery.isInitialLoading.value || deleteQuery.isRefreshing.value)
      return '正在核对删除影响';
    if (
      previewError.value ||
      !preview.value ||
      preview.value.employee.id !== deleteEmployee.value?.id
    )
      return '请先完成删除预检查';
    return preview.value.blockers.join(' ');
  });

  function clearPassword() {
    resetPasswordForm.password = '';
    resetPasswordForm.confirmation = '';
  }
  watch(resetVisible, (visible) => {
    if (!visible) clearPassword();
  });
  onUnmounted(clearPassword);
  function openReset(employee: V2Employee) {
    if (!canManage() || employee.isSystemSuperAdmin || resetting.value) return;
    clearPassword();
    resetError.value = '';
    resetEmployee.value = employee;
    resetVisible.value = true;
  }
  function openDelete(employee: V2Employee) {
    if (!canManage() || employee.isSystemSuperAdmin || deleting.value) return;
    deleteEmployee.value = employee;
    deleteError.value = '';
    deleteVisible.value = true;
    void deleteQuery.refresh();
  }
  async function resetPassword() {
    const employee = resetEmployee.value;
    if (!canManage() || !employee || resetting.value || resetDisabledReason.value) return;
    resetting.value = true;
    resetError.value = '';
    try {
      await v2EmployeesApi.resetPassword(employee.id, {
        expectedUpdatedAt: employee.updatedAt,
        newPassword: resetPasswordForm.password
      });
      resetVisible.value = false;
      clearPassword();
      ElMessage.success('密码已重置，旧会话已撤销，下次登录必须修改密码');
      await refresh();
    } catch (error) {
      resetError.value = getApiErrorMessage(error);
    } finally {
      resetting.value = false;
    }
  }
  async function removeEmployee() {
    const impact = preview.value;
    if (
      !canManage() ||
      !impact ||
      deleting.value ||
      deleteDisabledReason.value ||
      !impact.canDelete
    )
      return;
    deleting.value = true;
    deleteError.value = '';
    try {
      await v2EmployeesApi.remove(impact.employee.id, {
        expectedUpdatedAt: impact.expectedUpdatedAt,
        previewHash: impact.previewHash
      });
      deleteVisible.value = false;
      ElMessage.success('账号已删除，业务已由超级管理员接管');
      await refresh();
    } catch (error) {
      deleteError.value = getApiErrorMessage(error);
      await deleteQuery.refresh();
    } finally {
      deleting.value = false;
    }
  }
  return {
    resetVisible,
    resetEmployee,
    resetPasswordForm,
    resetError,
    resetting,
    resetDirty,
    resetDisabledReason,
    deleteVisible,
    deleteEmployee,
    deleteError,
    deleting,
    preview,
    previewError,
    deleteDisabledReason,
    previewPhase: deleteQuery.phase,
    openReset,
    openDelete,
    resetPassword,
    removeEmployee,
    refreshPreview: deleteQuery.refresh
  };
}
