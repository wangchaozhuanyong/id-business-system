import {
  AUTO_REGISTRATION_WORKSPACE_PATH,
  autoRegistrationPages,
  type AutoRegistrationChildMessage,
  type AutoRegistrationDraft,
  type AutoRegistrationPage,
  type AutoRegistrationParentState
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
