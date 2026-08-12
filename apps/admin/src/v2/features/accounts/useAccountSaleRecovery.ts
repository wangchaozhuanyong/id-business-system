import { computed, ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2AccountsApi } from './api';
import type { V2Account, V2SoldAccountRecoveryPreview } from './contracts';

interface AccountSaleRecoveryOptions {
  canUpdate: Readonly<Ref<boolean>>;
  refreshAccounts: () => Promise<unknown>;
}

export function useAccountSaleRecovery(options: AccountSaleRecoveryOptions) {
  const saleRecoveryTarget = ref<V2Account | null>(null);
  const saleRecoveryDialogVisible = ref(false);
  const saleRecoveryReason = ref('');
  const saleRecoverySubmitting = ref(false);
  const saleRecoveryLoading = ref(false);
  const saleRecoveryError = ref('');
  const saleRecoveryPreview = ref<V2SoldAccountRecoveryPreview | null>(null);
  const saleRecoveryReasonValid = computed(() => {
    const length = saleRecoveryReason.value.trim().length;
    return length >= 2 && length <= 200;
  });

  async function loadSaleRecoveryPreview() {
    const target = saleRecoveryTarget.value;
    if (!target?.soldByOrder || saleRecoveryLoading.value) return;
    saleRecoveryPreview.value = null;
    saleRecoveryError.value = '';
    saleRecoveryLoading.value = true;
    try {
      saleRecoveryPreview.value = await idBusinessV2AccountsApi.previewSoldAccountRecovery(
        target.id,
        target.soldByOrder.id
      );
    } catch (error) {
      saleRecoveryError.value = getApiErrorMessage(error);
    } finally {
      saleRecoveryLoading.value = false;
    }
  }

  async function openSaleRecovery(item: V2Account) {
    if (!options.canUpdate.value) return;
    if (item.lossStatus === 'reported') {
      ElMessage.warning('已报损冻结 ID 不能恢复为可用');
      return;
    }
    if (item.saleState !== 'sold' || !item.soldByOrder) {
      ElMessage.warning('该 ID 已不是卖出状态，请刷新后核对');
      return;
    }
    saleRecoveryTarget.value = item;
    saleRecoveryReason.value = '';
    saleRecoveryDialogVisible.value = true;
    await loadSaleRecoveryPreview();
  }

  async function confirmSaleRecovery() {
    const target = saleRecoveryTarget.value;
    if (
      !target?.soldByOrder ||
      !saleRecoveryReasonValid.value ||
      !saleRecoveryPreview.value?.canRecover ||
      saleRecoverySubmitting.value
    ) {
      return;
    }
    saleRecoverySubmitting.value = true;
    try {
      await idBusinessV2AccountsApi.recoverSoldAccount(
        target.id,
        target.soldByOrder.id,
        saleRecoveryReason.value.trim()
      );
      ElMessage.success('ID 已恢复为库存归属');
      saleRecoveryDialogVisible.value = false;
      saleRecoveryTarget.value = null;
      await options.refreshAccounts();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      saleRecoverySubmitting.value = false;
    }
  }

  return {
    saleRecoveryTarget,
    saleRecoveryDialogVisible,
    saleRecoveryReason,
    saleRecoverySubmitting,
    saleRecoveryLoading,
    saleRecoveryError,
    saleRecoveryPreview,
    saleRecoveryReasonValid,
    openSaleRecovery,
    loadSaleRecoveryPreview,
    confirmSaleRecovery
  };
}
