import { reactive, ref, toRaw, watch, type UnwrapNestedRefs } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

// 草稿只存在当前标签页内存；身份变化即失效，不进入查询缓存或浏览器存储。
const drafts = new Map<string, unknown>();
let identityEpoch = sessionCoordinator.identityEpoch.value;

export function clearV2SessionDrafts() {
  drafts.clear();
  identityEpoch = sessionCoordinator.identityEpoch.value;
}

sessionCoordinator.subscribeIdentityChange(clearV2SessionDrafts);

export function useV2SessionDraft<T>(key: string, create: () => T): T {
  if (identityEpoch !== sessionCoordinator.identityEpoch.value) clearV2SessionDrafts();
  if (!drafts.has(key)) drafts.set(key, create());
  return drafts.get(key) as T;
}

function copy<T extends object>(value: T): T {
  return structuredClone(toRaw(value));
}

export function useV2FormDraft<T extends object>(key: string, create: () => T) {
  const entries = useV2SessionDraft(key, () => new Map<string, { value: T; original: string }>());
  const form = reactive(create()) as UnwrapNestedRefs<T>;
  const original = ref(JSON.stringify(form));
  let activeKey: string | undefined;

  watch(
    form,
    () => {
      if (activeKey !== undefined)
        entries.set(activeKey, { value: copy(form) as T, original: original.value });
    },
    { deep: true, flush: 'sync' }
  );

  function open(entityKey: string, initial: Partial<T> = {}) {
    activeKey = undefined;
    const saved = entries.get(entityKey);
    const seed = { ...create(), ...initial };
    Object.assign(form, saved ? copy(saved.value) : seed);
    original.value = saved?.original ?? JSON.stringify(seed);
    activeKey = entityKey;
  }

  function complete() {
    if (activeKey !== undefined) {
      const latest = entries.get(activeKey);
      // 离页期间重新编辑过的内容，不由旧页面的迟到保存结果清理。
      if (!latest || JSON.stringify(latest.value) === JSON.stringify(form))
        entries.delete(activeKey);
    }
    activeKey = undefined;
  }

  return { form, original, open, complete };
}
