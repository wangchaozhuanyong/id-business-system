import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CREDENTIAL_STORAGE_KEY,
  createStoredCredential,
  LEGACY_CURRENT_USER_STORAGE_KEY as CURRENT_USER_STORAGE_KEY,
  LEGACY_TOKEN_STORAGE_KEY as TOKEN_STORAGE_KEY,
  writeStoredCredential
} from '@/auth/credential';
import { resetSessionCoordinatorForTests } from '@/auth/sessionCoordinator';
import type { CurrentUser } from '@/types/system';

const authApiMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  me: vi.fn()
}));

vi.mock('@/api/auth', () => ({
  authApi: authApiMocks
}));

import { useAuthStore } from './auth';

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const verifiedUser: CurrentUser = {
  id: 'verified-user',
  username: 'verified',
  displayName: '已验证用户',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};

describe('auth session gate', () => {
  beforeEach(() => {
    resetSessionCoordinatorForTests();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('BroadcastChannel', undefined);
    setActivePinia(createPinia());
  });

  it('validates a credential without trusting an incomplete cached profile', async () => {
    writeStoredCredential(createStoredCredential('legacy-token', null));
    authApiMocks.me.mockResolvedValueOnce(verifiedUser);

    const authStore = useAuthStore();

    expect(authStore.user).toBeNull();
    expect(authStore.userLoadedAt).toBe(0);

    await expect(authStore.ensureSessionReady()).resolves.toBe('ready');
    expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    expect(authStore.user).toEqual(verifiedUser);
    expect(
      JSON.parse(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY) ?? '{}').userCache
    ).toEqual(verifiedUser);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
  });

  it('deduplicates concurrent session checks through one current-user request', async () => {
    writeStoredCredential(createStoredCredential('test-token', null));
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);
    const authStore = useAuthStore();

    const first = authStore.ensureSessionReady();
    const second = authStore.ensureSessionReady();

    expect(authStore.session.kind).toBe('validating');
    expect(authApiMocks.me).toHaveBeenCalledTimes(0);
    await vi.waitFor(() => {
      expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    });

    deferred.resolve(verifiedUser);
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    expect(authStore.user).toEqual(verifiedUser);
  });

  it('ignores a stale user response after the identity is cleared', async () => {
    writeStoredCredential(createStoredCredential('test-token', null));
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);
    const authStore = useAuthStore();

    const sessionCheck = authStore.ensureSessionReady();
    await vi.waitFor(() => {
      expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    });
    authStore.clearLocalSession({
      reason: 'logout'
    });
    deferred.resolve(verifiedUser);

    await sessionCheck;
    expect(authStore.session.kind).toBe('anonymous');
    expect(authStore.user).toBeNull();
  });

  it('clears the local session even when remote logout fails', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'current-token');
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(verifiedUser));
    authApiMocks.logout.mockRejectedValueOnce(new Error('remote logout unavailable'));
    const authStore = useAuthStore();

    await expect(authStore.logout()).rejects.toThrow('remote logout unavailable');

    expect(authStore.session.kind).toBe('anonymous');
    expect(authStore.token).toBe('');
    expect(authStore.user).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it('clears the local session after changing the password', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'current-token');
    localStorage.setItem(
      CURRENT_USER_STORAGE_KEY,
      JSON.stringify({
        ...verifiedUser,
        mustResetPassword: true
      })
    );
    authApiMocks.changePassword.mockResolvedValueOnce({
      passwordChanged: true,
      signedOut: true
    });
    const authStore = useAuthStore();

    await expect(
      authStore.changePassword('temporary-password', 'new-secure-password')
    ).resolves.toEqual({
      passwordChanged: true,
      signedOut: true
    });

    expect(authApiMocks.changePassword).toHaveBeenCalledWith(
      'temporary-password',
      'new-secure-password'
    );
    expect(authStore.session.kind).toBe('anonymous');
    expect(authStore.token).toBe('');
    expect(authStore.user).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });
});
