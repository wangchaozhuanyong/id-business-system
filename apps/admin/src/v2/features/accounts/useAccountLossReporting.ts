import { computed, ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2AccountsApi } from './api';
import { isAccountLossConfirmationValid } from './account-loss-form';
import type { V2Account } from './contracts';

interface AccountLossReportingOptions {
  canReportLoss: Readonly<Ref<boolean>>;
  refreshAccounts: () => Promise<unknown>;
}

export function useAccountLossReporting(options: AccountLossReportingOptions) {
  const lossTarget = ref<V2Account | null>(null);
  const lossDialogVisible = ref(false);
  const lossSubmitting = ref(false);
  const lossReason = ref('');
  const lossConfirmed = ref(false);
  const lossIdempotencyKey = ref('');
  const lossFormReady = computed(() =>
    isAccountLossConfirmationValid(lossReason.value, lossConfirmed.value)
  );

  function openReportLoss(item: V2Account) {
    if (!options.canReportLoss.value || item.lossStatus === 'reported') return;
    lossTarget.value = item;
    lossReason.value = '';
    lossConfirmed.value = false;
    lossIdempotencyKey.value = `account-loss-${globalThis.crypto.randomUUID()}`;
    lossDialogVisible.value = true;
  }

  async function confirmReportLoss() {
    const target = lossTarget.value;
    const reason = lossReason.value.trim();
    if (!target || !lossFormReady.value || lossSubmitting.value) return;

    lossSubmitting.value = true;
    try {
      await idBusinessV2AccountsApi.reportLoss(target.id, {
        reason,
        expectedCurrentBalance: target.currentBalance,
        expectedBalanceCostAmount: target.balanceCostAmount,
        idempotencyKey: lossIdempotencyKey.value
      });
      ElMessage.success('ID 已永久报损，余额与人民币成本已清零');
      lossDialogVisible.value = false;
      lossTarget.value = null;
      await options.refreshAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      lossSubmitting.value = false;
    }
  }

  return {
    lossTarget,
    lossDialogVisible,
    lossSubmitting,
    lossReason,
    lossConfirmed,
    lossFormReady,
    openReportLoss,
    confirmReportLoss
  };
}
