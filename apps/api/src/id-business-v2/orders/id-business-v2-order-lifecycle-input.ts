import { BadRequestException } from '@nestjs/common';

export function normalizeLifecycleBoolean(value: unknown, label: string) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${label}格式无效`);
  }
  return value;
}

export function buildOrderReversalIdempotencyKey(orderId: string, value: string) {
  return `order_reversal:${orderId}:${value}`;
}
