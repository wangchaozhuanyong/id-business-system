import { computed, watch, type Ref } from 'vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { readActiveRechargeProxies, type RechargeProxyItem } from './recharge-proxy-api';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';

export function useManagedBrowserProxy(form: Ref<BitBrowserSettingsForm>, open: Ref<boolean>) {
  const query = useV2ModuleQuery<{ items: RechargeProxyItem[] }>({
    moduleKey: 'recharge-proxies',
    scope: 'auto-recharge',
    trackRouteData: false,
    key: 'auto-recharge-default-proxy-catalog',
    enabled: () => open.value,
    keepPreviousData: true,
    query: ({ signal }) => readActiveRechargeProxies(signal)
  });
  const items = computed(() => query.data.value?.items ?? []);
  const selected = computed(() => items.value.find((item) => item.id === form.value.proxyId));
  const matchingItems = computed(() =>
    items.value.filter(
      (item) =>
        item.status === 'active' &&
        item.connectionMode ===
          (form.value.browserOptions.proxyMode === 'dynamic' ? 'extraction' : 'direct')
    )
  );
  function applySelection() {
    const proxy = selected.value;
    if (!proxy || proxy.status !== 'active') return;
    form.value.proxyType = proxy.protocol;
    form.value.browserOptions.proxyMode =
      proxy.connectionMode === 'extraction' ? 'dynamic' : 'static';
  }
  watch(() => form.value.proxyId, applySelection, { flush: 'sync' });
  watch(() => query.data.value, applySelection);
  watch(
    () => form.value.browserOptions.proxyMode,
    () => {
      if (selected.value && !matchingItems.value.some((item) => item.id === form.value.proxyId))
        form.value.proxyId = '';
    },
    { flush: 'sync' }
  );
  const error = computed(() => {
    if (query.phase.value !== 'ready') return '请先完成代理目录读取';
    if (!form.value.proxyId) return '请选择代理 IP 管理中的启用代理';
    if (!matchingItems.value.some((item) => item.id === form.value.proxyId))
      return '所选代理已停用、删除或与当前模式不符，请重新选择';
    return '';
  });
  return { query, items, selected, matchingItems, error };
}
