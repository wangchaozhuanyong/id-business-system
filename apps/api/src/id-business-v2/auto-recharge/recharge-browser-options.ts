import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import {
  V2_RECHARGE_BROWSER_DEFAULTS,
  type V2RechargeBrowserOptions,
  type V2RechargeStaticProxyCredentials
} from '@apple-business/shared';
import { object } from './recharge-validation';

const fail = (label: string): never => {
  throw new BadRequestException(`${label}格式无效`);
};
const enums = {
  proxyMode: ['dynamic', 'static'],
  dynamicProvider: ['common', 'rola', 'doveip', 'cloudam'],
  ipCheckService: ['ip-api', 'ip123in', 'luminati'],
  os: ['MacIntel', 'Win32', 'Linux x86_64']
};
const booleans = [
  'refreshIp',
  'languageFromIp',
  'displayLanguageFromIp',
  'timezoneFromIp',
  'positionFromIp',
  'syncTabs',
  'syncCookies',
  'syncLocalStorage'
];
export function validateBrowserOptions(value: unknown): V2RechargeBrowserOptions {
  const supplied = object(value);
  const defaults = V2_RECHARGE_BROWSER_DEFAULTS;
  const input: Record<string, unknown> = {
    sessionWaitMinutes: defaults.sessionWaitMinutes,
    sessionRetryLimit: defaults.sessionRetryLimit,
    ...supplied
  };
  if (
    Object.keys(input).some((key) => !Object.hasOwn(defaults, key)) ||
    Object.keys(defaults).some((key) => !Object.hasOwn(input, key))
  )
    fail('窗口配置字段');
  for (const [key, min, max] of [
    ['sessionWaitMinutes', 1, 10],
    ['sessionRetryLimit', 0, 2]
  ] as const) {
    if (!Number.isInteger(input[key]) || Number(input[key]) < min || Number(input[key]) > max)
      fail('加载等待或重建次数');
  }
  for (const [key, choices] of Object.entries(enums)) {
    if (!choices.includes(input[key] as string)) fail('窗口配置选项');
  }
  if (booleans.some((key) => typeof input[key] !== 'boolean')) fail('窗口开关');
  for (const [key, min, max] of [
    ['staticPort', 1, 65535],
    ['latitude', -90, 90],
    ['longitude', -180, 180],
    ['accuracy', 1, 100000]
  ] as const) {
    const v = input[key];
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (key === 'staticPort' && !Number.isInteger(v))
    )
      fail('端口或定位参数');
  }
  const host = input.staticHost;
  if (
    typeof host !== 'string' ||
    host.length > 253 ||
    (host !== '' &&
      !isIP(host) &&
      !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
        host
      )) ||
    (input.proxyMode === 'static' && !host)
  )
    fail('固定代理主机');
  for (const key of ['language', 'displayLanguage'] as const) {
    if (
      typeof input[key] !== 'string' ||
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(input[key] as string)
    )
      fail('语言');
  }
  if (
    typeof input.timezone !== 'string' ||
    input.timezone.length > 80 ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(input.timezone)
  )
    fail('时区');
  let timezone = input.timezone as string;
  try {
    timezone = new Intl.DateTimeFormat('en', {
      timeZone: input.timezone as string
    }).resolvedOptions().timeZone;
  } catch {
    fail('时区');
  }
  return { ...input, timezone } as unknown as V2RechargeBrowserOptions;
}

export function storedBrowserOptions(value: unknown): V2RechargeBrowserOptions {
  return validateBrowserOptions(value == null ? { ...V2_RECHARGE_BROWSER_DEFAULTS } : value);
}

export function validateStaticCredentials(
  value: unknown
): V2RechargeStaticProxyCredentials | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  if (Object.keys(input).sort().join(',') !== 'password,username') fail('固定代理凭据');
  for (const key of ['username', 'password']) {
    if (
      typeof input[key] !== 'string' ||
      !(input[key] as string).trim() ||
      (input[key] as string).length > 256 ||
      [...(input[key] as string)].some(
        (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      )
    )
      fail('固定代理凭据');
  }
  return { username: input.username as string, password: input.password as string };
}
