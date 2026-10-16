import type { AppleMailboxBrowserLaunch } from './contracts';

const origin = 'http://127.0.0.1:55324';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type RequestOptions = { signal?: AbortSignal };

export interface RegistrationConnectorHealth {
  service: 'id-business-v2-auto-registration-connector';
  version: 1;
  ok: true;
}

function signal(options: RequestOptions) {
  const timeout = AbortSignal.timeout(6000);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export async function checkRegistrationConnector(
  options: RequestOptions = {}
): Promise<RegistrationConnectorHealth> {
  try {
    const response = await fetch(`${origin}/health`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: signal(options)
    });
    const health: unknown = response.ok ? await response.json() : null;
    if (
      !health ||
      typeof health !== 'object' ||
      !('service' in health) ||
      health.service !== 'id-business-v2-auto-registration-connector' ||
      !('version' in health) ||
      health.version !== 1 ||
      !('ok' in health) ||
      health.ok !== true
    )
      throw new Error();
    return { service: health.service, version: health.version, ok: true };
  } catch {
    throw new Error('自动注册助手未连接或版本不匹配，请先启动助手，再检查连接');
  }
}

export async function dispatchRegistrationBrowser(
  launch: AppleMailboxBrowserLaunch,
  options: RequestOptions & { websiteOrigin?: string } = {}
): Promise<void> {
  try {
    const callback = new URL(launch.callbackBaseUrl);
    if (
      !uuid.test(launch.taskUuid) ||
      typeof launch.launchToken !== 'string' ||
      !launch.launchToken ||
      launch.launchToken.length > 4096 ||
      !Number.isFinite(Date.parse(launch.expiresAt)) ||
      Date.parse(launch.expiresAt) <= Date.now() ||
      callback.origin !== (options.websiteOrigin ?? window.location.origin) ||
      callback.protocol !== 'https:' ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      callback.pathname !== `/api/id-business-v2/auto-registration/browser/tasks/${launch.taskUuid}`
    )
      throw new Error();
    const response = await fetch(`${origin}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskUuid: launch.taskUuid,
        launchToken: launch.launchToken,
        callbackBaseUrl: launch.callbackBaseUrl
      }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: signal(options)
    });
    const receipt: unknown = response.ok ? await response.json() : null;
    if (
      response.status !== 202 ||
      !receipt ||
      typeof receipt !== 'object' ||
      !('accepted' in receipt) ||
      receipt.accepted !== true ||
      !('taskUuid' in receipt) ||
      receipt.taskUuid !== launch.taskUuid
    )
      throw new Error();
  } catch {
    // Local response bodies and launch grants never become user-visible errors.
    throw new Error('任务已保留，但助手接收结果尚未确认；请查看原任务或取消，不要重新注册');
  }
}
