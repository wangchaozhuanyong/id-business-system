import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { rechargeApi } from './api';
import type { V2RechargeJob } from './contracts';

export function useRechargeServerConfirmation(
  job: Ref<V2RechargeJob | undefined>,
  allowed: Ref<boolean>,
  refresh: () => void
) {
  const busy = ref(false);
  const message = ref('');
  const uncertain = ref(false);
  let generation = 0;
  const eligible = computed(
    () =>
      job.value?.action === 'server' &&
      job.value.state === 'awaiting_confirmation' &&
      job.value.result.manual_payment_confirmation === true
  );
  const confirmationEnabled = computed(
    () =>
      allowed.value &&
      eligible.value &&
      Boolean(job.value?.result.nonce) &&
      Boolean(job.value?.result.quote?.today) &&
      !busy.value &&
      !uncertain.value
  );
  function reset() {
    generation += 1;
    busy.value = false;
    message.value = '';
    uncertain.value = false;
  }
  async function confirm() {
    if (!confirmationEnabled.value) return;
    const id = job.value!.id;
    const nonce = job.value!.result.nonce!;
    const revision = generation;
    busy.value = true;
    try {
      await rechargeApi.confirmServer(id, nonce);
      if (revision !== generation || !allowed.value || job.value?.id !== id) return;
      uncertain.value = true;
      message.value = '本次确认已提交，请刷新核对原任务状态。';
      refresh();
    } catch {
      if (revision !== generation || !allowed.value || job.value?.id !== id) return;
      uncertain.value = true;
      message.value = '本次确认结果待核验，请刷新原任务状态。系统不会自动重复确认付款。';
    } finally {
      if (revision === generation) busy.value = false;
    }
  }
  watch(
    [() => job.value?.id, () => job.value?.result.nonce, allowed, sessionCoordinator.identityEpoch],
    reset,
    { flush: 'sync' }
  );
  onScopeDispose(reset);
  return { eligible, confirmationEnabled, busy, message, confirm };
}
