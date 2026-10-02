import { computed, ref, reactive, watch, onScopeDispose } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { http, getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { validateV2Form } from '@/v2/utils/formValidation';
import {
  connectorRequest,
  RechargeConnectorError,
  useRechargeBrowserSettings,
  type ConnectorStatus
} from '../auto-recharge/public-api';
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
  const browserSettings = useRechargeBrowserSettings(
    ref<ConnectorStatus>('unknown'),
    ref(''),
    ref(false)
  );
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
    filters.page = 1;
    filters.appliedKeyword = filters.keyword.trim();
  }
  function openStart() {
    draft.open('create');
    error.value = '';
    formOpen.value = true;
  }
  function searchOptions() {
    filters.optionPage = 1;
    void options.refresh();
  }
  let disposed = false;
  const lifetime = new AbortController();
  async function dispatch(id: string) {
    const launch = await registrationApi.launch(id);
    const { connectorUrl, connectorToken, ...payload } = launch;
    const base = new URL(http.defaults.baseURL ?? '/api', window.location.origin).href.replace(
      /\/$/,
      ''
    );
    try {
      await connectorRequest(connectorUrl, '/jobs', {
        token: connectorToken,
        signal: lifetime.signal,
        body: {
          ...payload,
          callbackUrl: `${base}/id-business-v2/auto-registration/local/${id}`,
          windowName: `注册-${id.slice(0, 8)}`
        }
      });
    } finally {
      for (const key of Object.keys(payload)) delete payload[key];
    }
  }
  async function start() {
    if (!(await validateV2Form(formRef.value))) return;
    busy.value = true;
    error.value = '';
    const completeSave = draft.beginSave();
    try {
      const connection = await registrationApi.connection();
      const health = await connectorRequest(connection.connectorUrl, '/health', {
        signal: lifetime.signal
      });
      if (
        health.service !== 'id-business-v2-auto-recharge-connector' ||
        !Array.isArray(health.capabilities) ||
        !health.capabilities.includes('account-registration')
      )
        throw new Error('请更新并启动支持自动注册的本机连接器');
      if (health.busy !== false || health.originAllowed !== true)
        throw new Error('本机连接器正忙或未允许当前网站来源');
      const job = await registrationApi.create({
        ...draft.form,
        nameId: draft.form.nameId || undefined
      });
      filters.activeJobId = job.id;
      await dispatch(job.id);
      completeSave();
      formOpen.value = false;
      message.value = '本机已接收注册任务，请保留原浏览器窗口';
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
      if (action === 'continue' && ['partial', 'queued'].includes(row.state)) {
        if (row.state === 'partial') await registrationApi.resumeCredentials(row.id);
        await dispatch(row.id);
      } else {
        const connection = await registrationApi.connection();
        const credentials =
          action === 'continue' ? await registrationApi.resumeCredentials(row.id) : {};
        try {
          await connectorRequest(
            connection.connectorUrl,
            `/jobs/${row.id}/${action === 'cancel' ? 'cancel' : 'resume'}`,
            { token: connection.connectorToken, body: credentials, signal: lifetime.signal }
          );
        } catch (cause) {
          if (
            action !== 'cancel' ||
            !(cause instanceof RechargeConnectorError) ||
            cause.code !== 'missing'
          )
            throw cause;
        }
        if (action === 'cancel') await registrationApi.cancel(row.id);
      }
      await query.refresh();
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  const loginCode = ref('');
  async function submitCode(row: V2RegistrationJob, code: string, mailId?: string) {
    const connection = await registrationApi.connection();
    await connectorRequest(connection.connectorUrl, `/jobs/${row.id}/code`, {
      token: connection.connectorToken,
      body: { code, attempt: row.attempt, step: row.step, ...(mailId ? { mailId } : {}) },
      signal: lifetime.signal
    });
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
  let mailTimer: ReturnType<typeof setTimeout> | undefined;
  let mailGeneration = 0;
  async function checkMail(generation: number, row: V2RegistrationJob) {
    if (disposed || generation !== mailGeneration || selected.value?.state !== 'awaiting_email')
      return;
    try {
      const response = await registrationApi.code(row.id, lifetime.signal);
      if (disposed || generation !== mailGeneration) return;
      if (response.code) {
        await submitCode(row, response.code, response.mailId);
        error.value = '';
        message.value = '已提交当前步骤的邮件验证';
        return;
      }
    } catch (cause) {
      if (!disposed && generation === mailGeneration) error.value = getApiErrorMessage(cause);
    }
    if (!disposed && generation === mailGeneration)
      mailTimer = setTimeout(() => {
        void checkMail(generation, row);
      }, 8000);
  }
  watch(
    () => [
      selected.value?.id,
      selected.value?.attempt,
      selected.value?.state,
      selected.value?.step
    ],
    () => {
      const generation = ++mailGeneration;
      if (mailTimer) clearTimeout(mailTimer);
      if (selected.value?.state === 'awaiting_email') void checkMail(generation, selected.value);
    },
    { immediate: true }
  );
  onScopeDispose(() => {
    disposed = true;
    lifetime.abort();
    ++mailGeneration;
    if (mailTimer) clearTimeout(mailTimer);
    loginCode.value = '';
  });
  return {
    filters,
    query,
    activeQuery,
    formOpen,
    browserSettings,
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
