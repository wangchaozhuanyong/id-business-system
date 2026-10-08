import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { rechargeApi, rechargeConnectorApi } from './api';
import type { V2RechargeJob } from './contracts';

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
  const eligible = computed(
    () => job.value?.action === 'bitbrowser' && job.value.state === 'awaiting_confirmation'
  );
  const confirmationEnabled = computed(
    () =>
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
      !uncertain.value
  );

  function reset() {
    generation++;
    nonce.value = '';
    digest.value = '';
    expiresAt.value = '';
    loading.value = false;
    busy.value = false;
    uncertain.value = false;
    message.value = '';
  }

  async function readConfirmation() {
    if (!eligible.value || !job.value || loading.value || busy.value || uncertain.value) return;
    const id = job.value.id;
    const expectedDigest = job.value.result.quote_digest;
    const revision = generation;
    loading.value = true;
    message.value = '';
    try {
      const access = await rechargeApi.bitBrowserAccess(id);
      const local = await rechargeConnectorApi.status(
        access.connectorUrl,
        access.connectorToken,
        id
      );
      if (disposed || revision !== generation || job.value?.id !== id || !eligible.value) return;
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
    } catch (cause) {
      if (revision === generation && !disposed)
        message.value =
          cause instanceof Error ? cause.message : '无法连接本机充值助手，请检查后刷新确认状态。';
    } finally {
      if (revision === generation) loading.value = false;
    }
  }

  async function confirm() {
    if (!confirmationEnabled.value || !job.value) return;
    if (!(Date.parse(expiresAt.value) > Date.now())) {
      nonce.value = '';
      message.value = '本次报价确认已过期，请刷新原任务；本次未重新授权付款。';
      return;
    }
    const id = job.value.id;
    const singleNonce = nonce.value;
    const quoteDigest = digest.value;
    const revision = generation;
    busy.value = true;
    uncertain.value = true;
    nonce.value = '';
    try {
      const access = await rechargeApi.bitBrowserAccess(id);
      if (
        disposed ||
        revision !== generation ||
        job.value?.id !== id ||
        !eligible.value ||
        job.value.result.quote_digest !== quoteDigest
      )
        return;
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
      message.value = '本次确认结果待核验，请刷新原任务。系统不会重复发送付款确认。';
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
      reset();
      void readConfirmation();
    },
    { immediate: true, flush: 'sync' }
  );
  onScopeDispose(() => {
    disposed = true;
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
