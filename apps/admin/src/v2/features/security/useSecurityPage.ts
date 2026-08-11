import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { v2SecurityApi } from './api';
import { useSecurityPolicyManagement } from './useSecurityPolicyManagement';
import {
  clientSummary,
  formatSecurityDate,
  loginRiskLabel,
  loginStatusMeta,
  securityUserLabel,
  sessionStateMeta
} from './security-presentation';
import type {
  V2ActiveSessionRecord,
  V2IpWhitelistListQuery,
  V2IpWhitelistRecord,
  V2LoginLogListQuery,
  V2LoginLogRecord,
  V2MfaSettings,
  V2MfaStatus,
  V2MfaUserListQuery,
  V2MfaUserRecord,
  V2PagedResult,
  V2SecurityOverview,
  V2SecurityTab,
  V2SessionListQuery
} from './contracts';

type SecuritySnapshot =
  | {
      kind: 'login_logs';
      overview: V2SecurityOverview;
      result: V2PagedResult<V2LoginLogRecord>;
    }
  | {
      kind: 'sessions';
      overview: V2SecurityOverview;
      result: V2PagedResult<V2ActiveSessionRecord>;
    }
  | {
      kind: 'policy';
      overview: V2SecurityOverview;
      mfaSettings: V2MfaSettings;
      myMfaStatus: V2MfaStatus;
      mfaUsers: V2PagedResult<V2MfaUserRecord>;
      result: V2PagedResult<V2IpWhitelistRecord>;
    };

const EMPTY_OVERVIEW: V2SecurityOverview = {
  failedLoginCount: 0,
  abnormalLoginCount: 0,
  activeSessionCount: 0,
  pendingApprovalCount: 0,
  enabledWhitelistCount: 0
};

