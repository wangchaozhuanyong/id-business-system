import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { validateV2Form } from '@/v2/utils/formValidation';
import { registrationApi } from './api';
import type { V2RegistrationMailbox } from './contracts';
import { mailboxBlockedReasons, requireRegistrationAccepted } from './presentation';
import { useRegistrationOptions } from './useRegistrationOptions';

export function useRegistrationStart(config: {
  busy: Ref<boolean>;
  error: Ref<string>;
  message: Ref<string>;
  onJob: (id: string) => void;
  onStarted?: () => void;
  refresh: () => Promise<unknown>;
}) {
  const formOpen = ref(false);
  const formRef = ref<FormInstance>();
  const selectedMailbox = useV2SessionDraft('auto-registration:start-mailbox', () =>
    ref<V2RegistrationMailbox | null>(null)
  );
  const attempts = useV2SessionDraft('auto-registration:start-attempts', () =>
    reactive<Record<string, { jobId: string; uncertain: boolean }>>({})
  );
  const draft = useV2FormDraft('auto-registration:start', () => ({
    mailboxAliasId: '',
    proxyId: '',
    nameId: '',
    age: undefined as number | undefined,
    confirmIdentity: false
  }));
  const optionState = useRegistrationOptions(() => formOpen.value);
  watch(
    () => optionState.options.data.value?.defaultProxyId,
    (value) => {
      if (formOpen.value && !draft.form.proxyId) draft.form.proxyId = value ?? '';
    }
  );
  const rules: FormRules = {
    mailboxAliasId: [{ required: true, message: '请先在邮箱列表选择邮箱', trigger: 'change' }],
    proxyId: [{ required: true, message: '请选择代理', trigger: 'change' }],
    age: [
      {
        validator: (_rule, value, done) =>
          done(
            value == null || (Number.isInteger(value) && value >= 20 && value <= 45)
              ? undefined
              : new Error('年龄须为 20 至 45 岁的整数')
          ),
        trigger: 'change'
      }
    ],
    confirmIdentity: [
      {
        validator: (_rule, value, done) =>
          done(value === true ? undefined : new Error('请确认邮箱已授权用于注册')),
        trigger: 'change'
      }
    ]
  };
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });
  function bindForm(value: unknown) {
    formRef.value = value as FormInstance;
  }
  function openStart(row: V2RegistrationMailbox | null = selectedMailbox.value) {
    if (config.busy.value) return;
    if (!row) {
      config.error.value = '请先在隐藏邮箱或未注册列表选择邮箱';
      return;
    }
    if (!row.canStart && !attempts[row.id]) {
      config.error.value = row.startBlockedReason
        ? mailboxBlockedReasons[row.startBlockedReason]
        : '该邮箱暂不可注册，请刷新列表';
      return;
    }
    selectedMailbox.value = { ...row };
    draft.open(row.id, { mailboxAliasId: row.id });
    if (!draft.form.proxyId)
      draft.form.proxyId = optionState.options.data.value?.defaultProxyId ?? '';
    config.error.value = '';
    formOpen.value = true;
  }
  async function reconcile(aliasId: string) {
    const originalId = attempts[aliasId]?.jobId;
    const pending = await registrationApi.pending(aliasId);
    if (disposed) return;
    if (pending) {
      attempts[aliasId] = { jobId: pending.id, uncertain: false };
      config.onJob(pending.id);
      config.message.value = '已找到原注册任务，请在注册任务中查看进度、继续或取消';
      formOpen.value = false;
      config.onStarted?.();
    } else if (originalId) {
      const original = await registrationApi.job(originalId);
      if (disposed) return;
      if (!['completed', 'cancelled'].includes(original.state)) {
        config.onJob(original.id);
        config.error.value = '原任务尚未结束，请先核对原任务';
        return;
      }
      delete attempts[aliasId];
      config.onJob(original.id);
      config.message.value = '原任务已结束，请刷新邮箱状态后再操作';
      formOpen.value = false;
      config.onStarted?.();
    } else {
      delete attempts[aliasId];
      config.message.value = '未发现已建立的注册任务；资料已保留，可重新点击开始注册';
    }
  }
  async function start() {
    if (config.busy.value) return;
    config.busy.value = true;
    config.error.value = '';
    config.message.value = '';
    const aliasId = draft.form.mailboxAliasId;
    try {
      if (attempts[aliasId]) {
        await reconcile(aliasId);
        return;
      }
      if (!(await validateV2Form(formRef.value)) || disposed) return;
      if (!selectedMailbox.value || aliasId !== selectedMailbox.value.id) {
        config.error.value = '注册邮箱已变化，请重新从列表选择';
        return;
      }
      const completeSave = draft.beginSave();
      const input = {
        mailboxAliasId: aliasId,
        proxyId: draft.form.proxyId,
        nameId: draft.form.nameId || undefined,
        age: draft.form.age ?? undefined,
        confirmIdentity: draft.form.confirmIdentity
      };
      attempts[aliasId] = { jobId: '', uncertain: true };
      let job;
      try {
        job = await registrationApi.create(input);
      } catch (cause) {
        if (disposed) return;
        try {
          await reconcile(aliasId);
          if (!disposed) config.error.value = getApiErrorMessage(cause);
        } catch {
          if (!disposed)
            config.error.value = '创建结果暂不明确，资料已保留；请点击核对原任务，避免重复注册';
        }
        return;
      }
      if (disposed) return;
      attempts[aliasId] = { jobId: job.id, uncertain: false };
      config.onJob(job.id);
      requireRegistrationAccepted(await registrationApi.launch(job.id));
      if (disposed) return;
      const cleared = completeSave();
      if (cleared && draft.form.mailboxAliasId === aliasId) formOpen.value = false;
      config.message.value = '系统已接收注册任务，正在提取代理并打开独立指纹浏览器';
      config.onStarted?.();
      try {
        await config.refresh();
      } catch {
        if (!disposed) config.message.value += '；任务列表读取失败，请重试读取';
      }
    } catch (cause) {
      if (!disposed) config.error.value = getApiErrorMessage(cause);
    } finally {
      if (!disposed) config.busy.value = false;
    }
  }
  return {
    formOpen,
    formRef,
    bindForm,
    selectedMailbox,
    draft,
    rules,
    openStart,
    start,
    startConfirmText: computed(() =>
      attempts[draft.form.mailboxAliasId] ? '核对原任务' : '开始注册'
    ),
    ...optionState
  };
}
