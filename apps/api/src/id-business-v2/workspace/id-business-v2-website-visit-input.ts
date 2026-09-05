import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { V2WebsiteVisitSearch } from '@apple-business/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTS = new Set(['flashcast.com.my', 'www.flashcast.com.my']);
export const WEBSITE_VISIT_DAY_MS = 86_400_000;
export const WEBSITE_VISIT_OFFSET_MS = 8 * 3_600_000;

export interface WebsiteVisitEvent {
  eventId: string;
  host: string;
  path: string;
  ip: string;
  occurredAt: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('访问记录参数无效');
  return value as Record<string, unknown>;
}

export function websiteVisitId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException('访问记录编号无效');
  return value.toLowerCase();
}

export function normalizeWebsiteVisitIp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 45 || !isIP(value))
    throw new BadRequestException('请输入有效的 IP 地址');
  if (isIP(value) === 4) return value;
  let normalized: string;
  try {
    normalized = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  } catch {
    throw new BadRequestException('请输入有效的 IP 地址');
  }
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return normalized;
}

export function maskWebsiteVisitIp(ip: string) {
  return isIP(ip) === 4
    ? ip.split('.').slice(0, 2).join('.') + '.*.*'
    : ip.split(':').filter(Boolean).slice(0, 2).join(':') + ':****';
}

export function parseWebsiteVisitEvent(value: unknown): WebsiteVisitEvent {
  const input = object(value);
  const keys = ['eventId', 'host', 'path', 'ip', 'occurredAt'];
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw new BadRequestException('访问记录字段无效');
  if (typeof input.host !== 'string' || !HOSTS.has(input.host))
    throw new BadRequestException('访问记录网站无效');
  if (
    typeof input.path !== 'string' ||
    input.path.length > 1024 ||
    !/^\/(en|zh)(?:\/[A-Za-z0-9_%-]+)*\/?$/.test(input.path) ||
    /%(?![a-f0-9]{2})/i.test(input.path)
  )
    throw new BadRequestException('访问页面路径无效');
  if (
    typeof input.occurredAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.occurredAt) ||
    !Number.isFinite(Date.parse(input.occurredAt)) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt
  )
    throw new BadRequestException('访问时间无效');
  // Validate the original IP before signing; canonicalize only for persistence and search.
  normalizeWebsiteVisitIp(input.ip);
  websiteVisitId(input.eventId);
  return input as unknown as WebsiteVisitEvent;
}

export function websiteVisitSignaturePayload(event: WebsiteVisitEvent) {
  return JSON.stringify([event.eventId, event.host, event.path, event.ip, event.occurredAt]);
}

export function parseWebsiteVisitSearch(value: unknown): V2WebsiteVisitSearch {
  const input = object(value);
  if (
    Object.keys(input).some((k) => !['days', 'page', 'pageSize', 'sort', 'ip'].includes(k)) ||
    ![7, 30].includes(input.days as number) ||
    ![20, 50].includes(input.pageSize as number) ||
    !['newest', 'oldest'].includes(input.sort as string) ||
    !Number.isInteger(input.page) ||
    Number(input.page) < 1 ||
    Number(input.page) > 1_000_000
  )
    throw new BadRequestException('访问记录查询参数无效');
  const ip =
    input.ip === undefined || input.ip === '' ? undefined : normalizeWebsiteVisitIp(input.ip);
  return { ...input, ip } as unknown as V2WebsiteVisitSearch;
}

export function websiteVisitRange(days: 7 | 30, now: Date) {
  const today = new Date(now.getTime() + WEBSITE_VISIT_OFFSET_MS).toISOString().slice(0, 10);
  const start = new Date(Date.parse(today + 'T00:00:00+08:00') - (days - 1) * WEBSITE_VISIT_DAY_MS);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + WEBSITE_VISIT_OFFSET_MS + i * WEBSITE_VISIT_DAY_MS)
      .toISOString()
      .slice(0, 10)
  );
  return { start, end: now, dates };
}
