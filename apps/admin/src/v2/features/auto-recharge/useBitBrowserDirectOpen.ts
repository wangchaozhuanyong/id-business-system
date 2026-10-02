import { onScopeDispose } from 'vue';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
import { rechargeApi } from './api';
import { DirectBrowserError } from './bitbrowser-direct-api';
import { runDirectLogin, type DirectLoginCredential } from './bitbrowser-direct-login';

export function useBitBrowserDirectOpen(
  refresh: () => Promise<unknown>,
  reportError: (message: string) => void
) {
  let active: { id: string; controller: AbortController; done?: Promise<void> } | undefined;
  let codeRequest: { id: string; resolve: (code: string) => void } | undefined;
  let disposed = false;
  const owns = (id: string) => active?.id === id;
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
    if (active) throw new Error('当前网页已有登录任务，请先处理原任务');
    const task = {
      id: launch.id,
      controller: new AbortController(),
      done: undefined as Promise<void> | undefined
    };
    active = task;
    let profileId: unknown;
    const callback = async (type: 'progress' | 'finished', result: Record<string, unknown>) => {
      await rechargeApi.directBrowserCallback(launch.id, launch.agentToken, {
        type,
        result: {
          ...result,
          payment_attempted: false,
          payment_requests_sent: 0,
          ...(profileId ? { browser_profile_id: profileId } : {})
        }
      });
      if (!disposed) await refresh();
    };
    try {
      await callback('progress', {
        status: 'running',
        stage: 'bitbrowser_group',
        transport: 'web_direct'
      });
    } catch (error) {
      active = undefined;
      clearCredentials();
      throw error;
    }
    task.done = (async () => {
      try {
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
            code: () =>
              new Promise<string>((resolve, reject) => {
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
            ...(cancelled ? { cancellation_confirmed: true } : {})
          });
        } catch {
          if (!disposed)
            reportError('网页直连已停止，但执行结果未能保存，请刷新原任务核对；不要重复启动。');
        }
      } finally {
        clearCredentials();
        codeRequest = undefined;
        if (active === task) active = undefined;
      }
    })();
  }
  function submitCode(id: string, code: string) {
    if (!codeRequest || codeRequest.id !== id || !owns(id) || !/^[0-9]{6,8}$/.test(code))
      throw new Error('当前网页登录任务没有等待验证码，请检查原窗口');
    codeRequest.resolve(code);
  }
  async function cancel(id: string) {
    if (!owns(id)) throw new Error('当前网页没有此登录任务，请刷新原任务核对');
    const task = active!;
    task.controller.abort();
    await task.done;
  }
  onScopeDispose(() => {
    disposed = true;
    active?.controller.abort();
  });
  return { start, owns, submitCode, cancel };
}
