import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { bankRechargeApi } from './bank-recharge-api';
import { rechargeFieldError } from './recharge-form';
import type { V2RechargeDetails, V2RechargeAddress } from './contracts';
import { getApiErrorMessage } from '@/api/client';

export function useRechargeNameMatch(
  details: Ref<V2RechargeDetails>,
  selectedCardId: Ref<string>,
  locked: Ref<boolean>,
  allocation?: {
    request: () => { allocationKey: string; addressId?: string };
    apply: (value: { id: string; address: V2RechargeAddress }) => void;
  }
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

  async function match(force = false) {
    const number = canonical();
    if (rechargeFieldError('number', number)) return;
    if (
      !force &&
      lastMatchedNumber === number &&
      !error.value &&
      details.value.name &&
      (!confirmed.value || details.value.name === matchedName)
    )
      return;
    if (!force && pending && matchingNumber === number) return pending;
    const revision = ++generation;
    matchingNumber = number;
    const originalName = details.value.name;
    loading.value = true;
    error.value = '';
    const work = (async () => {
      try {
        const result = allocation
          ? await bankRechargeApi.matchCardName(number, allocation.request())
          : await bankRechargeApi.matchCardName(number);
        if (disposed || revision !== generation || canonical() !== number) return;
        applying.value = true;
        try {
          lastMatchedNumber = number;
          confirmed.value = result.confirmed;
          selectedCardId.value = result.cardId ?? '';
          if (result.allocationId && result.address)
            allocation?.apply({ id: result.allocationId, address: result.address });
          if (
            result.allocationId ||
            result.confirmed ||
            details.value.name === originalName ||
            !details.value.name
          ) {
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
        if (details.value.name === matchedName) details.value.name = '';
      }
      if (!locked.value) void match();
    },
    { immediate: true, flush: 'sync' }
  );
  watch(
    locked,
    (value) => {
      // 已保存银行卡加载时卡号先写入，解锁后再补齐暂停的姓名匹配。
      if (!value && !error.value) void match();
    },
    { flush: 'sync' }
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
