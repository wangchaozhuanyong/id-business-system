import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
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

const supabaseConfigMock = vi.hoisted(() => ({
  configured: false
}));

const supabaseAuthMocks = vi.hoisted(() => ({
  clearSupabaseSession: vi.fn(),
  getSupabaseSession: vi.fn(),
  setSupabaseSession: vi.fn(),
  subscribeSupabaseSession: vi.fn()
}));

vi.mock('@/api/auth', () => ({
  authApi: authApiMocks
}));

vi.mock('@/auth/supabase-config', () => ({
  isSupabaseAuthConfigured: () => supabaseConfigMock.configured
}));

vi.mock('@/auth/supabase', () => supabaseAuthMocks);

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

let supabaseSessionListener: ((event: AuthChangeEvent, session: Session | null) => void) | null =
  null;

function createSupabaseSession(accessToken: string, authUserId: string) {
  return {
    access_token: accessToken,
    user: {
      id: authUserId
    }
  } as Session;
}

describe('auth session gate', () => {
  beforeEach(() => {
    resetSessionCoordinatorForTests();
    vi.clearAllMocks();
    supabaseConfigMock.configured = false;
    supabaseSessionListener = null;
    supabaseAuthMocks.clearSupabaseSession.mockResolvedValue(undefined);
    supabaseAuthMocks.getSupabaseSession.mockResolvedValue(null);
    supabaseAuthMocks.setSupabaseSession.mockResolvedValue(null);
    supabaseAuthMocks.subscribeSupabaseSession.mockImplementation(
      (listener: (event: AuthChangeEvent, session: Session | null) => void) => {
        supabaseSessionListener = listener;
        return null;
      }
    );
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

  it('clears the local and Supabase sessions even when remote logout fails', async () => {
    supabaseConfigMock.configured = true;
    localStorage.setItem(TOKEN_STORAGE_KEY, 'current-token');
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(verifiedUser));
    authApiMocks.logout.mockRejectedValueOnce(new Error('remote logout unavailable'));
    const authStore = useAuthStore();

    await expect(authStore.logout()).rejects.toThrow('remote logout unavailable');

    expect(supabaseAuthMocks.clearSupabaseSession).toHaveBeenCalledTimes(1);
    expect(authStore.session.kind).toBe('anonymous');
    expect(authStore.token).toBe('');
    expect(authStore.user).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it('clears both the Supabase and local sessions after changing the password', async () => {
    supabaseConfigMock.configured = true;
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
    expect(supabaseAuthMocks.clearSupabaseSession).toHaveBeenCalledTimes(1);
    expect(authStore.session.kind).toBe('anonymous');
    expect(authStore.token).toBe('');
    expect(authStore.user).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CURRENT_USER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it('keeps the business identity ready when Supabase refreshes the same auth user token', async () => {
    const authUserId = 'supabase-auth-user';
    const initialSession = createSupabaseSession('initial-access-token', authUserId);
    const refreshedSession = createSupabaseSession('refreshed-access-token', authUserId);
    supabaseConfigMock.configured = true;
    localStorage.setItem(TOKEN_STORAGE_KEY, 'stored-access-token');
    localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(verifiedUser));
    supabaseAuthMocks.getSupabaseSession.mockResolvedValueOnce(initialSession);
    authApiMocks.me.mockResolvedValueOnce(verifiedUser);
    const authStore = useAuthStore();

    await expect(authStore.ensureSessionReady()).resolves.toBe('ready');
    expect(supabaseSessionListener).not.toBeNull();

    supabaseAuthMocks.getSupabaseSession.mockResolvedValue(refreshedSession);
    authApiMocks.me.mockResolvedValueOnce(verifiedUser);
    supabaseSessionListener?.('TOKEN_REFRESHED', refreshedSession);

    await vi.waitFor(() => expect(authStore.session.kind).toBe('ready'));

    expect(authStore.session.kind).toBe('ready');
    expect(authStore.user).toEqual(verifiedUser);
    expect(authStore.token).toBe('refreshed-access-token');
    expect(JSON.parse(sessionStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY) ?? '{}').token).toBe(
      'refreshed-access-token'
    );
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(authApiMocks.me).toHaveBeenCalledTimes(2);
  });
});
