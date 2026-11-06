import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { V2_RECHARGE_SUBSCRIPTION_CYCLE_CAPABILITY } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi, rechargeConnectorApi } from './api';
import type { V2RechargeJob } from './contracts';
import { ownsDirectPayment } from './direct-payment-task';

export function useRechargeNextCycle(
  job: Ref<V2RechargeJob | undefined>,
  apiSupportsCycle: Ref<boolean>,
  refresh: () => void
) {
  const dialogOpen = ref(false);
  const busy = ref(false);
  const message = ref('');
  const now = ref(Date.now());
  const jobEpoch = ref(sessionCoordinator.identityEpoch.value);
  let disposed = false;
  let generation = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let sending: AbortController | undefined;
  let opened: { id: string; digest: string; epoch: number } | undefined;
  const submitted = new Set<string>();
  const review = computed(() => job.value?.result.cycle_review);
  const expired = computed(() =>
    review.value ? !(Date.parse(review.value.expiresAt) > now.value) : false
  );
  const key = () => `${job.value?.id}:${review.value?.reviewDigest}`;
  const candidate = computed(
    () =>
      !disposed &&
      jobEpoch.value === sessionCoordinator.identityEpoch.value &&
      apiSupportsCycle.value &&
      job.value?.action === 'bitbrowser' &&
      job.value.result.mode !== 'open_browser' &&
      job.value.result.stage === 'next_subscription_cycle_review' &&
      ['running', 'awaiting_human_verification'].includes(job.value.state) &&
      review.value?.protocol === 1 &&
      review.value.status === 'awaiting_previous_cycle_confirmation' &&
      Boolean(review.value.reviewDigest) &&
      Date.parse(review.value.expiresAt) > now.value &&
      job.value.result.account_matched === true &&
      job.value.result.payment_attempted !== true &&
      Number(job.value.result.payment_requests_sent ?? 0) === 0 &&
      Number(job.value.result.confirmation_requests_sent ?? 0) === 0
  );
  const capabilityQuery = useV2ModuleQuery({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    trackRouteData: false,
    enabled: () => candidate.value,
    key: () =>
      createV2QueryKey({
        action: 'next-cycle-capability',
        id: job.value?.id,
        digest: review.value?.reviewDigest,
        epoch: jobEpoch.value
      }),
    query: async ({ signal }) => {
      const id = job.value!.id;
      const digest = review.value!.reviewDigest;
      const epoch = jobEpoch.value;
      if (job.value?.result.transport === 'web_direct')
        return { id, digest, epoch, supported: ownsDirectPayment(id) };
      const access = await rechargeApi.bitBrowserAccess(id, { signal });
      try {
        if (signal.aborted || epoch !== sessionCoordinator.identityEpoch.value)
          throw new DOMException('原任务所属身份已变化', 'AbortError');
        // 正在等待核实的原任务可以占用助手；这里仅核对能力，不启动新任务。
        const health = await rechargeConnectorApi.health(access.connectorUrl, signal, true);
        return {
          id,
          digest,
          epoch,
          supported:
            Array.isArray(health.capabilities) &&
            health.capabilities.includes(V2_RECHARGE_SUBSCRIPTION_CYCLE_CAPABILITY)
        };
      } finally {
        access.connectorToken = '';
      }
    }
  });
  const supported = computed(() => {
    const capability = capabilityQuery.data.value;
    return (
      capabilityQuery.phase.value === 'ready' &&
      capability?.supported === true &&
      capability.id === job.value?.id &&
      capability.digest === review.value?.reviewDigest &&
      capability.epoch === sessionCoordinator.identityEpoch.value
    );
  });
  const canOpen = computed(
    () => candidate.value && supported.value && !busy.value && !submitted.has(key())
  );
  const canConfirm = computed(
    () =>
      dialogOpen.value &&
      canOpen.value &&
      opened !== undefined &&
      opened.id === job.value?.id &&
      opened.digest === review.value?.reviewDigest &&
      opened.epoch === sessionCoordinator.identityEpoch.value
  );
  const confirmationBlocked = computed(() => !canConfirm.value);
  function open() {
    if (!canOpen.value || !job.value || !review.value) return;
    opened = {
      id: job.value.id,
      digest: review.value.reviewDigest,
      epoch: sessionCoordinator.identityEpoch.value
    };
    message.value = '';
    dialogOpen.value = true;
  }
  async function confirm() {
    if (!canConfirm.value || !job.value || !review.value) return;
    if (!(Date.parse(review.value.expiresAt) > Date.now())) {
      now.value = Date.now();
      message.value = '本次旧周期核实已过期，请刷新原任务重新核对。';
      return;
    }
    const id = job.value.id;
    const digest = review.value.reviewDigest;
    const epoch = sessionCoordinator.identityEpoch.value;
    const revision = generation;
    const controller = new AbortController();
    sending = controller;
    busy.value = true;
    submitted.add(key());
    try {
      await rechargeApi.confirmNextCycle(
        id,
        { reviewDigest: digest, confirmedPreviousCycleEnded: true },
        { signal: controller.signal }
      );
      if (
        disposed ||
        revision !== generation ||
        epoch !== sessionCoordinator.identityEpoch.value ||
        job.value?.id !== id ||
        review.value?.reviewDigest !== digest
      )
        return;
      dialogOpen.value = false;
      message.value =
        '旧周期核实已提交，执行页面将再次读取当前订阅；后续仍须核对官网报价并确认本次付款。';
      refresh();
    } catch (cause) {
      if (
        disposed ||
        revision !== generation ||
        epoch !== sessionCoordinator.identityEpoch.value ||
        job.value?.id !== id ||
        review.value?.reviewDigest !== digest
      )
        return;
      message.value = `${getApiErrorMessage(cause)} 旧周期核实结果待核对，请刷新原任务；本次不会重复提交核实。`;
    } finally {
      if (sending === controller) sending = undefined;
      if (revision === generation && epoch === sessionCoordinator.identityEpoch.value && !disposed)
        busy.value = false;
    }
  }
  watch(
    () => [
      job.value?.id,
      review.value?.reviewDigest,
      review.value?.expiresAt,
      review.value?.status
    ],
    () => {
      clearTimeout(expiryTimer);
      now.value = Date.now();
      const remaining = Date.parse(review.value?.expiresAt ?? '') - Date.now();
      if (remaining > 0)
        expiryTimer = setTimeout(
          () => {
            now.value = Date.now();
          },
          Math.min(remaining, 300_000)
        );
      if (
        opened &&
        (opened.id !== job.value?.id ||
          opened.digest !== review.value?.reviewDigest ||
          review.value?.status !== 'awaiting_previous_cycle_confirmation')
      ) {
        dialogOpen.value = false;
        opened = undefined;
      }
    },
    { immediate: true, flush: 'sync' }
  );
  watch(
    job,
    (value, previous) => {
      if (value !== previous && jobEpoch.value !== sessionCoordinator.identityEpoch.value)
        jobEpoch.value = sessionCoordinator.identityEpoch.value;
      if (value?.id !== previous?.id) {
        generation++;
        sending?.abort();
        dialogOpen.value = false;
        busy.value = false;
        opened = undefined;
        message.value = '';
      }
    },
    { flush: 'sync' }
  );
  watch(
    sessionCoordinator.identityEpoch,
    () => {
      generation++;
      jobEpoch.value = -1;
      sending?.abort();
      dialogOpen.value = false;
      busy.value = false;
      opened = undefined;
      message.value = '';
      submitted.clear();
    },
    { flush: 'sync' }
  );
  onScopeDispose(() => {
    disposed = true;
    generation++;
    clearTimeout(expiryTimer);
    sending?.abort();
    opened = undefined;
    submitted.clear();
  });
  return {
    review,
    expired,
    candidate,
    capabilityQuery,
    supported,
    canOpen,
    canConfirm,
    confirmationBlocked,
    dialogOpen,
    busy,
    message,
    open,
    confirm
  };
}
