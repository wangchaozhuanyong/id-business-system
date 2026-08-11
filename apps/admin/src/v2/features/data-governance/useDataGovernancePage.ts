import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { FormInstance } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { v2DataGovernanceApi } from './api';
import {
  CLEANUP_INITIAL,
  DECISION_INITIAL,
  RESTORE_INITIAL,
  cleanupRules,
  createGovernanceMutationKey,
  decisionRules,
  restoreRules,
  type CleanupFormModel,
  type DecisionFormModel,
  type RestoreFormModel
} from './data-governance-forms';
import { useDataGovernancePagination } from './data-governance-pagination';
import { createDataGovernanceQueryKey } from './data-governance-query-key';
import {
  buildAuditRestoreReason,
  createRecycleItemFromAuditRestoreRequest,
  readAuditRestoreRouteRequest,
  readGovernanceTab,
  routeRestoreRequestKey,
  type V2GovernanceTab
} from './data-governance-route';
import {
  canCancelGovernanceJob,
  formatGovernanceDate,
  getGovernanceItemStatusMeta,
  getGovernanceJobStatusMeta,
  governancePreviewBlockedReason,
  governanceItemStatusMeta,
  governanceJobStatusMeta,
  governanceJobTypeLabel,
  governanceJobTypeLabels,
  recycleEntityLabel,
  recycleEntityLabels,
  shortHash
} from './data-governance-presentation';
import type {
  V2GovernanceJob,
  V2GovernanceJobDetail,
  V2GovernanceJobQuery,
  V2GovernanceJobStatus,
  V2GovernanceJobType,
  V2GovernanceRecycleEntity,
  V2GovernanceRecycleItem,
  V2GovernanceRecycleQuery
} from './contracts';

