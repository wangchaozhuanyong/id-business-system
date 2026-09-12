import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import type {
  UpdateV2RechargeBitBrowserSettingsInput,
  V2RechargeBitBrowserSettings
} from './contracts';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi } from './api';
import { readBrowserCatalog, useRechargeBrowserCatalog } from './useRechargeBrowserCatalog';

export type ConnectorStatus = 'unknown' | 'checking' | 'online' | 'offline';
export interface BitBrowserSettingsForm extends UpdateV2RechargeBitBrowserSettingsInput {
  localApiToken: string;
  connectorToken: string;
  dynamicProxyUrl: string;
  browserOptions: NonNullable<UpdateV2RechargeBitBrowserSettingsInput['browserOptions']>;
  staticProxyUsername: string;
  staticProxyPassword: string;
  clearStaticProxyCredentials: boolean;
}

const formFromSettings = (settings?: V2RechargeBitBrowserSettings): BitBrowserSettingsForm => ({
  connectorUrl: settings?.connectorUrl ?? 'http://127.0.0.1:55321',
  localApiUrl: settings?.localApiUrl ?? 'http://127.0.0.1:54345',
  localApiToken: '',
  connectorToken: '',
  groupName: settings?.groupName ?? 'gpt账号注册',
  tagName: settings?.tagName ?? '申请gpt',
  proxyType: settings?.proxyType ?? 'http',
  dynamicProxyUrl: '',
  browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, ...settings?.browserOptions },
  staticProxyUsername: '',
  staticProxyPassword: '',
  clearStaticProxyCredentials: false
});

export function useRechargeBrowserSettings(
  connectorStatus: Ref<ConnectorStatus>,
  connectorMessage: Ref<string>
) {
  const settingsOpen = ref(false);
  const settingsSaving = ref(false);
  const settingsError = ref('');
  const settingsForm = ref(formFromSettings());
  const savedSnapshot = ref(JSON.stringify(settingsForm.value));
  const settingsDirty = computed(() => JSON.stringify(settingsForm.value) !== savedSnapshot.value);
  const settingsQuery = useV2ModuleQuery<V2RechargeBitBrowserSettings>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: () => 'auto-recharge-bitbrowser-settings',
    keepPreviousData: true,
    query: ({ signal }) => rechargeApi.getBitBrowserSettings({ signal })
  });
  const browserCatalog = useRechargeBrowserCatalog(settingsForm, settingsOpen, settingsQuery.data);
  let connectionCheck: AbortController | undefined;

  function resetSettings() {
    settingsForm.value = formFromSettings(settingsQuery.data.value);
    savedSnapshot.value = JSON.stringify(settingsForm.value);
    settingsError.value = '';
  }

  watch(
    () => settingsQuery.data.value,
    () => {
      if (!settingsSaving.value && !settingsDirty.value) resetSettings();
    },
    { immediate: true }
  );

  function setSettingsOpen(open: boolean) {
    if (settingsSaving.value) return;
    resetSettings();
    settingsOpen.value = open;
  }

  async function checkConnection(form: BitBrowserSettingsForm) {
    connectionCheck?.abort();
    const check = new AbortController();
    connectionCheck = check;
    connectorStatus.value = 'checking';
    connectorMessage.value = '正在检测连接器、比特接口和窗口分组／标签';
    try {
      const catalog = await readBrowserCatalog(form, check.signal);
      if (check.signal.aborted) throw new Error('本次连接检测已取消。');
      if (catalog.groups.filter((item) => item.name === form.groupName).length !== 1)
        throw new Error('比特接口已连通，但所选窗口分组不存在或重名，请重新选择。');
      if (catalog.tags.filter((item) => item.name === form.tagName).length !== 1)
        throw new Error('比特接口已连通，但所选窗口标签不存在或重名，请重新选择。');
      connectorStatus.value = 'online';
      connectorMessage.value = '连接器、比特接口和分组／标签检测通过';
    } catch (cause) {
      if (connectionCheck === check) {
        connectorStatus.value = 'offline';
        connectorMessage.value = getApiErrorMessage(cause);
      }
      throw cause;
    } finally {
      if (connectionCheck === check) connectionCheck = undefined;
    }
  }

  async function testConnector() {
    try {
      await checkConnection({ ...settingsForm.value });
    } catch {
      /* 具体原因保留在当前抽屉内。 */
    }
  }

  async function checkSavedConnection() {
    const settings = settingsQuery.data.value;
    if (!settings) throw new Error('请先读取并保存比特浏览器设置。');
    await checkConnection(formFromSettings(settings));
  }

  async function saveSettings() {
    if (settingsSaving.value) return;
    if (browserCatalog.selectionError.value) {
      settingsError.value = browserCatalog.selectionError.value;
      return;
    }
    const stored = settingsQuery.data.value;
    if (
      (!stored?.localApiTokenConfigured && !settingsForm.value.localApiToken) ||
      (!stored?.connectorTokenConfigured && !settingsForm.value.connectorToken) ||
      (settingsForm.value.browserOptions.proxyMode === 'dynamic' &&
        !stored?.dynamicProxyUrlConfigured &&
        !settingsForm.value.dynamicProxyUrl)
    ) {
      settingsError.value = '请填写连接密钥及当前代理模式所需的配置。';
      return;
    }
    settingsSaving.value = true;
    settingsError.value = '';
    try {
      const { staticProxyUsername, staticProxyPassword, ...input } = settingsForm.value;
      const updated = await rechargeApi.updateBitBrowserSettings({
        ...input,
        localApiToken: settingsForm.value.localApiToken || undefined,
        connectorToken: settingsForm.value.connectorToken || undefined,
        dynamicProxyUrl: settingsForm.value.dynamicProxyUrl || undefined,
        staticProxyCredentials:
          !input.clearStaticProxyCredentials && (staticProxyUsername || staticProxyPassword)
            ? { username: staticProxyUsername, password: staticProxyPassword }
            : undefined
      });
      settingsQuery.data.value = updated;
      resetSettings();
      settingsOpen.value = false;
    } catch (cause) {
      settingsError.value = getApiErrorMessage(cause);
    } finally {
      settingsSaving.value = false;
    }
  }

  onScopeDispose(() => {
    connectionCheck?.abort();
    settingsForm.value = formFromSettings();
  });

  return {
    ...browserCatalog,
    settingsQuery,
    settingsOpen,
    settingsSaving,
    settingsError,
    settingsDirty,
    settingsForm,
    setSettingsOpen,
    testConnector,
    checkSavedConnection,
    saveSettings,
    connectorStatus,
    connectorMessage
  };
}
