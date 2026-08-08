import { computed, readonly, ref } from 'vue';
import type { V2TablePreference } from '@apple-business/shared';
import { idBusinessV2TablePreferencesApi } from '@/v2/api/tablePreferences';

const preferencesByTable = ref<Record<string, readonly string[]>>({});
const activeUserId = ref('');
const loadedUserId = ref('');
const loading = ref(false);
const loadError = ref<unknown>(null);
let loadingPromise: Promise<void> | null = null;
let identityRevision = 0;

export const v2TablePreferences = readonly(preferencesByTable);
export const v2TablePreferencesReady = computed(
  () => Boolean(activeUserId.value) && loadedUserId.value === activeUserId.value
);

export async function ensureV2TablePreferences(userId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    clearV2TablePreferences();
    return;
  }

  switchActiveUser(normalizedUserId);
  if (loadedUserId.value === normalizedUserId) return;
  if (loadingPromise) return loadingPromise;

  const revision = identityRevision;
  loading.value = true;
  loadError.value = null;
  const currentLoadingPromise: Promise<void> = idBusinessV2TablePreferencesApi
    .list()
    .then((result) => {
      if (revision !== identityRevision || activeUserId.value !== normalizedUserId) return;
      preferencesByTable.value = Object.fromEntries(
        result.items.map((item) => [item.tableId, normalizeKeys(item.hiddenColumnKeys)])
      );
      loadedUserId.value = normalizedUserId;
    })
    .catch((error) => {
      if (revision === identityRevision && activeUserId.value === normalizedUserId) {
        loadError.value = error;
      }
      throw error;
    })
    .finally(() => {
      if (revision === identityRevision) loading.value = false;
      if (loadingPromise === currentLoadingPromise) loadingPromise = null;
    });
  loadingPromise = currentLoadingPromise;

  return currentLoadingPromise;
}

export async function saveV2TablePreference(
  userId: string,
  tableId: string,
  hiddenColumnKeys: readonly string[]
) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error('无法识别当前登录用户');
  await ensureV2TablePreferences(normalizedUserId);
  const revision = identityRevision;
  const result = await idBusinessV2TablePreferencesApi.update(tableId, {
    hiddenColumnKeys: normalizeKeys(hiddenColumnKeys)
  });
  if (revision === identityRevision && activeUserId.value === normalizedUserId) {
    applyPreference(result);
    loadedUserId.value = normalizedUserId;
  }
  return result;
}

export async function resetV2TablePreference(userId: string, tableId: string) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) throw new Error('无法识别当前登录用户');
  await ensureV2TablePreferences(normalizedUserId);
  const revision = identityRevision;
  const result = await idBusinessV2TablePreferencesApi.reset(tableId);
  if (revision === identityRevision && activeUserId.value === normalizedUserId) {
    const next = { ...preferencesByTable.value };
    delete next[tableId];
    preferencesByTable.value = next;
    loadedUserId.value = normalizedUserId;
  }
  return result;
}

export function isV2TableColumnVisible(tableId: string, columnKey: string) {
  return !(preferencesByTable.value[tableId] ?? []).includes(columnKey);
}

export function getV2TableHiddenColumnKeys(tableId: string) {
  return [...(preferencesByTable.value[tableId] ?? [])];
}

export function clearV2TablePreferences() {
  identityRevision += 1;
  preferencesByTable.value = {};
  activeUserId.value = '';
  loadedUserId.value = '';
  loading.value = false;
  loadError.value = null;
  loadingPromise = null;
}

export function useV2TablePreferences() {
  return {
    preferences: v2TablePreferences,
    activeUserId: readonly(activeUserId),
    loadedUserId: readonly(loadedUserId),
    ready: v2TablePreferencesReady,
    loading: readonly(loading),
    error: readonly(loadError),
    ensureLoaded: ensureV2TablePreferences,
    save: saveV2TablePreference,
    reset: resetV2TablePreference,
    clear: clearV2TablePreferences,
    isColumnVisible: isV2TableColumnVisible,
    getHiddenColumnKeys: getV2TableHiddenColumnKeys
  };
}

function switchActiveUser(userId: string) {
  if (activeUserId.value === userId) return;
  identityRevision += 1;
  activeUserId.value = userId;
  loadedUserId.value = '';
  preferencesByTable.value = {};
  loadError.value = null;
  loadingPromise = null;
}

function applyPreference(preference: V2TablePreference) {
  preferencesByTable.value = {
    ...preferencesByTable.value,
    [preference.tableId]: normalizeKeys(preference.hiddenColumnKeys)
  };
}

function normalizeKeys(keys: readonly unknown[]) {
  return [
    ...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))
  ];
}