export function useDataGovernancePage() {
  const route = useRoute();
  const authStore = useAuthStore();
  const activeTab = ref<V2GovernanceTab>(readGovernanceTab(route.query.tab));
  const recycleQueryModel = reactive({
    page: 1,
    pageSize: 20,
    entity: '' as V2GovernanceRecycleEntity | ''
  });
  const jobQueryModel = reactive({
    page: 1,
    pageSize: 20,
    type: '' as V2GovernanceJobType | '',
    status: '' as V2GovernanceJobStatus | ''
  });
  const selectedRecycleItems = ref<V2GovernanceRecycleItem[]>([]);
  const restoreDrawerVisible = ref(false);
  const cleanupDrawerVisible = ref(false);
  const decisionDrawerVisible = ref(false);
  const detailDrawerVisible = ref(false);
  const restoreFormRef = ref<FormInstance>();
  const cleanupFormRef = ref<FormInstance>();
  const decisionFormRef = ref<FormInstance>();
  const restoreForm = reactive<RestoreFormModel>({ ...RESTORE_INITIAL });
  const cleanupForm = reactive<CleanupFormModel>({ ...CLEANUP_INITIAL });
  const decisionForm = reactive<DecisionFormModel>({ ...DECISION_INITIAL });
  const restoreBaseline = ref(JSON.stringify(RESTORE_INITIAL));
  const cleanupBaseline = ref(JSON.stringify(CLEANUP_INITIAL));
  const decisionBaseline = ref(JSON.stringify(DECISION_INITIAL));
  const decisionTarget = ref<V2GovernanceJob | null>(null);
  const detailId = ref('');
  const mutationBusy = ref('');
  const mutationError = ref('');
  const handledRouteRestoreKey = ref('');

  function recycleListQuery(): V2GovernanceRecycleQuery {
    return {
      page: recycleQueryModel.page,
      pageSize: recycleQueryModel.pageSize,
      entity: recycleQueryModel.entity || undefined
    };
  }

  function jobListQuery(): V2GovernanceJobQuery {
    return {
      page: jobQueryModel.page,
      pageSize: jobQueryModel.pageSize,
      type: jobQueryModel.type || undefined,
      status: jobQueryModel.status || undefined
    };
  }

  const overviewQuery = useV2ModuleQuery({
    moduleKey: 'data-governance',
    trackRouteData: () => activeTab.value === 'overview',
    scope: 'data-governance',
    key: 'overview',
    keepPreviousData: true,
    query: ({ signal }) => v2DataGovernanceApi.overview({ signal })
  });
  const recycleQuery = useV2ModuleQuery({
    moduleKey: 'data-governance',
    trackRouteData: () => activeTab.value === 'recycle',
    scope: 'data-governance',
    key: () => createDataGovernanceQueryKey('recycle', recycleListQuery()),
    keepPreviousData: true,
    query: ({ signal }) => v2DataGovernanceApi.recycleBin(recycleListQuery(), { signal })
  });
  const jobsQuery = useV2ModuleQuery({
    moduleKey: 'data-governance',
    trackRouteData: () => activeTab.value === 'jobs',
    scope: 'data-governance',
    key: () => createDataGovernanceQueryKey('jobs', jobListQuery()),
    keepPreviousData: true,
    query: ({ signal }) => v2DataGovernanceApi.jobs(jobListQuery(), { signal })
  });
  const detailQuery = useV2ModuleQuery<V2GovernanceJobDetail | null>({
    moduleKey: 'data-governance',
    trackRouteData: false,
    scope: 'data-governance',
    key: () => `detail:${detailId.value || 'none'}`,
    enabled: () => Boolean(detailId.value),
    keepPreviousData: false,
    query: ({ signal }) => v2DataGovernanceApi.job(detailId.value, { signal })
  });

  const overview = computed(() => overviewQuery.data.value);
  const recycleItems = computed(() => recycleQuery.data.value?.items ?? []);
  const recycleTotal = computed(() => recycleQuery.data.value?.total ?? 0);
  const recycleCounts = computed(
    () =>
      recycleQuery.data.value?.byEntity ?? {
        account: 0,
        customer: 0,
        option: 0,
        order: 0
      }
  );
  const jobs = computed(() => jobsQuery.data.value?.items ?? []);
  const jobsTotal = computed(() => jobsQuery.data.value?.total ?? 0);
  const detail = computed(() => detailQuery.data.value ?? null);
  const overviewLoading = computed(
    () => overviewQuery.isInitialLoading.value || overviewQuery.isRefreshing.value
  );
  const recycleLoading = computed(
    () => recycleQuery.isInitialLoading.value || recycleQuery.isRefreshing.value
  );
  const jobsLoading = computed(
    () => jobsQuery.isInitialLoading.value || jobsQuery.isRefreshing.value
  );
  const detailLoading = computed(
    () => detailQuery.isInitialLoading.value || detailQuery.isRefreshing.value
  );
  const overviewError = computed(() =>
    overviewQuery.error.value ? getApiErrorMessage(overviewQuery.error.value) : ''
  );
  const recycleError = computed(() =>
    recycleQuery.error.value ? getApiErrorMessage(recycleQuery.error.value) : ''
  );
  const jobsError = computed(() =>
    jobsQuery.error.value ? getApiErrorMessage(jobsQuery.error.value) : ''
  );
  const detailError = computed(() =>
    detailQuery.error.value ? getApiErrorMessage(detailQuery.error.value) : ''
  );
  const previewBlockedReason = computed(() =>
    governancePreviewBlockedReason(overview.value, {
      loading: overviewLoading.value,
      error: overviewError.value
    })
  );
  const restoreDirty = computed(() => JSON.stringify(restoreForm) !== restoreBaseline.value);
  const cleanupDirty = computed(() => JSON.stringify(cleanupForm) !== cleanupBaseline.value);
  const decisionDirty = computed(() => JSON.stringify(decisionForm) !== decisionBaseline.value);
  function refreshOverview() {
    return overviewQuery.refresh();
  }
  function refreshRecycle() {
    selectedRecycleItems.value = [];
    return recycleQuery.refresh();
  }
  function refreshJobs() {
    return jobsQuery.refresh();
  }
  function refreshDetail() {
    return detailQuery.refresh();
  }
  function handleRecycleFilterChange() {
    recycleQueryModel.page = 1;
    void refreshRecycle();
  }
  function handleJobFilterChange() {
    jobQueryModel.page = 1;
    void refreshJobs();
  }
  const {
    recycleDisplayedPage,
    recycleDisplayedPageSize,
    jobsDisplayedPage,
    jobsDisplayedPageSize,
    handleRecyclePageChange,
    handleRecyclePageSizeChange,
    handleJobPageChange,
    handleJobPageSizeChange
  } = useDataGovernancePagination({
    recycleData: recycleQuery.data,
    jobsData: jobsQuery.data,
    recycleQuery: recycleQueryModel,
    jobsQuery: jobQueryModel,
    refreshRecycle,
    refreshJobs
  });

  function handleRecycleSelection(items: V2GovernanceRecycleItem[]) {
    selectedRecycleItems.value = items;
  }

  function isRecycleSelected(item: V2GovernanceRecycleItem) {
    return selectedRecycleItems.value.some(
      (selected) => selected.id === item.id && selected.entity === item.entity
    );
  }

  function toggleRecycleSelection(item: V2GovernanceRecycleItem, selected: boolean) {
    const next = selectedRecycleItems.value.filter(
      (current) => current.id !== item.id || current.entity !== item.entity
    );
    if (selected) next.push(item);
    selectedRecycleItems.value = next;
  }

  function openRestoreDrawer() {
    if (previewBlockedReason.value) {
      ElMessage.warning(previewBlockedReason.value);
      return;
    }
    if (!selectedRecycleItems.value.length) {
      ElMessage.warning('请先选择需要恢复的回收站记录');
      return;
    }
    Object.assign(restoreForm, RESTORE_INITIAL);
    restoreBaseline.value = JSON.stringify(restoreForm);
    mutationError.value = '';
    restoreDrawerVisible.value = true;
  }

  async function openRestoreDrawerFromAuditRoute() {
    const request = readAuditRestoreRouteRequest(route.query);
    if (!request) return;

    const requestKey = routeRestoreRequestKey(request);
    if (handledRouteRestoreKey.value === requestKey) return;
    handledRouteRestoreKey.value = requestKey;

    activeTab.value = 'recycle';
    if (recycleQueryModel.entity !== request.entity) {
      recycleQueryModel.entity = request.entity;
      recycleQueryModel.page = 1;
      await refreshRecycle();
    } else {
      await recycleQuery.ensureFresh();
    }

    const matchingItem =
      recycleItems.value.find((item) => item.entity === request.entity && item.id === request.id) ??
      createRecycleItemFromAuditRestoreRequest(request);
    selectedRecycleItems.value = [matchingItem];
    Object.assign(restoreForm, {
      reason: buildAuditRestoreReason(request, matchingItem),
      backupEvidence: ''
    });
    restoreBaseline.value = JSON.stringify(restoreForm);
    mutationError.value = '';

    await overviewQuery.ensureFresh();
    if (previewBlockedReason.value) {
      ElMessage.warning(previewBlockedReason.value);
      return;
    }
    restoreDrawerVisible.value = true;
  }

  function openCleanupDrawer() {
    if (previewBlockedReason.value) {
      ElMessage.warning(previewBlockedReason.value);
      return;
    }
    Object.assign(cleanupForm, CLEANUP_INITIAL);
    cleanupBaseline.value = JSON.stringify(cleanupForm);
    mutationError.value = '';
    cleanupDrawerVisible.value = true;
  }

  async function submitRestore() {
    if (!(await validateV2Form(restoreFormRef.value))) return;
    mutationBusy.value = 'restore';
    mutationError.value = '';
    try {
      const job = await v2DataGovernanceApi.previewRestore({
        items: selectedRecycleItems.value.map((item) => ({ entity: item.entity, id: item.id })),
        reason: restoreForm.reason.trim(),
        backupEvidence: restoreForm.backupEvidence.trim(),
        idempotencyKey: createGovernanceMutationKey('governance:restore')
      });
      restoreDrawerVisible.value = false;
      activeTab.value = 'jobs';
      await Promise.all([refreshJobs(), refreshOverview()]);
      ElMessage.success(`恢复预览已生成：${job.jobNo}`);
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
    } finally {
      mutationBusy.value = '';
    }
  }

  async function submitCleanup() {
    if (!(await validateV2Form(cleanupFormRef.value))) return;
    mutationBusy.value = 'cleanup';
    mutationError.value = '';
    try {
      const job = await v2DataGovernanceApi.previewCleanup({
        olderThanDays: cleanupForm.olderThanDays,
        reason: cleanupForm.reason.trim(),
        backupEvidence: cleanupForm.backupEvidence.trim(),
        idempotencyKey: createGovernanceMutationKey('governance:cleanup')
      });
      cleanupDrawerVisible.value = false;
      activeTab.value = 'jobs';
      await refreshJobs();
      ElMessage.success(`清理预览已生成：${job.jobNo}`);
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
    } finally {
      mutationBusy.value = '';
    }
  }

  function canApprove(job: V2GovernanceJob) {
    return job.status === 'pending_approval' && job.requestedByUserId !== authStore.user?.id;
  }

  function canCancel(job: V2GovernanceJob) {
    return canCancelGovernanceJob(job, authStore.user?.id);
  }

  async function cancelJob(job: V2GovernanceJob) {
    if (!canCancel(job)) return;
    let reason: string;
    try {
      const result = await ElMessageBox.prompt(
        '取消后任务不能审批或执行，预览和审计记录仍会保留。',
        `取消治理任务 · ${job.jobNo}`,
        {
          type: 'warning',
          inputType: 'textarea',
          inputPlaceholder: '请输入 4 至 1000 个字符的取消原因',
          inputValidator: (input) => {
            const length = input.trim().length;
            return length >= 4 && length <= 1_000 ? true : '取消原因必须为 4 至 1000 个字符';
          },
          confirmButtonText: '确认取消任务',
          cancelButtonText: '返回'
        }
      );
      reason = result.value.trim();
    } catch {
      return;
    }

    mutationBusy.value = `cancel:${job.id}`;
    mutationError.value = '';
    try {
      await v2DataGovernanceApi.cancel(job.id, { reason });
      await Promise.all([refreshJobs(), refreshOverview()]);
      if (detailId.value === job.id) await detailQuery.refresh();
      ElMessage.success('治理任务已取消，预览和审计记录已保留');
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
      ElMessage.error(mutationError.value);
    } finally {
      mutationBusy.value = '';
    }
  }

  function openDecisionDrawer(job: V2GovernanceJob) {
    decisionTarget.value = job;
    Object.assign(decisionForm, DECISION_INITIAL);
    decisionBaseline.value = JSON.stringify(decisionForm);
    mutationError.value = '';
    decisionDrawerVisible.value = true;
  }

  async function submitDecision() {
    if (!decisionTarget.value || !(await validateV2Form(decisionFormRef.value))) return;
    mutationBusy.value = 'decision';
    mutationError.value = '';
    try {
      const job = await v2DataGovernanceApi.decide(decisionTarget.value.id, {
        decision: decisionForm.decision,
        reason: decisionForm.reason.trim()
      });
      decisionDrawerVisible.value = false;
      await refreshJobs();
      if (detailId.value === job.id) await detailQuery.refresh();
      ElMessage.success(decisionForm.decision === 'approved' ? '审批已通过' : '申请已驳回');
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
    } finally {
      mutationBusy.value = '';
    }
  }

  async function executeJob(job: V2GovernanceJob) {
    try {
      await ElMessageBox.confirm(
        `将按已审批预览执行 ${job.jobNo} 的下一批，单条失败不会中断整批。`,
        '确认执行治理任务',
        { type: 'warning', confirmButtonText: '执行下一批', cancelButtonText: '取消' }
      );
    } catch {
      return;
    }
    mutationBusy.value = `execute:${job.id}`;
    mutationError.value = '';
    try {
      const result = await v2DataGovernanceApi.execute(job.id, {
        batchSize: 50,
        idempotencyKey: createGovernanceMutationKey(`governance:execute:${job.id}`)
      });
      await Promise.all([refreshJobs(), refreshOverview(), refreshRecycle()]);
      if (detailId.value === job.id) await detailQuery.refresh();
      ElMessage.success(
        result.job.status === 'approved' ? '本批已完成，仍有待执行明细' : '治理任务执行完成'
      );
    } catch (error) {
      mutationError.value = getApiErrorMessage(error);
      ElMessage.error(mutationError.value);
    } finally {
      mutationBusy.value = '';
    }
  }

  async function openDetail(job: V2GovernanceJob) {
    detailId.value = job.id;
    detailDrawerVisible.value = true;
    await detailQuery.refresh();
  }

  function beforeClose(dirty: boolean, done: () => void) {
    if (mutationBusy.value) {
      ElMessage.warning('正在提交，请稍候');
      return;
    }
    if (!dirty) {
      done();
      return;
    }
    void ElMessageBox.confirm('当前内容尚未提交，确认关闭吗？', '关闭确认', {
      type: 'warning',
      confirmButtonText: '确认关闭',
      cancelButtonText: '继续填写'
    })
      .then(done)
      .catch(() => undefined);
  }

  watch(
    () => route.query.tab,
    (tab) => {
      activeTab.value = readGovernanceTab(tab);
    },
    { immediate: true }
  );

  watch(detailDrawerVisible, (visible) => {
    if (!visible) detailId.value = '';
  });

  watch(
    () => [
      route.query.restoreEntity,
      route.query.restoreId,
      route.query.sourceAuditId,
      route.query.sourceAuditAt
    ],
    () => {
      void openRestoreDrawerFromAuditRoute();
    },
    { immediate: true }
  );

  return {
    activeTab,
    recycleQueryModel,
    jobQueryModel,
    selectedRecycleItems,
    restoreDrawerVisible,
    cleanupDrawerVisible,
    decisionDrawerVisible,
    detailDrawerVisible,
    restoreFormRef,
    cleanupFormRef,
    decisionFormRef,
    restoreForm,
    cleanupForm,
    decisionForm,
    decisionTarget,
    mutationBusy,
    mutationError,
    overview,
    recycleItems,
    recycleTotal,
    recycleDisplayedPage,
    recycleDisplayedPageSize,
    recycleCounts,
    jobs,
    jobsTotal,
    jobsDisplayedPage,
    jobsDisplayedPageSize,
    detail,
    overviewQueryPhase: overviewQuery.phase,
    recycleQueryPhase: recycleQuery.phase,
    jobsQueryPhase: jobsQuery.phase,
    detailQueryPhase: detailQuery.phase,
    recycleParameterTransition: recycleQuery.isParameterTransition,
    jobsParameterTransition: jobsQuery.isParameterTransition,
    overviewLoading,
    recycleLoading,
    jobsLoading,
    detailLoading,
    overviewError,
    recycleError,
    jobsError,
    detailError,
    previewBlockedReason,
    restoreDirty,
    cleanupDirty,
    decisionDirty,
    restoreRules,
    cleanupRules,
    decisionRules,
    overviewHasData: overviewQuery.hasData,
    recycleHasData: recycleQuery.hasData,
    jobsHasData: jobsQuery.hasData,
    detailHasData: detailQuery.hasData,
    refreshOverview,
    refreshRecycle,
    refreshJobs,
    refreshDetail,
    handleRecycleFilterChange,
    handleRecyclePageChange,
    handleRecyclePageSizeChange,
    handleJobFilterChange,
    handleJobPageChange,
    handleJobPageSizeChange,
    handleRecycleSelection,
    isRecycleSelected,
    toggleRecycleSelection,
    openRestoreDrawer,
    openCleanupDrawer,
    submitRestore,
    submitCleanup,
    canApprove,
    canCancel,
    cancelJob,
    openDecisionDrawer,
    submitDecision,
    executeJob,
    openDetail,
    beforeClose,
    recycleEntityLabels,
    recycleEntityLabel,
    governanceJobTypeLabels,
    governanceJobTypeLabel,
    governanceJobStatusMeta,
    getGovernanceJobStatusMeta,
    governanceItemStatusMeta,
    getGovernanceItemStatusMeta,
    formatGovernanceDate,
    shortHash
  };
}
