import { BadRequestException } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export function normalizeAccountLossDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return date;
}

export function normalizeAccountLossKeyword(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > 160) {
    throw new BadRequestException('搜索内容不能超过 160 个字符');
  }
  return normalized || null;
}

export function normalizeAccountLossSaleState(value: unknown): 'available' | 'sold' | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'available' || value === 'sold') return value;
  throw new BadRequestException('销售状态无效');
}

export function normalizeAccountLossStatus(value: unknown): 'active' | 'reversed' | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'active' || value === 'reversed') return value;
  throw new BadRequestException('报损状态无效');
}

export function normalizeAccountLossReason(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < 2 || normalized.length > 500) {
    throw new BadRequestException('报损原因必须为 2 至 500 个字符');
  }
  return normalized;
}

export function normalizeAccountLossIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
  }
  return normalized;
}

export function normalizeAccountLossUuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return normalized;
}

export function normalizeOptionalAccountLossUuid(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeAccountLossUuid(value, label);
}
