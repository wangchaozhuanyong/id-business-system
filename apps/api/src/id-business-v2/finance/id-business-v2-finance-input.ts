import { BadRequestException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { Amount4, Rate8, type V2DecimalInput } from '../runtime/public-api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCIES = new Set<IdBusinessV2FinanceCurrency>(['CNY', 'MYR', 'USDT']);

export function normalizeFinanceUuid(value: unknown, label: string) {
  const normalized = String(value ?? '').trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}不正确`);
  }
  return normalized;
}

export function normalizeOptionalFinanceUuid(value: unknown, label: string) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalizeFinanceUuid(normalized, label) : null;
}

export function normalizeFinanceCurrency(value: unknown, label = '币种') {
  const normalized = String(value ?? '')
    .trim()
    .toUpperCase() as IdBusinessV2FinanceCurrency;
  if (!CURRENCIES.has(normalized)) {
    throw new BadRequestException(`${label}仅支持 CNY、MYR、USDT`);
  }
  return normalized;
}

export function normalizeFinanceMoney(value: unknown, label: string, allowZero = false) {
  const normalized = String(value ?? '').trim();
  if (!MONEY_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}最多支持 4 位小数`);
  }
  const amount = Amount4.from(normalized);
  if (allowZero ? amount.lt(0) : amount.lte(0)) {
    throw new BadRequestException(`${label}${allowZero ? '不能小于 0' : '必须大于 0'}`);
  }
  return amount;
}

export function normalizeFinanceRate(value: unknown, currency: IdBusinessV2FinanceCurrency) {
  if (currency === 'CNY') return Rate8.one();
  const normalized = String(value ?? '').trim();
  if (!RATE_PATTERN.test(normalized)) {
    throw new BadRequestException('汇率必须大于 0，且最多支持 8 位小数');
  }
  const rate = Rate8.from(normalized);
  if (rate.lte(0)) throw new BadRequestException('汇率必须大于 0');
  return rate;
}

export function normalizeFinanceText(
  value: unknown,
  label: string,
  maxLength: number,
  required = false
) {
  const normalized = String(value ?? '').trim();
  if (required && normalized.length < 2) {
    throw new BadRequestException(`${label}至少填写 2 个字符`);
  }
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
  }
  return normalized || null;
}

export function normalizeFinanceDate(value: unknown, label: string) {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}不正确`);
  return date;
}

export function normalizeFinanceMonth(value: unknown) {
  const month = String(value ?? '').trim();
  if (!MONTH_PATTERN.test(month)) throw new BadRequestException('月份格式必须是 YYYY-MM');
  return month;
}

export function normalizeFinanceIdempotencyKey(value: unknown, prefix: string) {
  const normalized = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(normalized)) {
    throw new BadRequestException('幂等键需为 8–120 位字母、数字或 . _ : -');
  }
  return `${prefix}:${normalized}`;
}

export function toKualaLumpurBusinessDate(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
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

export function decimalJson(value: V2DecimalInput) {
  return Amount4.from(value).toString();
}
