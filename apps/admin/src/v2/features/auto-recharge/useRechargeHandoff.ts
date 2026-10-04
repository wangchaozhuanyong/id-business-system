import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { rechargeApi } from './api';
import type { V2RechargeHandoffFrame, V2RechargeJob } from './contracts';
import {
  handoffEligible,
  validHandoffAction,
  validHandoffFrame,
  type RechargeHandoffAction
} from './recharge-handoff';

export function useRechargeHandoff(job: Ref<V2RechargeJob | undefined>, allowed: Ref<boolean>) {
  const open = ref(false);
  // 原验证画面与临时验证码只保留在当前组件内存，关闭即清除；不进入草稿或查询缓存。
  const frame = shallowRef<V2RechargeHandoffFrame>();
  const verificationInput = ref('');
  const busy = ref(false);
  const message = ref('');
  const commandLocked = ref(false);
  const generation = ref(0);
  const cacheNamespace = crypto.randomUUID();
  let expiresTimer: ReturnType<typeof setTimeout> | undefined;
  let commandAbort: AbortController | undefined;
  const eligible = computed(() => Boolean(handoffEligible(job.value)));
  const query = useV2ModuleQuery<number>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    trackRouteData: false,
    key: () => `handoff:${cacheNamespace}:${job.value?.id ?? ''}:${generation.value}`,
    enabled: () => open.value && allowed.value && eligible.value,
    query: async ({ signal }) => {
      const id = job.value!.id;
      const revision = generation.value;
      const next = await rechargeApi.handoffFrame(id, { signal });
      if (signal.aborted || !current(id, revision)) throw new Error('本次验证窗口已关闭');
      if (!validHandoffFrame(next)) throw new Error('原验证画面无效或已过期，请核对原单');
      if (next.sessionId !== job.value?.result.handoff_session_id)
        throw new Error('原验证会话已变化，请重新打开原窗口');
      const deadline = Date.parse(job.value?.result.handoff_expires_at ?? '');
      if (
        !Number.isFinite(deadline) ||
        deadline <= Date.now() ||
        Date.parse(next.expiresAt) > deadline
      )
        throw new Error('原验证画面超出本次等待预算，请核对原单');
      if (
        frame.value &&
        (next.sessionId !== frame.value.sessionId ||
          next.revision < frame.value.revision ||
          (next.revision === frame.value.revision && next.frameId !== frame.value.frameId))
      ) {
        throw new Error('原验证画面已变化，请重新打开原窗口');
      }
      frame.value = next;
      verificationInput.value = '';
      commandLocked.value = false;
      message.value = '';
      clearTimeout(expiresTimer);
      expiresTimer = setTimeout(
        () => {
          close();
          message.value = '原验证画面已过期，请刷新画面或核对原单。';
        },
        Math.min(Date.parse(next.expiresAt) - Date.now(), 2_147_483_647)
      );
      // 缓存仅包含修订号，实际画面不进入共享查询缓存。
      return next.revision;
    }
  });
  const canOperate = computed(() =>
    Boolean(
      open.value &&
      allowed.value &&
      eligible.value &&
      frame.value &&
      Date.parse(frame.value.expiresAt) > Date.now() &&
      query.phase.value === 'ready' &&
      !busy.value &&
      !commandLocked.value
    )
  );
  const queryError = computed(() =>
    query.error.value ? '读取原验证画面失败，请刷新画面或核对原单。' : ''
  );

  function current(id: string, revision: number) {
    return (
      open.value &&
      allowed.value &&
      eligible.value &&
      job.value?.id === id &&
      generation.value === revision
    );
  }
  function clearTransient() {
    frame.value = undefined;
    verificationInput.value = '';
    busy.value = false;
    commandLocked.value = true;
    commandAbort?.abort();
    commandAbort = undefined;
    clearTimeout(expiresTimer);
    expiresTimer = undefined;
  }
  function close() {
    open.value = false;
    generation.value += 1;
    query.cancel();
    clearTransient();
    message.value = '';
  }
  async function show() {
    if (!allowed.value || !eligible.value) return;
    if (Date.parse(job.value?.result.handoff_expires_at ?? '') <= Date.now()) {
      message.value = '本人验证等待超时，请核对原单。';
      return;
    }
    close();
    open.value = true;
    await query.ensureFresh();
  }
  async function refreshFrame() {
    if (!open.value || !allowed.value || !eligible.value || busy.value) return;
    verificationInput.value = '';
    commandLocked.value = true;
    await query.refresh();
  }
  async function send(action: RechargeHandoffAction) {
    if (!canOperate.value || !frame.value) return;
    if (!validHandoffAction(action, frame.value)) {
      message.value =
        action.type === 'text'
          ? '请填写最多 64 个字符的临时验证输入，不可包含控制字符。'
          : '本次验证操作无效，请检查后重试。';
      return;
    }
    const id = job.value!.id;
    const revision = generation.value;
    const snapshot = frame.value;
    const controller = new AbortController();
    commandAbort = controller;
    const commandId = crypto.randomUUID();
    busy.value = true;
    verificationInput.value = '';
    let unknown: boolean;
    try {
      const receipt = await rechargeApi.handoffCommand(
        id,
        {
          ...action,
          commandId,
          sessionId: snapshot.sessionId,
          frameId: snapshot.frameId,
          revision: snapshot.revision
        },
        { signal: controller.signal }
      );
      unknown = receipt.commandId !== commandId || receipt.accepted !== true;
    } catch {
      unknown = true;
    }
    if (!current(id, revision) || controller.signal.aborted) return;
    busy.value = false;
    commandAbort = undefined;
    commandLocked.value = true;
    if (unknown) {
      await refreshFrame();
      if (!current(id, revision)) return;
      commandLocked.value = true;
      message.value =
        '本次操作结果待核验，已停止操作并尝试刷新画面。请刷新画面并核对原单，系统不会重发本次操作。';
      return;
    }
    await refreshFrame();
  }
  watch(
    [
      () => job.value?.id,
      () => job.value?.result.handoff_kind,
      () => job.value?.result.handoff_session_id,
      () => job.value?.result.handoff_generation,
      () => job.value?.result.handoff_expires_at,
      eligible,
      allowed,
      sessionCoordinator.identityEpoch
    ],
    close,
    { flush: 'sync' }
  );
  onScopeDispose(close);
  return {
    open,
    frame,
    verificationInput,
    busy,
    message,
    eligible,
    query,
    queryError,
    canOperate,
    show,
    close,
    refreshFrame,
    send
  };
}
