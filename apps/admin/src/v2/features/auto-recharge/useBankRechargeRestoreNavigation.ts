import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';

export function useBankRechargeRestoreNavigation() {
  const router = useRouter();
  const restoreNavigationError = ref('');
  async function requestRestore(
    entity: 'chatgpt_account' | 'bank_recharge_order',
    item: { id: string; deletedAt?: string | null },
    label: string
  ) {
    restoreNavigationError.value = '';
    try {
      const failure = await router.push({
        path: '/v2/data/governance',
        query: {
          tab: 'recycle',
          restoreEntity: entity,
          restoreId: item.id,
          restoreLabel: label,
          sourceAuditAt: item.deletedAt ?? ''
        }
      });
      if (failure) restoreNavigationError.value = '恢复申请页面未能打开，请重试';
    } catch (cause) {
      restoreNavigationError.value = getApiErrorMessage(cause);
    }
  }
  return { requestRestore, restoreNavigationError };
}
