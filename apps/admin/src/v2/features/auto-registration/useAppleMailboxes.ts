import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useAuthStore } from '@/stores/auth';
import {
  createV2QueryKey,
  invalidateV2Queries,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { autoRegistrationApi } from './api';
import {
  appleMailboxMarkError,
  appleMailboxRegisterReason,
  appleMailboxTaskActive,
  appleMailboxBusy,
  appleMailboxCanRecover
} from './apple-mailbox-presentation';
import type {
  AppleMailboxListQuery,
  AppleMailboxMarkInput,
  AppleMailboxPageResult,
  AppleMailboxRow,
  AppleMailboxTask
} from './contracts';

type AppleMailboxRecoveryTarget = Pick<
  AppleMailboxRow,
  'aliasId' | 'email' | 'revision' | 'taskUuid' | 'activeTaskUuid' | 'taskStatus'
>;

function recoveryTarget(row: AppleMailboxRow): AppleMailboxRecoveryTarget {
  return {
    aliasId: row.aliasId,
    email: row.email,
    revision: row.revision,
    taskUuid: row.taskUuid,
    activeTaskUuid: row.activeTaskUuid,
    taskStatus: row.taskStatus
  };
}

export function useAppleMailboxes() {
  const auth = useAuthStore();
  const identityEpoch = sessionCoordinator.identityEpoch.value;
  const disposed = ref(false);
  const canAccess = computed(
    () =>
      !disposed.value &&
      identityEpoch === sessionCoordinator.identityEpoch.value &&
      auth.writesAllowed &&
      Boolean(auth.user?.roles.includes('admin'))
  );
  const filters = useV2SessionDraft('auto-registration:apple:filters', () =>
    reactive<AppleMailboxListQuery>({
      page: 1,
      pageSize: 20,
      q: '',
      registrationStatus: '',
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    })
  );
  const selectedIds = useV2SessionDraft('auto-registration:apple:selection', () =>
    ref<string[]>([])
  );
  const taskUuid = useV2SessionDraft('auto-registration:apple:task', () => ref(''));
  let restoredTasks = false;
  const query = useV2ModuleQuery<AppleMailboxPageResult>({
    moduleKey: 'auto-registration',
    scope: 'auto-registration',
    key: () => createV2QueryKey({ appleMailboxes: filters }),
    enabled: () => canAccess.value,
    query: async ({ signal }) => {
      if (!restoredTasks) {
        await autoRegistrationApi.resumeAppleMailboxTasks({ signal });
        if (!canAccess.value || signal.aborted) throw new DOMException('操作已取消', 'AbortError');
        restoredTasks = true;
      }
      return autoRegistrationApi.appleMailboxes({ ...filters }, { signal });
    }
  });
  const items = computed(() => query.data.value?.items ?? []);
  const selected = computed(() =>
    items.value.filter((row) => selectedIds.value.includes(row.aliasId))
  );
  const hasSelection = computed(() => selected.value.length > 0);
  const listError = computed(() =>
    query.error.value ? getApiErrorMessage(query.error.value) : ''
  );
  const displayedPage = computed(() => query.data.value?.page ?? filters.page);
  const displayedPageSize = computed(() => query.data.value?.pageSize ?? filters.pageSize);
  const paginationBusy = computed(
    () =>
      query.isInitialLoading.value || query.isRefreshing.value || query.isParameterTransition.value
  );
  watch([() => query.phase.value, () => query.data.value], ([phase, data]) => {
    if (
      phase !== 'ready' ||
      !data ||
      data.page !== filters.page ||
      data.pageSize !== filters.pageSize
    )
      return;
    const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (filters.page > lastPage) {
      invalidateV2Queries('auto-registration');
      filters.page = lastPage;
      selectedIds.value = [];
    }
  });
  const canWrite = computed(
    () => canAccess.value && query.hasCurrentData.value && !query.isParameterTransition.value
  );
  const actionError = ref('');
  const feedback = ref('');
  const busy = ref(false);
  const markOpen = ref(false);
  const recoverOpen = ref(false);
  const recoverDraft = useV2FormDraft<{ target: AppleMailboxRecoveryTarget | null }>(
    'auto-registration:apple:recover',
    () => ({ target: null })
  );
  const recoverReadError = ref('');
  const recoverDisabledReason = computed(() => {
    if (!canWrite.value) return '当前列表或登录状态尚未确认，请先刷新';
    if (query.error.value) return '当前状态读取失败，请先刷新';
    if (recoverReadError.value) return recoverReadError.value;
    const target = recoverDraft.form.target;
    return !target || !appleMailboxCanRecover(target)
      ? '原占用已变化，请关闭后查看最新邮箱状态'
      : '';
  });
  const markDraft = useV2FormDraft<AppleMailboxMarkInput>('auto-registration:apple:mark', () => ({
    items: [],
    registrationStatus: 'unknown',
    registrationIp: null,
    note: ''
  }));
  const markTitle = computed(() =>
    markDraft.form.items.length > 1
      ? `批量标记 ${markDraft.form.items.length} 个邮箱`
      : '标记邮箱注册状态'
  );
  const registrationIpEditable = computed(() => markDraft.form.registrationStatus === 'registered');
  function refreshMailboxes() {
    if (!canAccess.value) return;
    invalidateV2Queries('auto-registration');
    return query.refresh();
  }

  function setSelection(rows: AppleMailboxRow[]) {
    selectedIds.value = rows.map((row) => row.aliasId);
  }
  function toggleSelection(row: AppleMailboxRow, value: boolean) {
    selectedIds.value = value
      ? [...new Set([...selectedIds.value, row.aliasId])]
      : selectedIds.value.filter((id) => id !== row.aliasId);
  }
  function openMark(rows: AppleMailboxRow[]) {
    if (!canWrite.value || !rows.length || busy.value) return;
    if (rows.some(appleMailboxBusy)) {
      actionError.value = '所选邮箱包含被占用的任务，请先查看任务；待核对任务需人工核对后解除占用';
      return;
    }
    const first = rows[0]!;
    const key = rows
      .map((row) => row.aliasId)
      .sort()
      .join(':');
    markDraft.open(key, {
      items: rows.map(({ aliasId, revision }) => ({ aliasId, revision })),
      registrationStatus: rows.length === 1 ? first.registrationStatus : 'unknown',
      registrationIp: rows.length === 1 ? first.registrationIp : null,
      note: rows.length === 1 ? (first.note ?? '') : ''
    });
    markOpen.value = true;
    actionError.value = '';
  }
  function resetMark() {
    markDraft.form.items = markDraft.form.items.map((target) => ({
      ...target,
      revision:
        items.value.find((row) => row.aliasId === target.aliasId)?.revision ?? target.revision
    }));
    markDraft.form.registrationStatus = 'unknown';
    markDraft.form.registrationIp = null;
    markDraft.form.note = '';
    actionError.value = '';
  }
  function markPayload(): AppleMailboxMarkInput {
    const { items, registrationStatus, registrationIp, note } = markDraft.form;
    return {
      items: items.map(({ aliasId, revision }) => ({ aliasId, revision })),
      registrationStatus,
      registrationIp: registrationStatus === 'registered' ? registrationIp?.trim() || null : null,
      note: note.trim()
    };
  }
  const markValidation = computed(() => appleMailboxMarkError(markPayload()));
  async function saveMark() {
    if (!canAccess.value || busy.value) return;
    const input = markPayload();
    const error = appleMailboxMarkError(input);
    if (error) {
      // 字段错误只显示在对应控件旁，避免在备注下方重复显示 IP 错误。
      actionError.value = error.includes('IPv4') || error.includes('500') ? '' : error;
      return;
    }
    const finishSave = markDraft.beginSave();
    busy.value = true;
    actionError.value = '';
    try {
      const result = await autoRegistrationApi.markAppleMailboxes(input);
      if (!canAccess.value) return;
      if (finishSave()) markOpen.value = false;
      feedback.value = `已标记 ${result.updated} 个邮箱`;
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  async function start(row: AppleMailboxRow) {
    if (!canWrite.value || busy.value) return;
    const reason = appleMailboxRegisterReason(row);
    if (reason) {
      actionError.value = reason;
      return;
    }
    busy.value = true;
    actionError.value = '';
    try {
      const result = await autoRegistrationApi.startAppleMailbox({
        aliasId: row.aliasId,
        revision: row.revision
      });
      if (!canAccess.value) return;
      taskUuid.value = result.taskUuid;
      feedback.value = '注册任务已提交';
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  function openRecovery(row: AppleMailboxRow) {
    if (!canWrite.value || busy.value || !appleMailboxCanRecover(row)) return;
    const restored = recoverDraft.open(row.aliasId, { target: recoveryTarget(row) });
    // 确认框没有输入字段，仍登记首次快照，让关闭重开保留原始 CAS 依据。
    if (!restored) recoverDraft.form.target = recoveryTarget(row);
    recoverOpen.value = true;
    recoverReadError.value = '';
    actionError.value = '';
  }
  async function refreshRecovery() {
    const target = recoverDraft.form.target;
    if (!canAccess.value || busy.value || !target) return;
    busy.value = true;
    actionError.value = '';
    try {
      await refreshMailboxes();
      if (!canAccess.value || recoverDraft.form.target?.aliasId !== target.aliasId) return;
      if (query.error.value) {
        recoverReadError.value = '刷新状态失败，请重试刷新后再确认';
        return;
      }
      const fresh = items.value.find((item) => item.aliasId === target.aliasId);
      if (fresh) {
        recoverDraft.form.target = recoveryTarget(fresh);
        recoverReadError.value = '';
      } else recoverReadError.value = '当前列表已找不到该邮箱，请关闭后重新选择';
    } catch (error) {
      if (canAccess.value) recoverReadError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  async function recover() {
    const row = recoverDraft.form.target;
    if (
      recoverDisabledReason.value ||
      busy.value ||
      !recoverOpen.value ||
      !row ||
      !appleMailboxCanRecover(row)
    )
      return;
    const finishSave = recoverDraft.beginSave();
    busy.value = true;
    actionError.value = '';
    try {
      await autoRegistrationApi.recoverAppleMailbox({
        aliasId: row.aliasId,
        revision: row.revision
      });
      if (!canAccess.value) return;
      if (finishSave()) recoverOpen.value = false;
      feedback.value = '任务占用已解除，原注册事实已保留；请用“标记”登记核实的注册状态';
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  async function startBatch() {
    if (!canWrite.value || busy.value || !selected.value.length) return;
    const selectedCount = selected.value.length;
    const candidates = selected.value.filter((row) => !appleMailboxRegisterReason(row));
    if (!candidates.length) {
      actionError.value = '所选邮箱中没有可注册的未注册邮箱';
      return;
    }
    busy.value = true;
    actionError.value = '';
    try {
      const result = await autoRegistrationApi.startAppleMailboxBatch({
        targets: candidates.map(({ aliasId, revision }) => ({ aliasId, revision })),
        count: candidates.length,
        concurrency: 3,
        mode: 'pipeline',
        interval_min: 5,
        interval_max: 30
      });
      if (!canAccess.value) return;
      taskUuid.value = result.taskUuids[0] ?? '';
      feedback.value = `批量已接收 ${result.accepted} 个邮箱，跳过 ${selectedCount - candidates.length + result.skipped.length} 个；并发为 3，间隔为 5～30 秒。其他设置可在注册控制台调整。`;
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  async function syncTask(row?: AppleMailboxRow) {
    const id = row?.taskUuid ?? taskUuid.value;
    if (!canAccess.value || busy.value || !id) return;
    busy.value = true;
    actionError.value = '';
    try {
      const result = await autoRegistrationApi.syncAppleMailboxTask(id);
      if (!canAccess.value) return;
      feedback.value =
        result.syncStatus === 'saved'
          ? '已同步到 ChatGPT 账号列表'
          : '账号同步尚未完成，请查看任务记录';
      if (id === taskUuid.value) await taskQuery.refresh();
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  async function saveLocalAccount(row?: AppleMailboxRow) {
    const id = row?.taskUuid ?? taskUuid.value;
    if (!canAccess.value || busy.value || !id) return;
    busy.value = true;
    actionError.value = '';
    try {
      const result = await autoRegistrationApi.saveAppleMailboxLocalAccount(id);
      if (!canAccess.value) return;
      feedback.value =
        result.localSaveStatus === 'saved'
          ? '已补存自动注册本地账号，可继续核对主账号同步'
          : '本地账号尚未保存，请查看任务记录';
      if (id === taskUuid.value) await taskQuery.refresh();
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  const taskQuery = useV2ModuleQuery<AppleMailboxTask>({
    moduleKey: 'auto-registration',
    scope: 'auto-registration',
    key: () => createV2QueryKey({ appleMailboxTask: taskUuid.value }),
    enabled: () => canAccess.value && Boolean(taskUuid.value),
    keepPreviousData: false,
    query: ({ signal }) => autoRegistrationApi.appleMailboxTask(taskUuid.value, { signal })
  });
  const taskError = computed(() =>
    taskQuery.error.value ? getApiErrorMessage(taskQuery.error.value) : ''
  );
  let taskTimer: ReturnType<typeof setTimeout> | undefined;
  function clearTaskTimer() {
    if (taskTimer) clearTimeout(taskTimer);
    taskTimer = undefined;
  }
  watch(
    [() => taskQuery.data.value, () => taskQuery.error.value, () => canAccess.value],
    ([task, error, allowed], previous) => {
      clearTaskTimer();
      if (!allowed || error || !task || task.taskUuid !== taskUuid.value) return;
      if (appleMailboxTaskActive(task.status))
        taskTimer = setTimeout(() => {
          if (canAccess.value) void taskQuery.refresh();
        }, 2500);
      else if (previous?.[0] && appleMailboxTaskActive(previous[0].status)) void refreshMailboxes();
    }
  );
  async function cancelTask() {
    const id = taskUuid.value;
    if (
      !canAccess.value ||
      busy.value ||
      !appleMailboxTaskActive(taskQuery.data.value?.status ?? null)
    )
      return;
    busy.value = true;
    actionError.value = '';
    try {
      await autoRegistrationApi.cancelAppleMailboxTask(id);
      if (!canAccess.value) return;
      feedback.value = '取消请求已提交，正在等待任务停止';
      if (taskUuid.value === id) await taskQuery.refresh();
      await refreshMailboxes();
    } catch (error) {
      if (canAccess.value) actionError.value = getApiErrorMessage(error);
    } finally {
      busy.value = false;
    }
  }
  function changeConditions() {
    filters.page = 1;
    selectedIds.value = [];
  }
  watch(
    () => [filters.q, filters.registrationStatus, filters.sortBy, filters.sortOrder],
    changeConditions
  );
  function changePage(page: number) {
    if (paginationBusy.value) return;
    filters.page = page;
    selectedIds.value = [];
  }
  function changePageSize(size: number) {
    filters.pageSize = size;
    changeConditions();
  }
  function viewTask(row: AppleMailboxRow) {
    if (row.taskUuid) taskUuid.value = row.taskUuid;
  }
  onScopeDispose(() => {
    disposed.value = true;
    clearTaskTimer();
  });

  return {
    filters,
    query,
    refreshMailboxes,
    items,
    selectedIds,
    selected,
    hasSelection,
    displayedPage,
    displayedPageSize,
    paginationBusy,
    canWrite,
    busy,
    listError,
    actionError,
    feedback,
    markOpen,
    recoverOpen,
    recoverDraft,
    recoverDisabledReason,
    markDraft,
    markTitle,
    registrationIpEditable,
    markValidation,
    taskUuid,
    taskQuery,
    taskError,
    setSelection,
    toggleSelection,
    openMark,
    resetMark,
    saveMark,
    start,
    startBatch,
    syncTask,
    saveLocalAccount,
    recover,
    openRecovery,
    refreshRecovery,
    cancelTask,
    changePage,
    changePageSize,
    viewTask
  };
}
