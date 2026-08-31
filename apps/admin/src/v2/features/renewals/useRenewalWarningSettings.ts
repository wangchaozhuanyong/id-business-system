import { computed, reactive, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import type { V2RenewalWarningSettings } from './contracts';
import { idBusinessV2RenewalsApi } from './api';

const RENEWAL_WARNING_REFRESH_EVENT = 'v2:renewal-warning-refresh';

export function useRenewalWarningSettings(options: {
  onSaved: (settings: V2RenewalWarningSettings) => Promise<void>;
}) {
  const authStore = useAuthStore();
  const canManageWarning = computed(
    () =>
      hasUserPermission(authStore.user, 'apple.renewal_task.view') &&
      hasUserPermission(authStore.user, 'apple.renewal_task.update') &&
      hasUserPermission(authStore.user, 'id_business_v2.renewal_warning.manage')
  );
  const warningSettingsVisible = ref(false);
  const warningSettingsLoading = ref(false);
  const warningSettingsSaving = ref(false);
  const warningSettingsError = ref('');
  const warningDaysInput = ref(3);
  const warningSettings = reactive<V2RenewalWarningSettings>({
    warningDays: 3,
    defaultWarningDays: 3,
    minWarningDays: 1,
    maxWarningDays: 365,
    updatedAt: null
  });

  async function openWarningSettings() {
    if (!canManageWarning.value) return;
    warningSettingsVisible.value = true;
    warningSettingsLoading.value = true;
    warningSettingsError.value = '';
    try {
      const result = await idBusinessV2RenewalsApi.getWarningSettings();
      Object.assign(warningSettings, result);
      warningDaysInput.value = result.warningDays;
    } catch (error) {
      warningSettingsError.value = getApiErrorMessage(error);
    } finally {
      warningSettingsLoading.value = false;
    }
  }

  async function saveWarningSettings() {
    if (
      !canManageWarning.value ||
      warningSettingsSaving.value ||
      !Number.isInteger(warningDaysInput.value) ||
      warningDaysInput.value < warningSettings.minWarningDays ||
      warningDaysInput.value > warningSettings.maxWarningDays
    ) {
      return;
    }
    warningSettingsSaving.value = true;
    warningSettingsError.value = '';
    try {
      const result = await idBusinessV2RenewalsApi.updateWarningSettings(
        warningDaysInput.value,
        warningSettings.updatedAt
      );
      Object.assign(warningSettings, result);
      await options.onSaved(result);
      window.dispatchEvent(new Event(RENEWAL_WARNING_REFRESH_EVENT));
      warningSettingsVisible.value = false;
      ElMessage.success(`已设为提前 ${result.warningDays} 天预警`);
    } catch (error) {
      warningSettingsError.value = getApiErrorMessage(error);
    } finally {
      warningSettingsSaving.value = false;
    }
  }

  return {
    canManageWarning,
    warningSettings,
    warningSettingsVisible,
    warningSettingsLoading,
    warningSettingsSaving,
    warningSettingsError,
    warningDaysInput,
    openWarningSettings,
    saveWarningSettings
  };
}
