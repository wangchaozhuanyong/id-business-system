import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CREDENTIAL_STORAGE_KEY,
  LEGACY_CURRENT_USER_STORAGE_KEY,
  LEGACY_TOKEN_STORAGE_KEY,
  clearStoredCredential,
  createStoredCredential,
  readStoredCredential,
  writeStoredCredential
} from './credential';

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

describe('credential storage contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is safe when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);

    expect(readStoredCredential()).toBeNull();
    expect(writeStoredCredential(createStoredCredential('token', null))).toBe(false);
    expect(clearStoredCredential()).toBe(true);
  });

  it('migrates legacy token and user into one atomic v2 record', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', persistentStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    persistentStorage.setItem(LEGACY_TOKEN_STORAGE_KEY, 'legacy-token');
    persistentStorage.setItem(
      LEGACY_CURRENT_USER_STORAGE_KEY,
      JSON.stringify({
        id: 'user-1',
        username: 'admin',
        displayName: '管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      })
    );

    const migrated = readStoredCredential();

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      token: 'legacy-token',
      tokenRevision: 1,
      userCache: { id: 'user-1' }
    });
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).not.toBeNull();
    expect(persistentStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(LEGACY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(LEGACY_CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('moves an existing persistent v2 credential into the tab session', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', persistentStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    const credential = createStoredCredential('persistent-token', null);
    persistentStorage.setItem(AUTH_CREDENTIAL_STORAGE_KEY, JSON.stringify(credential));

    expect(readStoredCredential()).toEqual(credential);
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBe(JSON.stringify(credential));
    expect(persistentStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it('rejects a corrupt atomic record instead of restoring a half-session', () => {
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', sessionStorage);
    sessionStorage.setItem(AUTH_CREDENTIAL_STORAGE_KEY, '{broken');

    expect(readStoredCredential()).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['token-only', 'legacy-token', null],
    [
      'user-only',
      null,
      JSON.stringify({
        id: 'user-1',
        username: 'admin',
        displayName: '管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      })
    ],
    ['corrupt-user', 'legacy-token', '{broken']
  ])('clears the %s legacy half-write without migrating it', (_case, token, user) => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', persistentStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    if (token) persistentStorage.setItem(LEGACY_TOKEN_STORAGE_KEY, token);
    if (user) persistentStorage.setItem(LEGACY_CURRENT_USER_STORAGE_KEY, user);

    expect(readStoredCredential()).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(LEGACY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(LEGACY_CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('does not combine legacy half-sessions from different storage scopes', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', persistentStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
    persistentStorage.setItem(LEGACY_TOKEN_STORAGE_KEY, 'persistent-token');
    sessionStorage.setItem(
      LEGACY_CURRENT_USER_STORAGE_KEY,
      JSON.stringify({
        id: 'user-1',
        username: 'admin',
        displayName: '管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      })
    );

    expect(readStoredCredential()).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(persistentStorage.getItem(LEGACY_TOKEN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('does not clear a newer token revision from a stale response', () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    const credential = createStoredCredential('token-v2', null);
    credential.tokenRevision = 2;
    writeStoredCredential(credential);

    expect(
      clearStoredCredential({
        credentialId: credential.credentialId,
        tokenRevision: 1
      })
    ).toBe(false);
    expect(readStoredCredential()).toEqual(credential);
  });

  it('never persists a newly written bearer credential in local storage', () => {
    const persistentStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', persistentStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);

    expect(writeStoredCredential(createStoredCredential('session-token', null))).toBe(true);
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toContain('session-token');
    expect(persistentStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });
});
