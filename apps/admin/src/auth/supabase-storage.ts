export type SupabaseAuthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function createSupabaseAuthStorage(
  supabaseUrl: string,
  sessionStorage = getBrowserStorage('sessionStorage'),
  persistentStorage = getBrowserStorage('localStorage')
): SupabaseAuthStorage {
  const storage = sessionStorage ?? createMemoryStorage();
  migratePersistedSupabaseSession(supabaseUrl, persistentStorage, storage);
  return storage;
}

export function getSupabaseAuthStorageKey(supabaseUrl: string) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  return `sb-${projectRef}-auth-token`;
}

function migratePersistedSupabaseSession(
  supabaseUrl: string,
  persistentStorage: SupabaseAuthStorage | null,
  sessionStorage: SupabaseAuthStorage
) {
  if (!persistentStorage) return;
  const storageKey = getSupabaseAuthStorageKey(supabaseUrl);
  for (const key of [storageKey, `${storageKey}-code-verifier`, `${storageKey}-user`]) {
    try {
      const persistedValue = persistentStorage.getItem(key);
      if (persistedValue && !sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, persistedValue);
      }
    } catch {
      // A failed migration forces a new provider session instead of reading persistent storage.
    }
    try {
      persistentStorage.removeItem(key);
    } catch {
      // The configured auth client never reads persistent browser storage after this point.
    }
  }
}

function createMemoryStorage(): SupabaseAuthStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

function getBrowserStorage(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const storage = globalThis[name];
    return typeof storage === 'undefined' ? null : storage;
  } catch {
    return null;
  }
}
