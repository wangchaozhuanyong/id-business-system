import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { v2ProfileApi } from './api';
import {
  formatProfileDate,
  profileClientSummary,
  profileRoleLabel,
  profileSessionStateMeta
} from './profile-presentation';
import type {
  V2ProfileBootstrap,
  V2ProfileMfaSetupResult,
  V2ProfileSessionRecord
} from './contracts';

export function useProfilePage() {
  const router = useRouter();
  const query = reactive({ page: 1, pageSize: 10 });
  const revokingSessionId = ref('');
  const revokingOthers = ref(false);

  const mfaSetupVisible = ref(false);
  const mfaSetupLoading = ref(false);
  const mfaEnabling = ref(false);
  const mfaMutationError = ref('');
  const mfaSetup = ref<V2ProfileMfaSetupResult | null>(null);
  const mfaCodeForm = reactive({ code: '' });
  const recoveryCodesVisible = ref(false);
  const recoveryCodes = ref<string[]>([]);
  const mfaCodeRules: FormRules<typeof mfaCodeForm> = {
    code: [
      { required: true, message: '请输入动态验证码', trigger: 'blur' },
      { pattern: /^\d{6}$/, message: '动态验证码必须为 6 位数字', trigger: 'blur' }
    ]
  };

  const profileQuery = useV2ModuleQuery<V2ProfileBootstrap>({
    moduleKey: 'profile',
    scope: 'security',
    key: () => createV2QueryKey(query),
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 30_000,
    query: ({ signal }) => v2ProfileApi.bootstrap(query, { signal })
  });

  const profile = computed(() => profileQuery.data.value?.profile ?? null);
  const mfaStatus = computed(() => profileQuery.data.value?.mfaStatus ?? null);
  const sessions = computed(() => profileQuery.data.value?.sessions.items ?? []);
  const sessionTotal = computed(() => profileQuery.data.value?.sessions.total ?? 0);
  const displayedPage = computed(() => profileQuery.data.value?.sessions.page ?? query.page);
  const displayedPageSize = computed(
    () => profileQuery.data.value?.sessions.pageSize ?? query.pageSize
  );
  const hasOtherActiveSessions = computed(() =>
    sessions.value.some((item) => !item.isCurrent && !item.revokedAt)
  );
  const resolved = computed(() => profileQuery.hasData.value);
  const loading = computed(
    () => profileQuery.isInitialLoading.value || profileQuery.isRefreshing.value
  );
  const error = computed(() =>
    profileQuery.error.value ? getApiErrorMessage(profileQuery.error.value) : ''
  );

  function refresh() {
    return profileQuery.refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void profileQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void profileQuery.ensureFresh();
  }

  function openChangePassword() {
    void navigateSafely(router, {
      path: '/change-password',
      query: { redirect: '/v2/profile' }
    });
  }

  async function revokeSession(item: V2ProfileSessionRecord) {
    if (item.isCurrent || item.revokedAt) return;
    try {
      await ElMessageBox.confirm('确认退出这个设备吗？该设备需要重新登录。', '确认退出设备', {
        confirmButtonText: '确认退出',
        cancelButtonText: '取消',
        type: 'warning'
      });
    } catch {
      return;
    }

    revokingSessionId.value = item.id;
    try {
      await v2ProfileApi.revokeSession(item.id);
      ElMessage.success('设备会话已退出。');
      await refresh();
    } catch (mutationError) {
      ElMessage.error(getApiErrorMessage(mutationError));
    } finally {
      revokingSessionId.value = '';
    }
  }

  async function revokeOtherSessions() {
    try {
      await ElMessageBox.confirm(
        '将退出当前设备之外的全部在线会话，其他设备需要重新登录。',
        '确认退出其他设备',
        {
          confirmButtonText: '退出其他设备',
          cancelButtonText: '取消',
          type: 'warning'
        }
      );
    } catch {
      return;
    }

    revokingOthers.value = true;
    try {
      const result = await v2ProfileApi.revokeOtherSessions();
      ElMessage.success(
        result.revokedCount > 0
          ? `已退出 ${result.revokedCount} 个其他设备会话。`
          : '没有需要退出的其他在线设备。'
      );
      await refresh();
    } catch (mutationError) {
      ElMessage.error(getApiErrorMessage(mutationError));
    } finally {
      revokingOthers.value = false;
    }
  }

  async function openMfaSetup() {
    mfaSetupLoading.value = true;
    mfaMutationError.value = '';
    try {
      mfaSetup.value = await v2ProfileApi.setupMfa();
      mfaCodeForm.code = '';
      mfaSetupVisible.value = true;
    } catch (mutationError) {
      ElMessage.error(getApiErrorMessage(mutationError));
    } finally {
      mfaSetupLoading.value = false;
    }
  }

  async function enableMfa(formInstance?: FormInstance) {
    if (!(await validateV2Form(formInstance))) return;
    mfaEnabling.value = true;
    mfaMutationError.value = '';
    try {
      const result = await v2ProfileApi.enableMfa(mfaCodeForm.code.trim());
      mfaSetupVisible.value = false;
      showRecoveryCodes(result.recoveryCodes);
      ElMessage.success('当前账号 MFA 已绑定。');
      await refresh();
    } catch (mutationError) {
      mfaMutationError.value = getApiErrorMessage(mutationError);
    } finally {
      mfaEnabling.value = false;
    }
  }

  async function regenerateRecoveryCodes() {
    let code: string;
    try {
      const result = await ElMessageBox.prompt(
        '旧恢复码会立即失效。请输入当前验证器中的 6 位动态验证码。',
        '重新生成恢复码',
        {
          confirmButtonText: '验证并重新生成',
          cancelButtonText: '取消',
          inputPattern: /^\d{6}$/,
          inputErrorMessage: '请输入 6 位数字动态验证码',
          inputType: 'text'
        }
      );
      code = result.value.trim();
    } catch {
      return;
    }

    try {
      const result = await v2ProfileApi.regenerateRecoveryCodes(code);
      showRecoveryCodes(result.recoveryCodes);
      ElMessage.success('恢复码已重新生成，旧恢复码已失效。');
      await refresh();
    } catch (mutationError) {
      ElMessage.error(getApiErrorMessage(mutationError));
    }
  }

  async function disableMfa() {
    let code: string;
    try {
      const result = await ElMessageBox.prompt(
        '停用后当前账号将失去 MFA 保护。如果管理员强制策略已开启，系统会拒绝本次操作。',
        '确认停用 MFA',
        {
          confirmButtonText: '验证并停用',
          cancelButtonText: '取消',
          type: 'warning',
          inputPattern: /^\d{6}$/,
          inputErrorMessage: '请输入 6 位数字动态验证码',
          inputType: 'text'
        }
      );
      code = result.value.trim();
    } catch {
      return;
    }

    try {
      await v2ProfileApi.disableMfa(code);
      ElMessage.success('当前账号 MFA 已停用。');
      await refresh();
    } catch (mutationError) {
      ElMessage.error(getApiErrorMessage(mutationError));
    }
  }

  function showRecoveryCodes(codes: string[]) {
    recoveryCodes.value = [...codes];
    recoveryCodesVisible.value = true;
  }

  function closeRecoveryCodes() {
    recoveryCodesVisible.value = false;
    recoveryCodes.value = [];
  }

  watch(mfaSetupVisible, (visible) => {
    if (visible) return;
    mfaSetup.value = null;
    mfaCodeForm.code = '';
    mfaMutationError.value = '';
  });

  return {
    query,
    profile,
    mfaStatus,
    sessions,
    sessionTotal,
    displayedPage,
    displayedPageSize,
    hasOtherActiveSessions,
    queryPhase: profileQuery.phase,
    isParameterTransition: profileQuery.isParameterTransition,
    resolved,
    loading,
    error,
    revokingSessionId,
    revokingOthers,
    refresh,
    handlePageChange,
    handlePageSizeChange,
    openChangePassword,
    revokeSession,
    revokeOtherSessions,
    mfaSetupVisible,
    mfaSetupLoading,
    mfaEnabling,
    mfaMutationError,
    mfaSetup,
    mfaCodeForm,
    mfaCodeRules,
    recoveryCodesVisible,
    recoveryCodes,
    openMfaSetup,
    enableMfa,
    regenerateRecoveryCodes,
    disableMfa,
    closeRecoveryCodes,
    formatProfileDate,
    profileClientSummary,
    profileRoleLabel,
    profileSessionStateMeta
  };
}
