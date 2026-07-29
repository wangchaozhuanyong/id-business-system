export const TOKEN_STORAGE_KEY = 'apple_business_access_token';
export const CURRENT_USER_STORAGE_KEY = 'apple_business_current_user';
export const AUTH_SESSION_EXPIRED_EVENT = 'apple-business:auth-session-expired';
export const AUTH_IDENTITY_CHANGED_EVENT = 'apple-business:auth-identity-changed';

export interface AuthSessionExpiredDetail {
  message?: string;
  reason: 'unauthorized';
}

export interface AuthIdentityChangedDetail {
  epoch: number;
  reason: 'login' | 'logout' | 'session-cleared' | 'session-expired' | 'identity-switched';
}

let sessionExpiredNotified = false;
let authSessionExpired = false;
let authSessionAbortController = new AbortController();
let authIdentityEpoch = 0;

export class AuthSessionExpiredError extends Error {
  constructor(message = '登录状态已过期，请重新登录。', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthSessionExpiredError';
  }
}

export function clearStoredAuthSession() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(CURRENT_USER_STORAGE_KEY);
}

export function markAuthSessionFresh() {
  sessionExpiredNotified = false;
  authSessionExpired = false;
  if (authSessionAbortController.signal.aborted) {
    authSessionAbortController = new AbortController();
  }
}

export function notifyAuthIdentityChanged(reason: AuthIdentityChangedDetail['reason']) {
  authIdentityEpoch += 1;
  sessionExpiredNotified = false;
  authSessionExpired = false;

  if (!authSessionAbortController.signal.aborted) {
    authSessionAbortController.abort(new DOMException('登录身份已变化。', 'AbortError'));
  }
  authSessionAbortController = new AbortController();

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<AuthIdentityChangedDetail>(AUTH_IDENTITY_CHANGED_EVENT, {
        detail: {
          epoch: authIdentityEpoch,
          reason
        }
      })
    );
  }
}

export function getAuthIdentityEpoch() {
  return authIdentityEpoch;
}

export function isAuthSessionExpired() {
  return authSessionExpired;
}

export function getAuthSessionAbortSignal() {
  return authSessionAbortController.signal;
}

export function isAuthSessionExpiredError(error: unknown): error is AuthSessionExpiredError {
  return (
    error instanceof AuthSessionExpiredError || getErrorName(error) === 'AuthSessionExpiredError'
  );
}

export function assertAuthSessionActive() {
  if (authSessionExpired) {
    throw new AuthSessionExpiredError();
  }
}

export function notifyAuthSessionExpired(detail: AuthSessionExpiredDetail) {
  authSessionExpired = true;
  clearStoredAuthSession();

  if (!authSessionAbortController.signal.aborted) {
    authSessionAbortController.abort(new AuthSessionExpiredError(detail.message));
  }

  if (sessionExpiredNotified) {
    return;
  }

  sessionExpiredNotified = true;
  window.dispatchEvent(
    new CustomEvent<AuthSessionExpiredDetail>(AUTH_SESSION_EXPIRED_EVENT, {
      detail
    })
  );
}

function getErrorName(error: unknown) {
  return error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
}
