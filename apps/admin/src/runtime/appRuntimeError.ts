import { ref } from 'vue';
import { isNavigationFailure } from 'vue-router';
import { isApiError } from '@/api/apiError';

type AppRuntimeErrorSource = 'vue' | 'window' | 'promise';

interface AppRuntimeErrorState {
  message: string;
  source: AppRuntimeErrorSource;
  occurredAt: number;
}

const runtimeErrorMessage = '页面运行时遇到问题，当前操作可能没有完成。';
const ignoredBrowserErrorMessages = new Set([
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications.'
]);

export const appRuntimeError = ref<AppRuntimeErrorState | null>(null);

export function shouldIgnoreRuntimeError(reason: unknown) {
  if (isApiError(reason) || isNavigationFailure(reason)) return true;
  if (reason instanceof DOMException && reason.name === 'AbortError') return true;
  const message = getRuntimeErrorMessage(reason);
  return message ? ignoredBrowserErrorMessages.has(message) : false;
}

export function setAppRuntimeError(source: AppRuntimeErrorSource, message = runtimeErrorMessage) {
  appRuntimeError.value = {
    message,
    source,
    occurredAt: Date.now()
  };
}

export function clearAppRuntimeError() {
  appRuntimeError.value = null;
}

function getRuntimeErrorMessage(reason: unknown) {
  if (typeof reason === 'string') return reason;
  if (!reason || typeof reason !== 'object' || !('message' in reason)) return '';
  const message = reason.message;
  return typeof message === 'string' ? message : '';
}
