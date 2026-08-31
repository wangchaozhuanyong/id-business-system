import { BadRequestException, ConflictException } from '@nestjs/common';
import { isPrismaErrorCode } from './id-business-v2-prisma-error';

export function normalizeV2ExpectedUpdatedAt(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const parsed = normalized ? new Date(normalized) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`缺少有效的${label}版本，请刷新后重试。`);
  }
  return parsed;
}

export function normalizeOptionalV2ExpectedUpdatedAt(value: unknown, label: string) {
  if (value === null) return null;
  return normalizeV2ExpectedUpdatedAt(value, label);
}

export function assertV2ExpectedUpdatedAt(actual: Date, expected: Date, label: string) {
  if (actual.getTime() !== expected.getTime()) {
    throw new ConflictException(`${label}已被其他人修改，请刷新后重试。`);
  }
}

export async function runV2OptimisticUpdate<TResult>(
  label: string,
  update: () => Promise<TResult>
) {
  try {
    return await update();
  } catch (error) {
    if (isPrismaErrorCode(error, 'P2025')) {
      throw new ConflictException(`${label}已被其他人修改，请刷新后重试。`);
    }
    throw error;
  }
}
