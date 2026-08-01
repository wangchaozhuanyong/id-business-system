import { readonly, ref, shallowRef } from 'vue';
import { ApiError, createSessionUnavailableError, isApiError } from '@/api/apiError';
import { isSupabaseAuthConfigured } from '@/auth/supabase-config';
import {
  AUTH_CREDENTIAL_STORAGE_KEY,
  clearStoredCredential,
  createStoredCredential,
  isSameCredentialSnapshot,
  readStoredCredential,
  toCredentialSnapshot,
  writeStoredCredential,
  type CredentialSnapshot,
  type StoredCredentialV2
} from '@/auth/credential';
import { markAppPerformance, measureAppPerformance } from '@/runtime/performance';
import type { CurrentUser } from '@/types/system';

const CURRENT_USER_REFRESH_INTERVAL_MS = 60_000;
const VALIDATION_FAILURE_WINDOW_MS = 30_000;
const VALIDATION_BREAKER_DELAYS_MS = [15_000, 30_000, 60_000] as const;
const VALIDATION_LOCK_KEY = 'apple-business:session-validation';
const VALIDATION_LEASE_KEY = 'apple_business_session_validation_lease';
const VALIDATION_LEASE_MS = 5_000;
const VALIDATION_LEASE_CLAIM_SETTLE_MS = 40;
const SESSION_CHANNEL_NAME = 'apple-business:session-v2';

export type SessionValidationSource =
  'boot' | 'navigation' | 'manual-retry' | 'background' | 'recovery';

export type SessionState =
  | { kind: 'cold' }
  | {
      kind: 'anonymous';
      reason: 'none' | 'logout' | 'expired' | 'revoked' | 'disabled' | 'session-cleared';
    }
  | { kind: 'validating'; source: SessionValidationSource; cachedUser: CurrentUser | null }
  | { kind: 'ready'; user: CurrentUser; verifiedAt: number }
  | { kind: 'refreshing'; user: CurrentUser; verifiedAt: number }
  | {
      kind: 'degraded';
      error: ApiError;
      failureCount: number;
      retryAt: number;
      user: CurrentUser | null;
      verifiedInRuntime: boolean;
    }
  | {
      kind: 'blocked';
      reason: 'ip' | 'password-reset' | 'permission';
      user: CurrentUser | null;
    };

export type SessionResolution = 'ready' | 'degraded' | 'anonymous' | 'unavailable' | 'blocked';
export type AuthIdentityChangeReason =
  'login' | 'logout' | 'session-cleared' | 'session-expired' | 'identity-switched';

interface SessionBroadcastMessage {
  credentialId?: string;
  errorCode?: string;
  retryAt?: number;
  tokenRevision?: number;
  type: 'credential-changed' | 'anonymous' | 'verified' | 'degraded';
  verifiedAt?: number;
}

interface ValidationLease {
  credentialId: string;
  expiresAt: number;
  ownerId: string;
  tokenRevision: number;
}

const mutableCredential = shallowRef<StoredCredentialV2 | null>(null);
const mutableSessionState = shallowRef<SessionState>({ kind: 'cold' });
const mutableIdentityEpoch = ref(0);
const mutableUserLoadedAt = ref(0);

export const sessionCredential = readonly(mutableCredential);
export const sessionState = readonly(mutableSessionState);
export const authIdentityEpoch = readonly(mutableIdentityEpoch);
export const sessionUserLoadedAt = readonly(mutableUserLoadedAt);

const LEGAL_SESSION_TRANSITIONS: Record<SessionState['kind'], ReadonlySet<SessionState['kind']>> = {
  cold: new Set(['cold', 'anonymous', 'validating', 'ready', 'degraded']),
  anonymous: new Set(['anonymous', 'cold', 'validating', 'ready']),
  validating: new Set([
    'cold',
    'anonymous',
    'validating',
    'ready',
    'refreshing',
    'degraded',
    'blocked'
  ]),
  ready: new Set(['cold', 'anonymous', 'validating', 'ready', 'refreshing', 'degraded', 'blocked']),
  refreshing: new Set([
    'cold',
    'anonymous',
    'validating',
    'ready',
    'refreshing',
    'degraded',
    'blocked'
  ]),
  degraded: new Set([
    'cold',
    'anonymous',
    'validating',
    'ready',
    'refreshing',
    'degraded',
    'blocked'
  ]),
  blocked: new Set([
    'cold',
    'anonymous',
    'validating',
    'ready',
    'refreshing',
    'degraded',
    'blocked'
  ])
};

