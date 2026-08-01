import { computed } from 'vue';
import { defineStore } from 'pinia';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

export const useAuthStore = defineStore('auth', () => {
  sessionCoordinator.hydrate();

  const session = computed(() => sessionCoordinator.state.value);
  const credential = computed(() => sessionCoordinator.credential.value);
  const token = computed(() => credential.value?.token ?? '');
  const user = computed(() => {
    const current = session.value;
    if (
      current.kind === 'ready' ||
      current.kind === 'refreshing' ||
      current.kind === 'degraded' ||
      current.kind === 'blocked'
    ) {
      return current.user;
    }
    if (current.kind === 'validating') return current.cachedUser;
    return credential.value?.userCache ?? null;
  });
  const userLoadedAt = computed(() => sessionCoordinator.userLoadedAt.value);
  const userRefreshing = computed(() => session.value.kind === 'refreshing');
  const isAuthenticated = computed(() => Boolean(credential.value));
  const displayName = computed(
    () => user.value?.displayName ?? user.value?.username ?? (token.value ? '验证中' : '未登录')
  );
  const shouldRefreshCurrentUser = computed(() => sessionCoordinator.shouldRefreshCurrentUser());
  const isSessionDegraded = computed(() => session.value.kind === 'degraded');
  const isVerifiedDegraded = computed(
    () => session.value.kind === 'degraded' && session.value.verifiedInRuntime
  );
  const sessionError = computed(() =>
    session.value.kind === 'degraded' ? session.value.error : null
  );
  const writesAllowed = computed(
    () => session.value.kind === 'ready' || session.value.kind === 'refreshing'
  );

  return {
    session,
    credential,
    token,
    user,
    userLoadedAt,
    userRefreshing,
    isAuthenticated,
    displayName,
    shouldRefreshCurrentUser,
    isSessionDegraded,
    isVerifiedDegraded,
    sessionError,
    writesAllowed,
    ensureSessionReady: sessionCoordinator.ensureSession,
    initializeSession: sessionCoordinator.ensureSession,
    login: sessionCoordinator.login,
    loadCurrentUser: sessionCoordinator.refreshCurrentUser,
    refreshCurrentUser: sessionCoordinator.refreshCurrentUser,
    syncAccessToken: sessionCoordinator.updateAccessToken,
    clearLocalSession: sessionCoordinator.clearLocalSession,
    logout: sessionCoordinator.logout,
    changePassword: sessionCoordinator.changePassword
  };
});
