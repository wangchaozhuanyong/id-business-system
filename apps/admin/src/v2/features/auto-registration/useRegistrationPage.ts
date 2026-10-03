import { computed, ref, reactive, watch, onScopeDispose } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { registrationApi } from './api';
import type { V2RegistrationJob } from './contracts';
import { useRegistrationStart } from './useRegistrationStart';
import { requireRegistrationAccepted } from './presentation';

export function useRegistrationPage(config: {
  moduleKey: 'auto-registration';
  enabled?: () => boolean;
  onStarted?: () => void;
}) {
  const filters = useV2SessionDraft('auto-registration:filters', () =>
    reactive({
      page: 1,
      pageSize: 20,
      keyword: '',
      appliedKeyword: '',
      activeJobId: ''
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
  const busy = ref(false),
    error = ref(''),
    message = ref('');
  const startState = useRegistrationStart({
    busy,
    error,
    message,
    onJob: (id) => {
      filters.activeJobId = id;
    },
    onStarted: config.onStarted,
    refresh: () => query.refresh()
  });
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
  let disposed = false;
  async function dispatch(id: string) {
    requireRegistrationAccepted(await registrationApi.launch(id));
  }
  async function act(row: V2RegistrationJob, action: 'continue' | 'cancel') {
    if (busy.value) return;
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
      else requireRegistrationAccepted(await registrationApi.resume(row.id));
      await query.refresh();
    } catch (cause) {
      if (!disposed) error.value = getApiErrorMessage(cause);
    } finally {
      busy.value = false;
    }
  }
  const loginCode = ref('');
  async function submitCode(row: V2RegistrationJob, code: string) {
    requireRegistrationAccepted(
      await registrationApi.code(row.id, { code, attempt: row.attempt, step: row.step })
    );
    loginCode.value = '';
  }
  async function manualSubmit() {
    if (busy.value) return;
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
    busy,
    error,
    message,
    selected,
    search,
    changePage,
    changePageSize,
    act,
    loginCode,
    manualSubmit,
    ...startState
  };
}