export function isSessionTransitionAllowed(from: SessionState['kind'], to: SessionState['kind']) {
  return LEGAL_SESSION_TRANSITIONS[from].has(to);
}

export function transitionSessionState(next: SessionState) {
  const from = mutableSessionState.value.kind;
  if (!isSessionTransitionAllowed(from, next.kind)) {
    throw new Error(`ILLEGAL_SESSION_TRANSITION:${from}->${next.kind}`);
  }
  mutableSessionState.value = next;
}

let hydrated = false;
let validationPromise: Promise<SessionResolution> | null = null;
let authAbortController = new AbortController();
let verifiedCredentialId = '';
let verifiedUserId = '';
let validationFailureTimes: number[] = [];
let breakerOpenUntil = 0;
let breakerLevel = 0;
let halfOpenProbeInFlight = false;
let halfOpenProbeUsed = false;
let browserListenersInstalled = false;
let sessionChannel: BroadcastChannel | null = null;
let providerSubscription: { unsubscribe(): void } | null = null;
let providerSubscribed = false;
let providerAuthUserId = '';
let authApiModulePromise: Promise<typeof import('@/api/auth')> | null = null;
let supabaseAuthModulePromise: Promise<typeof import('@/auth/supabase')> | null = null;
let nowProvider = () => Date.now();
const identityListeners = new Set<(reason: AuthIdentityChangeReason) => void>();
const peerValidationWaiters = new Set<() => void>();
const tabId = createTabId();

export const sessionCoordinator = {
  get state() {
    return sessionState;
  },
  get credential() {
    return sessionCredential;
  },
  get identityEpoch() {
    return authIdentityEpoch;
  },
  get userLoadedAt() {
    return sessionUserLoadedAt;
  },
  hydrate,
  ensureSession,
  login,
  logout,
  changePassword,
  refreshCurrentUser,
  updateAccessToken,
  clearLocalSession,
  getCredentialSnapshot,
  getRequestAbortSignal,
  getResolution,
  handleUnauthorized,
  handleForbidden,
  assertWriteAllowed,
  shouldRefreshCurrentUser,
  subscribeIdentityChange
};

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  mutableCredential.value = readStoredCredential();
  transitionSessionState(
    mutableCredential.value ? { kind: 'cold' } : { kind: 'anonymous', reason: 'none' }
  );
  installBrowserCoordination();
}

function getCredentialSnapshot() {
  hydrate();
  return toCredentialSnapshot(mutableCredential.value);
}

function getRequestAbortSignal() {
  hydrate();
  return authAbortController.signal;
}

function getResolution(): SessionResolution {
  const state = mutableSessionState.value;
  if (state.kind === 'ready' || state.kind === 'refreshing') return 'ready';
  if (state.kind === 'degraded') {
    return state.verifiedInRuntime ? 'degraded' : 'unavailable';
  }
  if (state.kind === 'blocked') return 'blocked';
  if (state.kind === 'anonymous') return 'anonymous';
  return 'unavailable';
}

function shouldRefreshCurrentUser() {
  const state = mutableSessionState.value;
  return (
    Boolean(mutableCredential.value) &&
    state.kind === 'ready' &&
    nowMs() - state.verifiedAt > CURRENT_USER_REFRESH_INTERVAL_MS
  );
}

async function ensureSession(
  options: { force?: boolean; source?: SessionValidationSource } = {}
): Promise<SessionResolution> {
  hydrate();
  const source = options.source ?? 'boot';
  if (!mutableCredential.value) return 'anonymous';
  if (validationPromise) return validationPromise;

  const state = mutableSessionState.value;
  if (!options.force) {
    if (state.kind === 'ready' || state.kind === 'refreshing') return 'ready';
    if (state.kind === 'degraded' && state.verifiedInRuntime) return 'degraded';
    if (state.kind === 'blocked') return 'blocked';
  }

  let halfOpenProbe = false;
  if (isBreakerOpen()) {
    if (source !== 'manual-retry' || halfOpenProbeUsed || halfOpenProbeInFlight) {
      enterCircuitOpenState();
      return getResolution();
    }
    halfOpenProbe = true;
    halfOpenProbeUsed = true;
    halfOpenProbeInFlight = true;
  } else if (breakerLevel > 0) {
    halfOpenProbe = true;
    halfOpenProbeUsed = true;
    halfOpenProbeInFlight = true;
  }

  const snapshot = getCredentialSnapshot();
  if (!snapshot) return 'anonymous';
  const validationStartedAt = nowMs();
  const credentialUpdatedAt = mutableCredential.value?.updatedAt ?? 0;
  const verified = isVerifiedInRuntime(snapshot.credentialId);
  const cachedUser = mutableCredential.value?.userCache ?? null;
  markAppPerformance('v2:auth-check-start');
  transitionSessionState(
    verified && cachedUser
      ? {
          kind: 'refreshing',
          user: cachedUser,
          verifiedAt: getVerifiedAt(state)
        }
      : { kind: 'validating', source, cachedUser }
  );

  validationPromise = withCrossTabValidationLock(
    snapshot,
    { credentialUpdatedAt, validationStartedAt },
    () => validateCurrentUser(snapshot, source, verified, halfOpenProbe)
  ).finally(() => {
    validationPromise = null;
    if (halfOpenProbe) halfOpenProbeInFlight = false;
    markAppPerformance('v2:auth-check-end');
    measureAppPerformance('v2:auth-check-duration', 'v2:auth-check-start', 'v2:auth-check-end');
  });
  return validationPromise;
}

