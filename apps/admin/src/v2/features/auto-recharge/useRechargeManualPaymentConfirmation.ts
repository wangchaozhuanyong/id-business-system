import { ref } from 'vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';

export function useRechargeManualPaymentConfirmation() {
  return useV2SessionDraft('auto-recharge-manual-payment-confirmation', () => ref(false));
}
