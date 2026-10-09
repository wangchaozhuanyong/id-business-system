import { randomBytes } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { authHttpError } from '../common/errors/api-http.exception';

export const REGISTRATION_WORKSPACE_PATH = '/api/id-business-v2/auto-registration/workspace';
export const REGISTRATION_WORKSPACE_COOKIE_NAME = 'id_business_registration_workspace';
export const REGISTRATION_WORKSPACE_SESSION_TTL_MS = 30 * 60 * 1_000;
const MAX_WORKSPACE_SESSIONS = 256;

export interface RegistrationWorkspaceRequest {
  method?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface RegistrationWorkspaceResponse {
  setHeader(name: string, value: string): unknown;
}

interface WorkspaceSession {
  accessToken: string;
  userId: string;
  origin: string;
  expiresAt: number;
}

const sessions = new Map<string, WorkspaceSession>();

export function createRegistrationWorkspaceSession(
  response: RegistrationWorkspaceResponse,
  accessToken: string,
  userId: string,
  request: RegistrationWorkspaceRequest,
  nowMs = Date.now()
) {
  const origin = readOrigin(request);
  if (!origin || request.headers['sec-fetch-site'] !== 'same-origin') {
    throw authHttpError(
      HttpStatus.FORBIDDEN,
      'AUTH_PERMISSION_DENIED',
      '请从管理系统内打开自动注册工作区。'
    );
  }
  if (!accessToken || !userId) {
    throw authHttpError(HttpStatus.UNAUTHORIZED, 'AUTH_MISSING', '请先登录后再操作。');
  }
  pruneExpiredSessions(nowMs);
  if (sessions.size >= MAX_WORKSPACE_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
  const handle = randomBytes(32).toString('base64url');
  const expiresAt = nowMs + REGISTRATION_WORKSPACE_SESSION_TTL_MS;
  sessions.set(handle, { accessToken, userId, origin, expiresAt });
  setWorkspaceCookie(response, handle);
  return { expiresAt: new Date(expiresAt).toISOString() };
}

export function resolveRegistrationWorkspaceSession(
  request: RegistrationWorkspaceRequest,
  nowMs = Date.now()
): Pick<WorkspaceSession, 'accessToken' | 'userId'> | undefined {
  if (
    !isWorkspacePath(request.originalUrl) ||
    request.headers['sec-fetch-site'] !== 'same-origin'
  ) {
    return undefined;
  }
  pruneExpiredSessions(nowMs);
  const handle = readWorkspaceHandle(request);
  if (!handle) return undefined;
  const session = sessions.get(handle);
  if (!session) return undefined;
  const method = request.method?.toUpperCase();
  if (!method) return undefined;
  const origin = readOrigin(request);
  const hasOrigin = request.headers.origin !== undefined;
  if ((hasOrigin || !['GET', 'HEAD'].includes(method)) && origin !== session.origin) {
    return undefined;
  }
  return { accessToken: session.accessToken, userId: session.userId };
}

export function clearRegistrationWorkspaceSession(
  response: RegistrationWorkspaceResponse,
  request?: RegistrationWorkspaceRequest
) {
  if (request) {
    const handle = readWorkspaceHandle(request);
    if (handle) sessions.delete(handle);
  }
  setWorkspaceCookie(response, null);
}

function readOrigin(request: RegistrationWorkspaceRequest) {
  const value = request.headers.origin;
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isWorkspacePath(originalUrl: string | undefined) {
  const path = originalUrl?.split('?')[0];
  if (!path || path.includes('\0') || /\\|%2e|%2f|%5c/i.test(path)) return false;
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) return false;
  return path === REGISTRATION_WORKSPACE_PATH || path.startsWith(`${REGISTRATION_WORKSPACE_PATH}/`);
}

function readWorkspaceHandle(request: RegistrationWorkspaceRequest) {
  const raw = request.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  const values = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${REGISTRATION_WORKSPACE_COOKIE_NAME}=`));
  if (values.length !== 1) return undefined;
  const handle = values[0]!.slice(REGISTRATION_WORKSPACE_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(handle) ? handle : undefined;
}

function pruneExpiredSessions(nowMs: number) {
  for (const [handle, session] of sessions) {
    if (session.expiresAt <= nowMs) sessions.delete(handle);
  }
}

function setWorkspaceCookie(response: RegistrationWorkspaceResponse, handle: string | null) {
  const attributes = [
    `${REGISTRATION_WORKSPACE_COOKIE_NAME}=${handle ?? ''}`,
    `Path=${REGISTRATION_WORKSPACE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${handle ? REGISTRATION_WORKSPACE_SESSION_TTL_MS / 1_000 : 0}`
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  response.setHeader('Set-Cookie', attributes.join('; '));
}