function refreshCurrentUser(source: SessionValidationSource = 'background') {
  return ensureSession({ force: true, source });
}

async function validateCurrentUser(
  snapshot: CredentialSnapshot,
  source: SessionValidationSource,
  hadVerifiedSession: boolean,
  halfOpenProbe: boolean
): Promise<SessionResolution> {
  if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
  if (
    mutableSessionState.value.kind === 'ready' &&
    isVerifiedInRuntime(snapshot.credentialId) &&
    source !== 'manual-retry' &&
    source !== 'background'
  ) {
    return 'ready';
  }

  try {
    await syncProviderSession();
    const synchronizedSnapshot = getCredentialSnapshot();
    if (!synchronizedSnapshot || synchronizedSnapshot.credentialId !== snapshot.credentialId) {
      return getResolution();
    }
    snapshot = synchronizedSnapshot;
    const { authApi } = await loadAuthApiModule();
    const user = await authApi.me();
    if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
    commitVerifiedUser(snapshot, user);
    resetBreaker();
    return 'ready';
  } catch (rawError) {
    if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
    const error = normalizeSessionError(rawError);
    if (error.kind === 'unauthorized' || error.status === 401) {
      handleUnauthorized(error, snapshot);
      return 'anonymous';
    }
    if (error.kind === 'forbidden' || error.status === 403) {
      handleForbidden(error, snapshot);
      return getResolution();
    }

    const failureCount = registerValidationFailure(error, halfOpenProbe);
    const credential = mutableCredential.value;
    const retryAt = Math.max(nowMs() + (error.retryAfterMs ?? 0), breakerOpenUntil);
    transitionSessionState({
      kind: 'degraded',
      error,
      failureCount,
      retryAt,
      user: credential?.userCache ?? null,
      verifiedInRuntime: hadVerifiedSession && isVerifiedInRuntime(snapshot.credentialId)
    });
    broadcastSession({
      credentialId: snapshot.credentialId,
      errorCode: error.code,
      retryAt,
      tokenRevision: snapshot.tokenRevision,
      type: 'degraded'
    });
    return getResolution();
  }
}

async function login(username: string, password: string, mfaCode?: string) {
  hydrate();
  const previousState = mutableSessionState.value;
  transitionSessionState({
    kind: 'validating',
    source: 'manual-retry',
    cachedUser: mutableCredential.value?.userCache ?? null
  });
  try {
    const { authApi } = await loadAuthApiModule();
    const data = await authApi.login(username, password, mfaCode);
    if (isSupabaseAuthConfigured()) {
      if (!data.refreshToken) {
        throw new ApiError('登录成功，但服务端没有返回可续期的登录会话。', {
          code: 'AUTH_PROVIDER_SESSION_MISSING',
          kind: 'server',
          retryable: false,
          status: 500
        });
      }
      const supabaseAuth = await loadSupabaseAuthModule();
      const session = await supabaseAuth.setSupabaseSession(data.accessToken, data.refreshToken);
      providerAuthUserId = session?.user.id ?? '';
    }

    replaceCredential(createStoredCredential(data.accessToken, data.user), 'login');
    verifiedCredentialId = mutableCredential.value?.credentialId ?? '';
    verifiedUserId = data.user.id;
    mutableUserLoadedAt.value = nowMs();
    transitionSessionState({
      kind: 'ready',
      user: data.user,
      verifiedAt: mutableUserLoadedAt.value
    });
    resetBreaker();
    broadcastVerified();
  } catch (error) {
    transitionSessionState(
      mutableCredential.value ? previousState : { kind: 'anonymous', reason: 'none' }
    );
    throw error;
  }
}

