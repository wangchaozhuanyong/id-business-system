import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/apiError';
import {
  AUTH_CREDENTIAL_STORAGE_KEY,
  createStoredCredential,
  readStoredCredential,
  writeStoredCredential
} from '@/auth/credential';
import type { CurrentUser } from '@/types/system';
import {
  BROWSER_SESSION_MARKER_KEY,
  readBrowserSessionMarker,
  writeBrowserSessionMarker
} from './browserSessionMarker';

const authApiMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  restoreSession: vi.fn(),
  me: vi.fn()
}));

vi.mock('@/api/auth', () => ({ authApi: authApiMocks }));

import {
  isSessionTransitionAllowed,
  resetSessionCoordinatorForTests,
  sessionCoordinator,
  setSessionCoordinatorClockForTests,
  transitionSessionState,
  type SessionState
} from './sessionCoordinator';

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

class TestBroadcastChannel extends EventTarget {
  static current: TestBroadcastChannel | null = null;

  constructor(name: string) {
    super();
    void name;
    TestBroadcastChannel.current = this;
  }

  close() {
    if (TestBroadcastChannel.current === this) TestBroadcastChannel.current = null;
  }

  postMessage(message: unknown) {
    void message;
  }

  emitMessage(data: unknown) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

const user: CurrentUser = {
  id: 'user-1',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['dashboard.view'],
  mustResetPassword: false
};

const replacementUser: CurrentUser = {
  ...user,
  id: 'user-2',
  username: 'operator',
  displayName: '新操作员'
};

function apiError(status: number, code: string) {
  return new ApiError(`request failed: ${code}`, {
    code,
    kind: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'transient',
    retryable: status >= 500,
    status
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function seedCredential(token = 'token-1', cachedUser: CurrentUser | null = null) {
  const credential = createStoredCredential(token, cachedUser);
  writeStoredCredential(credential);
  return credential;
}

function dispatchCredentialStorageChange() {
  const event = new Event('storage');
  Object.defineProperty(event, 'key', { value: AUTH_CREDENTIAL_STORAGE_KEY });
  window.dispatchEvent(event);
}

function stateFor(kind: SessionState['kind']): SessionState {
  if (kind === 'cold') return { kind };
  if (kind === 'anonymous') return { kind, reason: 'none' };
  if (kind === 'validating') return { kind, source: 'boot', cachedUser: null };
  if (kind === 'ready') return { kind, user, verifiedAt: 1 };
  if (kind === 'refreshing') return { kind, user, verifiedAt: 1 };
  if (kind === 'degraded') {
    return {
      kind,
      error: apiError(503, 'AUTH_DEPENDENCY_UNAVAILABLE'),
      failureCount: 1,
      retryAt: 2,
      user: null,
      verifiedInRuntime: false
    };
  }
  return { kind, reason: 'permission', user: null };
}

describe('SessionCoordinator', () => {
  beforeEach(() => {
    resetSessionCoordinatorForTests();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    authApiMocks.restoreSession.mockRejectedValue(apiError(401, 'AUTH_MISSING'));
  });

  it('restores a new tab through one server request without persisting its token', async () => {
    writeBrowserSessionMarker({ credentialId: 'browser-session-1', signedOut: false });
    const deferred = createDeferred<{ accessToken: string; user: CurrentUser }>();
    authApiMocks.restoreSession.mockReturnValueOnce(deferred.promise);
    const first = sessionCoordinator.ensureSession();
    const second = sessionCoordinator.ensureSession();
    await vi.waitFor(() => expect(authApiMocks.restoreSession).toHaveBeenCalledTimes(1));
    expect(sessionCoordinator.state.value.kind).toBe('validating');
    expect(sessionCoordinator.credential.value).toBeNull();
    deferred.resolve({ accessToken: 'restored-token', user });
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    expect(readStoredCredential()).toMatchObject({
      credentialId: 'browser-session-1',
      token: 'restored-token'
    });
    expect(localStorage.getItem(AUTH_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(BROWSER_SESSION_MARKER_KEY)).not.toContain('restored-token');
    expect(authApiMocks.me).not.toHaveBeenCalled();
  });

  it('does not repeatedly probe a browser without a session cookie', async () => {
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(authApiMocks.restoreSession).toHaveBeenCalledTimes(1);
  });

  it('publishes a signed-out marker when the restore cookie has been revoked', async () => {
    writeBrowserSessionMarker({ credentialId: 'revoked-session', signedOut: false });
    authApiMocks.restoreSession.mockRejectedValueOnce(apiError(401, 'AUTH_REVOKED'));
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(readBrowserSessionMarker()).toMatchObject({
      credentialId: 'revoked-session',
      signedOut: true
    });
  });

  it('keeps an incomplete restore response behind the unavailable boundary', async () => {
    authApiMocks.restoreSession.mockResolvedValueOnce({ user });
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('unavailable');
    expect(sessionCoordinator.credential.value).toBeNull();
    expect(sessionCoordinator.state.value).toMatchObject({
      kind: 'degraded',
      error: { code: 'AUTH_SESSION_RESTORE_INCOMPLETE' }
    });
  });

  it.each([
    [401, 'anonymous'],
    [403, 'blocked'],
    [503, 'unavailable']
  ] as const)(
    'keeps server restore failure %s behind its session boundary',
    async (status, resolution) => {
      authApiMocks.restoreSession.mockRejectedValueOnce(
        apiError(status, status === 403 ? 'AUTH_IP_BLOCKED' : 'AUTH_DEPENDENCY_UNAVAILABLE')
      );
      await expect(sessionCoordinator.ensureSession()).resolves.toBe(resolution);
      expect(sessionCoordinator.credential.value).toBeNull();
      expect(() => sessionCoordinator.assertWriteAllowed()).toThrow();
      if (status === 503) {
        authApiMocks.restoreSession.mockResolvedValueOnce({ accessToken: 'recovered-token', user });
        await expect(sessionCoordinator.ensureSession({ source: 'manual-retry' })).resolves.toBe(
          'ready'
        );
      }
    }
  );

  it('does not restore a response that arrives after local logout', async () => {
    const deferred = createDeferred<{ accessToken: string; user: CurrentUser }>();
    authApiMocks.restoreSession.mockReturnValueOnce(deferred.promise);
    const pending = sessionCoordinator.ensureSession();
    await vi.waitFor(() => expect(authApiMocks.restoreSession).toHaveBeenCalledTimes(1));
    await sessionCoordinator.logout({ remote: false });
    deferred.resolve({ accessToken: 'late-token', user });
    await expect(pending).resolves.toBe('anonymous');
    expect(readStoredCredential()).toBeNull();
    resetSessionCoordinatorForTests();
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(authApiMocks.restoreSession).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a newer login with an older restore response', async () => {
    const deferred = createDeferred<{ accessToken: string; user: CurrentUser }>();
    authApiMocks.restoreSession.mockReturnValueOnce(deferred.promise);
    const pending = sessionCoordinator.ensureSession();
    await vi.waitFor(() => expect(authApiMocks.restoreSession).toHaveBeenCalledTimes(1));
    authApiMocks.login.mockResolvedValueOnce({ accessToken: 'new-token', user: replacementUser });
    await sessionCoordinator.login('operator', 'password');
    deferred.resolve({ accessToken: 'old-token', user });
    await expect(pending).resolves.toBe('ready');
    expect(sessionCoordinator.credential.value?.token).toBe('new-token');
  });

  it('rejects a cookie from an older browser login generation', async () => {
    writeBrowserSessionMarker({ credentialId: 'new-id', signedOut: false, sessionId: 'new-jti' });
    authApiMocks.restoreSession.mockResolvedValueOnce({
      accessToken: `header.${btoa(JSON.stringify({ jti: 'old-jti' }))}.signature`,
      user
    });
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(readStoredCredential()).toBeNull();
  });

  it('clears a peer tab on logout using storage events without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const credential = seedCredential('existing-token');
    authApiMocks.me.mockResolvedValueOnce(user);
    await sessionCoordinator.ensureSession();
    writeBrowserSessionMarker({ credentialId: credential.credentialId, signedOut: true });
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: BROWSER_SESSION_MARKER_KEY });
    window.dispatchEvent(event);
    expect(sessionCoordinator.state.value.kind).toBe('anonymous');
    expect(readStoredCredential()).toBeNull();
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(authApiMocks.restoreSession).not.toHaveBeenCalled();
  });

  it('keeps failed remote logout signed out after a reload', async () => {
    seedCredential();
    authApiMocks.me.mockResolvedValueOnce(user);
    await sessionCoordinator.ensureSession();
    authApiMocks.logout.mockRejectedValueOnce(new Error('offline'));
    await expect(sessionCoordinator.logout()).rejects.toThrow('offline');
    expect(readBrowserSessionMarker()?.signedOut).toBe(true);
    resetSessionCoordinatorForTests();
    await expect(sessionCoordinator.ensureSession()).resolves.toBe('anonymous');
    expect(authApiMocks.restoreSession).not.toHaveBeenCalled();
  });

  it.each([
    ['cold', 'validating'],
    ['cold', 'degraded'],
    ['anonymous', 'cold'],
    ['anonymous', 'ready'],
    ['validating', 'blocked'],
    ['ready', 'degraded'],
    ['refreshing', 'anonymous'],
    ['degraded', 'ready'],
    ['blocked', 'validating']
  ] as const)('allows the declared transition %s -> %s', (from, to) => {
    resetSessionCoordinatorForTests(stateFor(from));

    expect(isSessionTransitionAllowed(from, to)).toBe(true);
    expect(() => transitionSessionState(stateFor(to))).not.toThrow();
    expect(sessionCoordinator.state.value.kind).toBe(to);
  });

  it.each([
    ['cold', 'refreshing'],
    ['cold', 'blocked'],
    ['anonymous', 'refreshing'],
    ['anonymous', 'degraded'],
    ['anonymous', 'blocked']
  ] as const)('rejects the illegal transition %s -> %s', (from, to) => {
    resetSessionCoordinatorForTests(stateFor(from));

    expect(isSessionTransitionAllowed(from, to)).toBe(false);
    expect(() => transitionSessionState(stateFor(to))).toThrow(
      `ILLEGAL_SESSION_TRANSITION:${from}->${to}`
    );
    expect(sessionCoordinator.state.value.kind).toBe(from);
  });

  it.each([
    {
      code: 'AUTH_DEPENDENCY_UNAVAILABLE',
      expectedKind: 'degraded',
      expectedResolution: 'unavailable',
      status: 503
    },
    {
      code: 'AUTH_EXPIRED',
      expectedKind: 'anonymous',
      expectedResolution: 'anonymous',
      status: 401
    },
    {
      code: 'AUTH_IP_BLOCKED',
      expectedKind: 'blocked',
      expectedResolution: 'blocked',
      status: 403
    },
    {
      code: 'AUTH_PERMISSION_DENIED',
      expectedKind: 'blocked',
      expectedResolution: 'blocked',
      status: 403
    }
  ])(
    'maps $status $code into the explicit session state',
    async ({ code, expectedKind, expectedResolution, status }) => {
      seedCredential();
      authApiMocks.me.mockRejectedValueOnce(apiError(status, code));

      await expect(sessionCoordinator.ensureSession()).resolves.toBe(expectedResolution);
      expect(sessionCoordinator.state.value.kind).toBe(expectedKind);
      if (status === 401) expect(readStoredCredential()).toBeNull();
    }
  );

  it('deduplicates concurrent navigation validation into one current-user request', async () => {
    seedCredential();
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);

    const first = sessionCoordinator.ensureSession({ source: 'navigation' });
    const second = sessionCoordinator.ensureSession({ source: 'navigation' });
    await vi.waitFor(() => expect(authApiMocks.me).toHaveBeenCalledTimes(1));
    deferred.resolve(user);

    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
  });

  it('recovers from 503, 503, then 200 without clearing the credential', async () => {
    seedCredential();
    authApiMocks.me
      .mockRejectedValueOnce(apiError(503, 'AUTH_DEPENDENCY_UNAVAILABLE'))
      .mockRejectedValueOnce(apiError(503, 'AUTH_DEPENDENCY_UNAVAILABLE'))
      .mockResolvedValueOnce(user);

    await expect(sessionCoordinator.ensureSession()).resolves.toBe('unavailable');
    await expect(
      sessionCoordinator.ensureSession({ force: true, source: 'recovery' })
    ).resolves.toBe('unavailable');
    await expect(
      sessionCoordinator.ensureSession({ force: true, source: 'recovery' })
    ).resolves.toBe('ready');

    expect(sessionCoordinator.state.value).toMatchObject({ kind: 'ready', user });
    expect(readStoredCredential()?.userCache).toEqual(user);
  });

  it('opens the breaker and allows only one failed manual half-open probe', async () => {
    let now = 10_000;
    setSessionCoordinatorClockForTests(() => now);
    seedCredential();
    authApiMocks.me.mockRejectedValue(apiError(503, 'AUTH_DEPENDENCY_UNAVAILABLE'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sessionCoordinator.ensureSession({ force: true, source: 'recovery' });
    }
    expect(authApiMocks.me).toHaveBeenCalledTimes(3);

    await sessionCoordinator.ensureSession({ force: true, source: 'manual-retry' });
    expect(authApiMocks.me).toHaveBeenCalledTimes(4);
    await sessionCoordinator.ensureSession({ force: true, source: 'manual-retry' });
    expect(authApiMocks.me).toHaveBeenCalledTimes(4);

    now += 30_000;
    await sessionCoordinator.ensureSession({ force: true, source: 'recovery' });
    expect(authApiMocks.me).toHaveBeenCalledTimes(5);
  });

  it('keeps a verified shell read-only during 503 and restores it after recovery', async () => {
    seedCredential();
    authApiMocks.me
      .mockResolvedValueOnce(user)
      .mockRejectedValueOnce(apiError(503, 'AUTH_DEPENDENCY_UNAVAILABLE'))
      .mockResolvedValueOnce(user);

    await sessionCoordinator.ensureSession();
    await expect(sessionCoordinator.refreshCurrentUser('background')).resolves.toBe('degraded');
    expect(sessionCoordinator.state.value).toMatchObject({
      kind: 'degraded',
      user,
      verifiedInRuntime: true
    });
    expect(() => sessionCoordinator.assertWriteAllowed()).toThrowError(
      expect.objectContaining({ code: 'SESSION_WRITE_BLOCKED' })
    );

    await expect(
      sessionCoordinator.ensureSession({ force: true, source: 'recovery' })
    ).resolves.toBe('ready');
    expect(() => sessionCoordinator.assertWriteAllowed()).not.toThrow();
  });

  it('ignores a late successful validation after logout', async () => {
    seedCredential();
    const deferred = createDeferred<CurrentUser>();
    authApiMocks.me.mockReturnValueOnce(deferred.promise);
    const pending = sessionCoordinator.ensureSession();
    await vi.waitFor(() => expect(authApiMocks.me).toHaveBeenCalledTimes(1));

    await sessionCoordinator.logout({ remote: false });
    deferred.resolve(user);
    await expect(pending).resolves.toBe('anonymous');

    expect(sessionCoordinator.state.value.kind).toBe('anonymous');
    expect(readStoredCredential()).toBeNull();
  });

  it('does not let an old 401 clear a newer login identity', async () => {
    seedCredential('old-token');
    const oldSnapshot = sessionCoordinator.getCredentialSnapshot();
    authApiMocks.login.mockResolvedValueOnce({
      accessToken: 'new-token',
      user: replacementUser
    });

    await sessionCoordinator.login('operator', 'password');
    const cleared = sessionCoordinator.handleUnauthorized(
      apiError(401, 'AUTH_EXPIRED'),
      oldSnapshot
    );

    expect(cleared).toBe(false);
    expect(sessionCoordinator.credential.value?.token).toBe('new-token');
    expect(sessionCoordinator.state.value).toMatchObject({
      kind: 'ready',
      user: replacementUser
    });
  });

  it('validates a same-credential storage revision without changing identity epoch', async () => {
    seedCredential('token-1');
    authApiMocks.me.mockResolvedValue(user);
    await sessionCoordinator.ensureSession();
    const identityEpoch = sessionCoordinator.identityEpoch.value;
    const current = readStoredCredential();
    expect(current).not.toBeNull();
    writeStoredCredential({
      ...current!,
      token: 'token-2',
      tokenRevision: current!.tokenRevision + 1,
      updatedAt: current!.updatedAt + 1
    });

    dispatchCredentialStorageChange();
    await vi.waitFor(() => expect(authApiMocks.me).toHaveBeenCalledTimes(2));

    expect(sessionCoordinator.identityEpoch.value).toBe(identityEpoch);
    expect(sessionCoordinator.credential.value?.token).toBe('token-2');
    expect(sessionCoordinator.state.value.kind).toBe('ready');
  });

  it('consumes a peer verified result after acquiring Web Lock without a second probe', async () => {
    const credential = seedCredential();
    const request = vi.fn(async (_name, _options, callback: () => Promise<unknown>) => {
      writeStoredCredential({
        ...credential,
        userCache: user,
        updatedAt: credential.updatedAt + 1
      });
      return callback();
    });
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(sessionCoordinator.ensureSession()).resolves.toBe('ready');

    expect(request).toHaveBeenCalledTimes(1);
    expect(authApiMocks.me).not.toHaveBeenCalled();
    expect(sessionCoordinator.state.value).toMatchObject({ kind: 'ready', user });
  });

  it('consumes a peer degraded result after acquiring Web Lock without a second probe', async () => {
    const credential = seedCredential();
    let now = 50_000;
    setSessionCoordinatorClockForTests(() => now);
    const request = vi.fn(async (_name, _options, callback: () => Promise<unknown>) => {
      TestBroadcastChannel.current?.emitMessage({
        credentialId: credential.credentialId,
        errorCode: 'AUTH_DEPENDENCY_UNAVAILABLE',
        retryAt: now + 1_000,
        tokenRevision: credential.tokenRevision,
        type: 'degraded'
      });
      return callback();
    });
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(sessionCoordinator.ensureSession()).resolves.toBe('unavailable');

    expect(authApiMocks.me).not.toHaveBeenCalled();
    expect(sessionCoordinator.state.value.kind).toBe('degraded');
    now += 1_000;
  });

  it('retries locally when another tab wins the fallback lease without sharing credentials', async () => {
    let leaseStolen = false;
    const storage = new (class extends MemoryStorage {
      override setItem(key: string, value: string) {
        super.setItem(key, value);
        if (key !== 'apple_business_session_validation_lease' || leaseStolen) return;
        leaseStolen = true;
        const lease = JSON.parse(value) as Record<string, unknown>;
        super.setItem(key, JSON.stringify({ ...lease, expiresAt: 0, ownerId: 'peer-tab' }));
      }
    })();
    vi.stubGlobal('localStorage', storage);
    seedCredential('lease-token');
    authApiMocks.me.mockResolvedValueOnce(user);

    await expect(sessionCoordinator.ensureSession()).resolves.toBe('ready');

    expect(leaseStolen).toBe(true);
    expect(authApiMocks.me).toHaveBeenCalledTimes(1);
    expect(sessionCoordinator.state.value).toMatchObject({ kind: 'ready', user });
  });
});
