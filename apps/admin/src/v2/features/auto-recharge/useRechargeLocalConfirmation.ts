import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { rechargeApi, rechargeConnectorApi } from './api';
import type { V2RechargeJob } from './contracts';
import { directPaymentControls } from './direct-payment-task';

export function useRechargeLocalConfirmation(
  job: Ref<V2RechargeJob | undefined>,
  refresh: () => void
) {
  // 单次确认凭据仅保留当前组件内存，不进入业务查询、草稿或浏览器存储。
  const nonce = ref('');
  const digest = ref('');
  const expiresAt = ref('');
  const loading = ref(false);
  const busy = ref(false);
  const message = ref('');
  const uncertain = ref(false);
  let generation = 0;
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimerVersion = 0;
  const sentJobs = new Set<string>();
  let identityEpoch = sessionCoordinator.identityEpoch.value;
  const eligible = computed(
    () => job.value?.action === 'bitbrowser' && job.value.state === 'awaiting_confirmation'
  );
  const confirmationEnabled = computed(() => {
    if (job.value?.result.transport === 'web_direct') {
      const control = directPaymentControls.get(job.value.id);
      return Boolean(
        !disposed &&
        identityEpoch === sessionCoordinator.identityEpoch.value &&
        eligible.value &&
        control?.pending &&
        !control.confirming &&
        control.digest === job.value.result.quote_digest &&
        Date.parse(control.expiresAt) > Date.now() &&
        job.value.result.account_matched === true &&
        job.value.result.quote?.plan === job.value.plan &&
        ['official_checkout_response', 'official_upgrade_preview'].includes(
          job.value.result.quote_authority ?? ''
        ) &&
        job.value.result.payment_attempted !== true &&
        Number(job.value.result.payment_requests_sent ?? 0) === 0 &&
        Number(job.value.result.confirmation_requests_sent ?? 0) === 0 &&
        Boolean(job.value.result.quote?.today) &&
        !busy.value
      );
    }
    return (
      eligible.value &&
      job.value?.result.account_matched === true &&
      ['official_checkout_response', 'official_upgrade_preview'].includes(
        job.value?.result.quote_authority ?? ''
      ) &&
      job.value?.result.quote?.plan === job.value?.plan &&
      job.value?.result.payment_attempted !== true &&
      Number(job.value?.result.payment_requests_sent ?? 0) === 0 &&
      Number(job.value?.result.confirmation_requests_sent ?? 0) === 0 &&
      Boolean(nonce.value && digest.value && job.value?.result.quote?.today) &&
      digest.value === job.value?.result.quote_digest &&
      !loading.value &&
      !busy.value &&
      !uncertain.value &&
      !sentJobs.has(job.value?.id ?? '')
    );
  });

  function clearExpiryTimer() {
    expiryTimerVersion++;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  function expireConfirmation(text: string) {
    clearExpiryTimer();
    nonce.value = '';
    digest.value = '';
    message.value = text;
  }

  function syncExpiry() {
    clearExpiryTimer();
    if (disposed || !eligible.value || !nonce.value || !digest.value || uncertain.value) return;
    const remaining = Date.parse(expiresAt.value) - Date.now();
    if (!(remaining > 0)) {
      expireConfirmation('本次报价确认已过期，请刷新原任务；尚未发送付款确认。');
      return;
    }
    const revision = generation;
    const timerVersion = expiryTimerVersion;
    const id = job.value?.id;
    const expectedNonce = nonce.value;
    const expectedDigest = digest.value;
    const expectedExpiry = expiresAt.value;
    expiryTimer = setTimeout(
      () => {
        if (
          disposed ||
          revision !== generation ||
          timerVersion !== expiryTimerVersion ||
          job.value?.id !== id ||
          nonce.value !== expectedNonce ||
          digest.value !== expectedDigest ||
          expiresAt.value !== expectedExpiry
        )
          return;
        syncExpiry();
      },
      Math.min(remaining, 2_147_483_647)
    );
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') syncExpiry();
  }

  function reset() {
    generation++;
    clearExpiryTimer();
    nonce.value = '';
    digest.value = '';
    expiresAt.value = '';
    loading.value = false;
    busy.value = false;
    uncertain.value = sentJobs.has(job.value?.id ?? '');
    message.value = uncertain.value
      ? '本次确认已发送，结果待核验。系统不会重复发送付款确认，请刷新原任务。'
      : '';
  }

  async function readConfirmation() {
    if (job.value?.result.transport === 'web_direct') {
      const control = directPaymentControls.get(job.value.id);
      digest.value = control?.digest ?? '';
      expiresAt.value = control?.expiresAt ?? '';
      message.value = control?.message ?? '请在启动本次充值的原网页确认；刷新或关闭后需重新核价。';
      return;
    }
    if (
      disposed ||
      !eligible.value ||
      !job.value ||
      loading.value ||
      busy.value ||
      uncertain.value ||
      sentJobs.has(job.value.id)
    )
      return;
    const id = job.value.id;
    const expectedDigest = job.value.result.quote_digest;
    const revision = generation;
    loading.value = true;
    message.value = '';
    try {
      const access = await rechargeApi.bitBrowserAccess(id);
      if (
        disposed ||
        revision !== generation ||
        job.value?.id !== id ||
        !eligible.value ||
        job.value.result.quote_digest !== expectedDigest
      )
        return;
      const local = await rechargeConnectorApi.status(
        access.connectorUrl,
        access.connectorToken,
        id
      );
      if (
        disposed ||
        revision !== generation ||
        job.value?.id !== id ||
        !eligible.value ||
        job.value.result.quote_digest !== expectedDigest
      )
        return;
      const result = local.result as Record<string, unknown> | undefined;
      if (
        local.status !== 'awaiting_confirmation' ||
        result?.status !== 'awaiting_confirmation' ||
        typeof result.nonce !== 'string' ||
        !result.nonce ||
        typeof result.quote_digest !== 'string' ||
        result.quote_digest !== expectedDigest ||
        typeof result.confirmation_expires_at !== 'string' ||
        !(Date.parse(result.confirmation_expires_at) > Date.now())
      ) {
        throw new Error('本机报价确认状态已变化，请刷新原任务重新核对。');
      }
      nonce.value = result.nonce;
      digest.value = result.quote_digest;
      expiresAt.value = result.confirmation_expires_at;
      syncExpiry();
    } catch (cause) {
      if (revision === generation && !disposed)
        message.value =
          cause instanceof Error ? cause.message : '无法连接本机充值助手，请检查后刷新确认状态。';
    } finally {
      if (revision === generation) loading.value = false;
    }
  }

  async function confirm() {
    if (job.value?.result.transport === 'web_direct') {
      const control = directPaymentControls.get(job.value.id);
      if (!confirmationEnabled.value || !control) return;
      busy.value = true;
      try {
        await control.confirm();
        message.value = directPaymentControls.get(job.value.id)?.message ?? '';
      } finally {
        busy.value = false;
        refresh();
      }
      return;
    }
    if (!confirmationEnabled.value || !job.value) return;
    if (!(Date.parse(expiresAt.value) > Date.now())) {
      expireConfirmation('本次报价确认已过期，请刷新原任务；本次未重新授权付款。');
      return;
    }
    const id = job.value.id;
    const singleNonce = nonce.value;
    const quoteDigest = digest.value;
    const revision = generation;
    busy.value = true;
    let invoked = false;
    try {
      const access = await rechargeApi.bitBrowserAccess(id);
      if (
        disposed ||
        revision !== generation ||
        job.value?.id !== id ||
        !eligible.value ||
        job.value.result.quote_digest !== quoteDigest ||
        nonce.value !== singleNonce ||
        job.value.result.account_matched !== true ||
        !['official_checkout_response', 'official_upgrade_preview'].includes(
          job.value.result.quote_authority ?? ''
        ) ||
        job.value.result.quote?.plan !== job.value.plan ||
        !job.value.result.quote?.today ||
        job.value.result.payment_attempted === true ||
        Number(job.value.result.payment_requests_sent ?? 0) !== 0 ||
        Number(job.value.result.confirmation_requests_sent ?? 0) !== 0 ||
        sentJobs.has(id)
      )
        return;
      if (!(Date.parse(expiresAt.value) > Date.now())) {
        expireConfirmation('本次报价确认已过期，请刷新原任务；尚未发送付款确认。');
        return;
      }
      // 只有真正调用本机确认接口才消费凭据；发送标记不随状态或报价回跳清除。
      sentJobs.add(id);
      invoked = true;
      uncertain.value = true;
      clearExpiryTimer();
      nonce.value = '';
      await rechargeConnectorApi.confirm(
        access.connectorUrl,
        access.connectorToken,
        id,
        singleNonce,
        quoteDigest
      );
      if (revision !== generation || disposed) return;
      message.value = '已确认本次报价，充值助手将重新核对金额并最多提交一次付款。';
      refresh();
    } catch {
      if (revision !== generation || disposed) return;
      message.value = invoked
        ? '本次确认结果待核验，请刷新原任务。系统不会重复发送付款确认。'
        : '无法读取原任务连接信息，尚未发送付款确认。请刷新确认状态后重试。';
    } finally {
      if (revision === generation) busy.value = false;
    }
  }

  watch(
    [
      () => job.value?.id,
      () => job.value?.state,
      () => job.value?.result.quote_digest,
      sessionCoordinator.identityEpoch
    ],
    () => {
      if (identityEpoch !== sessionCoordinator.identityEpoch.value) {
        identityEpoch = sessionCoordinator.identityEpoch.value;
        sentJobs.clear();
      }
      reset();
      void readConfirmation();
    },
    { immediate: true, flush: 'sync' }
  );
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', handleVisibilityChange);
  onScopeDispose(() => {
    disposed = true;
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    sentJobs.clear();
    reset();
  });
  return {
    eligible,
    confirmationEnabled,
    loading,
    busy,
    message,
    expiresAt,
    readConfirmation,
    confirm
  };
}
