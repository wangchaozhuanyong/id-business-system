import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { bankRechargeApi } from './bank-recharge-api';
import { rechargeFieldError } from './recharge-form';
import type { V2RechargeDetails } from './contracts';
import { getApiErrorMessage } from '@/api/client';

export function useRechargeNameMatch(
  details: Ref<V2RechargeDetails>,
  selectedCardId: Ref<string>,
  locked: Ref<boolean>,
  onAddress: (value: string | null, expectedManualRevision?: number) => void,
  readManualAddressRevision?: () => number
) {
  const loading = ref(false);
  const error = ref('');
  const confirmed = ref(false);
  const applying = ref(false);
  let generation = 0;
  let disposed = false;
  let matchingNumber = '';
  let pending: Promise<void> | null = null;
  let matchedName = '';
  let lastMatchedNumber = '';
  const canonical = () => details.value.number.replace(/[ -]/g, '');

  async function match() {
    const number = canonical();
    if (rechargeFieldError('number', number)) return;
    if (
      lastMatchedNumber === number &&
      !error.value &&
      details.value.name &&
      (!confirmed.value || details.value.name === matchedName)
    )
      return;
    if (pending && matchingNumber === number) return pending;
    const revision = ++generation;
    matchingNumber = number;
    const originalName = details.value.name;
    const manualAddressRevision = readManualAddressRevision?.();
    loading.value = true;
    error.value = '';
    const work = (async () => {
      try {
        const result = await bankRechargeApi.matchCardName(number);
        if (disposed || revision !== generation || canonical() !== number) return;
        applying.value = true;
        try {
          lastMatchedNumber = number;
          confirmed.value = result.confirmed;
          selectedCardId.value = result.cardId ?? '';
          onAddress(result.billingAddressId, manualAddressRevision);
          if (result.confirmed || details.value.name === originalName || !details.value.name) {
            details.value.name = result.name;
            matchedName = result.name;
          }
        } finally {
          applying.value = false;
        }
      } catch (cause) {
        if (!disposed && revision === generation) error.value = getApiErrorMessage(cause);
      } finally {
        if (!disposed && revision === generation) {
          loading.value = false;
          pending = null;
        }
      }
    })();
    pending = work;
    return work;
  }
  watch(
    canonical,
    (number, previous) => {
      generation++;
      lastMatchedNumber = '';
      pending = null;
      loading.value = false;
      error.value = '';
      confirmed.value = false;
      if (previous && number !== previous) {
        selectedCardId.value = '';
        onAddress(null);
        if (details.value.name === matchedName) details.value.name = '';
      }
      if (!locked.value) void match();
    },
    { immediate: true, flush: 'sync' }
  );
  onScopeDispose(() => {
    disposed = true;
    generation++;
  });
  return {
    loading,
    error,
    confirmed,
    applying,
    retry: match,
    async ensureReady() {
      await match();
      if (error.value) throw new Error(error.value);
    }
  };
}
