import { computed, ref, reactive, watch, onScopeDispose } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { validateV2Form } from '@/v2/utils/formValidation';
import { registrationApi } from './api';
import type { V2RegistrationJob } from './contracts';

export function useRegistrationPage(config: {
  moduleKey: 'auto-registration';
  enabled?: () => boolean;
}) {
  const filters = useV2SessionDraft('auto-registration:filters', () =>
    reactive({
      page: 1,
      pageSize: 20,
      keyword: '',
      appliedKeyword: '',
      activeJobId: '',
      optionSearch: '',
      optionPage: 1
    })
  );
  const query = useV2ModuleQuery({
    moduleKey: config.moduleKey,
    scope: 'auto-recharge',
    enabled: config.enabled,
    key: () =>
      createV2QueryKey({
        page: filters.page,
        pageSize: filters.pageSize,
        keyword: filters.appliedKeyword
      }),
    keepPreviousData: true,
    query: ({ signal }) =>
      registrationApi.jobs(
        { page: filters.page, pageSize: filters.pageSize, keyword: filters.appliedKeyword },
        { signal }
      )
  });
  watch(
    () => [filters.page, filters.pageSize, filters.appliedKeyword],
    () => {
      void query.ensureFresh();
    }
  );
  watch(
    () => filters.pageSize,
    () => {
      filters.page = 1;
    }
  );
  const formOpen = ref(false),
    busy = ref(false),
    error = ref(''),
    message = ref('');
  const formRef = ref<FormInstance>();
  function bindForm(value: unknown) {
    formRef.value = value as FormInstance;
  }
  const draft = useV2FormDraft('auto-registration:start', () => ({
    mailboxAliasId: '',
    proxyId: '',
    nameId: '',
    birthDate: '',
    confirmIdentity: false
  }));
  const rules: FormRules = {
    mailboxAliasId: [{ required: true, message: '请选择已授权的邮箱', trigger: 'change' }],
    proxyId: [{ required: true, message: '请选择代理', trigger: 'change' }],
    birthDate: [{ required: true, message: '请填写真实出生日期', trigger: 'change' }],
    confirmIdentity: [
      {
        validator: (_rule, value, done) =>
          done(value === true ? undefined : new Error('请确认邮箱授权及真实资料')),
        trigger: 'change'
      }
    ]
  };
  const options = useV2ModuleQuery({
    moduleKey: config.moduleKey,
    scope: 'auto-recharge',
    enabled: () => formOpen.value,
    key: () =>
      createV2QueryKey({ options: true, q: filters.optionSearch, page: filters.optionPage }),
    keepPreviousData: true,
    query: ({ signal }) =>
      registrationApi.options({ q: filters.optionSearch, page: filters.optionPage }, { signal })
  });
  watch(
    () => [filters.optionSearch, filters.optionPage],
    () => {
      if (formOpen.value) void options.ensureFresh();
    }
  );
  watch(
    () => options.data.value?.defaultProxyId,
    (value) => {
      if (formOpen.value && !draft.form.proxyId) draft.form.proxyId = value ?? '';
    }
  );
  const activeQuery = useV2ModuleQuery({
    moduleKey: config.moduleKey,
    scope: 'auto-recharge',
    enabled: () => Boolean(filters.activeJobId),
    key: () => createV2QueryKey({ jobId: filters.activeJobId }),
    keepPreviousData: true,
    query: ({ signal }) => registrationApi.job(filters.activeJobId, { signal })
  });
  watch(
    () => filters.activeJobId,
    () => {
      if (filters.activeJobId) void activeQuery.ensureFresh();
    }
  );
  const selected = computed(() =>
    activeQuery.data.value?.id === filters.activeJobId
      ? activeQuery.data.value
      : query.data.value?.items.find((row) => row.id === filters.activeJobId)
  );
  function changePage(value: number) {
    filters.page = value;
  }
  function changePageSize(value: number) {
    filters.pageSize = value;
  }
  function search() {
    const changed = filters.page !== 1 || filters.appliedKeyword !== filters.keyword.trim();
    filters.page = 1;
    filters.appliedKeyword = filters.keyword.trim();
    if (!changed) void query.refresh();
    if (filters.activeJobId) void activeQuery.refresh();
  }
  function openStart() {
    draft.open('create');
    if (!draft.form.proxyId) draft.form.proxyId = options.data.value?.defaultProxyId ?? '';
    error.value = '';
    formOpen.value = true;
  }
  function searchOptions() {
    filters.optionPage = 1;
    void options.refresh();
  }
  let disposed = false;
  function accepted(response: { delivery: string }) {
    if (response.delivery !== 'accepted')
      throw new Error(
        response.delivery === 'not_received'
          ? '内置浏览器未接收任务，请从原任务重试'
          : '任务接收结果暂不明确，请等待原任务进度，避免重复注册'
      );
  }
  async function dispatch(id: string) {
    accepted(await registrationApi.launch(id));
  }
  async function start() {
    if (!(await validateV2Form(formRef.value))) return;
    busy.value = true;
    error.value = '';
    const completeSave = draft.beginSave();
    try {
      const job = await registrationApi.create({
        ...draft.form,
        nameId: draft.form.nameId || undefined
      });
      filters.activeJobId = job.id;
      await dispatch(job.id);
      completeSave();
      formOpen.value = false;
      message.value = '系统已开始注册，正在提取代理并打开独立指纹浏览器';
      await query.refresh();
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  async function act(row: V2RegistrationJob, action: 'continue' | 'cancel') {
    busy.value = true;
    error.value = '';
    filters.activeJobId = row.id;
    try {
      if (action === 'cancel') {
        const receipt = await registrationApi.cancel(row.id);
        if (receipt.delivery !== 'accepted')
          error.value =
            '任务授权已撤销，但浏览器关闭尚未确认；请稍候点击重试关闭，仍失败时联系管理员';
      } else if (row.state === 'queued') await dispatch(row.id);
      else accepted(await registrationApi.resume(row.id));
      await query.refresh();
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  const loginCode = ref('');
  async function submitCode(row: V2RegistrationJob, code: string) {
    accepted(await registrationApi.code(row.id, { code, attempt: row.attempt, step: row.step }));
    loginCode.value = '';
  }
  async function manualSubmit() {
    if (!selected.value || !/^\d{6,8}$/.test(loginCode.value.trim())) {
      error.value = '请填写当前邮件的 6 至 8 位验证码';
      return;
    }
    busy.value = true;
    try {
      await submitCode(selected.value, loginCode.value.trim());
      error.value = '';
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  async function pollProgress() {
    if (disposed) return;
    if (selected.value && !['completed', 'cancelled', 'partial'].includes(selected.value.state)) {
      try {
        await activeQuery.refresh();
      } catch {
        /* 区域显示错误并提供重试。 */
      }
    }
    if (!disposed)
      progressTimer = setTimeout(() => {
        void pollProgress();
      }, 8000);
  }
  progressTimer = setTimeout(() => {
    void pollProgress();
  }, 8000);
  onScopeDispose(() => {
    disposed = true;
    if (progressTimer) clearTimeout(progressTimer);
    loginCode.value = '';
  });
  return {
    filters,
    query,
    activeQuery,
    formOpen,
    bindForm,
    busy,
    error,
    message,
    formRef,
    draft,
    rules,
    options,
    selected,
    search,
    changePage,
    changePageSize,
    openStart,
    searchOptions,
    start,
    act,
    loginCode,
    manualSubmit
  };
}