async function logout(options: { remote?: boolean } = {}) {
  hydrate();
  const snapshot = getCredentialSnapshot();
  let remoteError: unknown;
  try {
    if ((options.remote ?? true) && snapshot) {
      const { authApi } = await loadAuthApiModule();
      await authApi.logout();
    }
  } catch (error) {
    remoteError = error;
  } finally {
    if (isSupabaseAuthConfigured()) {
      const supabaseAuth = await loadSupabaseAuthModule();
      await supabaseAuth.clearSupabaseSession().catch(() => undefined);
    }
    clearLocalSession({ expectedCredentialId: snapshot?.credentialId, reason: 'logout' });
  }
  if (remoteError) throw remoteError;
}

async function changePassword(currentPassword: string, newPassword: string) {
  const { authApi } = await loadAuthApiModule();
  const result = await authApi.changePassword(currentPassword, newPassword);
  if (!result.passwordChanged || !result.signedOut) {
    throw new ApiError('密码修改结果不完整，请重新登录后确认。', {
      code: 'AUTH_PASSWORD_CHANGE_INCOMPLETE',
      kind: 'server',
      retryable: false,
      status: 500
    });
  }
  if (isSupabaseAuthConfigured()) {
    const supabaseAuth = await loadSupabaseAuthModule();
    await supabaseAuth.clearSupabaseSession().catch(() => undefined);
  }
  clearLocalSession({ reason: 'logout' });
  return result;
}

function updateAccessToken(accessToken: string) {
  hydrate();
  const token = accessToken.trim();
  if (!token) return;
  const current = mutableCredential.value;
  if (!current) {
    replaceCredential(createStoredCredential(token, null), 'login');
    transitionSessionState({ kind: 'cold' });
    return;
  }
  if (current.token === token) return;

  const next: StoredCredentialV2 = {
    ...current,
    token,
    tokenRevision: current.tokenRevision + 1,
    updatedAt: Math.max(nowMs(), current.updatedAt + 1)
  };
  mutableCredential.value = next;
  writeStoredCredential(next);
  broadcastSession({
    credentialId: next.credentialId,
    tokenRevision: next.tokenRevision,
    type: 'credential-changed'
  });
}

function clearLocalSession(
  options: {
    expected?: CredentialSnapshot | null;
    expectedCredentialId?: string;
    reason?: AuthIdentityChangeReason;
  } = {}
) {
  hydrate();
  const current = mutableCredential.value;
  const expected = options.expected;
  if (expected && !isSameCredentialSnapshot(current, expected)) return false;
  if (options.expectedCredentialId && current?.credentialId !== options.expectedCredentialId) {
    return false;
  }
  if (expected) {
    const removed = clearStoredCredential({
      credentialId: expected.credentialId,
      tokenRevision: expected.tokenRevision
    });
    if (!removed) {
      applyStoredCredential();
      return false;
    }
  } else if (current) {
    const removed = clearStoredCredential({
      credentialId: options.expectedCredentialId ?? current.credentialId
    });
    if (!removed) {
      applyStoredCredential();
      return false;
    }
  } else {
    clearStoredCredential();
  }

  const clearedCredentialId = current?.credentialId;
  mutableCredential.value = null;
  mutableUserLoadedAt.value = 0;
  verifiedCredentialId = '';
  verifiedUserId = '';
  providerAuthUserId = '';
  abortIdentityRequests();
  emitIdentityChange(options.reason ?? 'session-cleared');
  const anonymousReason = mapAnonymousReason(options.reason);
  transitionSessionState({ kind: 'anonymous', reason: anonymousReason });
  resetBreaker();
  broadcastSession({ credentialId: clearedCredentialId, type: 'anonymous' });
  return true;
}

function handleUnauthorized(error: ApiError, snapshot: CredentialSnapshot | null | undefined) {
  if (!snapshot || !isSameCredentialSnapshot(mutableCredential.value, snapshot)) return false;
  const reason: AuthIdentityChangeReason = 'session-expired';
  const cleared = clearLocalSession({ expected: snapshot, reason });
  if (cleared) {
    transitionSessionState({
      kind: 'anonymous',
      reason:
        error.code === 'AUTH_ACCOUNT_DISABLED'
          ? 'disabled'
          : error.code === 'AUTH_REVOKED'
            ? 'revoked'
            : 'expired'
    });
  }
  return cleared;
}

