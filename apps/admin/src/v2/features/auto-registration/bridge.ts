import {
  AUTO_REGISTRATION_WORKSPACE_PATH,
  autoRegistrationPages,
  type AutoRegistrationChildMessage,
  type AutoRegistrationDraft,
  type AutoRegistrationPage,
  type AutoRegistrationParentState,
  type AppleMailboxBridgeAction
} from './contracts';

const themeTokenNames = [
  '--v2-bg',
  '--v2-surface',
  '--v2-surface-muted',
  '--v2-surface-hover',
  '--v2-text',
  '--v2-text-soft',
  '--v2-border',
  '--v2-border-soft',
  '--v2-accent',
  '--v2-accent-solid',
  '--v2-on-accent-solid',
  '--v2-accent-soft',
  '--v2-success',
  '--v2-danger',
  '--v3-font-sans',
  '--v3-font-mono',
  '--v3-font-size-body',
  '--v3-line-height-body',
  '--v3-radius'
] as const;

const sensitiveField =
  /password|passwd|secret|token|cookie|(?:^|[_.:-])key(?:$|[_.:-])|api.?key|authorization|credential|proxy|cvv|cvc|otp|captcha|verification.?code|security.?code|import|raw.?account|account.?data|link-text/i;

const credentialValue = /(?:https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i;

export function isAutoRegistrationPage(value: unknown): value is AutoRegistrationPage {
  return autoRegistrationPages.some((page) => page.path === value);
}

export function registrationWorkspaceUrl(workspacePath: string, page: AutoRegistrationPage) {
  if (workspacePath !== AUTO_REGISTRATION_WORKSPACE_PATH) {
    throw new Error('自动注册工作区地址不正确，请重新加载。');
  }
  return `${workspacePath}${page === '/' ? '' : page.slice(1)}`;
}

export function sanitizeRegistrationDraft(value: unknown): AutoRegistrationDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          /^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(key) &&
          !sensitiveField.test(key) &&
          (typeof item === 'boolean' ||
            (typeof item === 'string' && item.length <= 4000 && !credentialValue.test(item)))
      )
      .slice(0, 100)
  );
}

export function readRegistrationChildMessage(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  frameWindow: Window | null,
  origin: string,
  activePage: AutoRegistrationPage
): AutoRegistrationChildMessage | undefined {
  if (!frameWindow || event.source !== frameWindow || event.origin !== origin) return;
  const value: unknown = event.data;
  if (!value || typeof value !== 'object') return;
  const message = value as Partial<AutoRegistrationChildMessage>;
  if (!isAutoRegistrationPage(message.page)) return;
  if (message.type === 'id-registration:ready') {
    return { type: message.type, page: message.page };
  }
  if (message.type === 'id-registration:draft' && message.page === activePage) {
    return { type: message.type, page: message.page, values: message.values };
  }
  if (
    message.type === 'id-registration:apple-request' &&
    message.page === '/' &&
    activePage === '/' &&
    typeof message.requestId === 'string' &&
    /^[a-zA-Z0-9-]{1,80}$/.test(message.requestId) &&
    isAppleMailboxBridgeAction(message.action) &&
    message.payload &&
    typeof message.payload === 'object' &&
    !Array.isArray(message.payload)
  ) {
    const payload = sanitizeAppleMailboxRequest(message.action, message.payload);
    if (!payload) return;
    return {
      type: message.type,
      page: '/',
      requestId: message.requestId,
      action: message.action,
      payload
    };
  }
}

export function sanitizeAppleMailboxRequest(
  action: AppleMailboxBridgeAction,
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const id = (value: unknown) => typeof value === 'string' && /^[\w:-]{1,128}$/.test(value);
  const integer = (value: unknown, min: number, max: number) =>
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
  const uploadFields = [
    'auto_upload_cpa',
    'cpa_service_ids',
    'auto_upload_sub2api',
    'sub2api_service_ids',
    'auto_upload_tm',
    'tm_service_ids'
  ];
  const allowed =
    action === 'candidates'
      ? []
      : ['task', 'cancel-task'].includes(action)
        ? ['taskUuid']
        : ['batch-status', 'cancel-batch'].includes(action)
          ? ['batchId']
          : action === 'start'
            ? ['aliasId', 'revision', 'proxyId', ...uploadFields]
            : [
                'targets',
                'count',
                'concurrency',
                'mode',
                'interval_min',
                'interval_max',
                'proxyId',
                ...uploadFields
              ];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) return;
  if (action === 'candidates') return {};
  if (action === 'task' || action === 'cancel-task')
    return id(payload.taskUuid) ? { taskUuid: payload.taskUuid } : undefined;
  if (action === 'batch-status' || action === 'cancel-batch')
    return id(payload.batchId) ? { batchId: payload.batchId } : undefined;
  if (
    'proxyId' in payload &&
    (typeof payload.proxyId !== 'string' || !/^[a-zA-Z0-9_-]{1,191}$/.test(payload.proxyId))
  )
    return;
  for (const key of uploadFields) {
    if (!(key in payload)) continue;
    if (key.startsWith('auto_') && typeof payload[key] !== 'boolean') return;
    if (
      key.endsWith('_ids') &&
      (!Array.isArray(payload[key]) ||
        payload[key].length > 100 ||
        !payload[key].every((value) => integer(value, 1, Number.MAX_SAFE_INTEGER)))
    )
      return;
  }
  if (action === 'start') {
    if ('aliasId' in payload !== 'revision' in payload) return;
    if (
      'aliasId' in payload &&
      (!id(payload.aliasId) || !integer(payload.revision, 0, Number.MAX_SAFE_INTEGER))
    )
      return;
  } else {
    if (!integer(payload.count, 1, 100) || !integer(payload.concurrency, 1, 50)) return;
    if (!['pipeline', 'parallel'].includes(payload.mode as string)) return;
    if (
      !integer(payload.interval_min, 0, 3600) ||
      !integer(payload.interval_max, Number(payload.interval_min), 3600)
    )
      return;
    if ('targets' in payload) {
      if (
        !Array.isArray(payload.targets) ||
        !payload.targets.length ||
        payload.targets.length > 100
      )
        return;
      const ids = new Set<string>();
      for (const target of payload.targets) {
        if (
          !target ||
          typeof target !== 'object' ||
          Object.keys(target).some((key) => !['aliasId', 'revision'].includes(key)) ||
          !id(target.aliasId) ||
          !integer(target.revision, 0, Number.MAX_SAFE_INTEGER) ||
          ids.has(target.aliasId)
        )
          return;
        ids.add(target.aliasId);
      }
    }
  }
  return payload;
}

function isAppleMailboxBridgeAction(value: unknown): value is AppleMailboxBridgeAction {
  return [
    'candidates',
    'start',
    'batch',
    'task',
    'batch-status',
    'cancel-task',
    'cancel-batch'
  ].includes(value as string);
}

export function registrationThemeState(
  root: Pick<HTMLElement, 'dataset'>,
  styles: Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  draft: AutoRegistrationDraft
): AutoRegistrationParentState {
  return {
    type: 'id-registration:state',
    theme: root.dataset.v2Theme === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(
      themeTokenNames.map((token) => [token, styles.getPropertyValue(token).trim()])
    ),
    draft: sanitizeRegistrationDraft(draft)
  };
}
