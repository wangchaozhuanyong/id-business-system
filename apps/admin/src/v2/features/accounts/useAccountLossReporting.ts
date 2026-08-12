import { ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2AccountsApi } from './api';
import { isAccountLossConfirmationValid, isAccountLossUnfreezeValid } from './account-loss-form';
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
  const unfreezeTarget = ref<V2Account | null>(null);
  const unfreezeDialogVisible = ref(false);
  const unfreezeSubmitting = ref(false);
  const unfreezeReason = ref('');
  const unfreezeIdempotencyKey = ref('');

  function openReportLoss(item: V2Account) {
    if (!options.canReportLoss.value || item.lossStatus === 'reported') return;
    lossTarget.value = item;
    lossReason.value = '';
    lossConfirmed.value = false;
    lossIdempotencyKey.value = `account-loss-${globalThis.crypto.randomUUID()}`;
    lossDialogVisible.value = true;
  }

  function openUnfreezeLoss(item: V2Account) {
    if (!options.canReportLoss.value || item.lossStatus !== 'reported' || !item.activeLossId) {
      return;
    }
    unfreezeTarget.value = item;
    unfreezeReason.value = '';
    unfreezeIdempotencyKey.value = `account-loss-unfreeze-${globalThis.crypto.randomUUID()}`;
    unfreezeDialogVisible.value = true;
  }

  async function confirmReportLoss() {
    const target = lossTarget.value;
    const reason = lossReason.value.trim();
    if (
      !target ||
      !isAccountLossConfirmationValid(lossReason.value, lossConfirmed.value) ||
      lossSubmitting.value
    ) {
      return;
    }

    lossSubmitting.value = true;
    try {
      await idBusinessV2AccountsApi.reportLoss(target.id, {
        reason,
        expectedCurrentBalance: target.currentBalance,
        expectedBalanceCostAmount: target.balanceCostAmount,
        idempotencyKey: lossIdempotencyKey.value
      });
      ElMessage.success(
        target.saleState === 'sold'
          ? '已售 ID 已报损冻结，仅剩余余额成本已计入损耗'
          : 'ID 已报损冻结，余额与人民币成本已计入损耗'
      );
      lossDialogVisible.value = false;
      lossTarget.value = null;
      await options.refreshAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      lossSubmitting.value = false;
    }
  }

  async function confirmUnfreezeLoss() {
    const target = unfreezeTarget.value;
    const reason = unfreezeReason.value.trim();
    if (
      !target ||
      !target.activeLossId ||
      !isAccountLossUnfreezeValid(unfreezeReason.value) ||
      unfreezeSubmitting.value
    ) {
      return;
    }

    unfreezeSubmitting.value = true;
    try {
      await idBusinessV2AccountsApi.unfreezeLoss(target.id, {
        reason,
        expectedLossId: target.activeLossId,
        idempotencyKey: unfreezeIdempotencyKey.value
      });
      ElMessage.success('ID 已解除报损冻结，损耗已自动冲回');
      unfreezeDialogVisible.value = false;
      unfreezeTarget.value = null;
      await options.refreshAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      unfreezeSubmitting.value = false;
    }
  }

  return {
    lossTarget,
    lossDialogVisible,
    lossSubmitting,
    lossReason,
    lossConfirmed,
    unfreezeTarget,
    unfreezeDialogVisible,
    unfreezeSubmitting,
    unfreezeReason,
    openReportLoss,
    openUnfreezeLoss,
    confirmReportLoss,
    confirmUnfreezeLoss
  };
}
