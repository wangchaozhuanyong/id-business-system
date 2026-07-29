import { computed, ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2BalancesApi } from './api';
import type { V2GiftCardRecord, V2GiftCardReversalAction } from './contracts';
import {
  buildGiftCardReversalPayload,
  canOfferGiftCardAccountLoss,
  getGiftCardReversalCopy,
  type PendingGiftCardReversal
} from './gift-card-reversal-form';

interface GiftCardReversalOptions {
  canAdjustBalance: Readonly<Ref<boolean>>;
  canReportAccountLoss: Readonly<Ref<boolean>>;
  reloadGiftCards: () => Promise<void>;
}

export function useGiftCardReversal(options: GiftCardReversalOptions) {
  const reversalDialogVisible = ref(false);
  const reversalSubmitting = ref(false);
  const pendingReversal = ref<PendingGiftCardReversal | null>(null);
  const reversalReason = ref('');
  const reversalIdempotencyKey = ref('');
  const reportAccountLoss = ref(false);
  const showAccountLossOption = computed(() =>
    canOfferGiftCardAccountLoss(pendingReversal.value, options.canReportAccountLoss.value)
  );
  const copy = computed(() =>
    getGiftCardReversalCopy(pendingReversal.value, reportAccountLoss.value)
  );
  const reversalDialogTitle = computed(() => copy.value.title);
  const reversalConfirmText = computed(() => copy.value.confirmText);
  const reversalMessage = computed(() => copy.value.message);

  function openReversalConfirmation(giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction) {
    if (
      !options.canAdjustBalance.value ||
      giftCard.status !== 'credited' ||
      giftCard.account.lossStatus === 'reported'
    ) {
      return;
    }
    pendingReversal.value = { giftCard, action };
    reversalReason.value = '';
    reversalIdempotencyKey.value = globalThis.crypto.randomUUID();
    reportAccountLoss.value = false;
    reversalDialogVisible.value = true;
  }

  async function submitReversal() {
    const pending = pendingReversal.value;
    const reason = reversalReason.value.trim();
    if (!pending || reason.length < 2 || reversalSubmitting.value) return;

    reversalSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.reverseGiftCard(
        pending.giftCard.id,
        buildGiftCardReversalPayload(
          pending,
          reason,
          reversalIdempotencyKey.value,
          reportAccountLoss.value && showAccountLossOption.value
        )
      );
      const successMessage = result.accountLoss
        ? '礼品卡已被赎回，该 ID 已永久报损并清零'
        : result.action === 'redeemed'
          ? '礼品卡已标记被赎回，反向流水已生成'
          : '礼品卡已撤回，反向流水已生成';
      ElMessage.success(
        result.idempotentReplay ? `该请求已经完成：${successMessage}` : successMessage
      );
      reversalDialogVisible.value = false;
      pendingReversal.value = null;
      await options.reloadGiftCards();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      reversalSubmitting.value = false;
    }
  }

  return {
    reversalDialogVisible,
    reversalSubmitting,
    reversalReason,
    reportAccountLoss,
    showAccountLossOption,
    reversalDialogTitle,
    reversalConfirmText,
    reversalMessage,
    openReversalConfirmation,
    submitReversal
  };
}
