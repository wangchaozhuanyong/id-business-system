export const BROWSER_SESSION_COOKIE_NAME = 'id_business_browser_session';
export const BROWSER_SESSION_PATH = '/api/auth/session';

export interface BrowserSessionRequest {
  method?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface BrowserSessionResponse {
  setHeader(name: string, value: string): unknown;
}

export function readBrowserSessionToken(request: BrowserSessionRequest) {
  // Cookies authenticate only this same-origin read. Business writes still require Bearer.
  if (
    request.method !== 'GET' ||
    request.originalUrl?.split('?')[0] !== BROWSER_SESSION_PATH ||
    request.headers['sec-fetch-site'] !== 'same-origin'
  ) {
    return undefined;
  }
  const raw = request.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  const matches = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${BROWSER_SESSION_COOKIE_NAME}=`));
  if (matches.length !== 1) return undefined;
  try {
    return (
      decodeURIComponent(matches[0]!.slice(BROWSER_SESSION_COOKIE_NAME.length + 1)) || undefined
    );
  } catch {
    return undefined;
  }
}

export function setBrowserSessionCookie(response: BrowserSessionResponse, token: string | null) {
  const attributes = [
    `${BROWSER_SESSION_COOKIE_NAME}=${token ? encodeURIComponent(token) : ''}`,
    `Path=${BROWSER_SESSION_PATH}`,
    'HttpOnly',
    'SameSite=Strict'
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  if (!token) attributes.push('Max-Age=0');
  response.setHeader('Set-Cookie', attributes.join('; '));
}
