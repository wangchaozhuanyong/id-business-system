import { computed, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import type {
  V2SensitiveAccessContext,
  V2SensitiveAccessPolicy,
  V2SensitiveAccessRequest
} from '@/v2/types/sensitiveAccess';

/** 兼容已有资料面板；查看权限统一来自业务模块，不再创建查看申请。 */
export function useV2SensitiveAccessApproval() {
  const auth = useAuthStore();
  const context = ref<V2SensitiveAccessContext | null>(null);
  const permission = computed(() =>
    context.value?.module === 'id_business_v2_customer' ? 'customer.view' : 'apple.account.view'
  );
  const canReveal = computed(() => hasUserPermission(auth.user, permission.value));
  const policy = computed<V2SensitiveAccessPolicy | null>(() =>
    context.value
      ? {
          ...context.value,
          permissionCode: permission.value,
          label: '业务资料',
          mode: canReveal.value ? 'direct' : 'denied'
        }
      : null
  );
  const request = ref<V2SensitiveAccessRequest | null>(null);
  const inactive = computed(() => false);
  async function prepare(next: V2SensitiveAccessContext) {
    context.value = next;
  }
  async function refresh() {}
  return {
    policy,
    request,
    requestExpired: inactive,
    requiresApproval: inactive,
    approvedRequestId: computed<string | null>(() => null),
    canReveal,
    loading: inactive,
    requesting: inactive,
    error: computed(() => ''),
    statusText: computed(() => '直接查看业务资料'),
    actionText: computed(() => '查看资料'),
    prepare,
    refresh
  };
}
