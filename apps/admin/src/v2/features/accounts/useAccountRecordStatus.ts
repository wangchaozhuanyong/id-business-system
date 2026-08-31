import { computed, ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2AccountsApi } from './api';
import { isAccountRecordStatusReasonValid } from './account-record-status-form';
import type { V2Account } from './contracts';

interface AccountRecordStatusOptions {
  canUpdate: Readonly<Ref<boolean>>;
  refreshAccounts: () => Promise<unknown>;
}

export function useAccountRecordStatus(options: AccountRecordStatusOptions) {
  const recordStatusTarget = ref<V2Account | null>(null);
  const recordStatusDialogVisible = ref(false);
  const recordStatusDialogMode = ref<'change' | 'view'>('change');
  const recordStatusReason = ref('');
  const recordStatusSubmitting = ref(false);
  const targetRecordStatus = computed(() =>
    recordStatusTarget.value?.recordStatus === 'active' ? 'disabled' : 'active'
  );
  const recordStatusReasonValid = computed(() =>
    isAccountRecordStatusReasonValid(recordStatusReason.value)
  );

  function openRecordStatusChange(item: V2Account) {
    if (!options.canUpdate.value || item.lossStatus === 'reported') {
      ElMessage.warning('已报损冻结 ID 不能启用或停用');
      return;
    }
    recordStatusTarget.value = item;
    recordStatusDialogMode.value = 'change';
    recordStatusReason.value = '';
    recordStatusDialogVisible.value = true;
  }

  function openDisabledReason(item: V2Account) {
    if (item.recordStatus !== 'disabled') return;
    recordStatusTarget.value = item;
    recordStatusDialogMode.value = 'view';
    recordStatusReason.value = '';
    recordStatusDialogVisible.value = true;
  }

  async function confirmRecordStatusChange() {
    const target = recordStatusTarget.value;
    if (
      !target ||
      recordStatusDialogMode.value !== 'change' ||
      !recordStatusReasonValid.value ||
      recordStatusSubmitting.value
    ) {
      return;
    }
    recordStatusSubmitting.value = true;
    try {
      await idBusinessV2AccountsApi.changeRecordStatus(target.id, {
        expectedUpdatedAt: target.updatedAt,
        recordStatus: targetRecordStatus.value,
        reason: recordStatusReason.value.trim()
      });
      ElMessage.success(targetRecordStatus.value === 'disabled' ? 'ID 已停用' : 'ID 已恢复启用');
      recordStatusDialogVisible.value = false;
      recordStatusTarget.value = null;
      await options.refreshAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      recordStatusSubmitting.value = false;
    }
  }

  return {
    recordStatusTarget,
    recordStatusDialogVisible,
    recordStatusDialogMode,
    recordStatusReason,
    recordStatusSubmitting,
    targetRecordStatus,
    recordStatusReasonValid,
    openRecordStatusChange,
    openDisabledReason,
    confirmRecordStatusChange
  };
}
