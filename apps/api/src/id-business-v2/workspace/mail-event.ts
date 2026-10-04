import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MailEvent {
  schemaVersion: 1;
  eventId: string;
  primaryAccountId: string;
  virtualEmailId: string | null;
  occurredAt: string;
}

export function verifyMailEvent(
  value: unknown,
  timestamp: unknown,
  signature: unknown,
  secret?: string
): MailEvent {
  if (!secret || secret.length < 32) throw new ServiceUnavailableException('邮件事件授权尚未配置');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('邮件事件格式无效');
  const input = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'eventId', 'primaryAccountId', 'virtualEmailId', 'occurredAt'];
  const identifier = (item: unknown) =>
    typeof item === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item);
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    input.schemaVersion !== 1 ||
    typeof input.eventId !== 'string' ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.eventId) ||
    !identifier(input.primaryAccountId) ||
    (input.virtualEmailId !== null && !identifier(input.virtualEmailId)) ||
    typeof input.occurredAt !== 'string' ||
    input.occurredAt.length > 32 ||
    !Number.isFinite(Date.parse(input.occurredAt))
  )
    throw new BadRequestException('邮件事件格式无效');
  const event: MailEvent = {
    schemaVersion: 1,
    eventId: input.eventId,
    primaryAccountId: input.primaryAccountId as string,
    virtualEmailId: input.virtualEmailId as string | null,
    occurredAt: input.occurredAt
  };
  if (
    typeof timestamp !== 'string' ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 300_000 ||
    typeof signature !== 'string' ||
    !/^[a-f\d]{64}$/i.test(signature)
  )
    throw new ForbiddenException('邮件事件授权无效');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(event)}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new ForbiddenException('邮件事件授权无效');
  return event;
}
