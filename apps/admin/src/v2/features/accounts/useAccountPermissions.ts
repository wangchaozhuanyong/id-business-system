import { computed, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import type { V2Account, V2AccountSecretField } from './contracts';

export function useAccountPermissions(revealTarget: Ref<V2Account | null>) {
  const authStore = useAuthStore();
  const canCreate = computed(() => hasUserPermission(authStore.user, 'apple.account.create'));
  const canUpdate = computed(() => hasUserPermission(authStore.user, 'apple.account.update'));
  const canImport = computed(() => hasUserPermission(authStore.user, 'apple.account.import'));
  const canAdjustBalance = computed(() =>
    hasUserPermission(authStore.user, 'apple.balance.adjust')
  );
  const canReportLoss = computed(() => canUpdate.value && canAdjustBalance.value);
  const canRevealAppleId = computed(() =>
    hasUserPermission(authStore.user, 'apple.account.view_full')
  );
  const canRevealPassword = computed(() =>
    hasUserPermission(authStore.user, 'apple.secret.view_password')
  );
  const canRevealPhone = computed(() =>
    hasUserPermission(authStore.user, 'apple.secret.view_phone')
  );
  const canRevealSecurity = computed(() =>
    hasUserPermission(authStore.user, 'apple.secret.view_security')
  );
  const revealFieldOptions = computed<Array<{ value: V2AccountSecretField; label: string }>>(() => {
    const target = revealTarget.value;
    if (!target) return [];
    return [
      canRevealAppleId.value ? { value: 'appleId' as const, label: 'ID 账号' } : null,
      target.hasPassword && canRevealPassword.value
        ? { value: 'password' as const, label: 'ID 密码' }
        : null,
      target.hasPhone && canRevealPhone.value
        ? { value: 'phone' as const, label: '手机号码' }
        : null,
      target.hasSecurityInfo && canRevealSecurity.value
        ? { value: 'securityInfo' as const, label: '密保资料' }
        : null
    ].filter((option): option is { value: V2AccountSecretField; label: string } => Boolean(option));
  });

  return {
    canCreate,
    canUpdate,
    canImport,
    canAdjustBalance,
    canReportLoss,
    canRevealAppleId,
    canRevealPassword,
    canRevealPhone,
    canRevealSecurity,
    revealFieldOptions
  };
}
