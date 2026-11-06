import { isApiError } from '@/api/apiError';
import { DirectBrowserError } from './bitbrowser-direct-api';

export function rechargeExecutionFailure(cause: unknown, cancelled = false) {
  if (cause instanceof DirectBrowserError) return cause.message;
  if (isApiError(cause)) {
    const metadata = [
      /^[A-Za-z0-9_.:-]{1,100}$/.test(cause.code) ? `错误代码：${cause.code}` : '',
      cause.requestId && /^[A-Za-z0-9_.:-]{1,100}$/.test(cause.requestId)
        ? `请求编号：${cause.requestId}`
        : ''
    ].filter(Boolean);
    return [cause.message, ...metadata].join('；');
  }
  return new DirectBrowserError(
    cancelled ? 'bitbrowser_direct_cancelled' : 'bitbrowser_direct_command_failed'
  ).message;
}

// 同时约束请求本身和调用方等待；下载或模拟请求不响应 abort 时也能及时收尾。
export function directOperationDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | unknown, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', cancel);
      if (failed) reject(value);
      else resolve(value as T);
    };
    const stop = (reason: 'bitbrowser_direct_cancelled' | 'bitbrowser_recovery_timeout') => {
      controller.abort();
      finish(new DirectBrowserError(reason), true);
    };
    const cancel = () => stop('bitbrowser_direct_cancelled');
    const timer = setTimeout(() => stop('bitbrowser_recovery_timeout'), timeoutMs);
    if (parentSignal?.aborted) return cancel();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    try {
      run(controller.signal).then(
        (value) => finish(value, false),
        (cause) => finish(cause, true)
      );
    } catch (cause) {
      finish(cause, true);
    }
  });
}
