import { computed, onScopeDispose, shallowRef } from 'vue';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
import { rechargeApi } from './api';
import { DirectBrowserError } from './bitbrowser-direct-api';
import type { DirectLoginCredential } from './bitbrowser-direct-credential';
import type { DirectLoginCode } from './bitbrowser-direct-login';

export function useBitBrowserDirectOpen(
  refresh: () => Promise<unknown>,
  reportError: (message: string) => void
) {
  const activeTask = shallowRef<{
    id: string;
    controller: AbortController;
    done?: Promise<void>;
    endedRemotely: boolean;
  }>();
  let codeRequest: { id: string; resolve: (code: DirectLoginCode) => void } | undefined;
  let disposed = false;
  const owns = (id: string) => activeTask.value?.id === id;
  const running = computed(() => Boolean(activeTask.value));
  async function start(
    launch: V2RechargeBitBrowserOpenLaunch,
    credential: DirectLoginCredential,
    windowName: string
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
    if (disposed) {
      clearCredentials();
      throw new DirectBrowserError('bitbrowser_direct_cancelled');
    }
    if (activeTask.value) throw new Error('当前网页已有登录任务，请先处理原任务');
    const task = {
      id: launch.id,
      controller: new AbortController(),
      done: undefined as Promise<void> | undefined,
      endedRemotely: false
    };
    activeTask.value = task;
    let profileId: unknown;
    const callback = async (type: 'progress' | 'finished', result: Record<string, unknown>) => {
      if (task.endedRemotely) return;
      await rechargeApi.directBrowserCallback(launch.id, launch.agentToken, {
        type,
        result: {
          ...result,
          payment_attempted: false,
          payment_requests_sent: 0,
          ...(profileId ? { browser_profile_id: profileId } : {})
        }
      });
      if (!disposed) {
        try {
          await refresh();
        } catch {
          if (!disposed && !task.endedRemotely)
            reportError('执行状态已保存，但页面刷新失败，请刷新原任务核对。');
        }
      }
    };
    try {
      await callback('progress', {
        status: 'running',
        stage: 'bitbrowser_group',
        transport: 'web_direct'
      });
    } catch (error) {
      activeTask.value = undefined;
      clearCredentials();
      throw error;
    }
    task.done = (async () => {
      try {
        const { runDirectLogin } = await import('./bitbrowser-direct-login');
        if (task.controller.signal.aborted)
          throw new DirectBrowserError('bitbrowser_direct_cancelled');
        const result = await runDirectLogin(
          launch.bitBrowser,
          credential,
          windowName,
          task.controller.signal,
          {
            progress: async (stage, extra = {}) => {
              if (extra.browser_profile_id) profileId = extra.browser_profile_id;
              await callback('progress', { status: 'running', stage, ...extra });
            },
            restore: async (accountKey) => {
              if (task.controller.signal.aborted || task.endedRemotely)
                throw new DirectBrowserError('bitbrowser_direct_cancelled');
              const result = await rechargeApi.directBrowserCallback(launch.id, launch.agentToken, {
                type: 'restore',
                accountKey
              });
              if (task.controller.signal.aborted || task.endedRemotely)
                throw new DirectBrowserError('bitbrowser_direct_cancelled');
              return result;
            },
            code: () =>
              new Promise<DirectLoginCode>((resolve, reject) => {
                if (task.controller.signal.aborted)
                  return reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
                const abort = () => {
                  codeRequest = undefined;
                  reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
                };
                task.controller.signal.addEventListener('abort', abort, { once: true });
                codeRequest = {
                  id: launch.id,
                  resolve: (code) => {
                    task.controller.signal.removeEventListener('abort', abort);
                    codeRequest = undefined;
                    resolve(code);
                  }
                };
              })
          }
        );
        await callback('finished', result);
      } catch (error) {
        if (task.endedRemotely) return;
        const cancelled = task.controller.signal.aborted;
        const reason = cancelled
          ? 'bitbrowser_direct_cancelled'
          : error instanceof DirectBrowserError
            ? error.reason
            : 'bitbrowser_direct_command_failed';
        if (!disposed) reportError(new DirectBrowserError(reason).message);
        try {
          await callback('finished', {
            status: cancelled ? 'cancelled' : 'blocked',
            stage: 'session_restore',
            reason,
            account_matched: reason === 'official_login_page_not_ready',
            session_status:
              reason === 'official_login_page_not_ready' ? 'restored' : 'not_verified',
            ...(cancelled ? { cancellation_confirmed: true } : {})
          });
        } catch {
          if (!disposed && !task.endedRemotely)
            reportError('网页直连已停止，但执行结果未能保存，请刷新原任务核对；不要重复启动。');
        }
      } finally {
        clearCredentials();
        codeRequest = undefined;
        if (activeTask.value === task) activeTask.value = undefined;
      }
    })();
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
  onScopeDispose(() => {
    disposed = true;
    activeTask.value?.controller.abort();
  });
  return { start, owns, running, submitCode, cancel };
}
