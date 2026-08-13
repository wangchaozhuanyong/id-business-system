import { BadRequestException } from '@nestjs/common';

export const ID_BUSINESS_V2_TIME_ZONE = 'Asia/Shanghai';
export const ID_BUSINESS_V2_UTC_OFFSET = '+08:00';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toIdBusinessV2BusinessDate(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ID_BUSINESS_V2_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const text = `${get('year')}-${get('month')}-${get('day')}`;
  return {
    text,
    month: text.slice(0, 7),
    date: new Date(`${text}T00:00:00.000Z`)
  };
}

export function parseIdBusinessV2DateBoundary(value: unknown, label: string, endExclusive = false) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  const match = DATE_PATTERN.exec(normalized);
  if (!match) throw new BadRequestException(`${label}格式无效`);
  const [, yearText, monthText, dayText] = match;
  const utcDate = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (
    utcDate.getUTCFullYear() !== Number(yearText) ||
    utcDate.getUTCMonth() !== Number(monthText) - 1 ||
    utcDate.getUTCDate() !== Number(dayText)
  ) {
    throw new BadRequestException(`${label}格式无效`);
  }
  const boundary = new Date(`${normalized}T00:00:00.000${ID_BUSINESS_V2_UTC_OFFSET}`);
  if (endExclusive) boundary.setUTCDate(boundary.getUTCDate() + 1);
  return boundary;
}

export function buildIdBusinessV2DateRange(
  fromValue: unknown,
  toValue: unknown,
  labels: { from: string; to: string; invalidRange: string }
) {
  const from = parseIdBusinessV2DateBoundary(fromValue, labels.from);
  const toExclusive = parseIdBusinessV2DateBoundary(toValue, labels.to, true);
  if (from && toExclusive && from.getTime() >= toExclusive.getTime()) {
    throw new BadRequestException(labels.invalidRange);
  }
  if (!from && !toExclusive) return undefined;
  return { gte: from ?? undefined, lt: toExclusive ?? undefined };
}
