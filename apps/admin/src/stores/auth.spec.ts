import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_STORAGE_KEY } from '@/auth/session';
import type { CurrentUser } from '@/types/system';

const authApiMocks = vi.hoisted(() => ({
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
  permissions: []
};

describe('auth session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('window', new EventTarget());
    setActivePinia(createPinia());
  });

  it('deduplicates concurrent session checks through one current-user request', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);
    const authStore = useAuthStore();

    const first = authStore.ensureSessionReady();
    const second = authStore.ensureSessionReady();

    expect(authStore.sessionStatus).toBe('checking');
    expect(authApiMocks.me).toHaveBeenCalledTimes(0);
    await vi.waitFor(() => {
      expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    });

    deferred.resolve(verifiedUser);
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    expect(authStore.user).toEqual(verifiedUser);
  });

  it('ignores a stale user response after the identity is cleared', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);
    const authStore = useAuthStore();

    const sessionCheck = authStore.ensureSessionReady();
    await vi.waitFor(() => {
      expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    });
    authStore.clearLocalSession({
      reason: 'logout',
      supabase: false
    });
    deferred.resolve(verifiedUser);

    await sessionCheck;
    expect(authStore.sessionStatus).toBe('anonymous');
    expect(authStore.user).toBeNull();
  });
});