function handleForbidden(error: ApiError, snapshot: CredentialSnapshot | null | undefined) {
  if (!snapshot || !isSameCredentialSnapshot(mutableCredential.value, snapshot)) return false;
  if (error.code === 'AUTH_IP_BLOCKED') {
    transitionSessionState({
      kind: 'blocked',
      reason: 'ip',
      user: mutableCredential.value?.userCache ?? null
    });
    return true;
  }
  if (error.code === 'AUTH_PASSWORD_RESET_REQUIRED') {
    transitionSessionState({
      kind: 'blocked',
      reason: 'password-reset',
      user: mutableCredential.value?.userCache ?? null
    });
    return true;
  }
  transitionSessionState({
    kind: 'blocked',
    reason: 'permission',
    user: mutableCredential.value?.userCache ?? null
  });
  return true;
}

function assertWriteAllowed() {
  hydrate();
  const state = mutableSessionState.value;
  if (state.kind === 'ready' || state.kind === 'refreshing') return;
  throw new ApiError('当前登录状态尚未确认，修改操作已暂停。请恢复连接后重试。', {
    code: 'SESSION_WRITE_BLOCKED',
    kind: 'transient',
    retryable: true,
    status: 503
  });
}

function subscribeIdentityChange(listener: (reason: AuthIdentityChangeReason) => void) {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

function commitVerifiedUser(snapshot: CredentialSnapshot, user: CurrentUser) {
  const current = mutableCredential.value;
  if (!isSameCredentialSnapshot(current, snapshot) || !current) return;
  const identitySwitched = Boolean(verifiedUserId) && verifiedUserId !== user.id;
  const next = identitySwitched
    ? createStoredCredential(current.token, user)
    : { ...current, userCache: user, updatedAt: Math.max(nowMs(), current.updatedAt + 1) };
  if (identitySwitched) {
    replaceCredential(next, 'identity-switched');
  } else {
    mutableCredential.value = next;
    writeStoredCredential(next);
  }
  verifiedCredentialId = next.credentialId;
  verifiedUserId = user.id;
  mutableUserLoadedAt.value = nowMs();
  transitionSessionState({
    kind: 'ready',
    user,
    verifiedAt: mutableUserLoadedAt.value
  });
  broadcastVerified();
}

function replaceCredential(next: StoredCredentialV2, reason: AuthIdentityChangeReason) {
  const previous = mutableCredential.value;
  mutableCredential.value = next;
  writeStoredCredential(next);
  abortIdentityRequests();
  if (!previous || previous.credentialId !== next.credentialId) emitIdentityChange(reason);
  broadcastSession({
    credentialId: next.credentialId,
    tokenRevision: next.tokenRevision,
    type: 'credential-changed'
  });
}

function emitIdentityChange(reason: AuthIdentityChangeReason) {
  mutableIdentityEpoch.value += 1;
  for (const listener of identityListeners) listener(reason);
}

function abortIdentityRequests() {
  if (!authAbortController.signal.aborted) {
    authAbortController.abort(new DOMException('登录身份已变化。', 'AbortError'));
  }
  authAbortController = new AbortController();
}

function normalizeSessionError(error: unknown) {
  if (isApiError(error)) return error;
  return new ApiError('暂时无法连接登录服务，请检查网络后重试。', {
    cause: error,
    code: 'AUTH_NETWORK_UNAVAILABLE',
    kind: 'network',
    retryable: true,
    status: null
  });
}

function registerValidationFailure(error: ApiError, halfOpenProbe: boolean) {
  const now = nowMs();
  validationFailureTimes = validationFailureTimes.filter(
    (failedAt) => now - failedAt <= VALIDATION_FAILURE_WINDOW_MS
  );
  if (error.retryable) validationFailureTimes.push(now);
  if (error.retryable && halfOpenProbe) {
    const delay =
      VALIDATION_BREAKER_DELAYS_MS[Math.min(breakerLevel, VALIDATION_BREAKER_DELAYS_MS.length - 1)];
    breakerLevel += 1;
    breakerOpenUntil = now + delay;
    halfOpenProbeUsed = true;
    validationFailureTimes = [];
  } else if (error.retryable && validationFailureTimes.length >= 3) {
    const delay =
      VALIDATION_BREAKER_DELAYS_MS[Math.min(breakerLevel, VALIDATION_BREAKER_DELAYS_MS.length - 1)];
    breakerLevel += 1;
    breakerOpenUntil = now + delay;
    halfOpenProbeUsed = false;
    validationFailureTimes = [];
  }
  return validationFailureTimes.length || (breakerOpenUntil > now ? 3 : 1);
}

function resetBreaker() {
  validationFailureTimes = [];
  breakerOpenUntil = 0;
  breakerLevel = 0;
  halfOpenProbeInFlight = false;
  halfOpenProbeUsed = false;
}

function isBreakerOpen() {
  return breakerOpenUntil > nowMs();
}

function enterCircuitOpenState() {
  const credential = mutableCredential.value;
  const verified = Boolean(credential && isVerifiedInRuntime(credential.credentialId));
  transitionSessionState({
    kind: 'degraded',
    error: createSessionUnavailableError(Math.max(0, breakerOpenUntil - nowMs())),
    failureCount: 3,
    retryAt: breakerOpenUntil,
    user: credential?.userCache ?? null,
    verifiedInRuntime: verified
  });
}

function isVerifiedInRuntime(credentialId: string) {
  return Boolean(credentialId && verifiedCredentialId === credentialId);
}

function getVerifiedAt(state: SessionState) {
  if (state.kind === 'ready' || state.kind === 'refreshing') return state.verifiedAt;
  return mutableUserLoadedAt.value || nowMs();
}

function mapAnonymousReason(reason?: AuthIdentityChangeReason) {
  if (reason === 'logout') return 'logout' as const;
  if (reason === 'session-expired') return 'expired' as const;
  return 'session-cleared' as const;
}

async function syncProviderSession() {
  if (!isSupabaseAuthConfigured()) return;
  const supabaseAuth = await loadSupabaseAuthModule();
  ensureProviderSubscription(supabaseAuth);
  const session = await supabaseAuth.getSupabaseSession();
  if (!session) {
    clearLocalSession({ reason: 'session-cleared' });
    return;
  }
  providerAuthUserId = session.user.id;
  updateAccessToken(session.access_token);
}

function ensureProviderSubscription(supabaseAuth: typeof import('@/auth/supabase')) {
  if (providerSubscribed) return;
  providerSubscribed = true;
  providerSubscription = supabaseAuth.subscribeSupabaseSession((event, session) => {
    if (!session) {
      if (event === 'SIGNED_OUT') clearLocalSession({ reason: 'session-cleared' });
      return;
    }
    const changedUser = Boolean(providerAuthUserId) && providerAuthUserId !== session.user.id;
    if (changedUser) clearLocalSession({ reason: 'identity-switched' });
    providerAuthUserId = session.user.id;
    updateAccessToken(session.access_token);
    if (
      (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') &&
      mutableSessionState.value.kind !== 'validating'
    ) {
      void ensureSession({ force: true, source: 'background' });
    }
  });
}

function loadAuthApiModule() {
  authApiModulePromise ??= import('@/api/auth').catch((error) => {
    authApiModulePromise = null;
    throw error;
  });
  return authApiModulePromise;
}

function loadSupabaseAuthModule() {
  supabaseAuthModulePromise ??= import('@/auth/supabase').catch((error) => {
    supabaseAuthModulePromise = null;
    throw error;
  });
  return supabaseAuthModulePromise;
}

async function withCrossTabValidationLock(
  snapshot: CredentialSnapshot,
  peerMarker: { credentialUpdatedAt: number; validationStartedAt: number },
  task: () => Promise<SessionResolution>
) {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager) {
    return lockManager.request(VALIDATION_LOCK_KEY, { mode: 'exclusive' }, async () => {
      if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
      const peerResolution = consumePeerValidation(snapshot, peerMarker);
      if (peerResolution) return peerResolution;
      return task();
    });
  }
  return withValidationLease(snapshot, peerMarker, task);
}

async function withValidationLease(
  snapshot: CredentialSnapshot,
  peerMarker: { credentialUpdatedAt: number; validationStartedAt: number },
  task: () => Promise<SessionResolution>
) {
  const storage = getCoordinationStorage();
  if (!storage) return task();
  const now = nowMs();
  const existing = readValidationLease(storage);
  if (
    existing &&
    existing.ownerId !== tabId &&
    existing.expiresAt > now &&
    existing.credentialId === snapshot.credentialId &&
    existing.tokenRevision === snapshot.tokenRevision
  ) {
    await waitForPeerValidation(Math.min(VALIDATION_LEASE_MS, existing.expiresAt - now + 50));
    if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
    const peerResolution = consumePeerValidation(snapshot, peerMarker);
    if (peerResolution) return peerResolution;
  }

  const lease: ValidationLease = {
    credentialId: snapshot.credentialId,
    expiresAt: nowMs() + VALIDATION_LEASE_MS,
    ownerId: tabId,
    tokenRevision: snapshot.tokenRevision
  };
  storage.setItem(VALIDATION_LEASE_KEY, JSON.stringify(lease));
  await delayLeaseClaim();
  if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();

  const confirmedLease = readValidationLease(storage);
  if (confirmedLease?.ownerId !== tabId) {
    const immediatePeerResolution = consumePeerValidation(snapshot, peerMarker);
    if (immediatePeerResolution) return immediatePeerResolution;
    if (confirmedLease && confirmedLease.expiresAt > nowMs()) {
      await waitForPeerValidation(
        Math.min(VALIDATION_LEASE_MS, confirmedLease.expiresAt - nowMs() + 50)
      );
    }
    if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
    const peerResolution = consumePeerValidation(snapshot, peerMarker);
    if (peerResolution) return peerResolution;
    return withValidationLease(snapshot, peerMarker, task);
  }

  try {
    return await task();
  } finally {
    const currentLease = readValidationLease(storage);
    if (currentLease?.ownerId === tabId) storage.removeItem(VALIDATION_LEASE_KEY);
  }
}

function delayLeaseClaim() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, VALIDATION_LEASE_CLAIM_SETTLE_MS);
  });
}