export function useSecurityPage() {
  const activeTab = ref<V2SecurityTab>('login_logs');
  const revokingSessionId = ref('');
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: '' as '' | 'success' | 'failed' | 'blocked',
    abnormal: '' as '' | 'true' | 'false',
    revoked: 'false' as '' | 'true' | 'false',
    scope: '' as '' | 'admin' | 'api',
    enabled: '' as '' | 'true' | 'false',
    sortBy: 'createdAt',
    sortOrder: 'desc' as 'asc' | 'desc',
    mfaUserPage: 1,
    mfaUserPageSize: 10,
    mfaUserKeyword: ''
  });

  function loginQuery(): V2LoginLogListQuery {
    const allowed = ['createdAt', 'username', 'status', 'abnormal', 'ip'] as const;
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      status: query.status || undefined,
      abnormal: query.abnormal || undefined,
      sortBy: allowed.includes(query.sortBy as (typeof allowed)[number])
        ? (query.sortBy as V2LoginLogListQuery['sortBy'])
        : 'createdAt',
      sortOrder: query.sortOrder
    };
  }

  function sessionQuery(): V2SessionListQuery {
    const allowed = ['createdAt', 'lastActiveAt', 'expiresAt', 'revokedAt', 'ip'] as const;
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      revoked: query.revoked || undefined,
      sortBy: allowed.includes(query.sortBy as (typeof allowed)[number])
        ? (query.sortBy as V2SessionListQuery['sortBy'])
        : 'lastActiveAt',
      sortOrder: query.sortOrder
    };
  }

  function whitelistQuery(): V2IpWhitelistListQuery {
    const allowed = ['createdAt', 'updatedAt', 'ipOrCidr', 'scope', 'enabled'] as const;
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      scope: query.scope || undefined,
      enabled: query.enabled || undefined,
      sortBy: allowed.includes(query.sortBy as (typeof allowed)[number])
        ? (query.sortBy as V2IpWhitelistListQuery['sortBy'])
        : 'createdAt',
      sortOrder: query.sortOrder
    };
  }

  function mfaUserQuery(): V2MfaUserListQuery {
    return {
      page: query.mfaUserPage,
      pageSize: query.mfaUserPageSize,
      keyword: query.mfaUserKeyword.trim() || undefined
    };
  }

  function currentQueryKey() {
    if (activeTab.value === 'sessions') return { kind: activeTab.value, ...sessionQuery() };
    if (activeTab.value === 'policy') {
      return {
        kind: activeTab.value,
        whitelist: whitelistQuery(),
        mfaUsers: mfaUserQuery()
      };
    }
    return { kind: activeTab.value, ...loginQuery() };
  }

  const securityQuery = useV2ModuleQuery<SecuritySnapshot>({
    moduleKey: 'security',
    scope: 'security',
    key: () => createV2QueryKey(currentQueryKey()),
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 30_000,
    query: async ({ signal }) => {
      const overviewPromise = v2SecurityApi.overview({ signal });
      if (activeTab.value === 'sessions') {
        const [overview, result] = await Promise.all([
          overviewPromise,
          v2SecurityApi.listSessions(sessionQuery(), { signal })
        ]);
        return { kind: 'sessions', overview, result };
      }
      if (activeTab.value === 'policy') {
        const [overview, mfaSettings, myMfaStatus, mfaUsers, result] = await Promise.all([
          overviewPromise,
          v2SecurityApi.getMfaSettings({ signal }),
          v2SecurityApi.getMyMfaStatus({ signal }),
          v2SecurityApi.listMfaUsers(mfaUserQuery(), { signal }),
          v2SecurityApi.listIpWhitelists(whitelistQuery(), { signal })
        ]);
        return { kind: 'policy', overview, mfaSettings, myMfaStatus, mfaUsers, result };
      }
      const [overview, result] = await Promise.all([
        overviewPromise,
        v2SecurityApi.listLoginLogs(loginQuery(), { signal })
      ]);
      return { kind: 'login_logs', overview, result };
    }
  });

  const overview = computed(() => securityQuery.data.value?.overview ?? EMPTY_OVERVIEW);
  const loginItems = computed(() =>
    securityQuery.data.value?.kind === 'login_logs' ? securityQuery.data.value.result.items : []
  );
  const sessionItems = computed(() =>
    securityQuery.data.value?.kind === 'sessions' ? securityQuery.data.value.result.items : []
  );
  const whitelistItems = computed(() =>
    securityQuery.data.value?.kind === 'policy' ? securityQuery.data.value.result.items : []
  );
  const mfaSettings = computed(() =>
    securityQuery.data.value?.kind === 'policy' ? securityQuery.data.value.mfaSettings : null
  );
  const myMfaStatus = computed(() =>
    securityQuery.data.value?.kind === 'policy' ? securityQuery.data.value.myMfaStatus : null
  );
  const mfaUserItems = computed(() =>
    securityQuery.data.value?.kind === 'policy' ? securityQuery.data.value.mfaUsers.items : []
  );
  const mfaUserTotal = computed(() =>
    securityQuery.data.value?.kind === 'policy' ? securityQuery.data.value.mfaUsers.total : 0
  );
  const total = computed(() =>
    securityQuery.data.value?.kind === activeTab.value ? securityQuery.data.value.result.total : 0
  );
  const currentItems = computed(() => {
    if (activeTab.value === 'sessions') return sessionItems.value;
    if (activeTab.value === 'policy') return whitelistItems.value;
    return loginItems.value;
  });
  const activeFilterCount = computed(() => {
    const values: string[] = [query.keyword.trim()];
    if (activeTab.value === 'login_logs') values.push(query.status, query.abnormal);
    if (activeTab.value === 'sessions') values.push(query.revoked === 'false' ? '' : query.revoked);
    if (activeTab.value === 'policy') values.push(query.scope, query.enabled);
    return values.filter(Boolean).length;
  });
  const resolved = computed(() => securityQuery.data.value?.kind === activeTab.value);
  const loading = computed(
    () => securityQuery.isInitialLoading.value || securityQuery.isRefreshing.value
  );
  const listError = computed(() =>
    securityQuery.error.value ? getApiErrorMessage(securityQuery.error.value) : ''
  );
  const statusItems = computed(() => [
    {
      key: 'failed',
      label: '失败登录',
      count: overview.value.failedLoginCount,
      tone: 'warning' as const
    },
    {
      key: 'abnormal',
      label: '异常登录',
      count: overview.value.abnormalLoginCount,
      tone: 'danger' as const
    },
    {
      key: 'sessions',
      label: '在线会话',
      count: overview.value.activeSessionCount,
      tone: 'success' as const
    },
    {
      key: 'whitelist',
      label: '启用白名单',
      count: overview.value.enabledWhitelistCount,
      tone: 'primary' as const
    }
  ]);

  function refresh() {
    return securityQuery.refresh();
  }

  function handleTabChange(name: string | number) {
    activeTab.value =
      name === 'sessions' ? 'sessions' : name === 'policy' ? 'policy' : 'login_logs';
    resetPageAndSort();
    void securityQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    void refresh();
  }

  function resetFilters() {
    query.keyword = '';
    query.status = '';
    query.abnormal = '';
    query.revoked = 'false';
    query.scope = '';
    query.enabled = '';
    query.mfaUserKeyword = '';
    query.mfaUserPage = 1;
    resetPageAndSort();
    void refresh();
  }

  function resetPageAndSort() {
    query.page = 1;
    query.sortBy = activeTab.value === 'sessions' ? 'lastActiveAt' : 'createdAt';
    query.sortOrder = 'desc';
  }

  function handleSortChange(input: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    if (!input.prop) return;
    query.sortBy = input.prop;
    query.sortOrder = input.order === 'ascending' ? 'asc' : 'desc';
    query.page = 1;
    void refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void securityQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void securityQuery.ensureFresh();
  }

  function handleMfaUserSearch() {
    query.mfaUserPage = 1;
    void refresh();
  }

  function handleMfaUserPageChange(page: number) {
    query.mfaUserPage = page;
    void securityQuery.ensureFresh();
  }

  function handleMfaUserPageSizeChange(pageSize: number) {
    query.mfaUserPageSize = pageSize;
    query.mfaUserPage = 1;
    void securityQuery.ensureFresh();
  }

  function selectMetric(key: string) {
    if (key === 'failed' || key === 'abnormal') {
      activeTab.value = 'login_logs';
      query.status = key === 'failed' ? 'failed' : '';
      query.abnormal = key === 'abnormal' ? 'true' : '';
    } else if (key === 'sessions') {
      activeTab.value = 'sessions';
      query.revoked = 'false';
    } else {
      activeTab.value = 'policy';
      query.enabled = 'true';
    }
    resetPageAndSort();
    void refresh();
  }

  async function revokeSession(item: V2ActiveSessionRecord) {
    if (item.isCurrent || item.revokedAt) return;
    try {
      await ElMessageBox.confirm(
        `确认强制下线 ${securityUserLabel(item.user)} 的这个会话吗？该设备将需要重新登录。`,
        '确认强制下线',
        {
          confirmButtonText: '确认下线',
          cancelButtonText: '取消',
          type: 'warning'
        }
      );
    } catch {
      return;
    }

    revokingSessionId.value = item.id;
    try {
      await v2SecurityApi.revokeSession(item.id);
      ElMessage.success('会话已下线，并写入操作审计。');
      await refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      revokingSessionId.value = '';
    }
  }

  const policyManagement = useSecurityPolicyManagement(refresh);

  return {
    activeTab,
    query,
    overview,
    statusItems,
    loginItems,
    sessionItems,
    whitelistItems,
    mfaSettings,
    myMfaStatus,
    mfaUserItems,
    mfaUserTotal,
    total,
    currentItems,
    activeFilterCount,
    queryPhase: securityQuery.phase,
    isParameterTransition: securityQuery.isParameterTransition,
    resolved,
    loading,
    listError,
    revokingSessionId,
    refresh,
    handleTabChange,
    handleSearch,
    resetFilters,
    handleSortChange,
    handlePageChange,
    handlePageSizeChange,
    handleMfaUserSearch,
    handleMfaUserPageChange,
    handleMfaUserPageSizeChange,
    selectMetric,
    revokeSession,
    formatSecurityDate,
    securityUserLabel,
    loginStatusMeta,
    loginRiskLabel,
    sessionStateMeta,
    clientSummary,
    ...policyManagement
  };
}
