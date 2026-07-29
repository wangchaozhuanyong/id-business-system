import { defineStore } from 'pinia';
import {
  clearStoredAuthSession,
  CURRENT_USER_STORAGE_KEY,
  isAuthSessionExpired,
  isAuthSessionExpiredError,
  markAuthSessionFresh,
  notifyAuthIdentityChanged,
  TOKEN_STORAGE_KEY
} from '@/auth/session';
import { isSupabaseAuthConfigured } from '@/auth/supabase-config';
import { markAppPerformance, measureAppPerformance } from '@/runtime/performance';
import type { CurrentUser } from '@/types/system';

const CURRENT_USER_REFRESH_INTERVAL_MS = 60_000;

export type SessionStatus = 'idle' | 'checking' | 'ready' | 'anonymous' | 'error';

interface AuthState {
  token: string;
  user: CurrentUser | null;
  userLoadedAt: number;
  userRefreshing: boolean;
  sessionStatus: SessionStatus;
}

let currentUserPromise: Promise<void> | null = null;
let currentUserAttemptId = 0;
let sessionReadyPromise: Promise<SessionStatus> | null = null;
let sessionReadyAttemptId = 0;
let sessionGeneration = 0;
let supabaseSessionSubscribed = false;
let supabaseAuthModulePromise: Promise<typeof import('@/auth/supabase')> | null = null;
let authApiModulePromise: Promise<typeof import('@/api/auth')> | null = null;

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

function invalidateSessionWork(reason: Parameters<typeof notifyAuthIdentityChanged>[0]) {
  sessionGeneration += 1;
  currentUserAttemptId += 1;
  sessionReadyAttemptId += 1;
  currentUserPromise = null;
  sessionReadyPromise = null;
  notifyAuthIdentityChanged(reason);
}

function readStoredCurrentUser() {
  try {
    const stored = localStorage.getItem(CURRENT_USER_STORAGE_KEY);
    const value = stored ? (JSON.parse(stored) as unknown) : null;

    return isCurrentUser(value) ? value : null;
  } catch {
    return null;
  }
}

function persistCurrentUser(user: CurrentUser | null) {
  if (!user) {
    localStorage.removeItem(CURRENT_USER_STORAGE_KEY);
    return;
  }

  localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(user));
}

