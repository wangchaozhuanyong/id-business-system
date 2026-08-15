import { describe, expect, it } from 'vitest';
import { createSupabaseAuthStorage, getSupabaseAuthStorageKey } from './supabase-storage';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const supabaseUrl = 'https://project-ref.supabase.co';

describe('Supabase auth storage contract', () => {
  it('uses tab session storage and removes the previous persistent session', () => {
    const sessionStorage = new MemoryStorage();
    const persistentStorage = new MemoryStorage();
    const storageKey = getSupabaseAuthStorageKey(supabaseUrl);
    persistentStorage.setItem(storageKey, 'persistent-session');
    persistentStorage.setItem(`${storageKey}-code-verifier`, 'persistent-verifier');
    persistentStorage.setItem(`${storageKey}-user`, 'persistent-user');

    const storage = createSupabaseAuthStorage(supabaseUrl, sessionStorage, persistentStorage);

    expect(storage).toBe(sessionStorage);
    expect(sessionStorage.getItem(storageKey)).toBe('persistent-session');
    expect(sessionStorage.getItem(`${storageKey}-code-verifier`)).toBe('persistent-verifier');
    expect(sessionStorage.getItem(`${storageKey}-user`)).toBe('persistent-user');
    expect(persistentStorage.getItem(storageKey)).toBeNull();
    expect(persistentStorage.getItem(`${storageKey}-code-verifier`)).toBeNull();
    expect(persistentStorage.getItem(`${storageKey}-user`)).toBeNull();
  });

  it('falls back to isolated memory storage instead of persistent storage', () => {
    const persistentStorage = new MemoryStorage();
    const storageKey = getSupabaseAuthStorageKey(supabaseUrl);
    persistentStorage.setItem(storageKey, 'persistent-session');

    const storage = createSupabaseAuthStorage(supabaseUrl, null, persistentStorage);

    expect(storage.getItem(storageKey)).toBe('persistent-session');
    expect(persistentStorage.getItem(storageKey)).toBeNull();
  });

  it('does not overwrite a newer tab-scoped session during migration', () => {
    const sessionStorage = new MemoryStorage();
    const persistentStorage = new MemoryStorage();
    const storageKey = getSupabaseAuthStorageKey(supabaseUrl);
    sessionStorage.setItem(storageKey, 'current-tab-session');
    persistentStorage.setItem(storageKey, 'stale-persistent-session');

    createSupabaseAuthStorage(supabaseUrl, sessionStorage, persistentStorage);

    expect(sessionStorage.getItem(storageKey)).toBe('current-tab-session');
    expect(persistentStorage.getItem(storageKey)).toBeNull();
  });
});
