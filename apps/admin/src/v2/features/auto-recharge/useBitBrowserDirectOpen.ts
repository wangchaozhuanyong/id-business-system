import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
import { rechargeApi } from './api';
import {
  DirectBrowserError,
  directBrowserFailure,
  type DirectBrowserOperation
} from './bitbrowser-direct-api';
import type { DirectLoginCredential } from './bitbrowser-direct-credential';
import { automaticLoginCode } from './recharge-login-code';
import type { DirectLoginCode } from './bitbrowser-direct-login';
import { directOperationDeadline } from './recharge-direct-lifecycle';

const progressOperations: Readonly<Record<string, DirectBrowserOperation>> = {
  owned_profile_check: 'record_profile_check',
  bitbrowser_profile_missing_confirmed: 'record_profile_missing',
  bitbrowser_profile_created: 'record_profile_created',
  bitbrowser_profile_opened: 'record_profile_opened',
  bitbrowser_group: 'record_group'
};

export function useBitBrowserDirectOpen(
  refresh: () => Promise<unknown>,
  reportError: (message: string) => void,
  refreshAlreadyCoalesced = false
) {
  const activeTask = shallowRef<{
    id: string;
    controller: AbortController;
    done: Promise<void>;
    endedRemotely: boolean;
    primaryFailure: string;
    clearCode?: () => void;
  }>();
  let codeRequest: { id: string; resolve: (code: DirectLoginCode) => void } | undefined;
  let disposed = false;
  let refreshing = false;
  let refreshQueued = false;
  let displayFailure = '';
  let handledId = '';
  const owns = (id: string) => activeTask.value?.id === id;
  const handles = (id: string) => handledId === id;
  const running = computed(() => Boolean(activeTask.value));
  function requestRefresh() {
    if (disposed) return;
    if (refreshAlreadyCoalesced) {
      void refresh().catch(() => {
        if (!disposed && !displayFailure)
          reportError('执行状态已保存，但页面刷新失败，请刷新原任务核对。');
      });
      return;
    }
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    void (async () => {
      do {
        refreshQueued = false;
        try {
          await refresh();
        } catch {
          if (!disposed && !displayFailure)
            reportError('执行状态已保存，但页面刷新失败，请刷新原任务核对。');
        }
      } while (refreshQueued && !disposed);
    })().finally(() => {
      refreshing = false;
    });
  }
  async function start(
    launch: V2RechargeBitBrowserOpenLaunch,
    credential: DirectLoginCredential,
    windowName: string,
    expectedIdentityEpoch = sessionCoordinator.identityEpoch.value,
    accountId?: string
  ) {
    const clearCredentials = () => {
      if (credential.login) credential.login.password = '';
      if ('sessionJson' in credential) credential.sessionJson = '';
      launch.agentToken = '';
      launch.bitBrowser.localApiToken = '';
      launch.bitBrowser.dynamicProxyUrl = '';
      if (launch.bitBrowser.staticProxyCredentials)
        launch.bitBrowser.staticProxyCredentials.password = '';
    };
    if (activeTask.value) {
      throw new Error('当前网页已有登录任务，请先处理原任务');
    }
    if (disposed || expectedIdentityEpoch !== sessionCoordinator.identityEpoch.value) {
      clearCredentials();
      throw new DirectBrowserError('bitbrowser_direct_cancelled');
    }
    const task = {
      id: launch.id,
      controller: new AbortController(),
      done: Promise.resolve(),
      endedRemotely: false,
      primaryFailure: '',
      clearCode: undefined as (() => void) | undefined
    };
    activeTask.value = task;
    handledId = task.id;
    const identityEpoch = sessionCoordinator.identityEpoch.value;
    displayFailure = '';
    let profileId: unknown;
    let initialSaved = false;
    let acceptStart!: () => void;
    let rejectStart!: (cause: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      acceptStart = resolve;
      rejectStart = reject;
    });
    const callback = async (type: 'progress' | 'finished', result: Record<string, unknown>) => {
      if (task.endedRemotely) return;
      try {
        await directOperationDeadline(
          (signal) =>
            rechargeApi.directBrowserCallback(
              launch.id,
              launch.agentToken,
              {
                type,
                result: {
                  ...result,
                  payment_attempted: false,
                  payment_requests_sent: 0,
                  ...(profileId ? { browser_profile_id: profileId } : {})
                }
              },
              { signal }
            ),
          15_000,
          type === 'progress' ? task.controller.signal : undefined
        );
      } catch (cause) {
        throw directBrowserFailure(
          cause,
          type === 'finished'
            ? 'record_finished'
            : typeof result.stage === 'string' && Object.hasOwn(progressOperations, result.stage)
              ? progressOperations[result.stage]
              : 'record_progress'
        );
      }
      if (type === 'finished') task.endedRemotely = true;
      if (identityEpoch === sessionCoordinator.identityEpoch.value) requestRefresh();
    };
    task.done = (async () => {
      try {
        await callback('progress', {
          status: 'running',
          stage: 'bitbrowser_group',
          transport: 'web_direct'
        });
        initialSaved = true;
        acceptStart();
        const { runDirectLogin } = await directOperationDeadline(
          () => import('./bitbrowser-direct-login'),
          30_000,
          task.controller.signal
        );
        if (task.controller.signal.aborted)
          throw new DirectBrowserError('bitbrowser_direct_cancelled');
        const result = await runDirectLogin(
          launch.bitBrowser,
          credential,
          windowName,
          task.controller.signal,
          {
            accountKey: launch.accountKey,
            ownedProfile: launch.ownedProfile,
            progress: async (stage, extra = {}) => {
              if (extra.browser_profile_id) profileId = extra.browser_profile_id;
              await callback('progress', { status: 'running', stage, ...extra });
            },
            restore: async (accountKey) => {
              if (task.endedRemotely) throw new DirectBrowserError('bitbrowser_direct_cancelled');
              try {
                return await directOperationDeadline(
                  (signal) =>
                    rechargeApi.directBrowserCallback(
                      launch.id,
                      launch.agentToken,
                      { type: 'restore', accountKey },
                      { signal }
                    ),
                  15_000,
                  task.controller.signal
                );
              } catch (cause) {
                throw directBrowserFailure(cause, 'record_restore');
              }
            },
            code: (challenge) =>
              accountId
                ? automaticLoginCode(launch.id, accountId, challenge, task.controller.signal)
                : new Promise<DirectLoginCode>((resolve, reject) => {
                    if (task.controller.signal.aborted)
                      return reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
                    const clear = () => {
                      task.controller.signal.removeEventListener('abort', abort);
                      task.clearCode = undefined;
                      codeRequest = undefined;
                    };
                    const abort = () => {
                      clear();
                      reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
                    };
                    task.clearCode = abort;
                    task.controller.signal.addEventListener('abort', abort, { once: true });
                    codeRequest = {
                      id: launch.id,
                      resolve: (code) => {
                        clear();
                        resolve(code);
                      }
                    };
                  })
          }
        );
        await callback('finished', result);
      } catch (cause) {
        if (!initialSaved) rejectStart(cause);
        if (task.endedRemotely) return;
        const cancelled = task.controller.signal.aborted;
        const reason = cancelled
          ? 'bitbrowser_direct_cancelled'
          : cause instanceof DirectBrowserError
            ? cause.reason
            : 'bitbrowser_direct_command_failed';
        task.primaryFailure = cancelled
          ? new DirectBrowserError('bitbrowser_direct_cancelled').message
          : directBrowserFailure(cause).message;
        displayFailure = task.primaryFailure;
        const report = (supplement = '') => {
          if (!disposed && identityEpoch === sessionCoordinator.identityEpoch.value)
            reportError(task.primaryFailure + supplement);
        };
        report();
        try {
          await callback('finished', {
            status: cancelled ? 'cancelled' : 'blocked',
            stage: [
              'bitbrowser_existing_window_control_unavailable',
              'bitbrowser_direct_debug_unavailable'
            ].includes(reason)
              ? 'browser_control_connect'
              : reason === 'official_login_page_not_ready'
                ? 'official_page_readiness'
                : 'session_restore',
            reason,
            account_matched: reason === 'official_login_page_not_ready',
            session_status:
              reason === 'official_login_page_not_ready' ? 'restored' : 'not_verified',
            ...(cancelled ? { cancellation_confirmed: true } : {})
          });
        } catch (saveError) {
          const saveFailure = directBrowserFailure(saveError, 'record_finished');
          try {
            await directOperationDeadline(
              (signal) => rechargeApi.cancelBitBrowser(launch.id, { signal }),
              15_000
            );
            task.endedRemotely = true;
            if (identityEpoch === sessionCoordinator.identityEpoch.value) requestRefresh();
            report(
              ` ${saveFailure.message} 原登录任务已停止，资料已解锁；请核对比特连接和窗口状态。`
            );
          } catch (closeError) {
            report(
              ` ${saveFailure.message} ${directBrowserFailure(closeError, 'record_stop').message} 原任务结束结果待核对，请刷新原任务后处理；本次不会自动重试。`
            );
          }
        }
      } finally {
        clearCredentials();
        task.clearCode?.();
        if (activeTask.value === task) activeTask.value = undefined;
      }
    })();
    return started;
  }
  function submitCode(id: string, code: string, expiresAt?: string) {
    if (!codeRequest || codeRequest.id !== id || !owns(id) || !/^[0-9]{6,8}$/.test(code))
      throw new Error('当前网页登录任务没有等待验证码，请检查原窗口');
    codeRequest.resolve(expiresAt === undefined ? code : { token: code, expiresAt });
  }
  async function cancel(id: string, endedRemotely = false) {
    if (!owns(id)) throw new Error('当前网页没有此登录任务，请刷新原任务核对');
    const task = activeTask.value!;
    task.endedRemotely ||= endedRemotely;
    task.controller.abort();
    await task.done;
  }
  watch(
    sessionCoordinator.identityEpoch,
    () => {
      activeTask.value?.controller.abort();
    },
    { flush: 'sync' }
  );
  onScopeDispose(() => {
    disposed = true;
    refreshQueued = false;
    activeTask.value?.controller.abort();
  });
  return { start, owns, handles, running, submitCode, cancel };
}
