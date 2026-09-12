import { BadRequestException } from '@nestjs/common';
import type { UpdateV2RechargeBitBrowserSettingsInput } from '@apple-business/shared';
import { object } from './recharge-validation';

const proxyTypes = ['http', 'https', 'socks5'] as const;
const allowedKeys = new Set([
  'connectorUrl',
  'localApiUrl',
  'localApiToken',
  'connectorToken',
  'groupName',
  'tagName',
  'proxyType',
  'dynamicProxyUrl'
]);
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

function plainText(value: unknown, label: string, max: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    hasControlCharacter(value)
  ) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return value.trim();
}

function localUrl(value: unknown, label: string) {
  const raw = plainText(value, label, 160);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException(`${label}格式无效`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new BadRequestException(`${label}必须是带端口的本机 HTTP 地址`);
  }
  return parsed.origin;
}

function secret(value: unknown, label: string, max: number) {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > max ||
    hasControlCharacter(value)
  ) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return value;
}

function dynamicProxyUrl(value: unknown) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2000 || hasControlCharacter(value)) {
    throw new BadRequestException('动态 IP 提取链接格式无效');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('动态 IP 提取链接格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BadRequestException('动态 IP 提取链接必须使用 HTTP 或 HTTPS');
  }
  return value;
}

export function validateRechargeBitBrowserSettings(
  value: unknown
): UpdateV2RechargeBitBrowserSettingsInput {
  const input = object(value);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new BadRequestException('比特浏览器设置包含不支持的字段');
  }
  if (!proxyTypes.includes(input.proxyType as (typeof proxyTypes)[number])) {
    throw new BadRequestException('代理协议无效');
  }
  return {
    connectorUrl: localUrl(input.connectorUrl, '本机连接器地址'),
    localApiUrl: localUrl(input.localApiUrl, '比特浏览器 Local API 地址'),
    localApiToken: secret(input.localApiToken, 'Local API Token', 1000),
    connectorToken: secret(input.connectorToken, '本机连接密钥', 1000),
    groupName: plainText(input.groupName, '窗口分组', 80),
    tagName: plainText(input.tagName, '标签／窗口备注', 80),
    proxyType: input.proxyType as UpdateV2RechargeBitBrowserSettingsInput['proxyType'],
    dynamicProxyUrl: dynamicProxyUrl(input.dynamicProxyUrl)
  };
}
