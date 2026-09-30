import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { bankRechargeObject, bankRechargeText } from './bank-recharge-validation';

export const proxyKinds = ['dynamic_residential', 'static_residential', 'mobile'] as const;
export type RechargeProxyKind = (typeof proxyKinds)[number];

export function proxyCountry(value: unknown) {
  const code = bankRechargeText(value, '国家', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new BadRequestException('国家请使用两位代码');
  return code;
}

export function proxyKind(value: unknown): RechargeProxyKind {
  if (!proxyKinds.includes(value as RechargeProxyKind)) {
    throw new BadRequestException('代理 IP 属性无效');
  }
  return value as RechargeProxyKind;
}

export function proxyLink(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 2000 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new BadRequestException('代理 IP 链接格式无效');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new BadRequestException('代理 IP 链接格式无效');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    parsed.hash ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (isIP(host) === 4 &&
      (/^(?:10|127|0|169\.254|192\.168)\./.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host))) ||
    (isIP(host) === 6 && /^(?:\[?::1\]?|\[?fc|\[?fd|\[?fe80)/i.test(host))
  ) {
    throw new BadRequestException('代理 IP 链接必须指向公网服务');
  }
  const explicitPort =
    /^[-a-z0-9+.]+:\/\/(?:[^@/]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d+)(?:[/?#]|$)/i.exec(
      value.trim()
    )?.[1];
  if (explicitPort) {
    if (
      !['http:', 'https:', 'socks5:'].includes(parsed.protocol) ||
      Number(explicitPort) < 1 ||
      Number(explicitPort) > 65535 ||
      !['', '/'].includes(parsed.pathname) ||
      parsed.search ||
      Boolean(parsed.username) !== Boolean(parsed.password)
    ) {
      throw new BadRequestException('直连代理链接须为协议://账号:密码@主机:端口');
    }
    return {
      url: value.trim(),
      connectionMode: 'direct' as const,
      protocol: parsed.protocol.slice(0, -1) as 'http' | 'https' | 'socks5'
    };
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new BadRequestException('IP 提取链接须为 HTTPS；直连代理须填写端口');
  }
  return { url: parsed.href, connectionMode: 'extraction' as const, protocol: 'http' as const };
}

export function parseRechargeProxy(value: unknown) {
  const input = bankRechargeObject(value);
  if (
    Object.keys(input).some(
      (key) => !['countryCode', 'url', 'kind', 'remark1', 'remark2'].includes(key)
    )
  ) {
    throw new BadRequestException('代理资料包含不支持的字段');
  }
  return {
    countryCode: proxyCountry(input.countryCode),
    kind: proxyKind(input.kind),
    ...proxyLink(input.url),
    remark1: bankRechargeText(input.remark1, '备注1', 500, false),
    remark2: bankRechargeText(input.remark2, '备注2', 500, false)
  };
}
