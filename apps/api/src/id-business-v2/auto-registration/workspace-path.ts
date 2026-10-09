import { BadRequestException } from '@nestjs/common';
import { REGISTRATION_WORKSPACE_PATH } from '../../auth/registration-workspace-session';

const pages = new Set(['/', '/accounts', '/email-services', '/payment', '/settings']);
const apiPath =
  /^\/api\/(?:accounts|registration|settings|email-services|payment|cpa-services|tm-services|sub2api-services|ws)(?:\/|$)/;

export function workspaceUpstreamPath(originalUrl: string) {
  const suffix = originalUrl.slice(REGISTRATION_WORKSPACE_PATH.length);
  const rawPath = suffix.split('?')[0] || '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new BadRequestException('自动注册地址无效');
  }
  if (
    !originalUrl.startsWith(`${REGISTRATION_WORKSPACE_PATH}/`) ||
    /[\\%]/.test(decoded) ||
    [...decoded].some((character) => character.charCodeAt(0) <= 32) ||
    decoded.includes('//') ||
    decoded.split('/').some((part) => part === '.' || part === '..') ||
    !(pages.has(decoded) || decoded.startsWith('/static/') || apiPath.test(decoded))
  ) {
    throw new BadRequestException('自动注册地址不在允许范围内');
  }
  return decoded + (suffix.includes('?') ? `?${suffix.split('?').slice(1).join('?')}` : '');
}

export function isWorkspaceSensitiveRead(method: string, path: string) {
  const pathname = path.split('?')[0]!;
  return (
    (method === 'POST' && /^\/api\/accounts\/export\//.test(pathname)) ||
    (method === 'GET' &&
      (/^\/api\/accounts\/\d+(?:\/(?:credentials|tokens|cookies))?$/.test(pathname) ||
        /^\/api\/(?:email-services|cpa-services|tm-services|sub2api-services)\/\d+\/full$/.test(
          pathname
        ) ||
        /^\/api\/settings\/proxies\/\d+$/.test(pathname)))
  );
}
