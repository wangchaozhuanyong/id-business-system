import { computed, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2SensitiveAccessApi } from '@/v2/api/sensitiveAccess';
import { createV2QueryKey, useV2Query } from '@/v2/composables/useV2Query';
import type {
  V2SensitiveAccessContext,
  V2SensitiveAccessRequestList
} from '@/v2/types/sensitiveAccess';

export function useV2SensitiveAccessApproval() {
  const context = ref<V2SensitiveAccessContext | null>(null);
  const requesting = ref(false);

  const policyQuery = useV2Query({
    scope: 'security',
    key: 'sensitive-access-policies',
    freshnessPolicy: 'event-driven',
    query: ({ signal }) => idBusinessV2SensitiveAccessApi.listPolicies({ signal })
  });
  const requestQuery = useV2Query<V2SensitiveAccessRequestList>({
    scope: 'security',
    key: () =>
      createV2QueryKey({
        type: 'my-sensitive-access-request',
        ...(context.value ?? { inactive: true })
      }),
    freshnessPolicy: 'event-with-deadline',
    keepPreviousData: false,
    getRevalidateAt: (result) => result.items[0]?.expiresAt,
    query: ({ signal }) => {
      const current = context.value;
      if (!current) {
        return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 1 });
      }
      return idBusinessV2SensitiveAccessApi.listMyRequests(
        { ...current, page: 1, pageSize: 1 },
        { signal }
      );
    }
  });

  const policy = computed(() => {
    const current = context.value;
    if (!current) return null;
    return (
      policyQuery.data.value?.items.find(
        (item) =>
          item.module === current.module &&
          item.fieldName === current.fieldName &&
          item.objectType === current.objectType
      ) ?? null
    );
  });
  const request = computed(() => requestQuery.data.value?.items[0] ?? null);
  const requestExpired = computed(() => {
    const expiresAt = request.value?.expiresAt;
    return Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  });
  const requiresApproval = computed(() => policy.value?.mode === 'approval_required');
  const approvedRequestId = computed(() =>
    request.value?.status === 'approved' && !requestExpired.value ? request.value.id : null
  );
  const canReveal = computed(
    () =>
      policy.value?.mode === 'direct' ||
      policy.value?.mode === 'admin_bypass' ||
      Boolean(approvedRequestId.value)
  );
  const loading = computed(
    () =>
      policyQuery.isInitialLoading.value ||
      policyQuery.isRefreshing.value ||
      requestQuery.isInitialLoading.value ||
      requestQuery.isRefreshing.value
  );
  const error = computed(() => {
    const issue = policyQuery.error.value ?? requestQuery.error.value;
    return issue ? getApiErrorMessage(issue) : '';
  });
  const statusText = computed(() => {
    if (!requiresApproval.value) {
      return policy.value?.mode === 'admin_bypass' ? '管理员直接查看' : '角色权限直接查看';
    }
    if (!request.value) return '需要提交查看申请';
    if (request.value.status === 'pending') return '等待管理员审核';
    if (request.value.status === 'rejected') {
      return request.value.decisionNote
        ? `申请已拒绝：${request.value.decisionNote}`
        : '申请已拒绝';
    }
    if (requestExpired.value) return '批准已过期，请重新申请';
    return '管理员已批准，可以查看完整资料';
  });
  const actionText = computed(() => {
    if (!requiresApproval.value || approvedRequestId.value) return '查看完整资料';
    if (request.value?.status === 'pending') return '等待管理员审核';
    return '提交查看申请';
  });

  async function prepare(next: V2SensitiveAccessContext) {
    context.value = next;
    await Promise.all([policyQuery.ensureFresh(), requestQuery.ensureFresh()]);
  }

  async function refresh() {
    await Promise.all([policyQuery.refresh(), requestQuery.refresh()]);
  }

  async function submitRequest(reason: string) {
    const current = context.value;
    if (!current) return null;
    requesting.value = true;
    try {
      const result = await idBusinessV2SensitiveAccessApi.createRequest({
        ...current,
        reason: reason.trim()
      });
      await requestQuery.refresh();
      return result;
    } finally {
      requesting.value = false;
    }
  }

  return {
    policy,
    request,
    requestExpired,
    requiresApproval,
    approvedRequestId,
    canReveal,
    loading,
    requesting,
    error,
    statusText,
    actionText,
    prepare,
    refresh,
    submitRequest
  };
}
