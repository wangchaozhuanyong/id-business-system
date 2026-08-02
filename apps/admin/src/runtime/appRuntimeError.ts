import { ref } from 'vue';
import { isNavigationFailure } from 'vue-router';
import { isApiError } from '@/api/apiError';

export type AppRuntimeErrorSource = 'vue' | 'window' | 'promise';
export type AppRuntimeErrorCategory =
  | 'api'
  | 'navigation'
  | 'cancellation'
  | 'browser-event'
  | 'application';

interface AppRuntimeErrorState {
  message: string;
  source: AppRuntimeErrorSource;
  category: AppRuntimeErrorCategory;
  referenceId: string;
  route: string;
  buildId: string;
  occurredAt: number;
}

interface AppRuntimeErrorContext {
  route: string;
  buildId: string;
}

export interface AppRuntimeErrorClassification {
  action: 'ignore' | 'overlay';
  category: AppRuntimeErrorCategory;
}

const runtimeErrorMessage = '页面运行时遇到问题，当前操作可能没有完成。';
const ignoredBrowserErrorMessages = new Set([
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications.'
]);
let incidentSequence = 0;

export const appRuntimeError = ref<AppRuntimeErrorState | null>(null);

export function classifyAppRuntimeError(
  reason: unknown,
  source: AppRuntimeErrorSource = 'promise'
): AppRuntimeErrorClassification {
  if (isApiError(reason)) return { action: 'ignore', category: 'api' };
  if (isNavigationFailure(reason)) return { action: 'ignore', category: 'navigation' };
  if (isCancellationError(reason)) return { action: 'ignore', category: 'cancellation' };
  const message = getRuntimeErrorMessage(reason);
  if (ignoredBrowserErrorMessages.has(message) || (source === 'window' && !message)) {
    return { action: 'ignore', category: 'browser-event' };
  }
  return { action: 'overlay', category: 'application' };
}

export function shouldIgnoreRuntimeError(reason: unknown) {
  return classifyAppRuntimeError(reason).action === 'ignore';
}

export function captureAppRuntimeError(
  source: AppRuntimeErrorSource,
  reason: unknown,
  context: AppRuntimeErrorContext
) {
  const classification = classifyAppRuntimeError(reason, source);
  if (classification.action === 'ignore') return false;

  const occurredAt = Date.now();
  const incident: AppRuntimeErrorState = {
    message: runtimeErrorMessage,
    source,
    category: classification.category,
    referenceId: createReferenceId(source, occurredAt),
    route: sanitizeRoute(context.route),
    buildId: sanitizeBuildId(context.buildId),
    occurredAt
  };
  appRuntimeError.value = incident;
  reportRuntimeIncident(incident, reason);
  return true;
}

export function clearAppRuntimeError() {
  appRuntimeError.value = null;
}

export function resolveWindowRuntimeErrorReason(event: unknown) {
  if (!event || typeof event !== 'object') return null;
  if ('error' in event && event.error !== undefined && event.error !== null) return event.error;
  const message = getRuntimeErrorMessage(event);
  return message ? new Error(message) : null;
}

function isCancellationError(reason: unknown) {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as {
    __CANCEL__?: unknown;
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  return (
    candidate.__CANCEL__ === true ||
    candidate.code === 'ERR_CANCELED' ||
    candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError' ||
    candidate.message === 'canceled'
  );
}

function createReferenceId(source: AppRuntimeErrorSource, occurredAt: number) {
  incidentSequence = (incidentSequence + 1) % 36 ** 2;
  return `RT-${source.slice(0, 1).toUpperCase()}-${occurredAt.toString(36).toUpperCase()}-${incidentSequence.toString(36).toUpperCase().padStart(2, '0')}`;
}

function sanitizeRoute(route: string) {
  return (route.split(/[?#]/, 1)[0] || '/').slice(0, 160);
}

function sanitizeBuildId(buildId: string) {
  return buildId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 96) || 'unknown';
}

function reportRuntimeIncident(incident: AppRuntimeErrorState, reason: unknown) {
  const safeDiagnostic = {
    referenceId: incident.referenceId,
    source: incident.source,
    category: incident.category,
    route: incident.route,
    buildId: incident.buildId,
    occurredAt: incident.occurredAt
  };
  console.error(`[V2_RUNTIME_INCIDENT] ${JSON.stringify(safeDiagnostic)}`);
  if (import.meta.env.DEV) console.error(reason);
}

function getRuntimeErrorMessage(reason: unknown) {
  if (typeof reason === 'string') return reason;
  if (!reason || typeof reason !== 'object' || !('message' in reason)) return '';
  const message = reason.message;
  return typeof message === 'string' ? message : '';
}