function consumePeerValidation(
  snapshot: CredentialSnapshot,
  peerMarker: { credentialUpdatedAt: number; validationStartedAt: number }
): SessionResolution | null {
  if (!isSameCredentialSnapshot(mutableCredential.value, snapshot)) return getResolution();
  const state = mutableSessionState.value;
  if (state.kind === 'ready' && isVerifiedInRuntime(snapshot.credentialId)) return 'ready';
  if (state.kind === 'degraded' && state.retryAt >= peerMarker.validationStartedAt) {
    return getResolution();
  }

  const stored = readStoredCredential();
  if (
    stored &&
    stored.credentialId === snapshot.credentialId &&
    stored.tokenRevision === snapshot.tokenRevision &&
    stored.updatedAt > peerMarker.credentialUpdatedAt &&
    stored.userCache
  ) {
    mutableCredential.value = stored;
    verifiedCredentialId = stored.credentialId;
    verifiedUserId = stored.userCache.id;
    mutableUserLoadedAt.value = stored.updatedAt;
    transitionSessionState({
      kind: 'ready',
      user: stored.userCache,
      verifiedAt: stored.updatedAt
    });
    resetBreaker();
    return 'ready';
  }
  return null;
}

function waitForPeerValidation(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peerValidationWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    peerValidationWaiters.add(finish);
  });
}

