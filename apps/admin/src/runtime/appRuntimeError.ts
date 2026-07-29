import { ref } from 'vue';

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
const routeResourceErrorPatterns = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /couldn't resolve component "default" at "\/[^"]+"/i
];

export const appRuntimeError = ref<AppRuntimeErrorState | null>(null);

export function shouldIgnoreRuntimeError(reason: unknown) {
  const message = getRuntimeErrorMessage(reason);
  return message
    ? ignoredBrowserErrorMessages.has(message) ||
        routeResourceErrorPatterns.some((pattern) => pattern.test(message))
    : false;
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
  if (typeof reason === 'string') {
    return reason;
  }
  if (!reason || typeof reason !== 'object' || !('message' in reason)) {
    return '';
  }

  const message = reason.message;
  return typeof message === 'string' ? message : '';
}
