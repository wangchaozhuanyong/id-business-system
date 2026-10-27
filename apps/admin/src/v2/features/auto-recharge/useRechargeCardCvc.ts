import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { bankRechargeApi } from './bank-recharge-api';

/** 临时凭据只进入本次页面内存，不进入草稿或查询缓存。 */
export function useRechargeCardCvc(
  details: Ref<{ cvc: string }>,
  selectedCardId: Ref<string>,
  plan: Ref<string>
) {
  const message = ref('');
  let revision = 0;
  let disposed = false;
  let applying = false;
  let autofilled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    revision++;
    clearTimeout(timer);
    timer = undefined;
    if (autofilled) {
      applying = true;
      details.value.cvc = '';
      applying = false;
    }
    autofilled = false;
    message.value = '';
  }
  watch([selectedCardId, plan, sessionCoordinator.identityEpoch], clear, { flush: 'sync' });
  watch(
    () => details.value.cvc,
    () => {
      if (applying) return;
      revision++;
      clearTimeout(timer);
      autofilled = false;
      message.value = '';
    },
    { flush: 'sync' }
  );
  async function load(cardId: string, selectedPlan: string, current: () => boolean) {
    clear();
    const generation = revision;
    const epoch = sessionCoordinator.identityEpoch.value;
    const sameSelection = () =>
      !disposed &&
      generation === revision &&
      epoch === sessionCoordinator.identityEpoch.value &&
      selectedCardId.value === cardId &&
      plan.value === selectedPlan;
    const valid = () => sameSelection() && current();
    try {
      const result = await bankRechargeApi.sharedCardCvc(cardId, selectedPlan);
      if (!valid() || details.value.cvc) return;
      const expires = result.expiresAt ? Date.parse(result.expiresAt) : NaN;
      if (
        result.state !== 'available' ||
        !/^\d{3,4}$/.test(result.cvc ?? '') ||
        !Number.isFinite(expires) ||
        expires <= Date.now()
      ) {
        message.value =
          result.state === 'busy'
            ? '临时安全码正在被其他任务使用，请等待后重选或本次手动填写。'
            : '临时安全码不可用或已到期，请重新补充或本次手动填写。';
        return;
      }
      applying = true;
      details.value.cvc = result.cvc!;
      applying = false;
      autofilled = true;
      message.value = '已自动填写仍有效的临时安全码，仅供本次页面使用。';
      timer = setTimeout(
        () => {
          if (!sameSelection()) return;
          clear();
          message.value = '临时安全码已到期，请重新补充或本次手动填写。';
        },
        Math.min(expires - Date.now(), 86400000)
      );
    } catch {
      if (valid()) message.value = '未能读取临时安全码，请本次手动填写。';
    }
  }
  onScopeDispose(() => {
    clear();
    disposed = true;
  });
  return { message, load };
}