function readValidationLease(storage: Storage): ValidationLease | null {
  const raw = storage.getItem(VALIDATION_LEASE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ValidationLease>;
    if (
      typeof value.credentialId === 'string' &&
      typeof value.expiresAt === 'number' &&
      typeof value.ownerId === 'string' &&
      typeof value.tokenRevision === 'number'
    ) {
      return value as ValidationLease;
    }
  } catch {
    // A corrupt coordination lease is disposable and never contains credentials.
  }
  storage.removeItem(VALIDATION_LEASE_KEY);
  return null;
}

function getCoordinationStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function installBrowserCoordination() {
  if (browserListenersInstalled || typeof window === 'undefined') return;
  browserListenersInstalled = true;
  window.addEventListener('storage', handleCredentialStorageChange);
  window.addEventListener('online', handleRecoverySignal);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityRecovery);
  }
  if (typeof BroadcastChannel !== 'undefined') {
    sessionChannel = new BroadcastChannel(SESSION_CHANNEL_NAME);
    sessionChannel.addEventListener('message', handleSessionBroadcast);
  }
}

function handleCredentialStorageChange(event: StorageEvent) {
  if (event.key === AUTH_CREDENTIAL_STORAGE_KEY || event.key === null) applyStoredCredential();
}

function applyStoredCredential() {
  const stored = readStoredCredential();
  const current = mutableCredential.value;
  if (!stored) {
    if (current) {
      mutableCredential.value = null;
      verifiedCredentialId = '';
      verifiedUserId = '';
      mutableUserLoadedAt.value = 0;
      abortIdentityRequests();
      emitIdentityChange('session-cleared');
      transitionSessionState({ kind: 'anonymous', reason: 'session-cleared' });
    }
    return;
  }

  const identityChanged = !current || current.credentialId !== stored.credentialId;
  const tokenRevisionChanged =
    Boolean(current) &&
    current?.credentialId === stored.credentialId &&
    current.tokenRevision !== stored.tokenRevision;
  mutableCredential.value = stored;
  if (identityChanged) {
    verifiedCredentialId = '';
    verifiedUserId = '';
    mutableUserLoadedAt.value = 0;
    abortIdentityRequests();
    emitIdentityChange(current ? 'identity-switched' : 'login');
    transitionSessionState({ kind: 'cold' });
    void ensureSession({ source: 'recovery' });
  } else if (tokenRevisionChanged) {
    const state = mutableSessionState.value;
    if (isVerifiedInRuntime(stored.credentialId) && stored.userCache) {
      transitionSessionState({
        kind: 'refreshing',
        user: stored.userCache,
        verifiedAt: getVerifiedAt(state)
      });
    } else {
      transitionSessionState({ kind: 'cold' });
    }
    void ensureSession({ force: true, source: 'recovery' });
  }
}

