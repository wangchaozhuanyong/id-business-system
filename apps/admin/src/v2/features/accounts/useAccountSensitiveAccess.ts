import type { Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2SensitiveAccessApproval } from '@/v2/composables/useV2SensitiveAccessApproval';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2AccountsApi } from './api';
import type { V2Account, V2AccountSecretField } from './contracts';

interface AccountSensitiveAccessForm {
  field: V2AccountSecretField | '';
  reason: string;
  value: string;
}

interface UseAccountSensitiveAccessOptions {
  revealTarget: Ref<V2Account | null>;
  revealing: Ref<boolean>;
  revealForm: AccountSensitiveAccessForm;
}

export function useAccountSensitiveAccess(options: UseAccountSensitiveAccessOptions) {
  const sensitiveAccess = useV2SensitiveAccessApproval();

  function prepareSensitiveAccess(field: V2AccountSecretField | '') {
    if (!options.revealTarget.value || !field) return Promise.resolve();
    return sensitiveAccess.prepare({
      module: 'id_business_v2_account',
      fieldName: field,
      objectType: 'id_business_v2_account',
      objectId: options.revealTarget.value.id
    });
  }

  function changeRevealField(field: V2AccountSecretField) {
    options.revealForm.reason = '';
    options.revealForm.value = '';
    void prepareSensitiveAccess(field);
  }

  async function revealSecret() {
    if (!options.revealTarget.value || !options.revealForm.field) return;
    options.revealing.value = true;
    try {
      if (sensitiveAccess.requiresApproval.value && !sensitiveAccess.approvedRequestId.value) {
        await sensitiveAccess.submitRequest(options.revealForm.reason);
        ElMessage.success('查看申请已提交，管理员审核后即可查看');
        return;
      }
      const result = await idBusinessV2AccountsApi.revealSecret(
        options.revealTarget.value.id,
        options.revealForm.field,
        {
          reason: options.revealForm.reason.trim(),
          approvalId: sensitiveAccess.approvedRequestId.value
        }
      );
      options.revealForm.value = result.value;
      ElMessage.success('完整资料已显示，并已写入敏感访问日志');
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      options.revealing.value = false;
    }
  }

  return {
    sensitiveAccessPolicy: sensitiveAccess.policy,
    sensitiveAccessRequest: sensitiveAccess.request,
    sensitiveAccessRequiresApproval: sensitiveAccess.requiresApproval,
    sensitiveAccessCanReveal: sensitiveAccess.canReveal,
    sensitiveAccessLoading: sensitiveAccess.loading,
    sensitiveAccessRequesting: sensitiveAccess.requesting,
    sensitiveAccessError: sensitiveAccess.error,
    sensitiveAccessStatusText: sensitiveAccess.statusText,
    sensitiveAccessActionText: sensitiveAccess.actionText,
    prepareSensitiveAccess,
    changeRevealField,
    refreshSensitiveAccess: sensitiveAccess.refresh,
    revealSecret
  };
}
