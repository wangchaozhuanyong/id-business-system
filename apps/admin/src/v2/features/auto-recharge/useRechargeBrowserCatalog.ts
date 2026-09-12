import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { rechargeApi, rechargeConnectorApi } from './api';
import type { V2RechargeBrowserCatalog, V2RechargeBitBrowserSettings } from './contracts';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';

export async function readBrowserCatalog(form: BitBrowserSettingsForm, signal: AbortSignal) {
  await rechargeConnectorApi.health(form.connectorUrl, signal);
  const access =
    form.connectorToken && form.localApiToken
      ? {
          connectorUrl: form.connectorUrl,
          localApiUrl: form.localApiUrl,
          connectorToken: form.connectorToken,
          localApiToken: form.localApiToken
        }
      : await rechargeApi.browserCatalogAccess({ signal });
  try {
    if (
      (!form.connectorToken && form.connectorUrl !== access.connectorUrl) ||
      (!form.localApiToken && form.localApiUrl !== access.localApiUrl)
    ) {
      throw new Error('连接地址已更换，请填写该地址对应的密钥后刷新列表');
    }
    access.connectorUrl = form.connectorUrl;
    access.localApiUrl = form.localApiUrl;
    access.connectorToken = form.connectorToken || access.connectorToken;
    access.localApiToken = form.localApiToken || access.localApiToken;
    return await rechargeConnectorApi.browserCatalog(access, signal);
  } finally {
    access.connectorToken = '';
    access.localApiToken = '';
  }
}

export function useRechargeBrowserCatalog(
  form: Ref<BitBrowserSettingsForm>,
  open: Ref<boolean>,
  stored: Ref<V2RechargeBitBrowserSettings | undefined>
) {
  const sessionId = crypto.randomUUID();
  const revision = ref(0);
  const requested = ref(false);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const catalogQuery = useV2ModuleQuery<V2RechargeBrowserCatalog>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    trackRouteData: false,
    keepPreviousData: true,
    key: () => `auto-recharge-browser-catalog-${sessionId}-${revision.value}`,
    enabled: () => open.value && requested.value,
    query: ({ signal }) => readBrowserCatalog({ ...form.value }, signal)
  });
  async function refreshCatalog() {
    if (disposed) return;
    clearTimeout(timer);
    const currentRevision = ++revision.value;
    requested.value = true;
    await nextTick();
    if (!disposed && open.value && requested.value && revision.value === currentRevision)
      await catalogQuery.refresh();
  }
  watch(
    () => [
      open.value,
      form.value.connectorUrl,
      form.value.localApiUrl,
      form.value.connectorToken,
      form.value.localApiToken,
      stored.value?.updatedAt
    ],
    () => {
      clearTimeout(timer);
      requested.value = false;
      if (open.value) timer = setTimeout(refreshCatalog, 250);
    },
    { flush: 'sync' }
  );

  const options = (kind: 'groups' | 'tags') =>
    computed(() => {
      const items = requested.value ? (catalogQuery.data.value?.[kind] ?? []) : [];
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      return items.map((item) => ({ ...item, disabled: counts.get(item.name)! > 1 }));
    });
  const groupOptions = options('groups');
  const tagOptions = options('tags');
  const catalogReady = computed(() => requested.value && catalogQuery.phase.value === 'ready');
  const selectionError = computed(() => {
    if (!catalogReady.value) return '请先读取比特浏览器分组与标签';
    if (!groupOptions.value.some((item) => !item.disabled && item.name === form.value.groupName))
      return '请选择一个有效且名称唯一的窗口分组';
    if (!tagOptions.value.some((item) => !item.disabled && item.name === form.value.tagName))
      return '请选择一个有效且名称唯一的窗口标签';
    return '';
  });
  onScopeDispose(() => {
    disposed = true;
    clearTimeout(timer);
  });
  return { catalogQuery, groupOptions, tagOptions, catalogReady, selectionError, refreshCatalog };
}