function isCurrentUser(value: unknown): value is CurrentUser {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const user = value as CurrentUser;
  return (
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.displayName === 'string' &&
    Array.isArray(user.roles) &&
    Array.isArray(user.permissions)
  );
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
    const storedUser = token ? readStoredCurrentUser() : null;

    return {
      token,
      user: storedUser,
      userLoadedAt: storedUser ? Date.now() : 0,
      userRefreshing: false,
      sessionStatus: 'idle'
    };
  },
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    displayName: (state) =>
      state.user?.displayName ?? state.user?.username ?? (state.token ? '验证中' : '未登录'),
    shouldRefreshCurrentUser: (state) =>
      Boolean(state.token) &&
      !state.userRefreshing &&
      Date.now() - state.userLoadedAt > CURRENT_USER_REFRESH_INTERVAL_MS
  },
  actions: {
    async ensureSessionReady(options: { force?: boolean } = {}) {
      if (
        !options.force &&
        (this.sessionStatus === 'ready' || this.sessionStatus === 'anonymous')
      ) {
        return this.sessionStatus;
      }
      if (sessionReadyPromise) return sessionReadyPromise;

      const generation = sessionGeneration;
      const attemptId = ++sessionReadyAttemptId;
      this.sessionStatus = 'checking';
      markAppPerformance('v2:auth-check-start');

      sessionReadyPromise = (async (): Promise<SessionStatus> => {
        try {
          if (isSupabaseAuthConfigured()) {
            const supabaseAuth = await loadSupabaseAuthModule();

            if (!supabaseSessionSubscribed) {
              supabaseSessionSubscribed = true;
              supabaseAuth.subscribeSupabaseSession((event, session) => {
                if (!session) {
                  this.clearLocalSession({
                    reason: 'session-cleared',
                    supabase: false
                  });
                  return;
                }

                const changedUser = Boolean(this.user?.id) && this.user?.id !== session.user.id;
                if (changedUser) {
                  this.clearLocalSession({
                    reason: 'identity-switched',
                    supabase: false
                  });
                }
                this.syncAccessToken(session.access_token);

                if (
                  event === 'SIGNED_IN' &&
                  this.sessionStatus !== 'checking' &&
                  (!this.user || changedUser)
                ) {
                  this.sessionStatus = 'idle';
                  void this.ensureSessionReady({ force: true });
                }
              });
            }

            const session = await supabaseAuth.getSupabaseSession();
            if (generation !== sessionGeneration) return this.sessionStatus;
            if (!session) {
              this.clearLocalSession({
                reason: 'session-cleared',
                supabase: false
              });
              return 'anonymous';
            }
            this.syncAccessToken(session.access_token);
          }

          if (generation !== sessionGeneration) return this.sessionStatus;
          if (!this.token) {
            this.sessionStatus = 'anonymous';
            return this.sessionStatus;
          }

          await this.loadCurrentUser({ force: true });
          if (generation !== sessionGeneration) return this.sessionStatus;
          if (!this.user) throw new Error('登录身份没有通过服务端校验。');

          this.sessionStatus = 'ready';
          return this.sessionStatus;
        } catch (error) {
          if (generation !== sessionGeneration) return this.sessionStatus;

          if (isAuthSessionExpired() || isAuthSessionExpiredError(error)) {
            this.clearLocalSession({
              reason: 'session-expired',
              supabase: false
            });
            return 'anonymous';
          }

          this.sessionStatus = 'error';
          return this.sessionStatus;
        } finally {
          const shouldFinishPerformance =
            attemptId === sessionReadyAttemptId || sessionReadyPromise === null;
          if (attemptId === sessionReadyAttemptId) {
            sessionReadyPromise = null;
          }
          if (shouldFinishPerformance) {
            markAppPerformance('v2:auth-check-end');
            measureAppPerformance(
              'v2:auth-check-duration',
              'v2:auth-check-start',
              'v2:auth-check-end'
            );
          }
        }
      })();

      return sessionReadyPromise;
    },
    async initializeSession() {
      return this.ensureSessionReady();
    },
    async login(username: string, password: string, mfaCode?: string) {
      this.sessionStatus = 'checking';
      try {
        const { authApi } = await loadAuthApiModule();
        const data = await authApi.login(username, password, mfaCode);

        invalidateSessionWork(
          this.user && this.user.id !== data.user.id ? 'identity-switched' : 'login'
        );
        clearStoredAuthSession();
        this.token = '';
        this.user = null;
        this.userLoadedAt = 0;

        if (isSupabaseAuthConfigured()) {
          if (!data.refreshToken) {
            throw new Error('登录成功，但服务端没有返回可续期的登录会话。');
          }
          const supabaseAuth = await loadSupabaseAuthModule();
          await supabaseAuth.setSupabaseSession(data.accessToken, data.refreshToken);
        }
        this.syncAccessToken(data.accessToken);
        this.user = data.user;
        this.userLoadedAt = Date.now();
        this.sessionStatus = 'ready';
        persistCurrentUser(data.user);
      } catch (error) {
        this.sessionStatus = this.token ? 'error' : 'anonymous';
        throw error;
      }
    },
    async loadCurrentUser(options: { force?: boolean } = {}) {
      if (!this.token) {
        return;
      }

      if (currentUserPromise) return currentUserPromise;
      if (!options.force && this.user && !this.shouldRefreshCurrentUser) return;

      const generation = sessionGeneration;
      const attemptId = ++currentUserAttemptId;
      currentUserPromise = (async () => {
        this.userRefreshing = true;
        try {
          const { authApi } = await loadAuthApiModule();
          const currentUser = await authApi.me();
          if (generation !== sessionGeneration) return;

          this.user = currentUser;
          this.userLoadedAt = Date.now();
          persistCurrentUser(this.user);
        } finally {
          if (attemptId === currentUserAttemptId) {
            this.userRefreshing = false;
            currentUserPromise = null;
          }
        }
      })();

      return currentUserPromise;
    },
    syncAccessToken(accessToken: string) {
      this.token = accessToken;
      localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
      markAuthSessionFresh();
    },
    clearLocalSession(
      options: {
        reason?: 'logout' | 'session-cleared' | 'session-expired' | 'identity-switched';
        supabase?: boolean;
      } = {}
    ) {
      const hadIdentity = Boolean(this.token || this.user);
      if (hadIdentity) {
        invalidateSessionWork(options.reason ?? 'session-cleared');
      }

      this.token = '';
      this.user = null;
      this.userLoadedAt = 0;
      this.userRefreshing = false;
      this.sessionStatus = 'anonymous';
      clearStoredAuthSession();
      if ((options.supabase ?? true) && isSupabaseAuthConfigured()) {
        void loadSupabaseAuthModule()
          .then((supabaseAuth) => supabaseAuth.clearSupabaseSession())
          .catch(() => undefined);
      }
    },
    async logout(options: { remote?: boolean } = {}) {
      const shouldNotifyRemote = options.remote ?? true;

      try {
        if (shouldNotifyRemote && this.token) {
          const { authApi } = await loadAuthApiModule();
          await authApi.logout();
        }
      } finally {
        if (isSupabaseAuthConfigured()) {
          const supabaseAuth = await loadSupabaseAuthModule();
          await supabaseAuth.clearSupabaseSession().catch(() => undefined);
        }
        this.clearLocalSession({
          reason: 'logout',
          supabase: false
        });
      }
    }
  }
});
