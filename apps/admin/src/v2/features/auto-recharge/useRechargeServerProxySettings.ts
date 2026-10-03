import { computed, ref, watch } from 'vue';
import type { V2RechargeServerProxySettings } from './contracts';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { rechargeApi } from './api';
import { readActiveRechargeProxies, type RechargeProxyItem } from './recharge-proxy-api';

export function useRechargeServerProxySettings() {
  const open = ref(false);
  const { error, saving, proxyId, snapshot } = useV2SessionDraft(
    'recharge-server-proxy-settings',
    () => ({
      error: ref(''),
      saving: ref(false),
      proxyId: ref(''),
      snapshot: ref('')
    })
  );
  const dirty = computed(() => proxyId.value !== snapshot.value);
  const settingsQuery = useV2ModuleQuery<V2RechargeServerProxySettings>({
    moduleKey: 'auto-recharge',
    scope: 'auto-recharge',
    key: 'auto-recharge-server-proxy-settings',
    keepPreviousData: true,
    query: ({ signal }) => rechargeApi.getServerProxySettings({ signal })
  });
  const catalogQuery = useV2ModuleQuery<{ items: RechargeProxyItem[] }>({
    moduleKey: 'recharge-proxies',
    scope: 'auto-recharge',
    trackRouteData: false,
    key: 'auto-recharge-default-proxy-catalog',
    enabled: () => open.value,
    keepPreviousData: true,
    query: ({ signal }) => readActiveRechargeProxies(signal)
  });
  const items = computed(() => catalogQuery.data.value?.items ?? []);
  const selected = computed(() => items.value.find((item) => item.id === proxyId.value));
  const ready = computed(
    () => settingsQuery.phase.value === 'ready' && catalogQuery.phase.value === 'ready'
  );
  function reset() {
    proxyId.value = settingsQuery.data.value?.proxyId ?? '';
    snapshot.value = proxyId.value;
    error.value = '';
  }
  watch(
    () => settingsQuery.data.value,
    () => {
      if (!saving.value && !dirty.value) reset();
    },
    { immediate: true }
  );
  function setOpen(value: boolean) {
    if (saving.value) return;
    open.value = value;
  }
  async function save() {
    if (saving.value || !ready.value) return;
    if (proxyId.value && !selected.value) {
      error.value = '默认代理已停用或删除，请重新选择或清除默认值';
      return;
    }
    saving.value = true;
    error.value = '';
    try {
      settingsQuery.data.value = await rechargeApi.updateServerProxySettings(proxyId.value || null);
      reset();
      open.value = false;
    } catch (cause) {
      error.value = getApiErrorMessage(cause);
    } finally {
      saving.value = false;
    }
  }
  return {
    open,
    saving,
    error,
    proxyId,
    dirty,
    settingsQuery,
    catalogQuery,
    items,
    selected,
    ready,
    setOpen,
    save
  };
}
