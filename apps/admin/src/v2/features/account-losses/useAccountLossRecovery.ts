import { computed, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isAccountLossRecoveryReasonValid } from './account-loss-recovery-form';
import { idBusinessV2AccountLossesApi } from './api';
import type { V2AccountLossRecord } from './contracts';

interface AccountLossRecoveryOptions {
  refreshRecords: () => Promise<unknown>;
}

export function useAccountLossRecovery(options: AccountLossRecoveryOptions) {
  const authStore = useAuthStore();
  const recoveryTarget = ref<V2AccountLossRecord | null>(null);
  const recoveryDialogVisible = ref(false);
  const recoverySubmitting = ref(false);
  const recoveryReason = ref('');
  const recoveryIdempotencyKey = ref('');
  const canRecover = computed(
    () =>
      hasUserPermission(authStore.user, 'apple.account.update') &&
      hasUserPermission(authStore.user, 'apple.balance.adjust')
  );
  const recoveryReasonValid = computed(() =>
    isAccountLossRecoveryReasonValid(recoveryReason.value)
  );

  function openRecovery(item: V2AccountLossRecord) {
    if (!canRecover.value || item.status !== 'active') return;
    recoveryTarget.value = item;
    recoveryReason.value = '';
    recoveryIdempotencyKey.value = `account-loss-recovery-${globalThis.crypto.randomUUID()}`;
    recoveryDialogVisible.value = true;
  }

  function setRecoveryDialogVisible(value: boolean) {
    if (!value && recoverySubmitting.value) return;
    recoveryDialogVisible.value = value;
    if (!value) recoveryTarget.value = null;
  }

  function setRecoveryReason(value: string) {
    recoveryReason.value = value;
  }

  async function confirmRecovery() {
    const target = recoveryTarget.value;
    if (
      !target ||
      target.status !== 'active' ||
      !canRecover.value ||
      !recoveryReasonValid.value ||
      recoverySubmitting.value
    ) {
      return;
    }

    recoverySubmitting.value = true;
    try {
      await idBusinessV2AccountLossesApi.recover(target.accountId, {
        reason: recoveryReason.value.trim(),
        expectedLossId: target.id,
        idempotencyKey: recoveryIdempotencyKey.value
      });
      ElMessage.success('ID 已恢复可用，原报损记录和财务冲回已保留');
      recoveryDialogVisible.value = false;
      recoveryTarget.value = null;
      await options.refreshRecords();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      recoverySubmitting.value = false;
    }
  }

  return {
    canRecover,
    recoveryTarget,
    recoveryDialogVisible,
    recoverySubmitting,
    recoveryReason,
    recoveryReasonValid,
    openRecovery,
    setRecoveryDialogVisible,
    setRecoveryReason,
    confirmRecovery
  };
}
