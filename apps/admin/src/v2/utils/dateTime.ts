export const V2_BUSINESS_TIME_ZONE = 'Asia/Shanghai';
export const V2_BUSINESS_TIME_OFFSET = '+08:00';

const DATE_TIME_INPUT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

type DateTimeValue = Date | string | number;

export function formatV2DateTime(
  value: DateTimeValue | null | undefined,
  options: Intl.DateTimeFormatOptions = {},
  fallback = '-'
) {
  const date = toValidDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: V2_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options
  }).format(date);
}

export function formatV2Time(
  value: DateTimeValue | null | undefined,
  options: Intl.DateTimeFormatOptions = {},
  fallback = '-'
) {
  const date = toValidDate(value);
  if (!date) return fallback;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: V2_BUSINESS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options
  }).format(date);
}

export function toV2DateTimeInput(value: DateTimeValue) {
  const date = toValidDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: V2_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function parseV2DateTimeInput(value: unknown) {
  const normalized = String(value ?? '').trim();
  const match = DATE_TIME_INPUT_PATTERN.exec(normalized);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00', millisecond = '0'] = match;
  const canonical = `${year}-${month}-${day}T${hour}:${minute}`;
  const instant = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond.padEnd(3, '0')}${V2_BUSINESS_TIME_OFFSET}`
  );
  if (Number.isNaN(instant.getTime()) || toV2DateTimeInput(instant) !== canonical) return null;
  return instant;
}

export function v2DateTimeInputToIso(value: unknown) {
  const date = parseV2DateTimeInput(value);
  if (!date) throw new Error('北京时间格式无效');
  return date.toISOString();
}

export function currentV2BusinessMonth(value: DateTimeValue | null) {
  if (value === null) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: V2_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit'
  }).format(new Date(value));
}

export function addOneInclusiveMonthToV2DateTimeInput(value: string) {
  const match = DATE_TIME_INPUT_PATTERN.exec(value.trim());
  if (!match || !parseV2DateTimeInput(value)) return '';
  const [, yearText, monthText, dayText, hour, minute] = match;
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const targetMonthStart = new Date(Date.UTC(year, monthIndex + 1, 1));
  const targetYear = targetMonthStart.getUTCFullYear();
  const targetMonthIndex = targetMonthStart.getUTCMonth();
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const dueDate = new Date(
    Date.UTC(targetYear, targetMonthIndex, Math.min(day, lastTargetDay) - 1)
  );
  return `${dueDate.getUTCFullYear()}-${pad(dueDate.getUTCMonth() + 1)}-${pad(
    dueDate.getUTCDate()
  )}T${hour}:${minute}`;
}

function toValidDate(value: DateTimeValue | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}
