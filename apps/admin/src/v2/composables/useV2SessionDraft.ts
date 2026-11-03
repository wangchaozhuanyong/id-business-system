import { nextTick, onScopeDispose, reactive, ref, toRaw, watch, type UnwrapNestedRefs } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

// 草稿只存在当前标签页内存；身份变化即失效，不进入查询缓存或浏览器存储。
const drafts = new Map<string, unknown>();
const draftFlushers = new Set<() => void>();
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

export function flushV2FormDrafts() {
  for (const flush of draftFlushers) flush();
}

export function useV2FormDraft<T extends object>(key: string, create: () => T) {
  const entries = useV2SessionDraft(
    key,
    () => new Map<string, { value: T; original: string; version?: string | null }>()
  );
  const form = reactive(create()) as UnwrapNestedRefs<T>;
  const original = ref(JSON.stringify(form));
  const version = ref<string | null>();
  const restoring = ref(false);
  let restoreRevision = 0;
  let activeKey: string | undefined;
  const ownerEpoch = sessionCoordinator.identityEpoch.value;
  let pending = false;

  function flush() {
    if (!pending) return;
    pending = false;
    if (activeKey === undefined || ownerEpoch !== sessionCoordinator.identityEpoch.value) return;
    entries.set(activeKey, {
      value: copy(form) as T,
      original: original.value,
      version: version.value
    });
  }
  draftFlushers.add(flush);
  onScopeDispose(() => {
    flush();
    draftFlushers.delete(flush);
  });

  watch(
    form,
    () => {
      if (activeKey === undefined || pending) return;
      // Field linkages often update several properties in one turn. Copy only once.
      pending = true;
      queueMicrotask(flush);
    },
    { deep: true, flush: 'sync' }
  );

  function open(entityKey: string, initial: Partial<T> = {}, sourceVersion?: string | null) {
    flushV2FormDrafts();
    restoring.value = true;
    const revision = ++restoreRevision;
    activeKey = undefined;
    const saved = entries.get(entityKey);
    const seed = { ...create(), ...initial };
    Object.assign(form, saved ? copy(saved.value) : seed);
    original.value = saved?.original ?? JSON.stringify(seed);
    version.value = saved ? saved.version : sourceVersion;
    activeKey = entityKey;
    void nextTick(() => {
      if (restoreRevision === revision) restoring.value = false;
    });
    return Boolean(saved);
  }

  function beginSave() {
    flushV2FormDrafts();
    const entityKey = activeKey;
    const submitted = JSON.stringify(form);
    return () => {
      // A late save can race with another mounted consumer's unflushed edit.
      flushV2FormDrafts();
      if (entityKey === undefined) return false;
      const latest = entries.get(entityKey);
      if (latest && JSON.stringify(latest.value) !== submitted) return false;
      entries.delete(entityKey);
      if (activeKey === entityKey && JSON.stringify(form) === submitted) activeKey = undefined;
      return true;
    };
  }

  return { form, original, version, restoring, open, beginSave, flush };
}
