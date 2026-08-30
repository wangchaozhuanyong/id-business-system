import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  auditAccessReasonLabel,
  auditActionLabel,
  auditFieldLabel,
  auditModuleLabel,
  auditRemarkLabel,
  auditUserLabel,
  buildOperationAuditRestoreRouteQuery,
  exportOperationAuditRows,
  exportSensitiveAuditRows,
  formatAuditDate,
  formatAuditJson,
  operationObjectLabel,
  sensitiveObjectLabel
} from './audit-log-presentation';
import { v2AuditLogsApi } from './api';
import type {
  V2AuditLogExportInput,
  V2AuditLogListQuery,
  V2AuditLogListResult,
  V2AuditLogRecord,
  V2AuditLogTab,
  V2SensitiveAccessLogListQuery,
  V2SensitiveAccessLogRecord
} from './contracts';

type AuditPageSnapshot =
  | { kind: 'operations'; result: V2AuditLogListResult<V2AuditLogRecord> }
  | { kind: 'sensitive_access'; result: V2AuditLogListResult<V2SensitiveAccessLogRecord> };

export function useAuditLogsPage() {
  const router = useRouter();
  const activeTab = ref<V2AuditLogTab>('operations');
  const createdRange = ref<[string, string] | []>([]);
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    module: '',
    operator: '',
    action: '',
    fieldName: '',
    approved: '' as '' | 'true' | 'false',
    sortBy: 'createdAt',
    sortOrder: 'desc' as 'asc' | 'desc'
  });
  const detailDrawerVisible = ref(false);
  const selectedOperation = ref<V2AuditLogRecord | null>(null);
  const selectedSensitiveAccess = ref<V2SensitiveAccessLogRecord | null>(null);
  const exporting = ref(false);

  function commonFilters() {
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      module: query.module.trim() || undefined,
      operator: query.operator.trim() || undefined,
      createdFrom: createdRange.value[0] || undefined,
      createdTo: createdRange.value[1] || undefined,
      sortOrder: query.sortOrder
    };
  }

  function operationListQuery(): V2AuditLogListQuery {
    const allowedSort = ['createdAt', 'module', 'action', 'objectType'] as const;
    return {
      ...commonFilters(),
      action: query.action.trim() || undefined,
      sortBy: allowedSort.includes(query.sortBy as (typeof allowedSort)[number])
        ? (query.sortBy as V2AuditLogListQuery['sortBy'])
        : 'createdAt'
    };
  }

  function sensitiveListQuery(): V2SensitiveAccessLogListQuery {
    const allowedSort = ['createdAt', 'module', 'fieldName', 'objectType', 'approved'] as const;
    return {
      ...commonFilters(),
      fieldName: query.fieldName.trim() || undefined,
      approved: query.approved || undefined,
      sortBy: allowedSort.includes(query.sortBy as (typeof allowedSort)[number])
        ? (query.sortBy as V2SensitiveAccessLogListQuery['sortBy'])
        : 'createdAt'
    };
  }

  function currentQueryKey() {
    return createV2QueryKey(
      activeTab.value === 'operations'
        ? { kind: activeTab.value, ...operationListQuery() }
        : { kind: activeTab.value, ...sensitiveListQuery() }
    );
  }

  const auditQuery = useV2ModuleQuery<AuditPageSnapshot>({
    moduleKey: 'audit-logs',
    scope: 'audit-logs',
    key: currentQueryKey,
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 60_000,
    query: async ({ signal }) => {
      if (activeTab.value === 'sensitive_access') {
        return {
          kind: 'sensitive_access',
          result: await v2AuditLogsApi.listSensitiveAccess(sensitiveListQuery(), { signal })
        };
      }
      return {
        kind: 'operations',
        result: await v2AuditLogsApi.listOperations(operationListQuery(), { signal })
      };
    }
  });

  const operationItems = computed(() =>
    auditQuery.data.value?.kind === 'operations' ? auditQuery.data.value.result.items : []
  );
  const sensitiveItems = computed(() =>
    auditQuery.data.value?.kind === 'sensitive_access' ? auditQuery.data.value.result.items : []
  );
  const total = computed(() =>
    auditQuery.data.value?.kind === activeTab.value ? auditQuery.data.value.result.total : 0
  );
  const displayedPage = computed(() =>
    auditQuery.data.value?.kind === activeTab.value ? auditQuery.data.value.result.page : query.page
  );
  const displayedPageSize = computed(() =>
    auditQuery.data.value?.kind === activeTab.value
      ? auditQuery.data.value.result.pageSize
      : query.pageSize
  );
  const currentItems = computed(() =>
    activeTab.value === 'operations' ? operationItems.value : sensitiveItems.value
  );
  const activeFilterCount = computed(
    () =>
      [
        query.keyword.trim(),
        query.module.trim(),
        query.operator.trim(),
        activeTab.value === 'operations' ? query.action.trim() : query.fieldName.trim(),
        activeTab.value === 'sensitive_access' ? query.approved : '',
        createdRange.value.length ? 'date' : ''
      ].filter(Boolean).length
  );
  const resolved = computed(() => auditQuery.data.value?.kind === activeTab.value);
  const loading = computed(
    () => auditQuery.isInitialLoading.value || auditQuery.isRefreshing.value
  );
  const listError = computed(() =>
    auditQuery.error.value ? getApiErrorMessage(auditQuery.error.value) : ''
  );

  function refresh() {
    return auditQuery.refresh();
  }

  function handleSearch() {
    query.page = 1;
    void refresh();
  }

  function handleTabChange(name: string | number) {
    activeTab.value = name === 'sensitive_access' ? 'sensitive_access' : 'operations';
    query.page = 1;
    query.sortBy = 'createdAt';
    query.sortOrder = 'desc';
    void auditQuery.ensureFresh();
  }

  function resetFilters() {
    query.page = 1;
    query.keyword = '';
    query.module = '';
    query.operator = '';
    query.action = '';
    query.fieldName = '';
    query.approved = '';
    query.sortBy = 'createdAt';
    query.sortOrder = 'desc';
    createdRange.value = [];
    void refresh();
  }

  function handleSortChange(input: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    if (!input.prop) return;
    const allowed =
      activeTab.value === 'operations'
        ? ['createdAt', 'module', 'action', 'objectType']
        : ['createdAt', 'module', 'fieldName', 'objectType', 'approved'];
    if (!allowed.includes(input.prop)) return;
    query.sortBy = input.prop;
    query.sortOrder = input.order === 'ascending' ? 'asc' : 'desc';
    query.page = 1;
    void refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void auditQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void auditQuery.ensureFresh();
  }

  function openOperationDetails(item: V2AuditLogRecord) {
    selectedSensitiveAccess.value = null;
    selectedOperation.value = item;
    detailDrawerVisible.value = true;
  }

  function openSensitiveDetails(item: V2SensitiveAccessLogRecord) {
    selectedOperation.value = null;
    selectedSensitiveAccess.value = item;
    detailDrawerVisible.value = true;
  }

  function openRestoreFromOperationAudit(item: V2AuditLogRecord) {
    const query = buildOperationAuditRestoreRouteQuery(item);
    if (!query) {
      ElMessage.warning('只有 ID、客户、业务选项和订单的软删除审计可以发起恢复。');
      return;
    }
    detailDrawerVisible.value = false;
    void navigateSafely(router, {
      path: '/v2/data/governance',
      query
    });
  }

  function exportInput(): V2AuditLogExportInput {
    const base = commonFilters();
    return activeTab.value === 'operations'
      ? {
          kind: 'operations',
          keyword: base.keyword,
          module: base.module,
          operator: base.operator,
          createdFrom: base.createdFrom,
          createdTo: base.createdTo,
          action: query.action.trim() || undefined,
          sortBy: operationListQuery().sortBy,
          sortOrder: query.sortOrder
        }
      : {
          kind: 'sensitive_access',
          keyword: base.keyword,
          module: base.module,
          operator: base.operator,
          createdFrom: base.createdFrom,
          createdTo: base.createdTo,
          fieldName: query.fieldName.trim() || undefined,
          approved: query.approved || undefined,
          sortBy: sensitiveListQuery().sortBy,
          sortOrder: query.sortOrder
        };
  }

  async function exportCurrent() {
    if (exporting.value) return;
    exporting.value = true;
    try {
      const result =
        activeTab.value === 'operations'
          ? await v2AuditLogsApi.exportOperations(exportInput())
          : await v2AuditLogsApi.exportSensitiveAccess(exportInput());
      if (result.kind === 'operations') {
        exportOperationAuditRows(result.items as V2AuditLogRecord[]);
      } else {
        exportSensitiveAuditRows(result.items as V2SensitiveAccessLogRecord[]);
      }
      if (result.capped) {
        ElMessage.warning(
          `共 ${result.total} 条，仅导出前 ${result.exportedCount} 条，请缩小筛选范围。`
        );
      } else {
        ElMessage.success(`已导出 ${result.exportedCount} 条记录，并写入导出审计。`);
      }
      void auditQuery.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      exporting.value = false;
    }
  }

  return {
    activeTab,
    createdRange,
    query,
    operationItems,
    sensitiveItems,
    currentItems,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: auditQuery.phase,
    isParameterTransition: auditQuery.isParameterTransition,
    activeFilterCount,
    resolved,
    loading,
    listError,
    detailDrawerVisible,
    selectedOperation,
    selectedSensitiveAccess,
    exporting,
    refresh,
    handleSearch,
    handleTabChange,
    resetFilters,
    handleSortChange,
    handlePageChange,
    handlePageSizeChange,
    openOperationDetails,
    openSensitiveDetails,
    openRestoreFromOperationAudit,
    exportCurrent,
    auditAccessReasonLabel,
    auditActionLabel,
    auditFieldLabel,
    auditModuleLabel,
    auditRemarkLabel,
    auditUserLabel,
    formatAuditDate,
    formatAuditJson,
    operationObjectLabel,
    sensitiveObjectLabel
  };
}
