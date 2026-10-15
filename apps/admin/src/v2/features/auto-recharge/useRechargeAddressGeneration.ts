import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { rechargeApi } from './api';
import type { V2RechargeAddress } from './contracts';

export function useRechargeAddressGeneration(options: {
  allowed: Ref<boolean>;
  automatic: Ref<boolean>;
  context: () => unknown[];
  addresses: Ref<V2RechargeAddress[]>;
  refresh: () => Promise<unknown>;
  select: (id: string) => void;
}) {
  const generating = ref(false);
  const error = ref('');
  let disposed = false;
  let revision = 0;
  let autoAttempted = false;
  let pendingAddressId = '';
  let pending: Promise<void> | undefined;
  watch(
    options.context,
    () => {
      revision++;
      autoAttempted = false;
      pendingAddressId = '';
      error.value = '';
    },
    { flush: 'sync' }
  );

  function generate(): Promise<void> {
    if (pending) return pending;
    if (disposed || !options.allowed.value) return Promise.resolve();
    const expectedRevision = revision;
    generating.value = true;
    error.value = '';
    const current = () => !disposed && expectedRevision === revision && options.allowed.value;
    pending = (async () => {
      try {
        // 写入成功但列表刷新失败时，只重读这条地址，不再次生成。
        let id = pendingAddressId;
        if (!id) {
          const result = await rechargeApi.generateAddresses(1);
          id = result.items[0]?.id ?? '';
          if (!id) throw new Error('地址生成结果不完整，请到地址管理核对');
          if (current()) pendingAddressId = id;
        }
        if (!current()) return;
        await options.refresh();
        if (!current()) return;
        if (!options.addresses.value.some((item) => item.id === id)) {
          throw new Error('地址已生成，列表暂未更新，请重试使用已生成地址');
        }
        options.select(id);
        pendingAddressId = '';
      } catch (cause) {
        if (!disposed && expectedRevision === revision) error.value = getApiErrorMessage(cause);
      } finally {
        generating.value = false;
        pending = undefined;
      }
    })();
    return pending;
  }
  watch(
    [options.automatic, options.context, generating],
    () => {
      if (!disposed && options.automatic.value && !generating.value && !autoAttempted) {
        autoAttempted = true;
        void generate();
      }
    },
    { immediate: true, flush: 'post' }
  );
  onScopeDispose(() => {
    disposed = true;
    revision++;
  });
  return { generating, error, generate };
}