function handleSessionBroadcast(event: MessageEvent<SessionBroadcastMessage>) {
  const message = event.data;
  const credential = mutableCredential.value;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'credential-changed' || message.type === 'anonymous') {
    applyStoredCredential();
  } else if (message.type === 'verified') {
    const stored = readStoredCredential();
    if (
      stored &&
      stored.credentialId === message.credentialId &&
      stored.tokenRevision === message.tokenRevision &&
      stored.userCache
    ) {
      mutableCredential.value = stored;
      verifiedCredentialId = stored.credentialId;
      verifiedUserId = stored.userCache.id;
      mutableUserLoadedAt.value = message.verifiedAt ?? nowMs();
      transitionSessionState({
        kind: 'ready',
        user: stored.userCache,
        verifiedAt: mutableUserLoadedAt.value
      });
      resetBreaker();
    }
  } else if (
    message.type === 'degraded' &&
    mutableSessionState.value.kind !== 'ready' &&
    credential !== null &&
    credential.credentialId === message.credentialId &&
    credential.tokenRevision === message.tokenRevision
  ) {
    transitionSessionState({
      kind: 'degraded',
      error: createSessionUnavailableError(
        message.retryAt ? Math.max(0, message.retryAt - nowMs()) : undefined
      ),
      failureCount: 1,
      retryAt: message.retryAt ?? nowMs(),
      user: credential.userCache,
      verifiedInRuntime: false
    });
  }
  for (const waiter of peerValidationWaiters) waiter();
}

function broadcastVerified() {
  const credential = mutableCredential.value;
  if (!credential) return;
  broadcastSession({
    credentialId: credential.credentialId,
    tokenRevision: credential.tokenRevision,
    type: 'verified',
    verifiedAt: mutableUserLoadedAt.value
  });
}

function broadcastSession(message: SessionBroadcastMessage) {
  try {
    sessionChannel?.postMessage(message);
  } catch {
    // Storage events remain the fallback when BroadcastChannel is unavailable.
  }
}

function handleRecoverySignal() {
  const state = mutableSessionState.value;
  if (state.kind === 'degraded' && state.retryAt <= nowMs()) {
    void ensureSession({ force: true, source: 'recovery' });
  }
}

function handleVisibilityRecovery() {
  if (document.visibilityState === 'visible') handleRecoverySignal();
}

function createTabId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${nowMs()}-${Math.random().toString(36).slice(2)}`;
}

function nowMs() {
  return nowProvider();
}

export function setSessionCoordinatorClockForTests(provider?: () => number) {
  nowProvider = provider ?? (() => Date.now());
}

export function resetSessionCoordinatorForTests(initialState: SessionState = { kind: 'cold' }) {
  validationPromise = null;
  hydrated = false;
  mutableCredential.value = null;
  // Tests may seed any source node directly; production transitions must use transitionSessionState.
  mutableSessionState.value = initialState;
  mutableIdentityEpoch.value = 0;
  mutableUserLoadedAt.value = 0;
  verifiedCredentialId = '';
  verifiedUserId = '';
  validationFailureTimes = [];
  breakerOpenUntil = 0;
  breakerLevel = 0;
  halfOpenProbeInFlight = false;
  halfOpenProbeUsed = false;
  providerAuthUserId = '';
  providerSubscribed = false;
  providerSubscription?.unsubscribe();
  providerSubscription = null;
  sessionChannel?.removeEventListener('message', handleSessionBroadcast);
  sessionChannel?.close();
  sessionChannel = null;
  if (browserListenersInstalled && typeof window !== 'undefined') {
    window.removeEventListener('storage', handleCredentialStorageChange);
    window.removeEventListener('online', handleRecoverySignal);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityRecovery);
    }
  }
  browserListenersInstalled = false;
  identityListeners.clear();
  for (const waiter of peerValidationWaiters) waiter();
  peerValidationWaiters.clear();
  authAbortController = new AbortController();
  nowProvider = () => Date.now();
}
