import { BadRequestException } from '@nestjs/common';
import { V2_WEBSITE_MONITOR_LIMITS } from '@apple-business/shared';
import { isIP } from 'node:net';

const BLOCKED_HOST_SUFFIXES = [
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.test'
] as const;

export function normalizeV2WebsiteMonitorInput(value: unknown) {
  if (typeof value !== 'string') throw new BadRequestException('请输入要检测的网站地址');
  const candidate = value.trim();
  if (!candidate) throw new BadRequestException('请输入要检测的网站地址');
  if (candidate.length > V2_WEBSITE_MONITOR_LIMITS.url) {
    throw new BadRequestException('网站地址过长，请检查后重试');
  }

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)
    ? candidate
    : `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new BadRequestException('网站地址格式不正确');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('网站监控只支持 HTTP 或 HTTPS 地址');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException('网站地址不能包含账号或密码');
  }
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    throw new BadRequestException('网站监控只允许检测公开网站');
  }
  if (parsed.href.length > V2_WEBSITE_MONITOR_LIMITS.url) {
    throw new BadRequestException('网站地址过长，请检查后重试');
  }
  parsed.hash = '';
  return parsed;
}

export function isPublicWebsiteAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) return isPublicIpv4(bigIntToIpv4(value & 0xffffffffn));

  if (!isInIpv6Cidr(value, ipv6ToBigInt('2000::')!, 3)) return false;
  if (isInIpv6Cidr(value, ipv6ToBigInt('2001::')!, 23)) return false;
  if (isInIpv6Cidr(value, ipv6ToBigInt('2001:db8::')!, 32)) return false;
  if (isInIpv6Cidr(value, ipv6ToBigInt('2002::')!, 16)) return false;
  return true;
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
    .replace(/\.$/u, '');
  if (!normalized || normalized === 'localhost') return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return isIP(normalized) > 0 && !isPublicWebsiteAddress(normalized);
}

function isPublicIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6ToBigInt(address: string) {
  let normalized = address.toLowerCase().split('%', 1)[0] ?? '';
  if (!normalized) return null;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(lastColon + 1);
    const octets = ipv4.split('.').map(Number);
    if (
      lastColon < 0 ||
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    normalized = `${normalized.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv6Cidr(value: bigint, base: bigint, prefix: number) {
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function bigIntToIpv4(value: bigint) {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
}
